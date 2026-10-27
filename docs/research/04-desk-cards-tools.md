# 个人桌面 AI Agent 架构与交互设计调研报告
**（方向 4/4：工作区/书桌、卡片与产物、执行可见性、工具与外部连接）**

> **项目背景对齐**：面向 Windows 桌面个人通用助理（底层 Pi coding agent，界面 Flutter）。核心概念包含「书桌」（用户资料、写笺、任务、产物的集中工作台）、「卡片」（任务卡、确认卡、产物卡的历史与最新态）、「执行可见性」（可追溯工具、耗时、用量、错误）以及「工具与外部连接」（MCP、多渠道通知、权限边界）。

---

## 一、 代表性项目深度调研（18 项）

### 1. Claude Artifacts 与 Claude Projects (Anthropic)
* **定位**：业界标杆级的独立产物交互面板与项目级长效上下文工作区。
* **具体机制**：
  * **Artifacts**：当生成的代码 >15 行、SVG、HTML/React 原型或独立长文档时，触发 `<antArtifact>` 语法，右侧自动拉起独立分栏。提供代码视图与实时渲染视图；右下角提供版本切换选择器（Version History，如 `v1`, `v2`），用户可随时翻阅历史版本的产物。
  * **Projects**：每个项目具备专属 System Prompt 及 Knowledge Base（支持上传 PDF、代码、文本）。在对话时采用动态注入与按需引用机制，文件变动无需重建整个对话。
* **值得借鉴的细节**：产物与对话流**物理隔离（双栏）**，避免聊天流被大段代码刷屏；产物版本可独立切回；项目资料与会话呈“一对多”从属关系。
* **真实链接**：https://claude.ai

### 2. ChatGPT Canvas 与 Projects (OpenAI)
* **定位**：协作式富文本与代码编辑工作区，支持用户与 AI 针对产物的微调共创。
* **具体机制**：
  * **Canvas**：独立编辑画布。用户可划选特定段落或代码行，直接针对局部提问或请求重写（Inline Edit）；右下角提供一键快捷操作菜单（调整阅读级别、增删表情、润色长度、语法修正、调试打 log）；右上角设有时间轴回退滑块，支持任意步回滚。
  * **Projects**：组织聊天会话与文件（上限 25~50 个文件），跨会话共享指令与文件知识（结合向量检索与 Code Interpreter 挂载）。
* **值得借鉴的细节**：**划选局部针对性修改**与**版本时间轴滑块**；快捷工具条将高频非技术指令抽象为“一键调节滑块”，极佳地降低了操作门槛。
* **真实链接**：https://chatgpt.com

### 3. NotebookLM (Google)
* **定位**：以“用户个人资料为中心”的研究与笔记协作桌面 Agent。
* **具体机制**：
  * **Sources 面板**：支持 PDF、Google Docs、网页链接、YouTube 视频字幕、纯文本与剪贴板导入。每份资料自动生成纲要与关键主题。
  * **资料勾选机制（Source Grounding）**：用户在左侧勾选/取消勾选具体文件，控制 AI 这一轮只基于哪些资料回答，并给出带编号的原角标跳转。
  * **Studio 笔记卡**：右侧是笔记面板，会话中有价值的回答可一键“Save to Note”固化为便笺；支持一键把便笺组合生成 Audio Overview（播客对话）、FAQ、Study Guide 等衍生卡片。
* **值得借鉴的细节**：**“写笺（Note）与资料（Source）共存”**的设计范式；精确到文档勾选的显式上下文控制，让用户清楚 Agent 到底读了哪篇材料。
* **真实链接**：https://notebooklm.google.com

### 4. Notion AI 与 Mem.ai
* **定位**：笔记原生与自组织个人知识库的“笔记交给 AI”范式。
* **具体机制**：
  * **Notion AI**：块级（Block-level）交互。写笺本身就是文档块，通过空白处触发 AI 编写；Database 具备“AI Autofill”列属性，对表格内每一行笔记自动执行摘要、提取动作项；Notion Q&A 跨工作区全文与语义检索。
  * **Mem.ai**：无文件夹架构，全靠 AI 自动连接。具有全局剪贴板抓取与邮件转发录入；聊天时 AI 自动把零散写笺召回为“行动清单（Task Card）”，双向链接原笔记。
