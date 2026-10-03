/**
 * HTTP JSON 数据源：按固定间隔轮询真实端点，把返回的快照 JSON 合并进上一帧。
 * 失败不抛异常：1~2 次失败仍标记 live（沿用上一帧数据），第 3 次起 stale，第 5 次起 error，
 * 并按下一次延迟 = 间隔 × 2^失败次数（封顶 4 倍间隔）退避。
 * 请求严格串行（上一次没回来就跳过本轮），stop() 之后不再发起任何请求、也不再上报。
 */
import { emptySnapshot } from '../store.js';
import { formatClock } from '../format.js';

/** 快照里按「子对象」逐字段合并的键；其余顶层键走浅合并。 */
const HTTP_GROUPS = ['model', 'output', 'requests', 'input', 'kvCache', 'mtp', 'memory', 'gpu'];
/** 退避上限：最多放大到 4 倍间隔。 */
const HTTP_MAX_BACKOFF = 4;
/** 连续失败到第 3 次标记 stale。 */
const HTTP_STALE_AT = 3;
/** 连续失败到第 5 次标记 error。 */
const HTTP_ERROR_AT = 5;
const HTTP_DEFAULT_INTERVAL = 1000;

/** 结构化克隆（只处理普通对象/数组，深度上限防环）：保证返回值与入参、prev 都不共享引用。 */
function httpDeepClone(value, depth = 0) {
  if (Array.isArray(value)) return value.map((v) => httpDeepClone(v, depth + 1));
  if (value && typeof value === 'object' && depth < 8) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = httpDeepClone(item, depth + 1);
    return out;
  }
  return value;
}

/** 只接受有限数值：字符串、NaN、Infinity 一律当作缺失。 */
function httpPick(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 合并一个已知子对象：数值必须有限，数组整体替换（浅拷贝，避免与负载共享引用），其余照搬。 */
function httpMergeGroup(base, patch) {
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [key, value] of Object.entries(patch)) {
      if (Array.isArray(value)) out[key] = value.slice();
      else if (typeof value === 'number') { if (Number.isFinite(value)) out[key] = value; }
      else if (value !== undefined && value !== null) out[key] = value;
    }
  }
  for (const [key, value] of Object.entries(out)) if (Array.isArray(value)) out[key] = value.slice();
  return out;
}

/** 响应是否 2xx：优先看 status，其次看 ok（兼容只给 ok 的极简 fake）。 */
function httpResponseOk(res) {
  if (!res || typeof res !== 'object') return false;
  if (typeof res.status === 'number') return res.status >= 200 && res.status < 300;
  return res.ok !== false;
}

/** 失败次数 → 下一次轮询延迟：间隔 × 2^n，封顶 4 倍间隔。 */
function httpBackoff(intervalMs, failures) {
  if (!(failures > 0)) return intervalMs;
  return intervalMs * Math.min(2 ** failures, HTTP_MAX_BACKOFF);
}

/** 远端 JSON → Snapshot：已知子对象逐字段合并，缺失与非有限数值沿用 prev，状态固定 live。 */
export function mapPayload(json, prev) {
  const base = prev && typeof prev === 'object' ? prev : emptySnapshot(0);
  const out = { ...base };
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    for (const [key, value] of Object.entries(json)) {
      if (HTTP_GROUPS.includes(key)) { out[key] = httpMergeGroup(base[key], value); continue; }
      if (key === 'status') continue;                                     // 状态永远由数据源掌握
      if (key === 'updatedAt') { out.updatedAt = httpPick(value, base.updatedAt); continue; }
      if (key === 'clock') { if (typeof value === 'string' && value !== '') out.clock = value; continue; }
      out[key] = value;                                                   // 其余顶层键浅合并照搬
    }
  }
  out.status = 'live';
  return httpDeepClone(out);       // 出口克隆：调用方拿到的快照与入参负载、prev 完全隔离
}

