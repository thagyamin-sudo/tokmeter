/**
 * 面板内浮层设置页：读写本机采集器的配置。
 *
 *   GET  <base>/config       → 回填表单（apiKey 是脱敏值，密码框里显示的就是它）
 *   POST <base>/config       → 保存（apiKey 留空或回传 *** 表示不改动；非法值 400 + 中文提示）
 *   POST <base>/config/test  → 用当前表单值发一次最小流式请求，量 TTFT / tok/s
 *
 * 面板可能以 file:// 打开，所以全部走采集器的 CORS 接口；页面上永远不出现明文 key。
 * 没有采集器时不弹 alert，只在浮层里显示一行可操作的提示。
 */

/** 采集器不在时的提示文案（与 README / 桌面壳一致）。 */
export const NO_COLLECTOR_HINT = '设置需要本机采集器（node collector.js 或桌面版）';

/** 关闭主动探测时的成本提示：**逐字**是给用户的承诺，别改（探针 tools/probe.js 断言它）。 */
export const PROBE_OFF_HINT = '已关闭主动探测：只统计经过本机的流量，不产生额外调用';

/** 还没连上采集器时的兜底提示：按默认口径说清楚，但不编造属于这台机器的数字。 */
export const PROBE_HINT_FALLBACK = '默认每 60 秒 1 次 ≈ 每天 1440 次调用（会消耗你的 token，走你的计费）；连上采集器后显示按你的配置算出的估算';

/** 每天的 token 估算：上万就折成「万」（面板一行放不下长数字）。 */
export function formatProbeTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  return v >= 10000 ? Math.round(v / 10000) + ' 万' : String(Math.round(v));
}

/**
 * 成本提示文案。两句话都必须出现：
 *  - 开着：「每 60 秒 1 次 ≈ 每天 1440 次调用、约 7 万 token（会消耗你的 token，走你的计费）」
 *  - 关着：「已关闭主动探测：只统计经过本机的流量，不产生额外调用」
 * 入参可以是采集器 /config 的 probe 块，也可以是表单里改过的间隔（用户改完立刻重算）。
 */
export function probeHintText(probe) {
  const p = probe && typeof probe === 'object' ? probe : null;
  if (!p) return PROBE_HINT_FALLBACK;
  if (p.enabled === false) return PROBE_OFF_HINT;
  const everyMs = Number(p.everyMs) > 0 ? Math.round(Number(p.everyMs)) : 60000;
  const probeMaxTokens = Number(p.probeMaxTokens) > 0 ? Number(p.probeMaxTokens) : 24;
  const promptTokens = Number(p.promptTokensEstimate) > 0 ? Number(p.promptTokensEstimate) : 24;
  const probesPerDay = Math.round(86400000 / everyMs);
  const tokensPerDay = probesPerDay * (promptTokens + probeMaxTokens);
  return '每 ' + Math.round(everyMs / 1000) + ' 秒 1 次 ≈ 每天 ' + probesPerDay + ' 次调用、约 ' +
    formatProbeTokens(tokensPerDay) + ' token（会消耗你的 token，走你的计费）';
}

/**
 * 从面板的 snapshot 端点推出采集器根地址：
 * http://127.0.0.1:8787/snapshot → http://127.0.0.1:8787
 */
export function configBaseFromEndpoint(endpoint, fallback = 'http://127.0.0.1:8787') {
  const raw = String(endpoint === undefined || endpoint === null ? '' : endpoint).trim();
  if (raw === '') return fallback;
  try {
    return new URL(raw).origin;
  } catch {
    return fallback;
  }
}

/** 表单字段 → 提交给 POST /config 的补丁（空字段不提交，避免把 0/空串当成用户意图）。 */
export function buildConfigPatch(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const patch = {};
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  if (text(f.baseUrl) !== '') patch.baseUrl = text(f.baseUrl);
  if (text(f.model) !== '') patch.model = text(f.model);
  if (typeof f.apiKey === 'string') patch.apiKey = f.apiKey.trim();          // '' / '***' 都表示不改动
  if (text(f.probeEveryMs) !== '') patch.probeEveryMs = Number(f.probeEveryMs);
  patch.proxy = f.proxy === true;
  // probe 只在**明确**给了布尔值时才提交：调用方没提这个字段 = 不改动（别顺手把探测打开）
  if (typeof f.probe === 'boolean') patch.probe = f.probe;
  const pricing = {};
  if (text(f.inPerM) !== '') pricing.inPerM = Number(f.inPerM);
  if (text(f.outPerM) !== '') pricing.outPerM = Number(f.outPerM);
  if (Object.keys(pricing).length > 0) patch.pricing = pricing;
  return patch;
}

