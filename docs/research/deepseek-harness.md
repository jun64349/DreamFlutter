> 2026-10-30 委派产出（Codex 只读调研），属待核验素材。用户据此做的决定见 [../v0.2-plan.md](../v0.2-plan.md) 第五节。

# DreamFlutter 对齐 DeepSeek Harness 的分析与改造方案

本报告基于 2026-10-30 的只读核查。未修改文件，未读取模型配置中的 API Key，未调用付费模型。结论来自源码与官方 API 文档，尚未通过真实请求抓包验证 DreamFlutter 当前会话。

源码记号：

- `D/`：用户提供的 `dsh-ref/`，提交为 `ce7073d51254c26cd63b22a60835b8f948deb447`。
- `C/`：`E:\claude\DreamFlutter\core/`。
- `P/`：`C/node_modules/@earendil-works/pi-coding-agent/dist/`。
- `A/`：`C/node_modules/@earendil-works/pi-ai/dist/`。

稀疏检出缺少的 dsh 核心文件，通过官方 GitHub 仓库的**同一提交**补充读取。

## 一、结论：先固定“严格对齐”的版本契约

**当前 dsh minimal、历史 RL 组合和用户期望的极简组合，已经不是同一套配置。** 实现前必须先确定基线，否则无法同时满足“严格按照当前 dsh”和“持久 shell＋编辑器＋读图、零上下文注入”。

| 项目 | 当前提交的 Web minimal | 归档笔记描述的历史 RL 组合 |
|---|---|---|
| 系统提示词 | 一句话，`complete: true` | 同一句话 |
| shell | Windows 持久 `pwsh`；POSIX 持久 `bash` | 持久 shell |
| `str_replace_editor` | **未注册** | 曾注册，后来移除 |
| `read_image` | 注册 | 后续独立增加的能力，不能据此推定所有历史阶段都包含它 |
| 自动压缩 | **启用** `compaction-basic` | bare runtime 阶段明确不启用 |
| 工具结果 pruner | 未挂载 | 不属于 bare runtime |
| runtime context | 抑制可选上下文 | 旧笔记描述为全部抑制 |
| 工作目录 | `working_directory` 工具及必需目录快照保留 | 不能直接沿用旧笔记推断当前行为 |

现行依据是 [minimal.patch.yml](C:/Users/21669/AppData/Local/Temp/claude/E--claude-DreamFlutter/af32413f-878e-4995-8168-193829b053a3/scratchpad/dsh-ref/packages/bundle/web-app/presets/minimal.patch.yml:11)、`D/packages/bundle/sdk-minimal/cordis.patch.yml:44`。历史依据是两篇归档笔记：

- `2026-08-10-minimal-preset-owns-rl-composition.md:16`：持久 shell、编辑器与 RL composition。
- `2026-08-11-minimal-profiles-bare-two-tool-runtime.md:16`：随后移除编辑器、不挂载压缩；该文件本身也已归档。

另一个需要纠正的判断是：**本项目安装的 Pi 1.4.0 已经支持 DeepSeek 思考内容回传。** 不能把改造建立在“Pi 必然丢弃 reasoning_content”这个前提上。

建议把标准、极简都定义为带版本号的运行契约：记录 dsh 提交、平台、工具目录、提示词组成、压缩和重试参数。采用当前提交时，极简应忠实保留目录工具、目录快照和自动压缩；若选择历史 RL 组合，应另行固定对应历史版本，而不是从几篇笔记拼装后宣称完全等价。

## 二、模型实际看到的提示词与工具

### 2.1 标准模式的系统提示词

标准模式没有一份与运行环境无关的完整常量。它由 persona、计划规则、各工具 guidance、宿主提示等按顺序拼装。

固定开场原文是：

```text
You are an AI agent powered by DeepSeek Harness.

You are a coding agent powered by the {{model}} model.
```

第一句来自 `packages/core/system-prompt/src/index.ts:460`；第二句来自 [standard.patch.yml](C:/Users/21669/AppData/Local/Temp/claude/E--claude-DreamFlutter/af32413f-878e-4995-8168-193829b053a3/scratchpad/dsh-ref/packages/bundle/web-app/presets/standard.patch.yml:14)，模型变量在组装时展开。

完整 system 的可执行定义是：

```text
按 order、name 排序：
Harness identity
→ persona prefix
→ 当前启用的 plan policy
→ 当前工具各自注册的 guidance
→ 文件交付等 guidance
→ 宿主来源、Web orientation
→ persona suffix
```

