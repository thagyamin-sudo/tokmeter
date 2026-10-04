/**
 * 采集器配置：默认值 + 校验 + 脱敏 + 写回。
 * API key 只从这里读（本地文件），绝不写进面板页面，也绝不出现在 /snapshot 里。
 * 面板的设置浮层走 HTTP（GET/POST /config），写回的就是这个文件。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export const DEFAULT_CONFIG = {
  port: 8787,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  probe: true,              // 主动探测总开关：false = 只被动统计，零额外调用
  probeEveryMs: 60000,      // 主动探测间隔（越小越费钱，最小 5 秒）
  probeMaxTokens: 24,
  probePrompt: '用一句话说明什么是缓存。',
  proxy: false,             // 是否开启 OpenAI 兼容转发（被动统计真实流量）
  pricing: { inPerM: 0, outPerM: 0 },   // 每百万 token 单价（美元），用于估算成本
  timeoutMs: 30000,
};

/** 面板可以把这些字段写回来（port 不开放：改端口必须重启进程才生效）。 */
export const PATCHABLE_FIELDS = ['baseUrl', 'model', 'probe', 'probeEveryMs', 'probeMaxTokens', 'probePrompt', 'proxy'];

/** 没有成功样本时占位的 prompt token 数（只用于「每天大约消耗多少 token」的估算）。 */
export const PROBE_PROMPT_TOKENS_FALLBACK = 24;

/** 归一化并校验；出错抛带可读信息的 Error，调用方直接打印即可。 */
export function normalizeConfig(raw) {
  const merged = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  const cfg = {
    port: Number(merged.port),
    baseUrl: String(merged.baseUrl || '').replace(/\/+$/, ''),
    apiKey: typeof merged.apiKey === 'string' ? merged.apiKey : '',
    model: String(merged.model || ''),
    // 只有真正的布尔 false 才是关；字符串 "false" / 0 / 缺省一律按默认 true
    probe: typeof merged.probe === 'boolean' ? merged.probe : DEFAULT_CONFIG.probe,
    probeEveryMs: Number(merged.probeEveryMs),
    probeMaxTokens: Number(merged.probeMaxTokens),
    probePrompt: String(merged.probePrompt || DEFAULT_CONFIG.probePrompt),
    proxy: merged.proxy === true,
    pricing: {
      inPerM: Number(merged.pricing && merged.pricing.inPerM) || 0,
      outPerM: Number(merged.pricing && merged.pricing.outPerM) || 0,
    },
    timeoutMs: Number(merged.timeoutMs),
  };

  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error('port 必须是 1~65535 的整数');
  if (!/^https?:\/\//.test(cfg.baseUrl)) throw new Error('baseUrl 必须以 http:// 或 https:// 开头（例：https://api.deepseek.com/v1）');
  if (!cfg.model) throw new Error('model 不能为空（例：deepseek-chat）');
  if (!(cfg.probeEveryMs >= 5000)) throw new Error('probeEveryMs 不得小于 5000（避免烧钱）');
  if (!(cfg.probeMaxTokens >= 1 && cfg.probeMaxTokens <= 512)) throw new Error('probeMaxTokens 必须在 1~512');
  if (!(cfg.timeoutMs >= 1000)) throw new Error('timeoutMs 不得小于 1000');
  return cfg;
}

/** 读配置文件；文件不存在时给出可操作的提示。 */
export function readConfig(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error('读不到配置文件 ' + path + '：请先复制 collector.config.example.json 为 collector.config.json 并填写 baseUrl / apiKey / model');
  }
  let raw;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error('配置文件不是合法 JSON：' + err.message);
  }
  return normalizeConfig(raw);
}

/**
 * 写回配置文件：先写临时文件再改名，中途断电不会留下半截 JSON。
 * 注意：传进来的必须是**完整配置**（含真实 apiKey），不要传脱敏后的视图。
 */
export function writeConfig(path, cfg) {
  const text = JSON.stringify(cfg, null, 2) + '\n';
  const tmp = String(path) + '.tmp';
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
  return text;
}

/**
 * apiKey 脱敏：只留末 4 位，前面的用 *** 盖住（sk-xxxxc3a3 → sk-***c3a3）。
 * 空串（没填）返回空串——面板据此显示「未填写」，而不是显示一个假的 ***。
 */
