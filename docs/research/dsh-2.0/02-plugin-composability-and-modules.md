# 02｜插件组合度评估、独立 UI 模块与 SuperAgent 可行性分析

本文专门回答您在 2026-11-19 提出的三个核心技术问题：
1. DSH + Cordis 插件体系的**自由度与组合度**是否足够高？
2. 能否把「**番茄钟**」这类功能做成左侧栏可选的独立界面模块，右侧呈现它专属 UI，同时**与主平台共享同一套底层 Agent Runtime 与记忆插件**？
3. 能否把 DSH 团队发布的 **SuperAgent（`dsh-superagent-prototype`）** 接入并做成一个模块？以及后续如何安全地消费、反哺 DSH 插件市场？

---

## 一、核心判据：DSH 插件模型的组合度究竟有多高？

**直接答案：在后端运行时层，自由度与组合度完全足够；在前端界面层，存在跨框架边界（React vs Flutter），必须通过「双轨 UI 宿主层」来桥接。**

原因在于 Cordis 的能力组织方式不是平面的「钩子列表」，而是**树形作用域（Scoped Context Tree） + 声明式服务依赖（`inject`） + 自动副作用回收（`ctx.effect`）**：
- **横向组合（功能拼接）**：工具集、Prompt 片段、中间件、模型路由器、事件监听器各自作为独立插件声明 `inject`；例如「番茄钟模块」可以只组合 `timer-service` + `focus-memory-scope` + `ctx.llm` + `dsh-agent-loop`，而完全不拉入重型 `shell` 或文件读写工具。
- **纵向隔离（上下文作用域分叉）**：利用 Cordis 的作用域派生机制，**共享服务向上放，专属工具与提示词向下隔离**。不会出现装了 10 个功能模块后，主对话窗口的 System Prompt 被塞进 80 个杂乱工具导致模型降智和缓存失效的问题。
- **动态组合（运行期按需装卸）**：因为每个插件的资源都绑在自己 Fiber 的 `ctx.effect` 上，模块只有在用户进入或开启时才拉起对应的工具/监听器，关闭时 LIFO 自动回收，不占常驻上下文与内存。

唯一的硬边界不在 DSH 后端，而在 **前端渲染技术栈不同**：DSH 官方的 `ui-slots`、`ui-sidebar`、`ui-renderer` 是面向 React / 浏览器 DOM 写的插槽系统，无法直接丢进 Flutter Desktop 的 Widget 树里运行。想在 DreamFlutter 实现「插件自带独立右侧 UI」，必须明确设计「Flutter 与模块 UI 的衔接协议」。

---

## 二、目标场景 A：左侧栏独立模块（如番茄钟）+ 右侧专属 UI + 共享 Runtime 与记忆

您构想的形态非常清晰：
> 「做一个模块包（比如番茄钟），打包进软件后可在**左侧边栏**选择进入，**右侧**显示该模块专属 UI；但模块内 Agent 背后接的仍是**同一套底层平台 Runtime 与记忆系统**，让本来彼此孤立的好 Agent 能力可以整合在同一个平台里协同。」

这与 [`docs/roadmap.md`](../../roadmap.md) 第 7 节「1.0 之后 → v2.0 模块化平台」的长期方向完全吻合。实现这套架构需要「后端共享+隔离」和「前端双轨容器」两步配合。

### 2.1 后端：一套 Runtime 托管多模块（共享底层 + 隔离模块作用域）

```text
Root Cordis Context (平台唯一共享底座)
 ├── 核心共享层 (Global Singletons)
 │    ├── ctx.llm         (DreamFlutter 多模型组 Gateway + Ledger 硬预算)
 │    ├── ctx.memory      (三层记忆系统：共用记忆读取 + 按 moduleScope 标签防串味)
 │    ├── ctx.agentHost   (DSH ReactLoopAgent / Session Log 存储池)
 │    ├── ctx.attention   (统一「等你处理」审批/提醒收件箱)
 │    └── ctx.security    (DPAPI 密钥保护 + 路径/策略审计)
 │
 ├── Child Scope: [通用工作台 & 蝶君]
 │    └── 只看到工作台/沙箱工具 + 全局设定 + 允许召回全部偏好记忆
 │
 ├── Child Scope: [Module: 番茄钟 (pomodoro)]  <-- 独立 dsh.bundle
 │    ├── 注入共享: ctx.llm, ctx.memory(scope='pomodoro' + read('global_user_prefs'))
 │    ├── 私有服务: PomodoroTimerService (计时状态机、中断记录、专注统计)
 │    ├── 私有工具: start_focus / log_distraction / adjust_cycle
 │    └── 私有 Preset: 专注教练指令与极简工具白名单（隔离掉 shell/文件删除等无关工具）
 │
 └── Child Scope: [Module: SuperAgent 长任务台] <-- 独立 dsh.bundle
      └── 注入共享: ctx.llm(budget-guarded), ctx.memory, ctx.goalScheduler, ctx.sandbox
```

