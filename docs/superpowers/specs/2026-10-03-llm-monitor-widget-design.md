# LLM 监控面板复刻 —— 设计文档（Spec）

- 日期：2026-10-03
- 状态：待用户评审
- 参考物：用户提供的截图 `软件插件1.png`（867×1140，手机拍摄屏幕），已裁切放大为 `ref/A..D` 四张对照图
- 交付形态：**自包含网页 / PWA**（用户已确认方案 A）

## 1. 背景与目标

用户看到一个 LLM 服务状态监控小插件，希望**一模一样地复刻**，用于监控自己本地的 vLLM 服务（截图中的实例是 `Qwen3.8-Flash` / `vLLM · Dual DGX Spark`）。

目标：一屏深色仪表盘，实时展示推理服务的吞吐、请求、缓存、内存、GPU 状态；既可离线跑模拟数据演示，也可指向真实端点。

成功标准：把复刻页面与参考截图并排看，**普通人分不出差别**；数值每秒跳动，曲线/环形/柱条随数据动。

## 2. 交付物

| 产物 | 说明 |
| --- | --- |
| `index.html` + `src/*.js` + `styles.css` | 源码（零依赖 ESM，无构建链） |
| `llm-monitor.html` | **构建产物：单文件**，双击即可离线打开，可直接丢给手机/发同事 |
| `manifest.webmanifest` | 通过本地服务器访问时可"添加到主屏幕" |
| `build.js` | 无依赖打包脚本（内联 CSS/JS → 单文件） |
| `tests/*.test.js` | `node --test` 单测（纯逻辑） |
| `README.md` | 运行、接真实端点、验收方法 |
| `ref/*.png` | 截图参照物（验收基准） |
| `docs/superpowers/specs/`、`docs/superpowers/plans/` | 本 spec 与后续实施计划 |

## 3. 范围与非目标

**做**：单屏面板的 1:1 视觉复刻；模拟数据引擎；真实端点适配（JSON 契约 + vLLM `/metrics` Prometheus 文本解析）；离线单文件产物；单测与视觉比对。

**不做（YAGNI）**：
- 不做历史存储、告警、多实例切换、登录鉴权
- 不做 Service Worker 离线缓存（单文件已离线；SW 只增加缓存 bug 面）
- 不复刻手机系统状态栏（信号/WiFi/电量）与灵动岛胶囊；灵动岛样式的 `tok/s` 胶囊做成**可选开关** `?island=1`，默认关闭
- 不引入 React/Vue/图表库

## 4. 界面规格

### 4.1 面板几何（从照片量取，单位 u = 面板宽度的 1%）

照片中面板外框 x 71→754、y 104→1096，即 683×992。换算比例：

| 量 | 照片像素 | u 值 |
| --- | --- | --- |
| 面板左右内边距 | 23 | 3.4u |
| 卡片横向间距 | 18 | 2.6u |
| 单列卡片宽 | 308 | 45.1u |
| 顶部标题区高 | ~94 | 13.8u |
| Hero 卡高 | 183 | 26.8u |
| 第二行卡高 | 199 | 29.1u |
| 第三行卡高 | 192 | 28.1u |
| 第四行卡高 | ~180 | 26.4u |
| 卡片纵向间距 | 15~23 | 2.8u |
| 底部栏高 | ~60 | 8.8u |

实现方式：面板 `width: min(92vw, 420px)`，由 JS 写入 `--u: <panelWidth/100>px`，所有内部尺寸用 `calc(var(--u) * N)`。这样在任何宽度下等比缩放，不依赖 `cqw` 兼容性。

### 4.2 区域清单（9 块）

1. **标题栏**：圆角方 App 图标；主标题 `Qwen3.8-Flash`（粗白）；副标题 `vLLM · Dual DGX Spark`（粗白）；右侧 `⌄ NAS 已连接 ⌄`（两侧 chevron）
2. **实时输出 Token（Hero）**：淡绿底卡片 + 1px 描边；标签 `实时输出 Token`；大号数字 `257` + 单位 `tok/s`；脚注 `最近 60 秒`；右侧绿色折线 sparkline（60 点，仅描边、圆角连接、无填充）
3. **请求状态**：图标 + 标签；`8 活动`（绿数字）`1 排队`（橙数字）；底部圆角进度条：绿色运行段 + 橙色排队段
4. **输入 Token**：圆形下箭头图标 + 标签；`1.7K` + `tok/s`；底部 `▤ Prefill 均值`
5. **KV Cache**：图标 + 标签；环形进度（灰轨道 + 蓝色弧，12 点方向起顺时针，圆头）；中心 `16%`；右侧三行：`占用率` / `余量充足`（绿）/ `Cache Hit 93%`
6. **MTP**：星芒图标 + 标签；环形进度（品红弧 69%）；中心 `69%`；右侧 `TAR` + `1.99`
7. **统一内存**：图标 + 标签；环形进度（绿色弧 82%）；中心 `82%`；右侧 `S1` / `105/128G`（绿）/ `可用 23G`
8. **GPU 活跃度**：图标 + 标签；`93%` 大号黄绿数字 + 副文本 `计算中`；右侧 ~15 根等高圆角黄绿竖条（历史活跃度，随时间滚动）
9. **底部栏**：时钟图标 + `23:48:30`（本地时间，秒级）；右侧三个图标按钮：刷新、复制、电源

