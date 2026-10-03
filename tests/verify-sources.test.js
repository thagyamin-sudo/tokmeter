/**
 * 对抗性验证：src/sources/vllm-metrics.js 与 src/sources/http.js
 *
 * 本文件只做独立验证：不修改 src/、不修改既有 tests/*。
 * 待验证的声明（实现者自称）：
 *   C1 任何输入都不抛异常
 *   C2 缺失或非有限指标逐字段回退 prev
 *   C3 连续 3 次失败 status 变 'stale'，第 5 次变 'error'
 *   C4 stop() 后不再发起请求
 *   C5 绝不产生 unhandled rejection
 *   C6 请求串行不重叠（同时在飞 <= 1）
 *
 * 标注约定：
 *   【缺陷】 断言写的是应然行为，当前实现不满足 —— 保留失败用例，不修改 src。
 *   【存疑】 无法断定是缺陷还是设计取舍，注释中给出理由；这类用例一般断言“实际行为”并附说明。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySnapshot } from '../src/store.js';
import { formatClock } from '../src/format.js';
import { parsePrometheus, toSnapshot } from '../src/sources/vllm-metrics.js';
import { createHttpSource, mapPayload } from '../src/sources/http.js';

const NOW = 1735689600000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 有界轮询：每次只等 1ms，条件成立立刻返回，绝不长时间 sleep。 */
async function waitFor(pred, budgetMs = 300) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(1);
  }
  return pred();
}

/**
 * 所有数据源都经这里创建，afterEach 统一 stop()：
 * 断言失败时若不 stop，1ms 轮询的定时器链会一直活着，node --test 会挂住不退出（实测踩过）。
 */
const liveSources = [];
function makeSource(opts) {
  const src = createHttpSource(opts);
  liveSources.push(src);
  return src;
}
test.afterEach(() => {
  for (const src of liveSources.splice(0)) {
    try { src.stop(); } catch { /* 清理失败不应掩盖用例本身的结论 */ }
  }
});

/** 全程收集未处理拒绝；每条用例断言自己时间窗内的增量必须为 0。 */
const unhandled = [];
const onUnhandled = (e) => unhandled.push(e);
process.on('unhandledRejection', onUnhandled);

// ─────────────────────── 探针自检（防止 C5 断言空洞） ───────────────────────

test('C0 探针自检：未处理拒绝探针已挂载（证明本文件的 C5 断言不是空洞的）', () => {
  // node:test 自己会挂一个 unhandledRejection 监听器，本文件再挂一个本地探针（两者共存，实测 >= 2）。
  assert.ok(process.listenerCount('unhandledRejection') >= 2,
    'node:test 与本地探针都应挂载监听器，实际 ' + process.listenerCount('unhandledRejection'));
  assert.equal(typeof onUnhandled, 'function');
  // 说明（实测记录）：不能在这里 emit 合成事件做阳性对照 —— node:test 会把任何 unhandledRejection 事件
  // （包括 process.emit 出来的合成事件）归因到当前用例并判红。因此阳性证据取自 H7 的真实事件：
  // H7 中探针观测到 6 次 'async consumer bug'，node:test 也独立把该用例判为失败。
});

/** 构造一个只回固定 JSON 的 fetchImpl。 */
const okFetch = (json, onCall) => async () => {
  if (onCall) onCall();
  return { ok: true, status: 200, json: async () => json };
};

// ───────────────────────────── parsePrometheus ─────────────────────────────

test('P1 parsePrometheus：非字符串输入一律安全返回 {}（C1）', () => {
  const inputs = [
    undefined, null, 0, -1, 3.14, {}, [], { toString: () => 'vllm:x 1' },
    Buffer.from('vllm:x 1'), new String('vllm:x 1'), () => 'vllm:x 1', Symbol('vllm:x 1'), true,
  ];
  for (const input of inputs) {
    let out;
    assert.doesNotThrow(() => { out = parsePrometheus(input); }, 'input = ' + String(input));
    assert.deepEqual(out, {}, 'input = ' + String(input));
  }
  assert.deepEqual(parsePrometheus(), {}, '不给参数也必须是 {}');
  // 【存疑】new String('vllm:x 1') 是 String 包装对象，typeof 为 'object'，被当成非文本整体丢弃；
  // 在“任何输入都不抛异常”的前提下它至少不抛，属可接受的不宽松判等。
});

test('P2 parsePrometheus：CRLF、行尾时间戳、制表符、纯注释与空白（C1）', () => {
  assert.deepEqual(parsePrometheus('vllm:a 1\r\nvllm:b 2.5\r\n# HELP x\r\n\r\n'), { 'vllm:a': 1, 'vllm:b': 2.5 });
  assert.deepEqual(parsePrometheus('  vllm:a\t3  '), { 'vllm:a': 3 }, '制表符与首尾空白');
  assert.deepEqual(parsePrometheus('vllm:a 4 1699999999999'), { 'vllm:a': 4 }, '只取数值列，忽略时间戳');
  assert.deepEqual(parsePrometheus('# HELP a b\n# TYPE a gauge\n#\n   # 缩进注释\n'), {}, '只有注释');
  assert.deepEqual(parsePrometheus('\n \t \n'), {}, '只有空白行');
  assert.deepEqual(parsePrometheus(''), {}, '空串');
  // 【存疑】裸 CR（经典 Mac 行尾）不是分隔符：整份文本成为一行，'.' 不匹配 \r 导致整行失效，
  // 结果是「全部丢弃」而不是「部分解析」。真实 vLLM 用 \n，风险很低。
  assert.deepEqual(parsePrometheus('vllm:a 1\rvllm:b 2'), {});
});

