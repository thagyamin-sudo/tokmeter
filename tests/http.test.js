/**
 * src/sources/http.js 的单测：JSON 轮询数据源的映射、失败降级与生命周期。
 * 全部注入假 fetchImpl，轮询间隔压到 1ms，不依赖真实网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySnapshot } from '../src/store.js';
import { formatClock } from '../src/format.js';
import { createHttpSource, mapPayload } from '../src/sources/http.js';

const NOW = 1735689600000;
const httpSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待：不写死 sleep 时长，只在预算内等到条件成立（上限 90ms，远小于 100ms）。 */
async function httpWaitFor(pred, budgetMs = 90) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await httpSleep(1);
  }
  return pred();
}

test('mapPayload：浅合并负载，缺失与非有限数值沿用 prev，状态固定 live', () => {
  const prev = emptySnapshot(NOW);
  prev.output.history = [1, 2, 3];
  prev.requests = { active: 8, queued: 1, capacity: 12 };

  const next = mapPayload({
    requests: { active: 3, queued: 0 },
    output: { tokPerSec: 240 },
    kvCache: { usage: 0.4, hitRate: 0.9, headroom: '余量紧张' },
    extraTopLevel: 42,
  }, prev);

  assert.equal(next.requests.active, 3);
  assert.equal(next.requests.queued, 0);
  assert.equal(next.requests.capacity, 12, '负载缺失的字段沿用 prev');
  assert.equal(next.output.tokPerSec, 240);
  assert.deepEqual(next.output.history, [1, 2, 3], '负载没给 history 就保留上一帧曲线');
  assert.equal(next.kvCache.usage, 0.4);
  assert.equal(next.kvCache.headroom, '余量紧张');
  assert.equal(next.extraTopLevel, 42, '未知顶层字段照搬');
  assert.equal(next.status, 'live');
  assert.equal(next.model.name, prev.model.name);
  assert.deepEqual(prev.output.history, [1, 2, 3], '不得就地修改 prev');

  const bad = mapPayload({ output: { tokPerSec: NaN }, requests: { active: Infinity }, clock: 9 }, prev);
  assert.equal(bad.output.tokPerSec, prev.output.tokPerSec, '非有限数值不得写入，回退到 prev 的取值');
  assert.equal(bad.requests.active, 8);
  assert.equal(bad.clock, prev.clock);
  assert.equal(mapPayload(null, prev).status, 'live');
  assert.equal(mapPayload(null, prev).requests.active, 8);
});

test('createHttpSource：start 立即拉取一次并映射成功负载', async () => {
  let calls = 0;
  const payload = { requests: { active: 4, queued: 0 }, output: { tokPerSec: 111 } };
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => payload };
  };
  const samples = [];
  const src = createHttpSource({ endpoint: 'http://x/metrics', intervalMs: 1000, fetchImpl, now: () => NOW });
  try {
    src.start((s) => samples.push(s));
    assert.ok(await httpWaitFor(() => samples.length >= 1), 'start 后应立即产生一帧，而不是等到第一个间隔');
    assert.equal(src.status, 'live');
    assert.equal(samples[0].requests.active, 4);
    assert.equal(samples[0].output.tokPerSec, 111);
    assert.equal(samples[0].status, 'live');
    assert.equal(samples[0].updatedAt, NOW, '数据源用注入的 now() 打接收时间戳');
    assert.equal(samples[0].clock, formatClock(new Date(NOW)), '负载没给 clock 时补本地时钟');
    assert.equal(calls, 1, '间隔 1000ms 时 90ms 内只应有这一次请求');
  } finally {
    src.stop();
  }
});

test('createHttpSource：负载自带 clock 时尊重负载，缺失时补本地时钟', async () => {
  const payloads = [{ clock: '09:30:00', requests: { active: 1 } }, { requests: { active: 2 } }];
  let i = 0;
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => payloads[Math.min(i++, payloads.length - 1)] });
  const samples = [];
  const src = createHttpSource({ endpoint: 'http://x', intervalMs: 1, fetchImpl, now: () => NOW });
  try {
    src.start((s) => samples.push(s));
    assert.ok(await httpWaitFor(() => samples.length >= 2));
    assert.equal(samples[0].clock, '09:30:00');
    assert.equal(samples[1].clock, formatClock(new Date(NOW)));
    assert.equal(samples[0].requests.active, 1);
  } finally {
    src.stop();
  }
});

test('createHttpSource：连续 3 次失败进入 stale，连续 5 次进入 error', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('connect ECONNREFUSED');
  };
  const samples = [];
  const src = createHttpSource({ endpoint: 'http://x', intervalMs: 1, fetchImpl, now: () => NOW });
  try {
    src.start((s) => samples.push(s));
    assert.ok(await httpWaitFor(() => calls >= 3), '3 次请求应在预算内完成');
    assert.equal(src.status, 'stale');
    assert.deepEqual(samples.map((s) => s.status), ['live', 'live', 'stale'],
      '前两次失败仍算 live，第 3 次起降级为 stale');
    assert.ok(await httpWaitFor(() => calls >= 5));
    assert.equal(src.status, 'error');
    assert.equal(samples.at(-1).status, 'error', 'error 帧同样要 onSample');
    assert.ok(samples.length >= 5, '降级期间不得停止上报');
  } finally {
    src.stop();
  }
});

test('createHttpSource：非 2xx 与非法 JSON 都被吞掉，不产生未处理拒绝', async () => {
  const rejections = [];
  const onRejection = (e) => rejections.push(e);
  process.on('unhandledRejection', onRejection);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls % 2 === 1) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); } };
  };
  const samples = [];
  const src = createHttpSource({ endpoint: 'http://x', intervalMs: 1, fetchImpl, now: () => NOW });
  try {
    src.start((s) => samples.push(s));
    assert.ok(await httpWaitFor(() => calls >= 5));
    await httpSleep(5);
    assert.equal(src.status, 'error');
    assert.equal(samples.at(-1).status, 'error');
    assert.deepEqual(rejections, [], '失败路径不得冒出未处理拒绝');
  } finally {
    src.stop();
    await httpSleep(5);
    process.off('unhandledRejection', onRejection);
  }
  assert.deepEqual(rejections, []);
});

test('createHttpSource：stop() 之后不再调用 fetchImpl，也不再上报', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ requests: { active: calls } }) };
  };
  const samples = [];
  const src = createHttpSource({ endpoint: 'http://x', intervalMs: 1, fetchImpl, now: () => NOW });
  src.start((s) => samples.push(s));
  assert.ok(await httpWaitFor(() => calls >= 2));
  src.stop();
  const callsAtStop = calls;
  const samplesAtStop = samples.length;
  await httpSleep(25);
  assert.equal(calls, callsAtStop, 'stop 之后不允许再发起请求');
  assert.equal(samples.length, samplesAtStop, 'stop 之后不允许再上报');
  assert.ok(callsAtStop >= 2);
});