排序表见 [`packages/core/system-prompt/src/index.ts:136`](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/system-prompt/src/index.ts#L136)。例如编辑规则原文是：

> Read a file before editing it (the default fs-observation-policy requires it), unless you just created or edited it in this session.

出处：`D/packages/fs/tool-fs/src/edit.ts:77`。

工作区指令、技能目录、时间与运行环境，不能一概归入 system：

- `agent-instructions` 在 pre-step 插入用户角色消息，最大读取量 `65536` 字节；指令放在新用户输入之后、runtime context 之前。
- 工作目录、sandbox、approval 等通过 runtime context 贡献。
- 技能目录按内容摘要判断是否变化，首次或变化后作为用户角色消息提交；显式调用技能再追加完整技能内容。
- `time-context` 通过 pre-step 追加时间消息。

出处：`standard.patch.yml:15`；`packages/context/agent-instructions/src/index.ts:330`；`packages/skill/tool-skill/src/index.ts:217`；`packages/context/time-context/src/index.ts:199`。

因此，严格实现应复用这些贡献者及其排序。把 Pi 的 system 换成上述两句，仅完成了 persona 开场。

### 2.2 极简模式是否只有一句 system

**system 本身确实只有：**

```text
You are a helpful software engineer assistant.
```

`persona.complete=true` 在全部 cooperative waterfall 执行后恢复该 section，使它成为唯一 system section；不是在字符串前面追加一句。实现见 `D/packages/preset/persona/src/index.ts:62`、`packages/core/system-prompt/src/index.ts:659`。

但当前的 `includeRuntimeContext=false` **只过滤非 required 的动态上下文**。工作目录贡献标记为 `required:true`，内容为：

```text
Current working directory: "<当前绝对目录>".
```

出处：`packages/session/working-directory/src/index.ts:90、172`；`system-prompt/src/index.ts:678、689`。这条用户角色快照不是 system，仍然影响模型输入。

当前默认 minimal 的模型工具为：

```text
pwsh / bash（二选一）
read_image
working_directory
```

共享宿主还可能在有 MCP resource provider 时条件注册资源工具。严格复现默认目录时，需要同时固定这些条件。

### 2.3 标准模式的完整工具组成

以下 schema 使用 `!` 表示必填、`?` 表示可选；`s/n/i/b` 分别代表 string、number、integer、boolean。它是阅读用表达，正式发送时必须保留源码转换后的 JSON Schema、字段顺序、描述、枚举及 additionalProperties，不能把表格缩写发给模型。

标准 Windows 采用 `pwsh`；POSIX 用同位置的 `bash`。

| 工具 | 输入 schema |
|---|---|
| `pwsh`／`bash` | `description:s!`, `command:s!`, `timeoutMs:n?`, `workdir:s?`, `run_in_background:b?`；有 sandbox 时增加 `sandbox_permissions`、`justification` |
| `read` | `file_path:s!`, `offset:n?`, `limit:n?` |
| `read_image` | `file_path:s!` |
| `write` | `file_path:s!`, `content:s!`，条件增加 sandbox 字段 |
| `edit` | `file_path:s!`, `old_string:s!`, `new_string:s!`, `replace_all:b?`，条件增加 sandbox 字段 |
| `glob` | `pattern:s!`, `path:s?` |
| `grep` | `pattern:s!`, `path:s?`, `include:s?` |
| `working_directory` | `cd:s?` |
| `job_list` | `{}` |
| `job_output` | `job_id:s!`, `wait:b?`, `timeout_ms:n?` |
| `job_kill` | `job_id:s!`, `reason:s?` |
| `skill` | `name:s!` |
| `todo_write` | `todos:[{content:s!,status:pending\|in_progress\|completed} ]!` |
| `exit_plan_mode` | `plan:s!` |
| `ask_user_question` | `questions:[{id:s!,question:s!,header:s?,options:[{label:s!,description:s?}]?,multi_select:b?}]!` |
| `web_search` | `queries:s[]!` |
| `web_fetch` | `url:s!` |
| `present` | `files:[{path:s!,description:s?}]!` |
| `get_goal` | `{}` |
| `create_goal` | `objective:s!`, `max_goal_rounds:n?` |
| `update_goal` | `goal_id:s!`, `revision:n!`, `action:edit\|pause\|resume\|complete\|blocked!`；可选 `objective,max_goal_rounds,blocked_reason` |
| `schedule_create` | `title:s!`, `prompt:s!`, `rrule:s!`, `target:this_session\|new_once\|new!` |
| `schedule_list` | `active:b?`, `limit:i?`, `offset:i?` |
| `schedule_view` | `id:s!` |
| `schedule_edit` | `id:s!`, `action:update\|delete!`；可选 `title,prompt,rrule,target,active,expectedUpdatedAt` |
| `subagent` | `description:s!`, `prompt:s!`, `cwd:s?`；条件增加 `agent_preset,provider,model,reasoning_effort` |
| `subagent_fork` | 同委派基本字段，默认不开放模型选择参数 |
| `list_subagent_models` | `provider:s?`, `model:s?` |
| `send_message` | `agent_id:s!`, `message:s!` |
| `interrupt_agent` | `agent_id:s!` |
| `workflow` | `script:s!`, `meta:{name:s!,description:s!,whenToUse:s?,phases:[{title:s!,detail:s?,provider:s?,model:s?}]?}!`, `args:object?`, `run_in_background:b?` |
| `plugin_manager` | `action` 必填，支持列举、启停、安装、移除和版本豁免；可选 `target,enabled,runtimeVersion,acceptRisk,approvedBuilds,registry,offset,limit` |

`plugin_manager` 取决于 `profileContext`；plugin market 默认禁用；`apply_patch:false`。普通标准预设没有额外注册独立 `ls`、`find` 工具。

完整组成出处：`standard.patch.yml:21–130`。工具 schema 与描述原文的直接实现入口：

- 文件：`D/packages/fs/tool-fs/src/{read,read-image,write,edit}.ts` 的 `apply*Tool()`。
- 搜索：`D/packages/fs/tool-fs-search/src/{glob,grep}.ts` 的 `apply*Tool()`。
- shell：`D/packages/shell/tool-{bash,pwsh}/src/index.ts` 的 `bashDescription()`／`pwshDescription()`及 `defineTool()`。
- 其余：`packages/{jobs,skill,todo,plan,interaction,web,deliverables,goal,schedule,subagent,workflow}/` 对应 `tool-*` 的 `src/index.ts`；模型发现位于 `tool-subagent/src/list-models.ts`，插件管理位于 `packages/boot/plugin-manager/src/tools.ts:87`。

这些较长的描述应直接复用对应构造函数原文，包括 workflow 的脚本协议，不能用中文摘要替换。关键文件工具描述原文如下：

```text
read:
Read a UTF-8 text file and return line-numbered content.

write:
Create or fully replace a UTF-8 text file.

edit:
Edit an existing UTF-8 text file by replacing literal text.

read_image:
Read a PNG/JPEG/WebP/GIF file and return the image itself. Large images are
downscaled automatically; do not install image libraries or create thumbnails
to inspect an image.

web_search:
Search the web for current information. Returns an optional summary answer
and a list of source URLs.

web_fetch:
Fetch the content of a specific HTTP(S) URL and return it decoded to text.
```

标准 shell 描述还明确声明每次新建进程、使用 `workdir`、输出保留尾部并提供完整输出路径。Windows 描述包括 `$env:NAME`、自动变量、ConstrainedLanguage 和受限进程管道的注意事项，完整原文见 `tool-pwsh/src/index.ts:121–148`。

### 2.4 极简 shell 与编辑器的确切契约

极简 Windows `pwsh` 只有一个必填参数：

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The PowerShell command to run. Relative path is preferred in the command."
    }
  },
  "required": ["command"]
}
```

预设覆盖后的工具描述原文为：

```text
Run commands in a PowerShell shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* State is persistent across command calls and discussions with the user.
* Use native Windows paths (C:\...) and $env:NAME variables; this is PowerShell, not bash.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'Start-Job' or start a server with Start-Process.
```

POSIX `bash` 同样只有 `command:string`；描述另有 `sed -n 10,25p` 示例，网络描述为依任务环境而定。出处：`minimal.patch.yml:47–78`；`tool-pwsh-persistent/src/index.ts:427`；`tool-bash-persistent/src/index.ts:416`。

历史编辑器 `str_replace_editor` 的 schema 为：

```text
command!: string，enum=view|create|str_replace|insert
path!: string
file_text?: oneOf(string,null)
insert_line?: oneOf(integer,null)
new_str?: oneOf(string,null)
old_str?: oneOf(string,null)
view_range?: oneOf(array<integer>,null)
```

运行时再检查 command 对应必填项、绝对路径和行范围。它没有 `undo_edit`；字段名是 `old_str`，不是 Pi 的 `oldText`。

描述开头原文：

```text
Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If `path` is a file, `view` displays the result of applying `cat -n`. If `path` is a directory, `view` lists non-hidden files and directories up to 2 levels deep
* The `create` command cannot be used if the specified `path` already exists as a file
* If a `command` generates a long output, it will be truncated and marked with `<response clipped>`
```

后续原文要求 `old_str` 精确匹配且唯一，并说明 null 占位规则：未被当前命令使用的字段可为 null；删除匹配应省略 `new_str`，不能传 null。出处：`D/packages/fs/tool-str-replace-editor/src/index.ts:20、429`。

**这个工具可以复刻，但当前 minimal 没有挂载它。**

## 三、两种模式的完整 agent loop

两种模式使用同一个 `ReactLoopAgent`。差异来自预设挂载的工具、提示贡献者、压缩和外围服务，而不是两份互不相关的循环。

核心依据：[`packages/core/agent-loop/src/agent.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/agent-loop/src/agent.ts#L283) 的 `preStep()`、`step()`、`prepareRequest()`。

