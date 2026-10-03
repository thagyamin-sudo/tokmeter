# LLM 监控面板复刻 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 E:/临时项目/LLM监控 复刻截图中的 LLM 状态监控面板：零依赖单页应用 + 可离线双击打开的单文件产物，数据由模拟引擎或真实 vLLM 端点驱动。

**Architecture:** 三层单向数据流 —— 数据源（mock / http / vllm，统一 `MetricsSource` 接口产出 `Snapshot`）→ 状态容器 `store`（含环形历史缓冲）→ 渲染层 `render`（内联 SVG，每帧重写文本与图形属性）。所有内部尺寸用 `calc(var(--u) * N)` 等比缩放，`--u = 面板宽度 / 100`。

**Tech Stack:** 原生 ESM + CSS + 内联 SVG；Node 24 内置 `node --test` 做单测；Microsoft Edge `--headless` 做 E2E 探针与截图；运行时零第三方依赖。

**Spec:** docs/superpowers/specs/2026-10-03-llm-monitor-widget-design.md

## Global Constraints

- 运行时零第三方依赖：不引入框架、图表库、网络字体（系统字体栈）。
- 开发入口 `index.html` 走 ESM；交付产物 `llm-monitor.html` 必须是单文件且能在 `file://` 下双击离线打开。
- 尺寸一律 `calc(var(--u) * N)`，`--u` 由 JS 写入（面板宽度/100），CSS 兜底 `3.9px`；禁止硬编码像素宽度。
- 颜色取自 spec 第 4.3 节的 token：`--bg #1c1c1e`、`--card #2c2c2e`、`--track #3a3a3c`、`--hero-bg #26382a`、`--text #ffffff`、`--text-dim #a1a1a6`、`--green #3ddc5f`、`--lime #b8e62e`、`--blue #3fa4f5`、`--magenta #c85ae0`、`--orange #f7a33c`。改色必须走任务 11 并同步 spec。
- 文案与截图逐字一致：Qwen3.8-Flash / vLLM · Dual DGX Spark / NAS 已连接 / 实时输出 Token / tok/s / 最近 60 秒 / 请求状态 / 活动 / 排队 / 输入 Token / Prefill 均值 / KV Cache / 占用率 / 余量充足 / Cache Hit / MTP / TAR / 统一内存 / GPU 活跃度 / 计算中 / 可用。
- 数字一律 `font-variant-numeric: tabular-nums`。
- 采样周期 1000ms；渲染用 `requestAnimationFrame` 合并。
- 每个任务一次 commit，前缀 `feat:` / `test:` / `docs:` / `chore:`。

## Review Focus

以下 5 类输入/失败模式最容易伤到真实使用者，spec 未逐条写死，由对应任务的测试钉住：

1. **极窄/极宽视口**（320px / >600px）——面板取 `min(92vw, 420px)`，`--u` 随之变化，任何元素不得溢出或错位（任务 1、11）。
2. **数值量级突变**（0 → 999 → 1.0K → 2.3M）——数字变宽不得把 `tok/s` 挤出卡片或引起布局抖动（任务 2、7）。
3. **数据源中途断开**——live → stale → error 时标题区文案切换，布局不得塌陷，图表保留最后一帧（任务 9、12）。
4. **异常数值**（NaN / null / 负数 / 分母为 0）——不得渲染出 `NaN%`、`Infinity` 或空 path（任务 2、3、5）。
5. **时钟跨零点与本地时区**——00:00:00 正确；挂机 1 小时后曲线窗口仍是"最近 60 秒"（任务 2、4、8）。

---

### Task 1: 缩放单位与面板骨架

**Files:**
- Create: `src/units.js`、`tests/units.test.js`、`index.html`、`styles.css`

**Interfaces:**
- Produces: `unitPx(panelWidth: number): number`、`applyUnit(el: HTMLElement, width: number): number`

- [ ] **Step 1: 写失败测试** `tests/units.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { unitPx } from '../src/units.js';

test('unitPx 返回面板宽度的百分之一', () => {
  assert.equal(unitPx(390), 3.9);
  assert.equal(unitPx(420), 4.2);
  assert.equal(unitPx(0), 0);
});
```

