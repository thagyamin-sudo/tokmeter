# Tokmeter

[中文](README.md) | **English** | [日本語](README.ja.md) | [한국어](README.ko.md)

> **Real-time status panel for LLM inference servers** — zero dependencies, offline-capable, single file.

![Reference design next to the Tokmeter replica](ref/compare.png)

*Left: reference design ｜ Right: the Tokmeter replica (panel aspect ratio 1.4540 vs reference 1.4518 — a 0.16% difference)*

Tokmeter is a pure **observation panel**: it does not proxy inference, does not rewrite your requests, and does not touch your model.
It simply draws what is happening right now, truthfully. The core artifact, `llm-monitor.html`, is a **single 79.4 KB file**
with all styles and scripts inlined — double-click it, and it runs offline. You can hand it to anyone.

---

## Features

- **Single file, zero dependencies**: `llm-monitor.html` runs straight from `file://` — no server, no network, no `npm install`.
- **Three data sources**: built-in mock engine (default) / server-side vLLM metrics / client-side collector (cloud APIs).
- **Server view**: output tok/s, input tok/s and average prefill time, request concurrency · queue · capacity, KV cache usage and hit rate, MTP acceptance ratio and TAR, VRAM usage, GPU utilization; a 60-point throughput chart, three ring gauges, and percentile bars.
- **Client view**: TTFT P50/P95, measured tok/s P50/P95, probe success rate and availability, token usage and estimated cost — only client-side metrics that can genuinely be measured.
- **Never fabricates data**: anything unavailable is rendered as `--`, never a fake `0` (a dedicated test pins this behaviour).
- **Graceful degradation**: when an endpoint fails, the status turns `stale` / `error` and the data area dims, while the **chart keeps its last frame and the layout never collapses**.
- **Three footer buttons**: refresh now / copy current status / pause·resume monitoring.
- **Optional dynamic island**: `?island=1` switches to the capsule form factor.
- **PWA**: installable via "Add to Home Screen" over http(s).
- **Windows desktop build**: frameless transparent floating window + tray control + embedded collector (no separate node process) + NSIS installer.
- **Zero third-party runtime dependencies**: the panel is plain JavaScript; the collector uses only Node built-ins.
- **Well tested**: 91 unit tests + 98 end-to-end probe assertions, all green.

---

## Installation

### Option 1 — Download the installer (recommended for Windows)