test('P3 parsePrometheus：Inf/NaN/科学计数法/负数/十六进制/脏尾（C1、C2）', () => {
  assert.deepEqual(parsePrometheus('m 1e3'), { m: 1000 });
  assert.deepEqual(parsePrometheus('m -5'), { m: -5 });
  assert.deepEqual(parsePrometheus('m +5'), { m: 5 });
  assert.deepEqual(parsePrometheus('m .5'), { m: 0.5 });
  assert.deepEqual(parsePrometheus('m 5.'), { m: 5 });
  assert.deepEqual(parsePrometheus('m +Inf\nn -Inf\nk NaN\nq nan\nw Infinity'), {}, '非有限值全部丢弃');
  assert.deepEqual(parsePrometheus('m 5abc'), {}, '尾部垃圾 → NaN → 丢弃');
  assert.deepEqual(parsePrometheus('m 1_000'), {}, '数字分隔符不是 Prometheus 语法');
  // 【存疑】Number() 会接受 0x/0b 字面量，Prometheus 文本格式并不允许；属于宽松解析，无安全后果。
  assert.deepEqual(parsePrometheus('m 0x10'), { m: 16 });
  assert.deepEqual(parsePrometheus('m 0b101'), { m: 5 });
});

test('P4 parsePrometheus：标签、转义引号、同名重复、标签内 } 与重复 # TYPE', () => {
  assert.deepEqual(parsePrometheus('m{a="b\\"c"} 5'), { m: 5 }, '标签值里的转义引号不影响取值');
  assert.deepEqual(parsePrometheus('# TYPE m gauge\n# TYPE m counter\nm 1'), { m: 1 }, '重复 # TYPE 只是注释');
  assert.deepEqual(parsePrometheus('m{a="b"} 5 1699999999999 extra'), { m: 5 }, '尾列忽略');
  // 【存疑】同名指标（多标签维度/多模型）后者覆盖前者，既不累加也不分行保存。
  // vLLM 多模型时 vllm:num_requests_running{model_name="A"|"B"} 会互相覆盖，面板只显示最后一个；
  // 单模型部署下无害，属设计取舍但值得写明。
  assert.deepEqual(parsePrometheus('m{a="1"} 1\nm{a="2"} 2'), { m: 2 });
  // 【存疑】Prometheus 允许标签值里出现 }（如 model_name="a}b"），此时 [^}]* 提前截断导致整行被丢；
  // 真实模型名含 } 的概率极低，但这是词法层面的真实缺口。
  assert.deepEqual(parsePrometheus('m{a="1}2"} 5'), {});
  // 名字与标签集之间多一个空格 → 值列变成 '{a="b"}' → 丢弃（Prometheus 规范不允许这种写法）
  assert.deepEqual(parsePrometheus('m {a="b"} 5'), {});
});

test('P5 parsePrometheus：超长行不抛异常、不灾难性回溯（C1）', () => {
  const junk = 'z'.repeat(200000);
  const t0 = Date.now();
  let out;
  assert.doesNotThrow(() => {
    out = parsePrometheus(junk + '\nvllm:ok 3\n' + '9'.repeat(100000) + ' ' + junk);
  });
  assert.deepEqual(out, { 'vllm:ok': 3 }, '超长垃圾行不得影响正常行');
  assert.ok(Date.now() - t0 < 2000, '解析 30 万字符不应出现灾难性回溯（实测 < 10ms）');
});

// ─────────────────────────────── toSnapshot ────────────────────────────────

test('S1 toSnapshot：prev 为 null/undefined/空对象/非对象时形状完整且核心数值有限（C1、C2）', () => {
  const shape = Object.keys(emptySnapshot(NOW)).sort();
  for (const prev of [null, undefined, {}, 'x', 42, [], true, 0]) {
    const s = toSnapshot({}, prev, NOW);
    const label = 'prev = ' + String(prev);
    assert.equal(s.status, 'live', label);
    assert.equal(s.updatedAt, NOW, label);
    assert.deepEqual(Object.keys(s).sort(), shape, label + ' 形状必须与 emptySnapshot 一致');
    for (const k of ['model', 'output', 'requests', 'input', 'kvCache', 'mtp', 'memory', 'gpu']) {
      assert.ok(s[k] && typeof s[k] === 'object' && !Array.isArray(s[k]), label + ' 分组 ' + k);
    }
    assert.ok(Number.isFinite(s.requests.active) && Number.isFinite(s.requests.queued), label);
    // 契约更新（评审 C2）：无从得知的量必须是 NaN（界面显示 --），不是假 0。
    // 这里只要求它们是 number（NaN 合法），绝不能是 undefined / 字符串。
    for (const v of [s.kvCache.usage, s.kvCache.hitRate, s.output.tokPerSec]) {
      assert.equal(typeof v, 'number', label + ' 未知量必须是 number（NaN 表示未知）');
      assert.equal(v, v, label + ' 不得是 NaN 以外的怪值');
    }
  }
});

test('S2 toSnapshot：metrics 为 null/数组/字符串/数字/空对象时全字段回退 prev（C2）', () => {
  const prev = emptySnapshot(NOW);
  prev.requests = { active: 5, queued: 2, capacity: 12 };
  prev.output = { tokPerSec: 111, history: [111] };
  prev.kvCache = { usage: 0.4, hitRate: 0.9, headroom: '余量一般' };

  for (const m of [null, undefined, [], 'vllm:num_requests_running 9', 7, true, new Map(), () => {}]) {
    const s = toSnapshot(m, prev, NOW);
    const label = 'metrics = ' + Object.prototype.toString.call(m);
    assert.equal(s.requests.active, 5, label);
    assert.equal(s.requests.queued, 2, label);
    assert.equal(s.output.tokPerSec, 111, label);
    assert.equal(s.kvCache.usage, 0.4, label);
    assert.equal(s.kvCache.hitRate, 0.9, label);
    // 回退帧同样会往曲线里推一个样本（与实现一致：pushRing 用回退后的 tokPerSec）
    assert.deepEqual(s.output.history, [111, 111], label);
  }

  const s2 = toSnapshot({
    'vllm:num_requests_running': '9',            // 字符串不是数值
    'vllm:num_requests_waiting': NaN,
    'vllm:gpu_cache_usage_perc': Infinity,
    'vllm:gpu_prefix_cache_hit_rate': '0.5',
    'vllm:avg_generation_throughput_toks_per_s': 0,   // 有限的 0 必须写入
  }, prev, NOW);
  assert.equal(s2.requests.active, 5, '字符串数值回退');
  assert.equal(s2.requests.queued, 2, 'NaN 回退');
  assert.equal(s2.kvCache.usage, 0.4, 'Infinity 回退');
  assert.equal(s2.kvCache.hitRate, 0.9, '字符串数值回退');
  assert.equal(s2.output.tokPerSec, 0, '有限的 0 不是缺失');
});

