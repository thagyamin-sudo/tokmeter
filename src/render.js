/**
 * 渲染层：只负责把 Snapshot 写进 DOM，不做任何业务计算。
 * 尺寸单位统一为 u（= 面板宽度的 1%），SVG 的 viewBox 也直接用 u，
 * 因此图形坐标与 CSS 尺寸一一对应，缩放时不会变形。
 */
import { formatRate, formatClock, formatPercent, formatMemPair, formatFreeLabel, formatTar } from './format.js';
import { sparklinePath, ringGeometry, barRects } from './charts.js';

/** SVG 图标（fill 用 currentColor，尺寸由 CSS 决定）。 */
const ICONS = {
  app: '<svg viewBox="0 0 32 32" width="100%" height="100%"><defs><linearGradient id="agi" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f4fd0"/><stop offset="1" stop-color="#4aa8f0"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#agi)"/><path d="M9 20c2.4 0 3.4-2.2 4.6-5.2C14.8 11.6 16 9 18.4 9c2 0 3.2 1.6 4.6 4.4" fill="none" stroke="#eaf3ff" stroke-width="2.4" stroke-linecap="round"/><circle cx="10.5" cy="22.5" r="2" fill="#eaf3ff"/></svg>',
  chevron: '<svg viewBox="0 0 16 16" width="100%" height="100%"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clock: '<svg viewBox="0 0 16 16" width="100%" height="100%"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.6V8l2.4 1.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  refresh: '<svg viewBox="0 0 16 16" width="100%" height="100%"><path d="M13 8a5 5 0 1 1-1.7-3.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M13 2.6V5.2h-2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 16 16" width="100%" height="100%"><rect x="2.6" y="2.6" width="7.4" height="7.4" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6.2 12.2a1.8 1.8 0 0 0 1.8 1.2h3a1.8 1.8 0 0 0 1.8-1.8v-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  power: '<svg viewBox="0 0 16 16" width="100%" height="100%"><path d="M8 2.4v5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M4.8 4.4a5 5 0 1 0 6.4 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  users: '<svg viewBox="0 0 16 16" width="100%" height="100%"><circle cx="5.6" cy="5.4" r="2.4" fill="currentColor"/><path d="M1.8 13.2c0-2.3 1.7-3.7 3.8-3.7s3.8 1.4 3.8 3.7z" fill="currentColor"/><circle cx="11.2" cy="6.2" r="1.9" fill="currentColor"/><path d="M10.2 12.8c0-1.7 1-2.9 2.4-2.9 1.3 0 2.2 1 2.2 2.9z" fill="currentColor"/></svg>',
  download: '<svg viewBox="0 0 16 16" width="100%" height="100%"><circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.55"/><path d="M8 4.4v5" stroke="#1c1c1e" stroke-width="1.5" stroke-linecap="round"/><path d="M5.8 7.4 8 9.6l2.2-2.2" fill="none" stroke="#1c1c1e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chip: '<svg viewBox="0 0 16 16" width="100%" height="100%"><rect x="3" y="4.4" width="10" height="7.2" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.6 2.8v1.6M10.4 2.8v1.6M5.6 11.6v1.6M10.4 11.6v1.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  sparkle: '<svg viewBox="0 0 16 16" width="100%" height="100%"><path d="M7 1.6 8.4 5.6 12.4 7 8.4 8.4 7 12.4 5.6 8.4 1.6 7 5.6 5.6z" fill="currentColor"/><path d="M12.6 9.4l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" fill="currentColor"/></svg>',
  memory: '<svg viewBox="0 0 16 16" width="100%" height="100%"><rect x="1.8" y="4.2" width="12.4" height="7.6" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4.4 6.6h7.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  gauge: '<svg viewBox="0 0 16 16" width="100%" height="100%"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.2v1.6M8 10.2v1.6M4.2 8h1.6M10.2 8h1.6M5.3 5.3l1.1 1.1M9.6 9.6l1.1 1.1M10.7 5.3 9.6 6.4M6.4 9.6 5.3 10.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  cloud: '<svg viewBox="0 0 16 16" width="100%" height="100%"><path d="M4.6 12.4h6.9a2.6 2.6 0 0 0 .3-5.2 3.8 3.8 0 0 0-7.3-.9A2.9 2.9 0 0 0 4.6 12.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  doc: '<svg viewBox="0 0 16 16" width="100%" height="100%"><path d="M4 1.9h5l3 3v9.2H4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6.2 8.2h3.6M6.2 10.6h3.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
};
export { ICONS };