### 3.1 每一步请求如何形成

1. **打开 turn，领取 inbox。** 首步领取 next-step 输入及一个排队 prompt；工具续步只领取 next-step 输入。空首批不会消耗模型调用。
2. **固定本 step 的模型选择。** 解析工具集合，运行 system-prompt assembly，再执行 `agent/pre-step` waterfall。
3. **运行预设贡献者。** 标准模式处理工作区指令、技能目录、时间、运行环境和压缩；当前 minimal 没有这些标准贡献者，但保留必需目录 context 和 basic compaction。
4. **接受 step 后准备请求。** 执行 `agent/request`，调用 `prepareCall()`解析 provider 默认值、模型容量、输出上限和更新能力。
5. **提交模型可见输入。** 首次提交用户输入；按需更新 system surface node；runtime snapshot 仅在变化或被压缩移除后重发。日志先提交，下一请求从日志推导。
6. **构造请求。** 内部请求由 config、`deriveMessages()`及工具目录组成。工具默认按名称的 code-unit 顺序排序；prompt sections 按 order、name 排序。
7. **适配器序列化后发送。** 当前 dsh 使用 Messages API：初始 system 是独立 `system` 字段，历史放入 `messages`，工具放入 `tools`。相邻同角色消息合并，块内顺序保留。