test('S3 toSnapshot：history 满 60 再 push 丢最旧；prev 缺 output / history 非数组都能兜底（C2）', () => {
  const full = { ...emptySnapshot(NOW), output: { tokPerSec: 1, history: Array.from({ length: 60 }, (_, i) => i) } };
  const s = toSnapshot({ 'vllm:avg_generation_throughput_toks_per_s': 999 }, full, NOW);
  assert.equal(s.output.history.length, 60, '窗口不得溢出');
  assert.equal(s.output.history.at(-1), 999);
  assert.equal(s.output.history[0], 1, '最旧的 0 被挤掉');
  assert.notEqual(s.output.history, full.output.history, '必须返回新数组');
  assert.deepEqual(full.output.history.slice(0, 3), [0, 1, 2], 'prev 不得被就地修改');

  const noOutput = { ...emptySnapshot(NOW) };
  delete noOutput.output;
  const s2 = toSnapshot({ 'vllm:avg_generation_throughput_toks_per_s': 42 }, noOutput, NOW);
  assert.equal(s2.output.tokPerSec, 42);
  assert.deepEqual(s2.output.history, [42], 'prev 缺 output 时用空白快照兜底');

  const weird = { ...emptySnapshot(NOW), output: { tokPerSec: 7, history: 'nope' } };
  assert.deepEqual(toSnapshot({}, weird, NOW).output.history, [7], 'history 非数组时重建');
  const nullGroup = { ...emptySnapshot(NOW), output: null };
  // 契约更新（评审 C2）：速率未知时不往曲线塞点，窗口保持不变
  assert.deepEqual(toSnapshot({}, nullGroup, NOW).output.history, [], 'output 为 null 且速率未知时，曲线保持空');

  let chain = { ...emptySnapshot(NOW), output: { tokPerSec: 0, history: [] } };
  for (let i = 0; i < 100; i++) chain = toSnapshot({ 'vllm:avg_generation_throughput_toks_per_s': i }, chain, NOW + i);
  assert.equal(chain.output.history.length, 60);
  assert.equal(chain.output.history[0], 40);
  assert.equal(chain.output.history.at(-1), 99);
});

test('S4 toSnapshot：冻结的 prev 不报错、prev 不被就地修改；未覆盖分组的数组仍是共享引用（存疑）', () => {
  const gpuHistory = [1, 2, 3];
  const base = emptySnapshot(NOW);
  const prev = Object.freeze({
    ...base,
    model: Object.freeze({ ...base.model }),
    gpu: Object.freeze({ utilization: 0.5, state: '空闲', history: gpuHistory }),
  });
  const before = structuredClone(prev);

  let s;
  assert.doesNotThrow(() => { s = toSnapshot({ 'vllm:num_requests_running': 3 }, prev, NOW); }, '冻结的 prev 不得报错');
  assert.equal(s.requests.active, 3);
  assert.equal(s.model.name, prev.model.name);
  assert.deepEqual(prev, before, 'prev 不得被就地修改');
  assert.notEqual(s.model, prev.model, '分组对象是重新构造的');

  // 【存疑·低危】vllmBase 只对 8 个分组做浅展开：未覆盖分组里的数组（gpu.history）与 prev 共享同一引用，
  // 而 output.history 因为走了 pushRing 反而是新数组 —— 隔离策略不一致。当前渲染层只读，暂无实际后果。
  assert.equal(s.gpu.history, gpuHistory, '这里断言的是实际行为：gpu.history 与 prev 共享引用');

  // 【存疑·低危】prev 自身带 NaN 时会被原样带进新快照（"回退 prev"本身是符合声明的，是 prev 违反了有限数契约）。
  // 数据源自身不会产出这种 prev（emptySnapshot 全为有限数，toSnapshot 只写入有限数），因此仅作记录。
  const badPrev = emptySnapshot(NOW);
  badPrev.requests = { active: NaN, queued: 0, capacity: 12 };
  const s2 = toSnapshot({}, badPrev, NOW);
  assert.ok(Number.isNaN(s2.requests.active), '这里断言的是实际行为：NaN 从 prev 传播到新快照');
});

test('S5 toSnapshot：getter 抛异常的 metrics / prev 会让 toSnapshot 抛出（【存疑】C1 的字面冲突）', () => {
  const prev = emptySnapshot(NOW);
  const hostileMetrics = { get 'vllm:num_requests_running'() { throw new Error('boom'); } };
  const hostilePrev = Object.defineProperty({ ...emptySnapshot(NOW) }, 'requests', {
    enumerable: true, configurable: true, get() { throw new Error('prev boom'); },
  });

  const observed = [];
  try { toSnapshot(hostileMetrics, prev, NOW); observed.push('metrics:ok'); }
  catch (e) { observed.push('metrics:THROW(' + e.message + ')'); }
  try { toSnapshot({}, hostilePrev, NOW); observed.push('prev:ok'); }
  catch (e) { observed.push('prev:THROW(' + e.message + ')'); }

  // 对照：null 原型对象、含 Symbol 键的对象、冻结对象都必须正常
  const nul = Object.create(null);
  nul['vllm:num_requests_running'] = 4;
  assert.equal(toSnapshot(nul, prev, NOW).requests.active, 4, 'null 原型对象必须正常');

  // 【存疑】真值表断言：两者实际都会抛（getter/Proxy 陷阱），与“任何输入都不抛异常”的字面声明冲突。
  // 理由：这不是 Prometheus 文本解析出的普通对象，属于敌意输入；但 toSnapshot 直接属性读取 + 扩展运算符，
  // 确实没有任何 try/catch 保护。倾向“低频、可接受的实现取舍”，故标存疑而非缺陷。
  assert.deepEqual(observed, ['metrics:ok', 'prev:ok'], 'getter 抛异常的输入不应让 toSnapshot 抛出');
});