* **值得借鉴的细节**：写笺“**默认就是纯静态笔记，按需触发 Agent**”的设计思想；块级状态流与双向反向链接溯源。
* **真实链接**：https://notion.so ； https://mem.ai

### 5. AnythingLLM Workspaces (Mintplex Labs)
* **定位**：开源、本地优先的企业级与个人私有知识库桌面客户端。
* **具体机制**：
  * **工作区隔离**：每个 Workspace 具备独立的本地向量表（LanceDB/Chroma 等）、专属 System Prompt 和参数配置。
  * **文件管理池**：全局资料库支持拖拽、网页爬取等；可将文件精准“Pin/Unpin”映射到某个工作区，界面清晰展示文档切分（Chunks）与向量化进度。
  * **内置 Agent 模式**：每个工作区可独立开启 Agent 技能（如网页抓取、SQL 数据库查询、本地文件分析）。
* **值得借鉴的细节**：本地多工作区严格数据隔离；文档向量化状态可视化（解析中/已就绪）；文件从全局池到任务工作区的勾选挂载。
* **真实链接**：https://github.com/Mintplex-Labs/anything-llm

### 6. Cherry Studio
* **定位**：基于 Electron 的国产开源全能桌面 AI 客户端（多模型、本地知识库、MCP 聚合）。
* **具体机制**：
  * **知识库系统**：集成桌面轻量向量引擎，支持混合检索（向量 + BM25 全文检索）。可直观看到文档切片详情，支持按需关联到特定助手。
  * **桌面交互**：左侧集中抽屉管理（会话、资料库、工具），轻量化置顶窗口与系统托盘快速唤起。
* **值得借鉴的细节**：纯本地运行，免除云端配置复杂度；直观的文档分块检视和命中度测试，非常适合桌面本地化落地。
* **真实链接**：https://github.com/kangfenfei/cherry-studio

### 7. Manus
* **定位**：全托管、长流程异步自治的通用 AI Agent 平台。
* **具体机制**：
  * **全异步任务卡**：采用“思考-规划-执行-观察”阶段卡片。左侧展示长流程步骤树（每个步骤有 Pending、Running、Success、Failed 状态），展开可查阅动作日志与浏览器操作截屏。
  * **独立产物卡与交付物看板**：右侧实时预览生成物（PPT 幻灯片、数据表、网页原型），任务完成后汇总为直观的下载与分享面板。
* **值得借鉴的细节**：**长耗时任务的执行过程解耦**；“总览进度条 + 步骤折叠卡”；向非技术用户输出高度直观的最终交付物，掩盖底层脏乱日志。
* **真实链接**：https://manus.im

### 8. OpenHands 界面（原 OpenDevin）
* **定位**：开源的通用软件开发与自动化任务 Agent 桌面/Web 平台。
* **具体机制**：
  * **多象限协同界面**：左侧聊天与交互输入，中间自适应展示 Planner 任务树（带动态勾选框的子任务清单），右侧支持 Tab 切换：文件浏览器、代码编辑器、实时终端、无头浏览器动态串流（通过 CDP 截屏呈现 Agent 正在浏览的网页）。
  * **Action / Observation 事件流**：底层采用强类型事件总线，前后端通过 WebSocket 实时同步每一步操作。
* **值得借鉴的细节**：**浏览器视觉同步**（让用户看见 Agent 在点什么网页）；带有勾选态的**分级计划卡片（Planner）**；工作区文件实时变动感知。
* **真实链接**：https://github.com/All-Hands-AI/OpenHands

### 9. Agent Zero
* **定位**：轻量级、完全自主且高度透明的 Docker/本地代码执行 Agent 框架。
* **具体机制**：
  * **极高执行可见性**：将内部独白（Monologue）、执行工具指令、标准终端输出以高度可读的卡片流依次输出。
  * **动态工具生成与子 Agent**：Agent 遇到未知问题可自主编写 Python 脚本并注册为新工具；主 Agent 可随时孵化 Sub-agent 并行执行，完成后聚合回溯。
  * **实时干预**：用户可随时中断或向执行流注入引导消息。
* **值得借鉴的细节**：思维链（CoT）与工具调用执行流的优雅卡片式排版；随时接管（Human-in-the-loop）的打断设计。
* **真实链接**：https://github.com/frdel/agent-zero

