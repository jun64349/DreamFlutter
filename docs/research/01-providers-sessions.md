本报告针对基于 **Pi coding agent**（`@earendil-works/pi-coding-agent`）作为 Agent 运行时、**Flutter** 构建界面的 Windows 桌面个人 AI Agent，对业界 17 个标杆开源与主流项目在**「模型供应商管理」**与**「会话管理」**两方面的机制设计进行深度调研。

---

## 一、业界标杆项目调研

### 1. Pi coding agent (`@earendil-works/pi-coding-agent`)
* **定位**：极简、高度可扩展且模型无关的开源终端 Coding Agent 运行时（由 Mario Zechner 发起，Earendil 维护）。
* **功能清单**：
  * **A. 模型供应商**：预置 15+ 供应商（Anthropic, OpenAI, Gemini, Bedrock, Groq, Mistral, Ollama 等）；支持 `models.json` 配置自定义兼容端点；`auth.json` 存储凭证；`/login` 命令行授权；无多 Key 轮换；无图形化测试连接；无自动拉取模型列表；通过 `models.json` 声明模型能力元数据（上下文大小、最大输出、计费）；支持温度、思考预算（Thinking Budget）等参数；无自动 Failover；单轮与累计 Token 统计；支持 Ollama 本地模型；支持 OAuth 登录（如 Google/Claude 等凭证注入）。
  * **B. 会话管理**：底层为 **JSONL 树状图（Tree-structured history）**；支持从任意节点开辟新分支；支持会话恢复；支持会话导出与分享（如 Hugging Face 共享）；无原生 GUI 分组/标签/回收站（单文件平铺）；无内置全文检索；无跨会话直接引用。
* **值得借鉴的机制**：
  1. **天然的树状 JSONL 会话模型**：每个节点包含 `id`、`parentId`、`role` 与工具执行上下文。分叉时不复制全量历史，仅将新节点 `parentId` 指向旧节点，非常契合 Flutter 用树状图组件进行多分支可视化。
  2. **`auth.json` 与 `models.json` 严格解耦**：凭证管理（鉴权）与模型定义（端点、能力、限制）分离，切换/修改模型无需重复配置 API Key。