**关键解决的三个隐蔽兼容性问题**（您在语音中也提到「记忆等兼容性要在后面测试解决」，非常准确）：
1. **Prompt 隔离与缓存保护**：每个模块拥有独立的 `Session` 与专属 `Preset`（工具 Schema + 专属 System Prompt 前缀）。番茄钟里只挂载 3 个计时/统计工具，既省 Token、模型反应极快，又不会影响主聊天窗的 Prefix Cache。
2. **记忆互通但不串味（Memory Scoped Namespace）**：三层记忆插件需要升级出 **`namespace / visibility` 维度**：
   - 用户通用事实与作息偏好（例如「我习惯下午深度工作、讨厌被打断」）设为全局可读；
   - 模块内部流水账（例如番茄钟每次 25 分钟中断原因、某插件临时草稿）打上 `moduleId` 标签，默认只在模块内高频召回，仅在用户主动汇总或由提炼 Agent 抽取为跨领域洞察时才升入长期档案，防止不同模块把主对话的记忆池灌满噪音。
3. **跨模块能力调用**：因为共享同一 Core 进程，番茄钟计时结束时可以直接往共享 `Attention`（等你处理）发轻量提醒，或在用户允许时把当日专注结果作为一条事件写入「今日总结 / 记忆沉淀」。

### 2.2 前端：不打破 1.0 体验、面向四端的「左侧模块入口 + 右侧原生 UI」

> **2026-11-19 用户拍板**：1.0 现有 Flutter UI（聊天/蝶君/任务/记忆/设置及水墨纸感主题）**100% 保留**；未来新增功能模块（番茄钟、SuperAgent 等）**统一走 Flutter 原生界面路线**，而非 Windows 专属 `WebView2`，以便后续平滑覆盖 **Windows / macOS / iOS / Android** 四端。

按 [`AGENTS.md`](../../../AGENTS.md) 与 [`settled-behaviors.md`](../../design/settled-behaviors.md)，1.0 已定型的 16 条操作规则和核心页面形态保持不动。2.0 引入左侧栏新模块时，前端采用**「纯能力全动态 + 核心模块原生化 + 小面板协议化」**组合结构：

| 模块 / 插件类型 | 右侧 UI 承载方式 | 多端（Win/macOS/iOS/Android）表现 | 与底层 Runtime 的连接方式 |
| :--- | :--- | :--- | :--- |
| **类型一：纯能力插件**（无独立 UI） | 无需新界面，直接融入现有对话流、过程块与右侧「等你处理」收件箱 | **天然全端通用**，随后端插件动态热插拔即生效 | 仅在 DSH Core 激活工具与钩子，前端零改动 |
| **类型二：完整功能模块（主推路线）**<br>（如番茄钟、SuperAgent 控制台） | **Flutter 原生模块包**（独立 Dart 子包挂载在左侧栏模块区，完全共用 12 套名作主题、WenKai 字体与水墨质感） | **四端一套 UI 代码复用**，不依赖 Windows 专属 [`web_surface.dart`](../../../app/lib/ui/web_surface.dart)（`webview_windows`），零额外浏览器进程开销 | 通过抽象 [`AgentBackend`](../../../app/lib/state/backend.dart)（WS RPC + `SlotConnection` + `modules.capabilities` 能力宣告）与后端对应 `dsh.bundle` 通信（详见 [05-multiplatform-architecture.md](05-multiplatform-architecture.md)） |
| **类型三：轻量动态插件面板（未来预留）** | 仅当外部后端插件需要展示简短表单/指标卡时，采用**声明式 JSON UI 协议**由 Flutter 原生组件统一渲染 | 遵守 iOS AOT / App Store 规矩（不下载运行外部代码），保持原生流畅度 | 插件吐出结构化组件描述，事件回调经 Core RPC 回传给插件自身 |

> **工程落地建议**：前期「纯能力插件」只走后端；一旦进入带界面模块阶段，**先把「番茄钟」做成第一个「Flutter 原生模块包 + 后端标准化 `dsh.bundle`」端到端样板**，一次性验证「能力宣告 → 左侧栏挂载 → 右侧原生专页 → 共享 Runtime/Memory → 停用无残留」完整闭环。

---

## 三、目标场景 B：将 DSH 团队的 `SuperAgent` 做成一个模块