### 10. Open Interpreter
* **定位**：运行于本机的开源自然语言代码执行器与桌面控制 Agent（OS Computer Use）。
* **具体机制**：
  * **权限确认与安全边界**：默认开启确认机制。执行任何 Shell/Python 脚本前，必须在界面打印具体代码与执行意图，等待用户确认 `(y/n)`；提供 `-y` 自动模式供高级用户选用。
  * **OS 控制模式**：具备视力（视觉定位截屏）与系统输入控制（键鼠模拟），操作桌面窗口。
  * **透明输出流**：代码高亮与 stdout/stderr 实时流式折叠打印，报错自纠。
* **值得借鉴的细节**：**危险操作拦截卡**（“即将运行脚本修改文件，是否允许？”）；对本地桌面级操作的权限边界分级。
* **真实链接**：https://github.com/openinterpreter/open-interpreter

### 11. Cline Checkpoints
* **定位**：VS Code 内的自主 Coding Agent，具备业界标杆级的文件快照回滚机制。
* **具体机制**：
  * **Shadow Git 快照**：每次工具修改文件前，Cline 在后台独立轻量 Git 机制中建立 snapshot，不污染用户自身的 Git 分支。
  * **双重分离回滚（Restore 分开）**：在每一个执行节点卡片旁，提供两个明确按钮：
    1. **Restore Files**：仅将工作区文件内容回滚到该时刻，保留后续对话；
    2. **Restore Task & Files**：将对话上下文与文件内容同时回溯到该节点。
  * **内置 Diff 对比**：点击可直接展开 IDE 原生对比视窗查看改动。
* **值得借鉴的细节**：**文件回滚与对话上下文回滚解耦**（极其贴合本项目的核心诉求）；避坑细节：需对 `node_modules` 或大文件建立精确过滤，避免快照膨胀。
* **真实链接**：https://cline.bot ； https://github.com/cline/cline

### 12. Cursor（Agent 视图与 Checkpoint）
* **定位**：新一代 AI 原生 IDE（Composer Agent / Background Agent）。
* **具体机制**：
  * **Agent 视图与批处理卡片**：Agent 跨文件修改被聚合在一个统一的“变更审查卡片”中，显示所有增删文件列表，支持单文件审查或一键“Accept / Reject All”。
  * **Checkpoint 恢复**：长流程操作支持单步回滚（Restore Checkpoint），撤销本轮 Agent 引起的文件脏改动。
  * **后台 Agent 运行**：支持将重型任务挂在后台静默运行，前台保留轻量状态指示，完成后卡片唤醒。
* **值得借鉴的细节**：文件批次改动合并卡；后台任务执行与前台无感通知。
* **真实链接**：https://www.cursor.com

### 13. LobeChat Artifacts
* **定位**：现代化开源跨端 AI 客户端，强调高颜值 UI 与丰富插件生态。
* **具体机制**：
  * **侧边抽屉式 Artifacts**：支持 Markdown、SVG、HTML/JS、Mermaid、React 动态渲染，支持全屏预览与独立复制代码。
  * **插件与工具调用微卡片**：工具调用以小胶囊/可折叠卡片形式展示输入参数与返回结果，UI 不突兀。
* **值得借鉴的细节**：**抽屉式侧边栏（Drawer）**展示产物，契合 Flutter 的响应式布局；微型状态卡片对非技术用户极度友好。
* **真实链接**：https://github.com/lobehub/lobe-chat

### 14. OpenClaw (Canvas 与多通道 IM)
* **定位**：面向全平台的本地化自主 AI 个人助理（"The lobster way"），深度整合即时通讯与实时画布。
* **具体机制**：
  * **Live Canvas**：内置独立 Canvas 扩展，用于实时承载图表、原型与长文档预览。
  * **全平台 IM 网关**：原生支持接入 Telegram、WhatsApp、Slack、Discord。用户在外可用手机发送任务，桌面端后台执行，执行过程关键确认卡通过 IM 互动按钮（Inline Buttons）让用户审批，完成后把产物推回 IM。
* **值得借鉴的细节**：**桌面 Agent 作为 Execution Core，移动端 IM 作为远程遥控器**；将“确认卡”无缝映射为 Telegram/飞书的交互按钮。
* **真实链接**：https://github.com/openclaw/openclaw

### 15. Hermes Agent (Nous Research)
* **定位**：Nous Research 开发的高自主性开源 Agent 框架，主打自进化技能与长程多通道交互。
* **具体机制**：
  * **自进化技能库（Skill-learning）**：执行工具任务并验证成功后，将经验转化为固化的 YAML Skill 沉淀至记忆库。
  * **多通道常驻服务**：支持后台 Telegram/Discord 守护进程，具备全天候断点续跑与自动恢复机制。
