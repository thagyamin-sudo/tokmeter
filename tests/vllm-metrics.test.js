/**
 * src/sources/vllm-metrics.js 的单测：Prometheus 文本解析与 Snapshot 映射。
 * 覆盖正常样本、畸形输入、缺字段回退与 history 窗口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySnapshot } from '../src/store.js';
import { formatClock } from '../src/format.js';
import { parsePrometheus, toSnapshot } from '../src/sources/vllm-metrics.js';

/** 真实 vLLM /metrics 的节选：含 HELP/TYPE 注释、带标签行、无标签行与可选时间戳列。 */
const SAMPLE = [
  '# HELP vllm:num_requests_running Number of requests currently running on GPU.',
  '# TYPE vllm:num_requests_running gauge',
  'vllm:num_requests_running{model_name="Qwen3.8-Flash"} 8.0',
  '# HELP vllm:num_requests_waiting Number of requests waiting to be processed.',
  '# TYPE vllm:num_requests_waiting gauge',
  'vllm:num_requests_waiting{model_name="Qwen3.8-Flash"} 1.0',
  '# HELP vllm:avg_generation_throughput_toks_per_s Average generation throughput in tokens/s.',
  '# TYPE vllm:avg_generation_throughput_toks_per_s gauge',
  'vllm:avg_generation_throughput_toks_per_s{model_name="Qwen3.8-Flash"} 257.3',
  '# HELP vllm:gpu_cache_usage_perc GPU KV-cache usage. 1 means 100 percent usage.',
  '# TYPE vllm:gpu_cache_usage_perc gauge',
  'vllm:gpu_cache_usage_perc{model_name="Qwen3.8-Flash"} 0.16',
  '# HELP vllm:gpu_prefix_cache_hit_rate GPU prefix cache hit rate. 1 means 100 percent.',
  '# TYPE vllm:gpu_prefix_cache_hit_rate gauge',
  'vllm:gpu_prefix_cache_hit_rate{model_name="Qwen3.8-Flash"} 0.93',
  '# TYPE vllm:request_success_total counter',
  'vllm:request_success_total{model_name="Qwen3.8-Flash",finished_reason="stop"} 42',
  'vllm:kv_cache_usage_perc 0.21 1699999999999',
].join('\n');

const NOW = 1735689600000;

test('parsePrometheus：正常样本取值正确，注释被跳过、标签与时间戳被忽略', () => {
  const m = parsePrometheus(SAMPLE);
  assert.equal(m['vllm:num_requests_running'], 8);
  assert.equal(m['vllm:num_requests_waiting'], 1);
  assert.equal(m['vllm:avg_generation_throughput_toks_per_s'], 257.3);
  assert.equal(m['vllm:gpu_cache_usage_perc'], 0.16);
  assert.equal(m['vllm:gpu_prefix_cache_hit_rate'], 0.93);
  assert.equal(m['vllm:request_success_total'], 42);
  assert.equal(m['vllm:kv_cache_usage_perc'], 0.21, '带时间戳的样本只取数值列');
  for (const v of Object.values(m)) assert.equal(typeof v, 'number');
  assert.equal(Object.keys(m).length, 7, 'HELP/TYPE 注释不得进入结果');
});

test('parsePrometheus：空串、半行、非数字一律跳过且任何输入都不抛异常', () => {
  assert.deepEqual(parsePrometheus(''), {});
  assert.deepEqual(parsePrometheus('\n\n   \n'), {});
  assert.deepEqual(parsePrometheus([
    'vllm:broken{model_name="x" 5',      // 半行：标签未闭合
    'vllm:no_value',                     // 半行：只有名字没有值
    'vllm:non_numeric abc',              // 非数字
    '{model_name="x"} 5',                // 缺少指标名
    'this is not a metric line',         // 非数字列
    'vllm:also_bad NaN',                 // NaN 不是有限数
  ].join('\n')), {});
  assert.deepEqual(parsePrometheus('# HELP vllm:ok ok\nvllm:ok 1\nbad line\nvllm:bad x'), { 'vllm:ok': 1 });
  assert.deepEqual(parsePrometheus(undefined), {});
  assert.deepEqual(parsePrometheus(null), {});
  assert.deepEqual(parsePrometheus(12345), {});
  assert.doesNotThrow(() => parsePrometheus('\u0000{vllm:x} ?? \n'));
});