// ─────────────────────────────── mapPayload ────────────────────────────────

test('M1 mapPayload：json 为 null/undefined/数组/字符串/数字时安全返回，且状态恒为 live（C1）', () => {
  const prev = emptySnapshot(NOW);
  prev.requests = { active: 8, queued: 1, capacity: 12 };
  prev.status = 'error';                       // 上一帧是降级态
  for (const json of [null, undefined, [], [1, 2], 'payload', 42, true, () => ({})]) {
    const out = mapPayload(json, prev);
    const label = 'json = ' + String(json);
    assert.notEqual(out, prev, label + ' 必须返回新对象');
    assert.equal(out.status, 'live', label + ' 状态恒由数据源掌握');
    assert.equal(out.requests.active, 8, label);
    assert.equal(out.model.name, prev.model.name, label);
  }
  assert.deepEqual(mapPayload(null, null), { ...emptySnapshot(0), status: 'live' }, 'prev 缺失时用空白快照兜底');
  assert.deepEqual(mapPayload(), { ...emptySnapshot(0), status: 'live' }, '不给参数也不得抛');
});

test('M2 mapPayload：组内部分覆盖、数组整体替换、组被标量/数组/null 覆盖时整体忽略', () => {
  const prev = emptySnapshot(NOW);
  prev.requests = { active: 8, queued: 1, capacity: 12 };
  prev.output = { tokPerSec: 111, history: [1, 2, 3] };
  prev.clock = '08:00:00';

  const next = mapPayload({
    requests: { active: 3 },                  // 只给一个字段
    output: { history: [9] },                 // 数组整体替换而非追加
    model: 'Qwen',                            // 【存疑】标量覆盖分组 → 静默忽略
    gpu: [1, 2],                              // 【存疑】数组覆盖分组 → 静默忽略
    kvCache: null,                            // null 覆盖分组 → 静默忽略
    input: { tokPerSec: NaN, prefillAvgMs: 5 },
    clock: 12345,                             // 非字符串 → 忽略
    updatedAt: NaN,                           // 非有限 → 回退 prev
  }, prev);

  assert.equal(next.requests.active, 3);
  assert.equal(next.requests.queued, 1, '组内未给的字段沿用 prev');
  assert.equal(next.requests.capacity, 12);
  assert.deepEqual(next.output.history, [9], '数组整体替换');
  assert.equal(next.output.tokPerSec, 111, '组内未给的字段沿用 prev');
  assert.equal(typeof next.model, 'object');
  assert.equal(next.model.name, prev.model.name, '实际行为：标量覆盖分组被忽略');
  assert.deepEqual(next.gpu, prev.gpu, '实际行为：数组覆盖分组被忽略');
  assert.deepEqual(next.kvCache, prev.kvCache, '实际行为：null 覆盖分组被忽略');
  assert.equal(next.input.tokPerSec, prev.input.tokPerSec, 'NaN 不写入');
  assert.equal(next.input.prefillAvgMs, 5);
  assert.equal(next.clock, prev.clock, '非字符串 clock 被忽略');
  assert.equal(next.updatedAt, prev.updatedAt, '非有限 updatedAt 回退 prev');
  assert.equal(next.status, 'live', '负载里的 status 永远无效');
});

test('M3 mapPayload：返回值与入参负载/prev 的引用隔离（【缺陷·低危】顶层数组与组内嵌套对象仍共享）', () => {
  const prev = emptySnapshot(NOW);
  const payload = {
    requests: { active: 3, meta: { note: 'x' } },
    output: { history: [1, 2, 3] },
    tags: ['a', 'b'],
  };
  const next = mapPayload(payload, prev);
  const next2 = mapPayload({ requests: { active: 1 } }, prev);

  // 一次断言给出完整真值表，避免第一条失败就掩盖后面的结论。
  const shared = {
    组内数组_与payload共享: next.output.history === payload.output.history,
    顶层未知数组_与payload共享: next.tags === payload.tags,
    组内嵌套对象_与payload共享: next.requests.meta === payload.requests.meta,
    未覆盖分组_与prev共享: next2.model === prev.model,
  };
  // 期望：全部为 false（httpMergeGroup 的注释只承诺“数组浅拷贝，避免与负载共享引用”）；
  // 实际：组内数组已复制，但顶层未知键数组、组内嵌套对象、以及负载未出现的分组对象仍然共享引用。
  // 判为【缺陷·低危】：协议里没有未知顶层键，嵌套对象也不是当前快照契约的一部分，所以线上暂时无害；
  // 但 store 长期持有 Snapshot，任何就地修改都会串帧，属于潜在坑。
  assert.deepEqual(shared, {
    组内数组_与payload共享: false,
    顶层未知数组_与payload共享: false,
    组内嵌套对象_与payload共享: false,
    未覆盖分组_与prev共享: false,
  }, '返回值不得与入参负载/prev 共享可变引用');

  next.tags.push('c');
  next.requests.meta.note = 'changed';
  assert.deepEqual(payload.tags, ['a', 'b'], '改返回值不得影响入参');
  assert.equal(payload.requests.meta.note, 'x', '改返回值不得影响入参');
});

test('M4 mapPayload：不修改 payload 与 prev；Infinity/undefined/null 被过滤（C2）', () => {
  const prev = emptySnapshot(NOW);
  const prevCopy = structuredClone(prev);
  const payload = { requests: { active: 3, queued: Infinity }, output: { tokPerSec: 250, history: [1] }, status: 'error', updatedAt: NOW + 5 };
  const payloadCopy = structuredClone(payload);

  const next = mapPayload(payload, prev);
  assert.deepEqual(prev, prevCopy, 'prev 不得被就地修改');
  assert.deepEqual(payload, payloadCopy, 'payload 不得被就地修改');
  assert.equal(next.status, 'live');
  assert.equal(next.requests.queued, prev.requests.queued, 'Infinity 不写入');
  assert.equal(next.requests.active, 3);
  assert.equal(next.output.tokPerSec, 250);
  assert.equal(next.updatedAt, NOW + 5, '有限的 updatedAt 会被采纳（createHttpSource 随后会覆写成本地接收时刻）');

  const sparse = mapPayload({ requests: { active: undefined, queued: null } }, prev);
  assert.equal(sparse.requests.active, prev.requests.active, 'undefined 不写入');
  assert.equal(sparse.requests.queued, prev.requests.queued, 'null 不写入');
});

