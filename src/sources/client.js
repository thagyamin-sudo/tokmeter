/**
 * 客户端视图数据源：轮询本机采集器的 /snapshot。
 *
 * 与 vLLM/JSON 源的区别：云 API 不可能给出 KV Cache、MTP、显存、GPU 这些服务端内部量，
 * 所以这里**只用真实可测的客户端指标**（TTFT、实测 tok/s、成功率、token 用量、成本），
 * 其余字段保持"未知"（NaN → 界面显示 --），绝不编造。
 */
import { emptySnapshot, pushRing } from '../store.js';
import { formatClock } from '../format.js';

const CLIENT_WINDOW = 60;
const CLIENT_BARS_WINDOW = 15;   // 注意：顶层名不能与其它模块重名（单文件构建会拼接）

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : NaN);

/** 延迟得分：2 秒为 0 分基准，越快环越满（只用于画环，不改变原始数值的展示）。 */
export function latencyScore(p50ms) {
  if (!Number.isFinite(p50ms) || p50ms <= 0) return NaN;
  return clamp01(1 - p50ms / 2000);
}

/** 吞吐得分：100 tok/s 记满分（只用于画环）。
 *  基准取云 API 的现实量级：定成 500 时，实测 24 tok/s 的环只有 5%，看着像坏了。 */
export function rateScore(p50rate) {
  if (!Number.isFinite(p50rate) || p50rate <= 0) return NaN;
  return clamp01(p50rate / 100);
}

/** 把采集器的 /snapshot 映射成面板快照；缺字段保持未知。 */
export function mapClientPayload(payload, prev) {
  const base = prev && typeof prev === 'object' ? prev : emptySnapshot(0);
  const p = payload && typeof payload === 'object' ? payload : {};
  const c = p.client && typeof p.client === 'object' ? p.client : {};
  const rate = Number.isFinite(p.output && p.output.tokPerSec) ? p.output.tokPerSec : NaN;
  const history = Array.isArray(p.output && p.output.history)
    ? p.output.history.filter((v) => Number.isFinite(v)).slice(-CLIENT_WINDOW)
    : Array.isArray(base.output.history)
      ? base.output.history.slice()
      : [];

  const successRate = clamp01(c.successRate);
  const rateP95 = Number.isFinite(c.rateP95) ? c.rateP95 : NaN;

  return {
    ...base,
    model: {
      name: (p.model && p.model.name) || base.model.name,
      engine: (p.model && p.model.engine) || 'OpenAI 兼容',
      nodes: (p.model && p.model.nodes) || 'API',
      link: base.model.link,
    },
    output: { tokPerSec: rate, history },
    input: {
      tokPerSec: Number.isFinite(p.input && p.input.tokPerSec) ? p.input.tokPerSec : NaN,
      prefillAvgMs: Number.isFinite(p.input && p.input.prefillAvgMs) ? p.input.prefillAvgMs : NaN,
    },
    requests: {
      active: Number.isFinite(p.requests && p.requests.active) ? p.requests.active : 0,
      queued: Number.isFinite(p.requests && p.requests.queued) ? p.requests.queued : 0,
      capacity: Number.isFinite(p.requests && p.requests.capacity) ? p.requests.capacity : 1,
    },
    // 客户端视图专用指标，语义明确，不与服务端字段混用
    client: {
      ttftP50: Number.isFinite(c.ttftP50) ? c.ttftP50 : NaN,
      ttftP95: Number.isFinite(c.ttftP95) ? c.ttftP95 : NaN,
      rateP50: Number.isFinite(c.rateP50) ? c.rateP50 : NaN,
      rateP95,
      probeCount: Number.isFinite(c.probeCount) ? c.probeCount : 0,
      failCount: Number.isFinite(c.failCount) ? c.failCount : 0,
      successRate,
      available: c.available === true,
      tokensIn: Number.isFinite(c.tokensIn) ? c.tokensIn : 0,
      tokensOut: Number.isFinite(c.tokensOut) ? c.tokensOut : 0,
      cost: Number.isFinite(c.cost) ? c.cost : 0,
      lastError: typeof c.lastError === 'string' ? c.lastError : null,
      latencyScore: latencyScore(c.ttftP50),
      rateScore: rateScore(c.rateP50),
      // 采集器自带历史就尊重它（确定性样本/长连接重放），否则每次轮询追加一个点
      history: Array.isArray(c.history)
        ? c.history.filter((v) => Number.isFinite(v)).slice(-CLIENT_BARS_WINDOW)
        : pushRing(
            Array.isArray(base.client && base.client.history) ? base.client.history : [],
            Number.isFinite(rate) ? rate : 0,
            CLIENT_BARS_WINDOW
          ).filter((v) => Number.isFinite(v)),
    },
    clock: typeof p.clock === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(p.clock) ? p.clock : formatClock(new Date()),
    status: p.status === 'error' || p.status === 'stale' ? p.status : 'live',
    updatedAt: Number.isFinite(p.updatedAt) ? p.updatedAt : 0,
  };
}

/** MetricsSource：轮询采集器，失败同样按 live→stale→error 降级。 */
export function createClientSource({ endpoint, intervalMs = 1000, fetchImpl = fetch, now = () => Date.now() } = {}) {
  let status = 'connecting';
  let running = false;
  let runId = 0;
  let timer = null;
  let inFlight = false;
  let failures = 0;
  let snapshot = null;
  let onSample = null;

  function emit(next, myRun) {
    if (!running || myRun !== runId) return;
    snapshot = next;
    if (!onSample) return;
    try {
      const ret = onSample(next);
      if (ret && typeof ret.then === 'function') ret.then(undefined, () => {});
    } catch {
      /* 消费端异常就地隔离 */
    }
  }

  async function attempt(myRun) {
    if (inFlight) return;
    inFlight = true;
    let mapped = null;
    let failed = false;
    try {
      const res = await fetchImpl(endpoint, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!res || res.ok === false || (typeof res.status === 'number' && (res.status < 200 || res.status >= 300))) {
        throw new Error('HTTP ' + (res && res.status));
      }
      const json = await res.json();
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('采集器返回不是 JSON 对象');
      mapped = mapClientPayload(json, snapshot);
    } catch {
      failed = true;
    } finally {
      inFlight = false;
    }
    if (!running || myRun !== runId) return;
    if (failed) {
      failures += 1;
      status = failures >= 5 ? 'error' : failures >= 3 ? 'stale' : 'live';
      const base = snapshot || emptySnapshot(now());
      emit({ ...base, status }, myRun);
      return;
    }
    failures = 0;
    status = 'live';
    emit(mapped, myRun);
  }

  async function loop(myRun) {
    try {
      await attempt(myRun);
    } catch {
      /* 兜底：循环不因异常中断 */
    }
    if (!running || myRun !== runId) return;
    timer = setTimeout(() => loop(myRun).catch(() => {}), intervalMs);
  }

  return {
    get status() {
      return status;
    },
    start(fn) {
      if (running) return;
      running = true;
      runId += 1;
      onSample = typeof fn === 'function' ? fn : null;
      loop(runId).catch(() => {});
    },
    stop() {
      running = false;
      runId += 1;
      onSample = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}