# 播放历史自动上报 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 MoeKoe 中真实播放满 30 秒后，调用酷狗接口 `/playhistory/upload` 上报一次，使账号听歌时长/历史记录生效。

**Architecture:** 新增独立的上报单元 `playHistoryReporter`（纯逻辑 + 会话去重 + 触发上传），由 `AudioController` 的原生 `timeupdate` 提供可靠采样回调，`PlayerControl` 负责接线与上下文（登录态、开关、`mxid`），`OnlineMusicQueue` 在解析 `/privilege/lite` 时捕获 `album_audio_id`。上报为后台静默调用，失败不影响播放。

**Tech Stack:** Vue 3（Composition API）、Vite、Pinia、Electron；单元测试用 Node 内置 `node:test`（不新增依赖）。

## Global Constraints

- 语言/模块：ESM（`package.json` 为 `"type": "module"`），Vue 3 `<script setup>`。
- 不新增任何 npm 依赖；测试用 `node --test`。
- 阈值：`30` 秒；采样最大合法步长：`2` 秒（超过视为拖动，不计入）。
- 开关：键名 `uploadPlayHistory`，值 `'on'`/`'off'`，存 `localStorage.settings`，**默认 `'off'`**。
- 上报参数：`mxid`=歌曲 `album_audio_id`；`ot`=`Math.floor(Date.now()/1000)`；`pc`=`1`。
- 上报必须静默：不弹窗、不重试、异常仅 `console.warn`，绝不向播放流程抛出。
- 只上报在线歌曲（存在 `mxid`）；本地/云盘歌曲（无 `mxid`）自动跳过。
- 提交信息使用 conventional commits（如 `feat(player): ...`）。

---

### Task 1: 上报核心模块与单元测试

**Files:**
- Create: `src/utils/playHistoryReporter.js`
- Test: `src/utils/playHistoryReporter.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_THRESHOLD_SECONDS: number = 30`
  - `DEFAULT_MAX_DELTA_SECONDS: number = 2`
  - `accumulate(state, sample, options) => { state, shouldReport }`
    - `state`: `{ key: string|null, mxid: string, accumulated: number, reported: boolean, lastTime: number|null }`
    - `sample`: `{ sessionKey: string, mxid: string, currentTime: number, paused: boolean }`
    - `options`: `{ thresholdSeconds?: number, maxDeltaSeconds?: number }`
  - `createPlayHistoryReporter({ upload, isEnabled?, isAuthenticated?, thresholdSeconds?, maxDeltaSeconds? }) => { tick, endSession, getState }`
    - `tick(sample)`：`sample` 同上；达标且未报过时调用 `upload({ mxid, ot, pc })`
    - `endSession()`：清空本会话计时与上报标志
    - `getState()`：返回当前状态快照

- [ ] **Step 1: 写失败测试**

