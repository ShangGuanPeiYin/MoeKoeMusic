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
