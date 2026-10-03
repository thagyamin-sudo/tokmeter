import { applyUnit } from './units.js';
import { createStore, emptySnapshot } from './store.js';
import { initialSnapshot, createMockSource } from './sources/mock.js';
import { renderShell, paint, collectProbe } from './render.js';

const params = new URLSearchParams(location.search);
const testMode = params.get('test') === '1';
const seed = Number(params.get('seed') || 7);
const freeze = params.get('freeze');

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
let paintCount = 0;

function doPaint(s) {
  paint(panel, s);
  paintCount += 1;
  if (testMode) {
    const probe = document.getElementById('probe');
    if (probe) probe.textContent = 'PROBE_JSON:' + JSON.stringify(collectProbe(panel, s, paintCount));
  }
}

// 测试模式要同步出结果（探针靠 --dump-dom 抓取，不能依赖 rAF 时序）
store.subscribe((s) => (testMode ? doPaint(s) : requestAnimationFrame(() => doPaint(s))));

if (testMode) {
  store.update(initialSnapshot(frozenNow()));
} else {
  const source = createMockSource({ seed, intervalMs: 1000, now: () => Date.now() });
  source.start((s) => store.update(s));
}