/** 表单 HTML（保持极简：一行一个字段，不需要滚动就能看全）。 */
function formHtml() {
  return [
    '<div class="set-head"><span id="set-title">设置</span></div>',
    '<p class="set-note" id="set-notice" hidden></p>',
    '<label class="set-row" for="set-baseurl"><span>接口地址 baseUrl</span>',
    '  <input id="set-baseurl" type="text" spellcheck="false" autocomplete="off" placeholder="https://api.deepseek.com/v1"></label>',
    '<label class="set-row" for="set-apikey"><span>API Key（留空或 *** 表示不改动）</span>',
    '  <input id="set-apikey" type="password" spellcheck="false" autocomplete="off" placeholder="sk-…"></label>',
    '<label class="set-row" for="set-model"><span>模型 model</span>',
    '  <input id="set-model" type="text" spellcheck="false" autocomplete="off" placeholder="deepseek-chat"></label>',
    '<label class="set-row" for="set-interval"><span>探测间隔（毫秒，最小 5000）</span>',
    '  <input id="set-interval" type="number" min="5000" step="1000" inputmode="numeric"></label>',
    '<label class="set-row set-row-check" for="set-probe"><span>启用主动探测</span>',
    '  <input id="set-probe" type="checkbox"></label>',
    '<p class="set-hint" id="set-probe-hint"></p>',
    '<label class="set-row set-row-check" for="set-proxy"><span>开启 OpenAI 兼容转发（/v1）</span>',
    '  <input id="set-proxy" type="checkbox"></label>',
    '<label class="set-row" for="set-in-perm"><span>输入单价（美元 / 百万 token）</span>',
    '  <input id="set-in-perm" type="number" min="0" step="0.01" inputmode="decimal"></label>',
    '<label class="set-row" for="set-out-perm"><span>输出单价（美元 / 百万 token）</span>',
    '  <input id="set-out-perm" type="number" min="0" step="0.01" inputmode="decimal"></label>',
    '<div class="set-actions">',
    '  <button type="button" class="set-btn" id="set-test">测试连接</button>',
    '  <button type="button" class="set-btn set-primary" id="set-save">保存</button>',
    '  <button type="button" class="set-btn" id="set-close">关闭</button>',
    '</div>',
    '<p class="set-status" id="set-status"></p>',
    '<p class="set-error" id="set-error" hidden></p>',
  ].join('\n');
}

/**
 * 在面板里挂一个设置浮层。
 * @param {{root:HTMLElement, baseUrl:string, fetchImpl?:Function, onSaved?:Function, timeoutMs?:number}} opts
 */