- [ ] **Step 2: 跑测试确认失败**：`node --test tests/units.test.js` → FAIL（Cannot find module '../src/units.js'）

- [ ] **Step 3: 实现** `src/units.js`：`unitPx` 返回 `panelWidth / 100`；`applyUnit` 用 `el.style.setProperty('--u', unitPx(width) + 'px')` 写入并返回该值。

- [ ] **Step 4: 跑测试确认通过**：`node --test tests/units.test.js` → PASS

- [ ] **Step 5: 搭骨架**：`index.html` 含 `<div class="panel" id="panel">` 与 `<script type="module" src="src/app.js">`；`styles.css` 定义 `:root` 色 token、`body` 居中深色底、`.panel` 取 `width: min(92vw, 420px)` + `aspect-ratio` 由内容决定 + 圆角 `4.4u` + 内边距 `3.4u` + `--u: 3.9px` 兜底；`src/app.js` 里调用 `applyUnit` 并在 `resize` 时重算。

- [ ] **Step 6: 目视确认**：`python -m http.server 8000` 后打开 `http://localhost:8000`，看到一个居中的空面板，缩放窗口时整体等比缩放。

- [ ] **Step 7: Commit** `chore: 面板骨架与等比缩放单位`

---

### Task 2: 格式化层 `src/format.js`

**Files:**
- Create: `src/format.js`、`tests/format.test.js`

**Interfaces:**
- Produces: `formatRate(v): string`、`formatClock(d: Date): string`、`formatPercent(ratio): string`、`formatMemPair(used, total): string`、`formatFreeLabel(gb): string`、`formatTar(v): string`
- 约定：任何非有限数返回 `'--'`；`formatRate` 负数按 0。

- [ ] **Step 1: 写失败测试** `tests/format.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRate, formatClock, formatPercent, formatMemPair, formatFreeLabel, formatTar } from '../src/format.js';

test('formatRate 覆盖量级突变与异常值', () => {
  assert.equal(formatRate(257), '257');
  assert.equal(formatRate(999), '999');
  assert.equal(formatRate(1000), '1.0K');
  assert.equal(formatRate(1700), '1.7K');
  assert.equal(formatRate(2340000), '2.3M');
  assert.equal(formatRate(-5), '0');
  assert.equal(formatRate(NaN), '--');
  assert.equal(formatRate(undefined), '--');
});

test('formatClock 补零且支持跨零点', () => {
  assert.equal(formatClock(new Date(2026, 9, 3, 23, 48, 30)), '23:48:30');
  assert.equal(formatClock(new Date(2026, 9, 4, 0, 0, 0)), '00:00:00');
  assert.equal(formatClock(new Date(2026, 9, 4, 7, 5, 9)), '07:05:09');
});

test('百分比/内存/TAR', () => {
  assert.equal(formatPercent(0.16), '16%');
  assert.equal(formatPercent(0.935), '94%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(NaN), '--');
  assert.equal(formatMemPair(105, 128), '105/128G');
  assert.equal(formatFreeLabel(23), '23G');
  assert.equal(formatTar(1.99), '1.99');
  assert.equal(formatTar(NaN), '--');
});
```

- [ ] **Step 2: 跑测试确认失败**：`node --test tests/format.test.js` → FAIL

- [ ] **Step 3: 实现** `src/format.js`（纯函数，无 DOM）：`formatRate` 用 `<1000 → 整数`、`<1e6 → 一位小数 + 'K'`、否则 `'M'`；`formatPercent` 用 `Math.round(ratio * 100) + '%'`。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: Commit** `feat: 数值格式化层`

---

### Task 3: 图表几何 `src/charts.js`

**Files:**
- Create: `src/charts.js`、`tests/charts.test.js`

**Interfaces:**
- Produces:
  - `sparklinePath(values: number[], w: number, h: number, pad: number): string` —— 折线 path，点少于 2 返回 `''`
  - `ringGeometry(ratio: number, radius: number, strokeWidth: number): { r: number, circumference: number, dasharray: string, dashoffset: number }`
  - `barRects(values: number[], box: {x,y,w,h}, gapRatio: number): Array<{x,y,w,h,rx}>`