// ───────────────────────────── createHttpSource ────────────────────────────

test('H1 createHttpSource：同步抛错/rejected/非 2xx/非 JSON 文本/JSON 数组/空响应 全部被吞掉（C1、C3、C5）', async () => {
  const local = [];
  const onRej = (e) => local.push(e);
  process.on('unhandledRejection', onRej);
  const modes = [
    ['sync-throw', () => { throw new Error('boom'); }],
    ['rejected-async', async () => { throw new Error('ECONNREFUSED'); }],
    ['rejected-promise', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['http-500', async () => ({ ok: false, status: 500, json: async () => ({}) })],
    ['http-302', async () => ({ ok: false, status: 302, json: async () => ({}) })],
    ['html-text', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } })],
    ['json-array', async () => ({ ok: true, status: 200, json: async () => [1, 2, 3] })],
    ['json-null', async () => ({ ok: true, status: 200, json: async () => null })],
    ['json-string', async () => ({ ok: true, status: 200, json: async () => 'nope' })],
    ['no-json-method', async () => ({ status: 200 })],
    ['empty-object', async () => ({})],
    ['undefined', async () => undefined],
    ['rejected-body', async () => ({ ok: true, status: 200, json: () => Promise.reject(new Error('body error')) })],
  ];
  try {
    for (const [name, impl] of modes) {
      let calls = 0;
      const src = makeSource({
        endpoint: 'http://127.0.0.1:1/metrics', intervalMs: 1, now: () => NOW,
        fetchImpl: (...a) => { calls += 1; return impl(...a); },
      });
      const samples = [];
      const before = local.length;
      src.start((s) => samples.push(s));
      const enough = await waitFor(() => calls >= 5, 500);
      await sleep(2);
      src.stop();
      assert.ok(enough, name + '：应在预算内完成 5 次请求');
      assert.equal(src.status, 'error', name + '：连续 5 次失败必须进入 error');
      assert.deepEqual(samples.map((s) => s.status).slice(0, 5), ['live', 'live', 'stale', 'stale', 'error'], name);
      assert.deepEqual(local.slice(before).map((e) => String(e && e.message)), [], name + '：不得产生未处理拒绝');
    }
  } finally {
    process.off('unhandledRejection', onRej);
  }
  assert.deepEqual(local, []);
});

test('H2 createHttpSource：3 次 stale、5 次 error、恢复后回到 live 且失败计数复位（C3）', async () => {
  let mode = 'fail';
  let calls = 0;
  const src = makeSource({
    endpoint: 'http://x', intervalMs: 1, now: () => NOW,
    fetchImpl: async () => {
      calls += 1;
      if (mode === 'fail') { await sleep(1); throw new Error('down'); }
      return { ok: true, status: 200, json: async () => ({ requests: { active: 7 }, output: { tokPerSec: 12 } }) };
    },
  });
  const samples = [];
  src.start((s) => samples.push(s));
  try {
    assert.ok(await waitFor(() => calls >= 5 && samples.length >= 5, 400), '应在预算内完成 5 次失败');
    assert.equal(src.status, 'error');
    assert.deepEqual(samples.slice(0, 5).map((s) => s.status), ['live', 'live', 'stale', 'stale', 'error']);

    mode = 'ok';
    assert.ok(await waitFor(() => src.status === 'live' && samples.at(-1).status === 'live', 400), '恢复成功后必须回到 live');
    assert.equal(samples.at(-1).requests.active, 7);
    assert.equal(samples.at(-1).output.tokPerSec, 12);

    const before = samples.length;
    mode = 'fail';
    assert.ok(await waitFor(() => samples.length >= before + 2, 400), '恢复后应能再次上报失败帧');
    assert.deepEqual(samples.slice(before, before + 2).map((s) => s.status), ['live', 'live'], '失败计数必须清零，前两次失败仍是 live');
    assert.equal(src.status, 'live');
  } finally {
    src.stop();
  }
});

test('H3 createHttpSource：stop() 后不再请求、不再上报；但迟到回包仍会改写 status（【缺陷·低危】C4）', async () => {
  let calls = 0;
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const src = makeSource({
    endpoint: 'http://x', intervalMs: 1, now: () => NOW,
    fetchImpl: async () => { calls += 1; return gate; },
  });
  const samples = [];
  src.start((s) => samples.push(s));
  assert.ok(await waitFor(() => calls >= 1, 200), 'start 应立即发起第一次请求');
  src.stop();
  const callsAtStop = calls;
  const statusAtStop = src.status;

  release(Promise.reject(new Error('late failure')));   // 在途请求迟到失败
  await sleep(15);

  assert.equal(calls, callsAtStop, 'stop 后不得再发起请求');
  assert.equal(samples.length, 0, '在途回包不得触发 onSample');
  assert.doesNotThrow(() => src.stop(), 'stop 必须幂等');
  // 【缺陷·低危】httpAttempt 在 runId 守卫之前就改了 failures/status：已停止的数据源状态会被死 run 的回包改写
  // （connecting → live）。虽然不再“上报”，但 status 是公开可读的观测面，"stop 后不再变化"更符合直觉。
  assert.equal(src.status, statusAtStop, 'stop 后数据源状态不得再被在途回包改写');
});

