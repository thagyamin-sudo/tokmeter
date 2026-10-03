/**
 * vLLM /metrics 解析与映射 —— 全部是纯函数：Prometheus 文本 → 指标字典 → Snapshot。
 * 只覆盖 5 个核心指标（运行/排队请求、生成吞吐、KV 占用、前缀缓存命中率），
 * 其余字段（model/input/mtp/memory/gpu）一律保留上一帧；任何畸形输入都不抛异常。
 * 注意 vLLM 的 gpu_cache_usage_perc 与 gpu_prefix_cache_hit_rate 已经是 0~1，无需再除以 100。
 */
import { emptySnapshot, pushRing } from '../store.js';
import { formatClock } from '../format.js';

/** 生成吞吐曲线的窗口长度（与 mock 源保持一致，便于两种数据源无缝切换）。 */
const VLLM_OUTPUT_WINDOW = 60;

/** Prometheus 样本行：指标名 +（可选）{标签} + 至少一个空白 + 值（时间戳等尾列忽略）。 */
const VLLM_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+(.+)$/;

/** 只接受有限数值：字符串、NaN、Infinity 一律当作缺失。 */
function vllmPick(source, key, fallback) {
  const v = source[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 严格数字解析：空串、非数字、Infinity 都返回 null（Number('') 是 0，必须挡掉）。 */
function vllmToNumber(token) {
  const n = Number(token);
  return Number.isFinite(n) ? n : null;
}

/** prev 缺字段时的兜底：用空白快照补齐，保证映射永远拿到完整的 Snapshot 形状。 */
function vllmBase(prev, now) {
  const fallback = emptySnapshot(now);
  if (!prev || typeof prev !== 'object') return fallback;
  const out = { ...fallback, ...prev };
  for (const key of ['model', 'output', 'requests', 'input', 'kvCache', 'mtp', 'memory', 'gpu']) {
    const group = prev[key];
    out[key] = group && typeof group === 'object' && !Array.isArray(group)
      ? { ...fallback[key], ...group }
      : fallback[key];
  }
  return out;
}

/**
 * 解析 Prometheus 文本为 { 指标名: 数值 }。
 * 跳过 # HELP / # TYPE 等注释行；畸形行（半行、非数字、缺名字）静默丢弃；空串返回 {}。
 */
export function parsePrometheus(text) {
  const out = {};
  if (typeof text !== 'string' || text === '') return out;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = VLLM_LINE.exec(line);
    if (!m) continue;
    const token = m[2].trim().split(/\s+/)[0];
    const num = vllmToNumber(token);
    if (num === null) continue;
    out[m[1]] = num;
  }
  return out;
}

/** 指标字典 → Snapshot：核心指标覆盖，缺失或非有限值逐字段回退 prev，状态固定 live。 */
export function toSnapshot(metrics, prev, now) {
  const ts = Number.isFinite(now) ? now : 0;
  // 契约是"任何输入都不抛异常"：prev 本身畸形（例如带抛异常的 getter）时退回空快照。
  let base;
  try {
    base = vllmBase(prev, ts);
  } catch {
    base = emptySnapshot(ts);
  }
  try {
    const m = metrics && typeof metrics === 'object' && !Array.isArray(metrics) ? metrics : {};

    const active = Math.round(vllmPick(m, 'vllm:num_requests_running', base.requests.active));
    const queued = Math.round(vllmPick(m, 'vllm:num_requests_waiting', base.requests.queued));
    const tokPerSec = vllmPick(m, 'vllm:avg_generation_throughput_toks_per_s', base.output.tokPerSec);
    const usage = vllmPick(m, 'vllm:gpu_cache_usage_perc', base.kvCache.usage);
    const hitRate = vllmPick(m, 'vllm:gpu_prefix_cache_hit_rate', base.kvCache.hitRate);

    return {
      ...base,
      output: { tokPerSec, history: pushRing(base.output.history, tokPerSec, VLLM_OUTPUT_WINDOW) },
      requests: { ...base.requests, active, queued },
      kvCache: { ...base.kvCache, usage, hitRate },
      clock: formatClock(new Date(ts)),
      status: 'live',
      updatedAt: ts,
    };
  } catch {
    // 畸形 metrics（含抛异常的 getter）：退回上一帧，绝不把异常抛给调用方
    return { ...base, clock: formatClock(new Date(ts)), status: 'live', updatedAt: ts };
  }
}
