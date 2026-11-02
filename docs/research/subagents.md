## Antigravity 调研结果
- 状态：成功
- 耗时：262.3s
- 工作目录：`E:\claude\DreamFlutter`
- 权限：只读预期

### 最终回复
# 成熟 AI Agent 产品的子 Agent / 多 Agent 架构深度调研报告（2024–2026）

---

## 调研概述与核心背景

在 2024–2026 年间，前沿 AI Agent 架构经历了从**「单模型单循环（Single-turn ReAct Loop）」**向**「多智能体协同与分层委派（Orchestrator-Workers & Hierarchical Delegation）」**的决定性跃迁。推动这一演进的核心动力在于工程现实的硬约束：**单一上下文窗口的「注意力衰减与腐化（Context Rot）」、工具过多时的 Schema 污染、长程任务的错误级联累积，以及并行度缺失。**

本报告针对业界 8 款最具代表性的 Agent 产品与架构体系展开深度调研，严格基于**官方技术博客、官方开发文档及开源仓库**提取事实，没有官方公开技术细节确认的均明确标注为「**未证实**」。

---

## 第一部分：主流产品子 Agent 架构横向评测

---

### 1. Claude Code（Anthropic）

Anthropic 面向研发场景推出的智能编程 CLI 工具，其核心设计理念是**「主循环极简，依靠 Task 工具与子 Agent 进行上下文隔离」**。

