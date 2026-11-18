# Agent 记忆扩展至大型资料库的技术调研与平台架构建议

> 阅读约定：文中以 **【事实】** 标明有公开文献或官方文档出处的客观数据与结论，以 **【推断】** 标明基于多源证据的工程推导，以 **【建议】** 标明面向本平台的具体落地方案；无法获取原始一手数据或属厂商未公开细节的内容均标为 **未核实**。

---

## 1. 结论摘要

1. **后台整理（Dreaming）对跨文档综合有显著收益，但对单文档精确查找几乎无益（强证据：对照实验 | R1）**。**【事实】** Anthropic 在 35 万文件、4.2 亿 token 的 Stainless 内部语料上测试，经过 128 轮后台整理构建互链 Wiki 后，Wiki+搜索的准确率从 54% 升至 61%（仅搜索为 53%），且每题节省约 2 万 token；但在 Harvey LAB 单文档可命中的法律任务上，Wiki 并无明显收益，甚至出现 Wiki 体积膨胀至原文 1.77 倍的「博尔赫斯地图」现象（[Anthropic, 2026](https://www.anthropic.com/research/components-of-agent-memory)）。**【建议】** 大型资料库不应盲目全量预构建 Wiki，应以「混合全文与向量检索」为底座，仅对跨文档高频主题按需构建轻量索引页。
2. **「按经验类型/仅记失败」的固定写入规则会削弱强模型收益，而弱模型必须依赖显式读记引导与程序兜底（强证据：对照实验 | R1, R19, R20）**。**【事实】** Anthropic 在 CL-Bench 1.0 上发现，限定「只记录失败」使 Opus 4.7 与 Opus 5 的记忆增益大幅缩水；而弱模型 Sonnet 4.6 在不提示时不到一半的概率会主动读取记忆，加入「答题前先读记忆并验证假设」提示后得分接近翻倍（[Anthropic, 2026](https://www.anthropic.com/research/components-of-agent-memory)）。外部研究进一步表明，写入模型与读取模型存在显著能力非对称性，弱执行器使用原始日志效果暴跌 21 个百分点，必须由强模型或离线整理成结构化指导（[Zhou et al., 2026](https://arxiv.org/html/2607.26637v1)）。**【建议】** 本平台对接 DeepSeek 等多档模型时，应将「固定类型标签」从前端提示词约束下沉为后台校验 Schema，并按模型能力切换引导策略。
3. **无节制的 LLM 连续重写记忆会导致「记忆崩溃」与自我引用塌缩（强证据：对照实验 | R23, R24）**。**【事实】** 2026 年研究证实，持续用 LLM 重写并合并轨迹记忆会使任务准确率在短暂上升后跌破「无记忆基线」，即便是 GPT-5.4 从正确解出发也会在 54% 的已解题目上退化（[Zhang et al., 2026](https://arxiv.org/abs/2605.12978)）；检索系统若混入模型自生成内容（哪怕仅占 10%–20%），也会因自我偏好引发 22.8%–50.9% 的回答塌缩（[Graphite Research, 2026](https://arxiv.org/html/2608.22118v1)）。**【建议】** 原始会话记录与原始文档分块必须作为只追加（append-only）的「事实底座」，一切派生记忆与 Wiki 必须挂接原文逐字引用与哈希指针，禁止无来源覆盖。
4. **多 Agent 并发写同一共享记忆页必然丢事实，必须采用单页单责或并发控制（强证据：对照实验与并发研究 | R1, R25, R26）**。**【事实】** Anthropic 在合同审查任务中观察到，多个 Agent 同时写入一张共享表时 57 条事实仅保留 41 条（72%）；改为「每份合同一页、单 Agent 负责、逐字引用」后达到 57/57（100%）（[Anthropic, 2026](https://www.anthropic.com/research/components-of-agent-memory)）。多 Agent 异步推理窗口极长，极易产生丢失更新与脏读（[arXiv:2608.18092](https://arxiv.org/html/2608.18092v1)）。**【建议】** 保持「记忆 Agent 提议 → 主程序 SQLite 事务校验提交」的现有架构，并在未来资料库 Wiki 构建中按文档或主题分片加锁。
5. **16GB 无独显 Windows 笔记本的最优本地检索路线是「Agent 自主搜索 + SQLite FTS5 + 单向量混合检索 + 按需重排」（强证据：基准评测与工程实测 | R4, R35, R36, R38）**。**【事实】** 微软 GraphRAG 全局查询单次需约 61 万 token（[arXiv:2410.05779](https://arxiv.org/html/2410.05779v3)），ColBERT 多向量 100 万分块压缩后仍需 6–10.8 GB 空间（[arXiv:2205.09707](https://arxiv.org/html/2205.09707v1)），均超出轻薄本预算。相反，混合检索（上下文增强嵌入 + BM25 + 重排）可将 Top-20 检索失败率降低 67%（[Anthropic, 2024](https://www.anthropic.com/research/contextual-retrieval)）。**【建议】** 本地采用 `Qwen3-Embedding-0.6B`（Q8_0 约 639 MB，MRL 截断至 512 维 `int8`）与 `bge-reranker-v2-m3`（INT8 ONNX 约 570 MB），20 万分块以内使用 SQLite `FTS5 + sqlite-vec` 单库方案，超大规模平滑迁移至嵌入式 LanceDB。
6. **中文检索不能直接依赖 SQLite FTS5 默认分词器，必须「分词预处理 + trigram 回退」（强证据：工程实测与源码文档 | R40, R41）**。**【事实】** SQLite FTS5 内置的 `unicode61` 会将整段连续中文当作单个巨型词元，导致关键词召回失效；内置 `trigram` 虽免外部依赖，但 1–2 字中文短词（如「测控」）无法命中三元组索引（[SQLite FTS5](https://sqlite.org/fts5.html)；[OpenClaw #170997](https://github.com/openclaw/openclaw/issues/170997)）。**【建议】** 在 Node.js 侧使用轻量 `jieba` 预分词写入 FTS5 影子列，并保留 `trigram` 作为代码符号与长子串回退。
7. **经验记忆、资料库知识与历史会话必须「物理分表/分区、逻辑统一路由」（中等证据：系统对比与架构分析 | R1, R12, R17）**。**【事实】** 业界成熟方案（如 Hermes Agent、Letta、EverMemOS）均将易变的「核心经验快照」、海量的「外部资料/归档库」与只追加的「原始会话日志」隔离存储（[Hermes Docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)；[arXiv:2601.02163](https://arxiv.org/html/2601.02163v2)）。**【推断】** 混合存储会混淆「用户个人偏好」与「外部导入文档的客观陈述」，一旦文档过时或被投毒将污染个人记忆。**【建议】** 在 SQLite 中分设三类数据区与统一检索路由，冲突时严格遵循「用户明说/确认 > 最新会话 > 经验记忆 > 资料库文档」的优先级。
8. **现有记忆系统普遍存在「遗忘传播失效」，彻底删除必须依赖溯源图与可重建索引（强证据：综述与攻击评测 | R28, R29, R30）**。**【事实】** 2026 年一项覆盖 3,283 篇论文的元分析指出，现有受测记忆系统对「遗忘请求」在派生层（摘要、向量、索引）的彻底清除通过率均不足 1.5%（[OpenChamber, 2026](https://openchamber.dev/blog/agent-memory-research/)）；PACMI 提出通过带边类型的溯源图（`supports`/`derived-from`）实现级联失效（[arXiv:2610.05732](https://arxiv.org/pdf/2610.05732)）。**【建议】** 在本平台建立 `source_doc_id` 到所有派生分块、向量、Wiki 段落与经验条目的强外键/溯源映射，删除文档时级联清理并保留不可逆哈希黑名单。
9. **知识库注入与记忆投毒的攻击成功率极高，仅靠提示词边界防护远不够用（强证据：安全实验 | R31, R32, R33）**。**【事实】** AgentPoison 在不到 0.1% 投毒率下即可达到 63% 平均端到端攻击成功率（[Chen et al., NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/file/eb113910e9c3f6242541c1652e30dfd6-Paper-Conference.pdf)）；MPBench 测试显示常规提示注入检测器对弱信号记忆投毒的拦截率仅 42.50%，而程序级文件锁与写路径校验可将实测投毒率从 87% 降至 5%（[Dash et al., 2026](https://arxiv.org/html/2606.04329v1)）。**【建议】** 对用户导入的外部网页、PDF 与仓库文件强制打上 `untrusted_kb` 隔离标签（参考 CaMeL 能力隔离思想），禁止未经过滤的资料库片段直接触发记忆写入或高危工具调用。
10. **常规下游问答评测会掩盖记忆系统的真实腐化，必须引入「内生状态评测 + 自动回归测试」（强证据：评测研究 | R21, R48, R49）**。**【事实】** 2026 年研究证明，单纯使用下游 QA 准确率评测会产生「假阳性」（强模型靠参数知识掩盖了过期记忆）与「假阴性」（记忆正确但检索漏召），不同裁判提示词可导致 LoCoMo 分数波动约 10%（[arXiv:2610.22209v1](https://arxiv.org/html/2610.22209v1)；[Sentra, 2026](https://www.sentra.app/articles/longmemeval-benchmark)）。**【建议】** 平台自建评测集应同时包含「状态/记忆库直检」与「端到端带引用问答」，并将文档增删改、CJK 召回、级联遗忘与防投毒纳入自动化回归测试套件。

---

## 2. Anthropic 记忆架构拆解与对照分析

### 2.1 核心组件、层次结构与数据流

**【事实】** 在 2026 年 11 月发布的《The components of agent memory》中，Anthropic 将 Agent 记忆明确界定为：**从交互与任务经验中获得、跨会话保留、以「可回读上下文」形式存储的知识**；它明确排除模型权重微调（weight updates）、单次对话内的上下文学习（in-context learning）以及会话内上下文压缩（compaction）（[Anthropic, 2026](https://www.anthropic.com/research/components-of-agent-memory)）。

该架构包含四个自底向上的层级，以及贯穿其中的两种写入机制与一项后台巩固流程（Dreaming，意为「睡眠整理」，借鉴人类海马体在睡眠中回放近期经验并整合进新皮层的机制）：

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 层级 4：预加载注入层 (Injected Context / Top-Level Index)                │
│ 形态：MEMORY.md 前 200 行/25KB 或 global.md 仪表盘（必须极小，仅作索引）   │
└───────────────────────────────▲─────────────────────────────────────────┘
                                │ 4. 提升高频核心笔记 & 细节下沉留链接
┌───────────────────────────────┴─────────────────────────────────────────┐
│ 层级 3：派生知识表示层 (Representations / Knowledge Wiki)                 │
│ 形态：主题化、双向互链的 Markdown Wiki 页（跨文档综合、逐字引用原文）      │
└───────────────────────────────▲─────────────────────────────────────────┘
                                │ 2. 跨会话综合、建页、修死链、合并重复
┌───────────────────────────────┴─────────────────────────────────────────┐
│ 层级 2：记忆笔记层 (Memory Notes / Mounted Directory)                    │
│ 形态：会话中或任务后写入的结构化笔记文件（策略、计划、已验证规则、陷阱警示） │
└───────▲───────────────────────▲─────────────────────────────────────────┘
        │ 1. 会话中显著性写入     │ 3. Dreaming 拿原始日志核对笔记（纠错）
        │ （带主观预测风险）       │
┌───────┴───────────────────────┴─────────────────────────────────────────┐
│ 层级 1：原始会话记录层 (Session Transcripts / Logs) — 唯一事实依据         │
│ 形态：只追加的完整工具调用、对话流与环境观测记录（支持全文搜索作为根基）     │
└─────────────────────────────────────────────────────────────────────────┘
```

各组件的核心机制如下：

1. **显著性判断（Salience Judgment）与预测性写入**：**【事实】** 写下记忆本质上是对「未来会再次用到该信息」的预测。屏幕或当前环境每次都能直接读到的瞬时状态（如游戏里的当前坐标、剩余金钱）不应存入记忆；真正值得存储的是「环境不直接提供、必须靠推理和试错才能得到的知识」（如策略、长期计划、经过验证的规律与避坑指南）（[Anthropic, 2026](https://www.anthropic.com/research/components-of-agent-memory)）。
2. **闭环学习（Closed Learning Loop）**：**【事实】** 完整的有效记忆写入包含四个步骤：遭遇失败 → 提出错误原因假设 → 在后续或验证步骤中检验假设 → 将「带依据的规则」与「验证状态」写入记忆。
3. **Dreaming（后台异步巩固）的六大功能**：**【事实】** 引用 Letta 与 UC Berkeley 提出的 *Sleep-time Compute*（睡眠期计算，指利用交互间隙的空闲算力整理上下文）（[Lin et al., 2025](https://arxiv.org/html/2504.13171v1)），Anthropic 将 Dreaming 拆解为六项具体职能：（1）**核对纠错**：以原始会话记录为事实依据（Ground Truth）校验并修正错误笔记；（2）**构建派生表示**：将海量文档与会话整理为互链的 Wiki 主题页；（3）**层级提升与瘦身**：将核心结论提升至会话启动必读的顶层索引，同时把细节下沉并保留链接；（4）**目标导向生长**：根据任务反馈重写构建 Wiki 的指令（例如从共享表改为单页单责）；（5）**跨会话补缺**：修复指向缺失页面的死链、合并重复页面、补充总览索引页；（6）**按需调度（开放方向）**：优先核对易变信息，并依据访问频率调节整理节奏（[Anthropic, 2026](https://www.anthropic.com/research/components-of-agent-memory)）。

### 2.2 实验结论的证据强度与模型能力依赖边界

Anthropic 原文报告了多组定量与定性实验，但其结论在不同模型能力与任务类型上存在明显适用边界：

| 核心结论 | 实验设计、样本量与数据（【事实】） | 证据强度 | 对「强模型」的依赖度与弱模型迁移风险（【推断】） |
| :--- | :--- | :--- | :--- |
| **强模型能自发形成「验证-成规」闭环** | CL-Bench 1.0 数据库任务：Opus 4.7 均值奖励从 0.383 升至 0.700；Opus 5 首次稳定写出「规则+依据+避坑」；Opus 5.5 从 0.655 升至 0.838（[Anthropic, 2026](https://www.anthropic.com/research/components-of-agent-memory)）。 | **高**（有对照基线，但具体题数未在博文详列，引用 CL-Bench） | **极强依赖**。Sonnet 4.6 仅停留在记录未验证猜测；若换用能力略弱的第三方模型（如部分中小参数模型），放任自写极易产生「未验证的伪规则」污染记忆。 |
| **强模型显著性判断远优于弱模型** | Pokémon Red 游戏约 10,000 步观测：Sonnet 3.7 写了 413 个文件/225 个目录（1 枚徽章）；Fable 5 仅写 9 个文件/2 目录+`global.md`（4 枚徽章）（[Anthropic, 2026](https://www.anthropic.com/research/components-of-agent-memory)）。 | **中**（典型单轨迹案例对比，非大样本统计显著性测试） | **极强依赖**。弱模型倾向「全量流水账式记录」，导致后期花费大量步骤检索与维护过期笔记。 |
| **固定写入规则损害强模型、显式引导拯救弱模型** | CL-Bench 上限定「只记失败」削弱了 Opus 4.7/5 的收益；而提示 Sonnet 4.6「答题前先读记忆并测试理论」使其得分接近翻倍（0.330→0.364 基线外翻倍，具体对照柱状图数值未逐一列出）（[Anthropic, 2026](https://www.anthropic.com/research/components-of-agent-memory)）。 | **高**（模型间交叉消融实验） | **高度敏感**。验证了「单一固定提示词无法通吃所有模型」，平台接入多模型时必须按模型档位自适应调整引导策略。 |
| **Dreaming 纠错可打破死循环** | Pokémon 月见山（Mt. Moon）单次失败轨迹修复：Dreaming 核对日志修正 PokéCenter 方位后，Agent 在第 1,935 步成功抵达华蓝市，对照组全失败（[Anthropic, 2026](https://www.anthropic.com/research/components-of-agent-memory)）。 | **中**（关键案例验证，样本量 $N=1$ 场景） | **中度依赖**。纠错前提是日志完整且整理模型具备足够的时空推理能力；若整理模型本身推理弱，仍可能误判。 |
| **Wiki 在跨文档综合上优势明显，单文档查找无增益** | Stainless 语料（~35 万文件/4.2 亿 token，25 题）：Dreaming 2→128 轮，仅 Wiki 13%→48%，Wiki+搜索 54%→61%（纯搜索 53%），省约 2 万 token/题；Harvey LAB 并购 24 题跨文档综合 Wiki 87% vs 搜索 73%；单文档任务无增益且一例 Wiki 膨胀至原文 1.77 倍（[Anthropic, 2026](https://www.anthropic.com/research/components-of-agent-memory)）。 | **高**（大规模语料+外部基准对照，但 Stainless 测试集仅 25 题） | **强依赖与高成本**。构建并维护 4.2 亿 token 级别语料的 128 轮 Wiki 耗费巨大算力，在按量计费的 DeepSeek/第三方 API 预算下不可直接照搬全量构建。 |
| **单页单责+逐字引用防止并发丢失** | Harvey LAB 合同任务：多 Agent 同写共享表仅保留 41/57 条事实（72%）；改为每份合同一页、单 Agent 负责并逐字引用后达 57/57（100%）（[Anthropic, 2026](https://www.anthropic.com/research/components-of-agent-memory)）。 | **高**（明确消融前后对比） | **结构性规律（跨模型通用）**。并发覆盖与摘要失真属于系统工程与信息压缩固有缺陷，换用任何模型都需遵守此规范。 |

### 2.3 与 Anthropic 既有产品及工程能力的对应关系

**【事实】** 通过追溯 Anthropic 官方文档与源码仓库，其研究理念已精准映射到五项公开工程组件中：

1. **Claude Code Auto Memory（自动记忆）**：对应「层级 4 顶层索引」。Claude Code 将项目自动记忆存放在本地，每次会话启动仅预加载 `MEMORY.md` 的前 **200 行或 25 KB**（以先到者为准）作为轻量索引，其余主题文件按需读取，防止指令过长稀释模型注意力（[Claude Code Docs](https://code.claude.com/docs/en/memory)）。
2. **Messages API Memory Tool（客户端记忆工具，`memory_20250818`）**：对应「层级 2 笔记层」的通用协议。Anthropic 不托管数据，而是由客户端暴露 `/memories` 目录及 `view`（单次截断上限 16,000 字符）、`create`、`str_replace`、`insert`、`delete`、`rename` 六个文件操作命令，支持零数据留存（ZDR）（[Claude Platform Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)）。
3. **Claude Managed Agents Memory Stores（托管记忆存储，`agent-memory-2026-07-22`）**：对应「可版本化的持久化工作区记忆」。以 `memstore_...` 挂载至沙箱 `/mnt/memory/<slug>/`，支持 `content_sha256` 乐观并发锁与保留 30 天的不可变版本 `memver_...`；单条上限 100 KB，单库上限 10,000 条，单会话最多挂载 8 个库（[Managed Agents Memory](https://platform.claude.com/docs/en/managed-agents/memory)）。
4. **Managed Agents Dreams（异步整理接口，`dreaming-2026-04-21`）与 Cookbook**：Dreams 接口（Research Preview）每次异步读取一个既有记忆库与 **1–100 个**历史会话记录，输出一个全新的记忆库而不覆盖原库（[Dreams Docs](https://platform.claude.com/docs/en/managed-agents/dreams)）。官方 Cookbook《Dreaming with a dynamic workflow》给出了三角色流水线：`memory-distiller`（主控，仅读/检索）→ `transcript-analyzer`（每份会话一个，并行提炼）→ `memory-organizer`（去重、修 `[[slug]]` 链接、更新 `_index.md`），处理 50 份长会话（约 12 MB）约耗时 10 分钟、花费约 8 美元（[Dreaming Cookbook](https://platform.claude.com/cookbook/managed-agents-cma-dreaming-with-a-dynamic-workflow)）。此外，官方 `claude-quickstarts` 仓库中的 **Knowledge Wiki** 示例展示了基于 SEC 公开文件构建带逐字出处的并购 Wiki 流程（[claude-quickstarts](https://github.com/anthropics/claude-quickstarts)）。
5. **Context Editing（`context-management-2025-06-27`）与 Contextual Retrieval（上下文增强检索）**：前者通过 `clear_tool_uses_20250919`（默认超过 10 万输入 token 时清理旧工具结果，仅保留最近 3 次）与 `clear_thinking_20251015` 配合记忆工具防止上下文爆炸（[Context Editing Docs](https://platform.claude.com/docs/en/build-with-claude/context-editing)）；后者则在建索引前为每个分块拼接 50–100 token 的文档级上下文说明（使用 Haiku + Prompt Caching 成本约 $1.02 / 百万文档 token），使混合检索+重排的 Top-20 失败率下降 **67%**（[Contextual Retrieval](https://www.anthropic.com/research/contextual-retrieval)）。

### 2.4 与本平台现有设计的逐项对照

结合本平台现有实现（三级记忆 + 严格权限锁死的记忆 Agent + 2000 token/3% 快照 + SQLite + DeepSeek 等第三方模型），逐项对照如下：

| 维度 | Anthropic 思路与实践 | 本平台现有设计 | 状态判定 | 冲突分析与工程建议（【建议】） |
| :--- | :--- | :--- | :--- | :--- |
| **离线整理机制** | Dreaming 后台读取日志整理记忆，支持纠正与建表 | 记忆 Agent 按任务结束/周/月/季/事件排队运行，程序校验提交 | **已有（架构高度同构）** | 保留「程序锁死权限+提议校验」优势，这是防止弱模型写乱的核心护城河。 |
| **顶层预加载注入** | `MEMORY.md`（≤200 行/25KB）或 `global.md` 索引 | 快照（≤2000 token 且 ≤3% 窗口）注入常驻+相关+补充 | **已有（且更精细）** | 保持 2000 token 硬上限；未来扩展资料库后，快照中应增加「资料库主题目录索引」指针。 |
| **防压缩复活与及时纠错** | 明确区分记忆与 Compaction；错误笔记需修正 | 压缩时不写入快照；用户纠正立即替换快照 | **已有（领先于常规方案）** | 保留该机制。 |
| **原始会话作为事实依据** | 保留完整 Transcript 供检索与 Dreaming 回溯核对 | 仅存指回会话条目的「短摘」，无会话全文检索 | **缺失** | **高优补齐**：将完整会话原文纳入 SQLite FTS5，使记忆 Agent 复核时能回读完整上下文而非仅靠短摘。 |
| **检索与资料库层** | 会话检索 + 混合 RAG（Contextual Retrieval）+ 按需 Wiki | 仅三元组文本相似度，无语义检索、无全文索引、无资料库 | **缺失** | **核心建设目标**：引入 FTS5（中英分词）+ 轻量本地向量 + 按需重排。 |
| **访问频率驱动整理** | 开放建议：优先核对易变信息、按访问频率调节整理节奏 | 固定周期（14 天近期、周/月/季）+ 回想再巩固 | **部分缺失** | 在调度器中引入「命中热度 + 最近纠错惩罚」权重，避免对冷门稳定记忆重复消耗 API 预算。 |
| **写入规则与分类约束** | 对强模型固定「只记失败」等规则有害；应告知用途而非死规 | 固定 7 种记忆类型、严格状态机与程序预筛规则 | **存在设计张力** | **直面冲突并保留折中方案**：Anthropic 测试对象是 Opus 4.7/5 等顶尖模型，而本平台主力为 DeepSeek 等第三方模型且计费受限。**建议保留程序层强 Schema 校验，但放宽对前端/强模型提示词中的内容限制**，允许强模型自由提炼跨类型经验，由记忆 Agent 后台归类。 |
| **写前验证闭环** | 强模型在会话中「失败→假设→验证→写规则」 | 记忆 Agent 事后批量提取，主 Agent 少有显式验证写入 | **部分缺失** | 为主 Agent 增加轻量 `flag_salient_event`（标记显著事件/待验证假设）工具，但不直接写库，交由记忆 Agent 验证后入库。 |

---

## 3. 业界与学界 Agent 记忆系统全景对比

### 3.1 主流方案横向对比（2024–2026）

**【事实】** 下表梳理了近两年最具代表性的 13 个工业界与学术界 Agent 记忆系统。为保证客观性，厂商自报评测成绩与独立第三方复现成绩已分开标注。

| 系统 / 项目 | 记忆单元形态 | 写入时机 | 整理与遗忘机制 | 检索方式 | 时间与版本处理 | 规模上限 / 开销 | 代表评测成绩（【事实】） | 本地部署可行性 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Letta / MemGPT & Sleep-time** ([arXiv:2504.13171](https://arxiv.org/abs/2504.13171)) | 核心块（Core）+ 回忆（Recall）+ 归档库（Archival） | 会话中工具写入 + 空闲期异步 Sleep-time 代理 | `rethink_memory` 重写合并覆盖旧事实 | 核心块常驻 + 工具调用语义/文本检索 | 块覆盖更新；支持 `.af` 导出 | 核心块受上下文窗口限制 | **自报**：GSM/AIME 推理降本 5×，精度 +13%/+18%；**第三方**：MemoryAgentBench 28.3（[R27](https://arxiv.org/html/2507.05257v4)），LoCoMo 单跳 F1 26.65（[R10](https://arxiv.org/html/2504.19413v1)） | **高**（Apache 2.0，支持本地部署） |
| **Mem0 / Mem0ᵍ** ([arXiv:2504.19413](https://arxiv.org/abs/2504.19413)) | 自然语言事实条目 + Neo4j 有向图（Mem0ᵍ） | 会话每轮异步提取（滑窗 10 条+摘要） | 2025 版 ADD/UPDATE/DELETE；2026 版改为单次 ADD + 衰减（[Mem0, 2026](https://mem0.ai/blog/introducing-temporal-reasoning-in-mem0)） | 向量 + 实体子图 + 2026 混合时间重排 | `event_end` 标记失效区间，保留历史态 | 免费云限 1 万次写入/月；自建随图库扩展 | **自报**：LoCoMo 66.88% J（Mem0ᵍ 68.44%），2026 时序版自报 LoCoMo 92.5% / LongMemEval 94.4%；**第三方**：MemoryAgentBench 21.1（[R27](https://arxiv.org/html/2507.05257v4)），EverMemOS 复测 LoCoMo 64.20%（[R16](https://arxiv.org/html/2601.02163v2)） | **高**（核心 Apache 2.0，图版本需 Neo4j） |
| **Zep / Graphiti** ([arXiv:2501.13956](https://arxiv.org/abs/2501.13956)) | 三层动态知识图谱（片段/实体/社区） | 异步后台摄取构建图谱 | 实体消歧、标签传播社区聚类、LLM 置边失效 | 余弦 + BM25 + N 跳 BFS + RRF/MMR/交叉重排 | **双时间模型**（事件有效时间 $T$ + 事务入库时间 $T'$） | 建图极耗 token（LoCoMo 单对话超 60 万 token，延迟数小时，[R10](https://arxiv.org/html/2504.19413v1)） | **自报**：DMR 94.8%–98.2%，LongMemEval_S 71.2%（延迟降 90%）；**第三方**：MemoryAgentBench 24.0（[R27](https://arxiv.org/html/2507.05257v4)），LoCoMo 65.99% J（[R10](https://arxiv.org/html/2504.19413v1)） / 85.22%（[R16](https://arxiv.org/html/2601.02163v2)） | **中**（Graphiti 开源但重度依赖 Neo4j 与 LLM 建图） |
| **A-MEM** ([arXiv:2502.12110](https://arxiv.org/abs/2502.12110)) | 卡片盒（Zettelkasten）原子笔记 + 链接网络 | 会话中每轮交互即时构建 | 链接生成 + 记忆演化（动态更新邻近笔记描述与标签） | 稠密向量检索 + 同盒链接扩散 | 记录时间戳，原地演化笔记内容 | 实测至 100 万条（1.46 GB，向量检索 3.7 μs，$O(N)$） | **自报**：LoCoMo 多跳 F1 45.85，每次操作 1,200–2,520 token；**第三方**：Mem0 复测 48.38% J（[R10](https://arxiv.org/html/2504.19413v1)），MemoryOS 复测 F1 26.55（[R12](https://arxiv.org/html/2506.06326v1)） | **高**（MIT，支持 Ollama 本地模型） |
| **MemoryOS** ([arXiv:2506.06326](https://arxiv.org/abs/2506.06326)) | 三级结构：短期页（STM）、中期主题段（MTM）、长期画像/知识（LPM） | 会话写入 STM + FIFO 与热度驱动迁移 | 热度公式（访问次数+交互量+指数衰减）淘汰冷段，高热晋升 LPM | STM 全量 + MTM 两阶段（余弦+Jaccard）+ LPM Top-10 | 时间戳 + 指数近期衰减 | 默认上限：STM 7 页，MTM 200 段，LPM 100 条 | **自报**（EMNLP 2025 Oral）：LoCoMo 多跳 F1 41.15（均耗 3,874 token）；**第三方**：EverMemOS 复测 LoCoMo 54.70%–60.11%（[R16](https://arxiv.org/html/2601.02163v2)） | **高**（开源，含 MCP 支持） |
| **LangMem** ([LangChain Docs](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)) | 语义（集合/画像）、情景（轨迹）、程序（系统提示词） | 热路径工具写 + 后台潜意识提取 | 集合条目 LLM 覆写/删除，画像原地更新，提示词优化器 | 键直查 + 向量检索 + 元数据过滤 | **无内置时间版本**（冲突直接静默覆盖，[Cognee 分析](https://www.cognee.ai/langchain-memory)） | 取决于底层 `BaseStore`（Postgres/内存） | **第三方**：LoCoMo 58.10% J，p95 检索延迟高达 59.82s（[R10](https://arxiv.org/html/2504.19413v1)） | **高**（MIT Python SDK） |
| **Cognee** ([Cognee Blog](https://www.cognee.ai/how-cognee-builds-ai-memory)) | 统一 `DataPoint` 跨图（Ladybug）+ 向量（LanceDB）+ 关系库（SQLite） | 异步 ECL 流水线（`add`→`cognify`→`memify`） | `memify` 剪枝陈旧节点、按使用频率重加权边 | 14 种模式（图 CoT、混合、`TEMPORAL` 等） | 支持 `TEMPORAL` 时序实体检索与数据集溯源 | 默认嵌入式本地库，可扩展至 Neo4j/Neptune | **自报**：BEAM 100K 0.79 / 10M 0.67，LoCoMo ~91%；**第三方**：MemoryAgentBench 20.6（[R27](https://arxiv.org/html/2507.05257v4)） | **高**（Apache 2.0，零外部服务可本地跑） |
| **OpenAI ChatGPT Memory** ([OpenAI, 2026](https://openai.com/index/chatgpt-memory-dreaming/)) | 显式保存记忆 + Dreaming V3 后台合成摘要 | 会话中显式触发 + 后台周期性 Dreaming | Dreaming V3 定期合成可编辑摘要页，算力较前代降 5× | 专有内部机制（**未核实**） | Dreaming V3 显式追踪时间推移与行程过期 | 专有（**未核实**） | **第三方**（Dreaming V3 前旧版）：LoCoMo 52.90% J，但时序 F1 仅 14.04（[R10](https://arxiv.org/html/2504.19413v1)） | **无**（纯云端闭源） |
| **Google Gemini Memory** ([Shlok Khemani, 2026](https://www.shloked.com/gemini-memory)) | 结构化 `user_context` 文档（人口/偏好/关系/事件）+ 近期对话尾 | 周期性后台摘要 + 近期对话作实时增量 | 按「半衰期」分段刷新；删除源对话会同步裁剪派生记忆 | 注入系统提示词（仅限 Pro/思考模型），但带触发门控 | 每条记忆附带**日期与来源依据**，便于冲突裁决 | 专有（**未核实**）；依据元数据使体积翻倍 | **未核实** | **无**（纯云端闭源） |
| **Hermes Agent** ([Hermes Docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)) | `MEMORY.md` + `USER.md` + SQLite 会话库 | 会话中工具写 + 可选回合后后台审查分支 | 严格字符上限强制触发批量压缩；`/journey` 人工剪枝；防注入扫描 | **冻结快照**注入（保前缀缓存）+ 按需 SQLite FTS5 `session_search`（~20ms） | `/journey` 时间线；精确子串补丁更新 | `MEMORY.md` 限 2,200 字符（~800 token），`USER.md` 限 1,375 字符 | 后台审查号称省 3–5× 成本；标准基准 **未核实** | **极高**（MIT，纯本地桌面友好） |
| **HippoRAG 2** ([arXiv:2502.14802](https://arxiv.org/abs/2502.14802)) | 无模式 OpenIE 三元组短语节点 + 段落节点 | 离线批处理建图 | 同义词短语边链接（相似度 $\ge 0.8$）；无遗忘衰减 | 查询→三元组匹配 + LLM 识别过滤 + 个性化 PageRank（PPR） | 面向静态/增量语料，无时序失效 | LV-Eval 达 24 万节点/398 万边；`NV-Embed-v2` 建索引需约 60 GB 显存 | **自报**（ICML 2025）：7 项 RAG 基准均分 59.8 F1；**第三方**：MemoryAgentBench **41.6**（非长上下文方案最高，[R27](https://arxiv.org/html/2507.05257v4)） | **中**（开源，但高精版依赖大显存嵌入与 LLM） |
| **Nemori** ([arXiv:2508.03341](https://arxiv.org/abs/2508.03341)) | 双库：分段情景叙事（Episode）+ 语义知识（Semantic） | 在线语义边界切分 + 异步「预测-校准」提炼 | 借鉴自由能原理：仅提炼「现有语义记忆预测失败的差距」 | 统一稠密向量检索（Top-10 情景 + Top-20 语义） | 写入时预先将「昨天」等相对时间解析为绝对日期 | LoCoMo 检索上下文压缩至 2,745 token（降 88%） | **自报**：LoCoMo 0.744–0.794，LongMemEval_S 74.6%（超越全上下文基线 65.6%）；**第三方**：**未核实** | **高**（模型无关开源代码） |
| **EverMemOS** ([arXiv:2601.02163](https://arxiv.org/abs/2601.02163)) | `MemCell`（情景+原子事实+时效前瞻）聚类为 `MemScene` + 画像 | 在线边界切分 + 实时增量主题聚类 | 增量合并至场景（受相似度与时间跨度上限约束）；过期前瞻过滤 | 重构式回忆：原子事实 RRF（稠密+BM25）→ 选场景 → 重排 → 充分性重写 | 前瞻信号显式带 $[t_{\text{start}}, t_{\text{end}}]$ 有效区间 | 单对话约 70–110 个 MemCell，每次检索约 2.3k–2.8k token | **自报**：LoCoMo 93.05%，LongMemEval 83.00%（知识更新项 89.74%）；**第三方**：**未核实** | **高**（开源，支持本地 Qwen3 系列模型） |

### 3.2 记忆评测基准小结

**【事实】** 近两年记忆评测正从「单纯的长对话大海捞针」转向「动态更新、抗干扰与现实任务闭环」：

| 评测基准 | 会议 / 年份 | 核心考察维度 | 数据规模 | 已知局限（【事实】+【推断】） |
| :--- | :--- | :--- | :--- | :--- |
| **LoCoMo** ([arXiv:2402.17753](https://arxiv.org/abs/2402.17753)) | ACL 2024 | 超长多轮对话的五类 QA：单跳、多跳、时间推理、开放域、对抗拒答 | 评测集常用 10 段对话（每段 ~600 轮、~2.6 万 token），1,986 题（含 446 题对抗） | 2.6 万 token 已可被现代模型整窗塞入；不同厂商采用的 LLM 裁判提示词差异可造成约 10% 分数漂移（[Sentra, 2026](https://www.sentra.app/articles/longmemeval-benchmark)）。 |
| **LongMemEval** ([arXiv:2410.10813](https://arxiv.org/abs/2410.10813)) | ICLR 2025 | 五大记忆能力：信息抽取、多会话推理、时间推理、**知识更新**、**拒答（Abstention）** | 500 题；`_S` 版约 11.5 万 token/题，`_M` 版达 150 万 token | 合成对话主题多样性有限；商业记忆系统在该基准上往往比短上下文掉点约 30%。 |
| **MemoryAgentBench** ([arXiv:2507.05257](https://arxiv.org/abs/2507.05257)) | 2025 / v4 2026.06 | 增量多轮交互下的四大能力：精确检索、测试时学习、长程理解、**选择性遗忘** | 14 个任务共 2,071 题，上下文跨度 10.3 万–144 万 token | 包含合成注入的事实巩固集；第三方评测显示多数开源/商业记忆框架总分仅在 20–42 分之间，远低于长上下文基线（60.6）。 |
| **CL-Bench (Continual Learning Bench)** ([arXiv:2606.05661](https://arxiv.org/abs/2606.05661)) | 2026.06 (UC Berkeley / Snorkel) | 概念漂移与在线持续学习（SWE、射频、流行病、数据库、扑克、销售 6 域） | 6 个领域、12–120 个连续任务实例序列（共 300+ 实例） | 测试表明现有专用记忆系统（如 Mem0 增益 20.2%）在部分域甚至不如朴素上下文学习（ICL 增益 25.4%），暴露出「检索旧经验反而过拟合」的问题。 |
| **Harvey LAB** ([Artificial Analysis](https://artificialanalysis.ai/articles/harvey-lab-aa)) | 2026.05–07 | 真实长程法律 Agent 工作（并购数据室、法律备忘录、条款比对） | 公开样本 + 120 个私有测试任务，24 个执业领域 | 采用严苛的「全准则通过率（All-Pass）」，顶级模型仅 14.2%（单准则通过率 93.6%），且单题运行成本约 18.9 美元、耗时约 20 分钟。 |

---

## 4. 大型资料库的技术路线与本地选型

### 4.1 三类检索与知识组织范式的适用边界

**【事实】** 将用户导入的数千至数十万份文档（笔记、PDF、Office、网页、代码、图片）纳入 Agent 可用范围，业界主要存在三条技术路线：

| 路线范式 | 代表方案 | 建库算力与磁盘开销 | 查询延迟与 Token 消耗 | 实证效果对比 | 对 16GB 无独显 Windows 的适用性 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Agent 自主搜索**（`grep`/FTS + 逐文件读取） | LlamaIndex `fs-explorer`（[LlamaIndex, 2026](https://www.llamaindex.ai/blog/did-filesystem-tools-kill-vector-search)） | **零建库成本** | 高：5 篇论文平均耗时 **11.17s**（RAG 为 7.36s），文件增至百/千级时显著恶化 | 5 篇论文小规模下正确率 8.4 vs RAG 6.4；百至千篇规模下 RAG 在速度与正确率上反超 | **必备辅助层**（专攻代码仓库、精确报错码、刚修改的活跃文件） |
| **2. 混合向量 RAG**（FTS5 + 稠密向量 + 重排） | Contextual Retrieval（[Anthropic, 2024](https://www.anthropic.com/research/contextual-retrieval)） | 中等：1 次文档解析 + CPU 嵌入 | 低：本地检索 <50ms，端到端约 7s | 上下文嵌入+BM25+重排使 Top-20 失败率下降 **67%** | **最佳主干底座** |
| **3A. 重量级预建图/树**（GraphRAG / RAPTOR） | Microsoft GraphRAG（[arXiv:2410.05779](https://arxiv.org/html/2410.05779v3)）、RAPTOR（[arXiv:2401.18059](https://arxiv.org/abs/2401.18059)） | 极高：5GB 法律语料重构建图估算约 **3.3 万美元**（[Graph Praxis, 2026](https://medium.com/graph-praxis/graphrag-vs-hipporag-vs-pathrag-vs-og-rag-choosing-the-right-architecture-for-your-knowledge-graph-a4745e8b125f)） | 极高：GraphRAG 全局查询约 **61 万 token/次** | 全局归纳达 86%（基线 RAG 32%），但会拉低简单事实查找精度 | **不适用**（本地预算与增量更新不可承受） |
| **3B. 轻量/延迟预建表示**（LazyGraphRAG / LightRAG / HippoRAG 2 / Wiki） | LazyGraphRAG（[MSR, 2024](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)）、LightRAG（[arXiv:2410.05779](https://arxiv.org/html/2410.05779v3)）、HippoRAG 2（[arXiv:2502.14802](https://arxiv.org/abs/2502.14802)） | 低至中：LazyGraphRAG 建库成本仅传统 GraphRAG 的 **0.1%**；LightRAG 约 $0.15/文档 | LazyGraphRAG 查询成本较 GraphRAG 降 **>700×**；LightRAG 单次检索 **<100 token** | HippoRAG 2 多跳 MuSiQue Recall@5 达 74.7（基线 69.7）且不损简单问答 | **按需增量引入**：核心用混合 RAG，仅在跨文档专题整理时触发 Wiki 或轻量实体图 |

**【推断】** 结合 Anthropic 在 Stainless 语料（35 万文件）与 Harvey LAB 上的实验结论，可以确立一条清晰的**算力投入准则**：当用户问题属于「单文档定位、代码符号查找、精确数值查询」时，预建 Wiki 或知识图谱不仅浪费算力，还可能因抽象失真降低召回；只有当多个文档围绕同一长期项目/主题被反复跨文档综合（如文献综述、项目复盘、多合同比对）时，才值得触发后台 Dreaming 为该主题生成带逐字引用的 Wiki 索引页。

### 4.2 混合检索最佳工程实践与中英双语要点

1. **多路融合方式（RRF vs. 分数融合）**：**【事实】** 倒数排名融合（RRF，$1/(k+\text{rank})$，$k=60$）无需调参即可作为冷启动默认方案；但 OpenSearch 在六个 BEIR 数据集上的评测显示，RRF 平均 NDCG@10 比调优后的分数线性融合低 **3.86%**（[BigData Boutique, 2026](https://bigdataboutique.com/blog/hybrid-search-fusion-methods-compared)）。**【建议】** 冷启动采用 RRF，当平台积累了用户自建评测集后，切换为基于 $\mu \pm 3\sigma$ 归一化的凸组合融合（或直接使用 Cross-Encoder 重排 Top-30）。
2. **低成本上下文分块（确定性结构头 + Late Chunking）**：**【事实】** Anthropic 的上下文检索依赖 LLM 为每个分块写 50–100 token 说明，本地 CPU 无法承受百万分块的 LLM 推理。工程上推荐替代组合：（a）**确定性结构头**：在分块文本前强制拼接 `[文件名 > 一级标题 > 二级标题 > 表格标题]`（[DEV Community, 2026](https://dev.to/gabrielanhaia/rag-in-one-db-file-nodesqlite-plus-sqlite-vec-no-vector-database-2dl2)）；（b）**Late Chunking（延迟分块）**：利用支持 8K+ 上下文的双语嵌入模型先对整页/整节编码，再按分块边界做池化，在 BEIR NFCorpus 上可带来 **+6.5 nDCG@10** 增益且几乎不增加额外计算（[arXiv:2409.04701](https://arxiv.org/pdf/2409.04701)）。
3. **放弃本地 ColBERT 多向量索引**：**【事实】** ColBERT 为每个 token 保存向量，即便经 PLAID 残差压缩至 20–36 字节/token，500 万个 300-token 分块仍需 **30–54 GB** 向量存储且缺乏成熟的 Node.js/Windows 原生引擎（[arXiv:2205.09707](https://arxiv.org/html/2205.09707v1)）。**【建议】** 坚持「单向量 + FTS5 初筛 Top-30～50 + Cross-Encoder 重排 Top-8」的两阶段漏斗。
4. **中英混合（CJK）分词陷阱与解法**：**【事实】** SQLite FTS5 默认 `unicode61` 分词器不会切分连续汉字，导致中文长句被当作单个词元而无法局部匹配；内置 `trigram` 分词器虽支持子串匹配，但 1–2 个汉字的查询（如「测控」「锁」）在三元组索引下召回为 0（[SQLite FTS5](https://sqlite.org/fts5.html)；[OpenClaw #170997](https://github.com/openclaw/openclaw/issues/170997)）。**【建议】** 在 Node.js 入库阶段引入轻量 `jieba` 分词，将分词后的空格文本写入 FTS5 `unicode61` 影子列（例如将「电磁超声换能器」存为 `"电磁 超声 换能器"`），同时辅以 `trigram` 列处理英文代码标识符、型号与长子串 `LIKE` 检索。

### 4.3 本地可运行组件选型（Node.js / Windows 16GB 无独显）

#### A. 本地双语嵌入与重排模型

| 模型 | 参数量 / 上下文 | 量化体积（ONNX/GGUF） | 中英基准表现（【事实】） | 许可证 | Node.js CPU 运行时 | 推荐度 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`Qwen/Qwen3-Embedding-0.6B`** ([HF](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)) | 0.6B / 32K / 支持 MRL 32–1024 维 | GGUF `Q8_0` **639 MB**（[Willison, 2025](https://simonwillison.net/2025/Jun/8/qwen3-embedding/)） | CMTEB-R **71.02**、MTEB-Code **75.41**、MTEB-R **61.82**；ONNX CPU 约 6.2–15.3 QPS（[ONNX Bench](https://iam-tsr.github.io/blog/cutting-edge-onnx-embedding-models/)） | **Apache-2.0** | `node-llama-cpp` / `onnxruntime-node` | **首选嵌入模型**（支持 MRL 降维至 512 维，代码与中文俱佳） |
| **`BAAI/bge-m3`** ([HF](https://huggingface.co/BAAI/bge-m3)) | 568M / 8K / 1024 维 | FP32 ~2.2 GB；INT8 约 570 MB（**未核实**精确官方包） | MTEB **63.0**；ONNX CPU 约 9.7–27.8 QPS（[ONNX Bench](https://iam-tsr.github.io/blog/cutting-edge-onnx-embedding-models/)） | **MIT** | `onnxruntime-node` / `transformers.js` | **备选嵌入模型**（生态极熟，CPU 吞吐略高） |
| **`jinaai/jina-embeddings-v3`** ([arXiv:2409.10173](https://arxiv.org/html/2409.10173v3)) | 570M / 8K / MRL | 精确 ONNX 体积 **未核实** | 多语言 MTEB 优于 `e5-large-instruct` | **CC-BY-NC-4.0** | `transformers.js` | **不推荐**（非商业许可限制软件分发） |
| **`BAAI/bge-reranker-v2-m3`** ([HF](https://huggingface.co/BAAI/bge-reranker-v2-m3)) | 568M / 8K（CPU 建议截断 512） | INT8 ONNX **~570 MB**（bs=1 进程内存 ~2 GB，提速 1.8×，[Saegus HF](https://huggingface.co/Saegus/bge-reranker-v2-m3-onnx-int8)） | CMTEB-R **72.16**、MTEB-R **57.03** | **Apache-2.0** | `onnxruntime-node` | **首选重排模型**（INT8 量化成熟，内存可控） |
| **`Qwen/Qwen3-Reranker-0.6B`** ([HF](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B)) | 0.6B / 32K | 精确量化体积 **未核实** | MTEB-R **65.80**、CMTEB-R **71.31**、Code **73.42** | **Apache-2.0** | `node-llama-cpp` / `onnxruntime-node` | **强力备选**（英文与代码重排更强，待补测桌面端延迟） |

#### B. 可嵌入索引与存储引擎

| 引擎 | 许可证 | 检索结构与混合能力 | 内存与磁盘特征 | Node.js / Windows 成熟度 | 推荐定位 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **SQLite FTS5** ([sqlite.org](https://sqlite.org/fts5.html)) | Public Domain | BM25 倒排索引 | 极低内存；磁盘约原文 0.5–1× | **极高**（`node:sqlite` / `better-sqlite3` 内置） | **必选全文底座** |
| **`sqlite-vec`** ([GitHub](https://github.com/asg017/sqlite-vec)) | MIT / Apache-2.0 | 暴力扫描（支持 `float32`/`int8`/`bit` 量化） | 低内存；单 `.db` 文件统一事务 | **高**（提供 Win x64 预编译 `.dll`）；实测实用上限 **10 万–50 万向量** | **阶段 1 首选**（<20 万分块时免维护第二套存储） |
| **`@lancedb/lancedb`** ([Docs](https://docs.lancedb.com/search/hybrid-search)) | Apache-2.0 | 磁盘级 DiskANN/IVF-PQ + Tantivy 全文 + RRF | **低内存**（按需磁盘页加载） | **高**（官方 Rust N-API 原生包，无 `node-gyp` 编译痛点） | **阶段 2 首选**（迈向 50 万–500 万分块时平滑接管向量检索） |
| **`usearch`** ([GitHub](https://github.com/unum-cloud/usearch)) | Apache-2.0 | HNSW（支持 `f16`/`i8`/`b1`） | 支持 `mmap` 内存映射磁盘视图 | **中高**（偶发 Node ABI 预编译缺失） | **备选** |
| **DuckDB VSS / `hnswlib-node`** | MIT / Apache-2.0 | HNSW | 需全量图驻留内存；检查点重写慢 | **低**（DuckDB VSS 持久化仍属实验性；`hnswlib-node` Windows 需 VS 编译环境） | **不推荐** |

#### C. 本地文档解析与 OCR

| 文档类型 | 候选方案与许可证 | 16GB 无独显 Windows 可行性与性能（【事实】） | 选型结论（【建议】） |
| :--- | :--- | :--- | :--- |
| **数字版 PDF** | `pdfjs-dist`（Apache-2.0） | 纯 JS 解析，毫秒至秒级提取文本层与页码坐标 | **首选** |
| **Office 文档** | `mammoth`（BSD-2-Clause，`.docx`）+ `exceljs`（MIT，`.xlsx`）+ `officeparser`（MIT） | 纯 JS/TS，极低内存；注意避开存在已知安全漏洞的旧版 SheetJS `xlsx`（[OpenELIS #3313](https://github.com/DIGI-UW/OpenELIS-Global-2/issues/3313)） | **首选组合** |
| **图片与扫描件 OCR** | `ppu-paddle-ocr` / RapidOCR ONNX（Apache-2.0） | 通过 `onnxruntime-node` 跑 PP-OCRv4/v5 轻量模型，中英混排极佳 | **首选**（仅当 `pdfjs-dist` 单页提取不足 50 字符时按需触发） |
| **复杂版面解析器** | Docling（MIT，3.1s/页）、MinerU（商业受限，3.3s/页）、Marker（>16s/页）（[Particula Tech, 2026](https://particula.tech/blog/docling-vs-mineru-vs-marker-pdf-parser)） | 均为重型 Python/PyTorch 管线，内存占用 2–6+ GB | **不内置捆绑**；仅作为面向学术/财报 PDF 的可选外部 Python 扩展 |

### 4.4 规模扩展与工程治理（1 千 → 100 万文件 / 数十 GB）

1. **存储膨胀与内存控制**：**【事实】** 按 100 万文件约 500 万分块估算，若存 1024 维 `float32` 向量，仅原始向量即占 **20 GB**，叠加 HNSW 图结构达 30–40 GB，远超 16GB 笔记本内存上限。**【建议】** 对 `Qwen3-Embedding-0.6B` 启用 **MRL 截断至 512 维 + `int8` 标量量化**（每分块仅 512 字节，500 万分块压至 **2.56 GB**）；若需极速粗排，可附加 64 字节/分块的 1-bit 二值量化向量（500 万分块仅 320 MB，检索提速约 10 倍，精度损失 5%–10%，[Alex Garcia, 2024](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html)），再用 `int8` 或重排模型精排。
2. **两阶段分级建库与后台限速**：**【事实】** 纯 CPU 嵌入吞吐约 10–25 分块/秒，500 万分块全量向量化需 55–138 小时。**【建议】** 采用**快慢双轨管线**：快轨在导入瞬间完成文件哈希、文本提取与 SQLite FTS5 入库（>1,000 文档/分钟），保证用户几分钟内即可通过关键词搜索新资料；慢轨在 Node.js `worker_threads` 中以 `PRIORITY_BELOW_NORMAL` 优先级、最多占用 `Math.max(1, Math.floor(cpus/2)-1)` 个核心，优先为最近访问/活跃工作区的文件生成向量。
3. **增量更新、改名移动检测与去重**：**【事实】** Windows 文件监听 `@parcel/watcher` 依赖 `ReadDirectoryChangesW`，其内核缓冲区仅 64 KB，在 `git checkout` 或批量拷贝时可能丢失事件（`ERROR_NOTIFY_ENUM_DIR`，[Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw)）。**【建议】**（a）实时监听结合启动时/定时低频目录对账扫描；（b）利用 NTFS 下的 `fs.stat()` `(dev, ino)` 识别同盘改名移动，跨盘移动与全盘去重则通过 **BLAKE3 / xxHash64** 文件哈希匹配；（c）在分块级引入 `chunk_hash`，文档局部修改时仅重算变更分块的向量。
4. **断点续建与索引损坏恢复**：**【建议】** 在 SQLite 中建立持久化状态机表 `ingestion_queue`（`PENDING` → `PARSED` → `EMBEDDED` → `INDEXED`），每 500–1,000 个分块提交一次 WAL 事务（`PRAGMA journal_mode=WAL; synchronous=NORMAL;`），严禁将 SQLite 数据库置于 SMB 网络盘。将「分块原文 + 量化向量 BLOB」作为唯一持久化真相源，开机运行 `PRAGMA quick_check`；一旦 FTS5 或外部向量索引损坏，可直接从本地持久化数据无损重建，无需重跑耗时的 OCR 与嵌入推理。

### 4.5 预建表示（Wiki）的防膨胀、防幻觉与并发控制

**【事实】** Anthropic 与 2026 年学术界针对预建表示揭示了三大核心风险及对应解法：
1. **防「博尔赫斯地图」膨胀**：**【事实】** 周等人（2026）在 LoCoMo 上观察到 Agent 整理后的文件系统比原始文本还大 35%（136 KB vs 102 KB），而在强制压缩时若不加「保留全部事实」约束，准确度会从 77.6% 腰斩至 41.2%（[Zhou et al., 2026](https://arxiv.org/html/2607.26637v1)）。**【建议】** 对每个 Wiki 主题页设置硬性的**体积压缩比告警线**（如摘要体量不得超过关联原文分块总字节数的 20%），并区分「结构化索引（仅存标题+一句话摘要+原文指针）」与「跨文档综合结论页」，禁止将大段原文搬运进 Wiki。
2. **防幻觉累积与自我塌缩**：**【事实】** 无约束连续重写会导致模型性能跌破无记忆基线（[Zhang et al., 2026](https://arxiv.org/abs/2605.12978)），自写文本混入检索池会引发严重塌缩（[Graphite Research, 2026](https://arxiv.org/html/2608.22118v1)）。**【建议】** 任何进入 Wiki 的客观断言必须强制附带 `source_ref(doc_id, chunk_id, char_span, content_hash)` 与逐字短引；检索时默认将「原始资料库分块」与「派生 Wiki 页」分池评分，不让未经核验的派生页直接挤掉原始文档证据。
3. **防多 Agent 并发覆盖**：**【事实】** 单表多写会导致 28% 事实丢失（[Anthropic, 2026](https://www.anthropic.com/research/components-of-agent-memory)）。**【建议】** 实行「一页一责（Single-Owner Page）+ 乐观并发校验（`content_sha256` 前置条件）」，由主调度器将不同主题页分片派发给独立工作单元，最后由单一 `organizer` 合并跨页 `[[链接]]`。

---

## 5. 边界划分、长期维护、模型差异与安全隐私

### 5.1 经验记忆、资料库知识与历史会话的边界与协同（问题 D）

1. **存储架构：物理分区、统一路由**：**【建议】** 三者绝不可混存在同一张无区分的向量表里，应采用**同库分表 + 统一检索路由**。（a）**历史会话层**：只追加的原始对话与工具日志，供 FTS5 精确回溯与记忆 Agent 核对纠错；（b）**经验记忆层**：保持平台现有的三级记忆与状态机，承载用户偏好、决策、跨任务教训与工作流规则；（c）**资料库知识层**：承载用户导入的外部文档、代码与 OCR 文本分块，带文件元数据与 `untrusted_kb` 安全标记。
2. **层级注入与索引页维护**：**【建议】** 会话启动时的系统快照（≤2000 token 且 ≤3% 窗口）仅注入四类轻量内容：常驻核心偏好、当前工作区近期进展、高频避坑规则，以及一份不超过 300 token 的**「资料库与专题 Wiki 目录树摘要」**（告诉 Agent 库里有什么大类资料、有哪些现成专题页，而非把资料正文塞进快照）。
3. **冲突裁决优先级**：**【建议】** 当资料库陈述与经验记忆冲突时，按以下确定性优先级裁决并显式标注来源：
   $$\text{用户当场明说/已锁定记忆} > \text{近期已验证会话记录} > \text{经验记忆（带有效期）} > \text{外部资料库文档（按文件修改时间排序）}$$
   若资料库内部两份文档相互矛盾（如旧版需求文档 vs 新版设计稿），检索结果应同时返回两者的时间与路径，由模型提示用户或以新版为准，切忌静默覆写经验记忆。
4. **作用域与派生继承**：**【建议】** 沿用并扩展现有的 `全局 / 工作区 / 共享组 / 蝶君` 四级作用域：
   - **工作区资料库**：严格隔离在工作区命名空间内；**蝶君沙箱**默认只能读取显式授权挂载的目录及自身专属分区，不可越权扫描用户全盘个人文档。
   - **派生继承规则（铁律）**：任何从文档派生出的分块、向量、摘要或 Wiki 页，必须继承所有参与合成的源文档中**最严格的作用域与安全等级交集**（例如：只要一份 Wiki 综合了「蝶君私有笔记」与「工作区 A 文档」，该 Wiki 仅限同时拥有两者权限的上下文读取，严禁提升为全局可见）。

### 5.2 后台维护与正确性（Dreaming 工程化，问题 E）

1. **触发节奏、算力预算与优先级调度**：**【事实】** Letta Sleep-time Compute 证明在可预测场景下离线预计算可降低 2.5× 查询成本（[Lin et al., 2025](https://arxiv.org/html/2504.13171v1)），但 LightMem 的独立复现提醒离线整理的总体 Token 开销可能反超在线检索（[arXiv:2607.29104v1](https://arxiv.org/html/2607.29104v1)）。**【建议】** 为「记忆 Agent + 资料库整理」设立**每日/每周独立 Token 预算上限**，调度优先级按公式计算：
   $$\text{整理优先级} = \text{易变性权重} \times \text{近期访问频次} \times (1 + \text{近期被纠错/冲突惩罚})$$
   高访问且近期发生过用户纠正的「高频易变区」优先全量核对；长期未访问的冷数据仅做确定性程序检查，不消耗 LLM 预算。
2. **原文核对与自动化一致性检查**：**【建议】** 将维护任务严格拆分为**确定性程序检查（零 LLM 成本）**与**模型语义核对（按需触发）**：
   - **程序确定性完成**：死链检测（正则扫描 `[[slug]]` 与 `doc_id` 存在性）、文件变更哈希比对（源文档 `content_hash` 变动自动将关联 Wiki/记忆标为 `待复核`）、重复分块剔除（`chunk_hash` 去重）、TTL 过期扫描、压缩比超限告警。
   - **必须由模型完成**：语义矛盾识别（如新文档推翻旧结论）、跨文档主题抽象与合并、基于完整会话原文核对笔记真伪。
   - **「模型提议、程序校验提交」在大规模 Wiki 中的可行性**：**【推断】** 完全可行且是控制幻觉的必要条件。程序校验层应强制检查：（1）单次提交只允许修改授权的 `page_id`；（2）新增事实句必须附带合法的 `source_ref` 且对应原文子串确实存在于目标分块中；（3）净增删比例在合理阈值内，防止模型一次误删整页。
3. **大规模删除与遗忘传播**：**【事实】** 常规向量库与摘要层普遍存在删除残留（[OpenChamber, 2026](https://openchamber.dev/blog/agent-memory-research/)；[arXiv:2606.30306v1](https://arxiv.org/html/2606.30306v1)）。**【建议】** 建立**反向溯源表 `provenance_edges(source_id, target_type, target_id)`**：
   - 当用户删除某份文档或彻底遗忘某事时，程序在单事务内查询所有下游 `target_id`：直接物理删除对应的分块、FTS5 记录、向量条目、以及**仅由该源文档支撑**的记忆/Wiki 节点；
   - 对于由多份文档共同支撑的复合 Wiki 页，不直接删页，而是精准移除该源文档贡献的段落或将其状态置为 `待重算`，并立即将涉事内容哈希写入平台现有的**不可逆遗忘黑名单**，同步触发快照刷新，形成可审计的清除回执。

### 5.3 模型能力差异与自适应引导（问题 F）

1. **按模型能力自适应的 Harness 设计**：**【事实】** Zhou 等人（2026）证明，强模型（如 `gpt-5.4`）在 140 项任务后能将技能库收敛为 16 个高密度文件（89.3% 成功率），而弱模型则写出上百个碎片文件；且弱执行器读原始日志准确率骤降 21 个百分点（[Zhou et al., 2026](https://arxiv.org/html/2607.26637v1)）。**【建议】** 本平台应根据当前选用的模型能力档位（例如：Tier A 顶尖推理/前沿模型 vs Tier B 中等性价比模型如部分 DeepSeek/本地小模型）动态切换 Harness 策略：
   - **对 Tier A 强模型**：提示词仅说明记忆与资料库工具的用途及「仅记环境读不到的规律」，不限制固定写作模板；
   - **对 Tier B 弱/性价比模型**：（a）在提示词中强制加入显式工作流检查单（「回答前先调用检索并核对引用，写入前先验证假设」）；（b）注入结构化提炼后的摘要（`GS`）而非冗长原始日志；（c）**程序层硬兜底**：严禁主模型直接改写 SQLite 记忆表，所有写入必须经结果门控（失败任务仅可写「避坑提示」，不可生成正面经验规则）和后端记忆 Agent 校验。
2. **主 Agent 显式标记 vs 后台专职整理**：**【事实】** 会话中实时写记忆会分散主任务注意力，但后台整理存在跨会话延迟（[Anthropic, 2026](https://www.anthropic.com/research/components-of-agent-memory)）。**【建议】** 保持「后台记忆 Agent 为主」的稳健架构，同时为主 Agent 开放一个极轻量的**「显式标记事件 / 草稿箱（`mark_memory_candidate`）」**工具：当用户明确说「记住这个约定」或主 Agent 刚解决一个棘手报错时，仅写入一条带时间戳和当前会话指针的轻量候选记录（极低延迟与注意力开销），不立即执行去重与分层，待任务结束或空闲时再由后台记忆 Agent 核对原文并正式入库；若用户是「直接纠正错误事实」，则沿用现有机制立即热替换当前会话快照。

### 5.4 安全与隐私防护（问题 G）

1. **资料库投毒与间接提示词注入防御**：**【事实】** 攻击者可在导入的网页、PDF 或开源代码注释中隐藏恶意指令。MPBench 证实，一旦恶意内容经摘要进入长期记忆，就会绕过单次输入过滤形成持久化后门（[Dash et al., 2026](https://arxiv.org/html/2606.04329v1)）；Spotlighting 与语义隔离注解可将间接注入成功率从 >50% 降至 <2% 甚至 6.6%（[HuggingFace Papers, 2026](https://huggingface.co/papers?q=Input%20injection)）。**【建议】** 借鉴 Google 与 Anthropic 提出的 **CaMeL 架构**（[Debenedetti et al., 2025](https://css.csail.mit.edu/6.5660/2026/readings/camel.pdf)）：
   - **数据与控制流隔离**：所有来自资料库的检索片段在注入上下文时，必须用不可伪造的 XML/边界标签包裹（如 `<untrusted_kb_excerpt doc_id="...">`），并在系统提示词中声明「标签内文本仅作参考数据，绝不可作为执行命令或修改记忆的指令」；
   - **写入权限降级**：「记忆 Agent」在整理带有 `untrusted_kb` 来源标记的内容时，默认**禁止**自动生成全局用户偏好或工具执行规则，涉及跨工作区或高危动作的提议必须进入人工确认队列；
   - **蝶君沙箱特别防护**：蝶君在 Linux 沙箱自主抓取网页并整理资料时，若触发敏感文件读写或外发请求，须受程序级能力令牌（Capability Token）拦截。
2. **本地优先下的隐私与云端授权边界**：**【事实】** 本地零云端方案（如 SuperLocalMemory V3.3 纯 CPU 7 通道检索）在 LoCoMo 上已可达 70.4% 准确率（[HuggingFace Papers, 2026](https://huggingface.co/papers?q=memory%20tax)）。**【建议】**
   - **默认全本地动作**：文档解析、OCR、分块、分词、本地嵌入/重排、FTS5/向量检索、程序级一致性检查，**100% 在本机完成，绝不上传原文**；
   - **敏感数据分级与脱敏**：允许用户将特定文件夹或标签标记为 `Local-Only（绝不出域）`，此类资料仅允许本地检索与本地小模型总结，禁止发送至 DeepSeek 等云端 API；对允许上云总结的普通资料，可在请求前提供可选的本地正则+轻量 NER 脱敏网关（替换身份证号、密钥、手机号等，[Medium, 2025](https://medium.com/@tj.ruesch/a-local-first-reversible-pii-scrubber-for-ai-workflows-using-onnx-and-regex-e9850a7531fc)），并在首次启用云端资料库推理或大批量建库时弹出明确的成本与隐私授权提示。

---

## 6. 面向本平台的架构建议与分阶段路线

### 6.1 六层总体架构与数据流

在保留现有 Flutter + Node.js(TS) + Pi Agent SDK + SQLite 底座的前提下，建议将记忆与资料库扩展为如下六层架构：

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 6. 评测与可观测层：内生状态快照校验 + 端到端带引用问答 + 成本/过期率监控 │
├─────────────────────────────────────────────────────────────────────────┤
│ 5. 维护与安全层 (Dreaming / 记忆 Agent)：                                │
│    程序校验提交 | 溯源图级联删 | 预算与热度调度 | untrusted_kb 注入隔离    │
├─────────────────────────────────────────────────────────────────────────┤
│ 4. 注入与工具路由层 (Harness)：                                         │
│    - 会话初：冻结快照 (≤2000 tok: 核心记忆 + 资料库目录索引)              │
│    - 会话中：按模型能力自适应引导 + 显式标记候选 + 自主检索工具           │
├─────────────────────────────────────────────────────────────────────────┤
│ 3. 派生表示层（按需构建）：                                             │
│    轻量主题 Wiki 页（一页一责 + 逐字引用 + 压缩比 ≤20% + 严格作用域继承） │
├─────────────────────────────────────────────────────────────────────────┤
│ 2. 混合索引层：                                                         │
│    SQLite FTS5 (jieba+trigram) + sqlite-vec/LanceDB (512d int8) + 重排   │
├─────────────────────────────────────────────────────────────────────────┤
│ 1. 分区存储底座 (SQLite WAL + 本地文件)：                                │
│    [历史会话只追加原文] | [三级经验记忆库] | [资料库文档与分块+哈希]       │
└─────────────────────────────────────────────────────────────────────────┘
```

**核心数据结构草图（SQLite 增量扩展字段，非代码实现）**：
- `kb_documents(doc_id, scope, trust_level, file_path, file_hash, dev_ino, mtime, status, local_only)`
- `kb_chunks(chunk_id, doc_id, chunk_hash, heading_path, page_no, char_start, char_end, raw_text, jieba_tokens, vec_int8)`
- `kb_wiki_pages(page_id, scope, owner_topic, content_md, source_byte_ratio, content_sha256, status, access_count, last_verified_at)`
- `provenance_edges(source_type, source_id, target_type, target_id, relation, excerpt_hash)`

### 6.2 与现有记忆设计的衔接清单

| 模块 | 保留（不变或微调） | 修改（重构升级） | 新增（全新建设） |
| :--- | :--- | :--- | :--- |
| **三级记忆与状态机** | 保留近/中/长期分级、可信度、有效期、软/硬遗忘与批量撤销日志 | 放宽前端强模型提示词中的「固定类型限制」，将类型归类下沉至记忆 Agent 后台处理 | 增加「跨库矛盾标注」状态与 `provenance_edges` 溯源外键 |
| **记忆 Agent** | 保留「权限锁死、仅提操作、程序校验提交」的核心原则 | 将调度策略从纯固定周期改为「固定周期 + 热度/纠错惩罚优先级 + Token 预算熔断」 | 增加「拿完整会话原文核对笔记」及「按需维护轻量主题 Wiki」职责 |
| **会话快照** | 保留 2000 token / 3% 上限、任务边界刷新、防压缩复活、纠错热替换 | 将相关性计算从单纯「三元组文本相似度」升级为「FTS5 + 向量混合检索」 | 快照内新增约 200–300 token 的「资料库主题与 Wiki 目录索引」 |
| **主 Agent 能力** | 保留工作台审批控制与蝶君沙箱隔离 | 按接入模型能力（如 DeepSeek 不同版本/其他厂商）动态切换记忆引导提示词 | 新增 `search_kb`、`search_transcripts` 与轻量 `mark_memory_candidate` 工具 |

### 6.3 分阶段实施路线（MVP → 完整版）

| 阶段 | 核心目标 | 做什么（交付物） | 明确不做什么（防范围蔓延） | 验收测试标准 |
| :--- | :--- | :--- | :--- | :--- |
| **Phase 1: 混合检索基座 MVP** | 让工作台与蝶君能离线搜索「历史会话 + 资料库」，替换现有三元组匹配 | 1. 接入 `pdfjs-dist`、`mammoth`、`exceljs` 与 `jieba` 分词；<br>2. 建好 SQLite `FTS5`（会话原文+文档分块）与 `sqlite-vec`（`Qwen3-Embedding-0.6B` 512d `int8`）；<br>3. 实现快慢双轨后台入库与断点续建；<br>4. 升级记忆快照相关性检索，开放 `search_kb` 与 `search_transcripts`。 | **不做** OCR 扫描件；<br>**不做** 重排模型；<br>**不做** Wiki 预建表示；<br>**不做** LanceDB 迁移。 | 1. 1 万份中英混排文档 10 分钟内完成快轨 FTS5 建库；<br>2. 召回中英混合与 2 字中文短词 Top-10 命中率达标；<br>3. 强杀进程重启后从断点续建不重复嵌入；<br>4. 笔记本内存增量 < 1.5 GB。 |
| **Phase 2: 精度跃升与安全加固** | 解决复杂扫描件、排序精度、投毒防护与彻底遗忘 | 1. 接入 `ppu-paddle-ocr`（仅触发无文本页）与 `bge-reranker-v2-m3` INT8 重排 Top-30；<br>2. 上线 `untrusted_kb` 标签隔离与防注入提示词模板；<br>3. 落地 `provenance_edges` 级联删除与黑名单传播；<br>4. 记忆 Agent 接入完整会话原文核对与 `mark_memory_candidate` 候选池。 | **不做** 多跳知识图谱；<br>**不做** 跨文档全量 Wiki。 | 1. 扫描版 PDF OCR 后可正常检索引用；<br>2. 重排后自建评测集 NDCG@10 明显提升；<br>3. 植入隐藏注入指令的测试文档 100% 不触发越权工具与记忆写入；<br>4. 删除文档后 FTS5/向量/派生记忆残留率为 0%。 |
| **Phase 3: 跨文档 Wiki 与超大规模扩展** | 支撑数十万文件（几十 GB）及跨文档深度综合 | 1. 向量层平滑迁移至嵌入式 `@lancedb/lancedb`（支持磁盘索引）；<br>2. 上线按需触发的「单页单责、逐字引用」主题 Wiki（Dreaming 整理，压缩比 ≤20%）；<br>3. 上线作用域交集继承与 `Local-Only` 云端拦截网关；<br>4. 上线热度驱动整理调度与预算熔断器。 | **不做** 微软全量 GraphRAG 社区全图；<br>**不做** ColBERT 多向量索引。 | 1. 模拟 20 万+ 分块磁盘与内存占用稳定不卡顿；<br>2. 跨文档综合测试集得分与单题 Token 消耗较纯搜索有显著改善；<br>3. 连续多轮 Dreaming 不出现死链或体积膨胀失控。 |

---

## 7. 评测方案与自动化回归体系

### 7.1 面向用户真实资料库的自建评测集

1. **四类分层问题构造**：**【建议】** 从真实工作区抽取脱敏语料（笔记、PDF 论文、代码、对话），构造至少 80–120 题的本地基准集，覆盖四类场景：
   - **A. 单文档精确查找（30%）**：特定参数、报错码、某页条款（验证 FTS5 + 分块定位，监控是否被 Wiki 误导）；
   - **B. 跨文档综合（30%）**：横跨 3–5 份文档的方案对比、多期项目进展汇总（验证混合检索 + 主题 Wiki 价值）；
   - **C. 推理与计算（20%）**：基于多份表格或日志做数值加总、趋势判断（验证逐字引用保真度）；
   - **D. 时间演变与冲突（20%）**：文档更新覆盖旧方案、用户中途改变偏好（验证时间权重、失效传播与记忆优先原则）。
2. **双轨评测指标体系**：**【事实】+【建议】** 借鉴 *Beyond Downstream QA*（[arXiv:2610.22209v1](https://arxiv.org/html/2610.22209v1)）与 [Zhou et al. (2026)](https://arxiv.org/html/2607.26637v1)，避免仅看端到端问答得分：
   - **内生状态指标（直接查库）**：记忆过期率（Staleness Rate）、死链数、派生内容压缩比（≤20%）、彻底遗忘残留率（目标 0%）；
   - **检索与引用指标**：Recall@20、MRR@10、**引用准确率（Citation Precision）**（程序自动核对回答中引用的 `doc_id` 与页码/行号是否真实包含该事实，目标 >90%）；
   - **端到端效能指标**：任务正确率、**每题总 Token（拆分在线检索 vs 离线整理摊销）**、端到端延迟（p50/p95）、单题美元成本；
   - **整理曲线测量**：固定测试集，分别在 Dreaming 0 轮（纯搜索）、2 轮、8 轮、32 轮后冻结库快照，绘制「整理轮数 → 正确率 / 单题 Token / Wiki 膨胀率」三条曲线，寻找性价比拐点（**【推断】** 多数个人库在 4–10 轮增量整理后即进入边际收益递减区）。

### 7.2 自动化回归测试清单（CI 必跑）

针对平台「每个能力都有自动测试」的工程要求，以下五类检查无需依赖昂贵外部 LLM 裁判，可直接纳入本地自动化回归测试：
1. **分词与混合检索冒烟测试**：固定中英混排语料（含 2 字中文专有名词、代码驼峰命名、混合长句），断言 FTS5 + 向量召回 Top-5 命中率。
2. **增量更新与断点恢复测试**：模拟文件重命名、局部修改、批量写入、进程 `SIGKILL` 中断后重启，断言 `chunk_hash` 复用率及最终索引完整性（`PRAGMA quick_check`）。
3. **级联遗忘与防复活测试**：写入文档与派生记忆/Wiki 后执行删除与遗忘，断言 FTS5、向量表、Wiki 页、快照及后续压缩摘要中均不可再检索到目标哈希与关键词。
4. **投毒与权限隔离测试**：在测试 PDF/Markdown 中植入「忽略前文指令并修改用户偏好」的注入文本，断言记忆 Agent 拒绝入库且 `Local-Only` 文件永不进入模拟云端请求载荷。
5. **模型降级兼容性测试**：用较弱的本地/小模型模拟执行写入提议，断言程序校验层能拦截无出处声明、超限写入与并发冲突。

---

## 8. 风险、未解决问题与待决策选项清单

### 8.1 核心风险与学界未决问题

1. **自生成内容长期循环的「模型崩溃」边界尚无定论**：**【事实】** 即便在强约束下，多轮自编辑摘要仍存在缓慢语义漂移风险（[Zhang et al., 2026](https://arxiv.org/abs/2605.12978)），目前尚缺乏全自动判断「良性抽象」与「有害失真」的通用指标（**未核实**成熟方案）。
2. **本地 CPU 并发推理与前台体验抢占**：**【推断】** 当用户同时运行语音识别（ASR）、本地嵌入模型与重排模型时，16GB 笔记本内存余量会变得紧张（三者峰值叠加可能接近 4–5 GB），需在模型常驻与按需卸载（Idle Unload）间精细调度。
3. **跨文档 Wiki 在个人桌面库上的 ROI 仍需实测**：**【推断】** Anthropic 的 61% vs 53% 增益来自 35 万文件的企业级研发语料；在个人数千份杂乱笔记上，Wiki 能否稳定跑赢「混合检索 + 优质重排」仍有待 Phase 3 实测验证。

### 8.2 需要工程团队决策的选项清单

| 决策项 | 备选方案 A | 备选方案 B | 备选方案 C | 推荐与理由（【建议】） |
| :--- | :--- | :--- | :--- | :--- |
| **1. 向量存储起步方案** | 直接一步到位引入 `@lancedb/lancedb` | 先用 `SQLite + sqlite-vec`，超 20 万分块后再迁移至 LanceDB | 全程纯内存 `usearch` + 定期落盘 | **推荐 B（先 `sqlite-vec` 后 LanceDB）**。Phase 1 保持单 SQLite 文件，开发与事务一致性最简单；仅当用户库真正突破 20 万分块时再切换矢量层至 LanceDB。 |
| **2. 本地模型捆绑策略** | 随安装包强制内置嵌入 + 重排模型（增加约 1.2 GB 体积） | 安装包极简化，首次开启资料库功能时后台按需下载模型 | 不内置本地模型，强制要求配置云端嵌入 API | **推荐 B（按需后台下载）**。既守住「完全离线可用」底线，又避免初始安装包体积暴涨，且可依据用户机器内存动态推荐量化版本。 |
| **3. 资料库分块上下文增强** | 全量调用 DeepSeek 为每个分块生成 50–100 token 上下文头 | 仅拼接确定性结构头（`路径 > 标题链`）+ Late Chunking | 仅对用户标记为「核心/高价值」的文件夹启用 LLM 上下文头 | **推荐 B 起步，可选开启 C**。全量 LLM 增强对几十 GB 资料库成本过高且耗时；确定性结构头 + Late Chunking 零额外推理成本即可拿到大部分收益。 |
| **4. 资料库摘要/整理算力来源** | 严格纯本地小模型（如 1.5B–3B）完成所有整理 | 默认本地检索 + 由用户按工作区授权 DeepSeek 等云端模型做后台整理与 Wiki 构建 | 强制全部走云端模型 | **推荐 B（本地检索底座 + 授权后云端精整）**。16GB 无独显本机跑长文本综合整理速度过慢，将「可审阅脱敏的云端整理」设为受预算与隐私开关控制的可选增强最为务实。 |

---

## 9. 参考文献

- **R1** Anthropic Engineering. *The components of agent memory*. Nov 2026. [https://www.anthropic.com/research/components-of-agent-memory](https://www.anthropic.com/research/components-of-agent-memory) | 类型：技术博客/研究报告 | 证据强度：多组对照实验+案例 | **已核实**
- **R2** Anthropic Docs. *Using agent memory (Managed Agents)*. 2026. [https://platform.claude.com/docs/en/managed-agents/memory](https://platform.claude.com/docs/en/managed-agents/memory) | 类型：产品文档 | 证据强度：工程规范 | **已核实**
- **R3** Anthropic Docs. *Dreams (Managed Agents)*. Apr 2026. [https://platform.claude.com/docs/en/managed-agents/dreams](https://platform.claude.com/docs/en/managed-agents/dreams) | 类型：产品文档 | 证据强度：工程规范 | **已核实**
- **R4** Anthropic Cookbook & Quickstarts. *Dreaming with a dynamic workflow* & *Knowledge Wiki Quickstart*. Nov 2026. [Cookbook](https://platform.claude.com/cookbook/managed-agents-cma-dreaming-with-a-dynamic-workflow) / [GitHub](https://github.com/anthropics/claude-quickstarts) | 类型：开源项目/工程示例 | 证据强度：含实测成本耗时 | **已核实**
- **R5** Anthropic Docs. *How Claude remembers your project (Claude Code Auto Memory)*. 2026. [https://code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory) | 类型：产品文档 | 证据强度：工程规范 | **已核实**
- **R6** Anthropic Docs. *Memory tool* & *Context editing*. 2025–2026. [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) / [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) | 类型：产品文档 | 证据强度：工程规范 | **已核实**
- **R7** Anthropic Research. *Contextual retrieval in AI systems*. Sep 2024. [https://www.anthropic.com/research/contextual-retrieval](https://www.anthropic.com/research/contextual-retrieval) | 类型：技术报告 | 证据强度：有对照实验数据 | **已核实**
- **R8** Lin et al. (Letta & UC Berkeley). *Sleep-time Compute: Beyond Inference Scaling at Test-time*. Apr 2025. [arXiv:2504.13171](https://arxiv.org/html/2504.13171v1) | 类型：arXiv 预印本 | 证据强度：有对照实验数据 | **已核实**
- **R9** Letta. *Sleep-time Compute Blog*. Apr 2025. [https://www.letta.com/blog/sleep-time-compute/](https://www.letta.com/blog/sleep-time-compute/) | 类型：工程博客 | 证据强度：厂商说明 | **已核实**
- **R10** Chhikara et al. (Mem0). *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory*. ECAI 2025 / arXiv:2504.19413. [https://arxiv.org/abs/2504.19413](https://arxiv.org/abs/2504.19413) & [Mem0 Temporal Blog (2026)](https://mem0.ai/blog/introducing-temporal-reasoning-in-mem0) | 类型：论文/博客 | 证据强度：论文有对照（2026 博客为厂商自报） | **已核实**
- **R11** Rasmussen et al. (Zep). *Zep: A Temporal Knowledge Graph Architecture for Agent Memory*. Jan 2025. [arXiv:2501.13956](https://arxiv.org/abs/2501.13956) | 类型：arXiv 预印本 | 证据强度：有对照实验（厂商发表） | **已核实**
- **R12** Xu et al. *A-MEM: Agentic Memory for LLM Agents*. Feb 2025. [arXiv:2502.12110](https://arxiv.org/abs/2502.12110) | 类型：arXiv 预印本 | 证据强度：有对照实验数据 | **已核实**
- **R13** Kang et al. *MemoryOS: Personalized AI Agent with OS-Inspired Hierarchical Memory*. EMNLP 2025 Oral. [arXiv:2506.06326](https://arxiv.org/abs/2506.06326) | 类型：顶会论文 | 证据强度：有对照实验数据 | **已核实**
- **R14** LangChain. *LangMem Conceptual Guide*. 2025–2026. [https://langchain-ai.github.io/langmem/concepts/conceptual_guide/](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) | 类型：开源项目文档 | 证据强度：框架文档 | **已核实**
- **R15** Cognee. *How Cognee Builds AI Memory* & *Evaluation Results*. 2025–2026. [Architecture](https://www.cognee.ai/how-cognee-builds-ai-memory) / [Evals](https://www.cognee.ai/research-and-evaluation-results) | 类型：工程博客 | 证据强度：厂商自报数据 | **已核实**
- **R16** EverMind AI. *EverMemOS: Engram-Inspired Memory OS*. Jan 2026. [arXiv:2601.02163](https://arxiv.org/abs/2601.02163) | 类型：arXiv 预印本 | 证据强度：有对照实验数据 | **已核实**
- **R17** Nous Research. *Hermes Agent Persistent Memory Docs*. 2026. [https://hermes-agent.nousresearch.com/docs/user-guide/features/memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) | 类型：开源项目文档 | 证据强度：工程实现文档 | **已核实**
- **R18** OpenAI & Shlok Khemani. *ChatGPT Memory Dreaming (Jun 2026)* & *Gemini Memory Analysis*. [OpenAI](https://openai.com/index/chatgpt-memory-dreaming/) / [Gemini Analysis](https://www.shloked.com/gemini-memory) | 类型：产品博客/第三方逆向分析 | 证据强度：OpenAI 内部细节未核实，Gemini 为第三方分析 | **部分核实**
- **R19** Zhou et al. *Filesystem-Based Memory for LLM Agents: Organization, Evolution, and Sustainability*. Jul 2026. [arXiv:2607.26637](https://arxiv.org/html/2607.26637v1) | 类型：arXiv 预印本 | 证据强度：多模型/多数据集严格对照 | **已核实**
- **R20** Fang et al. *LightMem: Lightweight and Efficient Memory-Augmented Generation*. ICLR 2026. [ICLR PDF](https://proceedings.iclr.cc/paper_files/paper/2026/file/a05b72653ec5b473732129829ae04195-Paper-Conference.pdf) & [Reproduction Study (arXiv:2607.29104)](https://arxiv.org/html/2607.29104v1) | 类型：顶会论文+复现研究 | 证据强度：有对照且含独立复现修正 | **已核实**
- **R21** *Beyond Downstream QA: Evaluating Memory via Paradigm Inversion (FEB-30)*. Oct 2026. [arXiv:2610.22209](https://arxiv.org/html/2610.22209v1) | 类型：arXiv 预印本 | 证据强度：有对照实验数据 | **已核实**
- **R22** Jiayang et al. *AMEMGYM*. ICLR 2026. [ICLR PDF](https://proceedings.iclr.cc/paper_files/paper/2026/file/0856bc553d3e3b9827e5140d0ad3bf8d-Paper-Conference.pdf) | 类型：顶会论文 | 证据强度：有对照实验 | **已核实**
- **R23** Zhang et al. *Useful Memories Become Faulty When Continuously Updated by LLMs*. May/Aug 2026. [arXiv:2605.12978](https://arxiv.org/abs/2605.12978) | 类型：arXiv 预印本 | 证据强度：有对照实验数据 | **已核实**
- **R24** Graphite Research. *LLM Responses Collapse When Retrieved Documents Are Self-Authored*. Aug 2026. [arXiv:2608.22118](https://arxiv.org/html/2608.22118v1) | 类型：arXiv 预印本 | 证据强度：1,528 次模拟实验 | **已核实**
- **R25** *Position: Multi-Agent Systems Should Prioritize Concurrency Control* & *CoAgent*. 2026. [arXiv:2608.18092](https://arxiv.org/html/2608.18092v1) / [arXiv:2606.15376](https://arxiv.org/html/2606.15376v1) | 类型：arXiv 预印本 | 证据强度：框架与系统分析 | **已核实**
- **R26** Nan et al. *Nemori: Free-Energy Inspired Memory*. Aug 2025. [arXiv:2508.03341](https://arxiv.org/abs/2508.03341) | 类型：arXiv 预印本 | 证据强度：有对照实验数据 | **已核实**
- **R27** Hu et al. *MemoryAgentBench*. ICLR 2026. [arXiv:2507.05257](https://arxiv.org/abs/2507.05257) | 类型：顶会论文 | 证据强度：第三方多系统统一评测 | **已核实**
- **R28** Wang et al. *PACMI: Provenance-Aware Cascading Memory Invalidation*. Oct 2026. [arXiv:2610.05732](https://arxiv.org/pdf/2610.05732) | 类型：arXiv 预印本 | 证据强度：有消融实验 | **已核实**
- **R29** OpenChamber. *Agent Memory Research Meta-Analysis*. 2026. [https://openchamber.dev/blog/agent-memory-research/](https://openchamber.dev/blog/agent-memory-research/) | 类型：工程研究博客 | 证据强度：元分析综述 | **已核实**
- **R30** *A Survey of Persistent Memory, State, and Governance in LLM Agents*. Jun 2026. [arXiv:2606.30306](https://arxiv.org/html/2606.30306v1) | 类型：arXiv 预印本 | 证据强度：综述框架 | **已核实**
- **R31** Chen et al. *AgentPoison*. NeurIPS 2024. [NeurIPS PDF](https://proceedings.neurips.cc/paper_files/paper/2024/file/eb113910e9c3f6242541c1652e30dfd6-Paper-Conference.pdf) | 类型：顶会论文 | 证据强度：严格攻击实验 | **已核实**
- **R32** Zou et al. *PoisonedRAG*. USENIX Security 2025. [arXiv:2402.07867](https://arxiv.org/abs/2402.07867) | 类型：顶会论文 | 证据强度：严格攻击实验 | **已核实**
- **R33** Dash et al. *From Untrusted Input to Trusted Memory (MPBench)*. Jun 2026. [arXiv:2606.04329](https://arxiv.org/html/2606.04329v1) | 类型：arXiv 预印本 | 证据强度：3,240 例攻防实测 | **已核实**
- **R34** Debenedetti et al. (Google & Anthropic). *CaMeL: Defeating Prompt Injections by Design*. 2025. [PDF](https://css.csail.mit.edu/6.5660/2026/readings/camel.pdf) | 类型：技术报告 | 证据强度：架构设计+安全性证明 | **已核实**
- **R35** Gutiérrez et al. *HippoRAG 2: From RAG to Memory*. ICML 2025. [arXiv:2502.14802](https://arxiv.org/abs/2502.14802) | 类型：顶会论文 | 证据强度：有对照实验 | **已核实**
- **R36** Guo et al. *LightRAG: Simple and Fast Retrieval-Augmented Generation*. EMNLP 2025 / arXiv:2410.05779. [https://arxiv.org/html/2410.05779v3](https://arxiv.org/html/2410.05779v3) | 类型：顶会论文 | 证据强度：有对照实验 | **已核实**
- **R37** Microsoft Research. *LazyGraphRAG: Setting a new standard for quality and cost*. Nov 2024. [https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/) | 类型：研究博客 | 证据强度：厂商对比数据 | **已核实**
- **R38** LlamaIndex. *Did Filesystem Tools Kill Vector Search?* Jan 2026. [https://www.llamaindex.ai/blog/did-filesystem-tools-kill-vector-search](https://www.llamaindex.ai/blog/did-filesystem-tools-kill-vector-search) | 类型：工程博客 | 证据强度：小规模实测（大规模详表未核实） | **部分核实**
- **R39** Günther et al. (Jina AI). *Late Chunking: Contextual Chunk Embeddings Using Long-Context Embedding Models*. Sep 2024. [arXiv:2409.04701](https://arxiv.org/pdf/2409.04701) | 类型：技术报告 | 证据强度：BEIR 对照实验 | **已核实**
- **R40** SQLite. *FTS5 Extension Documentation*. [https://sqlite.org/fts5.html](https://sqlite.org/fts5.html) & *OpenClaw CJK Trigram Issue*. [GitHub #170997](https://github.com/openclaw/openclaw/issues/170997) | 类型：官方文档/开源 Issue | 证据强度：工程事实 | **已核实**
- **R41** QwenLM, BAAI, Saegus & ONNX Benchmarks. *Qwen3-Embedding-0.6B* ([HF](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)), *bge-m3* ([HF](https://huggingface.co/BAAI/bge-m3)), *bge-reranker-v2-m3-onnx-int8* ([HF](https://huggingface.co/Saegus/bge-reranker-v2-m3-onnx-int8)), *ONNX CPU Bench* ([Blog](https://iam-tsr.github.io/blog/cutting-edge-onnx-embedding-models/)). | 类型：模型卡/实测博客 | 证据强度：公开基准与实测 | **已核实**
- **R42** Alex Garcia (`sqlite-vec`) & LanceDB Docs. *sqlite-vec* ([GitHub](https://github.com/asg017/sqlite-vec) / [Blog](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html)) & *LanceDB Hybrid Search* ([Docs](https://docs.lancedb.com/search/hybrid-search)). | 类型：开源项目文档 | 证据强度：工程规范 | **已核实**
- **R43** Wu et al. *LongMemEval*. ICLR 2025. [arXiv:2410.10813](https://arxiv.org/abs/2410.10813) & *Sentra Benchmark Analysis* ([Sentra](https://www.sentra.app/articles/longmemeval-benchmark)). | 类型：顶会论文/评测分析 | 证据强度：基准规范 | **已核实**
- **R44** Maharana et al. *LoCoMo*. ACL 2024. [arXiv:2402.17753](https://arxiv.org/abs/2402.17753) | 类型：顶会论文 | 证据强度：基准规范 | **已核实**
- **R45** UC Berkeley / Snorkel & Artificial Analysis. *Continual Learning Bench* ([arXiv:2606.05661](https://arxiv.org/abs/2606.05661)) & *Harvey LAB-AA* ([Artificial Analysis](https://artificialanalysis.ai/articles/harvey-lab-aa)). | 类型：arXiv 预印本/评测报告 | 证据强度：基准规范 | **已核实**
