/**
 * 装配层：解析 URL 参数 → 选数据源 → 采样 → rAF 合并渲染。
 * 确定性测试模式（?test=1）不依赖定时器：同步喂帧，或按 ?tick=N 步进 N 帧。
 */
import { applyUnit } from './units.js';
import { createStore, emptySnapshot } from './store.js';
import { initialSnapshot, stepSnapshot, createMockSource, mulberry32 } from './sources/mock.js';
import { renderShell, paint, collectProbe, renderIsland } from './render.js';
import { createSettings, configBaseFromEndpoint } from './settings.js';
import { createScheduler } from './scheduler.js';
import { createHttpSource } from './sources/http.js';
import { parsePrometheus, toSnapshot, extractModelName } from './sources/vllm-metrics.js';
import { createClientSource, mapClientPayload } from './sources/client.js';
import { formatClock, formatSummary } from './format.js';

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

/** 页脚四个按钮的真实行为：刷新 / 复制 / 暂停 / 设置。 */
let activeSource = null;
let paused = false;
let settings = null;
/** 采集器根地址：设置浮层与页脚 ⏻（POST /probe）都连它，只推导一次，保证两处一致。 */
const collectorBase = params.get('config') || configBaseFromEndpoint(params.get('endpoint'));
/** 页脚电源按钮的两种标签：这一个按钮现在管的是"探测"，不是"面板刷新"。 */
const POWER_PAUSE_LABEL = '暂停探测';
const POWER_RESUME_LABEL = '恢复探测';

function flash(btn) {
  if (!btn) return;
  btn.classList.add('is-flash');
  setTimeout(() => btn.classList.remove('is-flash'), 900);
}

async function copySummary(btn) {
  const text = formatSummary(store.get(), view);
  stats.copied = text;
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
  } catch {
    // file:// 或权限不足时的兜底：老式 execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* 忽略：仍然给出视觉反馈 */ }
    ta.remove();
  }
  flash(btn);
}

/**
 * 页脚 ⏻：暂停/恢复**两件事** —— 面板自己的刷新，以及采集器的主动探测。
 *
 * 只用面板停刷新是用户抱怨的那个 bug：藏在托盘里的采集器照样每 15 秒打一次上游、
 * 走用户的真实计费。所以这里同时 POST /probe；采集器连不上时退回"只停面板刷新"，
 * 在浮层与控制台各说明一句，绝不假装已经停了。
 */
function togglePause(btn) {
  paused = !paused;
  if (paused) {
    if (activeSource && typeof activeSource.stop === 'function') activeSource.stop();
  } else {
    startSource();
  }
  if (btn) {
    btn.classList.toggle('is-off', paused);
    btn.title = paused ? POWER_RESUME_LABEL : POWER_PAUSE_LABEL;
    btn.setAttribute('aria-label', btn.title);
  }
  stats.paused = paused;
  void syncCollectorProbe(paused);
}

/** POST /probe {enabled}：把暂停/恢复同步到采集器。失败只影响探测同步，不影响面板。 */
async function syncCollectorProbe(shouldPause) {
  const rec = stats.probeSync || (stats.probeSync = {});
  rec.base = collectorBase;
  rec.requested = shouldPause ? 'pause' : 'resume';
  rec.ok = null;
  rec.sent = null;
  rec.error = null;
  rec.probe = null;
  try {
    const res = await fetch(collectorBase + '/probe', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !shouldPause }),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined,
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) {
      const raw = out ? (out.message || out.error) : null;
      throw new Error(typeof raw === 'string' ? raw : raw && raw.message ? raw.message : 'HTTP ' + res.status);
    }
    rec.ok = true;
    rec.sent = { enabled: !shouldPause };
    rec.probe = out && out.probe ? out.probe : null;
  } catch (err) {
    rec.ok = false;
    rec.error = err && err.message ? err.message : String(err);
    const msg = '只暂停了面板刷新：没连上采集器（' + rec.error + '），探测没被暂停。' +
      (shouldPause ? '彻底关掉请打开设置 → 关闭「启用主动探测」。' : '');
    console.warn('[tokmeter] ' + msg);
    if (settings && typeof settings.showNotice === 'function') settings.showNotice(msg);
  }
}

