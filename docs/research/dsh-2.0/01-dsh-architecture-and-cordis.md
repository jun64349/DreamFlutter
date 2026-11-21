# 01｜DeepSeek Harness（DSH）与 Cordis 底层架构深度拆解

> **证据边界说明**：本文对 DSH 的拆解来自两类一等信源：(1) 仓库本地已记录的源码调研基线 [`docs/research/deepseek-harness.md`](../deepseek-harness.md)（对应提交 `ce7073d`）与当前 `core/` 代码实现；(2) `deepseek-ai/deepseek-harness` 公开仓库与 PKU / DeepSeek-AI 合著论文《*Cordis: A Programming Paradigm for Spatiotemporal Composability*》及后续公开提交信息。标注「待 POC-1 复核」的细节，将在 2.0 工程启动拉取最新上游源码时再逐行核对。

---

## 一、底层哲学：为什么 DSH 能做到「全插件化」？

传统桌面端或 Agent 框架通常是「**一个强内核 + 几个扩展点（Hooks）**」。DreamFlutter 目前的 [`core/src/core.ts`](../../../core/src/core.ts) 就是典型例子：内核在构造函数和 `buildCore` 中直接装配底层宿主与 30 余个模块，外部再通过 `CoreModule` 接口挂钩子。这种结构在功能稳定时很快，但当系统需要演进成「可自由组合的模块化平台」时，会遇到两个天花板：
1. **生命周期泄漏**：模块注册了定时器、文件监听、工具、路由，一旦想在运行中卸载、升级或切换模式，内核不知道哪些资源属于哪个模块，只能全进程重启。
2. **耦合隐性化**：内核持有一切特权对象（Session、Gateway、Store），模块之间互相直接拿实例调用，形成网状依赖，无法拆成可独立发布或按作用域隔离的包。

DeepSeek Harness 的根本解法是把整个应用建立在 **Cordis 元框架（Meta-framework）** 之上，奉行两条核心原则：
- **没有特权内核（No Privileged Core）**：Agent 主循环、Session 存储、LLM 接入、Shell 执行、Sandbox、目标调度、Web API 甚至插件管理器自己，全都是 Cordis 插件。
- **能力与实现分离**：插件不依赖「具体某个类」，而是声明「我需要什么服务契约（`inject`）」，运行期由作用域内实际激活的 Provider 动态满足。

---

## 二、Cordis 运行时机理：时空可组合性（Spatiotemporal Composability）

Cordis 把软件插件化拆成「时间」与「空间」两个正交维度来管理。

### 2.1 时间可组合性：自动副作用追踪（`ctx.effect` / LIFO 回收）
在普通 TypeScript 程序里，初始化逻辑和清理逻辑是分离的（写了 `onMount` 经常忘写或写漏 `onUnmount`）。Cordis 的每个插件启动时会拿到专属的上下文代理 `ctx`，所有向外世界做的登记都挂在 `ctx` 的作用域上：
- **`ctx.on(event, handler)`**：登记事件或瀑布流钩子；
- **`ctx.effect(fn)`**：登记带返回清理函数（disposer）的副作用（如连接、定时器、工具注册、文件句柄、工作区目录锁）；
- **`ctx.provide(name, service)`**：向当前及子作用域提供服务。

**核心机制**：Cordis 内部把插件每次注册的清理器压入该插件专属的栈中。当插件被停用、卸载、热重载（HMR）或父级作用域销毁时，Cordis 自动按 **LIFO（后进先出）** 顺序反向执行所有 disposer。这意味着：
- 只要插件代码遵循通过 `ctx.*` 注册资源，**热插拔、动态切换「模块」时不会残留僵尸工具、失效监听器或泄漏的连接**；
- 一旦某个插件启动中途抛错，已经登记的那一半副作用也会被自动回滚干净，不会把运行时拖进半残状态。

