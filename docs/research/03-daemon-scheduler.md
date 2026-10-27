# Windows 桌面个人 AI Agent 独立后台与任务调度系统调研报告

> **调研背景**：针对 Flutter 界面与 Node/TypeScript 常驻后台分离的 Windows 单机个人 AI Agent 架构，管理多个 Pi coding agent 进程。实现界面关闭任务不中断、后台重启可恢复、交互操作持久化确认卡、完善的定时调度（cron/时区/补做/防并发）以及后台无人值守安全管控。

---

## 一、主流与前沿项目机制深度剖析

### 1. OpenClaw
* **定位**：面向个人的全功能 AI Gateway 守护进程与多渠道智能助理。
* **具体机制**：
  * **Gateway 守护进程**：支持作为系统常驻服务安装（Windows 下通过服务或启动项）。Gateway 作为核心控制平面与事件总线（Event Bus），统一管理会话状态、WebSocket 连接与定时器。
  * **Cron 调度引擎**：内置持久化任务管理，元数据存储于本地 JSON（如 `~/.openclaw/cron/jobs.json`）。支持两种执行模式：
    * *Main Session*：在主会话下一个心跳注入系统事件；
    * *Isolated Session*：为独立自动化任务单独派生全新隔离会话（`cron:<jobId>`），避免背景输出污染主交互上下文。
  * **Heartbeat（心跳机制）**：默认每 30 分钟唤醒主会话，检查工作区 `HEARTBEAT.md` 待办清单。
  * **交付模式（Delivery）**：支持 `announce`（任务完成后系统自动汇总推送到外部频道）、`none`（由 Agent 显式调用工具投递）和 `webhook`。
* **值得借鉴的细节**：
  * **静默确认机制（`HEARTBEAT_OK`）**：心跳唤醒时若 Agent 评估无须处理，返回特定 token，系统静默抑制消息，不打扰用户；
  * **主会话与隔离会话分离**：定时任务采用临时会话运行，完成后交付摘要，极大节省上下文。
