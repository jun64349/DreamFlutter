# DreamFlutter 2.0 架构迁移与模块化底座调研总览

> **2026-11-20 更新**：用户已将这次底座迁移定为 **V1.1.0**。范围为现有平台迁至官方 DSH、已有功能尽量内置为固定系统插件、蝶君去掉 Linux 并验收原生工作空间。见 [现行范围](../../roadmap.md)、[当前进度](../../HANDOFF.md) 和 [POC-1 Windows 回执](poc-1-windows.md)。下文及目录名保留 11 月 19 日的调研历史，后续版本待 V1.1.0 完成后规划。

> **调研范围与性质**：本文档集为 2026-11-19 的纯技术调研与方案论证记录，**不修改现有 1.0 代码与路线（`1.0.0-preview.2` 内测照常进行）**，用于作为下一阶段启动 DreamFlutter 2.0 工程前的决策依据与知识底座。

---

## 一、文档目录与阅读索引

| 序号 | 文档 | 解决的核心问题 | 关键结论摘要 |
| :---: | :--- | :--- | :--- |
| 0 | **[README.md](README.md)**（本文件） | 总览与拍板清单 | 汇总全部结论、前置 POC 验证门槛与需用户决定的事项 |
| 1 | **[01-dsh-architecture-and-cordis.md](01-dsh-architecture-and-cordis.md)** | 官方 DeepSeek Harness（DSH）与 Cordis 底层是怎么设计的？ | 拆解 Cordis 时空可组合性、`inject`、6 态 Fiber、三元能力缝、ReactLoopAgent、Session Log SSOT，并逐项对比 DreamFlutter 现有 `Pi 1.4.0` 底座 |
| 2 | **[02-plugin-composability-and-modules.md](02-plugin-composability-and-modules.md)** | 插件自由度/组合度够不够做「独立 UI 模块（番茄钟等）」和「SuperAgent」？ | 后端**完全支撑**「模块隔离工具/Prompt + 共享一套 Runtime 与记忆」；SuperAgent 与现有长任务/记忆/账本互补性极高；前端**定调走 Flutter 原生模块路线**以支撑多端迁移 |
| 3 | **[03-butterfly-lightweight-isolation.md](03-butterfly-lightweight-isolation.md)** | 蝶君能否拆掉 4GB+ WSL2 虚拟机，在软件内部做目录级隔离？ | 主推 **Windows `AppContainer` + 应用自拥有目录 ACE + `Job Object` + WFP 网络开关**，并复用随包标准 Windows 工具链（0 额外镜像/无虚拟机节点）；需先过 4 项 POC 测试 |
| 4 | **[04-migration-bridge-and-ui-perf.md](04-migration-bridge-and-ui-perf.md)** | 如何保持前端 1.0 交互稳定实现平滑换心，以及前端卡顿从哪来？ | 给出 `CoreModule` → Cordis 插件全量映射表、WS RPC/Slot 稳定桥接层设计，以及对 `PaperGrain`/`PaintingBackdrop`/`AgentScope` 等 4 处真实渲染瓶颈的代码级定位 |
| 5 | **[05-multiplatform-architecture.md](05-multiplatform-architecture.md)** | 后续扩展 macOS / iOS / Android 时，前后端如何适配？ | 前端复用 Flutter 原生框架（实查当前 `app/` 仅少数外围 Windows 绑定）；桌面端本地跑 DSH Core + 平台沙箱插件，移动端通过已有 `AgentBackend` 抽象切为远程/伴侣 Core（`wss://`） |

---

## 二、核心问题一页纸结论

