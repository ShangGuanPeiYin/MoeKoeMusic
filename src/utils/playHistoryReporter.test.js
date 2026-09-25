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

test('isEnabled/isAuthenticated 抛异常时不上报且不外抛', () => {
    const calls = [];
    const reporter = createPlayHistoryReporter({
        upload: (payload) => calls.push(payload),
        isEnabled: () => { throw new Error('boom'); },
        isAuthenticated: () => { throw new Error('boom'); },
    });
    assert.doesNotThrow(() => {
        for (let t = 0; t <= 60; t += 1) reporter.tick({ sessionKey: 'k', mxid: '1', currentTime: t, paused: false });
    });
    assert.equal(calls.length, 0);
});

test('upload 非函数时不抛出', () => {
    const reporter = createPlayHistoryReporter({
        upload: undefined,
        isEnabled: () => true,
        isAuthenticated: () => true,
    });
    assert.doesNotThrow(() => {
        for (let t = 0; t <= 31; t += 1) reporter.tick({ sessionKey: 'k', mxid: '1', currentTime: t, paused: false });
    });
});