function wireControls() {
  const refresh = document.getElementById('btn-refresh');
  const copyBtn = document.getElementById('btn-copy');
  const power = document.getElementById('btn-power');
  const gear = document.getElementById('btn-settings');
  if (gear) gear.addEventListener('click', () => { if (settings) settings.toggle ? settings.toggle() : settings.open(); });
  // 标题栏右侧的连接状态区也是设置入口（点哪里都能打开同一张浮层）
  const link = panel.querySelector('.hdr-link');
  if (link) {
    link.setAttribute('role', 'button');
    link.setAttribute('tabindex', '0');
    link.addEventListener('click', () => { if (settings) settings.open(); });
    link.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (settings) settings.open(); }
    });
  }
  if (refresh) refresh.addEventListener('click', () => {
    if (activeSource && typeof activeSource.pollOnce === 'function') activeSource.pollOnce();
    flash(refresh);
  });
  if (copyBtn) copyBtn.addEventListener('click', () => { copySummary(copyBtn); });
  if (power) power.addEventListener('click', () => { togglePause(power); });
}

/** 按当前视图启动数据源（暂停后恢复也走这里）。 */
function startSource() {
  if (view === 'client') {
    const endpoint = params.get('endpoint') || 'http://127.0.0.1:8787/snapshot';
    activeSource = createClientSource({ endpoint, intervalMs: 1000, now: () => Date.now() });
  } else {
    activeSource = pickSource();
  }
  activeSource.start((s) => store.update(s));
}

/** 面板宽度决定 1u 的像素值，窗口尺寸变化时重算。 */
function layout() {
  applyUnit(panel, panel.clientWidth);
}

layout();
addEventListener('resize', layout);
addEventListener('orientationchange', layout);

panel.dataset.view = view;
renderShell(panel, view);
/** 设置浮层：采集器根地址优先取 ?config=，否则从 snapshot 端点推（桌面壳会显式带上 ?config=）。 */
settings = createSettings({
  root: panel,
  baseUrl: collectorBase,
  onSaved: () => {
    if (activeSource && typeof activeSource.pollOnce === 'function') activeSource.pollOnce();
  },
});
wireControls();
if (params.get('island') === '1') renderIsland();   // 可选：灵动岛胶囊，默认关闭

/** 冻结时钟：把今天的时分秒固定下来，让探针输出可复现。 */
function frozenNow() {
  if (!freeze) return Date.now();
  const [h, m, sec] = freeze.split(':').map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, sec || 0, 0);
  return d.getTime();
}

/** 按键回归：?test=1&press=power,copy 真的触发按钮事件，结果记进探针。两种视图都要跑。 */
function applyPress() {
  const press = (params.get('press') || '').split(',').map((v) => v.trim()).filter(Boolean);
  if (press.length === 0) return;
  stats.press = {};
  for (const name of press) {
    // 页脚按钮是 #btn-xxx；设置浮层里的按钮是 #set-xxx（press=settings,close 用来验证浮层能关掉）
    const btn = document.getElementById('btn-' + name) || document.getElementById('set-' + name);
    if (!btn) continue;
    btn.click();
    if (name === 'power') stats.press.power = { paused: stats.paused === true, isOff: btn.classList.contains('is-off') };
    if (name === 'copy') stats.press.copy = { text: stats.copied || null };
    if (name === 'refresh') stats.press.refresh = { ok: true };
    if (name === 'settings') stats.press.settings = { open: !!(settings && settings.isOpen()) };
  }
  store.update({});   // 探针在绘制时序列化，按键结果要再画一帧才带得出去
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

// 测试模式：设置浮层的"读配置 / 测试连接"是异步的，完成时没有新的数据帧，
// 探针就会停在"读取中"那一帧（实测：--dump-dom 抓到的是空提示）。
// 这里按固定节奏把当前状态重写进 #probe，保证抓到的是异步结束之后的 DOM。
if (testMode) setInterval(() => writeProbe(store.get()), 50);

/** 客户端视图的确定性样本：数值固定，便于探针断言。 */
function clientFixture(now, seedValue) {
  const rnd = mulberry32(seedValue);
  const history = [];
  let v = 180;
  for (let i = 0; i < 60; i++) {
    v = Math.max(40, v + (rnd() - 0.5) * 60);
    history.push(Math.round(v));
  }
  history[59] = 62;
  return {
    view: 'client',
    status: 'live',
    clock: formatClock(new Date(now)),
    updatedAt: now,
    model: { name: 'deepseek-chat', engine: 'OpenAI 兼容', nodes: 'API' },
    output: { tokPerSec: 62, history },
    input: { tokPerSec: 3400, prefillAvgMs: 320 },
    requests: { active: 1, queued: 0, capacity: 1 },
    client: {
      ttftP50: 320, ttftP95: 900, rateP50: 62, rateP95: 88, probeCount: 42, failCount: 2,
      successRate: 0.95, available: false, tokensIn: 1000000, tokensOut: 500000, cost: 6, lastError: null,
      history: history.slice(-15),
    },
  };
}

if (testMode && view === 'client') {
  store.update(mapClientPayload(clientFixture(frozenNow(), seed), emptySnapshot(Date.now())));
  applyPress();
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
  applyPress();
} else {
  startSource();
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