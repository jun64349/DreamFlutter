# 01｜Windows → macOS 代码级全量排查与改造清单

本文为 2026-11-19 对工作区 `core/`、`packages/`、`app/`、`scripts/` 进行逐模块实查后的精准改造地图，确保新窗口施工时**零遗漏、不踩隐形坑**。

---

## 一、`core/` 后端改造清单（按模块归类）

### 1. 数据目录、Bundle 载荷定位与内测标记
- **实查位置**：[`core/src/paths.ts`](../../../core/src/paths.ts)
- **现状问题**：
  - `APP_ROOT` 通过相对 `src/` 向上两级定位；打包成 macOS `.app` 后，代码位于 `DreamFlutter.app/Contents/Resources/core/`，`APP_ROOT` 会解析成 `Contents/Resources/`。
  - `defaultDataDir()` 目前默认返回 `join(APP_ROOT, "data")`（或检测 `Update.exe`），这在 macOS `/Applications/DreamFlutter.app` 下既没有写权限，又会破坏代码签名。
  - `legacyDataDir()` 目前读 `process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")`。
- **改造要求**：
  - 当 `process.platform === "darwin"` 且未指定 `DREAMFLUTTER_DATA` 时：若检测运行在 `.app/Contents/Resources` 内（或通用安装态），默认 `dataDir` 落在 `join(homedir(), "Library", "Application Support", "DreamFlutter", "data")`，`legacyDataDir()` 返回 `join(homedir(), "Library", "Application Support", "DreamFlutter")`；源码工作区直接启动开发模式时仍可维持仓库旁 `data/`。
  - `BETA_EDITION` 检查 `join(APP_ROOT, "beta-edition.json")`，在 macOS 放到 `Contents/Resources/beta-edition.json` 即可复用，无需改逻辑。

