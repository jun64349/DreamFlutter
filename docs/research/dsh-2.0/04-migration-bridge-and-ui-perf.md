# 04｜2.0 后端平稳迁移路线（保前端契约）与 Flutter 界面卡顿定位

本文聚焦两个落地问题：
1. 在**不动前端 1.0 已定型交互与操作逻辑**的前提下，如何把 `core/` 从 `Pi 1.4.0` + 自研模块框架平滑替换成 **官方 DSH + Cordis**？
2. 针对您在试用中感受到的「**前端界面有卡顿、延迟感**」，给出本次通过只读排查 Flutter UI 代码定位到的真实渲染瓶颈与改进方案。

---

## 一、迁移的「不动边界」与「替换边界」

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  【不动层】Flutter Desktop 前端（app/）                                    │
│   • 死守 settled-behaviors.md 全部 16 条已定型交互与守护测试                   │
│   • 后续仅做渲染性能优化（RepaintBoundary / 降 Opacity SaveLayer / 局部订阅）│
│   • 2.0 后期新增左侧栏「模块」容器 + WebSurface（WebView2）承载扩展 UI       │
└───────────────────────────────▲─────────────────────────────────────────┘
                                │
             【稳定边界协议：零改动 / 向后兼容】
             • docs/api/ 15 域 WebSocket RPC（含本地令牌鉴权）
             • SlotConnection（df_* 指令与会话流式事件映射）
                                │
┌───────────────────────────────▼─────────────────────────────────────────┐
│  【换心层】Node.js 24.9+ Core 后端（core/）                              │
│   • 拆掉：Pi 1.4.0（core/src/pi/host.ts）及对 settingsManager 的猴补丁    │
│   • 换入：官方 DSH + Cordis Runtime（ReactLoopAgent / Session Log SSOT）  │
│   • 保留并插件化：Gateway + Ledger + 三层记忆 + GoalScheduler + Security  │
│   • 新增：WS RPC / Slot 兼容适配器 + AppContainer 沙箱 Provider           │
└─────────────────────────────────────────────────────────────────────────┘
```

### 三条迁移铁律
1. **前端不跟着重做**：[`settled-behaviors.md`](../../design/settled-behaviors.md) 的 16 条体验契约及守护测试在 2.0 期间保持原样通过。
2. **协议契约先行**：[`docs/api/README.md`](../../api/README.md) 约定的 **15 域 WebSocket RPC** 与 [`packages/pi_rpc/lib/src/slot_connection.dart`](../../../packages/pi_rpc/lib/src/slot_connection.dart) 承载的 **`df_*` 指令与流式事件格式** 不得直接推翻；后端先做一层兼容映射桥（Bridge Adapter），让 Flutter 窗口以为底层还是原先那套 Slot 与 RPC，从而做到「**只换后心，前端无感**」。
3. **Node 版本与集中存储守恒**：官方 DSH 要求 **Node `>=24.9`**（[`deepseek-harness.md#L547`](../deepseek-harness.md#L547)），而目前 [`core/package.json`](../../../core/package.json) 为 `>=22.19.0`。切换底座时需同步升级随包内置 Node 并重测包体；集中数据目录结构与 1.0 历史对话（Pi JSONL）的只读迁移/查看兼容也要在桥接层里兜住。

---

## 二、现有 `Core` 模块向 DSH / Cordis 的逐类迁移映射表

通过核对 [`core/src/app.ts`](../../../core/src/app.ts)（`buildCore` 中注册的 `27` 处模块/服务）与 [`core/src/core.ts`](../../../core/src/core.ts)（`Core` 构造函数内直接装配的 `PersonaModule`、`GoalsModule`、`AutonomyModule`、`SelfworkModule`、`PatrolModule`、`JobsModule`、`PythonFilesModule`、`RenderHtmlFilesModule` 以及核心服务 `SecurityService`、`LibraryRegistry`、`ConfirmationStore`、`RunStore`），现有后端可以清晰地拆成三类迁移路径：

