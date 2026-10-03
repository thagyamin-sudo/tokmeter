/**
 * 装配层：解析 URL 参数 → 选数据源 → 采样 → rAF 合并渲染。
 * 确定性测试模式（?test=1）不依赖定时器：同步喂帧，或按 ?tick=N 步进 N 帧。
 */
import { applyUnit } from './units.js';
import { createStore, emptySnapshot } from './store.js';
import { initialSnapshot, stepSnapshot, createMockSource, mulberry32 } from './sources/mock.js';
import { renderShell, paint, collectProbe } from './render.js';
import { createScheduler } from './scheduler.js';
import { createHttpSource } from './sources/http.js';
import { parsePrometheus, toSnapshot } from './sources/vllm-metrics.js';

const params = new URLSearchParams(location.search);
const testMode = params.get('test') === '1';
const seed = Number(params.get('seed') || 7);
const freeze = params.get('freeze');
const tickN = Math.max(0, Number(params.get('tick') || 0));
// 测试模式默认同步出结果（探针靠 --dump-dom 抓取，不能依赖 rAF 时序）；
// ?raf=1 时才走真实渲染路径，用于验证"同帧多次更新只画一次"。
const useRaf = !testMode || params.get('raf') === '1';

const panel = document.getElementById('panel');

/** 面板宽度决定 1u 的像素值，窗口尺寸变化时重算。 */
function layout() {
  applyUnit(panel, panel.clientWidth);
}

layout();
addEventListener('resize', layout);
addEventListener('orientationchange', layout);

renderShell(panel);

/** 冻结时钟：把今天的时分秒固定下来，让探针输出可复现。 */
function frozenNow() {
  if (!freeze) return Date.now();
  const [h, m, sec] = freeze.split(':').map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, sec || 0, 0);
  return d.getTime();
}

const store = createStore(emptySnapshot(Date.now()));
const stats = { updates: 0, paints: 0, samples: 0, firstRate: null };
function writeProbe(s) {
  const probe = document.getElementById('probe');
  if (probe) probe.textContent = 'PROBE_JSON:' + JSON.stringify(collectProbe(panel, s, stats));
}

function renderFrame(s) {
  paint(panel, s);
  stats.paints += 1;
  if (testMode) writeProbe(s);
}

// 生产走 requestAnimationFrame 合并；测试模式用同步调度，保证 --dump-dom 能拿到确定结果。
const scheduler = createScheduler(renderFrame, useRaf ? (cb) => requestAnimationFrame(cb) : (cb) => cb());

function onUpdate(s) {
  stats.updates += 1;
  scheduler.push(s);
}

store.subscribe(onUpdate);

if (testMode) {
  const rnd = mulberry32(seed);
  let s = initialSnapshot(frozenNow());
  stats.samples = 1;
  stats.firstRate = s.output.tokPerSec;
  store.update(s);
  for (let i = 1; i < tickN; i++) {
    s = stepSnapshot(s, rnd, frozenNow() + i * 1000);
    stats.samples = i + 1;
    store.update(s);
  }
  if (params.get('fail') === '1') {
    // 数据源不可达时的降级帧：状态变 error，其余字段沿用最后一帧（曲线保留、布局不变）
    store.update({ ...s, status: 'error' });
  }
} else {
  pickSource().start((s) => store.update(s));
}

/** 数据源选择：?source=http|vllm&endpoint=<url>，缺省用模拟引擎。 */
function pickSource() {
  const kind = params.get('source') || 'mock';
  const endpoint = params.get('endpoint') || '';
  if (kind === 'http' && endpoint) {
    return createHttpSource({ endpoint, intervalMs: 1000, now: () => Date.now() });
  }
  if (kind === 'vllm' && endpoint) {
    return createHttpSource({
      endpoint,
      intervalMs: 1000,
      now: () => Date.now(),
      transform: async (res, prev, now) => toSnapshot(parsePrometheus(await res.text()), prev, now),
    });
  }
  return createMockSource({ seed, intervalMs: 1000, now: () => Date.now() });
}