export function maskApiKey(key) {
  const s = typeof key === 'string' ? key : '';
  if (s === '') return '';
  const tail = s.length > 4 ? s.slice(-4) : '';
  const head = s.startsWith('sk-') && s.length > 7 ? 'sk-' : '';
  return head + '***' + tail;
}

/**
 * 「不改动」哨兵：空串、以及任何带 *** 的值（\`***\` 或面板拿到的脱敏值 \`sk-***c3a3\`）都表示保留原 key。
 * 必须把脱敏值也算进来：面板 GET /config 拿到的是脱敏值，用户点保存时若把它原样回传，
 * 只认纯星号就会把真 key 覆盖成 \`sk-***c3a3\`——这是个不可逆的灾难。
 */
export function isApiKeyUnchanged(value) {
  if (typeof value !== 'string') return true;
  const v = value.trim();
  if (v === '') return true;
  return v.includes('***');
}

/**
 * 合并部分字段 → 完整配置（含校验）。
 * apiKey 缺省/空串/纯星号 = 不改动；pricing 只覆盖显式给出的那一项。
 * 校验失败抛 Error（调用方转成 400 + 可读中文）。
 */
export function patchConfig(current, patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = { ...(current && typeof current === 'object' ? current : DEFAULT_CONFIG) };
  for (const k of PATCHABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(p, k)) next[k] = p[k];
  }
  if (!isApiKeyUnchanged(p.apiKey)) next.apiKey = p.apiKey;
  if (p.pricing && typeof p.pricing === 'object') {
    next.pricing = { ...(next.pricing || {}), ...p.pricing };
  }
  return normalizeConfig(next);
}

/**
 * 探测预算：把「多久探一次」翻译成面板要显示的「每天多少次、约多少 token」。
 *
 * enabled 由调用方给出（运行时的真实状态），不只看 cfg.probe：
 * 页脚 ⏻ 与桌面壳「隐藏到托盘」都是临时暂停，此时 probesPerDay 必须是 0。
 * 字段名带 Estimate —— prompt 侧取「最近一次成功探测的 promptTokens」，没有样本时按
 * PROBE_PROMPT_TOKENS_FALLBACK（24）占位，这是估算口径，不是账单。
 */
export function probeBudget(cfg, { promptTokens = 0, enabled = null } = {}) {
  const c = cfg && typeof cfg === 'object' ? cfg : DEFAULT_CONFIG;
  const on = enabled === null ? c.probe !== false : enabled === true;
  const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
  const everyMs = num(c.probeEveryMs, DEFAULT_CONFIG.probeEveryMs);
  const probeMaxTokens = num(c.probeMaxTokens, DEFAULT_CONFIG.probeMaxTokens);
  const promptTokensEstimate = num(promptTokens, PROBE_PROMPT_TOKENS_FALLBACK);
  const probesPerDay = on ? Math.round(86400000 / everyMs) : 0;
  return {
    enabled: on,
    everyMs,
    probesPerDay,
    probeMaxTokens,
    promptTokensEstimate,
    tokensPerDayEstimate: probesPerDay * (promptTokensEstimate + probeMaxTokens),
  };
}

/**
 * 面板可见的配置视图：apiKey 已脱敏，可以直接回传给浏览器。
 * probe 块允许调用方传入**运行时**状态（页脚 ⏻ / 托盘隐藏都会临时暂停探测）；
 * 不传时按配置文件里的总开关算。
 */
export function publicConfig(cfg, { configPath = null, probe = null } = {}) {
  return {
    baseUrl: cfg.baseUrl,
    apiKey: maskApiKey(cfg.apiKey),
    apiKeySet: typeof cfg.apiKey === 'string' && cfg.apiKey !== '',
    model: cfg.model,
    probe: probe && typeof probe === 'object' ? probe : probeBudget(cfg),
    probeEveryMs: cfg.probeEveryMs,
    probeMaxTokens: cfg.probeMaxTokens,
    probePrompt: cfg.probePrompt,
    proxy: cfg.proxy === true,
    pricing: { inPerM: cfg.pricing.inPerM, outPerM: cfg.pricing.outPerM },
    port: cfg.port,
    timeoutMs: cfg.timeoutMs,
    configPath: configPath ? String(configPath) : null,
    writable: !!configPath,
  };
}