* **官方链接**：[GitHub earendil-works/pi](https://github.com/earendil-works/pi) | [官方文档 pi.dev](https://pi.dev)

---

### 2. Cherry Studio
* **定位**：面向桌面端的多模型聚合调用与并发对比客户端（Electron/Vue）。
* **功能清单**：
  * **A. 模型供应商**：预置 30+ 厂商（主流商业及国内大模型全覆盖）；自定义 OpenAI/Anthropic 兼容端点；API Key 本地安全存储；「测试连接」按钮；自动从供应商拉取模型列表；完整能力标签（Vision, Tool, Search, Reasoning, Context Window）；按模型调整 Temperature/Top_P 等；未查到自动 Failover；提供 Token 用量概览；原生检测并直连 Ollama / LM Studio。
  * **B. 会话管理**：关键词搜索；文件夹与助手分组；置顶；导出 Markdown/JSON/图片；后台小模型自动生成标题；编辑历史消息并重跑；**多模型同屏并行对话（Multi-model Chat）**；单会话可覆盖助手设定；无树状分支图；批量删除；无回收站。
* **值得借鉴的机制**：
  1. **模型元数据自动推断与正则解析**：自动拉取模型列表后，通过规则库与模型名关键字（如包含 `vision`、`claude-3-7` 等）自动补齐识图、工具、深度思考能力标签。
  2. **多模型广播分流**：单输入框同时发往多个模型，分栏并行渲染流式回复，便于对比不同模型在代码与逻辑上的差异。
* **官方链接**：[GitHub CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio) | [官网 cherryai.com](https://cherryai.com)

---

### 3. LobeChat / LobeHub
* **定位**：现代化高颜值的开源 AI Agent 工作台与多模态交互框架（Next.js / PWA / Tauri 桌面版）。
* **功能清单**：
  * **A. 模型供应商**：数十家预置供应商；自定义兼容端点；客户端 AES 加密存储 Key；连通性探测测试；API 动态抓取模型列表；**精细化模型元数据卡片（输入/输出/缓存单价、上下文上限、视觉/工具/思考深度）**；模型级高级参数微调；依赖外部网关实现多 Key 与 Failover（客户端无原生自动切换）；Token 与费用实时监控；内置 Ollama 服务发现；支持 NextAuth/Clerk 等登录。
  * **B. 会话管理**：IndexedDB 全文搜索；助手（Agent）与话题（Topic）双层架构；会话置顶与归档；JSON/Markdown 导入导出；小模型后台静默生成标题；**双模式分支会话（延续上下文模式 / 独立话题模式）**并在侧栏树状导航；支持编辑历史节点；会话级自定义 System Prompt 与工具绑定；会话 Token 审计；批量删除。
* **值得借鉴的机制**：
  1. **标准化的 `modelCard` 元数据体系**：以结构化 JSON 定义模型计费（按 1M tokens 计费）、最大上下文及能力位，前端在交互时可做超长上下文预警和精确记账。
  2. **Topics + Branches 协同结构**：在同一个 Agent 下维护若干个独立 Topic，每个 Topic 内若探讨偏离，可一键将其“分支化（Fork）”，有效防止上下文膨胀。
* **官方链接**：[GitHub lobehub/lobe-chat](https://github.com/lobehub/lobe-chat) | [官网 lobehub.com](https://lobehub.com)

---

### 4. Open WebUI
* **定位**：功能强大的自托管 Web UI 与 Agent 生态系统（兼容各类本地与云端模型）。
* **功能清单**：
  * **A. 模型供应商**：深度绑定 Ollama + 无限自定义 OpenAI 兼容端点（可独立注入自定义 Headers）；后端数据库加密保存 Key；模型列表秒级同步；Pipelines 插件机制；**支持模型路由与 Fallback（主模型宕机自动切换备选）**；模型级 System Prompt 与超参覆盖；系统级用量与审计日志；OAuth2/OIDC 单点登录。
  * **B. 会话管理**：基于 SQLite FTS 的全文搜索；标签（Tags）与文件夹管理；会话置顶与归档；JSON 导入导出；自动标题与自动打 Tag；**消息级版本翻页器（`< 1/3 >`）分支机制**；从任一消息编辑分支；会话级知识库/Prompt 挂载；批量删除；软删除机制（通过数据库字段控制）。
* **值得借鉴的机制**：
  1. **消息节点的“变体树”翻页机制**：重新生成或修改提问后，旧回答不覆盖，生成兄弟节点，UI 呈现紧凑的 `< 1/N >` 翻页器，既保持线性易读性，又保留了底层完整的树状分支。
  2. **端点级 Headers 动态注入**：针对各类第三方中转或企业私有网关，允许在端点层配置自定义 Header（如认证头、路由标签），大幅提升兼容性。
* **官方链接**：[GitHub open-webui/open-webui](https://github.com/open-webui/open-webui) | [文档 docs.openwebui.com](https://docs.openwebui.com)

---

### 5. LibreChat
* **定位**：企业级全功能开源 ChatGPT 替代方案，支持多端点、多用户与 Agent 编排。
* **功能清单**：
  * **A. 模型供应商**：预置各大模型供应商；通过 `librechat.yaml` 灵活定义自定义端点；**AES-256-CBC 强加密存储 Key**；**原生支持多 Key 轮换（Round-Robin 负载均衡）**；动态拉取模型列表；Model Specs 声明元数据；**原生支持配置 Fallback 备用模型链**；Token 计数器与额度配额体系；OAuth/SAML/OIDC 支持。
  * **B. 会话管理**：Meilisearch / MongoDB 全文检索；按模型/预设筛选；**完整分支树导航与多版本切换**；**从任意消息“分叉会话（Fork Conversation）”至新窗口**；导出 JSON/CSV/Markdown；自动生成标题；编辑历史重跑；会话级参数独立；批量操作；软删除。
* **值得借鉴的机制**：
  1. **声明式 Multi-Key 轮询与 Fallback 链**：在配置中支持逗号分隔多个 Key 自动做请求级轮询；在 `modelSpecs` 中可配置 `fallback: ["claude-3-5-haiku", "gpt-4o-mini"]`，遭遇 429、500 时无缝重试备用模型。
  2. **Fork 会话脱离主线**：不仅可在单流内切分支，还支持将某分支直接生成一个全新会话线索，保留当时的上下文快照。
* **官方链接**：[GitHub danny-avila/LibreChat](https://github.com/danny-avila/LibreChat) | [官网 librechat.ai](https://www.librechat.ai)

---

### 6. Jan (jan.ai)
* **定位**：以本地隐私优先的开源 AI 桌面客户端（Electron + 跨平台 C++ Cortex 引擎）。
* **功能清单**：
  * **A. 模型供应商**：集成 Cortex 推理引擎（直接运行 GGUF 本地模型）；支持主流远端供应商与自定义兼容端点；**API Key 存储在系统钥匙串（OS Keychain/Keyring）**；支持测试连接；支持按模型设置温度、Top_P、Max Tokens、Context Length；未查到多 Key 与自动 Failover；会话底部实时展示推理速度（TPS）与消耗 Token；无 OAuth 订阅登录。
  * **B. 会话管理**：底层为每个 Thread 单独存为 JSON/SQLite；会话全文搜索；编辑历史重跑；单会话参数面板（临时调整 Temperature 与截断长度）；导出 JSON/Markdown；批量清理；未查到分支树浏览与回收站。
* **值得借鉴的机制**：
  1. **硬件感知与显存保护**：在 Windows 端自动探查 GPU 显存（VRAM），在模型元数据和设置界面直接标注是否会爆显存。
  2. **会话级上下文滑块实时覆盖**：无需修改全局模型参数，在右侧侧边栏即可动态拉动滑动窗口大小，降低突发任务的开销。
* **官方链接**：[GitHub janhq/jan](https://github.com/janhq/jan) | [官网 jan.ai](https://jan.ai)

---

### 7. Chatbox
* **定位**：轻量、跨平台（桌面+移动）、强调隐私与数据安全的 AI 客户端。
* **功能清单**：
  * **A. 模型供应商**：主流供应商预置；支持自定义反代域名与端点；**支持本地数据库 SQLCipher 加密（用户自主设置主密码）**；提供测试连接；支持从 OpenAI 兼容接口拉取模型列表；按模型配置温度与最大 Token；未查到多 Key 轮换与 Failover；简单的 Token 统计；支持 Ollama。
  * **B. 会话管理**：关键词检索；文件夹与标签分类；会话置顶；导出 Markdown/PDF/图片；自动生成标题；编辑消息重跑；单会话独立绑定 Prompt 角色；无树状分支图；批量删除；无回收站。
* **值得借鉴的机制**：
  1. **主密码级端到端加密（SQLCipher）**：将 API Key、会话历史全量通过用户主密码派生的密钥落盘加密，防止 Windows 本地其他恶意软件窃取凭据。
  2. **轻量级历史上下文条数截断**：允许用户直观设置“发送历史消息条数”，简单直接地控制长会话的花费。
* **官方链接**：[GitHub Bin-Huang/chatbox](https://github.com/Bin-Huang/chatbox) | [官网 chatboxai.app](https://chatboxai.app)

---

### 8. AnythingLLM
* **定位**：全功能桌面与企业级 RAG 知识库与工作区 Agent 应用。
* **功能清单**：
  * **A. 模型供应商**：内置本地推理与向量引擎；支持主流商用与自定义兼容端点；API Key 本地加密保存；测试连接；动态读取模型列表；按工作区配置模型参数；无原生自动 Failover；完整调用监控日志；无 OAuth 订阅登录。
  * **B. 会话管理**：**以 Workspace（工作区）为核心的多线程会话**；每个工作区独立绑定知识库、System Prompt、默认 LLM 以及下属 Threads；置顶工作区；导出聊天记录；无分支树；批量清空。
* **值得借鉴的机制**：
  1. **工作区隔离模型**：将 Agent 运行时所需的系统提示词、代码库向量索引、所选模型及一组会话线程统一收拢在 Workspace 边界内，极适合开发者按项目分工。
* **官方链接**：[GitHub Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm) | [官网 anythingllm.com](https://anythingllm.com)

---

### 9. Msty (msty.app)
* **定位**：主打离线优先、多模型对比与精细提示词工作流的高效桌面 AI 客户端（闭源免费）。
* **功能清单**：
  * **A. 模型供应商**：内置 llama.cpp 本地运行 + 远端主流服务商；支持自定义端点；本地加密存储 Key；测试连接；支持按模型设置系统提示、思考预算与参数；无多 Key 轮换与自动 Failover；提供详尽的 Token 消耗监控看板。
  * **B. 会话管理**：文件夹、标签（Tags）与全文检索；置顶与归档；**双模型并排对比（Side-by-side split chat）**；支持从任意节点开辟新分支；导出 JSON/Markdown；**Prompt Shelf（提示词暂存抽屉）**可在会话间快速插入片段。
* **值得借鉴的机制**：
  1. **Prompt Shelf（便签抽屉）**：在会话右侧提供常驻的 Prompt / 代码片段便签，可随时拖入当前会话输入框，免去在外部文档来回复制。
  2. **Split-View 双分支并排展示**：支持将两个分支或不同模型对同一提示的回答并排对齐展开，而不是单一线性切换。
* **官方链接**：[官网 msty.app](https://msty.app) | [文档 docs.msty.app](https://docs.msty.app)（注：核心客户端非开源）

---

### 10. OpenCode (`anomalyco/opencode`，原 `sst/opencode`)
* **定位**：面向终端与桌面端、以开发者为中心的开源 AI Coding Agent。
* **功能清单**：
  * **A. 模型供应商**：通过 `opencode.jsonc` 声明供应商与端点；`/connect` 交互式录入 Key；支持定义模型别名；**双模型路由配置（`model` 主模型 + `small_model` 辅助小模型）**；模型变体机制（`#variant` 设定推理强度）；无自动 Failover；终端实时输出单次与累计 Token；无 OAuth 订阅登录。
  * **B. 会话管理**：多并行任务支持；**基于 Git 的快照（Snapshot）撤销系统**；会话恢复与历史回溯；Agent 双模式（`build` 写代码 vs `plan` 只读规划）；无图形化分支树。
* **值得借鉴的机制**：
  1. **`small_model` 与 `model` 双轨分工机制**：在配置中显式区分辅助任务（生成标题、规划摘要、代码解释）和核心代码生成，极大节约主模型 Token 和延迟。
  2. **会话步骤与 Git 快照强绑定**：每次 Agent 动作自动生成 Shadow Commit，回退会话历史时自动同步恢复代码树，保证上下文与真实文件系统一致。
* **官方链接**：[GitHub anomalyco/opencode](https://github.com/anomalyco/opencode) | [官网 opencode.ai](https://opencode.ai)

---

### 11. Claude Code
* **定位**：Anthropic 官方推出的终端自治 Agentic 编程助手。
* **功能清单**：
  * **A. 模型供应商**：直连 Anthropic 官方、AWS Bedrock 或 GCP Vertex；**原生支持 OAuth 订阅登录（`claude login` 浏览器授权）**，也支持环境变量 Key；Key 保存在系统钥匙串；支持 `--thinking` 设定思考预算；单供应商无自动 Failover；高精度的每轮与累计美元费用核算。
  * **B. 会话管理**：以项目目录为单位维护上下文；**主动上下文压缩（`/compact`）**；`claude --resume` 断点恢复会话；`/cost` 查询费用；无图形化树状分支。
* **值得借鉴的机制**：
  1. **主动上下文压缩（Active Compaction）**：长会话触发窗口上限时，模型自动执行状态归纳，将旧工具调用和长输出提炼成包含已改代码、残留 Bug、未完 Todo 的高密度 Prompt，替换掉早期历史。
  2. **原生 OAuth 订阅复用**：让个人开发者直接复用已付费的 Claude Pro/Team 订阅，无需额外走预付费 API 充值。
* **官方链接**：[官方文档 docs.anthropic.com/claude-code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code)

---

### 12. OpenAI Codex CLI (`@openai/codex`)
* **定位**：OpenAI 官方推出的轻量级终端 Coding Agent。
* **功能清单**：
  * **A. 模型供应商**：直连 OpenAI 模型库（GPT-4o, o-series 等）；**支持 ChatGPT 网页版账号 OAuth 登录或 API Key**；凭据保存在本地安全配置；支持指定推理强度（Reasoning effort: low/medium/high）；参数控制最大输出；单供应商无自动切换；支持 MCP 扩展；实时 Token 统计。
  * **B. 会话管理**：以项目目录为作用域；交互式 TUI 与批处理 `exec` 模式；任务中断后恢复；代码 Diff 分步审核与批准流水线；无图形化分支树。
* **值得借鉴的机制**：
  1. **会话与沙盒审批态解耦**：每个会话节点完整记录了 Shell 命令、执行退出码及用户的 Approval 状态，会话不仅是文本，更是完整的执行审计追踪。
* **官方链接**：[官方入口 chatgpt.com/codex](https://chatgpt.com/codex) | [npm @openai/codex](https://www.npmjs.com/package/@openai/codex)

---

### 13. Goose (`block/goose`)
* **定位**：Block（原 Square）开源的高性能、自主可扩展开发者 Agent（Rust 核心 + CLI + Electron 桌面版）。
* **功能清单**：
  * **A. 模型供应商**：预置 Databricks, OpenAI, Anthropic, Gemini, Ollama, OpenRouter 等；自定义兼容端点；**API Key 采用系统原生钥匙串存储（通过 Rust `keyring` 接入 Windows Credential Locker）**；支持测试连接；支持设置上下文窗口；内置 MCP 客户端扩展；无 OAuth 订阅登录。
  * **B. 会话管理**：**会话持久化在 SQLite 数据库（`sessions.db`）**；CLI 支持 `goose session list` 与 `resume`；桌面端提供历史抽屉；导出 Markdown/JSON；会话与已激活的 MCP 服务器上下文绑定；删除与清理。
* **值得借鉴的机制**：
  1. **Windows 原生 Credential Locker 集成**：桌面端彻底摒弃明文 JSON 或简单 Base64，调用 Windows 凭据管理器，具备最严格的安全合规性。
  2. **会话环境快照（Session MCP Environment）**：恢复会话时，不仅拉取问答历史，还恢复当时挂载的 MCP 工具集与子环境参数。
* **官方链接**：[GitHub block/goose](https://github.com/block/goose) | [官方文档 block.github.io/goose](https://block.github.io/goose/)

---

### 14. Cline / Roo Code
* **定位**：广泛使用的 VS Code 自治 Coding Agent 扩展（Roo Code 为增强分支）。
* **功能清单**：
  * **A. 模型供应商**：预置 10+ 供应商（Anthropic, OpenRouter, OpenAI, Bedrock, Vertex, Ollama, LM Studio, DeepSeek 等）；自定义端点；**Key 存储于 VS Code `SecretStorage`（底层为 OS 钥匙串）**；内置连通性校验；OpenRouter 模型列表与动态定价抓取；支持 Thinking Budget、Temperature 等参数；动态上下文滑动窗口与 Token 计数；任务单次与累计花费展示。
  * **B. 会话管理**：以“任务（Task）”组织会话；**基于 Git Shadow Repo 的检查点系统（Checkpoints）**，支持一键对比代码 Diff 并回滚任务状态；任务历史列表与搜索；导出/导入 JSON；模式切换（Code, Architect, Ask，各自独立 System Prompt）；无分支树。
* **值得借鉴的机制**：
  1. **Git Shadow Checkpoint 机制**：每次关键文件改动前生成 Shadow Commit，用户可在 UI 点击任意历史轮次对比 Diff 并“一键回退到此处”，会话与真实代码同时回滚。
  2. **上下文容量透视条（Context Window Meter）**：以百分比进度条直观展示当前会话占用的模型上下文窗口（包含 Cache Read、Cache Write、剩余可用），帮助用户准确决定何时开辟新任务。
* **官方链接**：[GitHub cline/cline](https://github.com/cline/cline) | [GitHub RooVetGit/Roo-Code](https://github.com/RooVetGit/Roo-Code)

---

### 15. Continue
* **定位**：开源模块化 IDE AI 辅助扩展（支持 VS Code 与 JetBrains，代码补全与侧栏 Agent 对话）。
* **功能清单**：
  * **A. 模型供应商**：通过 `config.yaml` 集中配置；覆盖各大商用与本地模型（Ollama, LM Studio）；自定义端点；Key 支持环境变量或安全存储；无内置动态多 Key 轮换；支持针对不同角色（Chat, Autocomplete, Embeddings, Rerank）独立指定模型与参数；无自动 Failover。
  * **B. 会话管理**：侧栏历史会话列表；导出 Markdown；**跨资源与上下文引用机制（`@Files`, `@Codebase`, `@Docs`, `@Terminal`, `@GitDiff`）**；编辑历史重跑；无复杂分支树与回收站。
* **值得借鉴的机制**：
  1. **模型角色化路由（Role-based Models）**：将模型按职能解耦配置，如对话用 Claude 3.7，代码补全用本地 DeepSeek，文档嵌入用小型向量模型，物尽其用。
  2. **`@` Context Provider 统一抽象**：在输入框内使用统一的 `@` 协议将文件、Git 差异、终端输出甚至其他会话摘要按需挂载为当前会话上下文。
* **官方链接**：[GitHub continuedev/continue](https://github.com/continuedev/continue) | [官网 continue.dev](https://continue.dev)

---

### 16. OpenClaw (`openclaw/openclaw`)
* **定位**：面向全自主系统执行、打通多通讯协议（IM+终端）的开源个人 Agent。
* **功能清单**：
  * **A. 模型供应商**：`models.providers` 声明端点；**原生声明式多级故障切换（`agents.defaults.model.primary` + `fallbacks: [...]`）**；Key 环境变量存储；模型级权限隔离；无 OAuth 订阅登录。
  * **B. 会话管理**：`sessions.json` 多渠道持久化；**子会话派生（`sessions_spawn` 派生后台子 Agent）**；会话参数动态打补丁（`sessions.patch`）；多端共享会话；归档与重置。
* **值得借鉴的机制**：
  1. **声明式 Fallback 路由机制**：在主模型遇到 Rate Limit（429）或网络超时时，系统按顺序自动降级尝试 fallback 列表中的备用模型，长时间后台运行任务不会死锁。
  2. **Sub-agent 会话派生（Spawn Session）**：对耗时较长、上下文极多的子任务（如全仓库代码审查）新开派生会话执行，只将最终结果回传主会话，防止主会话被噪声淹没。
* **官方链接**：[GitHub openclaw/openclaw](https://github.com/openclaw/openclaw) | [官网 openclaw.ai](https://openclaw.ai)

---

### 17. Hermes Agent (`NousResearch/hermes-agent`)
* **定位**：Nous Research 开源的自主成长型、具备跨会话技能提取与自我改进能力的 Agent。
* **功能清单**：
  * **A. 模型供应商**：专为 Hermes 系列微调模型优化，兼容 OpenAI/Anthropic/vLLM 端点；YAML 声明；Key 存储在配置文件/环境变量；支持函数调用定义；无多 Key 轮换与自动 Failover。
  * **B. 会话管理**：**跨会话长期记忆与技能提取机制**（`~/.hermes/memories/` 下的 `MEMORY.md` 与 `USER.md`）；**内置 SQLite FTS5 全文搜索**；可插拔 Memory Provider（具有生命周期钩子）；会话结束后自动提炼技能；无 GUI 分支树。
* **值得借鉴的机制**：
  1. **`MemoryProvider` 会话生命周期钩子**：定义了 `prefetch`、`sync_turn`、`on_session_end` 接口，在会话每轮及结束时异步提取用户画像与技能沉淀，让新会话天然具备“跨会话记忆”。
  2. **本地文件 + SQLite FTS5 混合检索**：通过极轻量的纯本地方案实现会话历史的高性能全文搜索与上下文按需检索。
* **官方链接**：[GitHub NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)

---

## 二、全面功能对比与架构落地汇总表

> **说明**：
> * **项目代号简写**：Pi（Pi coding agent）、Cherry（Cherry Studio）、Lobe（LobeChat）、OWeb（Open WebUI）、Libre（LibreChat）、Jan（Jan）、Box（Chatbox）、Any（AnythingLLM）、Msty（Msty）、OCode（OpenCode）、Claude（Claude Code）、Codex（OpenAI Codex CLI）、Goose（Goose）、Cline（Cline/Roo Code）、Cont（Continue）、Claw（OpenClaw）、Hermes（Hermes Agent）。
> * **价值评估**：基于“Flutter 桌面端 + Pi Agent 运行时”的核心场景设定。

### 维度 A：模型供应商管理

| 功能点 | 哪些项目具备完整机制 | 对基于 Pi 的桌面 Agent 价值 | 实现复杂度 | 机制与架构落地备注 |
| :--- | :--- | :---: | :---: | :--- |
| **1. 预置供应商列表** | Cherry, Lobe, Libre, Jan, Box, Any, Msty, Goose, Cline, Cont, Pi | **高** | **低** | 内置知名厂商的基础 URL、默认模型与 API 格式规范（OpenAI / Anthropic / Gemini），减少用户手输配置的门槛。 |
| **2. 自定义兼容端点** | 全体项目均支持 | **高** | **低** | 必备基础项。需允许用户自由输入 Base URL、自定义 Headers（Open WebUI 做法），以兼容 OneAPI、NewAPI 及自建网关。 |
| **3. API Key 安全存储** | Goose, Jan, Cline, Claude（系统钥匙串）；Chatbox, Libre, Lobe（强加密）；其他（明文配置文件） | **高** | **中** | Windows 桌面端严禁明文裸奔。建议 Flutter 层通过 `flutter_secure_storage` 接入 Windows **Credential Locker**，或由 SQLite/SQLCipher 本地加密存储。 |
| **4. 多 Key 轮换与负载均衡** | LibreChat（原生 Round-Robin 支持）；Cherry（社区方案） | **中** | **中** | 高频 Coding Agent 易撞 Rate Limit。可在 Flutter 客户端或本地代理层实现简单轮询（Round-Robin）与错误退避机制。 |
| **5. 「测试连接」功能** | Cherry, Lobe, OWeb, Jan, Box, Any, Msty, Goose, Cline | **高** | **低** | 发送极小请求（如 `max_tokens=1` 或获取 `/models` 列表），验证 API Key 与 Base URL 的有效性，提升初始配置体验。 |
| **6. 自动拉取模型列表** | Cherry, Lobe, OWeb, Libre, Any, Cline | **中** | **低** | 请求 `/v1/models` 端点拉取并填充下拉框。需结合正则表达式与黑名单过滤无关的 Embedding/TTS 杂质模型。 |
| **7. 模型能力元数据标注** | Lobe（最详尽）、Cherry, OWeb, Libre, Cline, Pi (`models.json`) | **高** | **中** | Agent 必需项。必须标注：**上下文窗口大小**（用于截断）、**是否支持 Tools**（用于调用 Pi 工具）、**思考强度支持**与**单价**。 |
| **8. 按模型独立参数定制** | 全体项目均具备不同程度支持 | **高** | **低** | 为每个模型持久化默认 `temperature`、`max_tokens` 及 `thinking_budget`（针对 Claude 3.7 / o-series / DeepSeek R1）。 |
| **9. 故障切换 / 备用模型 (Failover)** | OpenClaw, LibreChat, Open WebUI | **高** | **中** | Coding Agent 处理长任务极易遭遇 429。在 Pi 的 Agent 循环或外围代理层配置 `fallbacks: [backup_model_1, ...]`，失败时无缝切换重试。 |
| **10. 用量与花费统计** | Lobe, Libre, Claude, Cline, Cherry, Jan, OCode, Pi | **高** | **中** | 按会话/按模型/按天汇总 Token（Input/Output/Cache）。结合模型元数据单价换算成法币（USD/CNY），直观展现开发成本。 |
| **11. 本地模型直连支持** | Jan, AnythingLLM, Msty（内置引擎）；Cherry, Lobe, OWeb, Goose, Cline, Cont, Pi（直连 Ollama/LM Studio） | **高** | **低** | 本地代码隐私与轻量分析刚需。直接扫描并直连 Windows 本地 `localhost:11434`（Ollama）或 `localhost:1234`（LM Studio）。 |
| **12. OAuth 订阅登录复用** | Claude Code, OpenAI Codex CLI, Lobe (Web OAuth) | **高** | **高** | 个人用户的强烈痛点（免去 API 充值，复用 Claude/ChatGPT 网页订阅）。桌面端需通过本地微型 HTTP 服务接管 OAuth 回调。 |

---

### 维度 B：会话管理

| 功能点 | 哪些项目具备完整机制 | 对基于 Pi 的桌面 Agent 价值 | 实现复杂度 | 机制与架构落地备注 |
| :--- | :--- | :---: | :---: | :--- |
| **1. 全文搜索** | Lobe, OWeb, Libre, Jan, Box, Msty, Hermes | **高** | **中** | Windows 桌面端建议在 Flutter 端使用本地 **SQLite FTS5** 对会话标题与消息正文建倒排索引，秒级搜索历史代码与问答。 |
| **2. 分组 / 文件夹 / 标签** | Cherry, Lobe, OWeb, Box, Msty | **高** | **低** | 树形或平面文件夹分类。开发者通常按“项目/仓库”或“日常助理/代码重构”分类管理会话。 |
| **3. 置顶与归档** | Cherry, Lobe, OWeb, Box, Msty | **中** | **低** | 置顶常用会话（如“日常架构规划”），归档已完成任务，保持侧边栏清爽。 |
| **4. 导入 / 导出 (JSON/MD)** | 全体项目均支持 | **高** | **低** | 必备基础项。支持导出为 Markdown（便于做技术汇报/文档）、JSON（便于会话迁移与备份）。 |
| **5. 自动生成标题** | Cherry, Lobe, OWeb, Libre, Box, Msty | **中** | **低** | 触发第二轮对话后，在后台调用小模型（`small_model`）结合前两条消息生成 6-10 字简要标题，不阻塞前台流式输出。 |
| **6. 会话分支与分支树浏览** | Pi（底层树状）、Lobe, OWeb, Libre, Msty | **极高** | **中** | **杀手级特性**。Pi 底层 JSONL 原生即树状结构，Flutter 端仅需实现树状 UI 或分支切换器，用户可随时探索不同方案。 |
| **7. 消息编辑与重新生成** | 全体项目均支持（除只读 CLI 外） | **高** | **低** | 编辑历史 Prompt 立即生成同级兄弟节点（配合 `< 1/N >` 翻页器），不丢失原回复，形成分支分叉点。 |
| **8. 跨会话引用 / 长期记忆** | Continue (`@`), Hermes Agent, OpenClaw | **高** | **高** | 参考 Continue 的 `@Session` 或 Hermes 的 `MEMORY.md`。允许新会话输入框以挂载方式吸附旧会话结论或长期沉淀的技能。 |
| **9. 按会话独立配置模型/Prompt** | Lobe, OWeb, Libre, Jan, Box, Any, Msty, OCode | **高** | **低** | 会话元数据持久化该会话特定的 System Prompt、模型覆盖选择和温度，各项目互不干扰。 |
| **10. 会话级用量透视与上下文条** | Cline/Roo Code, Claude Code, Pi | **高** | **低** | 实时在会话顶部显示“上下文窗口占用进度条”，清楚展示当前任务已耗费的上下文长度，提醒用户及时收尾或开新分支。 |
| **11. 批量操作 (删除/归档/移动)** | Cherry, Lobe, OWeb, Libre | **中** | **低** | 侧边栏支持多选复选框，便于一次性清理过期调试会话。 |
| **12. 回收站 / 软删除机制** | Open WebUI（通过逻辑字段/DB） | **中** | **低** | 会话标记 `is_deleted=true` 移入回收站，保留 30 天恢复窗口，防手抖误删关键代码方案。 |
| **13. 代码快照与回滚 (Checkpoint)** | Cline/Roo Code, OpenCode | **极高** | **高** | **Coding Agent 核心护城河**。结合 Git 对每次 Agent 修改执行 Shadow Commit，回退会话节点时自动还原被修改的代码。 |

---

## 三、针对「Flutter + Pi Agent 架构」的核心设计建议

结合上述 17 个项目的精粹机制与你当前的技术栈，建议在架构设计上重点落实以下三项工程决策：

1. **会话层：直接继承 Pi 的原生 JSONL 树，在 Flutter 实现分支导航**
   * **机制落地**：Pi 的核心运行时原生将消息记录为树节点（具有 `id` 与 `parentId`）。Flutter 端无须自行设计复杂的关系数据库来维护分叉，直接以 Pi 的 JSONL 文件为 Single Source of Truth。
   * **UI 交互**：借鉴 **Open WebUI 的 `< 1/N >` 翻页器**（在线性流中展现分支）与 **LobeChat 的侧边栏分支树导航**，让用户既能在对话流中左右切换，也能统览整棵“决策分支树”。

2. **安全与模型层：Windows 凭据集成与声明式 Fallback**
   * **密钥存储**：借鉴 **Goose / Jan** 的做法，Flutter 桌面端使用 Windows 原生 `Credential Locker` 保护 API Key，彻底杜绝明文落盘。
   * **可靠性保障**：借鉴 **LibreChat / OpenClaw** 的声明式 Fallback 机制，在 Flutter 传递给 Pi 的执行参数中传入 `model` 与 `fallbackModels` 数组。当网络超时或遇到 429 限流时，外围循环自动降级重试备选模型，防止长耗时代写代码时断流挂死。

3. **Coding 特性：借鉴 Roo Code / OpenCode 的 Git 影子快照（Checkpoint）**
   * **机制落地**：在调用 Pi Agent 执行批处理代码修改动作前，本地后台自动执行轻量级 `git add -A && git commit -m "shadow: turn_xxx"`。
   * **会话联动**：当用户在 Flutter 界面点击“从此消息重新生成”或“回退到此步骤”时，除截断/切换会话分支外，同步执行 `git reset --hard <shadow_commit_id>`，实现会话历史与工作区物理代码的完全一致性回滚。