### 2.2 空间可组合性：声明式协同效应（`inject`）与 6 态 Fiber 状态机
插件之间的依赖关系在 Cordis 里不靠「手动排序启动脚本」解决，而是由每个插件显式声明 `inject = [...]`（支持必选依赖与可选依赖）：

```text
  PENDING ──▶ LOADING ──▶ ACTIVE ──▶ UNLOADING ──▶ DISPOSED
                 │           │
                 ▼           │ (依赖服务下线 / 宿主销毁)
               FAILED ◀──────┴────────────────────▶ (自动级联 UNLOADING -> DISPOSED)
```

- **Fiber 状态机流转**：
  1. 当新插件进入或通过 `cordis.patch.yml` / 插件管理器调整配置时，Fiber 先处于 `PENDING`，等待 `inject` 列表里的所有必需服务全部就绪；
  2. 条件满足后进入 `LOADING`，执行插件的 `apply(ctx, config)`（或类构造）；
  3. 成功完成且副作用挂载完毕进入 `ACTIVE`；若期间出错进入 `FAILED` 并自动回收本次局部副作用，**避免单个坏插件拖垮主程序**；
  4. 当上游某个 Provider 插件（例如 `sandbox` 提供者从本地切换成隔离容器，或者用户禁用了某个模块）进入 `UNLOADING` 时，所有强依赖它的下游 Fiber 会自动级联先卸载，等新 Provider 就绪后再自动重建挂载，最终不用的节点进入 `DISPOSED`。

### 2.3 三元能力缝（Three-Role Capability Seam）
这是 DSH 插件生态可以低成本互相替换、又能适应不同 OS/前端的关键结构。每一类系统能力都严格分成三方：
1. **Service Definition（服务契约包）**：只定义 TypeScript 接口、能力标识与错误类型，没有任何具体平台代码（例如定义 `llm`、`shell`、`sandbox`、`goal` 的抽象接口）。
2. **Service Provider（能力提供者）**：实现契约并调用 `ctx.provide(...)` 暴露给作用域。例如 `sandbox` 契约在 Linux 上由气泡/命名空间提供者满足，在 Windows 上可切换为本地 ACL 或 DreamFlutter 的 `AppContainer` 提供者，上层工具无感知。
3. **Consumer（能力消费者）**：具体的工具包、Agent 模块或业务功能，通过 `inject: ['sandbox', 'llm']` 消费契约，完全不耦合底层是哪种沙箱或哪家模型网关。

### 2.4 作用域树（Context Tree / Fork / Isolate）
Cordis 的 `Context` 可以不断派生子作用域（`ctx.fork(...)` 或隔离分支）：
- 放在**根上下文**的服务（如模型网关、账本 `Ledger`、全局记忆 `Memory`），所有子上下文都能看见、复用同一实例；
- 放在某个**子上下文**里的服务、工具或提示词片段，只在那个分支内部生效，**兄弟上下文之间彼此不可见**。
这一特性正是 DreamFlutter 2.0 想实现「多个右侧独立模块共享同一底层 Runtime 与记忆、但工具集和提示词互相隔离」的技术基石（详见 [02-plugin-composability-and-modules.md](02-plugin-composability-and-modules.md)）。

---

## 三、DSH 代码结构与核心运行链路拆解

### 3.1 `packages/` 分层全景
结合 `ce7073d` 本地基线（[`deepseek-harness.md`](../deepseek-harness.md)）与公开仓库包划分，DSH 将系统按职责拆成以下几大包族（具体目录名随版本略有微调，待 POC-1 复核）：

