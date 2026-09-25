# 设计：播放历史自动上报（Play History Upload）

日期：2026-09-25
状态：已评审通过，待实现
范围：MoeKoeMusic 前端源码改造（`~/software/MoeKoeMusic`）

## 1. 背景与目标

MoeKoe 作为第三方酷狗客户端，播放时只调用 `/song/url` 获取音频地址，**从不上报听歌历史**。因此用户在这个客户端里的真实播放不会计入酷狗账号的「听歌时长 / 听歌历史」。

本功能的目标：

- 在 MoeKoe 中**真实播放满阈值（30 秒）**后，调用酷狗接口 `/playhistory/upload` 上报一次，使账号的听歌时长与历史记录生效。
- 只上报**实际发生的播放**：跳过本地音乐、云盘音乐；失败静默；绝不刷量。
- 在设置中提供开关，**默认关闭**。

### 非目标

- 不做批量、定时、无人值守的上报（属于刷量）。
- 不改动后端 `api` 子模块或其编译出的二进制。
- 不实现"多设备同步"等平台侧功能，仅上报。

## 2. 现状与可行性依据

- 后端接口现成：`api/module/playhistory_upload.js` 暴露路由 `/playhistory/upload`，参数 `mxid`（必填）、`ot`（可选，秒级时间戳）、`pc`（可选，播放次数）。API 服务由客户端在 `127.0.0.1:6521` 启动。
- 认证自动携带：`src/utils/request.js` 的请求拦截器会为每个请求附加 `Authorization: token=…;userid=…` 等，无需额外处理登录态。
- `mxid` 在播放时已可获得：客户端在已登录播放时会调用 `/privilege/lite`，其实测响应包含 `data[].album_audio_id`，即 `mxid`。
- 播放事件可用：`AudioController` 已有 `play` / `pause` / `timeupdate` / `ended` 事件。
- ⚠️ 现有 `PlayerControl.vue` 的 `updateCurrentTime = throttle(() => {...})` **未传 delay**，而 `Helpers.js` 的 `throttle(func, delay)` 在 `delay === undefined` 时 `now - lastTime >= undefined` 恒为 `false`，即该函数实际是空操作（已用 Node 验证：0 次调用）。因此**不能依赖 `updateCurrentTime` 作为采样钩子**，需新增一个可靠的采样入口。

结论：可在**纯前端**实现，无需重建后端二进制。

## 3. 架构与数据流

```
列表/搜索/歌单  ──(album_audio_id)──▶  addSongToQueue
      │
      ▼
OnlineMusicQueue 调 /privilege/lite ──▶ data[].album_audio_id = mxid
      │  存到 currentSong.mxid 和队列歌曲对象
      ▼
AudioController 新增的 timeupdate 监听 ──onPlaybackProgress({currentTime,paused})──▶ PlayerControl
PlayerControl.onSongEnd / 切歌             ──endSession()/beginSession()──────────▶ Reporter
      │
      ▼
累计 ≥ 30s 且 本会话未上报 且 已登录 且 开关开启
      │
      ▼
silentGet('/playhistory/upload', { mxid, ot, pc: 1 })   // 失败静默
```

单一职责拆分：

- **Reporter（新单元）**：只负责"累计真实播放时长 + 会话去重 + 触发上报"。不依赖 Vue、不直接读 audio，输入为每次采样的 `currentTime`/`paused`。
- **AudioController**：在原生 `timeupdate` 事件上提供一个可靠的 `onPlaybackProgress` 回调（不依赖已有的失效 `updateCurrentTime`）。
- **PlayerControl**：把 `onPlaybackProgress` 转成对 Reporter 的 `tick`，并提供登录态、开关、`mxid` 等上下文，处理 `beginSession` / `endSession`。
- **OnlineMusicQueue**：在解析播放信息时捕获并携带 `mxid`。

## 4. 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/utils/playHistoryReporter.js` | **新增**：上报单元。导出 `createPlayHistoryReporter(options)`，含 `beginSession` / `tick` / `endSession`，并把计时逻辑抽成纯函数 `accumulate()` |
| `src/utils/request.js` | 新增 `silentGet(url, params)`：走 `__rawResponse` 的 GET，绕过风控弹窗，供后台上报使用 |
| `src/components/player/songQueue/OnlineMusicQueue.js` | 从 `/privilege/lite` 响应读取 `data[].album_audio_id`，写入 `currentSong.value.mxid` 与队列歌曲对象；`addSongToQueue` 增加可选 `mxid` 参数透传 |
| `src/components/player/SongQueue.js` | `currentSong` 初始结构增加 `mxid: ''`；`addToNext` 保留 `mxid` |
| `src/components/player/AudioController.js` | 新增 `onPlaybackProgress` 可选回调，并在原生 `timeupdate` 上调用它（绕过失效的 `updateCurrentTime`）；同步在 `play`/`pause`/`ended` 时通知 |
| `src/components/PlayerControl.vue` | 实例化 Reporter；`useAudioController` 传入 `onPlaybackProgress` 回调并转发为 `reporter.tick`；歌曲标识变化时 `beginSession`；`onSongEnd` 时 `endSession`；读取开关与登录态 |
| `src/config/settings.js` | 新增 toggle 项 `uploadPlayHistory`，默认 `off`，归入音乐/播放相关分组 |
| `src/language/zh-CN.json`、`zh-TW.json`、`en.json`、`ja.json`、`ko.json`、`ru.json` | 新增开关标题与说明文案键（各语言） |