因此，不能将“system/messages/tools 的顺序”理解成 JSON 对象键顺序。需要对齐的是：system 内容、消息数组和内容块顺序、工具声明顺序，以及动态更新的落点。

Flash 当前声明 `systemPromptUpdate:'in-history'`。持续请求序列中 system 非空变化会追加更新；序列被压缩或 surface replacement 打断时重新协调。Messages 序列化把更新安排在相应 user／tool-result 回合之后、下一 assistant 之前。

### 3.2 工具如何执行和回填

模型响应完整组装后，先持久化 assistant，再处理工具调用：

```text
assistant: thinking/text/tool_use[]
→ 完整工具批次送入受保护的执行管线
→ 参数、策略、审批与执行
→ 持久化每个 tool result
→ additionalContexts 进入 next-step inbox
→ 下一 step 重新推导请求
```

默认并发上限为 **10**，并行安全调用进入有界池，排他调用形成屏障；结果保持模型调用顺序。持久 shell 另外按精确 Agent owner 排队，避免同一 shell 的命令交错。

Messages 回填使用用户角色中的 `tool_result`，`tool_use_id` 必须对应原调用。序列化会拒绝重复 ID、无对应调用的结果，以及请求末尾尚未回填的工具调用。出处：`serialize.ts:131–146`。

工具失败通常变为模型可见错误结果；执行中发生宿主级异常时，未完成调用会补齐恢复结果：

- 已记录开始、没有结果：`TOOL_OUTCOME_UNKNOWN`。
- 尚未记录开始：`TOOL_NOT_STARTED`。
- 取消前未派发：`ABORTED_BEFORE_DISPATCH`。

未知结果不能被当作“未执行”自动重放。

### 3.3 什么时候裁剪、压缩

标准模式的工具结果裁剪**不是每次返回立即执行**。

在 step 边界，上下文计量达到阈值后：

```text
计量
→ 达阈值：pruneSession()
→ 重新计量
→ 仍达阈值：选择安全历史区间并摘要
→ 重新计量；必要时再压缩一次
```

pruner 参数：

```text
thresholdChars = 8192
headChars      = 4096
tailChars      = 1024
marker         = "\n\n[... tool result middle pruned ...]\n\n"
```

按 Unicode code point 跨 text blocks 计数，保留非文本块和顺序；用持久化 replacement 表达裁剪，保留原始日志。出处：`compaction-tool-result-pruner/src/index.ts:83、136`；`compaction-basic/src/index.ts:316`。

两种**当前模式**的 basic compaction 默认相同：

```text
thresholdRatio = 0.8
headroomTokens = 65536
retainRatio = 0.16
summary maxTokens = 65536
compactionRetries = 1
maxOverflowRetries = 1
auto = true
```

设容量为 C、有效输出预留为 M：

```text
threshold = floor(min(C × 0.8, C − M − 65536))
retain    = floor((C − M) × 0.16)
```

例如 C=1,048,576、M=256,000 时，阈值为 **727,040**，保留预算为 **126,812**。

当前 minimal 不挂 pruner，所以达到阈值后直接进入摘要流程。历史 bare RL 版本则没有该自动压缩流程。

摘要请求复用原对话的 system、tools、前缀历史，在尾部追加 compaction 指令；摘要落成带 `<compacted-summary>` 的用户角色 checkpoint。遇到 provider 确认的 context overflow，先做可用裁剪，再按不保留尾部预算的策略压缩，默认最多恢复一次。出处：`compaction-basic/src/{config,summarizer,region}.ts`。

### 3.4 什么时候停止、怎么重试

停止条件包括：

- 成功响应没有工具调用，且没有新的 next-step 输入。
- 工具批次明确 `concluded`。
- 达到 `max_tokens`。
- 取消或无法恢复的错误。

关闭前执行 `agent/turn-stopping`，它仍可追加下一步工作；标准模式的 goal 等能力可能据此延续。基础 loop 没有固定步数预算。

普通 provider 重试默认：