const RING_R = 8.5;
const RING_STROKE = 1.9;
const BARS_W = 21;
const BARS_H = 15;

function setText(root, id, value) {
  const node = root.querySelector('#' + id);
  if (node) node.textContent = value;
}

function textOf(root, sel) {
  const node = root.querySelector(sel);
  return node ? node.textContent.trim() : null;
}

function setWidthPct(root, id, pct) {
  const node = root.querySelector('#' + id);
  if (node) node.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

/** 更新一条环形进度弧：弧长只由 dasharray 表达，起点由 rotate(-90) 落在 12 点。 */
function setArc(root, id, ratio) {
  const node = root.querySelector('#' + id);
  if (!node) return;
  const g = ringGeometry(ratio, RING_R, RING_STROKE);
  node.setAttribute('stroke-dasharray', g.dasharray);
  node.setAttribute('stroke-dashoffset', String(g.dashoffset));
}

function ringCard(id, title, icon, arcId, valueId, sideHtml) {
  return (
    '<section class="card" id="' + id + '">' +
    '<div class="card-head"><span class="card-icon">' + icon + '</span><span class="card-title">' + title + '</span></div>' +
    '<div class="card-body ring-body">' +
    '<div class="ring-wrap">' +
    '<svg class="ring" viewBox="0 0 20 20">' +
    '<circle cx="10" cy="10" r="' + RING_R + '" fill="none" stroke="var(--track)" stroke-width="' + RING_STROKE + '"/>' +
    '<circle id="' + arcId + '" cx="10" cy="10" r="' + RING_R + '" fill="none" stroke-width="' + RING_STROKE +
    '" stroke-linecap="round" transform="rotate(-90 10 10)" stroke-dasharray="0 53.4"/>' +
    '</svg>' +
    '<div class="ring-text" id="' + valueId + '">--</div>' +
    '</div>' +
    '<div class="ring-side">' + sideHtml + '</div>' +
    '</div></section>'
  );
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
    '  <svg class="hero-chart" id="spark" viewBox="0 0 41 19">',
    '    <path id="spark-path" fill="none" stroke="var(--green)" stroke-width="0.95"',
    '      stroke-linecap="round" stroke-linejoin="round" d=""></path>',
    '  </svg>',
    '</section>',
    '<div class="grid" id="grid">',
    '  <section class="card" id="card-req">',
    '    <div class="card-head"><span class="card-icon">' + ICONS.users + '</span><span class="card-title">请求状态</span></div>',
    '    <div class="card-body req">',
    '      <div class="req-line"><span class="req-num" id="req-active" style="color:var(--green)">--</span>',
    '        <span class="req-label">活动</span>',
    '        <span class="req-num" id="req-queued" style="color:var(--orange)">--</span>',
    '        <span class="req-label">排队</span></div>',
    '      <div class="bar" id="req-bar"><span class="bar-run" id="bar-run"></span><span class="bar-queue" id="bar-queue"></span></div>',
    '    </div>',
    '  </section>',
    '  <section class="card" id="card-input">',
    '    <div class="card-head"><span class="card-icon">' + ICONS.download + '</span><span class="card-title">输入 Token</span></div>',
    '    <div class="card-body input-body">',
    '      <div class="value-line"><span class="value-big" id="input-rate">--</span><span class="value-unit">tok/s</span></div>',
    '      <div class="foot-line"><span class="foot-icon">' + ICONS.doc + '</span><span id="input-foot">Prefill 均值</span></div>',
    '    </div>',
    '  </section>',
    ringCard('card-kv', 'KV Cache', ICONS.chip, 'kv-arc', 'kv-value',
      '<div id="kv-label">占用率</div>' +
      '<div class="green" id="kv-headroom">--</div>' +
      '<div id="kv-hit">--</div>'),
    ringCard('card-mtp', 'MTP', ICONS.sparkle, 'mtp-arc', 'mtp-value',
      '<div id="tar-label">TAR</div>' +
      '<div class="value-mid" id="tar-value">--</div>'),
    ringCard('card-mem', '统一内存', ICONS.memory, 'mem-arc', 'mem-value',
      '<div id="mem-node">--</div>' +
      '<div class="green" id="mem-pair">--</div>' +
      '<div>可用 <span id="mem-free">--</span></div>'),
    '  <section class="card" id="card-gpu">',
    '    <div class="card-head"><span class="card-icon">' + ICONS.gauge + '</span><span class="card-title">GPU 活跃度</span></div>',
    '    <div class="card-body gpu-body">',
    '      <div class="gpu-left"><div class="gpu-value" id="gpu-value">--</div><div class="gpu-state" id="gpu-state">--</div></div>',
    '      <svg class="gpu-bars" id="gpu-bars" viewBox="0 0 ' + BARS_W + ' ' + BARS_H + '"></svg>',
    '    </div>',
    '  </section>',
    '</div>',
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

/** 可选：灵动岛样式的 tok/s 胶囊（?island=1），复刻参考照片顶部的实时活动。 */
export function renderIsland() {
  const node = document.createElement('div');
  node.className = 'island';
  node.id = 'island';
  node.innerHTML =
    '<span class="island-icon">' + ICONS.cloud + '</span>' +
    '<span class="island-rate" id="island-rate">--</span>' +
    '<span class="island-unit">tok/s</span>';
  document.body.appendChild(node);
}

/** GPU 柱条：数量不变时只改属性，避免每帧重建 DOM。 */
function drawBars(root, history) {
  const svg = root.querySelector('#gpu-bars');
  if (!svg) return;
  const rects = barRects(history, { x: 0, y: 0, w: BARS_W, h: BARS_H }, 0.12);
  while (svg.childElementCount > rects.length) svg.lastElementChild.remove();
  while (svg.childElementCount < rects.length) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('fill', 'var(--lime)');
    svg.appendChild(rect);
  }
  rects.forEach((r, i) => {
    const node = svg.children[i];
    node.setAttribute('x', String(r.x));
    node.setAttribute('y', String(r.y));
    node.setAttribute('width', String(r.w));
    node.setAttribute('height', String(r.h));
    node.setAttribute('rx', String(r.rx));
  });
}

/** 六张数据卡的每帧更新。 */
export function paintCards(root, s) {
  const cap = Math.max(1, s.requests.capacity);
  setText(root, 'req-active', String(s.requests.active));
  setText(root, 'req-queued', String(s.requests.queued));
  setWidthPct(root, 'bar-run', (s.requests.active / cap) * 100);
  setWidthPct(root, 'bar-queue', (s.requests.queued / cap) * 100);

  setText(root, 'input-rate', formatRate(s.input.tokPerSec));

  setText(root, 'kv-value', formatPercent(s.kvCache.usage));
  setText(root, 'kv-headroom', s.kvCache.headroom);
  setText(root, 'kv-hit', 'Cache Hit ' + formatPercent(s.kvCache.hitRate));
  setArc(root, 'kv-arc', s.kvCache.usage);

  setText(root, 'mtp-value', formatPercent(s.mtp.ratio));
  setText(root, 'tar-value', formatTar(s.mtp.tar));
  setArc(root, 'mtp-arc', s.mtp.ratio);

  const memRatio =
    Number.isFinite(s.memory.usedGB) && Number.isFinite(s.memory.totalGB) && s.memory.totalGB > 0
      ? s.memory.usedGB / s.memory.totalGB
      : NaN;   // 未知显存 → 显示 --，绝不显示 0%
  setText(root, 'mem-value', formatPercent(memRatio));
  setText(root, 'mem-node', s.memory.node);
  setText(root, 'mem-pair', formatMemPair(s.memory.usedGB, s.memory.totalGB));
  setText(root, 'mem-free', formatFreeLabel(s.memory.freeGB));
  setArc(root, 'mem-arc', memRatio);

  setText(root, 'gpu-value', formatPercent(s.gpu.utilization));
  setText(root, 'gpu-state', s.gpu.state);
  drawBars(root, s.gpu.history);
}

/** 每帧更新：把快照写进 DOM。 */
export function paint(root, s) {
  setText(root, 'model-name', s.model.name);
  setText(root, 'model-sub', s.model.engine + ' · ' + s.model.nodes);
  // 监控面板最危险的失效模式是"安静地显示过期数据"：stale 也必须看得见
  const linkText = s.status === 'error' ? '未连接' : s.status === 'stale' ? '连接异常' : 'NAS 已连接';
  setText(root, 'link-text', linkText);
  root.classList.toggle('is-degraded', s.status === 'stale' || s.status === 'error');
  setText(root, 'out-rate', formatRate(s.output.tokPerSec));
  setText(document, 'island-rate', formatRate(s.output.tokPerSec));
  setText(root, 'clock', s.clock);
  const path = root.querySelector('#spark-path');
  if (path) path.setAttribute('d', sparklinePath(s.output.history, 41, 19, 2));
  paintCards(root, s);
}

const r2 = (v) => Math.round(v * 100) / 100;

/** 弧比例：从 dasharray '<弧长> <周长>' 反推。 */
function arcRatio(node) {
  if (!node) return null;
  const parts = String(node.getAttribute('stroke-dasharray') || '').trim().split(/[\s,]+/).map(Number);
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1]) || parts[1] === 0) return null;
  return Math.round((parts[0] / parts[1]) * 10000) / 10000;
}