### 4.3 配色 token（照片反光导致偏色，以下为初始估计值，验收阶段按视觉比对微调）

```
--bg        #1c1c1e   面板底
--card      #2c2c2e   普通卡片
--track     #3a3a3c   环形/进度条轨道
--hero-bg   #26382a   Hero 绿底（含 1px rgba(255,255,255,.07) 描边）
--text      #ffffff
--text-dim  #a1a1a6
--green     #3ddc5f   sparkline / 进度条 / 内存环 / 活动数
--lime      #b8e62e   GPU 数字与柱条
--blue      #3fa4f5   KV Cache 环
--magenta   #c85ae0   MTP 环
--orange    #f7a33c   排队数与排队段
```

字体：系统字体栈 `-apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`；数字用 `font-variant-numeric: tabular-nums` 防止跳动。

### 4.4 图表画法（全部内联 SVG）

- Sparkline：`<path>` 折线，`stroke-linejoin/linecap: round`，`stroke-width ≈ 1.1u`；X 轴为最近 60 个采样点，Y 轴自适应（含 0 基线，带上下留白），数据变化时用 1 帧过渡
- 环形：`<circle>` + `stroke-dasharray`，`transform: rotate(-90deg)` 使起点在 12 点；`stroke-linecap: round`；轨道同宽灰色
- GPU 柱条：`<rect rx>` × N，高度按历史值，右端为最新

## 5. 架构

### 5.1 技术选型

**零依赖 ESM + 单文件构建**（已确认）。理由：一屏界面、无路由无状态管理需求；开发期零构建（改完刷新浏览器即可），产物由一行 `node build.js` 生成；单文件产物让"发给别人/丢到手机"零成本。备选 Vite+框架（后续要扩展多面板再考虑）与 Canvas 全绘制（中文排版与视觉还原成本高）均被否决。

### 5.2 模块划分

| 模块 | 职责 | 依赖 | 可独立测试 |
| --- | --- | --- | --- |
| `src/format.js` | 数值格式化：`1240→"1.2K"`、`105/128`、百分比、`HH:MM:SS` | 无 | ✅ 纯函数 |
| `src/charts.js` | 纯几何：点列→SVG path、比例→dasharray、数值列→柱条矩形 | 无 | ✅ 纯函数 |
| `src/store.js` | 状态容器：`snapshot` + 订阅 + 变更合并，环形缓冲（60 点） | 无 | ✅ |
| `src/sources/mock.js` | 模拟 vLLM 遥测引擎（可播种，确定性） | store 无关 | ✅ |
| `src/sources/http.js` | 轮询真实 JSON 端点 + 字段映射 + 退避 | format | ✅（注入 fetch） |
| `src/sources/vllm-metrics.js` | vLLM `/metrics` Prometheus 文本解析 | 无 | ✅ 纯函数 |
| `src/render.js` | DOM 绑定：把 snapshot 写进 8 个区域（只做 DOM 写，不含业务） | format/charts | 冒烟 |
| `src/app.js` | 装配：读 URL 参数选数据源、启动采样循环、rAF 渲染节流 | 全部 | 冒烟 |
| `build.js` | 内联 CSS+JS → `llm-monitor.html` | node fs | ✅ 断言产物 |

模块间只通过**数据对象**通信：数据源产出 `Snapshot`，`store` 持有，`render` 消费。渲染层不认识任何数据源。

### 5.3 目录结构

```
index.html            开发入口（模块化引用）
styles.css            设计 token + 布局
src/format.js
src/charts.js
src/store.js
src/render.js
src/app.js
src/sources/mock.js
src/sources/http.js
src/sources/vllm-metrics.js
build.js
tests/*.test.js
manifest.webmanifest
llm-monitor.html      ← 构建产物（提交进仓库，便于直接取用）
README.md
docs/superpowers/{specs,plans}/
ref/*.png
```

## 6. 数据模型（Snapshot）

