/**
 * 模拟 vLLM 遥测引擎：可播种、确定性、值域受控。
 * 首帧刻意对齐参考截图（257 tok/s / 8 活动 / 1 排队 / KV 16% / MTP 69% / 105-128G / GPU 93%），
 * 这样面板一打开就是「有数据」的样子，也方便视觉比对。
 */
import { emptySnapshot, pushRing } from '../store.js';
import { formatClock } from '../format.js';

const OUTPUT_WINDOW = 60;
const GPU_WINDOW = 15;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

/** 标准 mulberry32：同种子给出同序列，供测试与可复现演示。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 参考截图那条曲线：前段平稳、后段抖动放大，末点落在 257。 */
function seedOutputHistory() {
  const rnd = mulberry32(20261003);
  const out = [];
  let v = 196;
  for (let i = 0; i < OUTPUT_WINDOW - 1; i++) {
    const burst = i > 36;
    const amp = burst ? 70 : 11;
    v = clamp(v + (rnd() - 0.5) * 2 * amp, burst ? 120 : 150, burst ? 470 : 245);
    out.push(round1(v));
  }
  out.push(257);
  return out;
}

function seedGpuHistory() {
  const rnd = mulberry32(931);
  const out = [];
  for (let i = 0; i < GPU_WINDOW; i++) out.push(clamp(0.86 + (rnd() - 0.5) * 0.16, 0, 1));
  return out;
}

/** 首帧快照：字段与参考截图一致，历史窗口预填满。 */
export function initialSnapshot(now) {
  const s = emptySnapshot(now);
  s.status = 'live';
  s.output.history = seedOutputHistory();
  s.output.tokPerSec = 257;
  s.requests = { active: 8, queued: 1, capacity: 10 }; // 参考截图进度条 ≈ 80% 绿 + 10% 橙
  s.input = { tokPerSec: 1700, prefillAvgMs: 320 };
  s.kvCache = { usage: 0.16, hitRate: 0.93, headroom: '余量充足' };
  s.mtp = { ratio: 0.69, tar: 1.99 };
  s.memory = { node: 'S1', usedGB: 105, totalGB: 128, freeGB: 23 };
  s.gpu = { utilization: 0.93, state: '计算中', history: seedGpuHistory() };
  s.clock = formatClock(new Date(now));
  s.updatedAt = now;
  return s;
}

/** 推进一步：随机游走 + 均值回归，所有量都夹在物理值域内。 */
export function stepSnapshot(prev, rnd, now) {
  const capacity = prev.requests.capacity;
  const active = Math.round(clamp(prev.requests.active + (rnd() - 0.5) * 3.4, 0, capacity));
  const queued = Math.round(clamp(prev.requests.queued + (rnd() - 0.5) * 2.2, 0, 6));

  const target = active > 0 ? 170 + active * 22 : 0;
  const tokPerSec = clamp(prev.output.tokPerSec + (target - prev.output.tokPerSec) * 0.25 + (rnd() - 0.5) * 80, 0, 1200);

  const inputTarget = active * 190 + queued * 60;
  const inputRate = clamp(prev.input.tokPerSec + (inputTarget - prev.input.tokPerSec) * 0.3 + (rnd() - 0.5) * 260, 0, 20000);

  let usage = prev.kvCache.usage + 0.003 + (rnd() - 0.5) * 0.002;
  if (usage > 0.95) usage = 0.12;                    // 写满即淘汰，形成锯齿
  usage = clamp(usage, 0, 1);
  const hitRate = clamp(prev.kvCache.hitRate + (rnd() - 0.5) * 0.02, 0.85, 0.97);

  const ratio = clamp(prev.mtp.ratio + (rnd() - 0.5) * 0.05, 0.5, 0.85);
  const tar = clamp(1 + ratio * 1.43, 1.3, 2.6);

  const usedGB = clamp(prev.memory.usedGB + (rnd() - 0.5) * 0.6 + (usage - 0.5) * 0.4, 0, prev.memory.totalGB);

  const utilization = clamp(0.05 + (active / capacity) * 0.9 + (rnd() - 0.5) * 0.1, 0, 1);

  return {
    ...prev,
    output: { tokPerSec, history: pushRing(prev.output.history, round1(tokPerSec), OUTPUT_WINDOW) },
    requests: { active, queued, capacity },
    input: { tokPerSec: Math.round(inputRate), prefillAvgMs: Math.round(clamp(180 + (queued * 90) + (rnd() - 0.5) * 60, 60, 2000)) },
    kvCache: { usage, hitRate, headroom: usage > 0.8 ? '余量紧张' : usage > 0.5 ? '余量一般' : '余量充足' },
    mtp: { ratio, tar },
    memory: { ...prev.memory, usedGB, freeGB: prev.memory.totalGB - usedGB },
    gpu: {
      utilization,
      state: utilization > 0.2 ? '计算中' : '空闲',
      history: pushRing(prev.gpu.history, utilization, GPU_WINDOW),
    },
    clock: formatClock(new Date(now)),
    status: 'live',
    updatedAt: now,
  };
}

/** MetricsSource 实现：每秒推进一步。 */
export function createMockSource({ seed = 1, intervalMs = 1000, now = () => Date.now() } = {}) {
  const rnd = mulberry32(seed);
  let timer = null;
  let snapshot = null;
  let running = false;
  let status = 'connecting';
  return {
    get status() {
      return status;
    },
    start(onSample) {
      running = true;
      snapshot = initialSnapshot(now());
      status = 'live';
      onSample(snapshot);
      timer = setInterval(() => {
        snapshot = stepSnapshot(snapshot, rnd, now());
        onSample(snapshot);
      }, intervalMs);
    },
    /** 立即推进一步（页脚"刷新"按钮用）。 */
    pollOnce() {
      if (!running || !snapshot) return;
      snapshot = stepSnapshot(snapshot, rnd, now());
      onSample(snapshot);
    },
    stop() {
      running = false;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}