创建 `src/utils/playHistoryReporter.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { accumulate, createPlayHistoryReporter, DEFAULT_THRESHOLD_SECONDS } from './playHistoryReporter.js';

const emptyState = () => ({ key: null, mxid: '', accumulated: 0, reported: false, lastTime: null });

// 以 1 秒步长从 from 播放到 to（含），返回最终状态与是否触发上报
const playSeconds = (state, { sessionKey = 'k', mxid = '123', from, to, paused = false }) => {
    let s = state;
    let reported = false;
    for (let t = from; t <= to; t += 1) {
        const r = accumulate(s, { sessionKey, mxid, currentTime: t, paused });
        s = r.state;
        if (r.shouldReport) reported = true;
    }
    return { state: s, reported };
};

test('持续播放累加真实时长，达到阈值时报一次', () => {
    const { state, reported } = playSeconds(emptyState(), { from: 0, to: 31 });
    assert.equal(reported, true);
    assert.ok(state.accumulated >= DEFAULT_THRESHOLD_SECONDS);
});

test('拖动进度条的大跳变不计入', () => {
    let state = accumulate(emptyState(), { sessionKey: 'k', mxid: '123', currentTime: 0, paused: false }).state;
    state = accumulate(state, { sessionKey: 'k', mxid: '123', currentTime: 1, paused: false }).state;
    const r = accumulate(state, { sessionKey: 'k', mxid: '123', currentTime: 35, paused: false });
    assert.equal(r.shouldReport, false);
    assert.equal(r.state.accumulated, 1);
});

test('暂停期间不累加', () => {
    let { state } = playSeconds(emptyState(), { from: 0, to: 5 });
    state = accumulate(state, { sessionKey: 'k', mxid: '123', currentTime: 6, paused: true }).state;
    assert.equal(state.accumulated, 5);
});

test('切歌（sessionKey 变化）重置会话', () => {
    const { state } = playSeconds(emptyState(), { from: 0, to: 10 });
    const r = accumulate(state, { sessionKey: 'other', mxid: '999', currentTime: 10, paused: false });
    assert.equal(r.state.accumulated, 0);
    assert.equal(r.state.reported, false);
    assert.equal(r.state.mxid, '999');
});

test('重播/跳回开头（delta<0）开启新会话，可再次上报', () => {
    const first = playSeconds(emptyState(), { from: 0, to: 31 });
    assert.equal(first.reported, true);
    // 同一首歌从头重播：currentTime 回到 0
    const restart = accumulate(first.state, { sessionKey: 'k', mxid: '123', currentTime: 0, paused: false });
    assert.equal(restart.state.reported, false);
    assert.equal(restart.state.accumulated, 0);
    const second = playSeconds(restart.state, { from: 1, to: 31 });
    assert.equal(second.reported, true);
});

test('缺少 mxid 时永不触发上报', () => {
    const { reported } = playSeconds(emptyState(), { mxid: '', from: 0, to: 60 });
    assert.equal(reported, false);
});

test('createPlayHistoryReporter：每会话上报一次，开关关闭时不报', () => {
    const calls = [];
    const enabled = { value: true };
    const reporter = createPlayHistoryReporter({
        upload: (payload) => calls.push(payload),
        isEnabled: () => enabled.value,
        isAuthenticated: () => true,
    });

    for (let t = 0; t <= 31; t += 1) reporter.tick({ sessionKey: 'k', mxid: '123', currentTime: t, paused: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mxid, '123');
    assert.equal(calls[0].pc, 1);
    assert.equal(typeof calls[0].ot, 'number');

    // 同一会话继续播放不重复上报
    for (let t = 32; t <= 60; t += 1) reporter.tick({ sessionKey: 'k', mxid: '123', currentTime: t, paused: false });
    assert.equal(calls.length, 1);

    // endSession 后重播可再次上报
    reporter.endSession();
    for (let t = 0; t <= 31; t += 1) reporter.tick({ sessionKey: 'k', mxid: '123', currentTime: t, paused: false });
    assert.equal(calls.length, 2);

    // 关闭开关后不再上报
    enabled.value = false;
    reporter.endSession();
    for (let t = 0; t <= 31; t += 1) reporter.tick({ sessionKey: 'k2', mxid: '456', currentTime: t, paused: false });
    assert.equal(calls.length, 2);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test src/utils/playHistoryReporter.test.js`
Expected: 失败（`Cannot find module './playHistoryReporter.js'`）

- [ ] **Step 3: 实现模块**

创建 `src/utils/playHistoryReporter.js`：

