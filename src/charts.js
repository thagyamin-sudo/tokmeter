/**
 * SVG 图表几何：只做纯计算，不碰 DOM。
 * 坐标系与 SVG 一致（y 向下），调用方负责把结果写进 path/circle/rect 属性。
 */

/** 保留两位小数并去掉多余的 0，避免 path 里出现 12.340000000000002。 */
function num(n) {
  return String(Math.round(n * 100) / 100);
}

/**
 * 折线路径：点少于一帧（0 个）或含异常值时返回空串，调用方据此跳过绘制。
 * Y 轴按当前窗口的 [min,max] 自适应，pad 为上下留白。
 */
export function sparklinePath(values, w, h, pad = 0) {
  if (!Array.isArray(values) || values.length === 0) return '';
  // 单个坏点不该清空整条曲线：用相邻有效值顶上；全无效才返回空串（此时确实没东西可画）
  const clean = [];
  let last = null;
  for (const v of values) clean.push(Number.isFinite(v) ? (last = v) : last);
  if (clean.every((v) => v === null)) return '';
  const firstValid = clean.find((v) => v !== null);
  for (let i = 0; i < clean.length; i++) if (clean[i] === null) clean[i] = firstValid;
  const n = clean.length;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min;
  // 全 0（服务空转）应贴底，而不是悬在垂直中线让人误以为"有一半吞吐"
  const y = (v) => (span === 0 ? (max === 0 ? h - pad : h / 2) : h - pad - ((v - min) / span) * (h - 2 * pad));
  if (n === 1) return 'M 0 ' + num(y(clean[0]));
  const step = w / (n - 1);
  return clean
    .map((v, i) => (i === 0 ? 'M ' : 'L ') + num(i * step) + ' ' + num(y(v)))
    .join(' ');
}

/**
 * 环形进度：返回轨道/进度弧共用的半径、周长与 dasharray。
 * 起点在 12 点方向由调用方的 transform 负责（rotate(-90)）。
 * size 是含描边宽度的外框边长，供 viewBox 使用。
 */
export function ringGeometry(ratio, radius, strokeWidth) {
  const r = radius;
  const circumference = 2 * Math.PI * r;
  const safe = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const dash = circumference * safe;
  return {
    r,
    circumference,
    // dasharray 用 <弧长> <整圈> 表示"画一段、空一整圈"，起点即弧的起点（12 点方向由 CSS rotate 保证）。
    // dashoffset 必须保持 0：再叠加 (1-ratio) 的偏移会让可见弧长变成 (1-ratio)，是个画错但测试抓不到的坑。
    dasharray: dash + ' ' + circumference,
    dashoffset: 0,
    size: 2 * r + strokeWidth,
  };
}

/**
 * 柱状图矩形：等宽、等间隙，最后一根贴右边界；值按 0~1 归一化高度。
 */
export function barRects(values, box, gapRatio) {
  const list = Array.isArray(values) ? values : [];
  const n = list.length;
  if (n === 0) return [];
  const { x, y, w, h } = box;
  const gap = (w * gapRatio) / n;
  const barW = (w - (n - 1) * gap) / n;
  const rx = barW / 2;
  return list.map((v, i) => {
    const safe = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    const bh = safe * h;
    return { x: x + i * (barW + gap), y: y + (h - bh), w: barW, h: bh, rx };
  });
}
