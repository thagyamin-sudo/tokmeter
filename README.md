# LLM 状态监控面板（复刻）

按用户提供的截图 1:1 复刻的本地 LLM 推理服务监控面板：**零依赖、可离线、单文件**。

- 设计文档（spec）：docs/superpowers/specs/2026-10-03-llm-monitor-widget-design.md
- 实施计划：docs/superpowers/plans/2026-10-03-llm-monitor-widget.md
- 参考截图：ref/（A..D 四张放大对照图）

## 快速开始

**方式一：双击单文件（推荐）**

直接打开 `llm-monitor.html` —— 样式与脚本已全部内联，`file://` 下即可离线运行，也可以直接发给别人或丢到手机里。

**方式二：开发模式（改完刷新即可，无需构建）**

```bash
python -m http.server 8000
# 浏览器打开 http://localhost:8000
```

> PWA 安装（"添加到主屏幕"）只在 http(s) 下可用；单文件离线打开不支持安装。

## 接真实数据源

界面右上角状态、曲线与所有数字默认来自内置的**模拟引擎**（可复现，便于演示与比对）。
指向真实服务时加 URL 参数：

| 场景 | URL |
| --- | --- |
| vLLM 原生 metrics 端点 | `index.html?source=vllm&endpoint=http://127.0.0.1:8000/metrics` |
| 自定义 JSON 端点 | `index.html?source=http&endpoint=http://127.0.0.1:9000/snapshot` |
| 内置模拟（默认） | `index.html` |
| 可选灵动岛胶囊 | `index.html?island=1` |

**vLLM 模式**读取这些指标（缺哪个就沿用上一帧，不会显示 NaN）：
`vllm:num_requests_running`、`vllm:num_requests_waiting`、`vllm:avg_generation_throughput_toks_per_s`、`vllm:gpu_cache_usage_perc`、`vllm:gpu_prefix_cache_hit_rate`。

**JSON 模式**接受与内部快照同形状的对象（缺字段沿用上一帧）：

```json
{
  "model":    { "name": "Qwen3.8-Flash", "engine": "vLLM", "nodes": "Dual DGX Spark" },
  "output":   { "tokPerSec": 257 },
  "requests": { "active": 8, "queued": 1, "capacity": 10 },
  "input":    { "tokPerSec": 1700, "prefillAvgMs": 320 },
  "kvCache":  { "usage": 0.16, "hitRate": 0.93, "headroom": "余量充足" },
  "mtp":      { "ratio": 0.69, "tar": 1.99 },
  "memory":   { "node": "S1", "usedGB": 105, "totalGB": 128, "freeGB": 23 },
  "gpu":      { "utilization": 0.93, "state": "计算中" }
}
```

**跨域（CORS）**：浏览器直连 vLLM 会被同源策略拦。两种解法：

1. 让 vLLM 放行：启动参数加 `--allowed-origins '*'`（或指定来源）；
2. 用 nginx/caddy 把 `/metrics` 反代到与页面同源。

本项目**不内置代理服务**，以保持零依赖。

## 开发与验证

```bash
node --test                                      # 60 个单测（纯逻辑 + 构建 + 对抗性边界）
node tools/probe.js                              # E2E 探针：真实 390x844 视口，51 项断言
node tools/probe.js --target=llm-monitor.html    # 同一套断言跑在离线单文件产物上
node build.js                                    # 由 src/ + styles.css 重新生成 llm-monitor.html
node tools/shot.js --out=ref/mine.png            # 截图，用于与 ref/ 参考图并排比对
```

探针与截图脚本自带静态服务器与无头 Edge（要求已安装 Edge；可用 `EDGE_PATH` 环境变量覆盖路径）。

## 目录结构

```
index.html                   开发入口（ESM 模块化）
styles.css                   设计 token 与布局（尺寸一律 calc(var(--u) * N)，--u = 面板宽度 1%）
src/format.js                数值格式化（越界/缺失一律占位符）
src/charts.js                SVG 几何：折线 path / 环形 dasharray / 柱条矩形
src/units.js                 等比缩放单位
src/store.js                 Snapshot 契约、环形缓冲、状态容器
src/scheduler.js             渲染节流（每个动画帧最多重绘一次）
src/render.js                静态结构 + 每帧更新 + 探针采集
src/sources/mock.js          模拟 vLLM 遥测引擎（可播种、确定性）
src/sources/http.js          JSON 轮询 + 降级/退避 + transform 注入
src/sources/vllm-metrics.js  Prometheus 文本解析与映射
build.js                     无依赖单文件构建
tools/probe.js               E2E 探针
tools/shot.js                截图
tools/frame.html             固定视口承载页（绕开无头 Edge 的最小窗口宽度）
tests/                       单测；tests/verify-sources.test.js 是独立对抗性验证
```

## 验收结果

| 验收项 | 结果 |
| --- | --- |
| 与参考截图并排比对，9 个区域一致 | ✅ 面板高宽比 1.4540 vs 参考 1.4518（差 0.16%） |
| 每秒刷新：数字/折线/进度条/三个环形/柱条 | ✅ 生产走 1s 采样 + rAF 合并，合并语义有单测 |
| 时钟为本地时间（秒级） | ✅ |
| 单文件双击离线可用 | ✅ 探针在 file:// 下 51/51 |
| vLLM metrics 解析 | ✅ 解析与映射有单测；端到端需你提供地址 |
| 端点异常显示"未连接"且布局不塌陷 | ✅ 探针断言面板宽高不变、曲线保留最后一帧 |
| node --test 全绿、无第三方依赖 | ✅ 60/60 |

## 已知限制

- 退避时序（间隔 × 2ⁿ 封顶 4×）没有精确计时断言：Windows 定时器粒度约 15ms，精确计时必然 flaky。
- 没有请求超时 / AbortController：若 fetch 永不 settle，该次轮询会一直占用（请求串行，不会堆积）。
- vLLM 模式只在单测与注入契约层面验证，未对接真实 vLLM 实例。
- 照片存在透视与反光，配色是按参考图反推的估计值；如需更准，请在真实设备上目视微调 styles.css 的 token。