```js
// 播放历史上报：纯计时逻辑 + 会话去重 + 触发静默上传

export const DEFAULT_THRESHOLD_SECONDS = 30;
export const DEFAULT_MAX_DELTA_SECONDS = 2;

// 纯函数：根据上一次状态与本次采样，计算累计播放秒数与是否需要上报
export function accumulate(state, sample, options = {}) {
    const {
        thresholdSeconds = DEFAULT_THRESHOLD_SECONDS,
        maxDeltaSeconds = DEFAULT_MAX_DELTA_SECONDS,
    } = options;

    const next = {
        key: state.key,
        mxid: state.mxid,
        accumulated: state.accumulated,
        reported: state.reported,
        lastTime: state.lastTime,
    };

    // 会话切换（换歌）
    if (sample.sessionKey !== next.key) {
        next.key = sample.sessionKey;
        next.mxid = sample.mxid || '';
        next.accumulated = 0;
        next.reported = false;
        next.lastTime = null;
    } else if (sample.mxid) {
        next.mxid = sample.mxid;
    }

    const currentTime = Number(sample.currentTime) || 0;

    if (next.lastTime !== null) {
        const delta = currentTime - next.lastTime;
        if (delta < 0) {
            // 跳回开头 / 重播 => 新会话
            next.accumulated = 0;
            next.reported = false;
        } else if (!sample.paused && delta <= maxDeltaSeconds) {
            next.accumulated += delta;
        }
    }

    next.lastTime = currentTime;

    const shouldReport = !next.reported && !!next.mxid && next.accumulated >= thresholdSeconds;

    return { state: next, shouldReport };
}

// 创建上报器：upload / isEnabled / isAuthenticated 由外部注入，便于解耦与测试
export function createPlayHistoryReporter({
    upload,
    isEnabled = () => true,
    isAuthenticated = () => true,
    thresholdSeconds = DEFAULT_THRESHOLD_SECONDS,
    maxDeltaSeconds = DEFAULT_MAX_DELTA_SECONDS,
} = {}) {
    let state = { key: null, mxid: '', accumulated: 0, reported: false, lastTime: null };

    const tick = (sample) => {
        // 开关关闭或未登录：不累计（并保持时间基线），避免重新开启后补报
        if (!isEnabled() || !isAuthenticated()) {
            state = { ...state, accumulated: 0, reported: false, lastTime: Number(sample.currentTime) || 0 };
            return;
        }

        const result = accumulate(state, sample, { thresholdSeconds, maxDeltaSeconds });
        state = result.state;

        if (result.shouldReport) {
            state = { ...state, reported: true };
            const payload = {
                mxid: state.mxid,
                ot: Math.floor(Date.now() / 1000),
                pc: 1,
            };
            if (typeof upload !== 'function') return;
            try {
                const maybePromise = upload(payload);
                if (maybePromise && typeof maybePromise.catch === 'function') {
                    maybePromise.catch((error) => {
                        console.warn('[PlayHistory] 上报失败:', error?.message || error);
                    });
                }
            } catch (error) {
                console.warn('[PlayHistory] 上报异常:', error?.message || error);
            }
        }
    };

    const endSession = () => {
        state = { ...state, accumulated: 0, reported: false, lastTime: null };
    };

    const getState = () => ({ ...state });

    return { tick, endSession, getState };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test src/utils/playHistoryReporter.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/utils/playHistoryReporter.js src/utils/playHistoryReporter.test.js
git commit -m "feat(player): add play history reporter core with tests"
```

---

### Task 2: 请求层新增静默 GET

**Files:**
- Modify: `src/utils/request.js`（在 `export const get` 定义之后追加）

**Interfaces:**
- Produces: `silentGet(url, params) => Promise<AxiosResponse>`（走 `__rawResponse`，绕过风控弹窗）

- [ ] **Step 1: 新增 `silentGet`**

在 `src/utils/request.js` 中，找到 `export const get = async (url, params = {}, config = {}, onSuccess = null, onError = null) => {` 所在函数的结尾（即下一个 `// 封装 POST 请求` 注释之前），在该注释前插入：

```js
// 静默 GET：绕过风控弹窗，返回原始 axios 响应；供后台任务（如播放历史上报）使用
export const silentGet = (url, params = {}) =>
    httpClient.get(url, { params, __rawResponse: true, __skipRisk: true });
```

- [ ] **Step 2: 构建校验（本任务无自动化测试）**

Run: `npm run build`
Expected: 构建成功，无语法错误。

- [ ] **Step 3: 提交**

```bash
git add src/utils/request.js
git commit -m "feat(request): add silentGet for background tasks"
```

---

### Task 3: 捕获并携带 mxid

**Files:**
- Modify: `src/components/player/songQueue/OnlineMusicQueue.js`
- Modify: `src/components/player/SongQueue.js`

**Interfaces:**
- Consumes: `/privilege/lite` 响应中的 `data[].album_audio_id`
- Produces: `currentSong.mxid: string` 与队列歌曲对象的 `mxid` 字段（供 Task 5 的采样使用）

- [ ] **Step 1: 在 `OnlineMusicQueue.js` 进入时记录上一首的 hash/mxid**

找到：

```js
            clearTimeout(timeoutId.value);
            currentSong.value.author = author;
```

替换为：

```js
            clearTimeout(timeoutId.value);
            const previousHash = currentSong.value.hash;
            const previousMxid = currentSong.value.mxid || '';
            let resolvedMxid = '';
            currentSong.value.author = author;
```

- [ ] **Step 2: 在重置字段处清空 mxid**

找到：

```js
            currentSong.value.resolvedQuality = '';
            currentSong.value.qualityLabel = '';
            currentSong.value.qualityOptions = [];
```