您提到的 **DSH 团队发布的 `SuperAgent`（论文/博文 *Exploring Super-agent Design* 及开源原型 `deepseek-ai/dsh-superagent-prototype`）**，我们针对其公开架构与已知实测数据做了深入对比。

### 3.1 `dsh-superagent-prototype` 真实架构与实测得失
根据公开仓库与技术报告（2026 年 10 月底发布，MIT 协议，约 `25k LOC` TypeScript，本身就是为 `dsh` 写的一套 Cordis 插件包）：
1. **Router / Worker 双层拓扑**：
   - **`dsh-superagent-router`（常驻轻路由）**：**严禁挂载 bash、重代码读写工具**，上下文极其轻薄、永远在线，专门负责承接来自 IM / GitHub / 多路事件源的请求，做准入分流、事件合并与任务派发；
   - **`dsh-superagent-worker`（瞬态重执行器）**：真正持有完整工具链与隔离工作目录/Worktree 的子 Agent 实例，并行处理具体复杂任务，完成后向 Router 汇报，**不直接和人类散乱闲聊**。
2. **Event-driven + Fast Path（事件过滤与快车道）**：
   - 外部噪音先经代码层过滤器筛掉，避免无谓唤醒大模型；
   - 对已经绑定某 Worker 的追踪线程（Tracked Thread），后续追加回复走 **Fast Path 直接路由给对应 Worker**，省去 Router 二次理解和中转延迟。
3. **Chain of Recall（链式引用回忆）**：
   - 针对超长多轮历史溢出的痛点，构建跨上下文引用的轻量检索图，按索引按需召回前序关键决策，避免把整段原始长日志塞回窗口。
4. **Watchdog（看门狗）**：
   - 独立巡检僵死、空转或卡死在某一步的 Worker，超时触发重试、降级或上抛人工介入。
5. **公开披露的真实性能与代价（必须正视的红灯数据）**：
   - **正面收益**：在其基准实验里，把长尾复杂任务的 **p95 完成耗时从 29.5 分钟压降到了 15.7 分钟**；
   - **真实代价（极其关键）**：整体 **Token 消耗膨胀了约 4 倍（~4x）**（高度依赖 Prompt Cache 命中读取来换取并行多路上下文覆盖率）；
   - **官方自述尚未完全解决的难点**：① 多轮多路下的**长期记忆退化（Long-term memory degradation）**；② 异步后台场景下的**安全授权边界（Security mandates）**。

### 3.2 为什么 DreamFlutter 2.0 接 SuperAgent 不仅可行，而且恰好是「绝配」？
看清 `dsh-superagent-prototype` 的优点和两个未解短板后，会发现 DreamFlutter 在 1.0 期间沉淀的架构组件正好精准补齐它最缺的那几块拼图：

| SuperAgent 原型的短板 / 缺口 | DreamFlutter 已有对应底座能力 | 融合后的 2.0 增效 |
| :--- | :--- | :--- |
| **~4x Token 消耗膨胀风险**（在普通个人电脑/自付 API 场景容易烧穿钱包） | **`Ledger` 账本 + 模型组路由（`core/src/modules/llm.ts` / `model-groups.md`）** | 给 SuperAgent 每个 Goal/Worker 强制套上 Token/人民币预算硬上限；Router、Watchdog 强制走轻量便宜模型，高难度 Worker 按阶段切换强模型，杜绝无上限烧钱 |
| **长期记忆退化**（官网未完结的开放问题） | **三层隔离提炼记忆（[`memory-design.md`](../../architecture/memory-design.md)）** | Router 不必靠自己塞满上下文硬扛，Worker 结束后由无工具 `MemoryAgent` 做结构化归档与反复活校验，形成跨任务长期经验 |
| **安全授权与人工打扰平衡**（Security mandates 难题） | **`SecurityService` 策略解析 + `Attention` 统一收件箱（`等你处理`）** | 危险操作统一由 `tools/pre-execute` 拦截并投递进桌面右侧「等你处理」单入口收件箱，不卡死其他并行 Worker，人点一次批量拍板 |
| **长任务状态、租约与停机恢复** | **`GoalScheduler` + 三层验收 + `ButterflyReliability` L0–L4（[`long-task-design.md`](../../architecture/long-task-design.md) / [`butterfly-reliability-notes.md`](../../design/butterfly-reliability-notes.md)）** | 把 DSH/SuperAgent 的 Worker 状态并入 DreamFlutter 既有 `goals / tasks / runs` 租约与三层验收框架，断电/重启能续跑，Stop 语义确定可中止 |

