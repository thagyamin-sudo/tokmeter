/**
 * 数值格式化：面板上所有数字都经这里产出，保证越界/缺失值不会渲染成 NaN、Infinity。
 * 约定：任何非有限数一律返回占位符，负数按 0 处理。
 */

/** 速率：257 → '257'，1700 → '1.7K'，2340000 → '2.3M'。 */
export function formatRate(v) {
  if (!Number.isFinite(v)) return '--';
  const n = Math.max(0, v);
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  // 999950~999999 会被 toFixed(1) 抬成 "1000.0K"（7 字符，是格式化层唯一越界串）——进位到 M
  if (k < 999.95) return k.toFixed(1) + 'K';
  return (n / 1e6).toFixed(1) + 'M';
}

/** 本地时间 HH:MM:SS（24 小时制，补零）。 */
export function formatClock(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '--:--:--';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 0.16 → '16%'。 */
export function formatPercent(ratio) {
  if (!Number.isFinite(ratio)) return '--';
  // 夹取到 0~1：环弧本身就只能画 0~1，文字若显示 1600%/-50% 会与图形自相矛盾
  // （最常见的接线错误是按 0~100 传比例，这里兜住）
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100) + '%';
}

/** 105, 128 → '105/128G'。 */
export function formatMemPair(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total)) return '--/--G';
  return Math.max(0, Math.round(used)) + '/' + Math.max(0, Math.round(total)) + 'G';
}

/** 23 → '23G'（"可用" 前缀由 DOM 承担）。 */
export function formatFreeLabel(gb) {
  if (!Number.isFinite(gb)) return '--G';
  return Math.max(0, Math.round(gb)) + 'G';
}

/** 1.99 → '1.99'。 */
export function formatTar(v) {
  if (!Number.isFinite(v)) return '--';
  return Math.max(0, v).toFixed(2);
}
