/**
 * 端到端：本地伪造一个 vLLM 的 /metrics 端点（真实 HTTP + 真实 fetch），
 * 验证 app.js 里 ?source=vllm 走的完整链路：轮询 → Prometheus 解析 → 快照映射。
 * 这是唯一一条"真的发请求"的测试，其余单测都用注入的 fetchImpl。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHttpSource } from '../src/sources/http.js';
import { parsePrometheus, toSnapshot } from '../src/sources/vllm-metrics.js';

const METRICS = [
  '# HELP vllm:num_requests_running Number of requests currently running on GPU.',
  '# TYPE vllm:num_requests_running gauge',
  'vllm:num_requests_running{model_name="qwen"} 8.0',
  '# TYPE vllm:num_requests_waiting gauge',
  'vllm:num_requests_waiting{model_name="qwen"} 1.0',
  '# TYPE vllm:avg_generation_throughput_toks_per_s gauge',
  'vllm:avg_generation_throughput_toks_per_s{model_name="qwen"} 257.4',
  '# TYPE vllm:gpu_cache_usage_perc gauge',
  'vllm:gpu_cache_usage_perc{model_name="qwen"} 0.16',
  '# TYPE vllm:gpu_prefix_cache_hit_rate gauge',
  'vllm:gpu_prefix_cache_hit_rate{model_name="qwen"} 0.93',
  '',
].join('\n');

test('端到端：真实 HTTP 的 /metrics → 面板快照', async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.setHeader('content-type', 'text/plain; version=0.0.4');
    res.end(METRICS);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;

  const source = createHttpSource({
    endpoint: 'http://127.0.0.1:' + port + '/metrics',
    intervalMs: 20,
    transform: async (res, prev, now) => toSnapshot(parsePrometheus(await res.text()), prev, now),
  });

  const first = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    source.start((s) => {
      clearTimeout(timer);
      source.stop();
      resolve(s);
    });
  });
  server.close();

  assert.ok(first, '必须收到一帧快照');
  assert.equal(hits > 0, true, '必须真的发过 HTTP 请求');
  assert.equal(first.status, 'live');
  assert.equal(first.requests.active, 8);
  assert.equal(first.requests.queued, 1);
  assert.equal(first.output.tokPerSec, 257.4);
  assert.equal(first.kvCache.usage, 0.16);
  assert.equal(first.kvCache.hitRate, 0.93);
  assert.equal(first.output.history.length, 1, '每轮询一次推一个曲线点');
  assert.match(first.clock, /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(Number.isFinite(first.updatedAt), true);
});
