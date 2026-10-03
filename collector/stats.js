/**
 * 采集器 · 滚动统计：把探测样本汇总成面板要的字段。
 * 窗口按**时间**裁剪（"最近 60 秒"就该是 60 秒），上限 60 点对应面板的曲线长度。
 */
const DEFAULT_WINDOW_MS = 60000;
const MAX_POINTS = 60;

/** 分位数：nearest-rank，简单且不会插值出假的中间值。 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function createStats({ windowMs = DEFAULT_WINDOW_MS, pricing } = {}) {
  const samples = [];
  const price = pricing && typeof pricing === 'object' ? pricing : null;
  let tokensIn = 0;
  let tokensOut = 0;

  /** 丢弃窗口外的样本；调用方每次 add/snapshot 都会推进时间。 */
  function trim(now) {
    const floor = now - windowMs;
    while (samples.length > 0 && samples[0].t < floor) samples.shift();
  }

  return {
    add(sample) {
      if (!sample || typeof sample !== 'object') return;
      const t = Number.isFinite(sample.t) ? sample.t : 0;
      samples.push({
        t,
        ok: sample.ok === true,
        tokPerSec: Number.isFinite(sample.tokPerSec) ? sample.tokPerSec : 0,
        ttftMs: Number.isFinite(sample.ttftMs) ? sample.ttftMs : null,
        promptTokens: Number.isFinite(sample.promptTokens) ? sample.promptTokens : 0,
        completionTokens: Number.isFinite(sample.completionTokens) ? sample.completionTokens : 0,
      });
      if (samples[0] && samples[0].t > t) samples.sort((a, b) => a.t - b.t);
      if (sample.ok === true) {
        tokensIn += Number.isFinite(sample.promptTokens) ? sample.promptTokens : 0;
        tokensOut += Number.isFinite(sample.completionTokens) ? sample.completionTokens : 0;
      }
      trim(t);
      while (samples.length > MAX_POINTS * 4) samples.shift();   // 兜底，防止无时间推进时无限增长
    },

    snapshot(now = Date.now()) {
      trim(now);
      const okSamples = samples.filter((s) => s.ok);
      const rates = okSamples.map((s) => s.tokPerSec).sort((a, b) => a - b);
      const ttfts = okSamples.map((s) => s.ttftMs).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
      const cost = price
        ? (tokensIn / 1e6) * (Number.isFinite(price.inPerM) ? price.inPerM : 0) +
          (tokensOut / 1e6) * (Number.isFinite(price.outPerM) ? price.outPerM : 0)
        : 0;

      return {
        // 曲线：窗口内的成功速率，最多 60 点
        history: rates.slice(-MAX_POINTS),
        tokPerSec: okSamples.length > 0 ? okSamples[okSamples.length - 1].tokPerSec : 0,
        rateP50: percentile(rates, 50),
        rateP95: percentile(rates, 95),
        ttftP50: percentile(ttfts, 50),
        ttftP95: percentile(ttfts, 95),
        ttftLast: ttfts.length > 0 ? ttfts[ttfts.length - 1] : 0,
        probeCount: samples.length,
        failCount: samples.length - okSamples.length,
        successRate: samples.length === 0 ? null : okSamples.length / samples.length,
        available: samples.length > 0 && okSamples.length === samples.length,
        tokensIn,
        tokensOut,
        cost,
        inFlight: 0,          // 由采集器在探测期间写入
      };
    },

    setInFlight(n) {
      // 探测是串行的，这里只记录"当前是否有探测在途"，供面板显示
      const last = samples[samples.length - 1];
      if (last) last.inFlight = n;
    },
  };
}