### 2. API Key 与凭据加密（替代 PowerShell DPAPI）
- **实查位置**：
  - [`core/src/modules/secrets.ts`](../../../core/src/modules/secrets.ts)（调用 `powershell.exe` + .NET `ProtectedData` 读写 `.dpapi` 文件）
  - 调用方：[`core/src/security/service.ts#L78-L81`](../../../core/src/security/service.ts#L78-L81)、[`core/src/gateway/gateway.ts`](../../../core/src/gateway/gateway.ts)、[`core/src/modules/mcp.ts#L201,L252`](../../../core/src/modules/mcp.ts#L201)、[`core/src/backup/export.ts`](../../../core/src/backup/export.ts)、[`core/src/backup/restore.ts`](../../../core/src/backup/restore.ts)
- **改造要求**：
  - 抽象跨平台加密后端：`win32` 维持 DPAPI；`darwin` 采用 **信封加密（Envelope Encryption）**：首次生成 32 字节随机主密钥写入 **macOS Login Keychain**（调用系统自带 `/usr/bin/security add-generic-password / find-generic-password`，绑定服务名 `DreamFlutter.SecretsMasterKey`），具体各项 API Key 仍使用 Node 内置 `crypto` AES-256-GCM 密文存在 `secrets/` 目录。
  - **重要工程优势**：① 不会因为读写十几个 Provider Key 而反复弹出系统钥匙串授权窗口；② 保持 `SecretStore.put/get`、`dpapiMany` 抽象接口与现有备份导出解密/跨端导入流程完全兼容（注意同时处理扩展名兼容与 `basename(..., ".dpapi")` 等硬编码后缀）。

### 3. 工作台终端、命令安全解析与敏感路径策略
- **实查位置**：
  - [`core/src/agent/shell.ts`](../../../core/src/agent/shell.ts) & [`core/src/agent/harness.ts`](../../../core/src/agent/harness.ts) & [`core/src/agent/dsh-text.ts`](../../../core/src/agent/dsh-text.ts)
  - [`core/src/ext/approval.ts`](../../../core/src/ext/approval.ts)
  - [`core/src/security/command.ts`](../../../core/src/security/command.ts)
  - [`core/src/security/paths.ts`](../../../core/src/security/paths.ts)
  - [`core/src/security/service.ts#L30-L31`](../../../core/src/security/service.ts#L30-L31)
- **现状问题**：
  - `STANDARD_TOOLS` / `MINIMAL_TOOLS` 写死工具名 `"pwsh"`，[`shell.ts`](../../../core/src/agent/shell.ts#L30-L46) 只查找 `pwsh.exe`/`powershell.exe`，停止树用 `taskkill`（非 win32 已写 `child.kill("SIGKILL")`，**注意应改为 `detached: true` + `process.kill(-child.pid, "SIGKILL")` 才能杀干净子孙进程树！**）。
  - [`command.ts`](../../../core/src/security/command.ts) 中的 `safeLiteralCommand()` 只认识 `get-location`、`get-content` 等 PowerShell 动词，且 [`security/service.ts#L172`](../../../core/src/security/service.ts#L172) 写死 `event.toolName === "bash"` 一律判为 `unsafe`。这会导致 macOS 工作台在「仅改动时确认（changes）」模式下连执行只读 `ls` / `pwd` / `cat` 都频繁弹窗确认！
  - [`security/paths.ts`](../../../core/src/security/paths.ts#L40-L49) 的敏感目录主要列了 Windows `AppData/Local` 路径（Chrome/Edge/Credentials/Vault）。
- **改造要求**：
  - 工作台在 `darwin` 提供基于 `/bin/zsh`（或 `/bin/bash`）的统一 Shell 工具（可保留交互语义与 `JobRegistry`、CWD 追踪、溢出 spill 文件与 `toolchainEnv`），提示词工具名与 [`dsh-text.ts`](../../../core/src/agent/dsh-text.ts) 按平台描述适配。
  - 在 `command.ts` 新增**保守 POSIX 只读字面量白名单**（严禁管道/重定向/子命令替换，仅允许如 `pwd`、`ls`、`cat`/`head`/`tail`/`stat`（受限于安全参数）与已有的 `git status` / `git rev-parse`），并更新 `security/service.ts` 让 macOS 安全只读命令能与 Windows PowerShell 一样享有一致的免打扰体验。
  - 在 `security/paths.ts` 与 `security/service.ts` 补齐 **macOS 敏感路径表**：`~/Library/Keychains`、`~/Library/Cookies`、`~/Library/Safari`、`~/Library/Application Support/Google/Chrome`、`~/Library/Application Support/Microsoft Edge`、`~/Library/Application Support/Firefox`、`~/Library/Application Support/1Password`、`~/.aws`、`~/.kube`、`~/.ssh/id_*`、`$HOME/.config/gcloud` 等（注意 macOS `HOME` 展开及通常 APFS 默认大小写不敏感特性）。

### 4. 蝶君（Butterfly）沙箱与子工具链解耦
- **实查位置**：
  - [`core/src/sandbox/sandbox.ts`](../../../core/src/sandbox/sandbox.ts)、[`core/src/sandbox/wsl-install.ts`](../../../core/src/sandbox/wsl-install.ts)、[`core/src/sandbox/html-browser.ts`](../../../core/src/sandbox/html-browser.ts)
  - [`core/src/agent/sandbox-shell.ts`](../../../core/src/agent/sandbox-shell.ts)、[`core/src/agent/python-kernel.ts`](../../../core/src/agent/python-kernel.ts)、[`core/src/agent/package-sources.ts`](../../../core/src/agent/package-sources.ts)
  - [`core/src/modules/butterfly.ts`](../../../core/src/modules/butterfly.ts)、[`core/src/modules/tasks.ts#L430`](../../../core/src/modules/tasks.ts#L430)、[`core/src/modules/skill-trial.ts#L89`](../../../core/src/modules/skill-trial.ts#L89)
- **改造要求**：
  - 抽出平台沙箱提供者接口（`SandboxRuntime`），Windows 继续跑原有 WSL2，不破坏 Windows 1.0；
  - `darwin` 实现 **`MacSeatbeltSandbox`**：
    - 蝶君根目录落在 `<dataDir>/butterfly`（用户工作区与 `inbox/`、`outbox/` 都是普通本地目录，**去掉 `\\wsl.localhost\DreamFlutterSandbox\...` UNC 拼接**）；
    - `sandbox-shell.ts`、`python-kernel.ts`、`package-sources.ts`、`skill-trial.ts` 与 `html-browser.ts` 改为通过 `/usr/bin/sandbox-exec -f <profile.sb>` 直接拉起内置 `bash` / 随包 `python3` / Headless Chrome，同时过滤 Apple `sandbox-exec is deprecated` 的固定 stderr 警告；
    - 离线/联网切换通过生成不同的 SBPL Profile（`(deny network*)` vs 允许外网但明文 `(deny network-outbound (remote ip "localhost:*"))` 及禁本地 Core WS 端口）实现与 WSL2 `nftables` 对等的隔离语义。
    - （注：`sandbox-shell.ts` / `python-kernel.ts` 现有状态检测也需在 Mac 上关闭 `WSL_UTF8` / `WSLENV` 假设并处理进程组杀灭）。

### 5. 工具链、系统代理、HTML 渲染自检、语音与存储细节
- **工具链 [`core/src/agent/toolchain.ts`](../../../core/src/agent/toolchain.ts)**：目前已经兼容非 `win32` 的 `bin/python3`、`rg`、`fd`、`uv` 与 `:` PATH 分隔符；需注意打包时在 Mac 端用 `scripts/fetch-toolchain-macos` 下载对应架构二进制并确保 `chmod +x`（以及处理 Apple Silicon 二进制签名，否则无签名的下载二进制可能被 Gatekeeper 拦截）。
- **Git 寻找 [`core/src/git/process.ts`](../../../core/src/git/process.ts)**：已写 `process.platform === "win32" ? "cmd/git.exe" : "bin/git"`，但 macOS 通常自带系统 `/usr/bin/git`（需留意若用户未装 Xcode Command Line Tools，调 `/usr/bin/git` 会弹系统的安装向导弹窗！**因此必须在安装包内真正随包一份独立便携 macOS `git`，或先检查跳过触发 CLT 弹窗的 stub**——这是 macOS 开发非常容易踩的真坑！）。
- **系统代理 [`core/src/agent/system-proxy.ts`](../../../core/src/agent/system-proxy.ts)**：`readSystemProxy()` 目前非 `win32` 直接返回 `undefined`。macOS 需改为解析 `scutil --proxy`（提取 `HTTPEnable`/`HTTPProxy`/`HTTPPort`、`HTTPSEnable`/`HTTPSProxy`/`HTTPSPort`、`SOCKSEnable`/`SOCKSProxy`/`SOCKSPort` 与 `ExceptionsList`），这样朋友电脑开着 Clash/Surge 等系统代理时工具链才不用配也能联网。
- **HTML 视觉自检 [`core/src/agent/render-html-browser.ts`](../../../core/src/agent/render-html-browser.ts)**：`EdgeHtmlBrowser.find()` 当前对非 `win32` 直接 return。macOS 需探测本机 Chrome / Edge / Chromium 常见 `.app/Contents/MacOS/...` 路径，或按需下载/随包轻量 Chromium Headless Shell。
- **本地离线语音识别 [`core/package.json`](../../../core/package.json) & [`core/src/modules/voice/runtime.lock.json`](../../../core/src/modules/voice/runtime.lock.json) & [`scripts/prepare-bundled-runtime.mjs`](../../../scripts/prepare-bundled-runtime.mjs)**：目前只锁定 `sherpa-onnx-win-x64`。macOS 必须加入 **`sherpa-onnx-darwin-arm64`**（以及若兼容 Intel 的 **`sherpa-onnx-darwin-x64`**）校验与打包，并在 Node 原生 `.node` 插件上注意签名验证（Hardened Runtime 下如果未开 `disable-library-validation` 或未统一用相同团队证书签 `.node`，dlopen 会直接拒载！）。
- **存储搬迁 [`core/src/storage/target.ts`](../../../core/src/storage/target.ts)**：`localDatabaseTarget` 目前在非 `win32` 直接放行；建议在 `darwin` 补充检查不能选到 SMB/AFP/NFS 网络挂载卷（例如 `/Volumes/` 下的远程卷，可用 `df -T` 或 `stat -f` 判别），守住 SQLite WAL 不能放网络盘的可靠性底线。
- **提示词平台文案 [`core/src/memory/platform-defaults.ts#L14`](../../../core/src/memory/platform-defaults.ts#L14)**：目前硬编码「运行在 Windows 上的个人 AI 助手软件……在独立的 WSL 沙箱里干活」，需按当前平台动态生成更准确的简介。
- **更新与卸载 [`core/src/update/`](../../../core/src/update/module.ts) & [`core/src/uninstall/`](../../../core/src/uninstall/index.ts)**：`darwin`（尤其首期朋友内测版 `BETA_EDITION = true`）关闭 Velopack `Update.exe` 逻辑；在设置或数据面板中保留清晰的 macOS 清理/重置说明即可。

---

## 二、`packages/` 与 `app/` Flutter 改造清单

### 1. 生成 `app/macos/` 工程与权限配置
- **现状**：[`app/`](../../../app) 仅存在 `windows/` 目录。
- **动作**：在 Mac 环境运行 `flutter create --platforms=macos .`（确认只新建 `macos/`，绝不覆盖 `lib/`、`pubspec.yaml`、`test/`），并重点配置：
  - `macos/Runner/DebugProfile.entitlements` 与 `Release.entitlements`：**务必设置 `<key>com.apple.security.app-sandbox</key><false/>`**（因为 DreamFlutter 需要脱离主 UI 拉起独立长寿命 `node` 进程以及蝶君的 `sandbox-exec` 子沙箱），开启 Hardened Runtime，并按需配置 `com.apple.security.device.audio-input`（麦克风录音）；
  - `macos/Runner/Info.plist`：配置正式 `CFBundleIdentifier`、`CFBundleName`（`DreamFlutter` / `梦蝶`）、最低支持系统版本（建议对齐 `webview` / `flutter` / `record` 要求的 macOS 11+ 或 12+）与 **`NSMicrophoneUsageDescription`** 隐私申请文案；
  - `macos/Runner/Assets.xcassets/AppIcon.appiconset/`：从现有图标生成完整 macOS 尺寸 `.png` / `.icns`。

### 2. 修复缺失 macOS 端的 Vendored 插件：`packages/desktop_drop`
- **实查位置**：[`packages/desktop_drop/pubspec.yaml`](../../../packages/desktop_drop/pubspec.yaml)
- **现状问题**：当初因 Windows 虚拟图片/浏览器拖图定制，只保留了 `windows` 与 `web` 目录，删掉了 `macos/`。
- **改造要求**：从上游 `desktop_drop 0.8.4` 恢复完整的 `macos/` Swift 实现与 CocoaPod 配置，并在 `pubspec.yaml` 补回 `macos:` 平台声明；检查从 macOS 浏览器/访达/微信拖入图片或虚拟文件时 Cocoa Pasteboard 类型读取是否顺畅。

### 3. 后台启动器与路径定位：`packages/pi_rpc` & `Installation`
- **实查位置**：[`packages/pi_rpc/lib/src/core_client.dart`](../../../packages/pi_rpc/lib/src/core_client.dart)、[`packages/pi_rpc/lib/src/launcher.dart`](../../../packages/pi_rpc/lib/src/launcher.dart)、[`app/lib/state/installation.dart`](../../../app/lib/state/installation.dart)
- **改造要求**：
  - `PiRuntimeLocator.findNode`、`CoreLocator.findMain`：当程序以 `.app` 运行时，`Platform.resolvedExecutable` 在 `DreamFlutter.app/Contents/MacOS/dreamflutter`，因此搜索根除了 exe 所在目录及上级外，必须显式加上 **`p.join(p.dirname(p.dirname(Platform.resolvedExecutable)), 'Resources')`**（即 `Contents/Resources/`），否则打包后找不到 `runtime/node` 与 `core/src/main.ts`！
  - `CoreLocator.defaultDataDir` 与 `legacyDataDir`：对 `Platform.isMacOS` 且处于 `.app` 包内时，默认把可变数据放进 `~/Library/Application Support/DreamFlutter/data`（与 `core/src/paths.ts` 保持 100% 一致计算规则）；
  - `Installation.freeBytes`（[`installation.dart#L27-L32`](../../../app/lib/state/installation.dart#L27-L32)）：对 `Platform.isMacOS` 改用 `df -k <path>` 解析可用字节，避免磁盘空间校验永远返回 `null`。

### 4. 窗口标题栏、红绿灯、托盘图标与快捷键
- **实查位置**：
  - [`app/lib/desktop_shell.dart`](../../../app/lib/desktop_shell.dart)
  - [`app/lib/ui/window_frame.dart`](../../../app/lib/ui/window_frame.dart)
  - [`app/lib/ui/home_page.dart`](../../../app/lib/ui/home_page.dart)
  - [`app/lib/ui/keys.dart`](../../../app/lib/ui/keys.dart)、[`composer.dart`](../../../app/lib/ui/composer.dart)、[`sidebar.dart`](../../../app/lib/ui/sidebar.dart)、[`zoom.dart`](../../../app/lib/ui/zoom.dart)
- **改造清单**：
  - **托盘图标（`desktop_shell.dart#L32`）**：macOS 菜单栏不能加载 `.ico`！新增单色透明 PNG 图标（`assets/tray_icon_macos.png` + `@2x`）并按 `Platform.isMacOS` 传给 `trayManager.setIcon(..., isTemplate: true)`。
  - **隐藏标题栏与原生红绿灯位置**：Windows 把最小化/最大化/关闭画在右上角（`captionWidth = 138.0`），左侧栏直接顶到 `y = 0`。macOS 建议开启原生红绿灯（`windowManager.setTitleBarStyle(TitleBarStyle.hidden, windowButtonVisibility: true)`），同时：
    - **隐藏右侧 Windows 三键**（`AppTitleBar` 在 macOS 不画 `_captionButtons`，`captionInset` 在右端归零）；
    - **为左上角红绿灯留出安全顶距**（约 `38–44px` 高度 / 左侧 `~72px` 宽度），防止侧栏折叠开关与 Setup 页品牌栏被系统红绿灯遮挡！
  - **快捷键与提示文案**：把全应用 `HeldKeys.control` / `isControlPressed`（`Ctrl+B`、`Ctrl+O`、`Ctrl+K`、`Ctrl+V`、`Ctrl+滚轮`）收敛成语义化的 `HeldKeys.primaryShortcut`（Windows/Linux 认 `Control`，macOS 认 `Meta / Command`）；同时在 `keys.dart` 已通过 `Platform.isWindows` 跳过 `user32.dll`；把界面提示字符里的「`Ctrl+V`」「`Ctrl K`」动态显示为 macOS 的「`⌘V`」「`⌘K`」。
  - **打开目录与本地交付路径**：[`agent_controller.dart#L1035`](../../../app/lib/state/agent_controller.dart#L1035) 与 `#L1470` 在 `Platform.isMacOS` 时调用 `open -R <path>`（Finder 选中定位）与 `open <path>`；[`work_models.dart#L125-L132`](../../../app/lib/state/work_models.dart#L125-L132) 中 `isSandboxPath` 需适配 macOS 蝶君真实隔离目录而不再只认 `\\wsl.localhost\`。

### 5. 图表渲染（`WebSurface` → macOS `WKWebView`）与沙箱引导文案
- **实查位置**：[`app/lib/ui/web_surface.dart`](../../../app/lib/ui/web_surface.dart)、[`app/lib/ui/rich_blocks.dart`](../../../app/lib/ui/rich_blocks.dart)、[`app/lib/ui/sandbox_panel.dart`](../../../app/lib/ui/sandbox_panel.dart)、[`app/lib/state/onboarding.dart`](../../../app/lib/state/onboarding.dart)
- **改造要求**：
  - 给 `WebSurface` 增加 **macOS `WKWebView` 实现**（例如引入 `webview_flutter` 及其内置的 `webview_flutter_wkwebview` 实现离屏渲染与 `postMessage` JS 通道，或写一个 80 行 Swift `WKWebView` PlatformChannel 避免引整包重量），确保聊天页内的 `mermaid` / `chart` / `svg` 图表能 100% 与 Windows 一样画出来；
  - `sandbox_panel.dart` 与 `onboarding.dart` 在 `Platform.isMacOS` 下隐藏 `no-wsl` / `restart-needed` 的 WSL 安装页，直接体现「内置 macOS 原生隔离沙箱（无需额外装机与重启）」。

---

## 三、`scripts/` macOS 打包与交付脚本（新建 `scripts/package-macos.sh`）

仿照 [`scripts/package-windows.ps1`](../../../scripts/package-windows.ps1) 的产出结构，在 Mac CI/本机组装成标准应用包：
1. 调用 `flutter build macos --release --build-name=... --build-number=... --dart-define=DREAMFLUTTER_BETA=true`（内测版）；
2. 将精简后的 `core/`（含 `node_modules` 与 macOS 原生 `sherpa-onnx-darwin-*`、`core/bin/{uv,rg,fd,git,voice}`、`core/python`）、`runtime/node`（macOS 版）、`licenses/` 与 `beta-edition.json` 拷贝到 **`DreamFlutter.app/Contents/Resources/`**；
3. 对内含所有二进制可执行文件与 `.node`/`.dylib`/`.so` 执行权限确认与统一签名（Developer ID 签名 + 公证，或内测 Ad-hoc `codesign --force --deep --sign -`）；
4. 压缩为 `DreamFlutter-<version>-macos-<arch>.dmg`（或 `.zip`）交付内测。

---

## 四、朋友内测发布前必须过掉的 10 项一致性验收标准

1. **首次启动与激活（Beta 一键流程）**：干净未装过软件的 Mac 拖拽进 `/Applications` 后双击打开，不报写入 `.app` 权限错、直接进入激活码界面，数据准确落入 `~/Library/Application Support/DreamFlutter/data`。
2. **窗口、红绿灯与快捷键**：左上角红绿灯不压挡侧栏顶部按钮，隐藏关闭按钮可按设定缩回菜单栏 PNG 托盘或退出；`⌘B`、`⌘O`、`⌘K`、`⌘V`、`⌘+滚轮缩放` 与桌面拖拽文件/图片（`desktop_drop`）全部正常。
3. **API Key 加密与读取**：新增模型 Key、MCP Secret Env 后，目录里无明文泄露且 Keychain 不重复弹出授权打扰，重启软件能自动解密。
4. **工作台 Shell 与安全确认**：工作台执行只读命令（`ls`、`git status`）可在 `changes` 模式下免弹窗跑通；修改类命令或尝试读取 `~/.ssh`、`~/Library/Keychains` 被正常拦截并进审批。
5. **蝶君本地轻量隔离**：无需安装任何虚拟机软件，点开蝶君立即就绪；测试读取 `~/Desktop`、`~/.ssh` 被拒绝；切换「离线模式」时连外网及 `127.0.0.1` Core WS 端口均被拦截；开启「联网模式」能正常查资料并交付文件到 `outbox` 且 Finder 打开无误。
6. **Python、办公处理与 Mermaid 图表**：聊天中返回 `mermaid` / `chart` 代码块能正常绘制显示；工作台与蝶君均能用随包 Python + `matplotlib` 生成带中文字体 PNG 图片。
7. **HTML 离线视觉自检**：`render_html` 能顺利调用 macOS Chrome/Chromium 完成无头截图自检。
8. **本地离线语音输入**：麦克风权限弹窗提示正常，`record` 录音 + `sherpa-onnx-darwin-*` 本地模型能实时转写中文语音。
9. **核心长任务、记忆与 16 条已定型交互**：三层记忆自动提炼、长任务调度与退出后台弹窗确认、`settled-0.8.3` 守护体验全部一致。
10. **无残留重装验证**：删除 `.app` 与支持目录重新导入安装包，可干净复现首装流程。
