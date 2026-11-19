# DreamFlutter 1.0 Windows → macOS 预览 / 内测版迁移调研总览

> **目标与性质**：本目录为「将现有 **1.0（`1.0.0-preview.2`）** 迁移出 **macOS 预览版 / 朋友内测版**」的专项代码级调研与实施指南。
> - **核心要求**：「除了运行在不同客户端，其他体验尽量全部一致」（双空间：工作台 + 蝶君隔离、三级记忆、长任务、12 套主题与水墨界面、16 条已定型交互、朋友内测一步激活流程）。
> - **文档分工**：本文讲清总体判断、4 个关键工程难点解法、构建/分发前提与实施顺序；详尽的**逐文件实查改造清单**见 **[01-audit-and-checklist.md](01-audit-and-checklist.md)**。

---

## 一、总体可行性判断（实查结论）

通过逐目录排查 `app/`、`packages/`、`core/`、`scripts/` 后，迁移难度呈现清晰的「**前端中等偏易，后端两大硬块必须重写适配**」分布：

1. **Flutter 前端与状态层（工作量约 35%）**：
   - 主体 UI、主题、对话渲染、控制器状态流本身纯 Dart 跨端；
   - 主要工作在于：补齐 `app/macos/` 工程壳、调整 **`CoreLocator` 数据与资源路径**、修补已被剥离 macOS 代码的 vendored **`packages/desktop_drop`**、替换依赖 Win32/WebView2 的 **`RichRenderer`（Mermaid/图表渲染）**、**托盘图标（`.ico` → `.png`）**、**快捷键（`Ctrl` → `Cmd`）** 以及 **左上角 macOS 红绿灯与侧栏顶栏避让**。
2. **Core Node.js 后端（工作量约 65%）**：
   - `node:sqlite` 等已原生支持跨平台；
   - 但有**五个实实在在的 Windows 绑定点**必须在 1.0 层面完成平台抽象或替换，否则 macOS 上蝶君、密钥加密、工作台命令、语音与 HTML 自检无法跑通：
     1. **蝶君沙箱**：1.0 深度绑定 **`wsl.exe` + `\\wsl.localhost\` UNC 路径**（macOS 没有 WSL2）；
     2. **API Key 加密**：依赖 PowerShell `.NET ProtectedData` DPAPI；
     3. **工作台默认终端与安全命令白名单**：写死 `pwsh` 与 PowerShell 字面量解析；
     4. **语音与随包原生二进制**：只锁了 `sherpa-onnx-win-x64`、MinGit 与 `win_amd64` 轮子；
     5. **HTML 无头自检浏览器**：只找 `msedge.exe`。

---

## 二、四个必须提前拍板的关键技术方案

### 难题 1｜1.0 macOS 上的「蝶君」隔离沙箱怎么做？（最关键设计）
目前 1.0 的 Windows 蝶君重度依赖 `wsl.exe`（涉及 `sandbox.ts`、`sandbox-shell.ts`、`python-kernel.ts`、`package-sources.ts`、`html-browser.ts`、`skill-trial.ts`、`butterfly.ts`、`tasks.ts` 等至少 8 个后端模块及 `work_models.dart` / `sandbox_panel.dart`）。macOS 没有 WSL2，有两条路线：

| 对比维度 | **方案 A：macOS 原生 `sandbox-exec`（Seatbelt）+ 私有隔离目录（主推）** | 方案 B：Lima / Apple `Virtualization.framework` Linux VM |
| :--- | :--- | :--- |
| **用户体验一致性** | **极高，开箱即用**：0 额外装机/下载，毫秒启动，没有虚拟机感；离线/联网与私有读写边界照常工作 | **极重**：需塞入数百 MB Linux 镜像 + 启动虚拟化 VM，违背轻量化与内测快速上手诉求 |
| **实现机理** | 进程外起 `sandbox-exec -f <profile.sb>` 执行 `bash`/`python3`/`Chromium`，SBPL 规则写死仅可读写 `butterfly/workspace` 与私有缓存、只读访问随包工具与系统共享库、拒绝读取 `~/.ssh`、`~/Desktop`、`~/Documents`、`~/Library/Keychains` 及其他应用数据；离线模式加 `(deny network*)`，联网模式放行外网但拦截连本机 Core WebSocket 端口 | 独立 Linux 客机，直接复用 Debian `apt` 与 `/workspace` |
| **必须处理的真实坑** | 1. 苹果已将 `sandbox-exec` 标为 deprecated（每次调用 stderr 会打印一条弃用警告，shell/kernel 封装需过滤这条噪音）；<br>2. **外层 `.app` 必须关闭 Apple App Sandbox（`com.apple.security.app-sandbox = false`）**——若外层开 App Sandbox，子进程嵌套 `sandbox-exec` 会被系统拒绝（走直接 `.dmg`/`.zip` 分发完全不需要开 MAS App Sandbox）；<br>3. Apple Silicon 上需在 SBPL 中按实测放行必要只读动态库路径与 DNS/SSL Mach lookup；<br>4. 内部跑 macOS 原生工具链，不跑 Linux `apt` | 下载巨大、首次构建慢、M 系列 Mac 与 Intel 需两套镜像 |

> **推荐建议**：面向 macOS 朋友内测版，优先采用 **方案 A（`sandbox-exec` + 私有隔离工作目录）**。同时先把前端/后端的「沙箱提供者」从 `wsl.exe` 抽成平台接口，将来 2.0 换入官方 DSH `sandbox` 服务缝时可直接平移！

### 难题 2｜`.app` 包结构与可变数据目录位置（绝对不能把 `data/` 写进 `.app` 里）
- Windows 便携版把所有数据写在 `<软件目录>\data\`（[`core/src/paths.ts#L33-L36`](../../../core/src/paths.ts#L33-L36) 与 [`CoreLocator.defaultDataDir`](../../../packages/pi_rpc/lib/src/core_client.dart#L135-L145)）。
- 在 macOS 上，软件装在 `/Applications/DreamFlutter.app`（可执行文件在 `Contents/MacOS/dreamflutter`，资源在 **`Contents/Resources/`**）：
  - **绝不能把数据库、日志、密钥、蝶君文件写进 `.app/Contents/`**：普通非管理员用户在 `/Applications/` 无写权限，而且往包内写文件会直接破坏 Apple 代码签名导致启动报错，换包覆盖时也会丢数据！
  - **标准 macOS 做法**：只读程序载荷（`core/`、`runtime/`、`licenses/`、`beta-edition.json`）放入 **`DreamFlutter.app/Contents/Resources/`**；可变用户数据根目录默认落在 **`~/Library/Application Support/DreamFlutter/data`**（并同时修正 `legacyDataDir()` 使用 `~/Library/Application Support/DreamFlutter` 替代 `%APPDATA%`，仍保留 `DREAMFLUTTER_DATA` 环境变量供测试覆盖；在纯仓库源码调试运行未打 `.app` 时仍可使用仓库旁 `data/`）。