- [ ] **Step 1: 写失败测试** `tests/charts.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { sparklinePath, ringGeometry, barRects } from '../src/charts.js';

test('sparklinePath 边界', () => {
  assert.equal(sparklinePath([], 100, 50, 4), '');
  assert.equal(sparklinePath([5], 100, 50, 4), 'M 0 27');           // 单点仍在左端垂直居中
  assert.equal(sparklinePath([0, 10], 100, 50, 0), 'M 0 50 L 100 0'); // 满量程铺满
  assert.match(sparklinePath([1, 2, 3], 100, 50, 4), /^M .+ L .+ L .+$/);
  assert.equal(sparklinePath([7, 7, 7], 100, 50, 0), 'M 0 25 L 50 25 L 100 25'); // 等值居中
  assert.equal(sparklinePath([NaN, 1], 100, 50, 0), '');            // 异常值不产出 path
});

test('ringGeometry 比例到 dasharray', () => {
  const full = ringGeometry(1, 31, 9);
  assert.equal(full.r, 31);
  assert.ok(Math.abs(full.circumference - 2 * Math.PI * 31) < 1e-9);
  assert.equal(full.dasharray, full.circumference + ' ' + full.circumference);
  assert.equal(ringGeometry(0, 31, 9).dasharray, '0 ' + full.circumference);
  const p = ringGeometry(0.69, 31, 9);
  assert.ok(Math.abs(p.dashoffset - full.circumference * (1 - 0.69)) < 1e-9);
  assert.equal(ringGeometry(NaN, 31, 9).dasharray, '0 ' + full.circumference);
});

test('barRects 等宽带间隙且右端贴合', () => {
  const rects = barRects([0.2, 0.6, 1], { x: 0, y: 0, w: 100, h: 50 }, 0.35);
  assert.equal(rects.length, 3);
  assert.equal(rects[0].rx, rects[0].w / 2);
  assert.ok(rects[2].x + rects[2].w <= 100.0001);
  assert.ok(Math.abs(rects[2].h - 50) < 1e-9);
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现** `src/charts.js`：`sparklinePath` 先过滤非有限值（有异常即返回 `''`），X 均匀分布，Y 用 `[min,max]` 映射到 `[h - pad, pad]`（等值时取中点）；`ringGeometry` 用 `2πr` 与 `dashoffset = C * (1 - ratio)`，环起点靠 `transform: rotate(-90deg)` 交给 CSS；`barRects` 按 `gap = w * gapRatio / n` 分配。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: Commit** `feat: SVG 图表几何计算`

---

### Task 4: 状态容器 `src/store.js` 与 Snapshot 契约

**Files:**
- Create: `src/store.js`、`tests/store.test.js`

**Interfaces:**
- Produces: `createStore(initial: Snapshot): { get(): Snapshot, update(patch: Partial<Snapshot> | ((prev: Snapshot) => Partial<Snapshot>)): Snapshot, subscribe(fn: (s: Snapshot) => void): () => void }`、`pushRing(arr: number[], v: number, max: number): number[]`、`emptySnapshot(now: number): Snapshot`
- **Snapshot 是全局契约**（后续所有任务沿用这些字段名）：

```js
{
  model:    { name: string, engine: string, nodes: string, link: 'up' | 'down' },
  output:   { tokPerSec: number, history: number[] },        // history 固定长度上限 60
  requests: { active: number, queued: number, capacity: number },
  input:    { tokPerSec: number, prefillAvgMs: number },
  kvCache:  { usage: number, hitRate: number, headroom: string },
  mtp:      { ratio: number, tar: number },
  memory:   { node: string, usedGB: number, totalGB: number, freeGB: number },
  gpu:      { utilization: number, state: string, history: number[] },  // history 上限 15
  clock:    string,          // 'HH:MM:SS'
  status:   'connecting' | 'live' | 'stale' | 'error',
  updatedAt: number
}
```

- [ ] **Step 1: 写失败测试** `tests/store.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, pushRing, emptySnapshot } from '../src/store.js';

test('订阅/取消订阅/浅合并', () => {
  const store = createStore(emptySnapshot(0));
  const seen = [];
  const off = store.subscribe((s) => seen.push(s.requests.active));
  store.update({ requests: { active: 3, queued: 1, capacity: 12 } });
  store.update((prev) => ({ requests: { ...prev.requests, active: 4 } }));
  off();
  store.update({ requests: { active: 9, queued: 0, capacity: 12 } });
  assert.deepEqual(seen, [3, 4]);
  assert.equal(store.get().requests.active, 9);
  assert.equal(store.get().model.name, 'Qwen3.8-Flash');
});