### 1. 为什么切到官方 DSH + Cordis，而不是继续在 Pi 1.4.0 上修补？
DreamFlutter 当前在 `core/src/pi/host.ts` 已经不得不通过运行时覆写（monkey-patch）来屏蔽 Pi 1.4.0 的压缩、重试、超时和历史配置逻辑，并在 `core/src/core.ts` 自研了 `CoreModule` 插件缝来组织业务。但两者对比存在三个结构性代差：
1. **生命周期与热插拔**：现有 `CoreModule` 没有依赖声明图和副作用自动回收容器；Cordis 通过 `ctx.effect()` / `ctx.on()` 的 LIFO 自动回收与 6 态 Fiber 状态机，天然支持运行期动态装卸插件与热重载（HMR）。
2. **模型与工具主链**：DSH 原生把「Append-Only Session Log 单一事实源」「`pre-step / request / turn-stopping` 瀑布流」「`pre-execute / execute / post-execute` 受控工具管道」「提示词缓存稳态工程」「Tool Output Pruner」做成标准插件协议，正好契合 DreamFlutter 2.0 需要的可靠性与可扩展性。
3. **生态复用**：沿用官方 DSH 底座，才谈得上直接消费 `dsh-plugin` 社区插件生态（以及后续把 DreamFlutter 特色插件回馈发布上去），避免自己长期重复造底座。

### 2. 插件自由度与组合度能否支撑「独立 UI 模块 + 共享 Runtime/记忆」与「SuperAgent」？
- **结论：架构上完全可行，但必须区分「后端能力组合」和「前端界面承载」两层来解。**
- **后端共享与隔离可以同时满足**：在 Cordis 中，「底层共享服务（模型网关 `ctx.llm`、三层记忆 `ctx.memory`、账本 `Ledger`）」挂在根作用域或平台核心作用域；每个左侧栏模块（如番茄钟模块）以独立 `dsh.bundle` + 隔离的 Child Context / Prompt Preset 运行，只向当前模块会话暴露它自己的工具与提示词，互不污染通用对话，但底层推理 Runtime 与长期记忆仍是同一套。
- **前端 UI 宿主与多端策略（已定调）**：DSH 的 `ui-slots` / `ui-sidebar` / `ui-renderer` 是面向 React 浏览器的 DOM 体系，**不直接用于 DreamFlutter**。同时**原有 1.0 Flutter 界面与 [`settled-behaviors.md`](../../design/settled-behaviors.md) 的 16 条已定型交互 100% 保留不动**。结合后续拓展 **macOS / iOS / Android 多端**的战略规划：
  - 第一阶段（纯能力插件）：只接后端无界面 `dsh-plugin` 插件，不改现有界面结构；
  - 后续带 UI 的功能模块（如番茄钟、SuperAgent 控制台）：**统一采用 Flutter 原生界面路线**（模块化 Dart 包 + 后端 `dsh.bundle` 能力宣告），放弃以 Windows 专属 `WebView2`（[`web_surface.dart`](../../../app/lib/ui/web_surface.dart)）作为主模块承载器，保证四端体验一致、迁移成本最低与水墨主题贴合（详见 [05-multiplatform-architecture.md](05-multiplatform-architecture.md)）。
- **SuperAgent 模块可行性**：`deepseek-ai/dsh-superagent-prototype` 本身就是一套基于 DSH/Cordis 构建的 `~25k LOC` 插件包（Router/Worker 隔离 + 事件过滤/Fast Path + Chain of Recall + Watchdog）。值得特别注意的是，它公开试验暴露出的两大短板——**Token 消耗膨胀约 4 倍**与**长程记忆退化 / 权限边界模糊**——恰恰能被 DreamFlutter 现有的 **Ledger 硬预算体系**、**三层记忆提取（`MemoryModule`）** 和 **`Attention` 统一待办审批箱**直接补齐。