### 难题 3｜构建环境与朋友内测分发（Gatekeeper「已损坏」拦截警告）
1. **构建机硬条件**：在当前这台 Windows 电脑上**无法编译 macOS `.app` 或 Swift 原生插件**（需要 Xcode 与 macOS SDK）。新窗口可以**先在 Windows 完成前后端跨平台抽象与非 macOS 测试**，但最终生成 `macos/` 编译验证、Swift 调试、Voice 二进制集成与打包 `.dmg`/`.zip` **必须在真实 Mac（或 GitHub Actions `macos-latest` runner）上执行**。
2. **芯片架构目标**：需要明确先打 **Apple Silicon（`arm64`，M1/M2/M3/M4）** 还是同时打 **Intel（`x64`）**——影响随包的 `node`、`uv`、`python`、`rg`、`fd`、`sherpa-onnx-darwin-*` 与 `.dmg` 包策略。
3. **Gatekeeper 防拦截提醒**：苹果对通过浏览器/微信下载的未签名公证 `.app` 会贴上 `com.apple.quarantine` 隔离属性，朋友双击时系统可能直接弹窗「**无法打开，因为无法验证开发者 / 软件已损坏**」：
   - **最佳体验（有 Apple Developer 账号，\$99/年）**：`Developer ID Application` 签名 + `xcrun notarytool` 公证 + `stapler` 装订进 `.dmg`，朋友拿到双击直接打开；
   - **零成本内测兜底（无开发者账号，Ad-hoc 签名 `codesign -s -`）**：需给内测朋友附带一句终端命令（`xattr -cr /Applications/DreamFlutter.app`）或「系统设置 → 隐私与安全性 → 仍要打开」操作说明。