## 5. 关键逻辑

### 5.1 计时（真实播放）
- `tick` 接收 `{ currentTime, paused }`。
- 计算与上次采样的差值 `delta = currentTime - lastTime`。
- 仅当**未暂停**且 `0 < delta <= MAX_DELTA`（默认 2 秒）时，累加到 `accumulatedSeconds`，以过滤拖动进度条造成的大跳变（拖到 35 秒不算听完 30 秒）。
- `delta < 0`（跳回开头 / 重播）视为**新会话**，重置 `accumulatedSeconds` 与 `reported`（见 5.2），从而支持单曲循环与重播。
- `lastTime` 在每次 `tick` 结束时更新。

### 5.2 会话与去重
- 会话标识为 `mxid + hash`。
- 当标识变化、或显式调用 `beginSession`、或 `onSongEnd` 调用 `endSession` 时，重置 `accumulatedSeconds=0` 与 `reported=false`。
- 每个会话最多上报一次；上报后 `reported=true`，同一会话内不再上报。
- 效果：同一首歌**每次播放会话各上报一次**（支持真实重复听）。
- 除显式 `beginSession` / `endSession` 外，`tick` 检测到 `delta < 0`（重播/跳回开头）时也自动开启新会话，覆盖单曲循环场景。

### 5.3 跳过条件（任一满足即不上报）
- 设置开关未开启。
- 未登录（`MoeAuth.isAuthenticated` 为 false）。
- `mxid` 为空（本地音乐、云盘音乐、无 `album_audio_id` 的歌曲）。
- 当前会话已上报过。

### 5.4 上报参数
- `mxid`：歌曲的 `album_audio_id`。
- `ot`：客户端秒级时间戳 `Math.floor(Date.now() / 1000)`。
- `pc`：固定为 `1`（依据接口说明，服务端对播放次数取最大值）。

### 5.5 设置热生效
- 开关值存于 `localStorage.settings.uploadPlayHistory`。
- Reporter 在每次判定时读取最新设置；`Settings.vue` 的 `saveSettings()` 已派发 `settings-change` 事件，必要时可监听该事件清理状态。无需重启应用。

## 6. 错误处理与安全

- 后台上报统一走 `silentGet`：不触发风控验证弹窗、不改变播放状态、异常 `console.warn` 后吞掉，绝不向播放流程抛出。
- **不做重试**，避免高频请求触发风控。
- 仅跟随真实播放上报；不提供批量/定时上报能力。
- 风险提示：上报使用用户本人的登录态与酷狗官方接口，仍可能受酷狗平台规则约束，存在账号被风控的可能，使用前需知悉。

## 7. 测试与验证

项目当前**没有测试框架**（`package.json` 无 test 脚本），因此以手动验证为主：

- 正向：`npm run dev`（或构建后运行）→ 播放一首在线歌曲并持续 ≥30 秒 → 本地 API 日志出现 `[OK] /playhistory/upload`，控制台无错误 → 到酷狗端刷新听歌历史/时长确认。
- 反向：
  - 播放 <30 秒即切歌 → 不应上报。
  - 播放本地音乐 → 不应上报。
  - 关闭开关 → 不应上报。
  - 未登录 → 不应上报。
- 计时核心 `accumulate()` 为纯函数，便于将来引入测试时直接单测；本次不引入测试框架（YAGNI）。

## 8. 构建与部署

- 源码改动后需重新构建前端产物：`npm run build`。
- 供已安装应用使用的方式（三选一，属人工步骤）：
  1. 以开发模式运行：`npm run dev`；
  2. 用新 `dist` 重新打包安装包；
  3. 将补丁写入已安装应用的 `app.asar`（仅本地临时验证用）。

## 9. 待定项

无。以下默认值已确定：

- 阈值：30 秒。
- 去重：每次播放会话一次。
- 开关默认值：关闭。
- `ot`：客户端时间。
- `pc`：1。
- 不重试。