| 类别 | 现有代码模块 | 2.0 去向（DSH + Cordis 对应落位） | 迁移难点与适配动作 |
| :--- | :--- | :--- | :--- |
| **1. 底座替换类**<br>（弃旧换新） | `PiHost`（[`core/src/pi/host.ts`](../../../core/src/pi/host.ts)）、[`slots/slot.ts`](../../../core/src/slots/slot.ts)、[`agent/harness.ts`](../../../core/src/agent/harness.ts)、`dsh-text.ts`、`tool-environment.ts` | **整体替换为官方 DSH Core**<br>（`ReactLoopAgent` + Append-Only Session Log + 原生 Compaction + Persistent Pruner） | **高**：需在兼容层把 DSH 的 Session 事件流实时翻译为 `SlotConnection` 期望的事件与 `df_*` 指令回执；同时为历史 Pi JSONL 会话提供只读兼容读取或一次性导入 |
| **2. 核心护城河迁移类**<br>（保留规则，封装为标准 Cordis 插件） | `Gateway` & `Ledger`（[`core/src/modules/llm.ts`](../../../core/src/modules/llm.ts)） | **实现 DSH `ctx.llm` Provider 插件**<br>`@dreamflutter/dsh-llm-gateway` | **中**：DSH 默认偏向单一 Provider/Messages API，必须将我方多模型组路由、GPT Pro / Responses API 差异化处理、以及每次调用前后的**硬预算扣费**注入到 DSH `agent/request` 与 `llm` 服务缝里 |
| **2. 核心护城河迁移类** | 三层记忆系统（[`memory-design.md`](../../architecture/memory-design.md)） | **实现标准插件**<br>`@dreamflutter/dsh-three-tier-memory` | **中**：把现有基于 Pi 的 `before_agent_start` + `context` 注入改写为 DSH `agent/pre-step`（保持稳态前缀不被动态记忆破坏 Prompt Cache！）；扩展 `moduleScope` 维度服务于 2.0 多模块隔离 |
| **2. 核心护城河迁移类** | `GoalScheduler`、`GoalsModule`、`AutonomyModule`、`PatrolModule`、`SelfworkModule`、`JobsModule` | **挂载为 Cordis 自治插件族**（复用 DSH `goal`/`schedule` 契约，保留 DreamFlutter 租约、3 层验收与停机语义） | **中**：保留单个 `GoalScheduler` 租约调度与三层验收核心状态机，用 `ctx.effect` 管理定时器和事件 watch，避免重造或退化回简单 cron |
| **2. 核心护城河迁移类** | `SecurityService`、`ConfirmationStore`、`Attention` 收件箱 | **接入 DSH `tools/pre-execute` / `post-execute` 管道** | **低–中**：原有的保守 PowerShell 解析、deny/confirm/allow 路径策略与 DPAPI 密钥脱敏，天然契合 DSH 3 阶段工具管道，改为在 `pre-execute` 阻塞/入队「等你处理」，在 `post-execute` 做脱敏 |
| **2. 核心护城河迁移类** | `PersonaModule`、`LibraryRegistry`、`PythonFilesModule`、`RenderHtmlFilesModule`、`RunStore` | **平移为标准业务 Cordis 插件**（借助 `ctx.effect` 与 `tools/*` 注册） | **低**：逻辑自包含度高，只需去掉对 Pi `ExtensionFactory` 类型的直接依赖 |
| **3. 沙箱升级类** | `Sandbox`（[`core/src/sandbox/sandbox.ts`](../../../core/src/sandbox/sandbox.ts)） | **替换为 `@dreamflutter/dsh-sandbox-windows-appcontainer`** | **高（先 POC 后替换）**：实现 DSH `sandbox` 服务缝，底层走 Windows `AppContainer` + `Job Object` + WFP（详见 [03-butterfly-lightweight-isolation.md](03-butterfly-lightweight-isolation.md)） |
| **4. 历史债顺手清零** | 窗口端直接读删部分会话文件、多处分散预算判断（[`architecture.md`](../../architecture/architecture.md)） | **彻底收口到 Core API 与 `Ledger` 唯一出口** | **低**：趁搭建 WS RPC 桥接层一并清理窗口侧遗留的直接磁盘文件操作 |

---

## 三、分阶段迁移路径（稳步换心，不中断产品节奏）

1. **Phase 0｜POC 门禁验证（预计 1.0 正式发布后 1–2 周内于独立分支启动）**：完成 [README](README.md) 第三节列出的 4 项 POC（官方 DSH Node 24.9 跑通、Gateway/Ledger `ctx.llm` 适配、`AppContainer` 沙箱跑通便携工具链、Flutter DevTools 性能采样）。
2. **Phase 1｜双壳兼容换心（严格基于官方 DSH，只接纯能力插件，前端界面零大改）**：
   - 搭建基于官方 DSH + Cordis 的新 `Core` 进程；
   - 将现有业务模块迁移进 Cordis，同时上线 **15 域 WS RPC + `SlotConnection` 兼容桥**；
   - 测试标准：**原有所有桌面交互测试 + 16 条已定型守护测试全部 100% 通过**，同时打通首批第三方无界面 `dsh-plugin` 纯能力插件。
3. **Phase 2｜蝶君沙箱轻量落地**：
   - 将经过 POC-3 验证的 Windows 原生 `AppContainer` 沙箱接入 DSH `sandbox` 服务缝；
   - 去掉内置 WSL2 镜像与复杂安装卸载逻辑，验证包体与装卸体验。