```text
最多 5 次
初始延迟 500ms，指数增长
最大 10000ms，抖动 ±10%
代码白名单：
EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT
```

重试复用已接受的 assembly，不重新领取用户输入、不重新执行已完成工具；失败 attempt 记入诊断日志，不作为成功 assistant 消息污染历史。默认 400 参数错误不在白名单中。

出处：`packages/llm/llm/src/retry-policy.ts:14`、`llm-retry/src/index.ts:190`。`translate.ts:149`只明确将“无 content block 且正常 stop”判为空回复，不能推断它会把所有“只有思考、没有答案”的响应自动重试。

## 四、DeepSeek 适配器中影响效果的设计

### 4.1 当前 dsh 已改用原生 Messages 传输

默认地址是：

```text
https://api.deepseek.com/anthropic/v1/messages
```

出处：`D/packages/llm/llm-deepseek/src/config.ts:116`、`messages-api.ts:14`、`adapter.ts:142`。它不是在 OpenAI Chat Completions 外面加几个参数。

流式 `thinking_delta` 进入 reasoning block，签名独立保存在 replay metadata；后续请求重新序列化为 `thinking` block，并恢复有效签名。正常换用户轮次不会清除这些 reasoning blocks。跨模型或损坏的 replay metadata 会降级，不能据此假设 reasoning 正文也被删除。

出处：`translate.ts:51、73`；`replay.ts:39`；`serialize.ts:26`。

如果继续使用 Chat Completions，当前官方规则是：**请求携带 tools 时，所有历史 assistant 回合的 reasoning_content 都应完整回传，包括没有调用工具的回合**；缺失会导致 400。无 tools 的普通聊天则不依赖历史思考内容。[DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)

因此不能应用旧版“遇到新 user 就清除之前思考”的策略。

### 4.2 参数与缓存

dsh 默认：

- 思考开启，effort=`high`；支持 `off/low/high/max`。
- `max_tokens` 优先级：请求显式值 → 模型值 → provider 默认 **256000**。
- temperature 仅显式指定时发送，没有统一设成 0。
- 普通流空闲超时 **300000ms**；sdk-minimal 的 profile 特别覆盖为 **172800000ms**。
- 原生格式使用 `thinking` 和 `output_config.effort`，不是机械复制 Chat Completions 字段。

缓存稳定性来自整个请求投影：

- 工具与 section 确定性排序。
- 动态目录、技能和时间追加到历史，减少改写 system 前缀。
- 标准模式的计划／执行切换保留同一工具目录。
- Flash 支持 in-history system 更新和 addition-only 工具更新。
- 摘要请求复用原对话前缀。
- request extensions 不可覆盖基础字段，HTTP 接受后才提交贡献者的投递状态。

**“工具目录跨模式不变”指标准预设内的计划／执行切换，不是 standard 与 minimal 两套预设工具相同。** 缓存本身是尽力命中，不能只凭字符串稳定就承诺命中率。[DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)

### 4.3 图片

`read_image` 保存并返回真正 image block，执行前检查当前模型支持图片；超大图片按预算缩放。当前 adapter 优先通过 Files API 引用，失败时回退内联；默认请求预算为文件图片 128MiB、内联 base64 20MiB、600 张。模型默认单图预算 2MiB、最长边 4096。

图片超预算有单独的 offload 决策和重试路径，不能全部归为文字上下文 overflow。出处：`read-image.ts:128、209`；`images.ts`；`request-pricing.ts:20`；`defaults.ts:10`。

## 五、DreamFlutter 当前经 Pi 发送什么

### 5.1 提示词、记忆和技能

[host.ts](E:/claude/DreamFlutter/core/src/pi/host.ts:98) 为每个 runtime 创建 SettingsManager 和资源加载器，并加载 codemode、tool-search、MCP 及 DreamFlutter 扩展。

没有用户覆盖时，Pi 开场原文是：

```text
You are an expert coding assistant operating inside pi, a coding agent harness.
You help users by reading files, executing commands, editing code, and writing new files.
```

随后生成 `<tools>`、`<rules>`、Pi 文档说明、addendum、项目指令、技能列表及 `<cwd>`。项目或用户 `SYSTEM.md` 等配置也可改变最终输入。出处：`P/core/system-prompt.js:68–129`。

DreamFlutter 的记忆通过 `before_agent_start` 注入隐藏的 custom message，**不是追加 system**：

- 包含常驻记忆块及相关记忆。
- 相关记忆默认预算 1500 tokens，最多 30 条；常驻块另行加入。
- 同一可见上下文已有快照时通常不重复，刷新请求或快照被压缩移除后可再次生成。
- 快照含日期，且写入数据库。

出处：[memory.ts](E:/claude/DreamFlutter/core/src/modules/memory.ts:312) 的 `snapshot()`和 `extension()`。

### 5.2 工具与审批

Pi 默认活跃内建工具为 `read/bash/edit/write`。`grep/find/ls/powershell` 在工具库中存在，但不能说所有会话默认都启用；`defaultTools`、扩展和 MCP 可改变最终目录。codemode 默认注册为 inactive，MCP 可激活它。