替换为：

```js
            currentSong.value.resolvedQuality = '';
            currentSong.value.qualityLabel = '';
            currentSong.value.qualityOptions = [];
            currentSong.value.mxid = '';
```

- [ ] **Step 3: 从 `/privilege/lite` 响应提取 `album_audio_id`**

找到：

```js
                    if (qualityOptions.length === 0) {
                        const privilegeResponse = await get(`/privilege/lite`, { hash: hash });
                        if (isStaleRequest()) return { stale: true };
                        qualityOptions = getQualityOptions(privilegeResponse);
                    }
```

替换为：

```js
                    if (qualityOptions.length === 0) {
                        const privilegeResponse = await get(`/privilege/lite`, { hash: hash });
                        if (isStaleRequest()) return { stale: true };
                        const privilegeItems = Array.isArray(privilegeResponse?.data) ? privilegeResponse.data : [];
                        const matched = privilegeItems.find(item => item && item.hash === hash) || privilegeItems[0];
                        resolvedMxid = matched?.album_audio_id ? String(matched.album_audio_id) : '';
                        qualityOptions = getQualityOptions(privilegeResponse);
                    }
```

- [ ] **Step 4: 计算最终 mxid 并写入 `currentSong` 与歌曲对象**

找到：

```js
            // 创建歌曲对象
            const song = {
                id: musicQueueStore.queue.length + 1,
                hash: hash,
```

替换为：

```js
            // 解析 mxid（专辑音频 id）：优先本次拿到，其次同曲缓存（如仅切换音质）
            const mxid = resolvedMxid || (hash === previousHash ? previousMxid : '');
            currentSong.value.mxid = mxid;

            // 创建歌曲对象
            const song = {
                id: musicQueueStore.queue.length + 1,
                hash: hash,
                mxid: mxid,
```

- [ ] **Step 5: 在 `SongQueue.js` 的 `currentSong` 初始结构加入 `mxid`**

找到：

```js
        hash: '',
        playHash: '',
```

替换为：

```js
        hash: '',
        mxid: '',
        playHash: '',
```

- [ ] **Step 6: 构建校验**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 7: 提交**

```bash
git add src/components/player/songQueue/OnlineMusicQueue.js src/components/player/SongQueue.js
git commit -m "feat(player): capture album_audio_id as mxid for play history"
```

---

### Task 4: AudioController 提供可靠的播放采样回调

**Files:**
- Modify: `src/components/player/AudioController.js`

**Interfaces:**
- Produces: `useAudioController({ onSongEnd, updateCurrentTime, onPlaybackProgress })`
  - `onPlaybackProgress({ currentTime: number, paused: boolean })` 在原生 `timeupdate` 时被调用

- [ ] **Step 1: 扩展函数签名**

找到：

```js
export default function useAudioController({ onSongEnd, updateCurrentTime }) {
```

替换为：

```js
export default function useAudioController({ onSongEnd, updateCurrentTime, onPlaybackProgress = null }) {
```

- [ ] **Step 2: 新增采样处理函数**

找到：

```js
    // 处理播放/暂停事件
    const handleAudioEvent = (event) => {
```

替换为：

```js
    // 播放历史上报专用采样：独立于失效的 updateCurrentTime，保证可靠触发
    const handlePlaybackProgress = () => {
        if (typeof onPlaybackProgress === 'function') {
            onPlaybackProgress({ currentTime: audio.currentTime, paused: audio.paused });
        }
    };

    // 处理播放/暂停事件
    const handleAudioEvent = (event) => {
```

- [ ] **Step 3: 注册监听**

找到：

```js
        audio.addEventListener('timeupdate', updateCurrentTime);
```

替换为：

```js
        audio.addEventListener('timeupdate', updateCurrentTime);
        audio.addEventListener('timeupdate', handlePlaybackProgress);
```

- [ ] **Step 4: 注销监听**

找到：

```js
        audio.removeEventListener('timeupdate', updateCurrentTime);
```

替换为：

```js
        audio.removeEventListener('timeupdate', updateCurrentTime);
        audio.removeEventListener('timeupdate', handlePlaybackProgress);
```

- [ ] **Step 5: 构建校验**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 6: 提交**

```bash
git add src/components/player/AudioController.js
git commit -m "feat(player): add reliable playback progress callback"
```

---

### Task 5: PlayerControl 接线