### 3. 蝶君能否取消 WSL2 虚拟机，在软件内部做到真隔离？
- **结论：技术上可行，主推 Windows 原生 `AppContainer` 方案，但上线前必须先通过便携工具链 POC 验证。**
- **现状痛点**：当前基于 WSL2 的方案（[`sandbox.ts`](../../../core/src/sandbox/sandbox.ts)）需要约 `653MB` 压缩镜像与约 `4.25GB` 运行期磁盘占用（`clean.vhdx` + `ext4.vhdx`），安装需引导系统开启 WSL 甚至重启、在资源管理器多出「`此电脑 › Linux`」节点，卸载还需等待注销虚拟机。
- **为什么不是仅靠 ACL 或字符串过滤**：
  - 纯路径字符串拦截可以被脚本/子进程轻松绕过，无法支撑「免审批自由折腾」；
  - DSH 官方的 `@deepseek-ai/dsh-sandbox-windows-acl`（同 Codex 路线）走的是 `WRITE_RESTRICTED` 受限令牌 + NTFS ACL，属于**`partial`（部分隔离）**：防写不防读（能读主机桌面/SSH 密钥等）、缺少原生网络开关，且非管理员对系统/他人目录改 ACL 易触发 `ERROR_ACCESS_DENIED (5)`。
- **为什么 Windows `AppContainer` 恰好命中 DreamFlutter 的痛点**：
  - `AppContainer` 天然具备**读写双向目录白名单**、**注册表/命名对象隔离**以及基于 WFP 能力位的**真离线/联网隔离**（默认不给本地回环与内网权限，蝶君子进程连本机 Core WebSocket 都摸不到），并且 **0 虚拟机、0 额外安装包、毫秒级启动、不会在「此电脑」里多出 Linux 图标**。
  - 更关键的是，普通工具难用 `AppContainer` 是因为给用户已有大目录打 SID ACE 权限很慢且受权限限制；而蝶君的「自处理自成长沙箱」本来就是 DreamFlutter 自己创建并拥有的 `data/butterfly-space/` 目录——**软件自身就是目录属主（Owner），非管理员即可直接、干净地为该私有目录与随包工具目录授予精确 ACE**，再配合 `Job Object` 管住整个子进程树和内存/CPU 上限，复用已打包的便携版 Python / Node / MinGit / `rg` / `fd` / `uv`，包体几乎不增重。
  - **诚实局限**：内部只能跑 Win32 原生工具链，不能直接运行 Linux ELF 二进制或 `apt` 包；便携 Python 科学栈（如 `matplotlib`/`pandas`/字体与临时目录）在 `AppContainer` 里的兼容性必须先做实体 POC 验证。

### 4. 如何平滑换掉底层并顺带解决 Flutter 卡顿？
- **架构边界**：`docs/api/` 定义的 **15 域 WebSocket RPC** 与 [`slot_connection.dart`](../../../packages/pi_rpc/lib/src/slot_connection.dart) 承载的 **`df_*` 指令与会话事件流**，作为 1.0 → 2.0 的「不动契约边界」。后端把 `Pi 1.4.0` 与自研主循环整体替换为「官方 DSH + Cordis Runtime + DreamFlutter 业务插件集 + RPC 兼容适配器」，前端无感迁移，16 条已定型操作全部保留。
- **Node 版本前置条件**：当前 `core/package.json` 要求 Node `>=22.19.0`，而官方 DSH（本地调研基线 `docs/research/deepseek-harness.md`）要求 Node `>=24.9`，2.0 立项时需要同步升级内置 Node 运行时并重新评估包体变化。
- **Flutter 卡顿的四个明确根因**（均为本次只读代码排查实证）：
  1. `home_page.dart` 最顶层覆盖整窗的 `PaperGrain` 使用 `Opacity` 包裹平铺噪点图且缺 `RepaintBoundary`，触发全屏离屏 `SaveLayer` 合成；
  2. `PaintingBackdrop` 把静态水墨渲染与 22 秒周期的 `PaintingMotif` 动画混在同一绘制层，`HomeButterflyMark`/`ButterflyAvatar` 在 `AnimatedBuilder` 内直接套 `Opacity`，全 `app/lib/` 仅 `web_surface.dart` 有一处 `RepaintBoundary`；
  3. `AgentScope`（`InheritedNotifier<AgentController>`）被 `HomePage`、`Sidebar`、`ChatView` 等粗粒度订阅，流式输出与后台轮询会连带触发整棵界面树重build；
  4. `HomePage` 的 `IndexedStack` 全量保活及历史占位结构，需要配合后续模块视图切换做懒加载与精细监听拆分。

