# Windows 桌面个人 AI Agent 记忆、技能与任务模板体系调研报告

本报告针对基于开源 **Pi coding agent** 运行时的 Windows 桌面个人 AI Agent（通用个人助理），重点调研主流与前沿 Agent 系统在**长期记忆、记忆快照、技能沉淀、任务模板**等维度的具体机制，并给出适用于**本地单机、无独立向量数据库服务**前提下的落地方案。

---

## 一、 15 个代表性项目机制深度调研

### 1. Letta（原 MemGPT）
*   **定位**：专为长期有状态（Stateful）Agent 设计的记忆操作系统与运行时。
*   **具体机制**：
    *   **分层记忆架构**：分为 **Core Memory**（常驻上下文的高优先度内存块，如 `human` 用户人设、`persona` Agent 人设、`scratchpad` 暂存区）、**Archival Memory**（无限容量的非结构化长期只读检索库）与 **Recall Memory**（对话原始历史流）。
    *   **工具驱动读写**：Agent 在运行期通过内置工具（`core_memory_append`、`core_memory_replace`、`archival_memory_insert`、`archival_memory_search`）自主维护内部状态。
    *   **Sleep-Time Agents（睡眠整理机制）**：引入后台“潜意识”代理，在主 Agent 处于空闲（Idle）或周期性夜间触发。离线遍历近期对话与暂存记录，执行去重、冗余修剪、矛盾事实合并与归档，降低在线交互时的推理开销与延迟。
