# 05｜多端演进架构：macOS / iOS / Android 与后端适配设计

在 2026-11-19 拍板「功能模块走 **Flutter 原生界面路线**」时，您同步明确了产品的长期多端规划：**Windows 之后将扩展至 macOS、iOS 与 Android**。

本文结合当前代码库对 Windows 平台耦合点的实查结果，回答两个关键问题：
1. **前端 Flutter 如何做到一套 UI 与模块代码顺滑迁移到 macOS / iOS / Android？**
2. **后端基于官方 Node.js（`>=24.9`）+ DSH + Cordis 时，桌面端（Win/macOS）与移动端（iOS/Android）的后端必须怎么拆、怎么适配？**

---

## 一、现状盘点：当前 Flutter 客户端距离多端有多远？

通过实查仓库结构与 [`app/pubspec.yaml`](../../../app/pubspec.yaml) 及 `app/lib/` 源码，现状比预期健康得多——**业务逻辑与通信层本身已高度跨端，Windows 绑定集中在少数外围适配层**：

1. **平台工程目录现状**：当前 `app/` 下仅生成了 `windows/` 运行壳（尚未生成 `macos/`、`ios/`、`android/` 目录）。
2. **依赖清单评估（[`app/pubspec.yaml`](../../../app/pubspec.yaml)）**：
   - 大多数核心依赖已天生支持 Win / macOS / iOS / Android（如 `flutter_markdown_plus`、`file_selector`、`shared_preferences`、`url_launcher`、`flutter_math_fork`、`flutter_svg`、`record`、`highlight`、`markdown`、`crypto`、`path`）；
   - **纯桌面端插件**：`window_manager`、`tray_manager`、`desktop_drop`（含本地 Windows vendored 覆盖包）、`pasteboard`（在移动端需按平台做条件裁剪或替换）；
   - **唯一纯 Windows 强绑定 UI 包**：**`webview_windows: ^0.4.0`**（仅用于 [`app/lib/ui/web_surface.dart`](../../../app/lib/ui/web_surface.dart)）。**这再次印证您放弃 WebView 模块路线、改选 Flutter 原生 UI 路线非常正确**——省掉了跨 Windows `WebView2` / macOS `WKWebView` / iOS / Android 四端维护浏览器宿主与 JS 桥接的巨大包袱。