test('H4 createHttpSource：同时在飞请求恒为 1；start() 两次不重复轮询（C6）', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const src = makeSource({
    endpoint: 'http://x', intervalMs: 1, now: () => NOW,
    fetchImpl: async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(2);
      inFlight -= 1;
      return { ok: true, status: 200, json: async () => ({ requests: { active: calls } }) };
    },
  });
  const a = [];
  const b = [];
  src.start((s) => a.push(s));
  // 用「等到第 6 帧」代替固定 sleep 窗口：Windows 的 setTimeout 粒度约 15ms，固定 40ms 窗口并不稳定
  assert.ok(await waitFor(() => a.length >= 6, 800), 'start 后应持续上报，实际 ' + a.length + ' 帧');
  src.start((s) => b.push(s));            // 运行中的第二次 start
  await waitFor(() => calls >= 7, 400);
  src.stop();
  const callsAtStop = calls;
  await sleep(20);

  assert.equal(calls, callsAtStop, 'stop 后不得再请求');
  assert.equal(maxInFlight, 1, '同时在飞请求不得超过 1（实际峰值 ' + maxInFlight + '）');
  assert.ok(calls >= 6, 'intervalMs=1 时应持续多次请求，实际 ' + calls);
  assert.ok(a.length >= 6 && a.length <= calls, '首个回调应持续收到样本，实际 ' + a.length + ' 帧 / ' + calls + ' 次请求');
  // 【存疑】第二次 start() 被静默忽略：既不起第二条轮询（好），也不替换回调（调用方可能期望换回调）。
  // 由于没有别的「换回调」途径，运行中想换回调必须先 stop()，属于 API 上的小坑。
  assert.equal(b.length, 0, '实际行为：运行中的第二次 start() 不会替换回调');
});

test('H5 createHttpSource：陈旧 run 的迟到失败污染新 run 的失败计数（【缺陷】C4 的延伸）', async () => {
  let calls = 0;
  let release = null;
  let conc = 0;
  let maxConc = 0;
  const gate = new Promise((r) => { release = r; });
  const src = makeSource({
    endpoint: 'http://x', intervalMs: 1, now: () => NOW,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return gate;              // run1 的请求挂住
      conc += 1;
      maxConc = Math.max(maxConc, conc);
      try { await sleep(1); throw new Error('ECONNREFUSED'); } finally { conc -= 1; }
    },
  });
  src.start(() => {});
  assert.ok(await waitFor(() => calls >= 1, 200));
  src.stop();
  const run2 = [];
  src.start((s) => run2.push(s.status));         // run2：一个新数据源生命周期
  await sleep(6);
  // 【存疑·低危】inFlight 是跨 run 共享的单一标志，所以死 run 的挂起请求会把新 run 卡住（此处 6ms 内 0 次新请求，
  // 且没有任何超时/取消机制）。它保证了 C6 的串行，但代价是 stop()+start() 无法从挂起请求中恢复。
  assert.equal(calls, 1, '实际行为：新 run 被死 run 的在途请求挡住，直到它落地');
  assert.equal(src.status, 'connecting', '此时还没有任何一次 run2 自己的结果');

  release(Promise.reject(new Error('stale failure')));   // 死 run 的迟到失败
  assert.ok(await waitFor(() => run2.length >= 3, 400), 'run2 应至少上报 3 帧，实际 ' + run2.length);
  assert.equal(maxConc, 1, '串行保证仍然成立');
  src.stop();

  // 【缺陷】死 run 的 catch 在 runId 守卫之前执行 failures += 1，于是 run2 的失败计数从 1 起步：
  // 它自己第 2 次失败就被判成 stale（应为 live），第 5 次失败就会提前进入 error。
  assert.deepEqual(run2.slice(0, 3), ['live', 'live', 'stale'], '死 run 的迟到失败不得污染新 run 的失败计数');
});

test('H6 createHttpSource：onSample 同步抛异常不打断轮询、不产生未处理拒绝，但每请求会多上报一帧（【缺陷·低危】）', async () => {
  const before = unhandled.length;
  let calls = 0;
  const gates = [];                     // 手动放行请求，让「完成了几个请求」完全可控，不依赖定时器
  const delivered = [];
  const src = makeSource({
    endpoint: 'http://x', intervalMs: 1, now: () => NOW,
    fetchImpl: () => {
      calls += 1;
      return new Promise((resolve) => {
        gates.push(() => resolve({ ok: true, status: 200, json: async () => ({ requests: { active: 1 } }) }));
      });
    },
  });
  src.start((s) => { delivered.push(s.status); throw new Error('consumer bug'); });
  assert.ok(await waitFor(() => gates.length >= 1, 300), 'start 后应立即发起请求');
  gates.shift()();                      // 放行唯一一次请求
  await new Promise((r) => setImmediate(r));   // 冲干微任务：走完 成功 → onSample 抛 → catch → 降级帧 → onSample 再抛
  const callsAtSample = calls;
  const deliveredAtSample = delivered.length;
  src.stop();
  await sleep(10);

  assert.equal(calls, callsAtSample, '消费者抛异常不得让轮询继续堆请求');
  assert.equal(callsAtSample, 1, '本次只放行了 1 个请求，实际 ' + callsAtSample);
  assert.deepEqual(unhandled.slice(before).map((e) => String(e && e.message)), [], '不得产生未处理拒绝');
  // 【缺陷·低危】onSample 在 try 内抛出会被当成「传输失败」：catch 里 failures += 1 并再触发一次 httpEmit，
  // 于是 1 次成功请求让消费端收到 2 帧；第 2 帧是把消费者异常错误归因为数据源故障，退避也随之被拉长。
  // 消费者自身有 bug 是前提，但数据源把消费端异常计入传输失败，属于错误归因。
  assert.equal(deliveredAtSample, 1, '每次成功只应上报一帧，实际 ' + deliveredAtSample + ' 帧');
});