4. **Phase 3｜前端卡顿优化 + 左侧栏原生模块容器（番茄钟 / SuperAgent 上线）**：
   - 落地本文第四节的 Flutter 渲染性能优化（抽象平台适配层，不依赖 `WebSurface`）；
   - 在左侧栏加入「模块」入口，打通「后端 `modules.capabilities` 宣告 + Flutter 原生模块包按需挂载」，落地第一个标准功能模块样板（如番茄钟）及 **SuperAgent 模块**。
5. **Phase 4｜多端扩展与生态反哺（详见 [05-multiplatform-architecture.md](05-multiplatform-architecture.md)）**：
   - 将 Flutter 前端推广至 macOS / iOS / Android：macOS 配对本地 Core + macOS 原生沙箱插件，iOS / Android 通过 `AgentBackend` 接入远程/桌面伴侣模式（`wss://`）；
   - 整理安全审核过的 DSH 纯能力插件目录，并抽离发布 DreamFlutter 原创标准插件（Ledger 路由器、三级记忆、AppContainer 沙箱等）。

---

## 四、Flutter 前端现有卡顿与延迟的代码级诊断

本次在**不改动代码**的前提下，对 `app/lib/` 进行了重点只读排查，发现目前界面掉帧、拖动/切换卡顿及打字流式输出偏沉重，**不是 Flutter 框架本身慢，而是有四处明确的高开销渲染写法叠加在了一起**：

