/**
 * 状态容器与 Snapshot 契约 —— 全项目共享的数据形状在这里定义一次。
 * 数据源产出 Snapshot，store 持有，渲染层只读。
 */

/**
 * 空白快照：字段齐全，但**所有未知的量一律是 NaN**（界面显示 --）。
 * 这里绝不能填 0/128G/"空闲" 这类看着合理的假值：真实数据源缺指标时，
 * 假 0 会渲染成"GPU 空闲、显存全空"，让使用者据此做出错误判断，比不显示更危险。
 */
export function emptySnapshot(now) {
  return {
    model: { name: 'Qwen3.8-Flash', engine: 'vLLM', nodes: 'Dual DGX Spark', link: 'up' },
    output: { tokPerSec: NaN, history: [] },
    requests: { active: 0, queued: 0, capacity: 10 },
    input: { tokPerSec: NaN, prefillAvgMs: NaN },
    kvCache: { usage: NaN, hitRate: NaN, headroom: '--' },
    mtp: { ratio: NaN, tar: NaN },
    memory: { node: '--', usedGB: NaN, totalGB: NaN, freeGB: NaN },
    gpu: { utilization: NaN, state: '--', history: [] },
    clock: '00:00:00',
    status: 'connecting',
    updatedAt: Number.isFinite(now) ? now : 0,
  };
}

/** 环形缓冲：追加一个值并保持窗口长度，超出时丢弃最旧值。 */
export function pushRing(arr, v, max) {
  const next = Array.isArray(arr) ? arr.concat([v]) : [v];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** 极简状态容器：浅合并 + 订阅通知。 */
export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get() {
      return state;
    },
    update(patch) {
      const delta = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...(delta || {}) };
      for (const fn of [...subs]) fn(state);
      return state;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