test('H7 createHttpSource：onSample 返回 rejected Promise 会产生未处理拒绝（【存疑】C5 的字面冲突）', async () => {
  const before = unhandled.length;
  let calls = 0;
  const src = makeSource({
    endpoint: 'http://x', intervalMs: 1, now: () => NOW,
    fetchImpl: async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ requests: { active: calls } }) }; },
  });
  src.start(async () => { throw new Error('async consumer bug'); });
  await waitFor(() => calls >= 3, 300);
  await sleep(20);
  src.stop();
  await sleep(10);

  const leaked = unhandled.slice(before).map((e) => String(e && e.message));
  unhandled.length = before;                     // 清掉自己的噪声，避免污染后续用例
  // 【存疑】消费端契约里 onSample 是同步 sink；async 回调的 rejection 属于消费端问题。
  // 结论保鲜说明：在 src/sources/http.js 于 17:34 加入 httpEmit 的 try/catch + ret.then(undefined, () => {})
  // 之前，本用例是红色的（实测泄漏 6 次未处理拒绝）；现在它是这条修复的回归守卫。
  // 若把 C5 读成「数据源绝不冒未处理拒绝（含消费端返回的 rejected Promise）」，这条断言就是它的判据。
  assert.deepEqual(leaked, [], '数据源未兜底：观测到 ' + leaked.length + ' 次未处理拒绝 '
    + JSON.stringify(leaked) + '（node:test 也会把这段异步活动判为用例失败）');
});

test('H8 createHttpSource：intervalMs 非法值回退 1000ms；0 被接受成紧循环（【存疑】）', async () => {
  for (const bad of [-1, 'abc', NaN, null, Infinity]) {
    let calls = 0;
    const src = makeSource({
      endpoint: 'http://x', intervalMs: bad, now: () => NOW,
      fetchImpl: okFetch({ requests: { active: 1 } }, () => { calls += 1; }),
    });
    src.start(() => {});
    await waitFor(() => calls >= 1, 100);
    await sleep(20);
    src.stop();
    assert.equal(calls, 1, 'intervalMs=' + String(bad) + ' 应回退到 1000ms');
  }
  // 【存疑·低危】intervalMs: 0 通过校验（>= 0），退避也是 0，形成 setTimeout(0) 紧循环，CPU 会被拉满；
  // 是否要设下限（例如 >= 50ms）属于产品取舍，但值得提醒。
  let calls0 = 0;
  const s0 = makeSource({
    endpoint: 'http://x', intervalMs: 0, now: () => NOW,
    fetchImpl: okFetch({}, () => { calls0 += 1; }),
  });
  s0.start(() => {});
  await waitFor(() => calls0 >= 5, 100);
  s0.stop();
  assert.ok(calls0 >= 5, '实际行为：intervalMs=0 被接受并形成紧循环，实际请求 ' + calls0 + ' 次');
});