### 问题 1｜全窗口顶层 `PaperGrain` 触发整屏离屏合成（最高优先级）
- **实查代码坐标**：
  - [`app/lib/ui/home_page.dart#L151-L154`](../../../app/lib/ui/home_page.dart#L151-L154)：在主界面最顶层 `Stack` 中放了一个铺满整窗的 `Positioned.fill`，包裹 `PaperGrain`；
  - [`app/lib/ui/painting_background.dart#L235-L238`](../../../app/lib/ui/painting_background.dart#L235-L238)：`PaperGrain` 内部直接使用 `Opacity(opacity: ..., child: const Image(image: _noise, repeat: ImageRepeat.repeat, gaplessPlayback: true))`。
- **卡顿机理**：
  - 在 Flutter 渲染管线里，当 `Opacity` 包裹一块区域且内部是重复纹理贴图（`ImageRepeat.repeat`）时，引擎往往需要为整块区域分配**全屏离屏缓冲（`SaveLayer`）**再统一混合透明通道；
  - 更糟的是它盖在最上层且**外层没有任何 `RepaintBoundary` 隔离**——下方聊天流每吐一个字、光标每闪一下、或者动画每走一帧，都会连带把整张窗户尺寸的噪点覆盖层重新拖进合成计算，在高分屏/软件或集成显卡上开销极高！
- **建议解法**：
  - 改用 `Image` 自带 `color: Colors.white.withValues(alpha: ...)` 配合 `colorBlendMode: BlendMode.modulate`（直接把透明度乘在图片着色器里，彻底消除 `Opacity` 的 `SaveLayer` 开销）；
  - 给 `PaperGrain` 外层严格加上 `RepaintBoundary` 隔离，使其作为独立 GPU 静态缓存纹理层，不再随下方聊天区域逐帧重绘。

### 问题 2｜静态背景、长循环动画与头像渐变共用绘制层，全应用几乎零 `RepaintBoundary`
- **实查代码坐标**：
  - 全局检索 `RepaintBoundary`，整个 `app/lib/` 中**仅 [`app/lib/ui/web_surface.dart`](../../../app/lib/ui/web_surface.dart) 有一处使用**；
  - [`app/lib/ui/painting_background.dart#L28-L50`](../../../app/lib/ui/painting_background.dart#L28-L50)：`PaintingBackdrop` 把纯静态的底色 `ColoredBox`、复杂水墨 `CustomPaint(_PaintingWashPainter)`、`CustomPaint(PaintingPatternPainter)`，与一个 **22 秒连续摆动的动画 `PaintingMotif`** 塞在同一个无隔离 `Stack` 里；
  - [`app/lib/ui/painting_art.dart`](../../../app/lib/ui/painting_art.dart)、[`app/lib/ui/butterfly_motion.dart`](../../../app/lib/ui/butterfly_motion.dart)、[`app/lib/ui/shell_widgets.dart`](../../../app/lib/ui/shell_widgets.dart) 中的 `HomeButterflyMark` / `ButterflyAvatar` 在 `AnimatedBuilder` 内部也存在用 `Opacity` 做动态渐变的写法。
- **卡顿机理**：动画节点和静态复杂水墨路径没有隔开，`PaintingMotif` 或蝶君呼吸动画一跳帧，就会连带着旁边复杂的背景 `CustomPaint` 一起被迫失效重画或重新上传指令；叠加 `AnimatedBuilder` 里的 `Opacity` 进一步增加每帧合成图层的成本。
- **建议解法**：
  - 在 `PaintingBackdrop` 中把静态画底（底色 + `_PaintingWashPainter` + `PaintingPatternPainter`）包进一个 `RepaintBoundary`，把动态 `PaintingMotif` 单独包进另一个 `RepaintBoundary`；
  - `HomeButterflyMark` / `ButterflyAvatar` 等动画改用 `FadeTransition`（直接驱动渲染层透明度，无 `SaveLayer` 重分配）或把透明度直接画进 `CustomPainter` 画笔颜色里，并给自身动画加上独立的 `RepaintBoundary`。

### 问题 3｜`AgentScope` 粗粒度全局广播，流式输出引发大面积树重 Rebuild
- **实查代码坐标**：
  - [`app/lib/ui/agent_scope.dart#L7-L20`](../../../app/lib/ui/agent_scope.dart#L7-L20)：`AgentScope extends InheritedNotifier<AgentController>`；
  - `HomePage`、[`sidebar.dart`](../../../app/lib/ui/sidebar.dart)、[`chat_view.dart`](../../../app/lib/ui/chat_view.dart)、详情面板、空状态组件等多处高层 Widget 直接调用 `AgentScope.of(context)` 订阅了**整只巨型 `AgentController`**（[`docs/architecture/architecture.md`](../../architecture/architecture.md) 此前也已标记 `AgentController` 过重问题）。
- **卡顿机理**：模型每流式输出一个 delta chunk、工具跑完一次状态刷新、或后台账本/运行态轮询触发一次 `AgentController.notifyListeners()`，**所有依赖 `AgentScope.of(context)` 的高层视图都会整块触发 `build()`**（包括此刻并不在变动的侧栏条目、外框布局、顶部栏、消息历史旧条目）。
- **建议解法**：
  - 先不动外部业务接口，在 `AgentController` 上把高频变化状态（如正在流式的最后一条消息正文、`running` 脉冲状态、局部未读数）拆成独立的精细 `ValueNotifier` / `ValueListenable`，或用局部 `AnimatedBuilder` / `ListenableBuilder` 只包住**真正需要动的最小叶子 Widget**；
  - 静态读取控制器只调用方法的回调处（例如 `onPressed`），改用非订阅式读取（不建立 `InheritedWidget` 依赖），彻底切断不必要的重建链。

### 问题 4｜`HomePage` `IndexedStack` 全页保活与未来模块扩展机制
- **实查代码坐标**：
  - [`app/lib/ui/home_page.dart#L121-L134`](../../../app/lib/ui/home_page.dart#L121-L134)：`IndexedStack` 依据 `AppSection`（[`app/lib/state/agent_controller.dart#L99`](../../../app/lib/state/agent_controller.dart#L99) 含 `chat, butterfly, tasks, memory, library, spending, settings, schedules`）常驻构建子页面，其中 `131–134` 行因后来 `memory`/`library`/`spending`/`settings` 改成了悬浮 Overlay（`146–149` 行），还留着 4 个占位的 `const SizedBox()`。
- **分析与建议**：
  - 随着 2.0 在左侧栏引入「番茄钟」「SuperAgent」等可动态增删的新模块，**绝对不能继续把所有模块放进一个全量保活的 `IndexedStack`**（否则装了 10 个模块，启动时就把 10 个页面甚至多个 `WebView2` 全实例化出来了，内存与帧率直接雪崩）；
  - 应当保留主聊天等高频根页的快速切回体验（同时清理 `131–134` 历史空槽映射），把模块面板改为**按需懒挂载 + LRU 轻量缓存**（不用或长期切走的 `WebSurface` 可暂停或释放，仅保留后端 Cordis 模块状态与轻量草稿），保持前端即使接入十几个模块也依然轻快。

### 推荐的无风险性能调优节奏（可先于 2.0 单独验证）
- 跑 `flutter run --profile` 配合 DevTools **Performance / Raster Stats / Rebuild Counts**，先抓一份基线数据（`POC-4`）；
- 第一步只改「问题 1（`PaperGrain` 去 `Opacity` + 加 `RepaintBoundary`）」和「问题 2（`PaintingBackdrop` 静动隔离）」，这两项**完全不改交互逻辑也不动业务状态**，视觉像素几乎一致但往往能立竿见影降掉最明显的一半光栅化耗时；
- 第二步再拆 `AgentScope` 高频流式通知粒度，配合 Markdown 块级渲染缓存，解决打字输出时的卡顿。
