/**
 * 采集器 · 流式测量：把 OpenAI 兼容的 SSE 流变成可用的数字。
 *
 * 只做"量"这件事，不联网：调用方把响应体按行喂进来，这里返回
 * TTFT（首 token 延迟）、输出 token 数、生成速率、输入 token 数。
 * 纯逻辑 → 可以用假时钟和假流做确定性测试。
 */

/** 解析一行 SSE；不是 data 行、坏 JSON、[DONE] 都返回 null。 */
function parseSseLine(line) {
  const s = String(line).trim();
  if (!s.startsWith('data:')) return null;
  const payload = s.slice(5).trim();
  if (payload === '' || payload === '[DONE]') return null;
  try {
    const json = JSON.parse(payload);
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

/**
 * @param chunks 可迭代/可异步迭代的 SSE 行
 * @param now 取当前时间（毫秒），便于测试注入
 */
export async function measureOpenAiStream(chunks, now = () => Date.now(), startedAt) {
  // TTFT 必须从**发起请求**算起：响应头常与首个 chunk 一起 flush，
  // 若从"收到响应头"开始计时，本地回环下会量出 0ms（真机上是错误的乐观值）。
  const started = Number.isFinite(startedAt) ? startedAt : now();
  let ttftMs = null;
  let contentChunks = 0;
  let completionTokens = null;
  let promptTokens = null;

  for await (const line of chunks) {
    const json = parseSseLine(line);
    if (!json) continue;

    const usage = json.usage;
    if (usage && typeof usage === 'object') {
      if (Number.isFinite(usage.completion_tokens)) completionTokens = usage.completion_tokens;
      if (Number.isFinite(usage.prompt_tokens)) promptTokens = usage.prompt_tokens;
    }

    const delta = json.choices && json.choices[0] && json.choices[0].delta;
    const text = delta ? delta.content : undefined;
    if (typeof text === 'string' && text.length > 0) {
      if (ttftMs === null) ttftMs = now() - started;
      contentChunks += 1;
    }
  }

  const totalMs = now() - started;
  const outTokens = completionTokens !== null ? completionTokens : contentChunks;
  const genMs = ttftMs === null ? 0 : Math.max(1, totalMs - ttftMs);
  const tokPerSec = ttftMs === null || genMs <= 0 ? 0 : (outTokens / genMs) * 1000;

  return {
    ok: true,
    ttftMs,
    totalMs,
    promptTokens,
    completionTokens: outTokens,
    tokPerSec: Number.isFinite(tokPerSec) ? tokPerSec : 0,
  };
}
