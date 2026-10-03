# Tokmeter（词元表）· Windows 桌面悬浮窗

把仓库里的零依赖面板 `llm-monitor.html` 包成一个 Windows 桌面悬浮窗：无边框、透明圆角、可拖动、默认置顶，
托盘图标控制显隐与视图，内置采集器（不用另开 node 进程），带 NSIS 安装包。

**本目录以外的仓库文件一律没有改动**（`src/`、`collector/`、`styles.css`、`index.html`、`llm-monitor.html`、
`tests/`、`tools/`、`build.js` 全部原样）。窗口拖拽样式是用 `webContents.insertCSS()` 在运行时注入的。

## 目录与职责

| 文件 | 职责 |
| --- | --- |
| `main.js` | 主进程：单实例锁、启动采集器、建窗口、建托盘、开关机自启、退出清理；`--selftest` / `--shot` / `--login-item` 诊断 |
| `lib/paths.js` | 资源路径解析（开发 = 仓库路径；安装后 = `process.resourcesPath`）与用户数据路径 |
| `lib/state.js` | 窗口位置/大小、置顶、当前视图的读写（`%APPDATA%\Tokmeter\state.json`，手写 JSON，无第三方存储库） |
| `lib/config-file.js` | 首次运行生成 `%APPDATA%\Tokmeter\collector.config.json` 模板 |
| `lib/collector-host.js` | 在主进程内 `import` 采集器并监听 127.0.0.1；端口占用等错误翻译成人话 |
| `lib/widget-window.js` | 悬浮窗（`frame:false` + `transparent:true` + `resizable:true` + `backgroundColor:'#00000000'`）、面板 URL、拖拽 CSS 注入、置顶 |
| `lib/tray.js` | 托盘图标与右键菜单 |
| `resources/collector-package.json` | 打进 `resources/collector/package.json` 的 `{"type":"module"}` 垫片，保证采集器 .js 在打包后被当 ESM 加载 |
| `package.json` | 依赖（electron 37.10.3 / electron-builder 26.x）+ `build` 打包配置（appId `com.tokmeter.app`、NSIS 可改安装目录） |

## 开发运行

```powershell
cd desktop
npm install                 # 已有 electron 缓存时不会再下载 electron 包
npx electron .              # 或 npm start
```

> ⚠️ 如果你的 shell 里带着 `ELECTRON_RUN_AS_NODE=1`（某些 Electron 宿主会自动设置），
> electron.exe 会退化成纯 Node，报 `does not provide an export named 'app'`。
> 先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE` 再启动。

自检（不弹窗口，跑完打印 JSON 并退出）：

```powershell
npx electron . --selftest --shot="$env:TEMP\tokmeter.png"
```

## 打包安装包

```powershell
cd desktop
npx electron-builder --win nsis     # 产物在 desktop/dist/
```

国内网络下务必先设镜像，否则 electron-builder 会去 GitHub 拉 133MB 的 electron 包
（实测约 100KB/s 且长时间卡在 `downloaded label=electron progress=100%` 之后）：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npx electron-builder --win nsis     # 设了镜像后本次实测 21.9s 完成
```

> 本机 shell 里可能带着 `ELECTRON_RUN_AS_NODE=1`（某些 Electron 宿主会自动注入），
> 打包/运行前 `Remove-Item Env:\ELECTRON_RUN_AS_NODE` 更稳妥。

输出 `Tokmeter-0.1.0-setup.exe`（NSIS，`oneClick:false` + `perMachine:false`，安装时可以自己选目录）。
安装包内只有必要文件；面板、采集器、图标、配置模板通过 `extraResources` 落到 `resources/`。

## 托盘菜单

| 菜单项 | 说明 |
| --- | --- |
| 采集器状态（灰显） | `127.0.0.1:<port> · live/stale/error`，5 秒刷新 |
| 显示/隐藏悬浮窗 | 左键单击托盘图标同效；文字随窗口可见性变化 |
| 始终置顶（可勾选） | 写 `state.json`，立即生效 |
| 切换视图 → 服务端 / 客户端 | 服务端 = 面板内置模拟引擎；客户端 = 连本机采集器 |
| 开机自启（可勾选） | `app.setLoginItemSettings`，HKCU 注册表 Run 项 |
| 打开配置文件 | `shell.openPath(%APPDATA%\Tokmeter\collector.config.json)`，没有关联程序时改为在资源管理器中选中 |
| 退出 Tokmeter | 真正退出（关窗口只是收进托盘） |

## 用户数据

| 路径 | 内容 |
| --- | --- |
| `%APPDATA%\Tokmeter\collector.config.json` | 采集器配置（首次运行从模板生成；`port` 默认 8787） |
| `%APPDATA%\Tokmeter\state.json` | 窗口位置/大小、置顶、当前视图 |

## 实现上踩过的坑（别改回去）

1. **主进程 ESM 入口不能有顶层 `await`**。Electron 要等模块图求值完才发 `ready`，
   顶层 `await app.whenReady()` 会把自己锁死（Electron 37.10.3 实测必现），必须用 `.then()`。
2. **Windows 上 `setAlwaysOnTop(true)` 是空操作**。默认 level `floating` 在 Windows 不生效，
   构造参数 `alwaysOnTop: true` 也不生效；只有显式 level（`'screen-saver'` / `'normal'`）才真的置顶。
   见 `lib/widget-window.js` 的 `applyAlwaysOnTop()`。
3. **打包后采集器 .js 需要 ESM 垫片**。`resources/collector/` 下没有 package.json 时 Node 会把 .js 当 CJS，
   所以 `extraResources` 额外塞了一个 `{"type":"module"}` 的 `collector/package.json`。
4. **配置模板里的中文 apiKey 会导致 HTTP 头报错**。HTTP 头只能放 Latin-1，
   中文占位会让采集器抛 `Cannot convert argument to a ByteString`；首次生成时已替换为 ASCII 占位
   `PUT-YOUR-KEY-HERE`（错误信息因此变成干净的 `上游 HTTP 401`）。
5. **状态里的 `x/y` 为 null 表示「没记过位置」**。`Number(null) === 0`，直接转换会把窗口丢到左上角；
   `lib/state.js` 里已经把 null/undefined/'' 挡掉，之后居中显示。

## 已知取舍

- 默认窗口 380×620，而面板内容在 380 宽下自然高度约 510（等比缩放），所以窗口底部会有一段透明空白
  （仍然属于窗口、会接收鼠标）。把窗口高度改成 510 左右可以贴住内容。
- Windows 上 `transparent: true` 的无边框窗口没有非客户区，`resizable: true` 已开，但用鼠标拖边缘改大小
  在部分 Windows 版本上无效（Electron 的已知限制）。
- 托盘图标在 Windows 11 上默认会被收进「隐藏的图标」浮出面板，需要用户手动固定到任务栏。
