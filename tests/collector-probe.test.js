/**
 * 采集器 · 流式测量（纯函数，不联网）：
 * 从 OpenAI 兼容的 SSE 流里量出 TTFT、输出 token 数、生成速率。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureOpenAiStream } from '../collector/openai-probe.js';

/**
 * 可控时钟：时间随"数据到达"推进，而不是随 now() 被调用次数推进。
 * 这样测出来的 TTFT / 总时长才和真实流式语义一致。
 */
function streamClock(lines, stepMs) {
  let t = 1000;
  async function* stream() {
    for (const line of lines) {
      t += stepMs;               // 数据到达即推进时间；最后一行到达时请求就结束了
      yield line;
    }
  }
  return { clock: () => t, stream: stream() };
}

const chunk = (content) => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] });

test('测量：TTFT 取首个内容 chunk 的时间，速率按"首 token→结束"计算', async () => {
  const { clock, stream } = streamClock([chunk('你'), chunk('好'), chunk('呀'), 'data: [DONE]'], 100);
  const r = await measureOpenAiStream(stream, clock);

  assert.equal(r.ok, true);
  assert.equal(r.ttftMs, 100, '第一行内容到达即 TTFT=100ms');
  assert.equal(r.completionTokens, 3, '3 个内容 chunk ≈ 3 个 token');
  assert.equal(r.totalMs, 400, '4 行数据各耗 100ms');
  assert.equal(Math.round(r.tokPerSec), 10, '生成阶段 300ms 产出 3 token → 10 tok/s');
});

test('测量：推理模型的 reasoning_content 也要计入（否则速率量成 0）', async () => {
  const { clock, stream } = streamClock(
    ['data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: null } }] }),
     'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '想' } }] }),
     'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '一下' } }] }),
     'data: ' + JSON.stringify({ choices: [{ delta: { content: '答案' } }] }),
     'data: [DONE]'],
    100
  );
  const r = await measureOpenAiStream(stream, clock);
  assert.equal(r.completionTokens, 3, 'reasoning 与 content 都要计数');
  assert.equal(r.ttftMs, 200, '首个 reasoning chunk 就是首 token');
});

test('测量：优先采用 usage 里的真实 token 数', async () => {
  const { clock, stream } = streamClock(
    [chunk('a'), 'data: ' + JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 120, completion_tokens: 40 } }), 'data: [DONE]'],
    50
  );
  const r = await measureOpenAiStream(stream, clock);
  assert.equal(r.promptTokens, 120);
  assert.equal(r.completionTokens, 40, 'usage 出现后以它为准');
});

test('测量：缺少 usage 时按 chunk 计数，注释行与坏 JSON 不影响', async () => {
  const { clock, stream } = streamClock([': keep-alive', 'data: {坏 json', chunk('x'), chunk('y'), ''], 20);
  const r = await measureOpenAiStream(stream, clock);
  assert.equal(r.completionTokens, 2);
  assert.equal(r.ok, true);
});

test('测量：TTFT 从发起请求算起（含连接与排队），而不是从收到响应头算起', async () => {
  const { clock, stream } = streamClock([chunk('x'), 'data: [DONE]'], 100);
  const requestStartedAt = 900;                // 时钟从 1000 起走，首个 chunk 在 1100 到达
  const r = await measureOpenAiStream(stream, clock, requestStartedAt);
  assert.equal(r.ttftMs, 200, 'TTFT = 首个 chunk 时刻(1100) - 请求发起时刻(900)');
});

test('测量：一个内容都没有（空流/纯错误流）时 tokPerSec 记为 0，不产生 Infinity', async () => {
  const { clock, stream } = streamClock(['data: [DONE]'], 10);
  const r = await measureOpenAiStream(stream, clock);
  assert.equal(r.ttftMs, null);
  assert.equal(r.completionTokens, 0);
  assert.equal(r.tokPerSec, 0);
  assert.equal(Number.isFinite(r.tokPerSec), true);
});
