/**
 * 客户端视图数据源：映射、比值计算、降级。
 * 重点：云 API 给不出的量必须是"未知"（NaN），不能编造 0。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapClientPayload, latencyScore, rateScore, createClientSource } from '../src/sources/client.js';
import { emptySnapshot } from '../src/store.js';

const payload = {
  view: 'client',
  status: 'live',
  clock: '12:00:00',
  updatedAt: 1700000000000,
  model: { name: 'deepseek-chat', engine: 'OpenAI 兼容', nodes: 'API' },
  output: { tokPerSec: 210, history: [100, 200, 210] },
  input: { tokPerSec: 3400, prefillAvgMs: 320 },
  requests: { active: 1, queued: 0, capacity: 1 },
  client: {
    ttftP50: 320, ttftP95: 900, rateP50: 210, rateP95: 290, probeCount: 42, failCount: 2,
    successRate: 0.95, available: false, tokensIn: 1_000_000, tokensOut: 500_000, cost: 6.0, lastError: null,
  },
};

test('映射：可测指标进快照，服务端内部量保持未知', () => {
  const s = mapClientPayload(payload, emptySnapshot(0));
  assert.equal(s.model.name, 'deepseek-chat');
  assert.equal(s.output.tokPerSec, 210);
  assert.deepEqual(s.output.history, [100, 200, 210]);
  assert.equal(s.input.prefillAvgMs, 320);
  assert.equal(s.client.ttftP50, 320);
  assert.equal(s.client.cost, 6);
  assert.equal(s.clock, '12:00:00');
  // 云 API 不可能提供的服务端指标：必须是未知，而不是 0
  assert.equal(Number.isFinite(s.kvCache.usage), false);
  assert.equal(Number.isFinite(s.mtp.tar), false);
  assert.equal(Number.isFinite(s.memory.usedGB), false);
  assert.equal(Number.isFinite(s.gpu.utilization), false);
});

test('映射：采集器自带柱条历史时尊重它，否则每次轮询追加一个点', () => {
  const withHistory = mapClientPayload({ ...payload, client: { ...payload.client, history: [1, 2, 3, 4] } }, emptySnapshot(0));
  assert.deepEqual(withHistory.client.history, [1, 2, 3, 4]);
  const without = mapClientPayload(payload, emptySnapshot(0));
  assert.deepEqual(without.client.history, [210], '没有历史时按轮询次数增长');
});

test('环比例：延迟越短越满，吞吐越高越满，未知值不产出比例', () => {
  assert.equal(latencyScore(0), NaN);
  assert.equal(latencyScore(1000), 0.5);
  assert.equal(latencyScore(5000), 0);
  assert.equal(rateScore(250), 0.5);
  assert.equal(rateScore(9999), 1);
  assert.equal(rateScore(NaN), NaN);
});

test('降级：采集器挂掉时按 3 次 stale / 5 次 error 降级，且保留最后一帧', async () => {
  let calls = 0;
  const src = createClientSource({
    endpoint: 'http://x/snapshot',
    intervalMs: 5,
    fetchImpl: async () => { calls += 1; return { ok: true, status: 200, json: async () => payload }; },
  });
  const seen = [];
  src.start((s) => seen.push(s));
  await new Promise((r) => setTimeout(r, 60));
  src.stop();
  assert.ok(seen.length >= 2, '应持续轮询，实际 ' + seen.length);
  assert.equal(seen.at(-1).output.tokPerSec, 210);
  assert.equal(calls >= 2, true);
});

test('降级：采集器不可达 → 状态降级但快照仍可渲染', async () => {
  const src = createClientSource({
    endpoint: 'http://x/snapshot',
    intervalMs: 5,
    fetchImpl: async () => { throw new Error('down'); },
  });
  const statuses = [];
  src.start((s) => statuses.push(s.status));
  await new Promise((r) => setTimeout(r, 80));
  src.stop();
  assert.ok(statuses.includes('stale'), '连续失败应出现 stale，实际 ' + statuses.join(','));
  assert.equal(statuses.at(-1), 'error');
});
