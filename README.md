# Tokmeter（词元表）

**中文** | [English](README.en.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

> **LLM 推理服务的实时状态面板** —— 零依赖、可离线、单文件。

![参考设计稿与 Tokmeter 成品并排比对](ref/compare.png)

*左：参考设计稿 ｜ 右：Tokmeter 复刻成品（面板高宽比 1.4540 vs 参考 1.4518，误差 0.16%）*

Tokmeter 是一个纯粹的**观测面板**：它不代理推理、不改写你的请求、不碰你的模型，只把「现在跑得怎么样」如实画出来。
核心产物 `llm-monitor.html` 是一份 **79.4 KB 的单文件**（样式与脚本全部内联），双击即用、可离线、可随手转发。

---

## 功能特性

- **单文件零依赖**：`llm-monitor.html` 在 `file://` 下直接运行，不需要服务器、不需要联网、不需要 `npm install`。
- **三种数据源**：内置模拟引擎（默认）/ 服务端 vLLM metrics / 客户端采集器（云 API）。
- **服务端视图**：输出 tok/s、输入 tok/s 与 Prefill 平均耗时、请求并发·排队·容量、KV Cache 占用与命中率、MTP 接受率与 TAR、显存占用、GPU 利用率；60 点速率曲线、三个环形进度、分位柱条。
- **客户端视图**：TTFT P50/P95、实测 tok/s P50/P95、探测成功率与可用率、token 用量与成本估算——只显示真实可测的客户端指标。
- **绝不编造数据**：拿不到的字段一律显示 `--`，不会伪造 `0`（有专门测试钉住这条）。
- **自动降级**：端点异常时状态转为 `stale` / `error` 并把数据区压暗，**曲线保留最后一帧、布局不塌陷**。
- **页脚三键**：立即刷新 / 复制当前状态 / 暂停·恢复监测。
- **可选灵动岛**：`?island=1` 唤出胶囊形态。
- **PWA**：在 http(s) 下可「添加到主屏幕」。
- **Windows 桌面版**：无边框透明悬浮窗 + 托盘控制 + 内置采集器（不用另开 node 进程）+ NSIS 安装包。
- **零第三方运行时依赖**：面板是原生 JS，采集器只用 Node 内置模块。
- **测试完备**：91 个单元测试 + 98 项端到端探针断言，全绿。

---

## 安装

### 方式一：直接下载安装包（推荐给 Windows 用户）

到 [Releases](https://github.com/thagyamin-sudo/tokmeter/releases/latest) 下载 **`Tokmeter-0.1.0-setup.exe`**（约 87.8 MB），双击安装。

- 安装包是 NSIS 格式（`oneClick: false` + `perMachine: false`），**安装时可以自己选目录**，不需要管理员权限。
- 自动创建桌面快捷方式与开始菜单项。
- 卸载入口显示为「Tokmeter（词元表）」。

### 方式二：从源码运行（零安装、零依赖）

**① 双击单文件（最简单）**

直接双击仓库根目录的 `llm-monitor.html`。样式与脚本已全部内联，`file://` 下即可离线运行，也可以直接发给别人或丢进手机里。

**② 开发模式（改完刷新即可，无需构建）**

```bash
git clone https://github.com/thagyamin-sudo/tokmeter.git
cd tokmeter
python -m http.server 8000
# 浏览器打开 http://localhost:8000
```

> 任何静态服务器都可以（`npx serve`、`caddy file-server` 等）。
> PWA 安装（「添加到主屏幕」）只在 http(s) 下可用；单文件 `file://` 打开不支持安装。

---

## 详细使用指南

### 1. 三种数据源

界面右上角状态、曲线与所有数字，默认来自内置的**模拟引擎**（可播种、可复现，便于演示与比对）。
指向真实服务时加 URL 参数即可，无需改代码：

| 场景 | URL |
| --- | --- |
| 内置模拟（默认） | `llm-monitor.html` |
| vLLM 原生 metrics 端点 | `llm-monitor.html?source=vllm&endpoint=http://127.0.0.1:8000/metrics` |
| 自定义 JSON 端点 | `llm-monitor.html?source=http&endpoint=http://127.0.0.1:9000/snapshot` |
| 云 API 客户端采集器 | `llm-monitor.html?view=client` |

**vLLM 模式**读取这些 Prometheus 指标（缺哪个就沿用上一帧，**不会显示 NaN**）：
`vllm:num_requests_running`、`vllm:num_requests_waiting`、`vllm:avg_generation_throughput_toks_per_s`、
`vllm:gpu_cache_usage_perc`、`vllm:gpu_prefix_cache_hit_rate`。模型名从指标标签里取，取不到就显示「未知模型」。

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

### 2. 接入云 API（客户端视图，两步）

云 API 不会暴露 KV Cache / GPU / 显存这些**服务端内部量**，所以客户端视图不装服务端指标，
只显示真实可测的客户端指标，拿不到的一律 `--`。

**第一步：填配置**

```bash
cp collector.config.example.json collector.config.json
# 编辑 collector.config.json，至少填 baseUrl / apiKey / model
```

**第二步：启动采集器**

```bash
node collector.js                       # 默认读同目录 collector.config.json
node collector.js D:/path/my-config.json # 也可以指定配置文件
```

然后打开面板：`llm-monitor.html?view=client`（开发入口为 `index.html?view=client`）。

采集器做两件事：

1. **主动探测**（默认）：每 `probeEveryMs` 发一次小流式请求（默认 15 秒、`max_tokens` 24，最小间隔 5 秒），量 TTFT 与真实 tok/s —— **不用改你任何应用**。
2. **被动统计**（`"proxy": true`）：把你应用的 `base_url` 指到 `http://127.0.0.1:8787/v1`，统计真实流量、token 用量与成本。

![客户端视图接真实网关](ref/live-client.png)

*客户端视图接真实网关：TTFT、实测 tok/s、成功率、用量与成本都来自采集器实测*

![客户端视图](ref/client-view.png)

**卡片对应关系**（默认服务端视图逐像素不变，只有 `?view=client` 才切换）：

| 面板卡片 | 客户端视图显示 |
| --- | --- |
| 实时输出 Token | 实测输出 tok/s（流式测速） |
| 探测状态 | 窗口内成功/失败数 + 成功率进度条 |
| 输入 Token | Prefill 速度（`prompt_tokens ÷ TTFT`） |
| 响应延迟 | 首 Token P50（环越多越快），侧栏 P95 与样本数 |
| 吞吐分位 | P50 tok/s，侧栏 P95 |
| 今日用量 | 输出/输入 token 累计 + 估算成本 |
| 可用率 | 窗口内成功率 + 柱条（每次探测的速率） |

> ⚠️ **边界**：客户端视图只看得到「**经过采集器**」的请求。主动探测反映的是你账号当前调用的响应速度；
> 要统计你自己应用的真实流量与成本，必须把应用的 `base_url` 指向采集器（被动模式）。

### 3. 桌面版：托盘与悬浮窗

安装后运行 Tokmeter，会出现一个**无边框透明圆角悬浮窗**（默认 380×620、默认置顶）和一枚**托盘图标**。

**悬浮窗**：

- 拖动任意空白处即可移动窗口；窗口位置、大小、置顶状态、当前视图都会记住（存在 `%APPDATA%\Tokmeter\state.json`）。
- 关掉窗口只是**收进托盘**，不是退出。

**托盘菜单**：

| 菜单项 | 说明 |
| --- | --- |
| 采集器状态（灰显） | `127.0.0.1:<port> · live/stale/error`，5 秒刷新 |
| 显示/隐藏悬浮窗 | 左键单击托盘图标同效；文字随窗口可见性变化 |
| 始终置顶（可勾选） | 写 `state.json`，立即生效 |
| 切换视图 → 服务端 / 客户端 | 服务端 = 面板内置模拟引擎；客户端 = 连本机采集器 |
| 开机自启（可勾选） | `app.setLoginItemSettings`，写 HKCU 注册表 Run 项 |
| 打开配置文件 | 打开 `%APPDATA%\Tokmeter\collector.config.json` |
| 退出 Tokmeter | 真正退出（关窗口只是收进托盘） |

桌面版**内置采集器**（主进程内直接 import 采集器并监听 `127.0.0.1`），所以不需要另外开一个 `node collector.js`。
首次运行会从模板生成 `%APPDATA%\Tokmeter\collector.config.json`，填好 key 后在托盘菜单里「切换视图 → 客户端」即可。

### 4. URL 参数表

| 参数 | 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `island` | `1` | 关闭 | 显示灵动岛胶囊形态 |
| `view` | `server` / `client` | `server` | 服务端视图（对齐参考设计稿）/ 客户端视图（云 API 观测） |
| `source` | `mock` / `http` / `vllm` | `mock` | 数据源类型；`http` 与 `vllm` 必须同时给 `endpoint` |
| `endpoint` | URL | 客户端视图默认 `http://127.0.0.1:8787/snapshot` | 数据源地址（JSON 端点 / Prometheus metrics / 采集器快照） |
| `seed` | 整数 | `7` | 模拟引擎随机种子，同种子结果完全可复现 |
| `test` | `1` | 关闭 | 确定性测试模式：同步喂帧，不依赖定时器 |
| `tick` | 整数 | `0` | 测试模式下步进的帧数 |
| `raf` | `1` | 关闭 | 测试模式下改走真实 `requestAnimationFrame` 渲染路径 |
| `freeze` | `HH:MM:SS` | 关闭 | 冻结时钟，让输出可复现 |
| `press` | `power,copy,refresh` | 空 | 测试模式下自动点击页脚按钮（逗号分隔） |
| `inject` | `rate:<数值>` | 空 | 注入极端速率，验证数字变宽不挤坏 Hero 卡 |
| `name` | 任意字符串 | 空 | 覆盖模型名，验证超长名称省略而不撑破标题区 |
| `fail` | `stale` / `error` / `both` / `1` | 空 | 强制降级状态，验证异常时布局不塌陷 |

多个参数用 `&` 连接，例如：
`llm-monitor.html?source=vllm&endpoint=http://127.0.0.1:8000/metrics&island=1`

### 5. 页脚三个按钮

面板底部有三个图标按钮，从左到右：

| 按钮 | 标题 | 作用 |
| --- | --- | --- |
| ⟳ 刷新 | 立即刷新 | 对当前数据源立刻拉一次数据（HTTP / vLLM / 采集器）；模拟引擎下只是给出视觉反馈。按下后有 900ms 高亮闪烁 |
| ⧉ 复制 | 复制当前状态 | 把当前快照整理成一段纯文本摘要复制到剪贴板（以 `Tokmeter` 开头，含模型名、速率、请求、KV/GPU；客户端视图含 TTFT、探测次数、用量与成本，未知量显示 `--`）。`file://` 或权限不足时自动降级到 `execCommand('copy')` |
| ⏻ 电源 | 暂停/恢复监测 | 暂停时停掉当前数据源（不再发任何请求），按钮转为关闭态；再按一次恢复轮询 |

---

## 配置字段说明

`collector.config.json`（**已 gitignore，密钥只存在你本机**）：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `baseUrl` | string | `https://api.openai.com/v1` | OpenAI 兼容接口地址。必须以 `http://` 或 `https://` 开头；结尾多余的 `/` 会被自动去掉 |
| `apiKey` | string | `''` | 你的 API Key。**只从本机这个文件读**，绝不出现在面板页面，也绝不出现在 `/snapshot` 响应里 |
| `model` | string | `gpt-4o-mini` | 模型名，**不能为空** |
| `port` | number | `8787` | 采集器监听端口（`1~65535`）。只监听 `127.0.0.1`，不对局域网暴露 |
| `probeEveryMs` | number | `15000` | 主动探测间隔（毫秒）。**不得小于 5000**——这是防止探测烧钱的下限 |
| `probeMaxTokens` | number | `24` | 每次探测请求的 `max_tokens`，取值 `1~512` |
| `probePrompt` | string | `用一句话说明什么是缓存。` | 探测用的提示词。建议用短提示，省 token |
| `proxy` | boolean | `false` | 开启 OpenAI 兼容转发。开启后把应用的 `base_url` 指到 `http://127.0.0.1:8787/v1`，即可**被动统计真实流量** |
| `pricing.inPerM` | number | `0` | 输入 token 单价（**美元 / 每百万 token**），用于估算成本 |
| `pricing.outPerM` | number | `0` | 输出 token 单价（**美元 / 每百万 token**） |
| `timeoutMs` | number | `30000` | 单次上游请求超时（毫秒），不得小于 `1000` |

配置写错时采集器会在启动时打印可读的中文错误（例如 `baseUrl 必须以 http:// 或 https:// 开头`），不会带一堆堆栈。

**采集器只暴露三个端点**：

| 端点 | 说明 |
| --- | --- |
| `GET /snapshot` | 面板要的客户端视图数据（**不含 apiKey**） |
| `GET /health` | 存活探针：`{"ok": true, "status": "live"}` |
| `POST /v1/*` | 可选（仅 `proxy: true`）：OpenAI 兼容转发，key 由服务端注入，客户端拿不到 |

---

## 常见问题

### Q1：浏览器直连 vLLM 报 CORS 错误怎么办？

浏览器直连会被同源策略拦下。两种解法：

1. **让 vLLM 放行**：启动参数加 `--allowed-origins '*'`（生产环境建议写明具体来源而不是 `*`）；
2. **反向代理**：用 nginx / caddy 把 `/metrics` 反代到与页面同源，然后 `?source=vllm&endpoint=/metrics`。

本项目**不内置代理服务**，以保持零依赖。
（采集器自己的 `/snapshot` 已带 `Access-Control-Allow-Origin: *`，所以面板连采集器不会有 CORS 问题。）

### Q2：面板一直显示「未连接」/ 连不上？

按顺序排查：

1. **URL 对不对**：`endpoint` 必须是完整地址且带协议，例如 `http://127.0.0.1:8000/metrics`，不是 `127.0.0.1:8000`。
2. **端点在不在**：先在浏览器里直接打开那个 endpoint，确认返回 JSON / Prometheus 文本；vLLM 的 metrics 端口常常和推理端口不是同一个。
3. **采集器起没起**：客户端视图默认连 `http://127.0.0.1:8787/snapshot`，直接访问它应该看到 JSON。看不到就先检查 `node collector.js` 有没有报错。
4. **看 `/health`**：采集器返回的 `status` 会是 `connecting` / `live` / `stale` / `error`，能直接区分「采集器没起来」和「上游连不上」。
5. **上游报错**：如果 `/snapshot` 里的 `client.lastError` 写着 `上游 HTTP 401`，就是 key 或 baseUrl 不对。

面板在异常时不会白屏：状态变红、数据区压暗，**曲线保留最后一帧，面板尺寸不变**。

### Q3：界面上显示 `--` 是什么意思？

`--` 表示**这个量在当前数据源下拿不到**，而不是 0，也不是出错。这是刻意设计的：

- 云 API 不暴露 KV Cache / 显存 / GPU / MTP，所以客户端视图里这些卡片恒为 `--`；
- vLLM 少了某个指标（版本差异、未启用）时，对应字段显示 `--`，而不是编造一个 `0`；
- 探测还没跑满（一次都没成功）时，P50 / P95 也是 `--`。

有一条专门的测试钉住这个行为：**「缺失的指标必须是未知（NaN → 界面显示 `--`），不能是假 0」**。

### Q4：成本单价（`pricing`）怎么填？

`inPerM` / `outPerM` 的单位是 **美元 / 每百万 token**，直接照抄你服务商的价目表：

```json
"pricing": { "inPerM": 0.27, "outPerM": 1.1 }
```

- 例：输入 $0.27 / 百万 token、输出 $1.10 / 百万 token，就照上面这么填。
- **不确定就填 0**，此时成本显示 `$0.00`，但 token 用量仍然准确——用量和成本是分开算的。
- 如果你的价目表是「每千 token」，先乘以 1000 再填。
- 币种是美元；想用人民币计价，请自行换算后填入（面板不做汇率转换）。
- 成本只统计**经过采集器**的流量，主动探测的那点消耗也计入。

### Q5：主动探测会不会很费钱？

默认 15 秒一次、`max_tokens: 24`，一小时约 240 次短请求。按常见价格算是**每天几分钱**量级。
三个保险：`probeEveryMs` 硬下限 5000 毫秒、`probeMaxTokens` 上限 512、探测**串行执行**（上一轮没回来就跳过，不会堆积）。

### Q6：桌面版窗口底部有一段透明空白？

这是已知取舍：默认窗口 380×620，而面板内容在 380 宽下自然高度约 510（等比缩放）。
把那一段仍然属于窗口、会接收鼠标。把窗口高度改成 510 左右就能贴住内容。

---

## 安全说明

- **Key 只存本地**：`apiKey` 只从 `collector.config.json` 读取，这个文件在仓库根目录的 `.gitignore` 里，**永远不会被提交**。
- **绝不提交密钥**：仓库里只有 `collector.config.example.json`（占位符版本）。提交前请确认 `collector.config.json` 不在暂存区。
- **面板页面不含 key**：`llm-monitor.html` 是纯静态文件，里面没有任何密钥；浏览器拿 `?view=client` 时只向本机采集器要数据。
- **`/snapshot` 绝不返回 key**：采集器只监听 `127.0.0.1`，且响应体里不含 `apiKey`（有测试覆盖）。
- **转发时 key 由服务端注入**：`proxy: true` 时，客户端发来的请求头会被丢弃，key 由采集器进程加上去，前端拿不到。
- **最小暴露面**：采集器只暴露 `GET /snapshot`、`GET /health`，以及（可选）`POST /v1/*`。
- **只读跨域**：`/snapshot` 带 `Access-Control-Allow-Origin: *`，但它是只读接口、只监听本机、且不含任何密钥。
- **提交前自检**：`git status --short` 里不应出现 `collector.config.json`。

---

## 开发与验证

```bash
node --test                                  # 单元测试（纯逻辑 + 构建 + 对抗性边界 + 真实 HTTP 端到端 + 采集器）
node tools/probe.js                          # E2E 探针：服务端视图 + 客户端视图 + 窄屏，跑在真实无头浏览器里
node tools/probe.js --target=llm-monitor.html  # 同一套断言跑在离线单文件产物上
node build.js                                # 由 src/ + styles.css 重新生成 llm-monitor.html
node tools/shot.js --out=ref/mine.png        # 截图，用于与 ref/ 参考图并排比对
```

探针与截图脚本自带静态服务器与无头 Edge（要求已安装 Edge；可用 `EDGE_PATH` 环境变量覆盖路径）。

### 已验证的测试数字（本机实测，Node v24.18.0 / Windows）

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `node --test` | **91 / 91 通过**，0 失败，约 2.8 秒 |
| 端到端探针 | `node tools/probe.js` | **98 / 98 断言通过**（视口 390×844，面板 358.8×521.89） |
| 单文件构建 | `node build.js` | 输出 `llm-monitor.html` 81,299 字节（79.4 KB），内联模块 11 个；重复构建 **SHA256 逐字节一致** |
| 安装包 | `Tokmeter-0.1.0-setup.exe` | 92,069,277 字节（87.8 MB），SHA256 `9CDD7BAF…C5165F90` |

单文件产物 SHA256：`70A5DCAF1AA9FD75CC2180C2F5A3568C34C662EE9C9DD447C449EB2674F670A3`

### 与参考设计稿的一致性

| 验收项 | 结果 |
| --- | --- |
| 与参考截图并排比对，9 个区域一致 | ✅ 面板高宽比 1.4540 vs 参考 1.4518（差 0.16%） |
| 极窄视口（320px）不溢出、比例不变 | ✅ 探针窄屏运行断言 |
| 数值量级突变（2.3M）不挤坏 Hero | ✅ 探针注入帧断言「数字+单位不侵入折线区」 |
| 每秒刷新：数字/折线/进度条/三个环形/柱条 | ✅ 生产走 1s 采样 + rAF 合并，合并语义有单测 |
| 单文件双击离线可用 | ✅ 探针在 `file://` 下全通过（窄屏 6 项需 iframe 承载，显式跳过） |
| 端点异常显示「未连接」且布局不塌陷 | ✅ 探针断言面板宽高不变、曲线保留最后一帧 |

---

## 目录结构

```
llm-monitor.html              ← 构建产物：零依赖单文件面板（双击即用）
index.html                    开发入口（ESM 模块化）
styles.css                    设计 token 与布局（尺寸一律 calc(var(--u) * N)，--u = 面板宽度 1%）
src/app.js                    装配层：URL 参数 → 数据源 → 采样 → rAF 合并渲染
src/format.js                 数值格式化（越界/缺失一律占位符 --）
src/charts.js                 SVG 几何：折线 path / 环形 dasharray / 柱条矩形
src/units.js                  等比缩放单位
src/store.js                  Snapshot 契约、环形缓冲、状态容器
src/scheduler.js              渲染节流（每个动画帧最多重绘一次）
src/render.js                 静态结构 + 每帧更新 + 探针采集
src/sources/mock.js           模拟 vLLM 遥测引擎（可播种、确定性）
src/sources/http.js           JSON 轮询 + 降级/退避 + transform 注入
src/sources/vllm-metrics.js   Prometheus 文本解析与映射
src/sources/client.js         客户端视图载荷映射
collector.js                  采集器入口（node collector.js）
collector/config.js           配置默认值 + 校验
collector/server.js           HTTP 服务：/snapshot、/health、可选 /v1 转发
collector/openai-probe.js     OpenAI 流式响应测量（TTFT / tok/s）
collector/stats.js            滑动窗口统计（P50/P95、成功率、用量、成本）
collector.config.example.json 配置模板（含占位符 key）
build.js                      无依赖单文件构建
tools/probe.js                E2E 探针
tools/shot.js                 截图
desktop/                      Windows 桌面版（Electron 外壳 + 内置采集器 + NSIS 安装包）
tests/                        单元测试（91 个）
ref/                          参考截图与比对产物
```

---

## 已知限制

- **未对接过真实 vLLM 实例**：vLLM 模式已用本地伪造的 `/metrics` 做真实 HTTP 端到端验证，但字段名随版本变化的兼容性需要你在真实实例上实测。
- **退避时序没有精确计时断言**：Windows 定时器粒度约 15ms，精确计时必然 flaky，所以只断言了行为不测毫秒数。
- **请求没有超时 / AbortController**：若 `fetch` 永不 settle，该次轮询会一直占用（请求串行，不会堆积）。采集器侧有 `timeoutMs` 兜底。
- **配色是按照片反推的估计值**：参考图存在透视与反光；如需更准，请在真实设备上目视微调 `styles.css` 的 token。
- **桌面版**：透明无边框窗口在部分 Windows 版本上拖边缘改大小无效（Electron 已知限制）；托盘图标在 Windows 11 上默认会被收进「隐藏的图标」面板，需要手动固定到任务栏。

---

## License

[MIT](LICENSE) © 2026 thagyamin-sudo