3. **代码层实查到的平台耦合点**：
   - [`app/lib/ui/web_surface.dart`](../../../app/lib/ui/web_surface.dart)：已带 `if (!Platform.isWindows) return false;` 守卫；
   - [`app/lib/ui/keys.dart`](../../../app/lib/ui/keys.dart)：通过 `dart:ffi` 查询 Windows 按键状态，已带 `Platform.isWindows` 守卫；
   - [`app/lib/state/installation.dart`](../../../app/lib/state/installation.dart)：通过 `powershell.exe` 查盘符剩余空间，已带 `if (!Platform.isWindows) return null;` 守卫；
   - [`app/lib/state/agent_controller.dart`](../../../app/lib/state/agent_controller.dart#L1035)：调用系统文件管理器（`explorer` / `xdg-open`），macOS 需补 `open -R`，移动端无本地桌面文件夹概念需隐藏或改分享面板；
   - [`app/lib/state/backend.dart`](../../../app/lib/state/backend.dart)：**最宝贵的现成架构资产**——前端所有逻辑只面对抽象接口 **`AgentBackend`**（`connect()`、`launch(SessionTarget)`、`call(method, params)`、`events` 流），本地启停 Node Core 的逻辑已经被收进实现类 `CoreBackend`（通过 `CoreLocator` 与 `CoreClient` 建连）。

---

## 二、后端多端核心架构：桌面本地 Core vs 移动远程/伴侣 Core

您提到：
> 「前端的迁移就可以方便一些，那后端的话针对其他客户端我们是要重新地去设计的，去适配的。」

这个判断完全切中要害。**Node.js（`>=24.9`）+ DSH + Cordis + 沙箱工具链，在桌面端与移动端面临截然不同的操作系统硬约束：**

| 运行平台 | 能否在端内本地跑 DSH + Cordis + 工具沙箱？ | 推荐后端部署形态 | 蝶君沙箱（DSH `sandbox` Provider）落位 |
| :--- | :--- | :--- | :--- |
| **Windows 桌面** | **完全可以（主端）** | **本地随包 Node Core**（`ws://127.0.0.1` + Token） | `@dreamflutter/dsh-sandbox-windows-appcontainer`（Windows 原生 `AppContainer` + `Job Object` + 便携 Win32 工具链） |
| **macOS 桌面** | **完全可以（全功能端）** | **本地随包 macOS Node Core**（`.app/Contents/Resources` 路径定位调通即可） | `@dreamflutter/dsh-sandbox-macos`：走 macOS 原生 **`sandbox-exec` / App Sandbox + 私有隔离工作目录**，工具复用 macOS 原生工具链 / Python / Node |
| **iOS 移动端** | **不能在本地跑完整 Node 24.9 + CLI 沙箱**（App Store 严格禁止后台常驻多进程子进程、JIT 与外挂解释器执行任意脚本） | **切为 `RemoteBackend implements AgentBackend`**，走加密 **`wss://` 远程连接** | 沙箱与工具执行**留在用户信任的远端宿主**（① 家里/办公室开着的 Win/macOS 桌面端**「伴侣模式」**；或 ② **云端托管 DSH Core**） |
| **Android 移动端** | **技术上难且收益极差**（内置 Node 24.9 + Python 导致 APK 体积暴涨、后台杀进程、高耗电、无真正可用桌面项目目录） | **同 iOS，默认走 `RemoteBackend`（`wss://` 连桌面伴侣或云端 Core）** | 移动端本身作为轻巧控制器/查看器/语音入口；未来最多在端内补少量手机本地安全小工具（如日程/本地语音/拍照上传），不硬塞完整桌面沙箱 |

### 为什么这套架构让多端成本最低？
1. **DSH + Cordis 内核代码几乎零分叉**：同一份 TypeScript DSH Core + 业务插件包，既跑在 Windows/macOS 用户的本机，也可以原封不动跑在云端 Linux 容器里（Linux 容器还可以直接复用官方成熟 Linux 沙箱 Provider）。
2. **`AgentBackend` 接口把两端统一起来**：
   - 在桌面端（Win/macOS），装配 **`CoreBackend`（本地起进程 + `127.0.0.1` WebSocket）**；
   - 在移动端（iOS/Android），装配 **`RemoteBackend`（经 `wss://` TLS + 设备配对令牌 / 登录鉴权，直连用户桌面伴侣或云端 Core）**。
   - **上层 Flutter 聊天界面、记忆页、任务页、「等你处理」审批流以及未来所有原生模块，甚至不知道自己连的是本机还是云端**！
3. **跨端协同的杀手级体验（桌面伴侣模式）**：您在 Windows / macOS 电脑上挂着 **SuperAgent / 蝶君** 跑长任务时，出门在手机 iOS / Android 上打开 DreamFlutter，右侧「等你处理」就能直接弹出确认卡片让您点一下批准继续跑，或者随时用手机语音给电脑里的蝶君派活。

### 补充参考：Android 优秀开源客户端 `RikkaHub` 的可借鉴设计
用户提到安卓端可参考开源项目 **`RikkaHub`（`rikkahub/rikkahub`，Kotlin + Jetpack Compose）**。经核查，该项目具备以下值得 DreamFlutter 未来做移动端时借鉴的工程与体验设计（注：`RikkaHub` 采用 **AGPL-3.0** 协议，**只借鉴交互理念，不直接复用代码**）：
1. **扫码快速配置 / 配对导入（QR Code Export & Import）**：非常适合 DreamFlutter 移动端的「**桌面伴侣配对**」场景——在 Win / macOS 桌面端生成一次性配对二维码（包含网关地址、临时配对公钥/令牌），手机打开扫一下即连上家里/办公室电脑上的 Core，免去手机端手输复杂 URL 和密钥的麻烦。
2. **Android 本机 `proot` 独立 Linux 沙箱思路**：RikkaHub 在安卓上验证过借助用户态 `proot` 在不越狱/不 root 的前提下跑受限终端工具；但在 DreamFlutter 规划里，**iOS 无法使用此机制，且 2.0 初期优先采用「移动端远程连接桌面伴侣 / 云端 Core」方案**，未来仅当 Android 确需离线本地工具时再将其列为可选项评估。
3. **移动端富文本与对话体验细节**：消息分支切换、代码块/LaTeX/Mermaid 渲染、网页搜索与 MCP 参数表单在窄屏下的紧凑排布，均可在后续开发移动版时对照打磨（移动版与模块包开发计划均排在 2.0 底座落地之后）。

---

## 三、Flutter 原生 UI 模块如何在「多端」与「插件化」之间取得平衡？

选中 **Flutter 原生 UI 路线** 后，必须正视 Flutter 的一个底层工程特性：**Dart 在 iOS 等正式发布包上走 AOT 原生编译，App Store 也不允许运行期动态下载并执行未经审核的可执行 UI 代码包**。因此「插件化 + Flutter 原生界面」在 2.0 必须采用下面这套**分层落位方案**：

### 第 1 层｜纯能力型 DSH 插件（工具 / 记忆 / 路由 / 工作流 / MCP）
- **完全动态、全平台通用**：后端直接装进 DSH + Cordis，Flutter 端**不需要为它们单独写专有页面**——它们的工具调用过程、流式回复、审批请求、产物文件全部自动走现有的聊天过程块与「等你处理」收件箱原生呈现。

### 第 2 层｜自研 / 官方旗舰功能模块（如：番茄钟模块、SuperAgent 控制台）
- **前端模块化封装 + 后端能力宣告绑定**：
  1. 在 Flutter 仓库内按独立子包组织前端模块（例如 `packages/module_pomodoro/`、`packages/module_superagent/`），只依赖平台标准路由契约与 `AgentBackend`，**一套 Dart 代码编译覆盖 Windows / macOS / iOS / Android**（配合响应式断点：桌面端左侧栏进入、移动端底部导航或抽屉进入）；
  2. 后端对应的 DSH 功能包（`dsh.bundle`）启动后，通过 RPC（如 `modules.capabilities`）向客户端宣告自己在线与版本；
  3. Flutter 侧据此**动态决定左侧栏显示哪些模块入口、如何接入各自的状态流与共享 Runtime / Memory**，做到后端按需启停与多端原生流畅渲染两全。

### 第 3 层｜小型动态插件交互面板的未来兜底（声明式 UI 协议，非必需但预留）
- 如果未来接入社区某个「带一点交互界面」的 DSH 能力插件（比如一个简单配置表单、状态仪表盘卡片），而又不想在手机端引入沉重的 WebView 且不想每装一个插件就重编一次 Flutter App：
  - 可在 2.0 后期增加一层轻量 **声明式 Schema UI（Generative / Card Spec）**：后端插件只输出 JSON 形态的轻量组件树描述（文本、指标卡、开关、表单、列表、图表数据、按钮动作回调 ID），由 Flutter 原生组件库统一按 DreamFlutter 水墨主题渲染出来。这样**既守住全端原生手感与 App Store 合规，又赋予纯后端插件有限的自定义面板表达力**。

---

## 四、给 2.0 多端适配提前埋好的 5 条设计准备（暂不改 1.0 代码）

等两周后 1.0 正式版发完、正式启动 2.0 时，建议一开头就把以下 5 条架构隔离立住，后面加 macOS / iOS / Android 就只是「按平台填适配层」而非返工：
1. **严格抽象 `PlatformAdapter`**：把目前散在 `keys.dart`、`installation.dart`、`agent_controller.dart` 里的 `explorer`、`powershell`、键位查询、窗口控制、本地目录定位收进统一接口，桌面与移动端各自实现一套空安全/原生实现。
2. **`AgentBackend` 支持双模连接配置**：在现有 `CoreBackend` 之外设计清晰的鉴权与断线重连握手（为日后 `RemoteBackend` `wss://` 连伴侣端/云端留接口；移动端也必须解决 `SlotConnection` 在弱网切换 Wi-Fi/5G 时的断点续传事件对齐）。
3. **响应式布局接口预留**：1.0 的桌面向导与两栏/三栏布局在进入 macOS 无需大改；但面向 iOS/Android 时，左侧栏需自然折叠成移动抽屉或标签页，模块容器从一开头就按可用宽度自适应设计。
4. **核心插件禁碰平台假设**：所有自研 DSH + Cordis 插件（记忆、Ledger、SuperAgent、番茄钟后端）只通过 `ctx.sandbox` / `ctx.storage` 等标准能力缝干活，**严禁在核心业务插件里写死 Windows 盘符、反斜杠路径或 `powershell.exe`**。
5. **macOS 与 Windows 双桌面构建管线**：Node `>=24.9`、DSH Core、`AppContainer`（Win）/ `Sandbox`（macOS）各自作为独立平台打包插件，确保同一份 Cordis Bundle 能在 Win 和 macOS 上分别打出纯净安装包。