主要 schema 差异：

```text
Pi read:  path, offset?, limit?
Pi bash:  command, timeout?，单位秒，默认无超时
Pi edit:  path, edits:[{oldText,newText}]
Pi write: path, content
```

Pi `read` 兼任图片读取；默认文本截断约 2000 行／50KiB。dsh 的文件字段为 `file_path`，编辑协议也不同，不能只重命名工具。

DreamFlutter 额外注册：

```text
memory_search/save/update/forget/block_edit
session_search
skill_propose
schedule_state
schedule_create
web_fetch
```

出处：`C/src/modules/{memory,skills,scheduler,web}.ts` 的 `extensions()`。

**书桌由宿主管理，TasksModule 没有注册 desk_* 工具。** `approval.ts` 中列出 `desk_list/desk_read` 只是审批白名单，不代表工具存在。书桌的任务、素材整理和生命周期也不等于 dsh `todo_write`。

审批目前是 `tool_call` 钩子，默认 changes 模式，按工具名称判断只读；定时任务政策优先决定放行或拒绝。出处：`C/src/ext/approval.ts:43`；`scheduler.ts:753`。

### 5.3 reasoning_content 与压缩

当前 Pi 会：

1. 根据 provider 或 `baseUrl` 中的 `deepseek.com` 自动选择 DeepSeek 兼容逻辑，因此自定义 provider 名不会妨碍识别。
2. 将流式 reasoning_content 保存为 thinking block，并记录原字段名为 thinkingSignature。
3. 同模型重放时恢复字段；对其余 assistant 消息按兼容要求补空 reasoning_content。
4. 使用 system、max_tokens、DeepSeek thinking 格式。
5. 跨 provider／API／模型切换时丢弃 foreign thinking blocks。

出处：`A/api/openai-completions.js:390、1010、1055、1244`；`A/api/transform-messages.js:87`。

所以应新增回归测试验证完整回传，而不是直接修掉一段已存在的实现。补空字符串只能表达历史没有可用思考，不能修复真正丢失的正文。

Pi 默认 thinking level 是 medium，模型 `reasoning:true` 表示能力；会话仍可选择 off。实际 max_tokens 受模型配置和 `contextWindow−估计输入−4096` 限制。静态源码不能证明用户当前选中的 effort、最终输出上限或活跃工具快照。

Pi 自动压缩默认开启，阈值约为 `contextWindow−16384`，保留最近 20000 tokens；1.4.0 已有工具续步前的检查，但计量、摘要、保留和重试策略均不同于 dsh。

还有一个现有副作用：[core.ts:251](E:/claude/DreamFlutter/core/src/core.ts:251) 每次开 slot 调用 `setAutoCompactionEnabled()`；该方法最终修改 globalSettings 并 save。**独立 SettingsManager 实例不等于独立设置存储。**

## 六、严格对齐的实现方案

### 6.1 两种模式共用的传输层

新增 `DeepSeekTransport`，职责固定为：

- 区分 Messages 与 Chat Completions，分别序列化，不混用字段。
- 将思考正文、签名、来源模型和原始调用 ID 持久化；重启、fork、压缩后仍可重放。
- 明确 high/low/max/off 映射及输出预算。
- 统一 dsh 的错误分类、空回复判定、五次重试和取消语义。
- 保留图片 tool result、Files 回退和 offload。
- 暴露脱敏请求摘要：system／tools hash、历史长度、思考是否存在、缓存 token；不记录凭据。

继续走 Pi 的旧会话可以使用 `before_provider_request` 做检查，或通过 `registerProvider(...streamSimple)` 接入自定义传输。严格模式采用 dsh Messages adapter，并复用其 replay、序列化及工具增量投影。

### 6.2 Pi 能否做到同样的行为

| 行为 | Pi 扩展能力 | 严格对齐办法 |
|---|---|---|
| 精确替换 system | 可以 | `before_agent_start` 设置 `forceSystemPrompt`；普通 customPrompt 仍可能拼接额外 sections |
| 检查最终全部消息 | 可以 | `context_with_system`；普通 `context` 钩子之后 Pi 会恢复自己的 system/tools |
| 替换工具协议 | 可以 | 自定义 ToolDefinition；显式 allowlist；关闭默认工具及不需要的扩展 |
| 每会话资源隔离 | 可以 | 独立资源加载策略和内存 SettingsManager |
| 原生 Messages 与签名 | 可以定制 | 自定义 provider／streamSimple；payload 钩子本身不足以替换整个 SSE 解析器 |
| dsh pruner 的持久 replacement | 不能直接等同 | 独立 session surface 或维护受控 Pi 分支；context 临时删文本会造成日志与重放分离 |
| dsh 摘要、预算和事务 | 部分可接 | `session_before_compact` 可换摘要；完整时序和 replacement 仍需自有控制层 |
| 工具屏障、10 并发池、未知结果恢复 | 部分可接 | per-tool executionMode 可用；严格版复用 dsh executor |
| dsh max_tokens／结束语义 | 不完全相同 | 绕开 Pi agent loop。Pi length 响应会生成失败工具结果并可能继续 |
| dsh request-series、工具历史更新 | 通用 OpenAI 路由不等同 | 自定义 provider＋自有投影；严格版直接使用 dsh runtime |