test('H9 createHttpSource：缺省/非法 fetchImpl 与非法 now 的兜底（【存疑】静默回退）', async () => {
  const realFetch = globalThis.fetch;
  // 缺省 fetchImpl → 用全局 fetch
  let usedDefault = 0;
  globalThis.fetch = async () => { usedDefault += 1; return { ok: true, status: 200, json: async () => ({ requests: { active: 2 } }) }; };
  try {
    const sd = makeSource({ endpoint: 'http://x', intervalMs: 1, now: () => NOW });
    sd.start(() => {});
    assert.ok(await waitFor(() => usedDefault >= 1, 100), '缺省 fetchImpl 应使用全局 fetch');
    sd.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  // 【存疑】fetchImpl 非函数 → 静默改用全局 fetch（而不是快速失败/报错），可能把生产请求发到真实网络。
  let usedFallback = 0;
  globalThis.fetch = async () => { usedFallback += 1; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const sx = makeSource({ endpoint: 'http://x', intervalMs: 1, fetchImpl: 'not-a-function', now: () => NOW });
    sx.start(() => {});
    assert.ok(await waitFor(() => usedFallback >= 1, 100), '实际行为：非法 fetchImpl 静默回退到全局 fetch');
    sx.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  // now 非函数 → Date.now
  let got = null;
  const sn = makeSource({ endpoint: 'http://x', intervalMs: 1, now: 'nope', fetchImpl: okFetch({ requests: { active: 1 } }) });
  sn.start((s) => { got = s; });
  assert.ok(await waitFor(() => got !== null, 100));
  sn.stop();
  assert.ok(Number.isFinite(got.updatedAt) && Math.abs(Date.now() - got.updatedAt) < 5000, 'now 非函数时回退 Date.now');
  // 【存疑】now 返回非有限值 → updatedAt 变成 NaN、clock 变成 '--:--:--'，违反「快照数值有限」的约定。
  // 属于宿主注入错误（now 是测试/宿主提供的），数据源未做防御，暂按取舍记录。
  let got2 = null;
  const sn2 = makeSource({ endpoint: 'http://x', intervalMs: 1, now: () => NaN, fetchImpl: okFetch({ requests: { active: 1 } }) });
  sn2.start((s) => { got2 = s; });
  assert.ok(await waitFor(() => got2 !== null, 100));
  sn2.stop();
  assert.ok(Number.isNaN(got2.updatedAt), '实际行为：now 返回 NaN 时 updatedAt 是 NaN');
  assert.equal(got2.clock, '--:--:--', '实际行为：clock 退化为占位符');
});

test('H10 createHttpSource：在 onSample 内 stop() 立即停表；stop/start 幂等与重启（C4）', async () => {
  let calls = 0;
  const s1 = makeSource({
    endpoint: 'http://x', intervalMs: 1, now: () => NOW,
    fetchImpl: okFetch({ requests: { active: 1 } }, () => { calls += 1; }),
  });
  const seen = [];
  s1.start((s) => { seen.push(s); s1.stop(); });
  await sleep(25);
  assert.equal(calls, 1, 'onSample 内 stop() 之后不得再发起请求');
  assert.equal(seen.length, 1);
  assert.equal(s1.status, 'live');

  let calls2 = 0;
  const s2 = makeSource({
    endpoint: 'http://x', intervalMs: 1, now: () => NOW,
    fetchImpl: okFetch({ requests: { active: 2 } }, () => { calls2 += 1; }),
  });
  const seen2 = [];
  s2.start((s) => seen2.push(s));
  assert.ok(await waitFor(() => calls2 >= 2, 200));
  s2.stop();
  const after = calls2;
  await sleep(10);
  assert.equal(calls2, after, 'stop 后不得继续请求');
  s2.start((s) => seen2.push(s));
  assert.ok(await waitFor(() => calls2 > after, 200), 'start() 重启后必须恢复轮询');
  s2.stop();
  assert.doesNotThrow(() => s2.stop(), '重复 stop 必须幂等');

  const s3 = makeSource({ endpoint: 'http://x', intervalMs: 1, now: () => NOW, fetchImpl: okFetch({}) });
  assert.doesNotThrow(() => { s3.start(); s3.start(); s3.stop(); s3.stop(); }, '不传回调、重复 start/stop 都不得抛');
  await sleep(10);
});

test('H11 createHttpSource：transform 注入路径（新增代码，验证期间才出现）', async () => {
  // (a) 正常路径：transform 读文本并返回快照对象
  let calls = 0;
  const seen = [];
  const s1 = makeSource({
    endpoint: 'http://x', intervalMs: 1, now: () => NOW,
    fetchImpl: async () => { calls += 1; return { ok: true, status: 200, text: async () => 'vllm:num_requests_running 8' }; },
    transform: async (res, _prev) => {
      const body = await res.text();
      return { ...emptySnapshot(NOW), requests: { active: body.includes('8') ? 8 : 0, queued: 1, capacity: 12 }, clock: '' };
    },
  });
  s1.start((s) => seen.push(s));
  try {
    assert.ok(await waitFor(() => seen.length >= 1, 300), 'transform 路径必须能上报');
    assert.equal(seen[0].requests.active, 8, 'transform 的返回值必须被采用');
    assert.equal(seen[0].clock, formatClock(new Date(NOW)), 'transform 没给 clock 时补本地时钟');
    assert.equal(seen[0].updatedAt, NOW, 'updatedAt 用本地接收时刻');
    assert.equal(seen[0].status, 'live');
  } finally {
    s1.stop();
  }

  // (b) transform 抛异常 / 返回非对象 → 计入传输失败，5 次进入 error
  for (const [name, transform] of [
    ['transform-throw', async () => { throw new Error('parse failed'); }],
    ['transform-null', async () => null],
    ['transform-string', async () => 'nope'],
  ]) {
    let n = 0;
    const src = makeSource({
      endpoint: 'http://x', intervalMs: 1, now: () => NOW,
      fetchImpl: async () => { n += 1; return { ok: true, status: 200, text: async () => '' }; },
      transform,
    });
    const samples = [];
    src.start((s) => samples.push(s));
    try {
      assert.ok(await waitFor(() => n >= 5, 500), name + '：应在预算内完成 5 次请求');
      assert.equal(src.status, 'error', name + '：连续 5 次失败必须进入 error');
      assert.deepEqual(samples.slice(0, 5).map((s) => s.status), ['live', 'live', 'stale', 'stale', 'error'], name);
    } finally {
      src.stop();
    }
  }
});

test('H12 createHttpSource：transform 返回数组时未被拒绝（【存疑·低危】，与 JSON 分支不一致）', async () => {
  let calls = 0;
  const seen = [];
  const src = makeSource({
    endpoint: 'http://x', intervalMs: 1, now: () => NOW,
    fetchImpl: async () => { calls += 1; return { ok: true, status: 200, text: async () => '' }; },
    transform: async () => [1, 2, 3],          // 数组也是 typeof 'object'
  });
  src.start((s) => seen.push(s));
  try {
    assert.ok(await waitFor(() => calls >= 5, 600), '应完成多次请求');
    // 已由实现方对齐：transform 分支现在与 JSON 分支一样显式拒绝数组 —— 坏快照不会进 store，
    // 而是按传输失败计数降级（live → stale → error）。
    assert.equal(src.status, 'error', '数组返回值属于非法快照，连续 5 次后应进入 error');
    assert.deepEqual(seen.slice(0, 5).map((s) => s.status), ['live', 'live', 'stale', 'stale', 'error'],
      '非法快照按失败累计，实际 ' + JSON.stringify(seen.slice(0, 5).map((s) => s.status)));
    assert.ok(seen.every((s) => !Array.isArray(s)), 'onSample 绝不能收到数组形状的快照');
  } finally {
    src.stop();
  }
});

test('H13 createHttpSource：成功帧必须是 Snapshot 对象，而不是 null（【缺陷】变量遮蔽回归）', async () => {
  let calls = 0;
  const received = [];
  const src = makeSource({
    endpoint: 'http://x', intervalMs: 1, now: () => NOW,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ requests: { active: 5 }, output: { tokPerSec: 9 } }) };
    },
  });
  src.start((s) => received.push(s));
  assert.ok(await waitFor(() => received.length >= 1, 300), '成功轮询必须上报一帧');
  // 【缺陷】src/sources/http.js 的 httpAttempt 里 let mapped 被内层同名声明遮蔽：
  //   115 行 let mapped = null;             ← 外层
  //   123 行 let mapped;                    ← 内层（遮蔽），成功分支只赋值给内层
  //   158 行 httpEmit(mapped, myRun);       ← 用的仍是外层，恒为 null
  // 后果：每一次成功轮询都把 null 当成 Snapshot 交给消费端，store/render 会直接崩。
  assert.notEqual(received[0], null, 'onSample 收到的成功帧不得是 null');
  assert.equal(typeof received[0], 'object', '成功帧必须是对象');
  assert.equal(received[0].status, 'live');
  assert.equal(received[0].requests.active, 5, '成功帧必须带上映射后的负载');
  assert.equal(received[0].updatedAt, NOW);
  assert.equal(src.status, 'live');
  assert.ok(calls >= 1);
});

// ──────────────────────────── 全局收尾检查 ─────────────────────────────────

test('ZZ 收尾：除已记录的消费者异步异常外，全程不得有未处理拒绝（C5）', async () => {
  await sleep(20);
  const left = unhandled.map((e) => String(e && e.message));
  assert.deepEqual(left, [], '全程未处理拒绝应为空，实际残留 ' + JSON.stringify(left));
  process.off('unhandledRejection', onUnhandled);
});
