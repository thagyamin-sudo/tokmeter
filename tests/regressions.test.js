/**
 * 评审驱动的回归测试（独立评审者发现的问题，每条都先红后绿）。
 * 这些是"真实使用者会撞上"的场景，不是边界洁癖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySnapshot } from '../src/store.js';
import { mapPayload } from '../src/sources/http.js';
import { parsePrometheus, toSnapshot } from '../src/sources/vllm-metrics.js';
import { createHttpSource } from '../src/sources/http.js';

test('回归 C1：JSON 端点不提供 history 时，数据源必须自己维护曲线窗口', () => {
  const prev = emptySnapshot(0);
  prev.output = { tokPerSec: 100, history: [1, 2, 3] };
  prev.gpu = { utilization: 0.5, state: '计算中', history: [0.1, 0.2] };

  const out = mapPayload({ output: { tokPerSec: 257 }, gpu: { utilization: 0.9 } }, prev);

  assert.deepEqual(out.output.history, [1, 2, 3, 257], '曲线窗口应由数据源追加，否则 ?source=http 永远画不出折线');
  assert.deepEqual(out.gpu.history, [0.1, 0.2, 0.9], 'GPU 柱条同理');
});

test('回归 C1：负载自带 history 时尊重负载', () => {
  const out = mapPayload({ output: { tokPerSec: 1, history: [9, 9] } }, emptySnapshot(0));
  assert.deepEqual(out.output.history, [9, 9]);
});

test('回归 C1：非法速率不污染曲线窗口', () => {
  const prev = emptySnapshot(0);
  prev.output = { tokPerSec: 100, history: [1, 2] };
  const out = mapPayload({ output: { tokPerSec: 'x' } }, prev);
  assert.deepEqual(out.output.history, [1, 2]);
});

test('回归 C4：端点不可达时，降级帧的时钟必须继续走（时钟是"现在"，不是数据）', async () => {
  let t = 1700000000000;
  const clocks = [];
  const source = createHttpSource({
    endpoint: 'http://127.0.0.1:1/metrics',
    intervalMs: 5,
    now: () => (t += 1000),
    fetchImpl: async () => { throw new Error('down'); },
  });
  source.start((s) => clocks.push(s.clock));
  const deadline = Date.now() + 2000;
  while (clocks.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  source.stop();
  assert.ok(clocks.length >= 3, '必须收到多帧降级帧，实际 ' + clocks.length);
  assert.notEqual(clocks[0], clocks[2], '时钟不得冻结在最后一帧');
  assert.notEqual(clocks[0], '00:00:00', '从未连上时也不能显示 00:00:00');
});

test('回归 I2：vLLM 缺失的指标必须是"未知"（NaN → 界面显示 --），不能是假 0', () => {
  const text = [
    'vllm:num_requests_running{model_name="q"} 8',
    'vllm:num_requests_waiting{model_name="q"} 1',
    'vllm:avg_generation_throughput_toks_per_s{model_name="q"} 258.2',
    'vllm:gpu_cache_usage_perc{model_name="q"} 0.16',
    'vllm:gpu_prefix_cache_hit_rate{model_name="q"} 0.93',
  ].join('\n');
  const s = toSnapshot(parsePrometheus(text), emptySnapshot(0), 0);

  assert.equal(s.requests.active, 8);
  assert.equal(s.output.tokPerSec, 258.2);
  assert.equal(s.kvCache.usage, 0.16);
  // /metrics 里没有的量：不能谎报 0
  assert.equal(Number.isFinite(s.memory.usedGB), false, '显存用量未知');
  assert.equal(Number.isFinite(s.memory.totalGB), false, '显存总量未知');
  assert.equal(Number.isFinite(s.mtp.tar), false, 'TAR 未知');
  assert.equal(Number.isFinite(s.mtp.ratio), false, 'MTP 比值未知');
  assert.equal(Number.isFinite(s.input.tokPerSec), false, '输入速率未知');
  assert.equal(Number.isFinite(s.gpu.utilization), false, 'GPU 利用率未知');
  assert.equal(s.gpu.state, '--');
});