Grab **`Tokmeter-0.1.0-setup.exe`** (about 87.8 MB) from [Releases](https://github.com/thagyamin-sudo/tokmeter/releases/latest) and double-click it.

- NSIS installer (`oneClick: false` + `perMachine: false`) — **you choose the install directory**, and no admin rights are required.
- Creates a desktop shortcut and a Start Menu entry automatically.
- The uninstall entry appears as "Tokmeter（词元表）".

### Option 2 — Run from source (nothing to install, nothing to build)

**① Double-click the single file (simplest)**

Just double-click `llm-monitor.html` in the repository root. Styles and scripts are fully inlined, so it runs offline from `file://` —
you can also send it to someone else or drop it onto a phone.

**② Development mode (edit, then refresh — no build step)**

```bash
git clone https://github.com/thagyamin-sudo/tokmeter.git
cd tokmeter
python -m http.server 8000
# then open http://localhost:8000
```

> Any static server works (`npx serve`, `caddy file-server`, ...).
> PWA installation ("Add to Home Screen") requires http(s); opening the single file over `file://` does not support it.

---

## Usage guide

### 1. The three data sources

By default every number, chart and status indicator comes from the built-in **mock engine** (seedable and reproducible, ideal for demos and comparisons).
To point the panel at a real service, just add URL parameters — no code changes:

| Scenario | URL |
| --- | --- |
| Built-in mock (default) | `llm-monitor.html` |
| Native vLLM metrics endpoint | `llm-monitor.html?source=vllm&endpoint=http://127.0.0.1:8000/metrics` |
| Custom JSON endpoint | `llm-monitor.html?source=http&endpoint=http://127.0.0.1:9000/snapshot` |
| Cloud API client collector | `llm-monitor.html?view=client` |

**vLLM mode** reads these Prometheus metrics (whatever is missing falls back to the previous frame — it **never renders NaN**):
`vllm:num_requests_running`, `vllm:num_requests_waiting`, `vllm:avg_generation_throughput_toks_per_s`,
`vllm:gpu_cache_usage_perc`, `vllm:gpu_prefix_cache_hit_rate`. The model name is taken from the metric labels; if it cannot be found, the panel shows "unknown model".

**JSON mode** accepts an object shaped like the internal snapshot (missing fields fall back to the previous frame):

```json
{
  "model":    { "name": "Qwen3.8-Flash", "engine": "vLLM", "nodes": "Dual DGX Spark" },
  "output":   { "tokPerSec": 257 },
  "requests": { "active": 8, "queued": 1, "capacity": 10 },
  "input":    { "tokPerSec": 1700, "prefillAvgMs": 320 },
  "kvCache":  { "usage": 0.16, "hitRate": 0.93, "headroom": "ample headroom" },
  "mtp":      { "ratio": 0.69, "tar": 1.99 },
  "memory":   { "node": "S1", "usedGB": 105, "totalGB": 128, "freeGB": 23 },
  "gpu":      { "utilization": 0.93, "state": "computing" }
}
```

### 2. Connecting a cloud API (client view, two steps)

Cloud APIs never expose **server-internal quantities** such as KV cache, GPU utilization or VRAM. The client view therefore
does not pretend to show them; it displays only what is genuinely measurable, and renders everything else as `--`.

**Step 1 — fill in the config**

```bash
cp collector.config.example.json collector.config.json
# edit collector.config.json: at minimum baseUrl / apiKey / model
```

**Step 2 — start the collector**

```bash
node collector.js                        # reads collector.config.json next to it
node collector.js D:/path/my-config.json  # or point it at another config file
```

Then open the panel: `llm-monitor.html?view=client` (or `index.html?view=client` in development mode).

The collector does two things:

1. **Active probing** (default): sends one small streaming request every `probeEveryMs` (15 s by default, `max_tokens` 24, 5 s minimum interval) to measure TTFT and real tok/s — **without touching any of your applications**.
2. **Passive accounting** (`"proxy": true`): point your application's `base_url` at `http://127.0.0.1:8787/v1` to measure real traffic, token usage and cost.

![Client view connected to a real gateway](ref/live-client.png)

*Client view against a real gateway: TTFT, measured tok/s, success rate, usage and cost all come from live collector measurements*

![Client view](ref/client-view.png)

**Card mapping** (the default server view is pixel-for-pixel unchanged; only `?view=client` switches):

| Panel card | What the client view shows |
| --- | --- |
| Live output tokens | Measured output tok/s (streaming measurement) |
| Probe status | Successes / failures in the window + a success-rate bar |
| Input tokens | Prefill speed (`prompt_tokens ÷ TTFT`) |
| Response latency | First-token P50 (more rings = faster), P95 and sample count in the sidebar |
| Throughput percentile | P50 tok/s, P95 in the sidebar |
| Today's usage | Cumulative output/input tokens + estimated cost |
| Availability | Success rate within the window + bars (rate of each probe) |

> ⚠️ **Boundary**: the client view can only see requests that **pass through the collector**. Active probing reflects how fast
> your account responds right now; to account for your own application's real traffic and cost you must point its `base_url`
> at the collector (passive mode).

### 3. Desktop build: tray and floating window

After installing and launching Tokmeter you get a **frameless, transparent, rounded floating window** (380×620 by default, always-on-top by default) plus a **tray icon**.

**Floating window**:

- Drag any empty area to move it. Position, size, always-on-top state and the current view are all remembered in `%APPDATA%\Tokmeter\state.json`.
- Closing the window only **hides it to the tray** — it does not quit.

**Tray menu**:

| Menu item | Description |
| --- | --- |
| Collector status (greyed out) | `127.0.0.1:<port> · live/stale/error`, refreshed every 5 s |
| Show/hide floating window | Same as left-clicking the tray icon; the label follows window visibility |
| Always on top (checkable) | Writes `state.json`, takes effect immediately |
| Switch view → server / client | Server = the panel's built-in mock engine; client = connects to the local collector |
| Launch at login (checkable) | `app.setLoginItemSettings`, writes the HKCU Run key |
| Open config file | Opens `%APPDATA%\Tokmeter\collector.config.json` |
| Quit Tokmeter | Really quits (closing the window only hides it) |

The desktop build ships an **embedded collector** (imported directly into the main process and bound to `127.0.0.1`), so you do not need to
run `node collector.js` separately. On first launch it generates `%APPDATA%\Tokmeter\collector.config.json` from the template;
fill in your key and pick "Switch view → client" from the tray menu.

### 4. URL parameter reference

| Parameter | Values | Default | Description |
| --- | --- | --- | --- |
| `island` | `1` | off | Show the dynamic-island capsule form factor |
| `view` | `server` / `client` | `server` | Server view (matches the reference design) / client view (cloud API observation) |
| `source` | `mock` / `http` / `vllm` | `mock` | Data source type; `http` and `vllm` require `endpoint` |
| `endpoint` | URL | client view defaults to `http://127.0.0.1:8787/snapshot` | Data source address (JSON endpoint / Prometheus metrics / collector snapshot) |
| `seed` | integer | `7` | Mock-engine random seed; the same seed reproduces identical output |
| `test` | `1` | off | Deterministic test mode: frames are fed synchronously, no timers involved |
| `tick` | integer | `0` | Number of frames to step in test mode |
| `raf` | `1` | off | In test mode, use the real `requestAnimationFrame` render path |
| `freeze` | `HH:MM:SS` | off | Freeze the clock so output is reproducible |
| `press` | `power,copy,refresh` | empty | In test mode, auto-click footer buttons (comma-separated) |
| `inject` | `rate:<number>` | empty | Inject an extreme rate to verify wide numbers do not break the hero card |
| `name` | any string | empty | Override the model name to verify long names are truncated instead of breaking the header |
| `fail` | `stale` / `error` / `both` / `1` | empty | Force a degraded state to verify the layout does not collapse |

Combine parameters with `&`, for example:
`llm-monitor.html?source=vllm&endpoint=http://127.0.0.1:8000/metrics&island=1`

### 5. The three footer buttons

Three icon buttons sit at the bottom of the panel, left to right:

| Button | Title | What it does |
| --- | --- | --- |
| ⟳ Refresh | Refresh now | Immediately pulls one sample from the active data source (HTTP / vLLM / collector). Under the mock engine it only gives visual feedback. Flashes for 900 ms when pressed |
| ⧉ Copy | Copy current status | Formats the current snapshot as plain text and copies it to the clipboard (starts with `Tokmeter`; includes model, rates, requests, KV/GPU — and for the client view TTFT, probe counts, usage and cost, with `--` for unknown values). Falls back to `execCommand('copy')` on `file://` or when permission is denied |
| ⏻ Power | Pause/resume monitoring | While paused it stops the active data source entirely (no further requests are sent) and the button switches to its off state. Press again to resume polling |

---

## Configuration reference

`collector.config.json` (**gitignored — your key only ever lives on your machine**):

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `baseUrl` | string | `https://api.openai.com/v1` | OpenAI-compatible endpoint. Must start with `http://` or `https://`; trailing slashes are stripped |
| `apiKey` | string | `''` | Your API key. **Read only from this local file**; it never reaches the panel page and never appears in a `/snapshot` response |
| `model` | string | `gpt-4o-mini` | Model name, **must not be empty** |
| `port` | number | `8787` | Collector port (`1`–`65535`). Bound to `127.0.0.1` only; never exposed to the LAN |
| `probeEveryMs` | number | `15000` | Active-probe interval in milliseconds. **Must be at least 5000** — the lower bound that keeps probing cheap |
| `probeMaxTokens` | number | `24` | `max_tokens` for each probe request, `1`–`512` |
| `probePrompt` | string | `用一句话说明什么是缓存。` | Prompt used for probing. Keep it short to save tokens |
| `proxy` | boolean | `false` | Enable the OpenAI-compatible proxy. When on, point your app's `base_url` at `http://127.0.0.1:8787/v1` for **passive accounting of real traffic** |
| `pricing.inPerM` | number | `0` | Input token price (**USD per million tokens**) used for cost estimation |
| `pricing.outPerM` | number | `0` | Output token price (**USD per million tokens**) |
| `timeoutMs` | number | `30000` | Upstream request timeout in milliseconds, at least `1000` |

If the config is wrong, the collector prints a readable error at startup (for example `baseUrl must start with http:// or https://`) instead of a stack trace.

**The collector exposes exactly three endpoints**:

| Endpoint | Description |
| --- | --- |
| `GET /snapshot` | The client-view data the panel needs (**never contains apiKey**) |
| `GET /health` | Liveness probe: `{"ok": true, "status": "live"}` |
| `POST /v1/*` | Optional (only with `proxy: true`): OpenAI-compatible forwarding; the key is injected server-side and never reaches the client |

---

## FAQ

### Q1: The browser hits a CORS error when connecting straight to vLLM. What now?

The same-origin policy blocks direct browser access. Two solutions:

1. **Let vLLM allow it**: add `--allowed-origins '*'` to its launch arguments (in production, list explicit origins rather than `*`).
2. **Reverse proxy**: use nginx / caddy to proxy `/metrics` onto the same origin as the page, then use `?source=vllm&endpoint=/metrics`.

This project deliberately **ships no proxy service**, in order to stay zero-dependency.
(The collector's own `/snapshot` already sends `Access-Control-Allow-Origin: *`, so the panel never has a CORS problem talking to it.)

### Q2: The panel keeps showing "disconnected" / cannot connect?

Work through this list in order:

1. **Is the URL right?** `endpoint` must be a full address with a scheme, e.g. `http://127.0.0.1:8000/metrics`, not `127.0.0.1:8000`.
2. **Is the endpoint alive?** Open it directly in a browser and confirm it returns JSON / Prometheus text. vLLM's metrics port is often not the same as its inference port.
3. **Is the collector running?** The client view defaults to `http://127.0.0.1:8787/snapshot`; opening that should show JSON. If not, check whether `node collector.js` printed an error.
4. **Check `/health`.** The `status` it returns is one of `connecting` / `live` / `stale` / `error`, which distinguishes "collector not running" from "upstream unreachable".
5. **Upstream errors.** If `client.lastError` in `/snapshot` says `上游 HTTP 401`, your key or baseUrl is wrong.

The panel never white-screens on failure: the status turns red, the data area dims, the **chart keeps its last frame and the panel keeps its size**.

### Q3: What does `--` mean?

`--` means **this quantity cannot be obtained from the current data source** — not zero, and not an error. This is deliberate:

- Cloud APIs do not expose KV cache / VRAM / GPU / MTP, so those cards stay `--` in the client view.
- When a vLLM version does not expose a metric, that field shows `--` rather than a fabricated `0`.
- Before any probe has succeeded, P50 / P95 are `--` too.

A dedicated test pins this: **"missing metrics must be unknown (NaN → `--` in the UI), never a fake 0"**.

### Q4: How do I fill in the cost prices (`pricing`)?

`inPerM` / `outPerM` are **USD per million tokens** — copy them straight from your provider's price list:

```json
"pricing": { "inPerM": 0.27, "outPerM": 1.1 }
```

- Example: $0.27 per million input tokens and $1.10 per million output tokens → fill it in exactly as above.
- **If unsure, use 0.** Cost then shows `$0.00`, but token usage stays accurate — usage and cost are computed separately.
- If your price list is per thousand tokens, multiply by 1000 before filling it in.
- Amounts are in USD. To report in another currency, convert it yourself (the panel does no FX conversion).
- Cost only covers traffic that **passes through the collector**, including the small amount consumed by active probing.

### Q5: Does active probing cost a lot?

Once every 15 seconds with `max_tokens: 24` is roughly 240 short requests per hour — on the order of **a few cents per day** at typical prices.
Three safeguards: a hard 5000 ms floor on `probeEveryMs`, a 512 cap on `probeMaxTokens`, and **serial execution** (if the previous probe has not returned, the next one is skipped, so nothing piles up).

### Q6: Why is there a transparent strip at the bottom of the desktop window?

A known trade-off: the default window is 380×620, while the panel's natural height at 380 wide is about 510 (uniform scaling).
That strip still belongs to the window and receives mouse events. Setting the window height to about 510 makes it hug the content.

---

## Security

- **Keys stay local**: `apiKey` is read only from `collector.config.json`, which is listed in the repository's root `.gitignore` and is **never committed**.
- **Never commit secrets**: the repository ships only `collector.config.example.json` (a placeholder version). Before committing, confirm `collector.config.json` is not staged.
- **The panel page contains no key**: `llm-monitor.html` is a pure static file with no secrets in it; with `?view=client` the browser only asks the local collector for data.
- **`/snapshot` never returns the key**: the collector binds to `127.0.0.1` only and its response body contains no `apiKey` (covered by tests).
- **The key is injected server-side when proxying**: with `proxy: true`, headers sent by the client are discarded and the key is added by the collector process, so the front end never sees it.
- **Minimal surface**: the collector exposes only `GET /snapshot`, `GET /health` and (optionally) `POST /v1/*`.
- **Read-only CORS**: `/snapshot` sends `Access-Control-Allow-Origin: *`, but it is a read-only endpoint, bound to localhost, containing no secrets.
- **Pre-commit check**: `collector.config.json` must never appear in `git status --short`.

---

## Development and verification

```bash
node --test                                     # unit tests (pure logic + build + adversarial edge cases + real HTTP end-to-end + collector)
node tools/probe.js                             # E2E probe: server view + client view + narrow screen, in a real headless browser
node tools/probe.js --target=llm-monitor.html   # the same assertions against the offline single-file artifact
node build.js                                   # regenerate llm-monitor.html from src/ + styles.css
node tools/shot.js --out=ref/mine.png           # screenshot, for side-by-side comparison with ref/
```

The probe and screenshot scripts bring their own static server and headless Edge (Edge must be installed; override the path with the `EDGE_PATH` environment variable).

### Verified numbers (measured locally, Node v24.18.0 / Windows)

| Check | Command | Result |
| --- | --- | --- |
| Unit tests | `node --test` | **91 / 91 passed**, 0 failed, about 2.8 s |
| End-to-end probe | `node tools/probe.js` | **98 / 98 assertions passed** (viewport 390×844, panel 358.8×521.89) |
| Single-file probe | `node tools/probe.js --target=llm-monitor.html` | **92 / 92 assertions passed** (viewport 504×805, panel 420×610.56) |
| Single-file build | `node build.js` | `llm-monitor.html` at 81,299 bytes (79.4 KB), 11 inlined modules; repeat builds are **byte-identical (SHA256)** |
| Installer | `Tokmeter-0.1.0-setup.exe` | 92,069,277 bytes (87.8 MB), SHA256 `9CDD7BAF…C5165F90` |

Single-file artifact SHA256: `70A5DCAF1AA9FD75CC2180C2F5A3568C34C662EE9C9DD447C449EB2674F670A3`

### Fidelity to the reference design

| Acceptance item | Result |
| --- | --- |
| Side-by-side comparison, 9 regions match | ✅ panel aspect ratio 1.4540 vs reference 1.4518 (0.16% difference) |
| Very narrow viewport (320 px) does not overflow and keeps its proportions | ✅ asserted by the probe's narrow-screen run |
| Extreme magnitude changes (2.3M) do not break the hero card | ✅ probe injects a frame and asserts numbers + units never intrude into the chart area |
| Per-second refresh: numbers / chart / progress bar / three rings / bars | ✅ production samples at 1 s with rAF coalescing; the coalescing semantics are unit-tested |
| The single file works offline when double-clicked | ✅ the probe passes fully over `file://` (6 narrow-screen items need an iframe host and are explicitly skipped) |
| Failed endpoints show "disconnected" without collapsing the layout | ✅ the probe asserts the panel keeps its size and the chart keeps its last frame |

---

## Repository layout

```
llm-monitor.html              ← build artifact: zero-dependency single-file panel (double-click to run)
index.html                    development entry point (ESM modules)
styles.css                    design tokens and layout (all sizes are calc(var(--u) * N), --u = 1% of panel width)
src/app.js                    assembly layer: URL params → data source → sampling → rAF-coalesced rendering
src/format.js                 number formatting (out-of-range/missing always becomes the -- placeholder)
src/charts.js                 SVG geometry: line paths / ring dasharray / bar rectangles
src/units.js                  proportional scaling units
src/store.js                  Snapshot contract, ring buffer, state container
src/scheduler.js              render throttling (at most one repaint per animation frame)
src/render.js                 static structure + per-frame updates + probe collection
src/sources/mock.js           mock vLLM telemetry engine (seedable, deterministic)
src/sources/http.js           JSON polling + degradation/backoff + transform injection
src/sources/vllm-metrics.js   Prometheus text parsing and mapping
src/sources/client.js         client-view payload mapping
collector.js                  collector entry point (node collector.js)
collector/config.js           config defaults + validation
collector/server.js           HTTP service: /snapshot, /health, optional /v1 proxy
collector/openai-probe.js     OpenAI streaming response measurement (TTFT / tok/s)
collector/stats.js            sliding-window statistics (P50/P95, success rate, usage, cost)
collector.config.example.json config template (placeholder key)
build.js                      dependency-free single-file build
tools/probe.js                E2E probe
tools/shot.js                 screenshots
desktop/                      Windows desktop build (Electron shell + embedded collector + NSIS installer)
tests/                        unit tests (91)
ref/                          reference screenshots and comparison artifacts
```

---

## Known limitations

- **Never tested against a real vLLM instance**: vLLM mode is verified end-to-end over real HTTP against a locally faked `/metrics`, but compatibility with field names that change between versions needs measuring on your own instance.
- **No precise timing assertions for backoff**: Windows timer granularity is about 15 ms, so exact timing would inevitably be flaky; only behaviour is asserted, not milliseconds.
- **Requests have no timeout / AbortController**: if `fetch` never settles, that poll occupies its slot forever (requests are serial, so nothing piles up). The collector has `timeoutMs` as a safeguard.
- **Colours are estimates reverse-engineered from photographs**: the reference images have perspective distortion and reflections; for greater accuracy, tune the `styles.css` tokens by eye on real hardware.
- **Desktop build**: on some Windows versions resizing the frameless transparent window by dragging its edges does not work (a known Electron limitation); on Windows 11 the tray icon is hidden in the overflow panel by default and must be pinned to the taskbar manually.

---

## License

[MIT](LICENSE) © 2026 thagyamin-sudo