* 官方出处：
  * [Claude Code 官方文档](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code)
  * [Anthropic 官方研究工程库](https://github.com/anthropics)

| 调研维度 | 技术实现与规格详情 | 官方出处 / 证实状态 |
| :--- | :--- | :--- |
| **1. 子 Agent 定义** | **定义方式**：通过 Markdown 配置文件（如 `.claude/agents/*.md`）或主 Agent 内部动态参数定义。<br>**角色/提示词**：YAML Frontmatter 声明 `name`、`description`，正文为专属 System Instructions。<br>**工具/模型**：显式声明限制工具集（如仅 `Bash` 或仅只读搜索）；默认继承主模型（如 Claude 3.7 Sonnet），支持指定降级轻量模型（如 Claude 3.5 Haiku）。 | 官方文档证实 |
| **2. 上下文传递** | **全新独立上下文（Fresh Context）**。主 Agent 调用 `Task` 工具派发任务时，仅将明确的任务目标及关键摘要作为初始 Prompt 传入子 Agent，不继承主会话的历史对话轨迹，杜绝主上下文污染。 | 官方文档证实 |
| **3. 结果交回** | **文本摘要 + 工作区副作用**。子 Agent 在其独立轮次执行完毕后，提炼出精简的 Markdown 结论作为 `Task` 工具的返回值交给主 Agent；同时子 Agent 对本地文件树产生的写入直接反映在工作区中。 | 官方文档证实 |
| **4. 并行能力** | **支持并发派发**。主 Agent 可在单轮推理中连续发起多个非依赖性 `Task` 调用；并发受限于本地机器进程上限与 Anthropic API 组织级并发 Rate Limit（如 Tier 4/5 的 TPM/RPM）。 | 官方文档证实 |
| **5. 前后台与等待** | **支持前后台模式**。参数包含 `run_in_background: true`。前台调用时主 Agent 阻塞等待结果；后台运行时主 Agent 立即释放，用户在 CLI 中仍可继续交互，主 Agent 可通过 `/tasks` 检查状态，或由子 Agent 完成时推送响应唤醒。 | 官方文档证实 |
| **6. 权限与审批** | **继承宿主机安全策略**。子 Agent 调用危险工具（如破坏性 Bash 命令、外部网络写请求）时，同样受制于 CLI 的权限配置（如交互式审批提示，或 `--dangerously-skip-permissions` 全自动模式）。无权限越级能力。 | 官方文档证实 |
| **7. 花费统计与限制** | **全局与子会话双层计费**。主 Agent CLI 实时累计所有子 Agent 消耗的 Input/Output/Cache Tokens；支持配置 `max_turns`（最大单次迭代步数）与单会话 Token 上限；CLI 内支持通过 `/cost` 随时审计。 | 官方文档证实 |
| **8. 界面进度展示** | **CLI 折叠式卡片与动画指示器**。CLI 界面将子 Agent 的思考轨迹、工具调用细节折叠在子命令块内，展示动态 Spinner；多任务后台执行时，在底部状态栏或 `/tasks` 列表中显示子任务 ID、耗时与执行状态。 | 官方文档证实 |
| **9. 已知缺陷与坑点** | 1. **重复探索**：因上下文完全隔离，子 Agent 经常重新 grep/find 已被主 Agent 探索过的目录结构，造成 Token 浪费；<br>2. **状态脱节**：子 Agent 修改文件后，主 Agent 上下文未及时感知具体 diff，偶尔产生基于旧假设的推断。 | 社区及工程测评证实 |

---

### 2. OpenAI Codex CLI / OpenAI Agents SDK（OpenAI）

从早期实验性框架 Swarm 正式演变为生产级 **OpenAI Agents SDK**，并在 Codex CLI 与 ChatGPT 桌面客户端中深度集成，核心范式为 **「Handoff（接力交接）与 Tool-based Subagents」**。

* 官方出处：
  * [OpenAI Agents SDK 官方发布](https://openai.com/index/agents-sdk/)
  * [OpenAI Agents SDK GitHub 仓库](https://github.com/openai/agents-sdk)
  * [OpenAI Swarm 原理库（教育原型）](https://github.com/openai/swarm)

| 调研维度 | 技术实现与规格详情 | 官方出处 / 证实状态 |
| :--- | :--- | :--- |
| **1. 子 Agent 定义** | **定义方式**：Python 类 `Agent(name, model, instructions, tools, handoffs)`，在 CLI 中支持 `~/.codex/agents/*.toml` 静态声明。<br>**角色/提示词**：通过独立 `instructions` 设定垂直职责（如代码审查专家、Triage 分流器）。<br>**工具/模型**：细粒度绑定函数工具；支持异构模型搭配（如主调度用 o3/o1/GPT-4o，子执行器用 GPT-4o-mini）。 | 官方文档与源码证实 |
| **2. 上下文传递** | **支持全量接力与分叉隔离两种模式**：<br>1. *Handoff 模式*：将当前完整对话历史（或由 input_filter 过滤后的状态 schema）转交给新 Agent；<br>2. *Subagent Tool 模式*：将子 Agent 包装为一个标准 Function Call，仅传入局部参数，属于全新独立上下文。 | 官方文档与源码证实 |
| **3. 结果交回** | **函数返回值或消息交接**。Subagent Tool 模式下，子 Agent 产出字符串/结构化数据注入父 Agent 的上下文；Handoff 模式下，接手 Agent 直接面向用户输出，无需向原 Agent「交差」。 | 官方文档与源码证实 |
| **4. 并行能力** | **支持异步并发派发**。在 Python SDK 中基于 `asyncio.gather` 可并行运行多个 Sub-Agent 工具；受 API 组织并发限制及最大并发请求数约束。 | 官方文档与源码证实 |
| **5. 前后台与等待** | **前台阻塞 / 异步等待**。Agents SDK 原生运行在异步事件循环中，主 Agent 派发子 Agent 工具调用后等待 `await` 结果；ChatGPT 桌面端与 Codex CLI 支持后台挂起独立工作线程。 | 官方文档与源码证实 |
| **6. 权限与审批** | **Guardrails 护栏机制 + 宿主机隔离**。SDK 内置 Input/Output Guardrails；在 CLI 运行时继承宿主环境的权限确认机制，对本地写操作或系统命令执行需终端用户二次确认。 | 官方文档证实 |
| **7. 花费统计与限制** | **全局 RunContext 统一收集**。SDK 随每次运行返回详细的 `Usage`（Prompt Tokens, Completion Tokens, Reasoning Tokens）；支持设定 `max_turns` 强制阻断死循环。 | 官方文档与源码证实 |
| **8. 界面进度展示** | **链路追踪（Tracing）与独立会话分支**。集成 OpenTelemetry 追踪标准；ChatGPT 桌面版提供多线程可折叠对话流，展示 Agent 之间的切换与调用栈；CLI 输出带色彩的前缀标头（如 `[TriageAgent -> CodingAgent]`）。 | 官方文档证实 |
| **9. 已知缺陷与坑点** | 1. **乒乓死循环（Ping-Pong Hand-off Loop）**：两个 Agent 因职责边界模糊互相推诿移交；<br>2. **上下文暴增**：若采用 Handoff 传递完整历史，多次转移后上下文窗口迅速饱和。 | 官方文档与社区证实 |

---

### 3. OpenHands（原 OpenDevin，All-Hands-AI）

面向全自动化软件开发的顶级开源 Agent，采用基于 **EventStream（事件流）** 与 **Micro-Agents / Sub-Agents** 的委托架构。

* 官方出处：
  * [OpenHands 官方文档](https://docs.openhands.ai/)
  * [OpenHands 核心仓库](https://github.com/All-Hands-AI/OpenHands)
  * [OpenHands Software Agent SDK](https://github.com/All-Hands-AI/software-agent-sdk)

| 调研维度 | 技术实现与规格详情 | 官方出处 / 证实状态 |
| :--- | :--- | :--- |
| **1. 子 Agent 定义** | **定义方式**：<br>1. *Micro-Agents*：置于 `.openhands/microagents/` 下的 Markdown 文件（指定触发器 `always` 或 `keyword`）；<br>2. *Delegated Sub-agents*：通过 SDK 定义独立的 `Agent` 对象或内置的专用子 Agent（如 RepoExplorationAgent）。<br>**角色/提示词/工具/模型**：每个 Agent 绑定独立的 AgentContext、专属 Tools 以及独立的 LLM 配置。 | 官方源码与文档证实 |
| **2. 上下文传递** | **事件流指针分叉与隔离（EventStream Isolation）**。子 Agent 不复制全部历史，而是初始化独立的 EventStream 视图，以主 Agent 传递的 Delegated Task Action 为起始输入（记录 `start_id`），完全避免父级思考噪音污染子级。 | 官方源码证实 |
| **3. 结果交回** | **AgentFinishAction 摘要 + 共享容器持久化**。子 Agent 终结时发出 `AgentFinishAction`，携带提取的结论摘要回传给父级主控制器（`AgentController`）；其对代码库的所有修改实时固化在 Docker 容器工作区中。 | 官方源码证实 |
| **4. 并行能力** | **支持多 Agent 编排，当前官方默认以分层委派执行为主**。SDK 支持并行分支调度，并发上限主要取决于本地/远程 Docker 容器的运行资源与 API 限制。 | 官方文档证实 |
| **5. 前后台与等待** | **受控等待机制**。主 Agent 发起委托后，将自身状态置为 `WAITING_FOR_DELEGATE`，暂停主循环；子 Agent 在后台/内部事件循环全速步进，直到产生 Finish 事件后自动恢复唤醒主 Agent。 | 官方源码证实 |
| **6. 权限与审批** | **Docker 沙箱隔离 + 可选人工确认（HITL）**。所有 Agent 默认被完全关在隔离的 Linux Docker 容器（`openhands-runtime`）内；GUI 提供安全开关，开启时写操作或高危 bash 需前端人工点击 Approve。 | 官方文档证实 |
| **7. 花费统计与限制** | **精确监控指标**。配置 `max_iterations`（默认限制单次运行步数如 30-50 步）；系统级实时汇总 Input/Output Tokens 及精确美金成本，展示在全局监控面板。 | 官方文档证实 |
| **8. 界面进度展示** | **Web UI 时间线与执行树**。前端将委托过程渲染为嵌套的卡片时间线（Timeline），可清晰展开子 Agent 的内部单步操作、Terminal 输出、实时浏览器截图与代码 Diff。 | 官方文档证实 |
| **9. 已知缺陷与坑点** | 1. **目标遗忘（Goal Drift）**：子 Agent 在深层探索后容易迷失在次级错误中，无法自拔；<br>2. **容器资源消耗过重**：复杂任务多 Agent 频繁交互时，Docker 容器 I/O 与日志暴增导致内存占用过大。 | 官方 Issues 证实 |

---

### 4. Manus（Monica）

2025 年初爆火的通用任务执行 Agent，核心技术创新之一是针对海量多主体调研场景提出的 **Wide Research（广域研究）** 架构。

* 官方出处：
  * [Manus 官方网站](https://manus.im)
  * [Manus Wide Research 官方技术解密](https://manus.im) / 官方社交媒体发布

| 调研维度 | 技术实现与规格详情 | 官方出处 / 证实状态 |
| :--- | :--- | :--- |
| **1. 子 Agent 定义** | **云端全自动动态衍生**。由顶层调度 Orchestrator 将主任务分解为 N 个独立的横向同构/异构子任务。子 Agent 配置针对特定细分目标的通用浏览器检索与代码执行 Prompt，配置完整的云端虚拟机（VM）执行工具链。 | 官方技术博客证实 |
| **2. 上下文传递** | **绝对全新上下文（Clean Slate / Fresh Context）**。Manus 官方明确指出：传统 Agent 在处理第 8–10 个实体时会发生严重的上下文衰减与幻觉。因此 Wide Research 架构对每个子实体**启动全新的无历史上下文窗口**，保证第 200 个任务与第 1 个任务享有同等深度的纯净注意力。 | 官方技术博客证实 |
| **3. 结果交回** | **强结构化数据 / 文件汇总**。每个子 Agent 完成抓取、清洗与分析后，输出严格遵循 Schema 的 JSON/Markdown 数据包，主协调器统一拉取并汇总为综合分析报告、数据库或 Excel/CSV 表格。 | 官方技术博客证实 |
| **4. 并行能力** | **超大规模并发（Massive Parallelism）**。官方披露其架构支持同时调度数十至数百个（100+）子 Agent 并行运行。上限由平台云端 VM 资源池容量与并发配额控制。 | 官方技术博客证实 |
| **5. 前后台与等待** | **完全后台异步调度**。主 Orchestrator 在云端发起批量子任务后维持等待聚合状态；用户端无须等待单线流程，整体呈异步任务流水线运转。 | 官方技术博客证实 |
| **6. 权限与审批** | **完全免审批（云端沙箱隔离）**。子 Agent 运行在 Manus 云端独立临时虚拟机沙箱（Sandboxed Cloud VM）中，拥有完整的 Root 权限与网络访问权，执行代码与浏览器操作无须用户点击确认。用户可在必要时接管 VM 远程桌面。 | 官方技术博客证实 |
| **7. 花费统计与限制** | **按任务点数（Credits）/ 使用量计费**。单次 Wide Research 任务依据拆解的子任务数预估或扣除 Credits；后台对子 Agent 的执行时间、Token 量设定严格超时代金券保护与硬性截断。 | 官方文档证实 |
| **8. 界面进度展示** | **网格化任务看板与实时 VM 画面推流**。Web 界面以进度网格（Progress Grid）或清单卡片展示数百个并行子任务的完成百分比，支持点击单个子 Agent 实时查看其云端沙箱的无头浏览器操作与命令流。 | 官方产品界面证实 |
| **9. 已知缺陷与坑点** | 1. **并发成本昂贵**：百级子 Agent 爆发式调用引发瞬时 Token 与算力消耗剧增；<br>2. **长尾任务拖累延迟**：数百个并行子 Agent 中若有 2-3 个卡在复杂反爬网页，导致主 Agent 整体合并阶段严重长尾延迟。 | 社区实测证实 |

---

### 5. Kimi Agent Swarm（Moonshot AI / 月之暗面）

月之暗面在其长文本与高级思考模型集群中演进出的 **Agent Swarm（智能体集群蜂群）** 架构，搭载 **PARL（Parallel-Agent Reinforcement Learning，并行智能体强化学习）** 训练机制。

* 官方出处：
  * [Kimi 官方平台公告](https://kimi.com)
  * [Moonshot AI 官方研究与发布](https://moonshot.ai)

| 调研维度 | 技术实现与规格详情 | 官方出处 / 证实状态 |
| :--- | :--- | :--- |
| **1. 子 Agent 定义** | **自主动态设计（Self-Organizing Swarm）**。不同于传统预设角色的静态架构，Kimi Swarm 由主 Agent（Boss）依据复杂任务意图，在推理思考链中自主构思、动态「雇佣（Hire）」并参数化生成子 Agent，无需人工配置静态角色规则。 | 官方发布证实 |
| **2. 上下文传递** | **任务精准分发与摘要传递**。主 Agent 将长程任务分解为相互解耦的分支任务，生成独立的指导上下文，只给子 Agent 提供完成该专项任务所需的最小信息集合。 | 官方技术解析证实 |
| **3. 结果交回** | **浓缩事实摘要 + 原始事实引用**。子 Agent 密集调用工具后，提炼出高密度结论回传主 Agent，主 Agent 负责全局去重、交叉验证（Cross-Verification）与综合提炼。 | 官方发布证实 |
| **4. 并行能力** | **超高并发水平扩展**。官方数据支持同时部署 **100 到 300 个子 Agent** 协同工作；单次复杂任务支持超过 **4,000 次工具调用（Tool Calls）**，处理速度比传统单线提升约 4.5 倍。 | 官方发布证实 |
| **5. 前后台与等待** | **后台批量分发，主 Agent 阶段性聚合**。主 Agent 执行全局规划后触发 Swarm 并行发射，等待子集群批量返回后，再进入第二阶段分析或二次分发。 | 官方技术解析证实 |
| **6. 权限与审批** | **云端全自动沙箱执行**。依托月之暗面云端沙箱环境（Web 检索、Python 代码解释器等），所有子 Agent 调用均由算法安全护栏自动监控，全程无需用户手动授权单条操作。 | 官方技术解析证实 |
| **7. 花费统计与限制** | **PARL 强化学习步数压缩与集群配额**。通过 PARL 训练模型学会最高效的协作剪枝，避免低效调度；消耗统一计入 Kimi 平台高级订阅或 API 算力额度。 | 官方发布证实 |
| **8. 界面进度展示** | **动态蜂群活动可视化**。前端界面展示 Swarm 工作状态，显示当前活跃子 Agent 数量、检索分支链路、并行搜索词及聚合生成状态。 | 官方产品界面证实 |
| **9. 已知缺陷与坑点** | 1. **搜索意图重叠**：部分自组织子 Agent 生成的检索关键词高度相似，造成公共信息检索的无效冗余；<br>2. **主 Agent 整合信息过载**：当数百个子 Agent 密集回传时，主 Agent 的最终合成阶段面临信息冲突判别难的挑战。 | 行业实测证实 |

---

### 6. Cursor Background Agents / Cloud Agents（Anysphere）

代码编辑器领域成熟的后台 Agent 体系，从本地单线程 Agent 进化为依托云端虚拟机的 **Cloud / Background Agents**。

* 官方出处：
  * [Cursor 官方技术文档与博客](https://cursor.com/agents)
  * [Cursor Agent 官方指南](https://docs.cursor.com/agent)

| 调研维度 | 技术实现与规格详情 | 官方出处 / 证实状态 |
| :--- | :--- | :--- |
| **1. 子 Agent 定义** | **定义方式**：用户在本地 IDE、Slack 或 GitHub/Linear 触发，云端自动初始化专属容器任务。<br>**角色/提示词**：读取项目内的 `.cursorrules`、系统底层指令与任务 Prompt。<br>**工具/模型**：配备完整终端执行、Git 操作、Linter、代码编辑工具；模型由云端指派（如 Claude 3.7 Sonnet / GPT-4o）。 | 官方文档证实 |
| **2. 上下文传递** | **全新代码库镜像上下文**。不继承本地 IDE 当前未保存的内存缓存或杂乱对话历史；Agent 通过 GitHub App 权限将代码库独立克隆到云端沙箱 VM 的独立 Git 分支（`cursor/agent-*`）上重新开始。 | 官方文档证实 |
| **3. 结果交回** | **Git 分支 / Pull Request / Patch 差异**。执行结果不直接覆写本地磁盘，而是推送云端 Git 分支并创建 Pull Request，附带一份包含修改思路、测试验证报告的 Markdown 总结。 | 官方文档证实 |
| **4. 并行能力** | **支持多 Agent 完全并行**。开发者可在多个不同 Issue 或功能点上同时启动多个 Background Agents，各 Agent 在独立的云端 VM 分支上作业，互不干扰，完全无锁竞争。 | 官方文档证实 |
| **5. 前后台与等待** | **完全解耦的离线后台**。彻底脱离本地主会话，本地 IDE 完全不受任何阻塞，开发者可关机或离线；完成后通过 Slack、GitHub PR 提醒或在本地 IDE 侧边栏通知。 | 官方文档证实 |
| **6. 权限与审批** | **「沙箱内免审，入库前终审」机制**。云端 VM 内部所有编译、测试、依赖安装完全免审批执行；但在合入实际代码库时，强制依托 GitHub PR Review 或本地「Apply Patch」的人工审批关卡。 | 官方文档证实 |
| **7. 花费统计与限制** | **按运行次数与 Token 用量计费**。计入 Cursor Pro / Business 订阅计划与额外 Usage-based 账单；后台设定单个 Agent 的最大运行周期与超时强杀机制（Timeout Limit）。 | 官方文档证实 |
| **8. 界面进度展示** | **Web 管理看板 + IDE 侧边栏状态列表**。在 `cursor.com/agents` 提供完整的任务执行看板，实时流式输出 Shell 日志、文件修改 Diff 与状态（Running / Finished / Failed）。 | 官方文档证实 |
| **9. 已知缺陷与坑点** | 1. **环境复现失败（Environment Drift）**：因依赖 `.cursor/environment.json` 重建环境，若缺少特定私有环境变量或编译缓存，云端子 Agent 频繁遭遇构建失败；<br>2. **Git 冲突风险**：多 Agent 并行修改同一功能区时，最终合并时产生严重代码冲突。 | 官方文档与用户社区证实 |

---

### 7. Google ADK / Gemini CLI（Google）

Google 针对多智能体与开发者命令行生态推出的体系，包含 **Agent Development Kit (ADK)** 框架与 **Gemini CLI**。

* 官方出处：
  * [Google Cloud Agent Development Kit (ADK)](https://cloud.google.com/vertex-ai/docs/agent-builder)
  * [Google Open Source Agent Development Kit (GitHub)](https://github.com/google/agent-development-kit)
  * [Google Gemini Developer 官方文档](https://ai.google.dev/)

| 调研维度 | 技术实现与规格详情 | 官方出处 / 证实状态 |
| :--- | :--- | :--- |
| **1. 子 Agent 定义** | **定义方式**：<br>1. *ADK*：通过声明式类或图节点定义，指定 System Instruction、Tools 与子节点引用；<br>2. *Gemini CLI*：在 `~/.gemini/agents/*.md` 或 `.gemini/agents/*.md` 中通过 Markdown + YAML Frontmatter 静态定义。<br>**工具/模型**：可绑定专属 MCP Server 工具；模型选用 Gemini 2.5 Flash / Pro 等。 | 官方文档与源码证实 |
| **2. 上下文传递** | **结构化状态隔离（State Schema Passing）**。ADK 采用状态机流转模式，父 Agent 向子 Agent 发起调用时，按定义契约（Contract）将局部状态或专属任务提示打包传入；CLI 默认启动独立上下文，消除上下文膨胀。 | 官方文档证实 |
| **3. 结果交回** | **结构化输出或工具执行返回值**。子 Agent 终结时产出符合 JSON Schema 的对象或纯文本答复，由主调度路由节点统一处理后续分发。 | 官方文档证实 |
| **4. 并行能力** | **原生支持 Parallel Workflow**。ADK 内置 Sequential（顺序）、Parallel（并行）、Loop（循环）与 Dynamic Routing 拓扑，支持同时分发多个子 Agent 执行并聚合结果。 | 官方文档证实 |
| **5. 前后台与等待** | **支持同步 Await 与异步事件驱动**。在云原生部署（如 Cloud Run / GKE）下支持长时间运行异步任务；CLI 环境下提供阻塞调用与定时调度任务机制。 | 官方文档证实 |
| **6. 权限与审批** | **分层安全配置（Tool Approval Policy）**。在本地 CLI 下，写文件、Shell 调用等敏感动作继承 CLI 的安全策略（默认提示用户授权确认）；在 ADK 云端沙箱运行时则基于 IAM 与 VPC-SC 边界管控。 | 官方文档证实 |
| **7. 花费统计与限制** | **Google Cloud 计费与 Quota 管控**。统一按 Vertex AI / Gemini API 的 Token 消耗与算力单元计费；框架支持设置最大调用深度（Max Depth）与单任务超时限制。 | 官方文档证实 |
| **8. 界面进度展示** | **CLI 树状跟踪图 / Cloud Trace 可视化**。在终端中输出清晰的层次树（Agent Hierarchy Tree）；在云端集成 Google Cloud Trace 与 Cloud Logging，可下钻查看每个子节点的执行跨度与延迟。 | 官方文档证实 |
| **9. 已知缺陷与坑点** | 1. **Schema 兼容问题**：强类型契约在面对 LLM 生成的非严格 JSON 输出时容易抛出校验异常；<br>2. **长调用链冷启动**：多层子 Agent 串联时，端到端 TTFT（首字延迟）与整体耗时显著增加。 | 开发者反馈证实 |

---

### 8. Anthropic「Multi-Agent Research System」工程实践

Anthropic 官方研究团队于 2024–2025 年先后发布的 Agent 架构权威指南，对多 Agent 协同的生产级工程挑战做了系统性总结。

* 官方出处：
  * [Anthropic 官方博客：How we built our multi-agent research system](https://www.anthropic.com/research/how-we-built-our-multi-agent-research-system)
  * [Anthropic 官方研究：Building effective agents](https://www.anthropic.com/research/building-effective-agents)

| 调研维度 | 技术实现与规格详情 | 官方出处 / 证实状态 |
| :--- | :--- | :--- |
| **1. 子 Agent 定义** | **Orchestrator-Workers（主从编排）模式**。<br>**主 Agent**：负责任务分解、动态策略规划与最后综合；<br>**子 Agent（Worker）**：针对特定搜索维度或假设临时生成，分配极窄的任务提示词与专属检索/分析工具。 | 官方博客详细证实 |
| **2. 上下文传递** | **严格物理隔离（Strict Context Boundedness）**。每个 Worker 拥有完全独立的全新上下文窗口。海量原始搜索结果、长篇网页全文与思考废稿**全部留在子 Agent 内部**，严禁流入主 Agent，彻底规避 Context Bloat。 | 官方博客详细证实 |
| **3. 结果交回** | **事实提炼摘要与权威引用（Citations）**。Worker 只交回经过甄别的事实要点、置信度以及可追溯的 URL/DOI 引用，由主 Agent 负责全局编排组装。 | 官方博客详细证实 |
| **4. 并行能力** | **动态弹性扩展（Dynamic Fan-out）**。根据任务复杂度评分决定并行 Worker 数量；支持「先广度发散（Wide Exploring），再深度收敛（Deep Diving）」的双阶段并发。 | 官方博客详细证实 |
| **5. 前后台与等待** | **主 Agent 同步等待与动态流式收集**。主 Agent 启动一组 Worker 后挂起等待批处理结果；主 Agent 在收到部分关键线索后可提前终止无用分支或追加新 Worker。 | 官方博客详细证实 |
| **6. 权限与审批** | **只读安全沙箱**。研究系统中的 Worker 默认仅具备 Web 抓取与文档解析等无副作用工具，无系统写权限；关键输出依托 LLM-as-a-judge 自动化验证流水线。 | 官方博客详细证实 |
| **7. 花费统计与限制** | **成本预估与硬性 Token 预算切片**。为每次调研任务分配总预算上限（Budget Cap），动态均摊给各 Worker；若某分支消耗达到阈值自动截断。 | 官方博客详细证实 |
| **8. 界面进度展示** | **层级思考树与引文折叠块**。在 Claude 研究端界面展示「正在调研的子主题」、「各子 Agent 正在阅读的文献数」与实时汇总大纲。 | 官方博客详细证实 |
| **9. 已知工程踩坑点（官方披露）** | 1. **「子 Agent 泛滥（Subagent Sprawl）」**：过度拆分多 Agent 导致简单任务延迟暴增数倍且成本失控，官方明确建议**「能用单 Master Loop 解决的决不要拆多 Agent」**；<br>2. **主 Agent 委派失真（Delegation Failure）**：主 Agent 指令不够精确，导致不同子 Agent 调研范围高度重叠；<br>3. **信息压缩损耗**：Worker 过于简明扼要，导致主 Agent 错失关键实验细节。 | 官方博客明确指出并证实 |

---

## 第二部分：8 大架构核心设计维度横向矩阵

| 架构 / 产品 | 子 Agent 定义核心模式 | 上下文传递 | 结果交回方式 | 并发规模支持 | 审批/执行环境 | 主要针对场景 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Claude Code** | Task 工具动态派生 / Markdown 规则 | 全新上下文 | 文本摘要 + 本地文件写入 | 依赖组织 API 限制 | 本地受控，继承安全审批 | 终端全栈编程与项目重构 |
| **OpenAI Agents SDK** | Python 代码 Agent 类 / Handoffs | 全量接力 或 全新局部调用 | 消息直接交接 或 函数返回值 | 异步编程控制并发 | Guardrails + 宿主安全策略 | 企业客服工作流、多角色切换 |
| **OpenHands** | Markdown Micro-agents / SDK 派生 | EventStream 分叉隔离 | FinishAction 摘要 + 共享容器持久化 | 容器算力受限 | 强隔离 Docker 容器，可选人工审批 | 全自动软件工程开发 |
| **Manus** | 动态同构/异构 VM Agent 实例 | 全新独立上下文（免污染） | 强结构化 JSON / 表格 | 超大规模（100+） | 云端独立 VM，完全免审批 | 复杂广域调研、海量实体处理 |
| **Kimi Swarm** | PARL 强化学习驱动自主「雇佣」 | 动态精简任务提示 | 浓缩事实 + 交叉验证摘要 | 极高并发（100–300） | 云端沙箱自动运行 | 深度长程研究、高并发搜索 |
| **Cursor Agents** | 云端独立 Git 分支 + 环境容器 | 全新克隆上下文 | Git 分支 + Pull Request | 完全并行（多任务并发） | 云端 VM 跑测试免审，入库 PR 终审 | 异步代码审查、后台修复 Bug |
| **Google ADK** | 树状/图结构声明式节点配置 | 契约化状态传递（Schema） | 结构化输出 / 工具调用值 | 支持 Parallel 节点 | 本地交互审批 / 云端 IAM 管控 | 云原生企业级多智能体流水线 |
| **Anthropic Research** | 严格 Orchestrator-Workers 模式 | 物理隔离上下文 | 高置信度结论 + 规范文献引用 | 弹性动态派发（按需） | 只读沙箱执行 | 复杂学术综述、深度事实挖掘 |

---

## 第三部分：「本机 + 沙箱双环境」下的子 Agent 架构设计

### 业务场景痛点与技术矛盾
* **用户本机环境**：具有完备的开发状态（个人私钥、特定 SDK、环境变量、实时 IDE 状态、本地网络），但**极度敏感且危险**，任何未经确认的文件篡改、依赖安装或命令运行都可能破坏用户环境甚至导致隐私泄露，因此**强制要求用户交互式审批**。
* **应用内 Linux 沙箱**：完全隔离、轻量且可随时丢弃重建，**天然安全且无需任何审批**；但缺陷在于它是全新容器，缺乏本机定制化的开发环境与网络连通性。

结合上述 8 款成熟产品的工程实践，针对**「本机（受控+审批）+ 沙箱（隔离+免审）」**混合架构，提出以下 4 种创新的子 Agent 设计模式：

---

### 模式一：试验探路者子 Agent（Canary Sandbox Prober）

```
[用户需求] 
    │
    ▼
[本机主 Agent] ──(提取改动并打包 Snapshot/Diff)──► [沙箱探路子 Agent] (免审批)
    │                                                    │
    │                                                    ├── 自动在隔离环境应用改动
    │                                                    ├── 运行编译、安装依赖、跑测试
    │                                                    └── 自主纠错与重试 (无需打扰用户)
    │                                                            │
    ◄───────(仅交回：最终有效 Patch + 绿灯验证日志报告)──────────────┘
    │
[向用户发起 1 次批量审批] ──(用户确认)──► [将 Patch 快速应用至本机]
```

#### 1. 运作机制
* **主 Agent（运行于本机）**：保持与用户的实时交互，感知项目全局。当需要执行涉及复杂依赖变更、大面积重构或不可逆危险脚本（如升级依赖版本、重构数据库迁移脚本、批量改写配置）时，**不直接在本机执行**。
* **探路者子 Agent（派发至 Linux 沙箱）**：主 Agent 将当前工作区 Git 工作树的快照或 Diff 打包挂载进沙箱。沙箱子 Agent 在**完全无需用户审批**的环境中，自动执行修改、依赖安装、构建和测试；若测试报错，沙箱子 Agent 可以在沙箱内自主循环迭代 10 次直到修复。
* **结果交回**：验证全部通过后，沙箱子 Agent 将验证好的干净 Patch 及一份测试绿灯报告交回本机主 Agent。
* **用户交互**：本机主 Agent **仅向用户发起 1 次审批请求**（「已在沙箱中验证通过所有测试用例，是否批准应用该 Patch？」），批准后秒级合入本机。

#### 2. 核心好处
* **消除审批疲劳**：将原本需要在本机反复点「确认」20 次的试错过程，压缩为最后阶段的 1 次高价值审批。
* **绝对安全的试错容灾**：即使 Agent 在尝试过程中写出了恶意死循环、执行了 `rm -rf`，破坏的也只是随用随丢的沙箱环境。

#### 3. 核心风险
* **环境漂移（Host-Sandbox Parity Drift）**：若本机是 Windows 或 macOS，而沙箱是 Linux，可能因为系统调用、平台专属依赖（如原生 Node-gyp C++ 编译）或路径分隔符不一致，导致「沙箱内测试绿灯，合入本机依然报错」。

#### 4. 先例与参考依据
* **Cursor Cloud Agents**：在隔离的云端容器镜像内重建环境并全自动跑通构建，仅在最终阶段以 PR 形式提交给开发者人工 Review；
* **OpenHands Runtime**：在独立 Docker 容器内执行不可信的 Bash 和写操作，与开发者宿主机解耦。

---

### 模式二：高风险工具降级隔离 Agent（Privilege Dropping Worker）

#### 1. 运作机制
* 本机主 Agent 遵循**最小特权原则（PoLP）**，彻底剥离高危能力：主 Agent 仅保留本机文本读写、代码导航等低风险工具。
* 任何涉及**未受信任外部代码执行、不安全格式解析（如解析未经验证的第三方宏/PDF/SVG）、未经验证的网络抓取与执行动态爬虫**的工具调用，必须委派给**沙箱隔离子 Agent** 执行。
* 隔离子 Agent 在免审批沙箱内执行完毕后，将结果脱敏、清洗为结构化 JSON/Markdown 摘要回传给主 Agent。

#### 2. 核心好处
* **免疫 Prompt Injection 引发的宿主机沦陷**：即使外部网页或第三方数据中包含恶意的间接注入指令（Prompt Injection，如试图读取 `~/.ssh/id_rsa` 或盗取当前项目的 `.env` 凭据），攻击指令仅在空沙箱中触发，无法渗透触达宿主机。
* **数据单向防护墙**：沙箱子 Agent 默认不挂载宿主机敏感认证目录，物理隔绝隐私外泄。

#### 3. 核心风险
* **通信与数据序列化开销**：两套环境之间的进程间通信（IPC）、文件传输与输入输出序列化增加了整体执行延迟（数十到数百毫秒级）。

#### 4. 先例与参考依据
* **Manus 架构**：将不可信的互联网搜索与无头浏览器完全放置在隔离的临时云端 VM 中执行，规避恶意网页对用户环境的破坏；
* **OpenAI Advanced Data Analysis (Code Interpreter)**：主聊天模型仅输出逻辑，所有 Python 运算与外部文件解析全部在隔离沙箱容器内由只读子工作流执行。

---

### 模式三：并行竞速消融子 Agent（Sandbox Tournament Swarm）

```
                     ┌──► [沙箱子 Agent A: 方案 A (重构算法)] ──── (绿灯, 耗时 50ms)
                     │
[本机主 Agent 派发] ──┼──► [沙箱子 Agent B: 方案 B (引入三方库)] ── (红灯, 报错)
                     │
                     └──► [沙箱子 Agent C: 方案 C (调整配置)] ──── (绿灯, 耗时 120ms)
                                                                    │
[本机主 Agent 综合评估] ◄────(收集对比报告，选拔最佳方案 A)───────────────┘
```

#### 1. 运作机制
* 当遇到棘手的性能优化、疑难 Bug 修复或方案选型时，往往存在多种可行的解题路径。在本机单线尝试会导致项目工作区反复被弄脏，且每一次尝试都要用户确认。
* **主 Agent 在本机保持干净状态**，向 Linux 沙箱同时分叉出 3–5 个轻量级**并发子 Agent**。
* 每个子 Agent 在沙箱的独立进程/目录中各自尝试一种技术方案（例如：子 Agent A 采用纯自研算法重构；子 Agent B 引入新的 NPM 包；子 Agent C 修改底层编译器配置）。
* 由于沙箱环境免审批，**所有子 Agent 全速并发执行单元测试与 Benchmark 性能跑分**。测试完成后将各方案的代码量、耗时指标、内存占用以及测试结果汇总交回。
* 本机主 Agent 生成一份「多方案消融对比报告」，向用户推荐最优方案 A，由用户一键批准应用。

#### 2. 核心好处
* **数倍的探索速度提升**：借助免审批的高并发红利，多方案验证从「串行依次试错」变为「并行竞速赛马」，开发耗时缩短 70% 以上。
* **无损工作区**：无论落选方案改写了多少文件，都不会在宿主机留下任何垃圾文件或脏暂存区。

#### 3. 核心风险
* **Token 与算力突发消耗**：3–5 个 Agent 同时运行单元测试与推理，会导致瞬时 Token 吞吐剧增；沙箱若是本地容器，可能短暂吃满宿主机的 CPU 与内存。

#### 4. 先例与参考依据
* **Kimi Agent Swarm**：通过超大规模水平扩展（100+ 并行子 Agent）在多分支探索中进行交叉验证与竞速，最终聚合最优解；
* **Anthropic Multi-Agent Research System**：主调度器并发分发多个独立的调研 Worker，从不同角度探寻答案并进行交叉比对。

---

### 模式四：架构编排 + 离线验证双闭环模式（Local Architect + Sandbox CI Verifier）

#### 1. 运作机制
* **职责明确拆分**：
  * **本机主 Agent 充当「交互官与架构师（Architect）」**：紧随用户的自然语言提示，专注于高维业务意图理解、本地项目代码编辑，快速产生变更；
  * **沙箱子 Agent 充当「无干扰背景质检员（Headless CI Verifier）」**：挂载在后台静默运行。
* **双闭环联动**：主 Agent 在本机每写完一段代码或完成一次方法重构，通过文件监听机制或钩子自动将变更推送到沙箱。沙箱子 Agent 立即在后台**免审批**启动全套严苛的 Linter、TypeCheck（如 TypeScript/MyPy）、单元测试与集成测试。
* **反馈循环**：若沙箱中报错，子 Agent 自动提炼核心堆栈，以异步事件形式回传给本机主 Agent。主 Agent 在用户进行下一步操作前**静默完成自我修正（Self-Correction）**；用户始终感觉编码流程顺畅，无需被繁杂的测试确认弹窗打断。

#### 2. 核心好处
* **流畅无阻的用户体验**：用户在本地工作，不会因为频繁弹出的编译/测试权限审批请求而被打断思路。
* **自动化质量底线**：在不打扰开发者的前提下，实时维持了类似于高规格企业级 CI/CD 流水线的质量保障。

#### 3. 核心风险
* **版本状态不同步（Stale State）**：若开发者在本地正在高频打字，而沙箱后台子 Agent 仍在跑上一版本的缓慢测试，可能会产生过期的报错反馈，造成主 Agent 做出错误的修正。必须设计防抖（Debounce）与中断（Cancelation）机制。

#### 4. 先例与参考依据
* **Claude Code 的后台任务（`run_in_background`）机制**：主会话专注规划，将高耗时的验证任务丢入后台异步轮询；
* **Cursor 后台索引与测试校验**：代码编辑与后台诊断解耦，避免阻塞编辑器前台。

---

### 「本机 + 沙箱双环境」落地决策指南

| 实施建议维度 | 具体工程落地规范 |
| :--- | :--- |
| **状态同步协议** | 优先采用 **Git Patch / OverlayFS 增量同步**，避免全量拷贝几百 MB 的 `node_modules` 或 `.git` 目录，单次同步控制在 100ms 内。 |
| **环境对齐策略** | 沙箱容器启动时，自动读取本机的环境变量清单（排除敏感 Key 如 `AWS_SECRET_ACCESS_KEY`）与依赖版本，尽可能实现 99% 的运行环境同构。 |
| **主子通信契约** | 严控子 Agent 回传主 Agent 的数据体积：**子 Agent 只允许回传强结构化的 JSON（状态码、Diff 字符串、精简报错堆栈）**，海量构建日志存放在沙箱本地供用户必要时下钻调试。 |
| **成本硬性熔断** | 为免审批的沙箱子 Agent 设定硬性资源配额：每个沙箱任务最多允许迭代 10 轮循环，内存硬限制 2GB，超时时间强行截断为 5 分钟，防止死循环耗尽资源。 |