*   **值得借鉴的细节**：Memory Blocks（分块命名管理）概念清晰；Core Memory 设硬性字符上限；引入后台 Idle 阶段做记忆固化与整理。
*   **真实链接**：[https://github.com/letta-ai/letta](https://github.com/letta-ai/letta)

### 2. Mem0
*   **定位**：轻量级、开箱即用的多层级通用 AI 记忆层（Universal Memory Layer）。
*   **具体机制**：
    *   **两阶段提取与状态流转（A.U.D.N 引擎）**：当输入新对话后，首先通过 LLM 提取原子化候选事实（Candidate Facts）；随后将候选事实与数据库现有相似条目比对，由 LLM 决定执行 4 种操作之一：
        *   `ADD`：全新事实，分配新 ID 写入；
        *   `UPDATE`：对已有事实的演进或补充（如职业变更、喜好细化），就地更新；
        *   `DELETE`：与已有事实完全相悖或已被废除，直接软/硬删除；
        *   `NOOP`：与现有事实重复或无保留价值，直接丢弃。
    *   **多维度 Scope**：原生支持 `user_id`（全局用户偏好）、`agent_id`（Agent 经验）、`run_id / session_id`（单次会话临时记忆）。
*   **值得借鉴的细节**：将记忆更新解构为确定性的 `ADD / UPDATE / DELETE / NOOP` 状态机，避免无脑追加导致的上下文爆炸与事实矛盾。
*   **真实链接**：[https://github.com/mem0ai/mem0](https://github.com/mem0ai/mem0)

### 3. Zep / Graphiti
*   **定位**：基于**时序知识图谱（Temporal Knowledge Graph）**构建的高性能动态 Agent 记忆引擎。
*   **具体机制**：
    *   **双时间维度建模（Bi-temporal Modeling）**：图谱中的每条关系边（Edge）均标注四个时间戳：`valid_at`（事实在物理世界生效时间）、`invalid_at`（事实失效时间）、`created_at`（系统摄入时间）、`expired_at`（系统判定被推翻时间）。
    *   **非破坏性事实失效（Edge Invalidation）**：当接收到新事实（如“用户从使用 VS Code 改为使用 Cursor”）时，系统不直接删除旧边，而是将其标记 `invalid_at = now()` 并挂接新边。
    *   **时态回溯检索**：既能查询“用户当前喜好”，又能通过时间切片回溯“用户 2025 年 3 月时的环境配置”。
*   **值得借鉴的细节**：事实“失效不删除”，天然具备版本审计追踪与回溯能力。
*   **真实链接**：[https://github.com/getzep/graphiti](https://github.com/getzep/graphiti)

### 4. LangMem（LangChain）
*   **定位**：LangChain 官方长程记忆 SDK，无缝结合 LangGraph 状态机。
*   **具体机制**：
    *   **认知分类**：严格区分为 **Semantic Memory**（事实、属性、用户画像，如编程语言喜好）与 **Episodic Memory**（情境事件、过去执行的成功/失败经验与反思）。
    *   **异步结构化抽取**：支持通过 Pydantic Schema 定义记忆结构。既可在对话流程中作为 Tool（Hot-path），也支持通过 `create_memory_manager` 在后台离线（Cold-path）监听对话流批量提取更新，不阻断主链路。
*   **值得借鉴的细节**：严格隔离“客观事实/偏好（语义）”与“过去的交互成败记录（情景反思）”。
*   **真实链接**：[https://github.com/langchain-ai/langmem](https://github.com/langchain-ai/langmem)

### 5. ChatGPT Memory 与 Chat History Reference
*   **定位**：消费级个人助理对话记忆标杆。
*   **具体机制**：
    *   **显式记忆（Saved Memories）**：模型在对话中感知到用户背景或明确收到“记住某事”指令时静默提取，UI 气泡提示“Memory updated”。用户可在设置面板中分页浏览、编辑具体单条、逐条删除或全部清空。
    *   **跨会话引用（Reference Chat History）**：不仅依赖结构化事实，还能跨 Session 语义检索过去的完整对话片段作为补充背景。
    *   **隐私模式**：提供 Temporary Chat（临时对话），期间不读取任何记忆，对话结束后不留痕迹、不写入长期记忆。
*   **值得借鉴的细节**：极佳的用户控制粒度（UI 明确通知 + 随时编辑删除单个 item）和隐私开关。
*   **真实链接**：[https://openai.com/index/memory-and-new-controls-for-chatgpt/](https://openai.com/index/memory-and-new-controls-for-chatgpt/)

### 6. Claude 官方记忆 与 Claude Code（CLAUDE.md / Auto Memory）
*   **定位**：Web 端的全局偏好记忆与 CLI 端面向工程任务的持久化双轨记忆体系。
*   **具体机制**：
    *   **Claude.ai Memory**：支持跨对话记住用户人设、风格，提供设置中心管理，并上线了从 ChatGPT / Gemini 迁移记忆的 Memory Import 工具。
    *   **Claude Code 的双轨机制**：
        *   `CLAUDE.md`：**人类维护的确定性手册**。位于项目根目录，Git 追踪，每次会话启动全量注入，定义构建命令、代码规约与高压线。
        *   `Auto Memory`（`MEMORY.md` 等）：**Agent 自主沉淀的经验本**。位于本地状态目录，Agent 在执行踩坑、命令纠偏后自动追加，避免下次会话犯相同错误。
*   **值得借鉴的细节**：“静态规范（人写）”与“动态经验（Agent 自写）”物理隔离；纯 Markdown 文件存储，天然具备 Git/版本可读性。
*   **真实链接**：[https://docs.anthropic.com/en/docs/agents-and-tools/claude-code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code)

### 7. OpenClaw
*   **定位**：轻量级、文件驱动的开源本地个人智能体运行时。
*   **具体机制**：
    *   **多层级 Markdown 架构**：
        *   `MEMORY.md`：经过提炼的高价值长期记忆（用户核心档案、稳定决策），Session 启动全量注入。
        *   `memory/YYYY-MM-DD.md`：每日流水日志（Daily Notes），启动时默认仅挂载“今天与昨天”的笔记，更早的历史沉淀归档。
    *   **Context Compaction 前的内存冲刷（Memory Flush）**：在上下文窗口即将耗尽触发压缩截断（Compaction）的前一刻，系统向模型发起内部 ping，强制 Agent 将未落盘的临时结论或重要偏好落盘到当日日志，避免上下文截断导致信息丢失。
    *   **混合检索**：提供 `memory_search`（BM25 + 向量）与按行读取工具 `memory_get`。
*   **值得借鉴的细节**：**Memory Flush 触发机制**（上下文压缩前抢救记忆）；每日笔记按天分片，仅加载近 2 天降低日常 Token 消耗。
*   **真实链接**：[https://openclaw.ai](https://openclaw.ai) *(开源实现与规范参考社区文档)*

### 8. Hermes Agent（Nous Research）
*   **定位**：具备自主进化与技能自愈能力的开源 Agent 框架。
*   **具体机制**：
    *   **有界记忆文件**：采用 `MEMORY.md`（系统与项目事实）与 `USER.md`（用户偏好），设置字符上限（约 2000-4000 字符），会话初始化作为快照注入。
    *   **技能自动创建与沉淀（Procedural Evolution）**：Agent 配备后台会话审查（Session Review）机制。当一次复杂排错或工作流成功执行后，Agent 通过 `skill_manage` 工具自动生成符合规范的 `SKILL.md`（包含参数、依赖、执行步骤）。
    *   **审批流**：沉淀或修改技能时产生差异比对（Diff），提示用户批准后存入 `~/.hermes/skills/`。
*   **值得借鉴的细节**：将“事实记忆”与“程序化技能（SOP）”解耦；复后会话自动提炼技能草案，用户确认后生效。
*   **真实链接**：[https://github.com/NousResearch/Hermes-Function-Calling](https://github.com/NousResearch/Hermes-Function-Calling) *(Hermes Agent 生态组件)*

### 9. Nanobot
*   **定位**：极简主义（~4,000 行核心代码）、单机优先的多渠道个人 Agent。
*   **具体机制**：
    *   **坚决抛弃向量数据库**：仅靠两个本地纯文本文件：`MEMORY.md`（稳定偏好与事实）与 `HISTORY.md`（追加式的摘要事件日志）。
    *   **“Dream（梦境）”自动整理周期**：当单次对话 Token 达到预设滑窗阈值时，自动激活 Dream 流程：压缩旧对话并归档追加到 `HISTORY.md`，提炼其中的持久偏好增量合并到 `MEMORY.md`，随后重置活动上下文。
    *   **检索方式**：直接采用系统级 `grep` 与精准文本正则匹配。
*   **值得借鉴的细节**：极低开销的单机运行逻辑，证明在个人桌面尺度下，结构化纯文本 + 确定性匹配在稳定性和维护成本上远优于向量库。
*   **真实链接**：[https://github.com/HKUDS/nanobot](https://github.com/HKUDS/nanobot)

### 10. Deep Agents（LangChain 生态模式）
*   **定位**：面向多智能体长程复杂任务的虚拟文件系统记忆框架。
*   **具体机制**：
    *   **文件系统即状态**：将记忆抽象为统一文件系统。短期状态绑定在线程 Checkpointer，长期跨会话状态沉淀在基于 Markdown 的规范文件中（如根目录 `AGENTS.md`）。
    *   **显式工具交互**：模型不通过黑盒隐式记忆向量召回，而是通过暴露的标准工具（`read_file`、`edit_file`、`list_dir`）主动探索和更新特定领域的记忆文件夹。
*   **值得借鉴的细节**：把记忆操作统一转化为标准的“文件读写”，让编码型 Agent（如 Pi）能复用已有的代码编辑能力维护记忆。
*   **真实链接**：[https://github.com/langchain-ai/deep-agents](https://github.com/langchain-ai/deep-agents) *(未核实独立仓库，属于 LangChain 官方 LangGraph Deep Agents 体系)*

### 11. Anthropic Agent Skills 规范
*   **定位**：Agent 技能标准化封装规范（已由 Anthropic 捐赠予 Linux 基金会 AAIF，托管于 agentskills.io）。
*   **具体机制**：
    *   **目录即技能**：每个 Skill 为独立文件夹，根目录下必须包含 `SKILL.md`，可选包含 `scripts/`（脚本）、`references/`（参考手册）、`assets/`（静态资源）。
    *   **YAML Frontmatter 规范**：严格限定 `name`（小写字母与连字符，<=64 字符）、`description`（说明“是什么”以及“何时触发”，<=1024 字符）、`compatibility`（环境要求）。
    *   **三级渐进式加载（Progressive Disclosure）**：
        1.  *Discovery*：启动时系统提示词中仅常驻所有技能的 `name + description`（单个技能仅耗费 ~100 tokens）；
        2.  *Activation*：当用户意图匹配到描述时，Agent 调用工具按需读取完整 `SKILL.md` 正文；
        3.  *Execution*：仅在需要具体脚本或参考时，才进一步读取 `scripts/` 或 `references/` 中的内容。
*   **值得借鉴的细节**：行业标准规范，Pi 运行时天然兼容；完美的 Token 递进控制模型。
*   **真实链接**：[https://agentskills.io](https://agentskills.io)

### 12. Goose Recipes（Block 出品）
*   **定位**：开源本地 Agent 工具 Goose 的可复用、参数化声明式任务模板。
*   **具体机制**：
    *   **YAML + Jinja 模板驱动**：Recipe 采用 YAML 编写，原生支持 `parameters` 声明（字段名、描述、是否必填、默认值）与 Jinja2 插值表达式（如 `{{ target_path }}`）。
    *   **扩展绑定与子代理**：模板内可直接声明执行该任务必须启用的 MCP（Model Context Protocol）扩展服务，甚至可直接编排多子 Agent 协同。
    *   **一键会话固化（Session to Recipe）**：用户在 Goose 桌面端或 CLI 跑通一次复杂交互后，可输入指令直接将当前成功的操作序列导出保存为 `.yaml` 模板。
*   **值得借鉴的细节**：**参数化任务模板的最佳实践**；支持从交互式会话一键导出为模板。
*   **真实链接**：[https://github.com/block/goose](https://github.com/block/goose)

### 13. Cursor Rules 与 Memories
*   **定位**：工程 IDE 场景下的上下文注入与项目规则演进。
*   **具体机制**：
    *   **转向确定性文件**：早期尝试过黑盒自动提取记忆，但因幻觉与不可预测性，全面转向显式的 `.cursor/rules/*.mdc` 文件系统。
    *   **精准条件触发**：通过 Frontmatter 配置 `globs: **/*.ts`（文件模式匹配触发）或 `alwaysApply: false`（根据用户提问语义智能激活），避免全量规则撑爆上下文。
*   **值得借鉴的细节**：放弃不可控的黑盒自动记忆；通过 Glob 模式与语义标签实现规则的精准按需注入。
*   **真实链接**：[https://docs.cursor.com/context/rules-for-ai](https://docs.cursor.com/context/rules-for-ai)

### 14. Windsurf Memories（Codeium）
*   **定位**：下一代 IDE Agent（Cascade）的双层混合上下文引擎。
*   **具体机制**：
    *   **Cascade Memories**：后台自动从开发者代码变动和会话中提取持久化记忆（如团队习惯、废弃 API、代码范式），在本地静默持久化，实现越用越聪明。
    *   **规则分层**：分为全局规则 `~/.codeium/windsurf/memories/global_rules.md`（上限约 6,000 字符）与工作区规则 `.windsurfrules`，硬性约束开发边界。
*   **值得借鉴的细节**：自动记忆（后台提炼）与显式规则（开发者编写）互补。
*   **真实链接**：[https://codeium.com/windsurf](https://codeium.com/windsurf)

### 15. OpenViking（火山引擎 / 字节跳动）
*   **定位**：面向 AI Agent 的三层渐进式虚拟文件系统上下文数据库。
*   **具体机制**：
    *   **虚拟文件系统协议**：基于 `viking://` 抽象，提供类 Linux 的资源寻址。
    *   **L0 / L1 / L2 漏斗式加载架构**：
        *   `L0（Abstract 摘要层）`：~100 tokens，纯文本极简摘要，常驻或大范围索引；
        *   `L1（Overview 概览层）`：~2k tokens，核心框架、调用契约与场景说明；
        *   `L2（Details 详情层）`：完整原始正文、代码实现或大型数据集。
    *   **可观测的探索轨迹**：模型通过系统内置的 `ls`、`find`、`grep`、`read` 逐步深入，逐级决定是否展开下一层。
*   **值得借鉴的细节**：L0/L1/L2 分层结构为桌面 Agent 管理大量长期记忆和技能提供了标准的分级加载范式。
*   **真实链接**：[https://github.com/volcengine/openviking](https://github.com/volcengine/openviking)

---

## 二、 7 大核心关注点的横向解构与设计选型

### 1. 记忆分类、存储格式与作用域
*   **分类体系**：
    *   **用户画像与偏好（Profile/Preference）**：如习惯、操作系统路径、语言偏好。变更频率低，高确定性。
    *   **项目/工作区背景（Project Context）**：当前软件工程规范、技术栈、特定术语。跟随工作目录切换。
    *   **沉淀经验与排错记录（Confirmed Experience / Episodic）**：踩坑经验、特定报错修复方式、排障 SOP。
*   **作用域（Scope）**：
    *   `Global`：全局生效，存储于 `~/.myagent/memory/global/`（全局偏好）。
    *   `Workspace/Project`：当前项目独占，存储于项目根目录 `.agent/` 或本地按哈希映射的配置目录。
    *   `Session`：单次对话临时变量与执行日志，存储在会话临时目录，任务结束即归档。
*   **存储格式选型（文件 vs 数据库）**：
    *   **推荐采用“双轨格式”**：以 **本地 Markdown 文件为事实唯一真理来源（Single Source of Truth）**，配以轻量级 **SQLite 本地数据库作为加速索引**。
    *   *为什么选 Markdown*：用户可以直接在 Windows 记事本/VS Code 中打开查看、编辑、通过 Git 备份；
    *   *为什么配合 SQLite*：存储元数据（来源、时间戳、推断标记、标签），便于 SQL 快速过滤。

### 2. 写入策略与人机交互流
*   **何时写与谁来写**：
    *   **严禁在主交互链路（Hot-path）中让模型频繁思考“是否写记忆”**：这会导致响应变慢且极大增加 Token 消耗。
    *   **用户显式要求（“记住我喜欢用 Python 3.12”）**：由 Agent 直接调用 `memory_set` 工具在当轮直接写盘，并在响应中显式回显“已记录”。
    *   **隐式推断（Agent 从长程任务中总结的经验）**：一律放入**暂存缓冲区（Staging Area）**。在任务完成时（或进入后台 Idle 潜意识状态时），生成“候选记忆卡片”。
*   **人机确认与差异展示**：
    *   对于隐式推断的记忆，以 UI 弹窗或侧边栏卡片展示：
        > 💡 **Agent 建议沉淀记忆**：  
        > *内容*：检测到您在本项目中使用 `pnpm` 而非 `npm`。  
        > *依据来源*：当前任务执行中的修正记录（来自 Turn 3 的报错回溯）。  
        > *置信度*：推断（Inferred）。  
        > [批准并写入] [编辑后保存] [忽略/丢弃]
    *   **严格区分标签**：每条记忆元数据必须标注 `type: explicit_user`（用户明说）或 `type: agent_inferred`（Agent 推断）。

### 3. 去重、冲突与事实失效
*   **去重与冲突判定引擎**：借鉴 Mem0 的 `ADD / UPDATE / DELETE / NOOP` 四态分类与 Graphiti 的时序模型。
*   **判定逻辑流程**：
    1.  当产生一条候选记忆时，先通过 SQLite FTS5 全文搜索召回 3~5 条高相似度已有记忆；
    2.  若完全重合 $\rightarrow$ 标记为 `NOOP`，直接丢弃；
    3.  若存在矛盾（例如旧记忆为 `node_version: 18`，新提炼为 `node_version: 20`） $\rightarrow$ 触发 `UPDATE`；
    4.  若用户明确指令“我不再使用 Docker” $\rightarrow$ 触发 `DELETE`（软删除/打上 `invalid_at` 标记）；
*   **来源可追溯性（Provenance）元数据格式示例**：
```yaml
id: "mem_20261027_001"
fact: "构建打包命令必须使用 `pnpm build --filter desktop`"
scope: "project"
source_type: "agent_inferred"  # explicit_user | agent_inferred
source_session_id: "sess_20261027_1930"
source_evidence: "在执行通用打包时遇到工作区报错，用户手动干预更正了命令参数"
created_at: "2026-10-27T19:35:00Z"
updated_at: "2026-10-27T19:35:00Z"
status: "active"  # active | superseded | deleted
superseded_by: null
```

### 4. 检索机制、本地轻量方案（FTS5）与 Token 预算
*   **本地轻量方案实测结论**：
    *   在 Windows 桌面单机环境，**严禁部署常驻向量数据库服务（如 Docker + Qdrant/Milvus/Chroma）**，其内存占用、冷启动耗时和环境依赖会大幅削弱桌面助理的轻量感。
    *   **SQLite FTS5（Full-Text Search 5）效果极佳**：结合 Porter 分词（英文/代码）与简单 N-Gram（中文），原生支持 BM25 排序。在单机几千条记忆尺度下，查询延迟在 **5 毫秒以内**，内存几乎为零。
    *   *可选平滑升级*：若确实需要语义相似度匹配，可引入纯 Python 嵌入的 `onnxruntime` 跑微型模型（如 30MB 的 `bge-small-zh`），向量直接以 BLOB 存入 SQLite，无须外挂任何后台 Daemon。
*   **Token 预算与注入上下文机制**：
    *   **严格分级注入（OpenViking 漏斗模型）**：
        *   `System Prompt 常驻区（Tier 0）`：只固定注入核心 Profile 与最高频的全局偏好（严格控制在 **500 Tokens** 以内）。
        *   `任务启动按需区（Tier 1）`：任务初始化时，根据 Prompt 关键词在 FTS5 匹配相关度 Top-5 的记忆条目作为背景注入（预算 **1000 Tokens**）。
        *   `工具调阅区（Tier 2）`：向 Agent 暴露 `memory_search` 工具，需要查阅历史细节时由 Agent 主动调用，不盲目预塞。

### 5. 记忆快照（Snapshot）与 Prompt Cache 友好性
*   **痛点**：当前前沿大模型（Claude、Gemini、OpenAI）均支持 Prompt Caching（提示词前缀缓存），可降低 50%~80% 费用与延迟，但前提是**前缀内容严格保持字节级一致**。如果 Agent 在执行复杂任务的多轮交互中动态修改或插入记忆，会导致 Prompt 前缀突变，全面击穿 Prompt Cache。
*   **设计：任务期间记忆冻结（Immutable Task Snapshot）**：
    1.  **快照生成（Task Turn 0）**：在用户下发任务的第 0 轮，系统完成记忆匹配，生成一份静态的 `active_memory_snapshot`，拼装在 System Prompt 的指定位置；
    2.  **任务执行期绝对不可变**：任务进行中的 Turn 1 ~ Turn N 期间，即使 Agent 产生新经验，也**绝对禁止就地修改当前上下文中的记忆块**；
    3.  **缓冲与后处理**：所有新记忆统一进入暂存队列（Staging Queue），直到整轮任务彻底结束、用户确认后，才批量更新底层存储。下一次全新任务启动时，才会挂载新的快照。

### 6. 技能沉淀、任务模板（Recipe）与版本管理
*   **“技能（Skill）” vs “任务模板（Recipe）”的明确边界**：
    | 维度 | Agent Skill（技能） | Recipe（任务模板） |
    | :--- | :--- | :--- |
    | **定位** | **能力型规范**：教 Agent “如何做某类事情”的 SOP | **目标型剧本**：预设参数、一步到位的“批处理工作流” |
    | **标准** | 遵循 Anthropic `SKILL.md`（YAML + 步骤说明 + 脚本） | 遵循 Goose 式 YAML 模板（Jinja2 参数 + 步骤 + MCP） |
    | **触发方式** | Agent 根据用户意图**自主决定是否激活** | 用户显式在 UI 选择模板并**填入参数执行** |
    | **生命周期** | 一旦安装，在所有符合场景的对话中均待命 | 一次性任务实例化，填参运行完毕即结束 |
*   **技能自动沉淀工作流**：
    1.  **检测触发点**：当 Agent 经历了复杂交互、重试多次并最终成功（或用户夸奖“这个解决办法很好，以后都这么干”）；
    2.  **提炼草案**：Agent 自动将解决过程形式化为 Anthropic 标准的 `SKILL.md`（提取关键参数、依赖工具、排错注意事项）；
    3.  **差异比对与审批（Diff View）**：在桌面端弹窗展示 Git 风格的 Diff 视图，用户点击“同意并保存”后写入 `~/.agent/skills/user-defined/`；
    4.  **动态刷新注册表**：利用 Pi 的渐进式加载特性，仅需向 Pi 运行时发送更新通知，更新技能清单（Name + Description），零成本即时生效。

### 7. 隐私与用户控制
*   **本地私有化**：记忆数据与技能文件全部以纯文本（Markdown）和标准 SQLite 文件保存在用户本地磁盘（`%USERPROFILE%/.myagent/`），绝不强制上传任何第三方云端。
*   **完备的管理能力**：
    *   **可视化管理器**：UI 提供“记忆看板”，支持按标签、更新时间、来源类型搜索，单条编辑与删除；
    *   **一键全量导出（Export）**：支持一键导出为标准 JSON 或 ZIP 包（内含完整 Markdown 与元数据）；
    *   **一键清空/归档（Wipe/Archive）**：支持一键清空项目记忆或全局记忆；
    *   **隐身/临时任务模式（Incognito Mode）**：勾选后冻结所有记忆检索与写入，不读取旧记忆，执行完毕不保留任何记录。

---

## 三、 功能全景横向对比汇总表

| 功能点 | 哪些项目具备代表性实现 | 对个人桌面 Agent 的价值 | 实现复杂度 | 推荐做法 |
| :--- | :--- | :---: | :---: | :--- |
| **Markdown 双轨存储** | Claude Code, OpenClaw, Nanobot, Hermes | **极高** | 低 | Markdown 文件作为唯一真实源，SQLite 建立快速查询索引 |
| **A.U.D.N 冲突处理** | Mem0, LangMem | **高** | 中 | 增量记忆入库前与前 3 条相似记忆通过轻量模型判定增删改留 |
| **时序失效不删除** | Zep / Graphiti | **中** | 中 | 为记忆条目保留 `invalid_at` 与历史版本字段，支持审计但不过度引入重型图库 |
| **记忆快照与缓存冻结** | Letta, Claude Code (理念一致) | **极高** | 低 | 任务开始时抽取上下文并固定，任务期内只读，保护 Prompt Cache |
| **渐进式加载 (L0/L1/L2)**| OpenViking, Anthropic Skills | **极高** | 中 | 启动仅加载元数据（~100 tokens），触发时读正文，执行时调脚本 |
| **上下文压缩前冲刷** | OpenClaw (`memoryFlush`) | **高** | 中 | 监听 Context 长度，在触发截断/压缩前向 Agent 发出存盘信号 |
| **潜意识/空闲整理** | Letta (Sleep-time), Nanobot (Dream) | **中** | 中 | 监测桌面空闲（Idle）状态，触发后台轻量批处理去重与整理 |
| **参数化任务模板** | Goose Recipes | **高** | 低 | 采用 YAML + Jinja2 规范，支持参数声明与表单渲染，支持会话一键导出 |
| **技能草案与 Diff 审批** | Hermes Agent, Pi 运行时 | **极高** | 中 | 任务成功后后台提炼 `SKILL.md`，在 UI 端给出 Diff 确认卡片 |
| **用户隐私控制看板** | ChatGPT, Claude | **极高** | 低 | 独立设置面板，单条查看/编辑/删除，提供隐身免记录模式开关 |

---

## 四、 本地单机、无向量库服务前提下的推荐记忆架构方案

基于开源 **Pi coding agent** 运行时，结合 Windows 桌面个人助理的资源敏感性、低延迟和可控性要求，推荐采用如下**“零后台服务依赖、文件为纲、快照保缓存”**的极简高性能架构：

```
                    ┌────────────────────────────────────────────────────────┐
                    │                   Windows 桌面 UI                      │
                    │   - 记忆管理看板 (查看/编辑/删除)                        │
                    │   - 候选记忆/技能 Diff 确认卡片                         │
                    │   - Recipe 参数化填报表单                               │
                    └───────────────────────────┬────────────────────────────┘
                                                │ 用户控制 / 事件
                                                ▼
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│                              Agent Runtime (基于 Pi 改造)                                   │
│                                                                                            │
│   [任务启动 Turn 0]                                                                         │
│   ┌──────────────────────────────┐          ┌──────────────────────────────────────────┐   │
│   │   SQLite FTS5 快速混合检索    │ ───────► │ 冻结生成 Memory Snapshot (只读，缓存友好)  │   │
│   └──────────────────────────────┘          └────────────────────┬─────────────────────┘   │
│                                                                  │ 注入前缀                │
│                                                                  ▼                         │
│   [任务执行期 Turn 1..N]                                                                   │
│   ┌────────────────────────────────────────────────────────────────────────────────────┐   │
│   │ 执行器 (只读访问当前 Snapshot，保障多轮 Prompt Cache 命中)                           │   │
│   │ 发现新知识/新规约 ──► 写入 Staging Buffer (内存暂存区，严禁中途修改 Snapshot)       │   │
│   │ 匹配到 Skill ──► Pi 原生渐进式加载 SKILL.md                                        │   │
│   └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                  │                         │
│   [任务结束 / 潜意识空闲]                                         ▼                         │
│   ┌────────────────────────────────────────────────────────────────────────────────────┐   │
│   │ 记忆提炼器 (A.U.D.N 状态机) ──► 弹窗提示用户确认 ──► 固化到持久化存储                │   │
│   │ 技能沉淀器 ──► 提炼 SKILL.md ──► UI Diff 确认 ──► 写入 skills 目录                 │   │
│   └────────────────────────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────┬────────────────────────────────────────────┘
                                                │ 读写同步
                                                ▼
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│                                本地持久化层 (文件系统为准)                                   │
│                                                                                            │
│  %USERPROFILE%/.myagent/                                                                   │
│  ├── memory/                                                                               │
│  │   ├── user_profile.md           # [全局] 用户固定人设与基础偏好                           │
│  │   ├── memories.jsonl            # [全局] 结构化事实库 (带时间戳、来源、推断标记)          │
│  │   └── index.db                  # [索引] SQLite 数据库 (启用 FTS5 全文搜索扩展)          │
│  ├── skills/                                                                               │
│  │   └── <skill-name>/             # 符合 Anthropic 规范的标准技能包                         │
│  │       ├── SKILL.md              # YAML Frontmatter + Markdown 步骤说明                  │
│  │       └── scripts/              # 本地执行脚本                                          │
│  └── recipes/                                                                              │
│      └── <recipe-name>.yaml        # Goose 风格的任务模板 (Jinja2 参数化)                   │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 核心落地实施建议：

1.  **存储与检索层（放弃向量，拥抱 SQLite FTS5）**：
    *   在 `%USERPROFILE%/.myagent/memory/index.db` 中建立 SQLite 数据库，开启 `fts5` 虚拟表。
    *   对每条记忆提取 `id, content, scope, source_type, tags, created_at` 字段；
    *   检索时直接使用 BM25 评分排序，配合当前活动窗口的关键词进行精准过滤。实测 10,000 条记忆检索延迟 `< 3ms`，零显存占用，免除配置嵌入模型的烦恼。
2.  **Prompt Cache 极致友好的快照策略**：
    *   任务开始前，将 `user_profile.md` 的内容与检索出的 Top-3 动态记忆打包，格式化为固定的系统提示词前缀，标记为 `[MEMORY_SNAPSHOT]`；
    *   在单次多轮任务内，无论发生何种修正，**绝对不要动态修改该前缀**，确保 100% 吃到大模型厂商的 Prompt Cache 命中红利；
    *   所有当轮提炼的新知识一律进内存中的 `StagingBuffer`。
3.  **记忆入库的 A.U.D.N 确认闭环**：
    *   任务正常退出或用户主动结束时，从 `StagingBuffer` 读取条目，在后台调用一次小尺寸模型或快速接口，对比已有记忆输出操作建议；
    *   在桌面端托盘/通知区以卡片形式唤出：“检测到 1 条新偏好，是否记住？”，获得用户点击后再落盘并更新 SQLite 索引。
4.  **技能（Skill）与任务模板（Recipe）的双轨运行**：
    *   **通用能力**走 **Anthropic Agent Skills** 规范：放在 `skills/` 目录，利用 Pi 已有的能力，启动时只暴露 `name + description`，运行时由 Agent 按需 `read_file` 激活；
    *   **固定套路**走 **Goose YAML Recipes**：放在 `recipes/` 目录，在桌面 UI 呈现为一个可点击的“快捷动作卡”，用户点击后弹出输入框填写参数（如目标路径、报告主题），提交后直接为 Pi 运行时组装预制指令并启动会话。