/** MetricsSource 实现：start 立刻拉一次，之后按 intervalMs 轮询并上报 Snapshot。 */
export function createHttpSource({ endpoint, intervalMs = HTTP_DEFAULT_INTERVAL, fetchImpl = fetch, now = () => Date.now(), transform = null } = {}) {
  const period = typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : HTTP_DEFAULT_INTERVAL;
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const clock = typeof now === 'function' ? now : () => Date.now();

  let status = 'connecting';
  let running = false;
  let runId = 0;
  let timer = null;
  let inFlight = false;
  let failures = 0;
  let snapshot = null;
  let onSample = null;

  /** 仅在本次运行仍然有效时上报：stop() 之后到达的在途回包一律丢弃。 */
  function httpEmit(next, myRun) {
    if (!running || myRun !== runId) return;
    snapshot = next;
    if (!onSample) return;
    // 消费端契约是同步 sink。它自身的异常（同步抛出，或返回 rejected Promise）
    // 属于消费端问题，必须在这里就地隔离：否则会被传输层的 catch 误判成网络故障，
    // 导致每次成功都多推一帧降级帧、并错误拉长退避。
    try {
      const ret = onSample(next);
      if (ret && typeof ret.then === 'function') ret.then(undefined, () => {});
    } catch {
      /* 按契约忽略消费端异常；数据源只保证自己绝不冒未处理拒绝 */
    }
  }

  /** 一次请求：成功则映射上报，失败则按失败次数降级上报；所有异常都在这层被吃掉。 */
  async function httpAttempt(myRun) {
    if (inFlight) return;                       // 上一次还没回来：跳过本轮，杜绝请求重叠
    inFlight = true;
    let mapped = null;
    let failure = false;
    try {
      const res = await doFetch(endpoint, {
        headers: { accept: typeof transform === 'function' ? 'text/plain' : 'application/json' },
        cache: 'no-store',
      });
      if (!httpResponseOk(res)) throw new Error('HTTP ' + (res && res.status));
      // 注意：这里绝不能再声明一次 mapped —— 内层声明会遮蔽外层，成功帧会变成 null 交给渲染层。
      let payloadHasClock = false;
      if (typeof transform === 'function') {
        // vLLM 的 /metrics 是 Prometheus 文本，由调用方注入 transform 完成解析与映射
        mapped = await transform(res, snapshot, clock());
        if (!mapped || typeof mapped !== 'object' || Array.isArray(mapped)) throw new Error('transform 未返回快照对象');
        payloadHasClock = typeof mapped.clock === 'string' && mapped.clock !== '';
      } else {
        const json = await res.json();
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('响应不是 JSON 对象');
        mapped = mapPayload(json, snapshot);
        payloadHasClock = typeof json.clock === 'string' && json.clock !== '';
      }
      const stamp = clock();
      // 负载没带时钟就按本地时间补一个，保证面板时钟一直在走；updatedAt 一律用本地接收时刻
      if (!payloadHasClock) mapped.clock = formatClock(new Date(stamp));
      mapped.updatedAt = stamp;
    } catch {
      failure = true;
    } finally {
      inFlight = false;
    }

    // 所有状态改动都必须在"本次运行仍然有效"之后：stop()/重启后迟到的回包
    // 既不得改写 status，也不得污染新一轮的失败计数（否则退避会被幽灵失败拉长）。
    if (!running || myRun !== runId) return;
    if (failure) {
      failures += 1;
      status = failures >= HTTP_ERROR_AT ? 'error' : failures >= HTTP_STALE_AT ? 'stale' : 'live';
      const base = snapshot || emptySnapshot(clock());
      httpEmit({ ...base, status }, myRun);     // 降级帧也要上报，界面才能进入降级显示
      return;
    }
    failures = 0;
    status = 'live';
    // 状态永远由数据源掌握：transform 注入方返回的快照里带的 status 不作数（与 mapPayload 语义一致）
    if (mapped.status !== 'live') mapped.status = 'live';
    httpEmit(mapped, myRun);
  }

  /** 轮询循环：跑一次、按退避排下一次；异常绝不外泄成 unhandled rejection。 */
  async function httpLoop(myRun) {
    try {
      await httpAttempt(myRun);
    } catch {
      // httpAttempt 内部已兜底：这里再挡一层，保证循环不会因为消费者异常而断掉
    }
    if (!running || myRun !== runId) return;
    timer = setTimeout(() => { httpLoop(myRun).catch(() => {}); }, httpBackoff(period, failures));
  }

  return {
    get status() {
      return status;
    },
    start(onSampleFn) {
      if (running) return;
      running = true;
      runId += 1;
      onSample = typeof onSampleFn === 'function' ? onSampleFn : null;
      httpLoop(runId).catch(() => {});
    },
    stop() {
      running = false;
      runId += 1;                               // 作废在途回包
      onSample = null;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