**Files:**
- Modify: `src/components/PlayerControl.vue`

**Interfaces:**
- Consumes: `createPlayHistoryReporter`（Task 1）、`silentGet`（Task 2）、`currentSong.mxid`（Task 3）、`onPlaybackProgress`（Task 4）
- Produces: 端到端生效——播放满 30 秒触发 `/playhistory/upload`

- [ ] **Step 1: 扩展导入**

找到：

```js
import { get } from '../utils/request';
```

替换为：

```js
import { get, silentGet } from '../utils/request';
import { MoeAuthStore } from '../stores/store';
import { createPlayHistoryReporter } from '../utils/playHistoryReporter';
```

- [ ] **Step 2: 声明 reporter 变量**

找到：

```js
const currentTime = ref(0);
```

替换为：

```js
const currentTime = ref(0);
let playHistoryReporter = null;
```

- [ ] **Step 3: 定义采样回调并接入 useAudioController**

找到：

```js
// 初始化各个模块
const audioController = useAudioController({ onSongEnd, updateCurrentTime });
```

替换为：

```js
// 播放历史上报：把 AudioController 的可靠采样转成 reporter.tick
const handlePlaybackProgress = ({ currentTime: progressTime, paused }) => {
    if (!playHistoryReporter) return;
    playHistoryReporter.tick({
        sessionKey: currentSong.value?.hash || '',
        mxid: currentSong.value?.mxid || '',
        currentTime: progressTime,
        paused,
    });
};

// 初始化各个模块
const audioController = useAudioController({ onSongEnd, updateCurrentTime, onPlaybackProgress: handlePlaybackProgress });
```

- [ ] **Step 4: 实例化 reporter**

找到：

```js
const { currentSong, NextSong, addSongToQueue, addCloudMusicToQueue, addLocalMusicToQueue, addLocalPlaylistToQueue, addToNext, getPlaylistAllSongs, addPlaylistToQueue, addCloudPlaylistToQueue, restoreLocalSongCover } = songQueue;
```

在该行之后新增：

```js

playHistoryReporter = createPlayHistoryReporter({
    upload: ({ mxid, ot, pc }) => silentGet('/playhistory/upload', { mxid, ot, pc }),
    isEnabled: () => JSON.parse(localStorage.getItem('settings') || '{}').uploadPlayHistory === 'on',
    isAuthenticated: () => {
        try {
            return !!MoeAuthStore().isAuthenticated;
        } catch (error) {
            return false;
        }
    },
});
```

- [ ] **Step 5: 歌曲结束时结束会话**

找到：

```js
const onSongEnd = () => {
    if (currentPlaybackModeIndex.value == 2) return; // 单曲循环
```

替换为：

```js
const onSongEnd = () => {
    playHistoryReporter?.endSession();
    if (currentPlaybackModeIndex.value == 2) return; // 单曲循环
```

- [ ] **Step 6: 构建校验**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 7: 提交**

```bash
git add src/components/PlayerControl.vue
git commit -m "feat(player): wire play history upload into playback"
```

---

### Task 6: 设置开关与多语言文案

**Files:**
- Modify: `src/config/settings.js`
- Modify: `src/language/zh-CN.json`
- Modify: `src/language/zh-TW.json`
- Modify: `src/language/en.json`
- Modify: `src/language/ja.json`
- Modify: `src/language/ko.json`
- Modify: `src/language/ru.json`

**Interfaces:**
- Produces: 设置项 `uploadPlayHistory`（默认 `'off'`），供 Task 5 的 `isEnabled` 读取

- [ ] **Step 1: 在 `settings.js` 的「声音」分组末尾新增开关**

找到：

```js
                showRefreshHint: true,
                refreshHintText: t('zhong-qi-hou-sheng-xiao'),
                helpLink: 'https://music.moekoe.cn/guide/data-source.html'
            }
        ]
    },
```

替换为：

```js
                showRefreshHint: true,
                refreshHintText: t('zhong-qi-hou-sheng-xiao'),
                helpLink: 'https://music.moekoe.cn/guide/data-source.html'
            },
            {
                key: 'uploadPlayHistory',
                defaultValue: 'off',
                itemIcon: 'fas fa-cloud-upload-alt',
                selectionTitle: t('shang-chuan-ting-ge-ji-lu'),
                options: [
                    { displayText: t('da-kai'), value: 'on' },
                    { displayText: t('guan-bi'), value: 'off' }
                ],
                label: t('shang-chuan-ting-ge-ji-lu'),
                icon: '☁️ '
            }
        ]
    },
```