export function createSettings({ root, baseUrl, fetchImpl = fetch, onSaved = () => {}, timeoutMs = 8000 } = {}) {
  const el = document.createElement('div');
  el.className = 'overlay';
  el.id = 'settings-overlay';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '设置');
  el.innerHTML = formHtml();
  root.appendChild(el);

  const $ = (id) => el.querySelector('#' + id);
  const notice = $('set-notice');
  const statusLine = $('set-status');
  const errorLine = $('set-error');
  const inputs = ['set-baseurl', 'set-apikey', 'set-model', 'set-interval', 'set-probe', 'set-proxy', 'set-in-perm', 'set-out-perm'].map($);
  const buttons = ['set-test', 'set-save'].map($);
  const closeBtn = $('set-close');
  const probeHint = $('set-probe-hint');
  let offline = false;      // 采集器不可达：表单只读，只留「关闭」
  let maskedKey = '';       // 上一次回填的脱敏值（没被改过就等于没动 key）
  let probeKnown = false;   // 是否真的读到了采集器的 probe 块（没读到就不编造数字）
  let probeInfo = null;     // 采集器给的 probe 块：{enabled, everyMs, probesPerDay, promptTokensEstimate, ...}

  /** 表单当前对应的探测口径（间隔可能刚被用户改过 → 成本提示要立刻跟着变）。 */
  function currentProbeInfo() {
    const base = probeInfo && typeof probeInfo === 'object' ? probeInfo : {};
    const every = Number(value('set-interval'));
    return {
      enabled: $('set-probe').checked,
      everyMs: Number.isFinite(every) && every > 0 ? every : base.everyMs,
      probeMaxTokens: base.probeMaxTokens,
      promptTokensEstimate: base.promptTokensEstimate,
    };
  }

  function updateProbeHint() {
    probeHint.textContent = probeKnown ? probeHintText(currentProbeInfo()) : PROBE_HINT_FALLBACK;
  }

  function setStatus(text) {
    statusLine.textContent = text || '';
  }

  function setError(text) {
    const msg = text ? String(text) : '';
    errorLine.textContent = msg;
    errorLine.hidden = msg === '';
  }

  function setBusy(busy, text) {
    for (const b of buttons) b.disabled = busy || offline;
    for (const i of inputs) i.disabled = !!offline;
    if (text !== undefined) setStatus(text);
  }

  function goOffline(message) {
    offline = true;
    notice.textContent = message || NO_COLLECTOR_HINT;
    notice.hidden = false;
    probeKnown = false;
    updateProbeHint();
    setBusy(false, '');
    for (const i of inputs) i.disabled = true;
    for (const b of buttons) b.disabled = true;
  }

  function value(id) {
    const node = $(id);
    return node ? node.value : '';
  }

  function fill(cfg) {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    $('set-baseurl').value = c.baseUrl || '';
    maskedKey = c.apiKey || '';
    $('set-apikey').value = maskedKey;            // 脱敏值：sk-***c3a3 / ****c3a3
    // 占位符同样显示脱敏值：把输入框清空后仍然看得出"配置里已经有一把 key"（真 key 永不进页面）
    $('set-apikey').placeholder = maskedKey || '留空 = 不改动';
    $('set-model').value = c.model || '';
    $('set-interval').value = Number.isFinite(Number(c.probeEveryMs)) ? String(c.probeEveryMs) : '';
    // probe 块是对象（{enabled,...}）；兼容老采集器把 probe 当布尔回的情况
    probeInfo = c.probe && typeof c.probe === 'object' ? c.probe : null;
    probeKnown = !!probeInfo;
    $('set-probe').checked = probeInfo ? probeInfo.enabled !== false : c.probe !== false;
    updateProbeHint();
    $('set-proxy').checked = c.proxy === true;
    const pricing = c.pricing && typeof c.pricing === 'object' ? c.pricing : {};
    $('set-in-perm').value = Number.isFinite(Number(pricing.inPerM)) ? String(pricing.inPerM) : '';
    $('set-out-perm').value = Number.isFinite(Number(pricing.outPerM)) ? String(pricing.outPerM) : '';
  }

  /**
   * 提交用的 apiKey：与回填的脱敏值一字不差 = 用户没动它 → 提交空串（明确表示不改动）。
   * 这样即便采集器只把「纯星号」当哨兵，也不会把真 key 覆盖成 sk-***xxxx。
   */
  function apiKeyForSubmit() {
    const v = value('set-apikey').trim();
    if (v === '') return '';
    if (maskedKey !== '' && v === maskedKey) return '';
    return v;
  }

  function fields() {
    return {
      baseUrl: value('set-baseurl'),
      apiKey: apiKeyForSubmit(),
      model: value('set-model'),
      probeEveryMs: value('set-interval'),
      probe: $('set-probe').checked,
      proxy: $('set-proxy').checked,
      inPerM: value('set-in-perm'),
      outPerM: value('set-out-perm'),
    };
  }

  function timeoutSignal(ms) {
    const t = Number.isFinite(ms) && ms > 0 ? ms : timeoutMs;
    return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(t) : undefined;
  }

  /** 一次 JSON 请求；HTTP 非 2xx 时把采集器的中文 message 抛出来。 */
  async function request(path, init, ms) {
    const res = await fetchImpl(baseUrl + path, { cache: 'no-store', ...init, signal: timeoutSignal(ms) });
    let json = null;
    try {
      json = await res.json();
    } catch { /* 非 JSON：下面按状态码兜底 */ }
    if (!res.ok) {
      // 采集器有两种错误形状：{message} / {error:{message}}——都取最里层那句中文
      const raw = json ? (json.message || json.error) : null;
      const message = typeof raw === 'string'
        ? raw
        : raw && typeof raw.message === 'string'
          ? raw.message
          : 'HTTP ' + res.status;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return json || {};
  }

  /**
   * 打开浮层：先显示，再去读配置（拖动/输入都不阻塞）。
   *
   * 读配置是本机回环，正常几毫秒就回来；但采集器没开时（尤其是 file:// 页面跨源请求
   * 被浏览器挂在半路），fetch 可能很久都不 settle——绝不能让浮层空着等：
   * 1.2 秒还没有结果就先给出「设置需要本机采集器」这句可操作提示，
   * 真配置回来后再覆盖掉它（活着的采集器几乎不可能慢过 1.2 秒）。
   */
  async function refresh() {
    setError('');
    offline = false;
    setBusy(true, '正在读取配置…');
    let settled = false;
    const grace = setTimeout(() => {
      if (!settled) goOffline(NO_COLLECTOR_HINT);
    }, 1200);
    try {
      const data = await request('/config', { method: 'GET' }, 1500);
      settled = true;
      clearTimeout(grace);
      offline = false;
      notice.hidden = true;
      const cfg = data.config || data;
      fill(cfg);
      const cfgPath = data.configPath || cfg.configPath || '';
      setBusy(false, cfgPath ? '配置文件：' + cfgPath : '');
    } catch (err) {
      settled = true;
      clearTimeout(grace);
      goOffline(NO_COLLECTOR_HINT);
      setStatus('');
      setError('读不到采集器配置：' + (err && err.message ? err.message : String(err)));
    }
  }

  async function open() {
    el.hidden = false;
    setError('');
    await refresh();
  }

  function close() {
    el.hidden = true;
    setError('');
    setStatus('');
  }

  async function runTest() {
    setError('');
    setBusy(true, '测试中…（一次最小流式请求）');
    try {
      const patch = buildConfigPatch(fields());
      const body = { baseUrl: patch.baseUrl, apiKey: apiKeyForSubmit(), model: patch.model };
      const out = await request('/config/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (out.ok) setStatus('连接正常：TTFT ' + Math.round(out.ttftMs) + 'ms · ' + Math.round(out.tokPerSec) + ' tok/s');
      else {
        setStatus('');
        setError('连接失败：' + (out.error || '未知错误'));
      }
    } catch (err) {
      setStatus('');
      setError('连接失败：' + (err && err.message ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setError('');
    setBusy(true, '保存中…（写回配置文件并热重启探测）');
    try {
      const out = await request('/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildConfigPatch(fields())),
      });
      fill(out.config || {});
      const suffix = out.saved === false ? '' : '（已写回配置文件）';
      const probe = out.probe;
      if (!probe) setStatus('已保存' + suffix);
      else if (probe.ok) setStatus('已保存' + suffix + ' · 探测正常 TTFT ' + Math.round(probe.ttftMs || 0) + 'ms');
      else setStatus('已保存' + suffix + ' · 探测失败：' + (probe.error || '未知错误'));
      if (out.saveError) setError(out.saveError);
      onSaved(out);
    } catch (err) {
      setStatus('');
      setError('保存失败：' + (err && err.message ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  }

  // 开关 / 间隔一改，成本提示立刻重算 —— 用户要看到的是"我现在这么配，一天要花多少"
  $('set-probe').addEventListener('change', updateProbeHint);
  $('set-interval').addEventListener('input', updateProbeHint);

  for (const b of buttons) {
    if (b.id === 'set-test') b.addEventListener('click', () => { void runTest(); });
    else b.addEventListener('click', () => { void save(); });
  }
  if (closeBtn) closeBtn.addEventListener('click', close);
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  const api = {
    el,
    open,
    close,
    refresh,
    toggle: () => (el.hidden ? open() : close()),
    isOpen: () => el.hidden === false,
    isOffline: () => offline,
    /** 页脚 ⏻ 的操作反馈：只写一行提示，不弹 alert、不改表单可用性 */
    showNotice: (text) => {
      const msg = text ? String(text) : '';
      notice.textContent = msg || NO_COLLECTOR_HINT;
      notice.hidden = msg === '';
    },
  };
  // 桌面壳（托盘「设置…」）通过这个钩子打开浮层，不必知道面板内部结构
  if (typeof window !== 'undefined') window.__tokmeterOpenSettings = () => { void open(); };
  return api;
}
