/**
 * 状态容器与 Snapshot 契约 —— 全项目共享的数据形状在这里定义一次。
 * 数据源产出 Snapshot，store 持有，渲染层只读。
 */

/** 空白快照：字段齐全、数值有限，供测试与首次渲染使用。 */
export function emptySnapshot(now) {
  return {
    model: { name: 'Qwen3.8-Flash', engine: 'vLLM', nodes: 'Dual DGX Spark', link: 'up' },
    output: { tokPerSec: 0, history: [] },
    requests: { active: 0, queued: 0, capacity: 12 },
    input: { tokPerSec: 0, prefillAvgMs: 0 },
    kvCache: { usage: 0, hitRate: 0, headroom: '余量充足' },
    mtp: { ratio: 0, tar: 1 },
    memory: { node: 'S1', usedGB: 0, totalGB: 128, freeGB: 128 },
    gpu: { utilization: 0, state: '空闲', history: [] },
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