扩展接口出处：`P/core/extensions/types.d.ts:679–725、1413`；`P/core/sdk.d.ts:26`；`P/core/resource-loader.d.ts:70`。停止差异见 `pi-agent-core/dist/agent-loop.js:160`。

### 6.3 推荐的运行时边界

**新增 DshSessionRuntime，让它掌管严格模式；保留 PiRuntime 支持已有会话。**

严格模式绕开：

```text
Pi AgentSession.prompt()
Pi agent-core 的循环驱动
Pi 自动压缩
Pi 通用 OpenAI transcript 投影
```

继续使用或桥接：

```text
模型选择与凭据管理
桌面 UI bridge、审批对话框
书桌、运行记录、通知、调度数据库
既有 RPC 和前端事件协议
```

首选在独立子进程中运行固定版本 dsh 核心，并挂载所选预设及对应服务。dsh 当前要求 Node ≥24.9，DreamFlutter 是 Node 22；独立 runtime 可以隔离此差异。若坚持单进程 Node 22，就需要移植兼容实现并逐项做差分验收，不能声称“接上 Pi 扩展即可完全等价”。

标准模式必须包含前述完整能力。`schedule_create` 的 RRULE、多目标和乐观并发，与现有“创建待审批定时提案”不同；`skill` 也不同于 `skill_propose`。应实现协议适配或复用 dsh 服务，不能用同名旧工具代替。

极简采用当前基线时，仅挂载当前 minimal 契约；采用历史 RL 基线时，则必须同时锁定编辑器、压缩、runtime context、文件系统和权限组成。

### 6.4 设置、模式切换与现有功能

模式保存到会话元数据：

```text
agentMode
harnessRevision
compositionVersion
platformShell
toolCatalogHash
```

fork、恢复、定时任务捕获这些值；运行中禁止切换。默认通过新会话切换，避免历史记忆、技能和 system 更新残留。

设置隔离可用：

```ts
const inherited = SettingsManager.create(cwd, agentDir, { projectTrusted });
const isolated = SettingsManager.inMemory(
  inherited.getSettings(),
  { projectTrusted },
);
```

同时移除开 slot 时写共享 Pi 设置的路径；资源重载需要重新读取基线并重建隔离实例。关闭 Pi 压缩和重试后，由 dsh runtime 单独管理，防止双重压缩和重试次数相乘。

功能关系应明确：

- **审批**：保留宿主安全边界。Web minimal 本来保留权限服务；sdk-minimal 的 danger-full-access、无审批不能自动套到桌面。新 `pwsh/read_image/str_replace_editor` 必须按参数动作分类，编辑器 view 与修改分开判断。
- **记忆**：严格标准也没有 DreamFlutter 记忆工具。保留注入和工具就属于附加组成；严格极简关闭主动注入。
- **技能**：标准按 dsh 的目录快照＋skill 工具实现；极简关闭技能发现、自动展开和 skill_propose。
- **书桌**：任务存储、状态和通知可继续；自动素材提示会改变模型输入，应显式定义。todo 与书桌任务分开保存。
- **定时任务**：由宿主启动对应模式；不能暗中给极简加 schedule_state 等工具。无人值守的 shell 权限必须预先有确定政策。
- **备用模型**：严格 DeepSeek 评测固定路由；切换模型会改变思考重放、容量和缓存，应记录为降级事件。
- **MCP、codemode、用户扩展**：严格模式采用允许清单，防止隐藏工具仍通过编排工具被调用。

## 七、文件改造清单

| 文件 | 改动要点 |
|---|---|
| `C/src/pi/host.ts` | runtime 选择；隔离设置；按模式加载资源和扩展；不再隐式加载全部 built-ins |
| `C/src/core.ts` | 移除共享压缩设置写入；传递、恢复模式元数据 |
| `C/src/slots/slot.ts` | 从直接依赖 AgentSession 改为 runtime facade；映射取消、重放、压缩、模型切换 |
| 新增 `src/agent/runtime.ts` | 统一 prompt、abort、events、history、model、compact、dispose 接口 |
| 新增 `src/agent/dsh-runtime.ts` | dsh 子进程生命周期、会话绑定、事件转换 |
| 新增 `src/agent/compositions.ts` | 固定两种组成、版本、工具／提示 hash |
| 新增 `src/agent/deepseek-transport.ts` | 原生传输桥接及测试注入 seam |
| 新增 `src/agent/session-settings.ts` | 会话内设置和 reload 行为 |
| `src/ext/approval.ts` | 新工具及 command 级动作分类；复用桌面审批呈现 |
| `src/ext/fallback.ts` | 严格模式路由政策及降级记录 |
| `src/modules/memory.ts`、`skills.ts` | 依据组成控制注册与注入，不能只隐藏 UI |
| `src/modules/tasks.ts`、`scheduler.ts` | 保存模式；分离宿主状态与模型上下文；补齐 dsh 调度协议适配 |
| `src/modules/web.ts` | 避免与 dsh web_fetch 同名不同 schema |
| `src/settings.ts`、`schema.ts` | 默认模式、版本化会话／调度元数据及迁移 |
| Flutter 设置与控制器 | 展示模式、会话生效范围及功能可用性 |