---

## 三、进入 2.0 编码前必须先过的 4 项 POC 验证门禁

本着可靠性工程「**先证明边界可行，再重构主干**」的原则，建议正式开写 2.0 代码前按顺序完成 4 个最小验证：

1. **POC-1（D1｜DSH 官方源码基线核验）**：拉取当前最新 `deepseek-ai/deepseek-harness` 与 `deepseek-ai/dsh-superagent-prototype`，对照 Node `24.9+` 运行环境，实测最小 Cordis Bundle 启动、Session Log 落盘与 Windows 兼容状态。
2. **POC-2（D2｜多模型网关 + Ledger 适配原型）**：验证 DSH 的 `ctx.llm` 服务缝能否无损接住 DreamFlutter 现有多提供商模型组（含 GPT Pro / Responses API 差异）与每次调用前后的 `Ledger` 硬预算拦截。
3. **POC-3（D3｜AppContainer 沙箱内跑通真实工具链）**：编写最小 Win32 helper（`CreateAppContainerProfile` + `Job Object` + 私有目录 ACE），验证当前随包便携版 `python` / `uv` / `node` / `git` / `rg` 在其中能否正常读写私有工作区、出图（`matplotlib`）、且**确定无法**读用户桌面与 SSH 目录、**确定无法**在离线模式下连外网或本机 `127.0.0.1`。
4. **POC-4（D4｜Flutter 卡顿基线测量）**：在现有 1.0 上跑一轮 Flutter DevTools Frame / Raster 采样，验证隔离 `PaperGrain` 合成层与拆分 `AgentScope` 局部监听后的帧耗时下降幅度（这部分优化甚至可直接反哺 1.0 体验）。

---

## 四、已拍板架构决策与推进节奏（2026-11-19 用户确认）

1. **DSH 接入方式——严格跟随官方架构**：不另起魔改叉分支，直接在官方 `deepseek-harness`（Cordis）包体系与扩展契约之上搭建 DreamFlutter 平台插件与业务包。
2. **蝶君隔离路线——软件内置 Windows 原生 `AppContainer` 私有目录隔离**：拆掉沉重的 WSL2 虚拟机，利用系统原生 `AppContainer` + 目录 ACE + `Job Object` 实现软件内部目录级隔离与免安装/无虚拟机显示；内部运行标准 Windows 原生命令行/脚本工具（`.exe` 格式的 Python、Node、Git 等，而非 Linux `apt` 环境），并预留 DSH `sandbox` 能力缝供后续 macOS 原生沙箱替换。
3. **模块 UI 路线与多端规划——坚持 Flutter 原生界面（服务 Win / macOS / iOS / Android 四端）**：1.0 现有 UI 全部保留不变；未来新增功能模块（番茄钟、SuperAgent 等）全部采用 **Flutter 原生 UI 模块**开发以利四端迁移；后端则在桌面端（Win/macOS）本地运行、移动端（iOS/Android）通过 `AgentBackend` 抽象重新适配为远程/桌面伴侣连接模式（见 [05-multiplatform-architecture.md](05-multiplatform-architecture.md)）。
4. **启动时间表**：当前重心仍在 **1.0 内测收口与正式版发布（预计 1–2 周后发 1.0 正式版）**；**待 1.0 正式发布后再启动 2.0 代码实施与上述 POC 原生验证**，这 1–2 周内以调研完善与 1.0 稳定性收口为主，暂不动生产代码。

### 留待 2.0 开工时细化的两个小问题
- 未来如果社区第三方 DSH 插件确实带了简短配置交互卡片，是否需要补充一套「后端吐 JSON 描述、Flutter 原生组件统一渲染」的轻量声明式 UI 协议（不引入 WebView 也能显示小型扩展面板）？
- 极少数用户若在 Windows 上遇到必须运行 Linux 专属软件的场景，是否完全不提供，还是保留一个不随主包默认安装的「可选外部 Linux/Docker 扩展插件」开关？
