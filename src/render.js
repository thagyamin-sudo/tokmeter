/**
 * 渲染层：只负责把 Snapshot 写进 DOM，不做任何业务计算。
 * 尺寸单位统一为 u（= 面板宽度的 1%），SVG 的 viewBox 也直接用 u，
 * 因此图形坐标与 CSS 尺寸一一对应，缩放时不会变形。
 */
import { formatRate, formatClock, formatPercent, formatMemPair, formatFreeLabel, formatTar } from './format.js';
import { sparklinePath, ringGeometry, barRects } from './charts.js';

/** SVG 图标（16x16 视口，fill 用 currentColor）。 */
const ICONS = {
  app: '<svg viewBox="0 0 32 32" width="100%" height="100%"><defs><linearGradient id="agi" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f4fd0"/><stop offset="1" stop-color="#4aa8f0"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#agi)"/><path d="M9 20c2.4 0 3.4-2.2 4.6-5.2C14.8 11.6 16 9 18.4 9c2 0 3.2 1.6 4.6 4.4" fill="none" stroke="#eaf3ff" stroke-width="2.4" stroke-linecap="round"/><circle cx="10.5" cy="22.5" r="2" fill="#eaf3ff"/></svg>',
  chevron: '<svg viewBox="0 0 16 16" width="100%" height="100%"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clock: '<svg viewBox="0 0 16 16" width="100%" height="100%"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.6V8l2.4 1.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  refresh: '<svg viewBox="0 0 16 16" width="100%" height="100%"><path d="M13 8a5 5 0 1 1-1.7-3.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M13 2.6V5.2h-2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 16 16" width="100%" height="100%"><rect x="2.6" y="2.6" width="7.4" height="7.4" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6.2 12.2a1.8 1.8 0 0 0 1.8 1.2h3a1.8 1.8 0 0 0 1.8-1.8v-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  power: '<svg viewBox="0 0 16 16" width="100%" height="100%"><path d="M8 2.4v5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M4.8 4.4a5 5 0 1 0 6.4 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};
export { ICONS };

function setText(root, id, value) {
  const node = root.querySelector('#' + id);
  if (node) node.textContent = value;
}

/** 一次性建立静态结构（标题栏 / Hero / 卡片网格 / 底部栏）。 */
export function renderShell(root) {
  root.innerHTML = [
    '<header class="hdr">',
    '  <div class="hdr-icon">' + ICONS.app + '</div>',
    '  <div class="hdr-titles">',
    '    <div class="hdr-name" id="model-name">--</div>',
    '    <div class="hdr-sub" id="model-sub">--</div>',
    '  </div>',
    '  <div class="hdr-link"><span class="chev">' + ICONS.chevron + '</span>',
    '    <span id="link-text">--</span><span class="chev">' + ICONS.chevron + '</span></div>',
    '</header>',
    '<section class="hero" id="hero">',
    '  <div class="hero-info">',
    '    <div class="hero-label">实时输出 Token</div>',
    '    <div class="hero-value"><span class="hero-num" id="out-rate">--</span><span class="hero-unit">tok/s</span></div>',
    '    <div class="hero-foot">最近 60 秒</div>',
    '  </div>',
    '  <svg class="hero-chart" id="spark" viewBox="0 0 45 19">',
    '    <path id="spark-path" fill="none" stroke="var(--green)" stroke-width="1.1"',
    '      stroke-linecap="round" stroke-linejoin="round" d=""></path>',
    '  </svg>',
    '</section>',
    '<div class="grid" id="grid"></div>',
    '<footer class="ftr">',
    '  <div class="ftr-clock"><span class="ftr-icon">' + ICONS.clock + '</span><span id="clock">--:--:--</span></div>',
    '  <div class="ftr-actions">',
    '    <span class="ftr-icon">' + ICONS.refresh + '</span>',
    '    <span class="ftr-icon">' + ICONS.copy + '</span>',
    '    <span class="ftr-icon">' + ICONS.power + '</span>',
    '  </div>',
    '</footer>',
  ].join('\n');
}

/** 每帧更新：把快照写进 DOM。 */
export function paint(root, s) {
  setText(root, 'model-name', s.model.name);
  setText(root, 'model-sub', s.model.engine + ' · ' + s.model.nodes);
  setText(root, 'link-text', s.status === 'error' ? '未连接' : 'NAS 已连接');
  setText(root, 'out-rate', formatRate(s.output.tokPerSec));
  setText(root, 'clock', s.clock);
  const path = root.querySelector('#spark-path');
  if (path) path.setAttribute('d', sparklinePath(s.output.history, 45, 19, 2));
  paintCards(root, s);
}

/** 占位：六张数据卡由任务 7 实现。 */
export function paintCards() {}

const r2 = (v) => Math.round(v * 100) / 100;

/** 采集探针数据：真实几何 + 关键文本，供无头浏览器断言。 */
export function collectProbe(root, s, paintCount) {
  const pr = root.getBoundingClientRect();
  const hero = root.querySelector('#hero').getBoundingClientRect();
  const d = (root.querySelector('#spark-path') || { getAttribute: () => '' }).getAttribute('d') || '';
  const read = (id) => {
    const n = root.querySelector('#' + id);
    return n ? n.textContent.trim() : null;
  };
  return {
    mode: 'test',
    viewport: { w: innerWidth, h: innerHeight },
    panel: { w: r2(pr.width), h: r2(pr.height) },
    u: getComputedStyle(root).getPropertyValue('--u').trim(),
    texts: {
      title: read('model-name'),
      engine: read('model-sub'),
      link: read('link-text'),
      heroLabel: (root.querySelector('.hero-label') || {}).textContent || null,
      heroFoot: (root.querySelector('.hero-foot') || {}).textContent || null,
      rate: read('out-rate'),
      unit: (root.querySelector('.hero-unit') || {}).textContent || null,
      clock: read('clock'),
    },
    hero: { h: r2(hero.height), ratio: Math.round((hero.height / pr.width) * 10000) / 10000 },
    spark: { points: (d.match(/[ML]/g) || []).length, d },
    paintCount: paintCount || 0,
    status: s.status,
  };
}