/** 采集探针数据：真实几何 + 关键文本，供无头浏览器断言。 */
export function collectProbe(root, s, stats) {
  const pr = root.getBoundingClientRect();
  const hero = root.querySelector('#hero').getBoundingClientRect();
  const d = (root.querySelector('#spark-path') || { getAttribute: () => '' }).getAttribute('d') || '';
  const read = (id) => {
    const n = root.querySelector('#' + id);
    return n ? n.textContent.trim() : null;
  };
  const box = (sel) => {
    const n = root.querySelector(sel);
    return n ? n.getBoundingClientRect().width : 0;
  };
  const cardEl = root.querySelector('#card-req');
  // 量 "Cache Hit 93%" 的真实文本宽度与可用宽度（scrollWidth 在 ellipsis 下会被钳住，不可用）
  const kvFit = (() => {
    const node = root.querySelector('#kv-hit');
    if (!node) return { need: 0, avail: 0 };
    const cs = getComputedStyle(node);
    const probe = document.createElement('span');
    probe.textContent = node.textContent;
    // 不能用 cs.font：Chrome 常返回空串，量出来会变成 16px 默认字体（假数据）
    probe.style.cssText =
      'position:absolute;visibility:hidden;white-space:nowrap;' +
      'font-family:' + cs.fontFamily + ';font-size:' + cs.fontSize +
      ';font-weight:' + cs.fontWeight + ';letter-spacing:' + cs.letterSpacing;
    document.body.appendChild(probe);
    const need = Math.round(probe.getBoundingClientRect().width * 100) / 100;
    probe.remove();
    return { need, avail: Math.round(node.clientWidth * 100) / 100 };
  })();
  return {
    mode: 'test',
    viewport: { w: innerWidth, h: innerHeight },
    panel: { w: r2(pr.width), h: r2(pr.height) },
    u: getComputedStyle(root).getPropertyValue('--u').trim(),
    texts: {
      title: read('model-name'),
      engine: read('model-sub'),
      link: read('link-text'),
      heroLabel: textOf(root, '.hero-label'),
      heroFoot: textOf(root, '.hero-foot'),
      rate: read('out-rate'),
      unit: textOf(root, '.hero-unit'),
      clock: read('clock'),
    },
    hero: {
      h: r2(hero.height),
      ratio: Math.round((hero.height / pr.width) * 10000) / 10000,
      numW: r2((root.querySelector('#out-rate') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width),
      valueRight: r2((root.querySelector('.hero-value') || { getBoundingClientRect: () => ({ right: 0 }) }).getBoundingClientRect().right),
      chartLeft: r2((root.querySelector('#spark') || { getBoundingClientRect: () => ({ left: 0 }) }).getBoundingClientRect().left),
    },
    overflow: { doc: document.documentElement.scrollWidth, body: document.body.scrollWidth },
    hdr: (() => {
      const h = root.querySelector('.hdr').getBoundingClientRect();
      return { h: r2(h.height), bottom: r2(h.bottom), heroTop: r2(hero.top) };
    })(),
    spark: { points: (d.match(/[ML]/g) || []).length, d },
    cards: {
      heightRatio: cardEl ? Math.round((cardEl.getBoundingClientRect().height / pr.width) * 10000) / 10000 : 0,
      requests: {
        title: textOf(root, '#card-req .card-title'),
        active: read('req-active'),
        queued: read('req-queued'),
        run: r2(box('#bar-run')),
        queue: r2(box('#bar-queue')),
        total: r2(box('#req-bar')),
      },
      input: {
        title: textOf(root, '#card-input .card-title'),
        rate: read('input-rate'),
        unit: textOf(root, '#card-input .value-unit'),
        foot: read('input-foot'),
      },
      kv: {
        title: textOf(root, '#card-kv .card-title'),
        value: read('kv-value'),
        headroom: read('kv-headroom'),
        hit: read('kv-hit'),
        // 省略号兜底很容易把正常文案也吃掉（曾把 "Cache Hit 93%" 截成 "Cache Hit …"）。
        // 注意不能用 scrollWidth 判断：text-overflow: ellipsis 下 scrollWidth 会被钳到 clientWidth，
        // 得到的是假阴性。这里用同字体的隐藏 span 量真实文本宽度。
        clipped: kvFit.need > kvFit.avail + 1,
        need: kvFit.need,
        avail: kvFit.avail,
        ratio: arcRatio(root.querySelector('#kv-arc')),
      },
      mtp: {
        title: textOf(root, '#card-mtp .card-title'),
        value: read('mtp-value'),
        tar: read('tar-value'),
        ratio: arcRatio(root.querySelector('#mtp-arc')),
      },
      mem: {
        title: textOf(root, '#card-mem .card-title'),
        value: read('mem-value'),
        node: read('mem-node'),
        pair: read('mem-pair'),
        free: read('mem-free'),
        ratio: arcRatio(root.querySelector('#mem-arc')),
      },
      gpu: {
        title: textOf(root, '#card-gpu .card-title'),
        value: read('gpu-value'),
        state: read('gpu-state'),
        bars: (root.querySelector('#gpu-bars') || { childElementCount: 0 }).childElementCount,
      },
    },
    dim: root.classList.contains('is-degraded'),
    degrade: { staleLink: (stats && stats.staleLink) || null, staleDim: !!(stats && stats.staleDim) },
    island: (() => {
      const node = document.getElementById('island');
      const rate = document.getElementById('island-rate');
      return { present: !!node, rate: rate ? rate.textContent.trim() : null };
    })(),
    paintCount: (stats && stats.paints) || 0,
    updateCount: (stats && stats.updates) || 0,
    samples: {
      count: (stats && stats.samples) || 0,
      firstRate: stats ? stats.firstRate : null,
      rate: s.output.tokPerSec,
    },
    status: s.status,
  };
}