* **值得借鉴的细节**：将用户的高频写笺任务沉淀为“长效技能卡片”；强大的后台持久服务通信范式。
* **真实链接**：https://github.com/NousResearch/hermes-agent

### 16. Goose (Block / aaif-goose)
* **定位**：Block (Square) 开源的通用开发与自动化 Agent 框架，完全原生基于 MCP 规范。
* **具体机制**：
  * **MCP 原生扩展体系**：所有能力（CLI、文件读写、GitHub、浏览器、开发工具）全部封装为标准 MCP 服务，支持即插即用。
  * **Recipes（任务配方）**：支持用 YAML 编写“任务配方”，组合多个扩展与指令，一键批量触发。
* **值得借鉴的细节**：完全解耦的 MCP 架构；**配方化（Recipes）**理念，非常适合本项目中“从写笺模板一键实例化为特定任务”。
* **真实链接**：https://github.com/aaif-goose/goose

### 17. MCP 桌面生态配置界面（Claude Desktop / Cherry Studio / Cursor）
* **定位**：当前桌面 AI Agent 最核心的工具扩展协议标准与配置形态。
* **具体机制**：
  * **Claude Desktop**：采用 `claude_desktop_config.json` 手工配置本地 stdio。输入框上方展示“锤子”图标显示可用工具，调用本地危险工具时强制弹出确认对话框（Allow / Always Allow）。
  * **Cherry Studio**：最成熟的**图形化配置界面**。支持表单输入（命令、参数、环境变量、SSE URL）与 JSON 双向实时切换；具备连通性状态指示灯（绿/红），可展开查看每个 MCP Server 导出的具体工具列表并支持单独勾选启用/禁用。
  * **Cursor MCP**：设置项支持全局与项目级配置，支持一键刷新拉取最新 Tools 列表并挂载到 Agent Composer 中。
* **值得借鉴的细节**：**禁止强迫非技术用户手写 JSON 配置文件**；必须提供“表单添加 + 一键开关 + 连通性测试绿灯 + 单工具禁用”的图形面板。
* **真实链接**：https://modelcontextprotocol.io

### 18. Langfuse / AgentOps / Arize Phoenix（Trace 数据模型）
* **定位**：主流的工业级 LLM & Agent 可观测性与追踪系统。
* **具体机制**：
  * **数据模型分层**：
    * `Trace`：整个顶层任务树（含任务 ID、总耗时、总花费成本/Token、最终状态、用户元数据）；
    * `Span`：有开始和结束时间的中间逻辑段（如“工具执行”、“知识检索”、“语义重写”），形成父子树状调用链；
    * `Generation`：具体的 LLM 节点，记录模型名、提示词模版、输入输出 Token、延迟；
    * `Event`：无持续时间的瞬时点（如“用户确认”、“触发降级回退”）。
* **面向非技术用户的降噪呈现**：
  * 放弃复杂的 OpenTelemetry 瀑布图，抽象为**“三态任务进度条卡片”**：
    * 【进行中】：简短自然语言（如“正在检索本地资料... 已耗时 3s”）；
    * 【完成】：折叠为“已参考 3 份资料，调用 2 个工具，用时 8s”（可点击展开详细步骤）；
    * 【异常】：展示可读的纠错建议而非堆栈报错。
* **值得借鉴的细节**：底层遵循标准的 Trace/Span 模型以便排查与性能统计，前端面向小白用户做高度脱敏与拟人化汇总。
* **真实链接**：https://langfuse.com ； https://agentops.ai ； https://phoenix.arize.com

---

## 二、 关键关注点在本项目（Windows Flutter 桌面 Agent）的架构设计落地

结合上述 18 个项目的成熟机制，针对本项目的六大核心设计点提出具体机制方案：