| 层级 | 代表包 / 模块族 | 核心职责 | 对 DreamFlutter 2.0 的意义 |
| :--- | :--- | :--- | :--- |
| **Core 内核层** | `core/`（`agent-loop`、`system-prompt`、Session Log 等） | 无状态推演、Append-Only 会话日志、Turn/Step 驱动、提示词装配、上下文裁剪 | **核心替换目标**：直接替代 `core/src/pi/host.ts` 的 `Pi 1.4.0` 宿主 |
| **Model & LLM 层** | `llm/` | 原生 Messages API、原生 Thinking Block 透传回放、模型能力抽象 | 需做适配：对接 DreamFlutter 现有多模型组 / Responses / `Ledger` |
| **API 与宿主通信层** | `api/`、`typert/`、`host/` | BFF 聚合接口、Typert 强类型 RPC、与本地进程宿主通信 | 可外挂 DreamFlutter WS RPC 兼容桥，保住现有 15 域前端协议 |
| **执行与环境层** | `shell/`、`terminal/`、`sandbox/`（如 `dsh-sandbox-local`、`dsh-sandbox-windows-acl`） | 命令行与终端会话管理、平台级隔离后端 | **关键扩展点**：通过实现 DSH `sandbox` Provider 嵌入蝶君新隔离 |
| **长程与自动化层** | `goal/`、`schedule/` | 目标管理、定时与事件触发 | 与 DreamFlutter 已有 `GoalScheduler` / `AutonomyModule` / `PatrolModule` 对齐 |
| **插件装配与启停层** | `boot/plugin-manager/`、`bundle/`（`web-app`、`sdk-minimal`） | `dsh.bundle` 清单解析、`cordis.patch.yml` 分层覆盖、动态市场安装/热重载 | 支撑按模块打包、纯能力插件先接入、独立模块按需加载 |
| **Web 客户端层** | `client/`（`web`、`ui-slots`、`ui-renderer`、`ui-sidebar`、`ui-sidebar-right`、`ui-plugin-manager`、`resources`） | React 前端、插槽渲染、侧栏/右侧栏容器、`dsh-resource://` 资源协议 | **不直接替代 Flutter**，其中 `resources` 与局部 Web UI 协议可借由 `WebView2` 复用 |

### 3.2 Agent 主循环（`ReactLoopAgent`）与 Turn / Step 层次
DSH 把一次 Agent 运行严格建模成三层状态与两级循环，清晰度远高于目前压在 `Pi AgentSession` 之上的补丁式封装：
- **Agent 三态**：`idle | maintenance | running`（`maintenance` 态专门留给压缩、记忆归纳、恢复检查等后台维护工作，避免和用户新消息打架）。
- **Turn → Step 层级**：一次用户输入或自治唤醒开启一个 Turn；Turn 内部按「模型推理 → 工具执行 → 观察追加」推进多个 Step。
- **瀑布流扩展点（Waterfalls）**：
  - `agent/pre-step`：每步推演前执行，可用于动态注入实时工作区状态、待办确认、预算余量等动态前缀外内容；
  - `agent/request`：真实发出 LLM 请求前的最后拦截点（模型路由、限流、预算预占）；
  - `agent/request-error`：区分可恢复网络抖动与不可恢复错误，配合退避策略；
  - `agent/turn-stopping`：Turn 即将停止前的收尾判据（检查是否有未完成校验、自动进入下轮巡检或提交最终状态）。

### 3.3 Append-Only Session Log 单一事实源（SSOT）
在现有 DreamFlutter 里，虽然对话归后端管理，但 [`docs/architecture/architecture.md`](../../architecture/architecture.md) 仍指出历史窗口和后端在 session JSONL 与 Pi 压缩条目之间有耦合（`host.ts` 还需要额外维护 `manualCompactions` 等补丁状态）。

DSH 采用 **Append-Only Session Log 作为唯一事实源**：
- 任何事件（用户输入、Thinking、Tool Call、Tool Result、Prune 标记、Compaction 摘要、人工介入决定）都只做追加写入，不原地破坏历史；
- 每次发给模型之前，由纯函数 `deriveMessages()` 从完整日志派生出当前要送入上下文窗口的消息序列；
- 压缩（Compaction）与工具输出裁剪（Pruner）都在日志上追加一条「替代/折叠记录」，而非粗暴抹除原始轨迹。这样做有两大可靠性红利：**事后全量审计极清楚（FRACAS 排障友好）**、**分支回溯与 SuperAgent 的 `Chain of Recall` 引用检索有了扎实原材料**。