test('pushRing 保持窗口长度且丢弃最旧值', () => {
  let h = [];
  for (let i = 1; i <= 65; i++) h = pushRing(h, i, 60);
  assert.equal(h.length, 60);
  assert.equal(h[0], 6);
  assert.equal(h[59], 65);
});

test('emptySnapshot 字段齐全且为有限数', () => {
  const s = emptySnapshot(0);
  for (const k of ['output', 'requests', 'input', 'kvCache', 'mtp', 'memory', 'gpu']) assert.ok(s[k]);
  assert.equal(s.status, 'connecting');
  assert.equal(s.clock, '00:00:00');
  assert.deepEqual(s.output.history, []);
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现** `src/store.js`：`update` 做一层浅合并（对象字段直接替换）；`subscribe` 返回取消函数；`pushRing` 用 `[...arr, v].slice(-max)`。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: Commit** `feat: 状态容器与 Snapshot 契约`

---

### Task 5: 模拟数据引擎 `src/sources/mock.js`

**Files:**
- Create: `src/sources/mock.js`、`tests/mock.test.js`

**Interfaces:**
- Produces: `mulberry32(seed: number): () => number`、`initialSnapshot(now: number): Snapshot`、`stepSnapshot(prev: Snapshot, rnd: () => number, now: number): Snapshot`、`createMockSource({ seed, intervalMs, now }): MetricsSource`
- `MetricsSource` 接口：`{ start(onSample: (s: Snapshot) => void): void, stop(): void, get status(): string }`

- [ ] **Step 1: 写失败测试** `tests/mock.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, initialSnapshot, stepSnapshot } from '../src/sources/mock.js';

test('同种子序列可复现，不同种子不同', () => {
  const a = mulberry32(7), b = mulberry32(7), c = mulberry32(8);
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, [c(), c(), c()]);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
});

test('1000 步后所有数值仍在值域内且有限', () => {
  const rnd = mulberry32(42);
  let s = initialSnapshot(0);
  for (let i = 0; i < 1000; i++) s = stepSnapshot(s, rnd, i * 1000);
  assert.ok(s.output.tokPerSec >= 0 && s.output.tokPerSec <= 1200);
  assert.ok(s.requests.active >= 0 && s.requests.active <= s.requests.capacity);
  assert.ok(s.requests.queued >= 0 && s.requests.queued <= 6);
  assert.ok(s.kvCache.usage >= 0 && s.kvCache.usage <= 1);
  assert.ok(s.kvCache.hitRate >= 0.85 && s.kvCache.hitRate <= 0.97);
  assert.ok(s.mtp.ratio >= 0.5 && s.mtp.ratio <= 0.85);
  assert.ok(s.mtp.tar >= 1.3 && s.mtp.tar <= 2.6);
  assert.ok(s.memory.usedGB >= 0 && s.memory.usedGB <= s.memory.totalGB);
  assert.ok(s.gpu.utilization >= 0 && s.gpu.utilization <= 1);
  assert.equal(s.output.history.length, 60);
  assert.equal(s.gpu.history.length, 15);
  for (const v of [...s.output.history, ...s.gpu.history, s.input.tokPerSec]) assert.ok(Number.isFinite(v));
  assert.equal(s.status, 'live');
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现** `src/sources/mock.js`：`mulberry32` 标准实现；`stepSnapshot` 用随机游走 + 均值回归：解码速率在 0~1200 间带突发（偶发空转）、请求做 Markov 迁移、`input.tokPerSec` 跟随 prefill 活动、KV 占用缓慢上升并在 0.95 处回落（模拟淘汰）、命中率 0.85~0.97、TAR 与 ratio 联动、显存随 KV 漂移、GPU 利用率与活动请求数正相关并在低于阈值时 `state` 变 `'空闲'`；每步把新值 `pushRing` 进 history。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: Commit** `feat: 模拟 vLLM 遥测引擎`

---

### Task 6: E2E 探针 + 标题栏 / Hero 卡 / 底部栏

**Files:**
- Create: `tools/probe.js`、`src/render.js`、`src/app.js`
- Modify: `index.html`、`styles.css`

**Interfaces:**
- Consumes: `unitPx/applyUnit`（T1）、`formatRate/formatClock`（T2）、`sparklinePath`（T3）、`createStore/emptySnapshot`（T4）、`createMockSource`（T5）
- Produces: `renderShell(root: HTMLElement): void`、`paint(root: HTMLElement, s: Snapshot): void`；探针约定 `?test=1&seed=7&freeze=23:48:30` 为确定性模式（冻结时钟、固定种子、不启动定时器），页面把测量结果写入 `<pre id="probe">` JSON

- [ ] **Step 1: 写探针** `tools/probe.js`：用 `child_process.spawnSync` 调 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`，参数 `--headless=new --disable-gpu --virtual-time-budget=3000 --dump-dom "file:///<abs index.html>?test=1&seed=7&freeze=23:48:30"`，从 stdout 抽出 `<pre id="probe">` 的 JSON，按断言表逐条校验，失败打印差异并以退出码 1 结束。

- [ ] **Step 2: 先跑一次确认失败**：`node tools/probe.js` → FAIL（找不到 `#probe`）

- [ ] **Step 3: 实现** `src/render.js` 的 `renderShell`（标题栏：图标 + `Qwen3.8-Flash` + `vLLM · Dual DGX Spark` + `NAS 已连接`；Hero 卡：标签 `实时输出 Token`、大数字 + `tok/s`、脚注 `最近 60 秒`、`<svg id="spark">`；底部栏：时钟 + 刷新/复制/电源三个 SVG 图标）与 `paint` 里对应这三块的更新逻辑；`styles.css` 补齐这三块的 `u` 尺寸（Hero 高 `26.8u`、标题区高 `13.8u`、底部栏高 `8.8u`，卡片圆角 `4.4u`、内边距 `3.4u`）。

- [ ] **Step 4: 探针断言**：文本 6 项齐全；`#spark path` 的 `d` 点数 = 60；Hero 卡高 / 面板宽 ∈ `[0.255, 0.281]`；面板宽 = `min(92vw, 420px)`。

- [ ] **Step 5: 跑探针确认通过**：`node tools/probe.js` → PASS

- [ ] **Step 6: Commit** `feat: 标题栏/Hero/底部栏与 E2E 探针`

---

### Task 7: 六张数据卡

**Files:**
- Modify: `src/render.js`、`index.html`、`styles.css`、`tools/probe.js`

**Interfaces:**
- Consumes: `ringGeometry`、`barRects`、`formatPercent`、`formatMemPair`、`formatFreeLabel`、`formatTar`
- Produces: `#probe` 增加 `cards` 段（每张卡的 bounding box 与关键图形属性）

- [ ] **Step 1: 扩充探针断言**（先写期望，再实现）：请求状态卡含 `8`/`活动`/`1`/`排队` 与进度条两段宽度比 `active : queued`；输入 Token 卡含 `1.7K` 与 `Prefill 均值`；KV Cache 环 `dashoffset` 对应 `0.16±0.01`、文案 `占用率`/`余量充足`/`Cache Hit`；MTP 环对应 `0.69±0.01`、`TAR`/`1.99`；统一内存环 `0.82±0.01`、`S1`/`105/128G`/`可用 23G`；GPU 卡 `93%`/`计算中` 与 15 根柱条；四行卡高 / 面板宽 ∈ `[0.25, 0.31]`。

- [ ] **Step 2: 跑探针确认失败** → FAIL

- [ ] **Step 3: 实现**：`index.html` 补 `.grid` 两列（列宽 `45.1u`、列距 `2.6u`）；`render.js` 建卡并绘制环形（`<circle>` 轨道 + 进度弧，`transform="rotate(-90 cx cy)"`、`stroke-linecap="round"`）与 GPU 柱条（`<rect rx>`）；文字用 `format*` 产出。

- [ ] **Step 4: 跑探针确认通过** → PASS

- [ ] **Step 5: 数值量级回归**：探针加一帧注入 `output.tokPerSec = 2340000`，断言 `2.3M` 渲染后大数字容器宽度 ≤ `28u` 且 Hero 卡不溢出（Review Focus 2）。

- [ ] **Step 6: Commit** `feat: 六张数据卡与环形/柱状图`

---

### Task 8: 实时刷新接线

**Files:**
- Modify: `src/app.js`、`tools/probe.js`

**Interfaces:**
- Consumes: `createStore`、`createMockSource`、`paint`

- [ ] **Step 1: 扩充探针**：`?test=1&tick=3` 走同步步进模式（不依赖真实定时器），断言：3 次采样后 `output.tokPerSec` 与首帧不同；`clock` 等于注入时钟的 `HH:MM:SS`；同一帧内连续两次 `update` 只触发一次 `paint`（用 `#probe` 里的 `paintCount` 计数）。

- [ ] **Step 2: 跑探针确认失败** → FAIL

- [ ] **Step 3: 实现** `src/app.js`：解析 URL 参数（`test/seed/freeze/tick/source/endpoint`）→ 选数据源 → `store.subscribe` 触发 `requestAnimationFrame` 合并渲染 → `setInterval(1000)` 采样；`stop` 时清理定时器。

- [ ] **Step 4: 跑探针确认通过** → PASS

- [ ] **Step 5: 手工确认**：`http://localhost:8000` 打开，数字每秒跳动、时钟走秒、曲线右移。

- [ ] **Step 6: Commit** `feat: 实时采样与 rAF 渲染循环`

---

### Task 9: 真实数据源（JSON 轮询 + vLLM Prometheus）

**Files:**
- Create: `src/sources/http.js`、`src/sources/vllm-metrics.js`、`tests/http.test.js`、`tests/vllm-metrics.test.js`
- Modify: `src/app.js`、`tools/probe.js`

**Interfaces:**
- Produces: `createHttpSource({ endpoint, intervalMs, fetchImpl, now }): MetricsSource`、`mapPayload(json: object, prev: Snapshot): Snapshot`、`parsePrometheus(text: string): Record<string, number>`、`toSnapshot(metrics: Record<string, number>, prev: Snapshot, now: number): Snapshot`

- [ ] **Step 1: 写失败测试** `tests/vllm-metrics.test.js`：解析含 `# HELP` / `# TYPE` / 带标签的样本，断言 `vllm:num_requests_running`、`vllm:num_requests_waiting`、`vllm:avg_generation_throughput_toks_per_s`、`vllm:gpu_cache_usage_perc`、`vllm:gpu_prefix_cache_hit_rate` 取值正确；畸形文本（空串、半行、非数字）返回 `{}` 且不抛异常；`toSnapshot` 在缺字段时保留 `prev` 的值。

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现** `src/sources/vllm-metrics.js`（纯函数，注意 vLLM 的 `gpu_cache_usage_perc` 已是 0~1，`prefix_cache_hit_rate` 亦为 0~1）。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 写 `tests/http.test.js`**：注入假 `fetchImpl`（成功/500/网络异常/非法 JSON 四例），断言：成功时 `mapPayload` 缺字段沿用 prev；连续 3 次失败后 `status` 变 `'stale'`，第 5 次后变 `'error'`；`stop()` 后不再发起请求。

- [ ] **Step 6: 跑测试确认失败 → 实现 `src/sources/http.js` → 确认通过**

- [ ] **Step 7: 接进 app**：`?source=vllm&endpoint=<url>` 与 `?source=http&endpoint=<url>`；探针加一例：端点不可达时 `status` 为 `error` 且面板尺寸与 live 时一致（Review Focus 3）。

- [ ] **Step 8: Commit** `feat: 真实端点数据源（JSON 与 vLLM metrics）`

---

### Task 10: 单文件构建 `build.js` → `llm-monitor.html`

**Files:**
- Create: `build.js`、`tests/build.test.js`
- Produces: `llm-monitor.html`（提交进仓库）

**Interfaces:**
- Consumes: `index.html`、`styles.css`、`src/**/*.js`

- [ ] **Step 1: 写失败测试** `tests/build.test.js`：`build.js` 导出 `build(): string`；断言产物不含行首 `import ` / `export `（`/^\\s*(import|export)\\s/m` 无匹配）；含 `<style>` 与 `id="probe"`；体积 < 150KB；把内联脚本抽出写入临时 `.mjs` 后 `node --check` 通过。

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现 `build.js`**：按 `format → charts → units → store → mock → vllm-metrics → http → render → app` 的依赖顺序拼接（剥掉 `import` 行与 `export ` 前缀），CSS 内联进 `<style>`，输出单文件；同时写盘 `llm-monitor.html`。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 端到端确认**：`node tools/probe.js --target=llm-monitor.html`（`file://` 直接加载产物）→ PASS，证明双击离线可用。

- [ ] **Step 6: Commit** `feat: 单文件离线构建产物`

---

### Task 11: 视觉比对与调优

**Files:**
- Create: `tools/shot.js`
- Modify: `styles.css`（必要时）、`docs/superpowers/specs/2026-10-03-llm-monitor-widget-design.md`（若色值/比例调整）

- [ ] **Step 1: 写截图脚本 `tools/shot.js`**：Edge `--headless=new --window-size=390,844 --force-device-scale-factor=2 --screenshot=<out>`，加载确定性模式 URL。

- [ ] **Step 2: 生成对照** `ref/compare.png`：把复刻截图与 `ref/A..D` 按行对齐拼接（Python + Pillow），供人眼逐块比对。

- [ ] **Step 3: 逐块比对并记录差异清单**：9 个区域的比例（±5%）、配色、字号层级、圆角、图标形态。

- [ ] **Step 4: 修正差异**（只动 `styles.css` / `render.js` 的尺寸与色值），每轮重跑 `node tools/probe.js` 与截图；色值变化同步写回 spec 第 4.3 节。

- [ ] **Step 5: 复跑全部门禁**：`node --test` + `node tools/probe.js` + `node tools/probe.js --target=llm-monitor.html` 全绿。

- [ ] **Step 6: Commit** `feat: 视觉比对调优至 1:1`

---

### Task 12: 降级、PWA 与文档

**Files:**
- Create: `README.md`、`manifest.webmanifest`
- Modify: `src/render.js`、`src/app.js`、`tools/probe.js`

- [ ] **Step 1: 探针加降级断言**：`status = 'error'` 时标题区显示 `未连接`、面板宽高与 `live` 时逐像素一致、曲线保留最后一帧（Review Focus 3）。

- [ ] **Step 2: 跑探针确认失败 → 实现降级 UI → 确认通过**

- [ ] **Step 3: 可选灵动岛胶囊**：`?island=1` 时在面板顶部渲染 `257 tok/s` 胶囊，默认关闭；探针断言开关行为。

- [ ] **Step 4: `manifest.webmanifest`**：`name/short_name/display: standalone/background_color #1c1c1e/theme_color #1c1c1e` + 图标（复用 `index.html` 内联 SVG 转 PNG）。

- [ ] **Step 5: `README.md`**：如何打开（双击 `llm-monitor.html` / 本地服务器）、如何接真实 vLLM（`?source=vllm&endpoint=...`）、CORS 两种解法、如何跑测试与探针、验收清单勾选结果。

- [ ] **Step 6: 复跑全部门禁** → 全绿

- [ ] **Step 7: Commit** `docs: 使用说明与降级行为`

---

## 自检记录

- **Spec 覆盖**：第 2 节交付物 → T1/T10/T12；第 3 节非目标 → 未列入计划的功能一律不做（island 在 T12 做成开关）；第 4 节界面规格 → T1/T6/T7/T11；第 5 节架构 → 全任务；第 6 节数据模型 → T4（契约定义）；第 7 节数据流 → T8；第 8 节数据源契约 → T5/T9；第 9 节错误处理 → T9/T12；第 10 节测试策略 → 每任务 + T6 探针 + T11 视觉；第 11 节验收 → T11/T12；第 12 节风险 → T11 迭代。
- **类型一致性**：`Snapshot` 字段名只在 T4 定义一次，T5/T6/T7/T9/T12 全部引用同一组名字；`MetricsSource` 接口在 T5 定义，T9 复用。
- **Review Focus 落点**：1→T1/T11；2→T2/T7；3→T9/T12；4→T2/T3/T5；5→T2/T4/T8。
- **比例**：本计划 12 个任务、每个 3~8 步，未逐行转录实现代码。