- [ ] **Step 2: 六个语言文件各新增一个键**

在每个 `src/language/*.json` 中，定位包含 `"shu-ju-yuan":` 的那一行，紧接其后插入对应的一行：

`src/language/zh-CN.json`（注意行尾逗号）：
```json
  "shang-chuan-ting-ge-ji-lu": "上传听歌记录到酷狗",
```

`src/language/zh-TW.json`：
```json
  "shang-chuan-ting-ge-ji-lu": "上傳聽歌記錄到酷狗",
```

`src/language/en.json`：
```json
  "shang-chuan-ting-ge-ji-lu": "Upload play history to KuGou",
```

`src/language/ja.json`：
```json
  "shang-chuan-ting-ge-ji-lu": "再生履歴をKuGouにアップロード",
```

`src/language/ko.json`：
```json
  "shang-chuan-ting-ge-ji-lu": "재생 기록을 KuGou에 업로드",
```

`src/language/ru.json`：
```json
  "shang-chuan-ting-ge-ji-lu": "Загружать историю прослушиваний в KuGou",
```

- [ ] **Step 3: 校验 JSON 合法性与构建**

Run: `node -e "['zh-CN','zh-TW','en','ja','ko','ru'].forEach(l=>{JSON.parse(require('fs').readFileSync('src/language/'+l+'.json','utf8'))});console.log('json ok')" && npm run build`
Expected: 输出 `json ok`，随后构建成功。

- [ ] **Step 4: 提交**

```bash
git add src/config/settings.js src/language/zh-CN.json src/language/zh-TW.json src/language/en.json src/language/ja.json src/language/ko.json src/language/ru.json
git commit -m "feat(settings): add play history upload toggle with i18n"
```

---

### Task 7: 端到端手动验证

**Files:** 无（验证任务）

- [ ] **Step 1: 启动开发模式**

Run: `npm run dev`
Expected: 应用启动，本地 API 日志出现 `server running @ http://localhost:6521`。

- [ ] **Step 2: 关闭开关时不上报**

在「设置 → 声音」保持「上传听歌记录到酷狗」为关闭，播放一首在线歌曲 ≥35 秒，再切歌。
Expected: API 日志**不出现** `[OK] /playhistory/upload`。

- [ ] **Step 3: 打开开关后上报一次**

打开该开关，播放同一首歌 ≥35 秒。
Expected: API 日志出现一次 `[OK] /playhistory/upload`；控制台无报错；`console` 无风控弹窗。

- [ ] **Step 4: 反向用例**

分别验证：
- 播放 <30 秒即切歌 → 不上报。
- 播放本地音乐 → 不上报。
- 同一首歌在同一会话内播放超过 30 秒后继续播放 → 只上报一次。
- 从头重播同一首歌并再满 30 秒 → 再上报一次。

- [ ] **Step 5: 酷狗端确认**

到酷狗客户端/网页刷新「听歌历史 / 听歌时长」。
Expected: 出现对应播放记录（服务端可能有延迟）。

- [ ] **Step 6: 提交验证记录（可选）**

如无代码改动则无需提交；若为验证调整了参数，单独提交并说明。

---

## 自审记录

- **Spec 覆盖**：接口/可行性（Task 2/3/5）、阈值与会话（Task 1）、可靠采样钩子（Task 4）、开关默认关（Task 6）、静默与不重试（Task 1/2/5）、验证（Task 7）——均有对应任务。
- **对 spec 的一处收敛**：spec §4 曾提"`addSongToQueue` 增加可选 `mxid` 参数透传"。经核对播放路径（`playSongFromQueue` 对在线歌曲始终调用 `addSongToQueue`，会拉取 `/privilege/lite`），改为**只在 `OnlineMusicQueue` 内捕获 mxid** 即可覆盖全部在线播放路径，无需改动多处调用点与签名（YAGNI）。
- **类型一致性**：`tick` 的字段（`sessionKey`/`mxid`/`currentTime`/`paused`）、`upload` 的 `{mxid, ot, pc}`、以及 `currentSong.mxid` 在各任务间命名一致。
- **无占位符**：所有步骤均含可执行代码或确切命令。