### 难题 4｜语音、图表 `WebSurface`、快捷键与密钥加密的无缝替身
- **图表与 Mermaid（`RichRenderer`）**：Chat 内画 Mermaid / Chart / SVG 目前依靠 [`rich_blocks.dart`](../../../app/lib/ui/rich_blocks.dart) 打开隐藏的 Windows `WebView2`；macOS 上如果留空会导致聊天里的流程图全部失效，必须接回 **`WKWebView` 实现**（例如引入官方 [`webview_flutter`](https://pub.dev/packages/webview_flutter) 的 macOS 支持或薄 Swift MethodChannel）。
- **DPAPI 密钥库**：Windows 的 PowerShell DPAPI 替换为 **macOS Login Keychain 存一把主密钥 + `secrets/` 目录 AES-256-GCM 密文文件**（既保持与现有 `SecretStore` / 备份导入机制一致，又不会每次读写 Key 反复弹系统密码框）。
- **快捷键与工作台 Shell**：全局主修饰键由 `Ctrl` 在 macOS 自动切换为 `Cmd`（`⌘B / ⌘O / ⌘K / ⌘V / ⌘+滚轮`）；工作台 Shell 在 macOS 由 `pwsh` 切为 `/bin/zsh` 并补齐 POSIX 只读命令安全解析。

---

## 三、建议在「新窗口」按什么顺序推进（7 步落地路线）

| 阶段 | 执行位置 | 关键产出 | 验收门槛 |
| :--- | :--- | :--- | :--- |
| **Step 1：拍板前提** | 对话确认 | 明确编译 Mac / CI、目标架构（`arm64`/`x64`/双架构）、`sandbox-exec` 方案与是否有 Apple Developer 账号 | 边界清零，不返工 |
| **Step 2：后端平台抽象** | Win/Mac 均可 | 完成 `paths.ts`、`secrets.ts`（Keychain）、`shell.ts`（zsh）、`command.ts`（POSIX 只读规则）、`paths.ts`（macOS 敏感路径）、`system-proxy.ts`（`scutil`）、`render-html-browser.ts`（Chrome/Edge macOS） | Windows 既有后端测试全绿 |
| **Step 3：蝶君 macOS Sandbox Adapter** | 需 Mac 实测 | 抽象 `SandboxProvider` 接口，Windows 维持 `wsl.exe`，macOS 实现 `sandbox-exec`（目录白名单 + 离线禁网 + 禁 `127.0.0.1` Core 端口 + stderr 警告过滤 + `python-kernel` / `sandbox-shell` 本地进程化） | 在 Mac 实测读写越界拒绝、断网阻断与中文出图 |
| **Step 4：Flutter 平台泛化与 `desktop_drop` 补全** | Win/Mac 均可 + Mac 编译 | 补回 `desktop_drop/macos/`；重构 `keys.dart` / 快捷键（`Ctrl`/`Cmd`）；`desktop_shell.dart` 适配 PNG 托盘与 macOS 关闭行为；`window_frame.dart` / `sidebar` 适配左上角红绿灯让位；`RichRenderer` 接入 macOS `WKWebView` | `flutter analyze` 与组件测试通过 |
| **Step 5：生成 `app/macos/` 工程与权限配置** | 必须 Mac（Xcode） | `flutter create --platforms=macos .`（不覆写 `lib/`），配置 entitlements（关闭 App Sandbox、开 Hardened Runtime、配麦克风隐私声明）与 `.icns` 图标 | `flutter run -d macos` 首屏拉起成功 |
| **Step 6：macOS 运行时锁与打包脚本** | Mac / CI | 准备 macOS 版 `node`、`uv`、`cpython-3.13`、`rg`、`fd`、`git`、`sherpa-onnx-darwin-*` 与 Python wheels；编写 `scripts/package-macos.sh` 组装 `.app` 与 `.dmg`（含 `--beta` 参数写入 `beta-edition.json`） | `DreamFlutter.app` 在干净目录双击能独立拉起 Core 并正常对话、识别语音、跑蝶君 |
| **Step 7：内测打包与一致性回归** | 真实朋友 Mac | 对照 [01-audit-and-checklist.md](01-audit-and-checklist.md) 第四节完成 10 项端到端验证，处理签名公证或内测打开指引 | 交付朋友内测 `.dmg`/`.zip` |

---

## 四、开新窗口施工前，请先跟用户确认的 4 个实操条件

1. **Mac 编译与测试环境**：您手边是否有可操作/连代理构建的 Mac，还是需要通过 GitHub Actions `macos-latest` 来出包后您拿到朋友 Mac 上试？
2. **CPU 架构覆盖**：内测朋友主要是 **Apple Silicon（M1/M2/M3/M4 `arm64`）**，还是也包含 **Intel Mac（`x64`）**？
3. **1.0 内测版蝶君路线确认**：是否同意 1.0 macOS 内测版先用 **`sandbox-exec` 轻量目录隔离**（无虚拟机、原生体验，唯不能跑 Linux `apt`）来保证与 Windows 一致的「免审批隔离体验」？
4. **Apple 签名 / 公证条件**：是否有 **Apple Developer 账号（Developer ID 证书）** 用于公证 `.dmg`，还是采用无账号 Ad-hoc 签名并给朋友附带右键/终端放行指引？
