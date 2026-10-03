/**
 * 数值格式化：面板上所有数字都经这里产出，保证越界/缺失值不会渲染成 NaN、Infinity。
 * 约定：任何非有限数一律返回占位符，负数按 0 处理；比例类一律夹取到 0~1。
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

/** 0.16 → '16%'。夹取到 0~1：环弧本身只能画 0~1，文字显示 1600% 会与图形自相矛盾。 */
export function formatPercent(ratio) {
  if (!Number.isFinite(ratio)) return '--';
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100) + '%';
}

/** 105, 128 → '105/128G'。 */
export function formatMemPair(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total)) return '--/--G';
  return Math.max(0, Math.round(used)) + '/' + Math.max(0, Math.round(total)) + 'G';
}

/** 23 → '23G'（"可用"前缀由 DOM 承担）。 */
export function formatFreeLabel(gb) {
  if (!Number.isFinite(gb)) return '--G';
  return Math.max(0, Math.round(gb)) + 'G';
}

/** 1.99 → '1.99'。 */
export function formatTar(v) {
  if (!Number.isFinite(v)) return '--';
  return Math.max(0, v).toFixed(2);
}

/** 毫秒展示：未知显示 --。 */
function ms(v) {
  return Number.isFinite(v) ? Math.round(v) + 'ms' : '--';
}

/**
 * 生成一段可直接粘贴到聊天/工单里的状态摘要（页脚"复制"按钮用）。
 * 纯函数便于单测；两种视图各用各的字段，不混用，未知量显示 --。
 */
export function formatSummary(s, view = 'server') {
  const lines = [
    'Tokmeter · ' + (s.clock || '--'),
    s.model.name + '（' + s.model.engine + ' · ' + s.model.nodes + '）',
    '状态 ' + s.status,
  ];
  if (view === 'client' && s.client) {
    lines.push('输出 ' + formatRate(s.output.tokPerSec) + ' tok/s');
    lines.push('TTFT P50 ' + ms(s.client.ttftP50) + ' / P95 ' + ms(s.client.ttftP95));
    lines.push('探测 ' + s.client.probeCount + ' 次，失败 ' + s.client.failCount);
    const cost = Number.isFinite(s.client.cost) ? s.client.cost.toFixed(2) : '--';
    lines.push('用量 输入 ' + formatRate(s.client.tokensIn) + ' / 输出 ' + formatRate(s.client.tokensOut) + ' tok，成本 ' + cost);
  } else {
    lines.push('输出 ' + formatRate(s.output.tokPerSec) + ' tok/s，输入 ' + formatRate(s.input.tokPerSec) + ' tok/s');
    lines.push('请求 ' + s.requests.active + ' 活动 / ' + s.requests.queued + ' 排队');
    lines.push('KV ' + formatPercent(s.kvCache.usage) + '，GPU ' + formatPercent(s.gpu.utilization));
  }
  return lines.join('\n');
}