* **权威链接**：[OpenClaw Docs](https://openclaw.ai) / [OpenClaw Playbook](https://openclawplaybook.ai)

---

### 2. Hermes Agent (`NousResearch/hermes-agent`)
* **定位**：Nous Research 针对开源基座模型研发的自主 Agent 运行时。
* **具体机制**：
  * **Gateway 调度**：Gateway 进程常驻后台，内置一个大约每 60 秒触发一次的 `tick()` 轮询线程。
  * **并发与文件锁**：采用本地文件锁机制（如 `~/.hermes/cron/.tick.lock`）确保调度循环单实例运行，避免多进程冲突。
  * **错过补做策略（Misfire）**：若 Gateway 停机，重启后**默认跳过（skip）**并记录停机期间错过的 tick，防止任务瞬间堆积引发雪崩，在下一个自然周期恢复触发。
  * **自然语言管理与模式**：支持自然语言或 CLI（`/cron create`）创建定时任务；区分纯脚本执行（`no_agent=true`）与 Agent 提示词推理执行。
* **值得借鉴的细节**：轻量级文件锁单实例保证；宕机后“跳过错过任务”的防雪崩策略。
* **权威链接**：[NousResearch/hermes-agent (GitHub)](https://github.com/NousResearch/hermes-agent)

---

### 3. Nanobot (`HKUDS/nanobot`)
* **定位**：香港大学开源的超轻量个人 AI Agent 框架。
* **具体机制**：
  * **`HEARTBEAT.md` 契约**：在用户工作区根目录下维护 `HEARTBEAT.md`。后台 Gateway 定时器以固定周期唤醒 Agent，将该 Markdown 文件作为上下文传入。
  * **LLM 语义决策**：通过虚拟工具调用让 LLM 评估文件中标记的任务是否需要立即执行，执行后自动更新/清空文件内的活动任务项。
* **值得借鉴的细节**：任务定义完全文件化、透明化，用户和 Agent 均可随时查看和修改 Markdown 文件，直观且便于版本跟踪。
* **权威链接**：[HKUDS/nanobot (GitHub)](https://github.com/HKUDS/nanobot)

---

### 4. OpenHands (原 OpenDevin)
* **定位**：开源全自主软件工程 Agent 系统。
* **具体机制**：
  * **服务分层解耦**：严格分离 **Automation Service**（负责触发、调度、GitHub Webhook 监听、任务历史元数据）与 **Agent Server**（负责沙箱隔离、代码编写、Shell 交互、LLM 推理循环）。
  * **调度与派发**：Automation Service 定时触发后，分配并唤醒一个沙箱运行环境，向 Agent Server 发送任务模板，任务完成后回调记录日志并关闭临时环境。
* **值得借鉴的细节**：“触发调度服务（When）”与“Agent 执行引擎（What）”彻底解耦，调度器不占用 Agent 执行进程资源。
* **权威链接**：[All-Hands-AI/OpenHands (GitHub)](https://github.com/All-Hands-AI/OpenHands)

---

### 5. LangGraph
* **定位**：多智能体有状态编排引擎。
* **具体机制**：
  * **持久化检查点（Checkpointing）**：提供 `SqliteSaver` / `PostgresSaver`。在每个 Super-step 结束后自动序列化图状态快照。
  * **原生中断（`interrupt()`）**：在节点内部调用 `interrupt(payload)`，图执行立即挂起并保存现场；调用端通过 `Command(resume=value)` 重新激活并传入审批输入。
  * **Durable Execution**：挂起期间进程随意退出或重启，只要恢复时提供相同的 `thread_id`，图引擎即可从最近检查点无缝继续。
* **值得借鉴的细节**：将人工审批（HITL）标准化为运行时原生异常挂起/注入机制，状态数据结构高度统一。
* **权威链接**：[LangGraph Checkpoints & HITL Docs](https://langchain-ai.github.io/langgraph/)

---

### 6. Mastra
* **定位**：TypeScript-first 的全栈 Agent 与 Workflow 框架。
* **具体机制**：
  * **强类型挂起与恢复**：Workflow 步骤中定义 `suspendSchema` 与 `resumeSchema`（基于 Zod 校验）。
  * **流式中断关闭（`closeOnSuspend`）**：在 `run.stream()` 时配置该参数，一旦挂起，WebSocket / SSE 数据流自动优雅关闭，将状态写入数据库；恢复时调用 `run.resumeStream({ resumeData })` 恢复流式推送。
* **值得借鉴的细节**：针对 TypeScript 体系设计了完备的审批输入/输出类型校验，以及流式传输与挂起无缝契合的生命周期管理。
* **权威链接**：[Mastra Workflows & HITL Docs](https://mastra.ai)

---

### 7. Agno (原 Phidata)
* **定位**：轻量级 Agent 运行时与 AgentOS 底座。
* **具体机制**：
  * **持久化队列（Durable Queue）**：`AgentOS` 引入数据库驱动的有状态队列（如 `agno_jobs` 表）。
  * **租约（Lease）与崩溃认领**：后台任务接收后立即入库，工作线程通过租约机制抢占任务。若运行节点崩溃导致租约超时，其他健康进程可重新认领任务。
  * **幂等控制**：支持基于 `idempotency_key` 的去重排队与并发槽位限制（`max_concurrency`）。
* **值得借鉴的细节**：数据库即队列（DB-as-Queue）结合超时租约，非常适合单机 SQLite 的任务恢复与防崩溃。
* **权威链接**：[Agno Documentation](https://agno.com)

---

### 8. CrewAI Flows
* **定位**：事件驱动的结构化多智能体编排层。
* **具体机制**：
  * **`@persist` 装饰器**：开箱即用支持 SQLite 持久化，Flow 中每个监听方法执行完毕后自动持久化当前 Pydantic State。
  * **状态恢复与分支（Fork）**：支持 `kickoff(restore_from_state_id=...)` 从指定快照恢复或派生执行。
* **值得借鉴的细节**：状态快照粒度控制在“高层方法/步骤（Flow）”级别，而非底层的每次小 LLM token 交互，降低 I/O 开销。
* **权威链接**：[CrewAI Flows Persistence](https://docs.crewai.com)

---

### 9. Temporal / Inngest / Trigger.dev
* **定位**：现代持久化执行（Durable Execution）三大代表。
* **具体机制**：
  * **Temporal（重放模型）**：依赖严格确定性工作流代码与完整事件历史（Event Sourcing）。故障时重跑函数，跳过已完成 Activity。对于 AI 这种高度随机场景稍显厚重。
  * **Inngest（步骤记忆化 Step Memoization）**：采用 `step.run()`、`step.sleep()`、`step.waitForEvent()`。每一步完成后将其返回值序列化缓存，崩溃恢复时直接读缓存跳至下一未完成 step。
  * **Trigger.dev（TypeScript 原生无超时计算）**：专为长期运行的 Agent 任务优化，支持超长运行、检查点断点续传、原生流式输出与 HITL 实时等待。
* **值得借鉴的细节**：**步骤记忆化（Step Memoization）**模式——在 Node.js 后台中，将 Agent 的“LLM 推理 -> 工具执行 -> 用户审批”包装为离散 Step 并缓存结果，崩溃后跳过昂贵且不可逆的工具调用。
* **权威链接**：[Temporal Docs](https://temporal.io) / [Inngest AI Agents](https://inngest.com) / [Trigger.dev Realtime](https://trigger.dev)

---

### 10. Claude Code
* **定位**：Anthropic 针对本地软件开发的 Agent CLI 客户端。
* **具体机制**：
  * **后台任务管理**：耗时的终端命令或子 Agent 调用可一键推入后台（`Ctrl+B` 或根据超时自动切入）。任务分配独立 Task ID，输出持续重定向至临时文件，前台可通过 `/tasks` 随时查阅与收拢结果。
  * **Hooks 生命周期拦截**：支持 `PreToolUse`、`PostToolUse`、`SessionStart` 等事件钩子，支持异步非阻塞配置（`"async": true`）。
  * **调度循环**：会话内支持短轮询循环（`/loop`），外部可对接定时任务触发。
* **值得借鉴的细节**：长命令自动转后台运行、输出管道落地到文件、通过任务池异步轮询/通知。
* **权威链接**：[Claude Code Documentation](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code)

---

### 11. OpenAI Codex (Cloud Tasks) & ChatGPT Tasks
* **定位**：OpenAI 官方的异步代码任务与个人定时任务体系。
* **具体机制**：
  * **Codex Cloud**：将多步长耗时工程任务交由云端容器异步运行，本地关闭或休眠无影响，完成后通过 Git 分支或 PR 交付产物。
  * **ChatGPT Tasks**：支持自然语言直接设定日程（“工作日早 8 点抓取...”），侧边栏设有专用 Tasks 调度中心，统一提供暂停、编辑、运行记录查阅功能。
  * **无变化不打扰（Delta Notification）**：定时监控类任务若评估结果与上次相同，静默保存记录但不推送高优先级通知。
* **值得借鉴的细节**：直观的 UI 调度管理面板；增量变更通知过滤机制。
* **权威链接**：[OpenAI Platform Guides](https://platform.openai.com)

---

### 12. Manus
* **定位**：通用全自主异步执行 Agent。
* **具体机制**：
  * **异步沙箱持久化**：用户提交目标后可完全断开前台连接。任务在云端隔离容器中通过多步代码解释器（CodeAct）自循环推进。
  * **关键节点挂起与交付**：遇到敏感动作（登录校验、高额操作）触发中断卡；任务完成通过 Webhook/消息推送触达离线用户。
* **值得借鉴的细节**：前端完全为纯展示层，执行上下文与浏览器生命周期彻底脱钩。
* **权威链接**：[Manus](https://manus.im)（注：内部核心代码闭源，架构机制基于其官方公开演示与网络通信行为核实）

---

### 13. Cursor Background Agents
* **定位**：IDE 内的异步分支化编程 Agent。
* **具体机制**：
  * **隔离分支独立执行**：后台 Agent 独立在独立 Git 分支上运行测试与改动，不锁死当前编辑区。
  * **Headless 命令行模式**：支持 `cursor-agent -p`（输出结构化 JSON）与 `--force`（自动化无确认执行），便于系统服务或脚本调用。
* **值得借鉴的细节**：后台修改先在临时环境或隔离分支进行，待确认后再合并入工作主线。
* **权威链接**：[Cursor Features](https://cursor.com)

---

### 14. Goose (`block/goose`)
* **定位**：Block 开源的可扩展本地工程 Agent。
* **具体机制**：
  * **内置调度器**：核心库内置 `scheduler.rs`，支持无头执行（`goose run`）预设自动化配方（Recipes）。
  * **工作流引擎适配**：官方支持将复杂长周期配方交由 Temporal 工作流进行持久化调度与故障重试。
* **值得借鉴的细节**：将自动化任务沉淀为“配方（Recipes）”模版，定时任务仅需引用配方 ID 与特定参数。
* **权威链接**：[block/goose (GitHub)](https://github.com/block/goose)

---

### 15. n8n
* **定位**：可自托管的工作流自动化平台（深度集成 AI Agent 节点）。
* **具体机制**：
  * **工具级人工审批（Tool-Level HITL）**：在 AI Agent 节点中可单独勾选某个高危工具（如删除、支付、发送公函）开启“Human Review”，LLM 生成参数后流程自动暂停并生成待审批卡片。
  * **Wait 节点挂起**：支持等待 Webhook 回调或超时时间（如 24 小时），超时未处理走降级分支。
* **值得借鉴的细节**：**工具维度的细粒度审批开关**；被人类拒绝时将拒绝原因注入上下文让 Agent 自行重规划。
* **权威链接**：[n8n AI Agent Human in the loop](https://docs.n8n.io)

---

## 二、横向功能点对比与评估汇总表

| 核心功能点 | 涉及参考项目 | 业务价值 | 实现复杂度 | 针对 Windows 单机 Agent 的推荐做法 |
| :--- | :--- | :---: | :---: | :--- |
| **独立常驻守护进程** | OpenClaw, OpenHands, Manus | **高** | 中 | Node.js 独立进程，结合本地 Named Pipe/WebSocket 与 Flutter 通信，Windows 登录自启 |
| **步骤级持久化 (Step Memoization)** | Inngest, LangGraph, Mastra | **高** | 中 | 采用 SQLite WAL 模式，在每一步（LLM 规划、工具执行前后）落盘，重启跳过已完成步骤 |
| **崩溃恢复与孤儿进程清理** | Agno, Temporal, Claude Code | **高** | 高 | 记录子进程 PID，后台启动时扫描进程树；死任务标记为 `interrupted`，提示用户恢复/重试 |
| **持久化确认卡 (HITL)** | Mastra, LangGraph, n8n | **高** | 中 | 区分“操作审批”与“表单输入”，写入 `pending_confirmations` 表；UI 启动时主动拉取对齐 |
| **离线通知渠道降级** | OpenClaw, n8n, ChatGPT | **中** | 低 | 窗口关闭时调用 Windows 原生系统 Toast（WinRT）；若配置了 IM Webhook 则同步推送到手机端 |
| **多功能定时调度引擎** | OpenClaw, Hermes, n8n | **高** | 中 | 采用 `croner`（完整支持 IANA 时区与夏令时）；支持一次性、固定间隔与 cron 表达式 |
| **错过补做策略 (Misfire Policy)** | Hermes, OpenClaw | **中** | 低 | 提供 `skip`（默认跳过）与 `catch_up_once`（补偿一次）；绝对禁止无上限堆叠补做 |
| **同一计划并发互斥** | Hermes (锁), Agno | **高** | 低 | 任务触发时检查当前执行状态，已在运行直接跳过（`skip_if_running`），记录一条跳过日志 |
| **增量静默与通知去重** | OpenClaw (`HEARTBEAT_OK`), ChatGPT | **中** | 低 | Agent 工具输出可标记 `no_changes`；后台识别后仅写入历史记录，抑制桌面弹窗骚扰 |
| **Agent 自管理定时任务工具** | Hermes, Claude Code | **中** | 中 | 提供 `schedule_task` 工具，但限定最小执行频率（≥5分钟），创建周期写任务必须经过人工确认 |
| **无人值守安全与预算熔断** | OpenHands, Claude Code, n8n | **高** | 低 | 设置单次任务最大轮数（`max_turns`，如 20）与每日 Token 预算上限；高危 Shell 离线禁行 |

---

## 三、Windows 单机个人 Agent 后台推荐落地架构

针对 **Flutter 桌面界面** 与 **Node/TypeScript 独立后台守护进程** 的分离架构，以下为具体实现方案：

```
+-------------------------------------------------------------------------------+
|                             Flutter Desktop UI                                |
|  [会话抽屉]      [交互卡片流 (实时/审批)]      [调度面板 (Cron/历史)]  [系统托盘 Tray]  |
+-------------------------------------------------------------------------------+
          │                                                  ▲
          │ 1. 鉴权握手 (Bearer Token from Local File)       │ 4. 实时事件流
          ▼                                                  │    (流式Token/卡片/状态)
+────────────────────────────────────────────────────────────┴──────────────────+
|                    Node/TypeScript Daemon Core (单实例)                       |
|                                                                               |
|  ┌──────────────┐     ┌────────────────┐     ┌──────────────┐     ┌─────────┐ |
|  | 通信与分发层  |     | 任务执行调度器  |     | HITL 审批中心 |     | 进程守护 | |
|  | HTTP/WS/Pipe |     | croner 引擎    |     | 挂起/恢复/TTL |     | 子进程树| |
|  └──────┬───────┘     └───────┬────────┘     └──────┬───────┘     └────┬────┘ |
|         │                     │                     │                  │      |
|         ▼                     ▼                     ▼                  ▼      |
|  ┌──────────────────────────────────────────────────────────────────────────┐ |
|  |                 better-sqlite3 本地持久化层 (WAL Mode)                   | |
|  |  sessions  |  steps  |  pending_confirmations  |  scheduled_jobs  | logs | |
|  └──────────────────────────────────────────────────────────────────────────┘ |
+───────────────────────────────────────────────────────────────────────────────+
          │                                                  │
          ▼ 派生子进程                                       ▼ 离线触达
+───────────────────────────────────+              +────────────────────────────+
|   Pi Coding Agent Processes       |              |  系统与外部通知            |
|   (CLI / bash / python / git)     |              |  - Windows Toast (WinRT)   |
|   stdout/stderr 重定向至日志文件   |              |  - Telegram/飞书/企业微信  |
+───────────────────────────────────+              +────────────────────────────+
```

### 1. 守护进程形态与 Windows 原生集成
* **运行与启动形态**：
  * 后台编写为独立 Node.js 程序，通过 `@yao-pkg/pkg` 打包为独立可执行文件 `agent-daemon.exe`。
  * **启动方案**：用户安装时通过注册表写入 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 或创建快捷方式放入 `shell:startup` 实现登录自启；Flutter 启动时首先检测后台心跳，若未拉起则由 Flutter 负责冷启动后台。
  * **托盘托管**：Flutter 窗口关闭时默认最小化到托盘（`tray_manager`）；完全退出由用户在托盘右键选择“完全关闭”（退出时可选择仅关界面或同时停止后台）。
* **单实例保证**：
  * 使用本地固定端口结合排他锁，或在用户主目录建立 `.agent/daemon.lock`。
  * 采用 `windows-mutex` 原生模块或尝试以独占写入模式锁定文件；若已存在锁文件且对应 PID 存活，新启动进程立即退出。
* **通信协议与鉴权**：
  * **协议**：采用 **本地 WebSocket**（端口如 `127.0.0.1:41234`）处理双向流式通信，辅以少量 REST HTTP 接口处理文件传输。
  * **鉴权**：守护进程首次启动时生成 64 位高熵随机密钥，存入 `%APPDATA%\MyAgent\auth.token`，并设置 NTFS 文件 ACL 仅限当前系统用户访问。Flutter UI 启动时读取该文件，在 WebSocket 握手或 HTTP Header 中携带 `Authorization: Bearer <token>`。
  * **多客户端连接**：支持多个客户端（如主窗口、浮窗、CLI）同时连入，后台内部作为 Event Bus 将 Session 事件向所有鉴权连接广播。

### 2. 状态持久化与崩溃恢复状态机
* **持久化数据库选型**：使用 `better-sqlite3`，配置 `PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`，保证高并发读写性能。
* **数据存储范式（精简模型）**：
  * `sessions`：记录会话状态（`idle`, `running`, `paused`, `waiting_approval`, `interrupted`）；
  * `steps`：存储执行步骤序列、输入、工具名称、参数、工具执行结果、状态与对应子进程 PID；
  * `pending_confirmations`：存储待确认操作卡片；
  * `scheduled_jobs` 与 `job_executions`：存储计划与执行追踪。
* **重启恢复与孤儿进程处理机制**：
  1. **启动自检**：后台重启时，查询表中状态为 `running` 的 Session；
  2. **进程检查**：利用 Windows 命令 `tasklist /FI "PID eq <pid>"` 探测未完成步骤记录的子进程 PID。若已不存在，说明系统重启或异常崩溃导致子进程终止；
  3. **状态标记**：将未决会话置为 `interrupted`，绝不盲目重新调用未完成的 Shell 或 Git 工具；
  4. **前端提示**：Flutter 重新连接后，界面弹出“未完成任务恢复卡”：*“任务在执行 [步骤 3: 运行测试] 时意外中断，是否从断点重试或放弃当前任务？”*，由用户主动决策。

### 3. 人工确认卡（HITL）全生命周期
* **类型区分**：
  * **审批确认（Approval）**：布尔值选择（批准/拒绝）+ 可选参数微调（如调整建议执行的命令参数）；
  * **信息补充（Input Request）**：包含动态表单 schema（文本框、下拉选择），用于用户提供凭据或关键决策上下文。
* **持久化与时效**：
  * 确认卡直接入库，具备唯一 `confirmation_id`，设置默认超时时间 `expires_at`（例如 24 小时）；
  * UI 离线时卡片稳定保存在 SQLite 中，下次打开界面重新拉取，卡片依旧处于激活状态；
  * 超时后状态转为 `expired`，后台向 Agent 推理上下文注入：“*User confirmation timed out. Action aborted.*”，驱动 Agent 优雅放弃或降级处理。
* **离线通知触达机制**：
  * 若检测到当前无活动的 WebSocket 连接（用户关闭了 Flutter 窗口）：
    * **本地系统通知**：调用 Windows 10/11 原生通知中心（使用 `node-notifier` 或基于 PowerShell 脚本触发带动作按钮的 WinRT Toast）；
    * **外部渠道降级（可选）**：若用户在设置中配置了 Telegram / 飞书 Webhook，发送一条卡片消息，附带操作回调 URL。

### 4. 任务调度语义与数据结构规范
* **成熟类库选型**：推荐选用 **`croner`**（严苛支持全量 cron 语法、原生支持 IANA 时区字符串如 `Asia/Shanghai`、支持夏令时转换与下一次触发时间预估，且无原生构建依赖）。
* **时区与错过补做（Misfire Policy）**：
  * 任务时间全部在 SQLite 中存储标准 UTC 时间戳与目标 IANA 时区标识；
  * 补做策略设计三种：
    * `skip`（默认）：停机期间错过的周期全部忽略，下一次从当前时间之后计算；
    * `catch_up_once`：若错过一次或多次，后台启动时立即补偿执行一次；
    * `coalesce`：合并错过的任务。
* **并发互斥策略**：
  * 单个 Scheduled Job 维护内存互斥锁（`isRunning` 标志）。若上次运行未结束，触发时直接丢弃本轮，并在 `job_executions` 记录 `status = 'skipped'`，原因标记为 `concurrency_conflict`。
* **执行与交付数据表结构设计**：

```sql
-- 定时任务定义表
CREATE TABLE scheduled_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    trigger_type TEXT NOT NULL,       -- 'cron', 'interval', 'once'
    pattern TEXT NOT NULL,            -- cron 表达式或间隔秒数
    timezone TEXT DEFAULT 'Asia/Shanghai',
    prompt TEXT NOT NULL,             -- 唤醒时的目标或指令
    isolated_session INTEGER DEFAULT 1, -- 是否使用独立无污染上下文
    misfire_policy TEXT DEFAULT 'skip', -- 'skip', 'catch_up_once'
    status TEXT DEFAULT 'active',     -- 'active', 'paused'
    created_at INTEGER NOT NULL
);

-- 执行历史流水表
CREATE TABLE job_executions (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    session_id TEXT,
    triggered_at INTEGER NOT NULL,
    completed_at INTEGER,
    status TEXT NOT NULL,             -- 'running', 'success', 'failed', 'skipped'
    duration_ms INTEGER,
    has_delta INTEGER DEFAULT 1,      -- 是否产生实质变化
    error_message TEXT,
    FOREIGN KEY(job_id) REFERENCES scheduled_jobs(id)
);

-- 外部交付通知记录表
CREATE TABLE delivery_records (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    channel TEXT NOT NULL,            -- 'local_ui', 'win_toast', 'webhook'
    status TEXT NOT NULL,             -- 'delivered', 'suppressed', 'failed'
    delivered_at INTEGER NOT NULL,
    FOREIGN KEY(execution_id) REFERENCES job_executions(id)
);
```

* **静默去重策略**：Agent 在执行自动化巡检任务时，若比对无异常，调用特定返回工具返回 `status: "no_changes"`。后台在交付阶段识别到 `has_delta = 0`，则将通知级别设为静默（仅入库历史，不在桌面或外部发起弹窗提醒）。

### 5. Agent 自创建任务工具设计与权限闭环
* **工具集声明**：向 Agent 注入一组严密受控的系统工具：
  * `schedule_cron_job(name, cron_pattern, prompt, timezone)`
  * `list_my_schedules()`
  * `pause_or_resume_schedule(job_id, action)`
* **防无限递归与频率限制**：
  * 强校验 cron 表达式解析出的最小触发间隔，限制不允许小于 5 分钟；
  * 每个项目工作区限制最多创建 10 个有效定时任务；
  * Agent 自身无法为具有直接系统文件删除、远程推送权限的危险动作创建无确认定时任务，必须附带人工审核标志。

### 6. 无人值守安全与成本熔断设计
* **安全沙箱与降级执行**：
  * 在无人值守模式下，降级工具执行权限。高风险命令（`rmdir /s`, `format`, 密码变更, 远程 `git push --force`）触发时，强制中断并生成持久化卡片等待用户回归审核；
* **预算与步数硬熔断**：
  * **单次运行步数限制**：单次定时任务触发设置 `max_turns = 20`，超时或超步数自动中止；
  * **Token 与费用预算表**：数据库维护每日费用计数器 `daily_usage`。一旦达到阈值（如每天 200k Token 或 $2.00），自动暂停所有活动的定时任务，直至用户进入 UI 手动提升配额或次日重置。
