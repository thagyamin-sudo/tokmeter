/**
 * 装配层：解析 URL 参数 → 选数据源 → 采样 → rAF 合并渲染。
 * 确定性测试模式（?test=1）不依赖定时器：同步喂帧，或按 ?tick=N 步进 N 帧。
 */
import { applyUnit } from './units.js';
import { createStore, emptySnapshot } from './store.js';
import { initialSnapshot, stepSnapshot, createMockSource, mulberry32 } from './sources/mock.js';
import { renderShell, paint, collectProbe, renderIsland } from './render.js';
import { createScheduler } from './scheduler.js';
import { createHttpSource } from './sources/http.js';
import { parsePrometheus, toSnapshot, extractModelName } from './sources/vllm-metrics.js';
import { createClientSource, mapClientPayload } from './sources/client.js';
import { formatClock } from './format.js';

const params = new URLSearchParams(location.search);
const testMode = params.get('test') === '1';
const seed = Number(params.get('seed') || 7);
const freeze = params.get('freeze');
const tickN = Math.max(0, Number(params.get('tick') || 0));
// 测试模式默认同步出结果（探针靠 --dump-dom 抓取，不能依赖 rAF 时序）；
// ?raf=1 时才走真实渲染路径，用于验证"同帧多次更新只画一次"。
const useRaf = !testMode || params.get('raf') === '1';
// 视图：server（默认，逐像素对齐参考截图）/ client（云 API 客户端观测）
const view = params.get('view') === 'client' ? 'client' : 'server';

const panel = document.getElementById('panel');

/** 面板宽度决定 1u 的像素值，窗口尺寸变化时重算。 */
function layout() {
  applyUnit(panel, panel.clientWidth);
}

layout();
addEventListener('resize', layout);
addEventListener('orientationchange', layout);

panel.dataset.view = view;
renderShell(panel, view);
if (params.get('island') === '1') renderIsland();   // 可选：灵动岛胶囊，默认关闭

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

/** 客户端视图的确定性样本：数值固定，便于探针断言。 */
function clientFixture(now, seedValue) {
  const rnd = mulberry32(seedValue);
  const history = [];
  let v = 180;
  for (let i = 0; i < 60; i++) {
    v = Math.max(40, v + (rnd() - 0.5) * 60);
    history.push(Math.round(v));
  }
  history[59] = 210;
  return {
    view: 'client',
    status: 'live',
    clock: formatClock(new Date(now)),
    updatedAt: now,
    model: { name: 'deepseek-chat', engine: 'OpenAI 兼容', nodes: 'API' },
    output: { tokPerSec: 210, history },
    input: { tokPerSec: 3400, prefillAvgMs: 320 },
    requests: { active: 1, queued: 0, capacity: 1 },
    client: {
      ttftP50: 320, ttftP95: 900, rateP50: 210, rateP95: 290, probeCount: 42, failCount: 2,
      successRate: 0.95, available: false, tokensIn: 1000000, tokensOut: 500000, cost: 6, lastError: null,
      history: history.slice(-15),
    },
  };
}

if (testMode && view === 'client') {
  store.update(mapClientPayload(clientFixture(frozenNow(), seed), emptySnapshot(Date.now())));
} else if (testMode) {
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
  // 长文本回归：模型名过长时标题区必须省略而不是换行撑破
  const nameOverride = params.get('name');
  if (nameOverride) {
    s = { ...s, model: { ...s.model, name: nameOverride } };
    store.update(s);
  }
  // 量级回归：把速率注入成极端值（如 2340000），验证数字变宽不会挤坏 Hero 卡
  const inject = params.get('inject') || '';
  const injectRate = inject.startsWith('rate:') ? Number(inject.slice(5)) : NaN;
  if (Number.isFinite(injectRate)) {
    s = { ...s, output: { ...s.output, tokPerSec: injectRate } };
    store.update(s);
  }
  const fail = params.get('fail');
  if (fail === 'stale' || fail === 'both') {
    store.update({ ...s, status: 'stale' });
    stats.staleLink = (document.getElementById('link-text') || {}).textContent || null;
    stats.staleDim = panel.classList.contains('is-degraded');
  }
  if (fail === '1' || fail === 'error' || fail === 'both') {
    // 数据源不可达时的降级帧：状态变 error，其余字段沿用最后一帧（曲线保留、布局不变）
    store.update({ ...s, status: 'error' });
  }
} else if (view === 'client') {
  // 客户端视图连本机采集器；key 只存在采集器的配置文件里，页面里没有
  const endpoint = params.get('endpoint') || 'http://127.0.0.1:8787/snapshot';
  createClientSource({ endpoint, intervalMs: 1000, now: () => Date.now() }).start((s) => store.update(s));
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
      transform: async (res, prev, now) => {
        const text = await res.text();
        const snap = toSnapshot(parsePrometheus(text), prev, now);
        const name = extractModelName(text);
        // 标题区只写真实信息：取不到模型名就显示占位，不沿用内置演示实例的名字
        snap.model = { ...snap.model, name: name || '未知模型', nodes: '—' };
        return snap;
      },
    });
  }
  return createMockSource({ seed, intervalMs: 1000, now: () => Date.now() });
}