### 3.4 工具 3 阶段管道、并发控制与输出裁剪
- **Guarded 3-Stage Tool Pipeline**：
  1. `tools/pre-execute`：权限检查、路径合规判断、高危确认拦截、输入审计；
  2. `tools/execute`：在指定能力提供者（本地或沙箱）中执行；
  3. `tools/post-execute`：结果脱敏（DPAPI/密钥掩码）、结构化提取、统计耗时与审计落盘。
- **并发与互斥**：默认提供 **10 并发受限池（Bounded Pool）** 执行彼此独立的只读工具（大幅缩短代码检索与批量文件读取耗时），同时提供 **Exclusive Barrier（独占屏障）**：遇到会改写状态或需要用户审批的工具时，自动收敛成串行独占执行，避免竞态破坏文件。
- **Persistent Pruner**：超过窗口或安全阈值的历史大块工具输出会被持久性替换成轻量引用标记（带行号/路径索引），需要时再精准复读，既省 Token 又不丢失坐标。

### 3.5 System Prompt 稳态与缓存命中保护
与很多框架「每轮动态拼接系统提示词导致 Prefix Cache 全部失效」不同，DSH 把 System Prompt 的组织按 **变更频率** 做了分层：
- 静态核心指令、核心规则与工具 Schema 置于前缀最前端并保持字节级稳定，保住模型的 Prompt Caching 命中率；
- 易变的运行时信息（当前时间、工作目录变动、刚触发的记忆或状态摘要）被严格限制到稳定前缀之后的边界位置（如 `pre-step` 尾部或用户侧上下文条目），不污染前缀哈希。
- 这对 DreamFlutter 尤为重要：我们在 [02-plugin-composability-and-modules.md](02-plugin-composability-and-modules.md) 会看到，SuperAgent 与多轮长任务极度依赖高缓存命中来控制成本。

### 3.6 `dsh.bundle`、`cordis.patch.yml` 与配置合并规则
- **Bundle 清单（`dsh.bundle`）**：把一组强相关的插件、默认参数与预设打包成具名 `profile`（例如官方提供的 `web-app`、`sdk-minimal`），一个桌面产品本质上就是按自己定位装配出来的 `profile`。
- **增量配置补丁（`cordis.patch.yml` 与 CLI `--patch`）**：允许层叠多份 YAML patch 开关特定插件、切换 Provider 或微调参数，并可在开发期触发 HMR 热更新。
- **必须提前注意的工程坑**：根据调研记录，DSH 的 `cordis.patch.yml` 在配置覆盖上偏 **整块映射覆盖（full-map override）而非深度递归合并（deep merge）**——写错一个局部节点可能把默认配置同级字段整片顶掉，后续写接入适配器或预设生成器时必须用 Schema 校验兜底。

---

## 四、DSH 与 DreamFlutter 当前底座逐项对比

DreamFlutter 1.0 目前在 [`core/src/pi/host.ts`](../../../core/src/pi/host.ts) 与 [`core/src/core.ts`](../../../core/src/core.ts) 上的架构现状，与 DSH 之间呈现出「思想高度一致、但运行时能力已被 Pi 1.4.0 锁住」的特征：

