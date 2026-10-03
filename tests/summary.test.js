/** 状态摘要（页脚"复制"按钮的内容）：纯函数，可单测。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSummary } from '../src/format.js';
import { emptySnapshot } from '../src/store.js';

test('服务端视图摘要：含模型、状态、速率、请求与 KV/GPU', () => {
  const s = emptySnapshot(0);
  s.clock = '12:00:00';
  s.status = 'live';
  s.output = { tokPerSec: 257, history: [] };
  s.input = { tokPerSec: 1700, prefillAvgMs: 320 };
  s.requests = { active: 8, queued: 1, capacity: 10 };
  s.kvCache = { usage: 0.16, hitRate: 0.93, headroom: '余量充足' };
  s.gpu = { utilization: 0.93, state: '计算中', history: [] };

  const text = formatSummary(s, 'server');
  assert.match(text, /^Tokmeter · 12:00:00/);
  assert.match(text, /状态 live/);
  assert.match(text, /输出 257 tok\/s/);
  assert.match(text, /8 活动 \/ 1 排队/);
  assert.match(text, /KV 16%，GPU 93%/);
});

test('客户端视图摘要：含 TTFT、探测次数、用量与成本，且未知量显示 --', () => {
  const s = emptySnapshot(0);
  s.clock = '12:00:00';
  s.output = { tokPerSec: 62, history: [] };
  s.client = {
    ttftP50: 322, ttftP95: NaN, probeCount: 42, failCount: 2,
    tokensIn: 1_000_000, tokensOut: 500_000, cost: 6, successRate: 0.95,
  };
  const text = formatSummary(s, 'client');
  assert.match(text, /TTFT P50 322ms \/ P95 --/);
  assert.match(text, /探测 42 次，失败 2/);
  assert.match(text, /输入 1\.0M \/ 输出 500\.0K tok/);
  assert.match(text, /成本 6\.00/);
  assert.equal(text.includes('NaN'), false, '未知量绝不能渲染成 NaN');
});