### 1. 「书桌」工作区与资料组织
* **三层组织结构**：
  * **书桌工作台（Desk）**：当前活跃工作区，平铺展示：【用户原始资料】、【写笺区（Scratchpad）】、【活跃任务卡】、【产物托盘】。
  * **写笺机制（Memo / Scratchpad）**：借鉴 Notion 与 NotebookLM。输入即自动保存，纯本地 SQLite 存储；点击卡片底部「交给 Agent」按钮，唤起派发弹层（可选：带入哪些书桌资料、选择任务模式），一键将写笺升格为「任务卡」，原写笺保留引用并标记“已派发”。
  * **海量资料索引与按需读取**：借鉴 AnythingLLM 与 NotebookLM。
    * 导入支持：拖拽文件/文件夹、剪贴板自动识别、网页 URL 输入后后台无头浏览器（Puppeteer/Fetch）抓取为 Markdown。
    * 目录地图（Catalog Map）：资料导入后，离线生成两级摘要：**L1 文件级 100 字摘要与元数据**，**L2 章节级切片（Chunks）**。Agent 在规划阶段只读轻量的 Catalog Map，确定需要哪几页，再精准按需读取对应 Chunks，极大节约上下文。

### 2. 产物展示、版本与检查点（Checkpoints）
* **双栏/抽屉预览**：主界面参考 Claude Artifacts 与 LobeChat，右侧为可折叠「产物面板」。支持 Flutter 原生 Markdown 渲染、WebView 代码/HTML 原型预览、CSV/Excel 简易网格、PDF 预览。
* **文件快照与解耦回滚机制**：完全借鉴 **Cline 的 Shadow Checkpoints**。
  * 任务启动时，在本地 `.desk_snapshots/<task_id>/` 创建专用 Git 轻量分支或版本快照树。
  * 产物卡片上提供明确的两级回退：
    1. **「仅恢复此版本文件」**：磁盘覆盖回该检查点，但保留对话历史，用户可继续对话让 Agent 基于历史重试；
    2. **「连同任务进度一同回退」**：把执行流截断至该状态，丢弃后续对话与步骤。

### 3. 卡片系统的状态流与信息结构
* **信息模型（Card State Model）**：
  ```
  TaskCard {
    id: UUID,
    title: String,
    origin_memo_id: Option<UUID>, // 关联的原写笺
    attached_sources: List<SourceRef>, // 关联资料
    status: Pending | Running | AwaitingApproval | Success | Failed,
    steps: List<TaskStep>, // 历史步骤
    current_action: String, // 最新正在做的事
    artifacts: List<ArtifactRef>, // 生成的产物文件指针
    metrics: { duration_ms: Int, token_usage: Int, cost_estimate: Double }
  }
  ```
* **历史状态 vs 最新状态的展示**：
  * **流式历史卡片**：留在聊天消息流中的卡片保留**当时的快照**（如“审批卡：用户已于 14:02 点击允许”、“步骤卡：已完成资料搜索”）；
  * **书桌全局状态栏**：书桌顶部或右侧常驻一个悬浮或固定的“任务看板”，始终显示当前全局最新状态；点击流式卡片中的任何历史节点，可在看板中查看当时的上下文快照。

### 4. 执行轨迹（Trace）的非技术化可视呈现
* **底层数据结构**：采用类似 Langfuse 的精简模型（`Trace` -> `Span` -> `Event`），记录工具名、耗时、用量、报错堆栈。
* **前端展示降噪法则**：
  * **默认状态（自然语言动态折叠）**：
    * 运行态：`[转动图标] 正在整理第 2 份财务报表 (耗时 4s)...`
    * 遇到工具：`[图标] 正在通过浏览器查询汇率...`
    * 完成态：`[折叠面板: 共执行 4 个步骤 · 耗时 12s · 消耗 1,450 字符额度]`
  * **专家视图（Developer Mode）**：普通用户无需接触；仅当点击卡片右上角“查看详情/排错”时，才滑出类似 Agent Zero 的终端式调用明细与原始 JSON。

### 5. 工具与外部连接方案
* **MCP 客户端管理（UI 方案）**：
  * 完全参考 **Cherry Studio**：提供纯图形化设置中心。内置常用预设（网页搜索、本地文件读写、网页抓取）；允许用户填表单添加外部 Stdio（如 `npx -y @modelcontextprotocol/server-xxx`）或远程 SSE 服务；提供状态绿灯与单工具启停开关。
* **浏览器与网络操作**：
  * 集成轻量 Playwright/CDP 驱动或 headless 浏览器。在 Flutter 界面提供一个小窗模式，Agent 抓取网页遇到反爬验证码时，支持弹窗让用户手动点选协助。