| 维度 | DreamFlutter 1.0 现状（`Pi 1.4.0` + `core/`） | 官方 DSH + Cordis 底座 | 2.0 迁移评价 |
| :--- | :--- | :--- | :--- |
| **扩展骨架** | `CoreModule` 接口（[`core/src/core.ts#L125-L143`](../../../core/src/core.ts#L125-L143)），支持 `extensions` / `toolPolicy` / `onSlotEvent` 等回调，但无自动卸载与依赖图 | Cordis 时空插件容器：`inject` 依赖声明 + `ctx.effect` LIFO 自动卸载 + 6 态 Fiber | **显著升级**：直接解锁热插拔、多模块隔离与生态兼容 |
| **宿主绑定问题** | [`core/src/pi/host.ts#L222-L233`](../../../core/src/pi/host.ts#L222-L233) 被迫直接覆写 `settingsManager.getCompactionSettings`（内含 `dshCompactionSettings`）、`getRetrySettings`、`getHttpIdleTimeoutMs` 来绕开 Pi 限制 | `agent-loop`、`compaction`、`retry`、`pruner` 全部是开放的官方 Cordis 插件与标准钩子 | **去掉脆弱猴补丁**，以后跟进上游维护成本大幅下降 |
| **会话事实源** | Pi `AgentSession` + JSONL 历史文件（窗口端尚存少量直接读写/删除文件的历史债） | 纯 Append-Only Session Log SSOT + 纯函数 `deriveMessages()` | **彻底收口前端读文件债**，利于可靠性回溯 |
| **Tool 执行链** | 通过 `extensions()` 挂载 Pi 扩展及 `toolPolicy` 串联确认与策略 | 原生 `tools/pre-execute -> execute -> post-execute` 管道 + 10 并发池 + 独占屏障 | 与现有 [`security.md`](../../architecture/security.md) 策略天然对齐，只需平滑改写挂点 |
| **LLM 接入与账本** | 优势项：自研 `Gateway`、多模型组路由、GPT Pro / Responses API 支持、`Ledger` 硬预算控制（[`core/src/modules/llm.ts`](../../../core/src/modules/llm.ts)） | 官方更偏向直接 Messages API 与单 Provider 配置假设，多租户/多模型组/强人民币或额度账本较薄 | **DreamFlutter 反补 DSH**：保留我方网关与账本实现为 DSH `ctx.llm` Provider |
| **长任务、记忆与安全** | 优势项：`GoalScheduler` 租约、`3 层验收`、独立无工具 `MemoryAgent`、DPAPI 脱敏、`Attention` 统一收件箱 | 提供基础 `goal`/`schedule`，缺乏 DreamFlutter 这套中文桌面工作流打磨的三层记忆与人类拍板收件箱 | **平移复用核心资产**：封装为独立 Cordis 插件包迁移，不重写业务规则 |
| **Node.js 运行时** | `core/package.json` 当前声明 `>=22.19.0` | 官方 DSH 要求 Node `>=24.9`（见 [`deepseek-harness.md#L547`](../deepseek-harness.md#L547)） | **需同步升级打包内置的 Node 二进制**并复测体积与冷启动 |
| **UI 体系** | Flutter Desktop（水墨纸感、12 套名作主题、[`settled-behaviors.md`](../../design/settled-behaviors.md)）+ 已内嵌 `WebView2` | React Web 客户端（`ui-slots` / `ui-sidebar` / `ui-renderer`） | **前端 UI 保持 Flutter 为主**，仅借助 `WebView2` 兼容第三方带界面插件 |

---

## 五、本节调研小结论

1. DreamFlutter 自己已经摸到了 Harness 工程化的半个门（`CoreModule` 缝、`dshCompactionSettings` 等实现都在向同一方向靠拢），**直接切到官方 DSH + Cordis 不是从零推翻，而是把「手工模拟的宿主层」换成「经过体系化设计的标准宿主层」**。
2. DSH 原生在「插件热生命周期、Session Log 单一事实源、Prompt 缓存稳态、受控工具并发池」上比 Pi 1.4.0 领先一整代；而 DreamFlutter 在「多模型组路由、硬预算 Ledger、三层独立提炼记忆、统一待办审批箱与 Win32 安全解析」上比官方默认 `web-app` 更厚实——**两者结合后既能省掉底层造轮子成本，又能保留并凸显产品自身的差异化护城河**。