test('toSnapshot：五个核心指标映射到位，其余字段保留 prev，状态与时钟被刷新', () => {
  const prev = emptySnapshot(NOW - 1000);
  prev.output.history = [200];

  const s = toSnapshot({
    'vllm:num_requests_running': 7.6,
    'vllm:num_requests_waiting': 1.4,
    'vllm:avg_generation_throughput_toks_per_s': 257.3,
    'vllm:gpu_cache_usage_perc': 0.16,
    'vllm:gpu_prefix_cache_hit_rate': 0.93,
  }, prev, NOW);

  assert.equal(s.requests.active, 8, '活动请求数取整');
  assert.equal(s.requests.queued, 1, '排队数取整');
  assert.equal(s.requests.capacity, prev.requests.capacity);
  assert.equal(s.output.tokPerSec, 257.3);
  assert.deepEqual(s.output.history, [200, 257.3], '既有历史保留，新样本入队');
  assert.equal(s.kvCache.usage, 0.16, 'gpu_cache_usage_perc 已是 0~1');
  assert.equal(s.kvCache.hitRate, 0.93);
  assert.equal(s.kvCache.headroom, prev.kvCache.headroom);
  assert.equal(s.status, 'live');
  assert.equal(s.updatedAt, NOW);
  assert.equal(s.clock, formatClock(new Date(NOW)));
  assert.ok(/^\d{2}:\d{2}:\d{2}$/.test(s.clock));

  assert.deepEqual(s.model, prev.model, '未覆盖字段保留 prev');
  assert.deepEqual(s.input, prev.input);
  assert.deepEqual(s.mtp, prev.mtp);
  assert.deepEqual(s.memory, prev.memory);
  assert.deepEqual(s.gpu, prev.gpu);
  assert.deepEqual(prev.output.history, [200], '不得就地修改 prev');
});

test('toSnapshot：缺失或非有限的指标逐字段回退到 prev', () => {
  const prev = emptySnapshot(NOW);
  prev.requests = { active: 5, queued: 2, capacity: 12 };
  prev.output = { tokPerSec: 111, history: [111] };
  prev.input = { tokPerSec: 1700, prefillAvgMs: 320 };
  prev.kvCache = { usage: 0.4, hitRate: 0.9, headroom: '余量一般' };

  const s = toSnapshot({ 'vllm:num_requests_running': 3 }, prev, NOW);
  assert.equal(s.requests.active, 3);
  assert.equal(s.requests.queued, 2, '缺失指标沿用 prev');
  assert.equal(s.output.tokPerSec, 111);
  assert.equal(s.kvCache.usage, 0.4);
  assert.equal(s.kvCache.hitRate, 0.9);

  const bad = toSnapshot({
    'vllm:num_requests_running': NaN,
    'vllm:num_requests_waiting': Infinity,
    'vllm:gpu_cache_usage_perc': '0.5',
    'vllm:gpu_prefix_cache_hit_rate': null,
    'vllm:avg_generation_throughput_toks_per_s': 0,
  }, prev, NOW);
  assert.equal(bad.requests.active, 5, 'NaN 沿用 prev');
  assert.equal(bad.requests.queued, 2, 'Infinity 沿用 prev');
  assert.equal(bad.kvCache.usage, 0.4, '字符串不是数值，沿用 prev');
  assert.equal(bad.kvCache.hitRate, 0.9, 'null 沿用 prev');
  assert.equal(bad.output.tokPerSec, 0, '有限的 0 要照常写入，不能当成缺失');

  const fresh = toSnapshot({}, null, NOW);
  assert.equal(fresh.status, 'live');
  assert.equal(fresh.requests.active, 0);
  assert.deepEqual(fresh.output.history, [], 'prev 缺失且速率未知：不往曲线塞假点（界面显示 --）');
});

test('toSnapshot：output.history 窗口为 60，且保留既有历史', () => {
  const seed = { ...emptySnapshot(NOW), output: { tokPerSec: 0, history: [11, 22, 33] } };
  let s = seed;
  for (let i = 0; i < 100; i++) {
    s = toSnapshot({ 'vllm:avg_generation_throughput_toks_per_s': 100 + i }, s, NOW + i);
  }
  const expected = [11, 22, 33, ...Array.from({ length: 100 }, (_, i) => 100 + i)].slice(-60);
  assert.equal(s.output.history.length, 60);
  assert.deepEqual(s.output.history, expected);
  assert.equal(s.output.history.at(-1), 199);
  assert.equal(s.output.tokPerSec, 199);
  assert.equal(seed.output.history.length, 3, '种子快照不被修改');
});