### 3.3 SuperAgent 在 DreamFlutter 中的产品形态设计
- **不需要另起一套外挂架构**：`dsh-superagent` 本身就是 DSH 的 Cordis Bundle。切到 DSH 底座后，只需将其 Router、Worker、FastPath、Chain of Recall、Watchdog 作为可选功能包引入，把它的存储与模型口对接到 DreamFlutter 的 `ctx.llm` / `ctx.goal` / `ctx.sandbox` / `ctx.attention`。
- **界面落位**：不破坏 1.0 现有的「聊天 / 蝶君 / 任务」三主入口；SuperAgent 可作为左侧栏「任务」的 2.0 进阶引擎或独立侧栏模块打开，呈现 **Router 派发队列 + 并行 Worker 状态卡片 + 合并入「等你处理」的审批票据流**，同时每个 Worker 在蝶君的轻量隔离环境（见 [03-butterfly-lightweight-isolation.md](03-butterfly-lightweight-isolation.md)）中以独立子工作目录/worktree 并发跑，互不踩文件。

---

## 四、DSH 插件市场接入与反哺生态路径

您在语音里提到两个具体预期：
1. 「利用 DSH 现成成熟的插件市场生态，节省大量开发成本」；
2. 「把 DreamFlutter 独有的一些模块（甚至自己写的模块）写成标准插件，反手发布到 DSH 市场、贡献资源」。

### 4.1 消费 DSH 生态：`dsh-plugin` 体系现状与安全前提
根据对 `deepseek-harness` 生态的调研：
- **分发标准**：社区与官方插件通常带有 `dsh-plugin` 标签（GitHub / npm），清单由索引目录（`index.json`）聚合，通过 `boot/plugin-manager`、`dsh plugin add`、`dsh-market` / `dsh-find-plugin` 检索安装进本地 `bundle`。
- **一个极其关键的现实提醒**：在本地调研基线 `ce7073d` 的 `web-app` 预设里，`plugin market` 默认处于关闭（disabled）状态——核心原因就是桌面端 Agent 具有真实文件与命令执行权，未经审核的第三方 npm 插件与本地提权风险极高。
- **DreamFlutter 的接入策略**：
  1. **分两步开放**：2.0 初期先「**开发者/预设白名单安装**」+ 支持标准 `dsh-plugin` 纯能力插件，把校验逻辑接进 DreamFlutter 的 `tools/pre-execute` 安全审计里（任何新安装插件必须声明它申请的工具能力、网络访问范围与文件系统作用域）；
  2. **UI 安全隔离与四端一致性**：因选定 Flutter 原生路线，默认**不直接放开未审计的第三方 Web UI 插件嵌入主端**；如果外部插件只是工具/流程扩展，全部走纯能力接入由 Flutter 原生界面统一呈递结果，确保 Windows / macOS / iOS / Android 一致可控；
  3. **默认工具契约对齐**：安装官方插件时，DreamFlutter 的 Core 提供标准化 Service（如 `llm`、`fs`、`sandbox`、`storage`），避免插件因为找不到特定宿主 API 而报错。

### 4.2 将 DreamFlutter 特色插件发布回 DSH 生态
哪些能力最值得抽出来以「DreamFlutter 团队」身份开源或贡献给 DSH 市场？
1. **`dsh-plugin-ledger-router`（硬预算账本 + 多模型组分级路由插件）**：正好解决 SuperAgent 等场景下 Token 失控痛点，全社区都会缺这个；
2. **`dsh-plugin-three-tier-memory`（独立无工具提炼 + 反复活三级记忆插件）**：比简单的 `MEMORY.md` 拼接工程化得多，也是 SuperAgent 论文点名需要提升的方向；
3. **`dsh-sandbox-windows-appcontainer`（Windows AppContainer + JobObject 轻量目录沙箱 Provider）**：填补官方只有 WSL2 与 `partial` 级 `windows-acl` 的生态空白（详见下一篇 [03-butterfly-lightweight-isolation.md](03-butterfly-lightweight-isolation.md)）；
4. **领域功能后端包（例如番茄钟后端能力包 `dsh-module-pomodoro`）**：只要遵守「纯 Cordis 后端服务与状态协议、不硬编码 Flutter 私有依赖」，同一份后端包既可以支撑 DreamFlutter 四端原生模块界面，也能给 DSH Web 社区复用。

**反向发布的唯一纪律**：后端插件内部 **严禁硬编码 Flutter 私有通信细节或单个操作系统特定路径**，统一通过 Cordis `inject` 向宿主请求标准能力（`llm`、`storage`、`goal`、`sandbox`、`http/rpc`）。