* **三级权限控制模型（安全边界）**：
  1. **Safe（只读类）**：如文件读取、网络检索、本地写笺读取，默认静默执行。
  2. **Caution（文件变更）**：如创建新文件、覆盖已有产物。在任务卡中展示 Diff 预览，首次修改弹窗确认，可勾选“本次任务中信任”。
  3. **Dangerous（系统命令与外发通知）**：如执行 Shell/CMD 脚本、发送邮件、向外部 IM 发送数据。必须强制弹出确认卡，非技术用户点击“允许”后方可继续。
* **多渠道通知网关（IM 联动）**：
  * 借鉴 **OpenClaw 与 Hermes Agent**：利用 Windows 本地托盘与 Toast 弹框作为主通知；同时支持配置 Telegram Bot API 或飞书 Webhook。当长任务在后台执行完成，或遇到 Dangerous 操作被暂停时，推送消息到用户手机 Telegram/飞书，并带上审批按钮。

### 6. 面向非技术用户的易用性规范
* **术语全面脱敏**：
  * 不使用 `Token`，改用 `文字处理量 / 额度`；
  * 不使用 `RAG / Embedding`，改用 `参考资料库 / 资料已收录`；
  * 不使用 `Trace / Span`，改用 `执行步骤清单`；
  * 不出现裸 Python/Shell 报错，翻译为友好提示（如“找不到指定文件，正在尝试重试”）。
* **一键预设行动模板**：
  * 在写笺“交给 Agent”的弹出框中，提供高频行动 Chip 胶囊：【整理成总结】、【核对材料错误】、【转换成报告】、【提炼关键代办】，让小白无需手写复杂的 Prompt。

---

## 三、 功能汇总对比与推荐选型表

| 核心功能点 | 典型参考项目 | 桌面 Agent 价值 | 实现复杂度 | 落地推荐做法 |
| :--- | :--- | :--- | :--- | :--- |
| **独立双栏产物面板 (Artifacts)** | Claude, ChatGPT Canvas, LobeChat | **极高** | 中 | 在 Flutter 采用 Split-view 双栏，左侧对话/书桌，右侧产物预览（Markdown、代码、HTML、表格、图片）。 |
| **文件独立快照与检查点 (Checkpoints)** | Cline, Cursor | **极高** | 中 | 采用本地轻量 Git 机制建立任务影子版本，界面提供「仅恢复文件」与「连同对话一同恢复」两个独立选项。 |
| **写笺一键转任务 (Scratchpad to Task)** | NotebookLM, Notion AI, Mem.ai | **高** | 低 | 便笺默认仅本地自动保存；卡片右上角置「交给 Agent」，点击附带上下文生成独立任务卡。 |
| **资料目录地图 (Catalog Map) 按需读取** | NotebookLM, AnythingLLM | **极高** | 中 | 文件导入后后台异步生成一级轻量目录地图，Agent 规划时仅读取目录地图，再精准读取具体段落，避免上下文爆炸。 |
| **任务卡三态与历史/最新视图解耦** | Manus, OpenHands, Agent Zero | **高** | 中 | 消息流中保留带时间戳的操作快照卡；右侧/顶部常驻“当前最新任务状态看板”，双向锚点跳转。 |
| **Trace 简易时间轴折叠** | Langfuse, AgentOps, Arize Phoenix | **高** | 低 | 底层按 Trace/Span 存储，UI 默认仅展示简短拟人化动作动词，折叠显示耗时与用量，提供“开发者模式”展开原始 JSON。 |
| **图形化 MCP 管理面板** | Cherry Studio, Cursor MCP | **极高** | 中 | 严禁让用户手写 JSON，使用 Flutter 表单录入命令与环境变量，提供连通性指示灯和单个 Tool 开关。 |
| **操作权限三级拦截机制** | Open Interpreter, Claude Desktop | **极高** | 低 | 只读操作静默放行；写文件展示 Diff 并支持单次/全局授权；Shell/网络外发强制弹窗阻断确认。 |
| **多渠道 IM 通知与审批中继** | OpenClaw, Hermes Agent | **中** | 中 | 优先保证 Windows 原生 Toast 通知；可选提供 Telegram/飞书 Webhook 绑定，长任务完成后或等待审批时手机端推送。 |
| **浏览器自动化操作与视觉可见** | OpenHands, Manus | **中** | 高 | 初期采用无头浏览器（Fetch/Puppeteer）抓取静态 DOM 为 Markdown；二期再引入 CDP 串流与人工干预接管。 |