```js
{
  model:   { name: "Qwen3.8-Flash", engine: "vLLM", nodes: "Dual DGX Spark", link: "up" | "down" },
  output:  { tokPerSec: 257, history: [/* 60 个 */] },
  requests:{ active: 8, queued: 1, capacity: 12 },
  input:   { tokPerSec: 1700, prefillAvgMs: 320 },
  kvCache: { usage: 0.16, hitRate: 0.93, headroom: "余量充足" },
  mtp:     { ratio: 0.69, tar: 1.99 },
  memory:  { node: "S1", usedGB: 105, totalGB: 128, freeGB: 23 },
  gpu:     { utilization: 0.93, state: "计算中", history: [/* 15 个 */] },
  clock:   "23:48:30",
  status:  "live" | "connecting" | "stale" | "error",
  updatedAt: 1759494510000
}
```

## 7. 数据流

```
MetricsSource.start(onSample)
   └─(每 1s)→ Snapshot → store.update() → 订阅者
                                   ├→ render.paint(snapshot)   （rAF 合并，最多 60fps）
                                   └→ history 环形缓冲（output 60 点 / gpu 15 点）
```

采样 1s（与"最近 60 秒"、秒级时钟一致）；渲染按 rAF 合并，避免抖动与重排风暴。

## 8. 数据源契约

- **mock（默认）**：`mulberry32` 播种 PRNG；模拟突发解码速率、请求 Markov 迁移（活动/排队）、prefill 活动驱动的输入速率、KV 占用锯齿（写满→淘汰）、缓存命中率 85%~97%、MTP 比值随机游走、显存缓慢漂移、GPU 利用率与状态联动。同一种子 → 同一序列，供测试断言。
- **http**：`?source=http&endpoint=<url>&interval=1000`，GET 返回上述 Snapshot 字段的 JSON（缺字段用上一帧值补齐）。
- **vllm**：`?source=vllm&endpoint=http://host:8000/metrics`，解析 Prometheus 文本：`vllm:num_requests_running`、`vllm:num_requests_waiting`、`vllm:avg_generation_throughput_toks_per_s`、`vllm:gpu_cache_usage_perc`、`vllm:gpu_prefix_cache_hit_rate` 等；字段名可配置，缺失即降级为占位符 `--`。
- 跨域：浏览器直连 vLLM 会被 CORS 拦；README 给出两种解法（vLLM 侧加 `--allowed-origins`，或用一行 `python -m http.server` 反代不了时的 `?proxy=` 说明）。**不做**内置代理服务。

## 9. 错误处理与降级

- 数据源异常：连续失败 → `stale`（数值变暗 60s 不更新提示）→ `error`（右上角显示 `未连接`，chevron 保持位置，**布局不塌陷**）
- 字段缺失/NaN：格式化层兜底为 `--`，图表保留上一帧
- 历史不足 60 点：左侧留空，不补零、不拉伸
- 分母为 0（容量、总量）：进度条按 0 处理，不产生 NaN

## 10. 测试策略

1. **单测**（`node --test`）：format 边界（999/1000/1.5M、0、NaN）；charts 几何（0%/50%/100% 环、单点折线、全等值柱条）；store 环形缓冲与订阅；mock 同种子可复现 + 值域不越界；vllm 解析器对真实样本与畸形输入。
2. **构建完整性**：产物不含 `import`/`export` 残留、无重复顶层标识符、体积上限。
3. **冒烟 + 视觉比对**：用本机无头浏览器加载 `llm-monitor.html`，注入固定种子与冻结时钟，在 390×844 视口截图，与 `ref/` 对照图并排比对，逐轮修正比例与配色；同时断言 9 个区域的文本内容与预期一致。
4. **降级验证**：端点不可达时断言状态文案与布局尺寸不变。

## 11. 验收标准

- [ ] 与参考截图并排比对，9 个区域的内容、层级、相对比例一致（比例误差 ≤5%）
- [ ] 每秒刷新：数字、折线、进度条、三个环形、GPU 柱条同步变化
- [ ] 时钟显示本地真实时间（秒级）
- [ ] `llm-monitor.html` 双击可离线打开且完整可用
- [ ] `?source=vllm&endpoint=...` 能解析真实 vLLM `/metrics`
- [ ] 端点异常时显示"未连接"且布局不塌陷
- [ ] `node --test` 全绿；无第三方运行时依赖

## 12. 风险与取舍

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 照片透视/反光 → 颜色是估计值 | 配色可能有偏差 | 以并排视觉比对为准迭代，spec 中的色值不是圣旨 |
| 面板实际像素尺寸未知（只有比例） | 字号绝对值无依据 | 采用 `--u` 等比缩放，任何宽度下观感一致 |
| vLLM 指标名随版本变化 | 真实接入失败 | 解析器容错 + 可配置字段名 + 缺失降级 `--` |
| 无头浏览器不可用 | 视觉比对只能靠人工 | 退化为输出对照图 + 手写像素比例断言 |

## 13. 后续可选项（不在本次范围）

灵动岛胶囊（`?island=1` 已留开关）、多实例切换、历史导出、告警阈值、DSH GUI 插件化封装。