若移植工具而非运行原包，再增加独立 tools、compaction、session-surface 模块；不修改 node_modules。

## 八、测试、风险和真实评测

### 8.1 无 Key 测试

复用 [core/test/harness.ts](E:/claude/DreamFlutter/core/test/harness.ts:34) 的 `createFauxCore()`、`fauxAssistantMessage()`、`fauxToolCall()`，在 streamSimple 外包一层记录输入。faux 用于验证循环；最终 wire 与 SSE 另做 mock fetch 测试。

必须新增：

1. **组成快照**：两模式的 system、全部工具名称／schema／description 与 dsh 基准一致；计划切换工具目录不变。
2. **输入隔离**：启用记忆、技能、MCP、项目指令后，极简只出现选定契约允许的消息；当前契约应保留目录快照。
3. **思考重放**：思考→工具→思考→工具→答案→新 user；每次请求保留正确正文、签名、ID，重启后相同。
4. **shell**：跨调用和用户讨论保留 cwd、变量、函数；跨 slot 隔离；并发排队；取消、超时、异常退出后重置；检查 300 秒和 16000 字符边界。
5. **编辑器**：唯一匹配、删除、null 占位、绝对路径、CRLF、中文路径、制表符、insert 边界。
6. **裁剪／压缩**：阈值未到不裁剪；达到后先 prune 再计量；8192／4096／1024 按 code point；图片保留；摘要保留调用配对和安全切点。
7. **停止／恢复**：max_tokens 不执行工具；未知结果不盲目重试；取消期间不继续请求；失败 attempt 不重复用户输入。
8. **设置隔离**：两个 slot 设置不同；关闭、恢复、重载后互不影响，用户 Pi 设置文件字节不变。
9. **权限与调度**：交互拒绝、无人值守拒绝、允许清单、模式继承及同名调度 schema 冲突。

验收应与固定 dsh runtime 做相同输入的差分测试。允许归一化随机 ID、时间和临时路径，不能归一化提示词、工具描述、思考正文和错误类型。

### 8.2 真实 DeepSeek 简单对比

准备六个小型、可重复的隔离任务：

- 连续两轮工具调用，第二轮追问，检查 reasoning 400。
- 小仓库定位并修复一个错误，以现成测试判定完成。
- 长搜索输出中定位证据并准确引用行号。
- 两轮修改与验证，检查 shell／目录语义。
- 读取固定图片并回答可客观判分的问题。
- 计划审批后实施，检查批准前不修改及目录缓存稳定性。

比较现有 Pi、dsh 标准、选定极简三组；每项跑三次，共 54 个任务会话。固定模型版本、effort、代码起点和权限，随机执行顺序。

记录成功率、400／空响应／重试、工具错误、总耗时、输入输出 tokens、缓存命中、费用及审批次数。真实长上下文压缩另设专项，不用短任务通过来代替。

主要风险是：混用历史版本、Windows PTY 与 native 依赖、权限语义偏移、两套日志投影不一致，以及在已有长会话中切模式造成上下文污染。上线顺序应为：先固定契约和快照，再接传输与 runtime，最后接桌面功能。

## 九、需要用户决定的问题

1. **极简版本基线**：严格采用当前 dsh minimal，还是历史 RL 组合？当前包含自动压缩和目录快照，没有编辑器。
2. **极简工具与上下文**：是否坚持“shell＋str_replace_editor＋读图、零注入”？若坚持，应将其定义为固定的产品组成，明确它与当前 dsh 的差异。
3. **运行方式**：是否接受为严格模式随应用携带独立 Node ≥24.9 dsh runtime？坚持 Node 22 单进程会增加移植和差分验证成本。
4. **审批政策**：采用 Web 的 sandbox＋审批，还是已有 changes/all 政策？极简 shell 的长期授权和无人值守权限需要单独确定。
5. **记忆和技能**：严格模式是否完全关闭 DreamFlutter 附加工具与主动注入？后台记忆候选抽取是否继续运行？
6. **兼容范围**：是否保留旧 Pi 会话运行时，并让模式切换默认新建会话？现有历史应继续按原 runtime 恢复。
7. **预算与降级**：是否采用 dsh 默认 256000 输出上限和固定 DeepSeek 路由？降低上限、自动切备用模型都应作为显式配置记录并重新评测。