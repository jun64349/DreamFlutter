# Agent 模式：标准 / 极简（v0.2 阶段 3a）

按 DeepSeek Harness（dsh，`deepseek-ai/deepseek-harness`，提交 `ce7073d`，MIT）的标准预设和极简预设，在我们的 Pi 后台里复现两种 Agent 模式，让 DeepSeek 模型看到它训练和调优时的那套环境。**没有**接入 dsh 的运行时，所有会话仍然跑在 Pi 上。

调研报告：[research/deepseek-harness.md](research/deepseek-harness.md)。dsh 源码参考副本：`E:\claude\_ref\deepseek-harness`（稀疏检出，不在仓库里）。

## 两种模式

| | 标准 | 极简 |
|---|---|---|
| 系统提示词 | `You are an AI agent powered by DeepSeek Harness.` + `You are a coding agent powered by the {{model}} model.` + （计划模式时）计划规则 + 各工具的使用说明 | 只有 `You are a helpful software engineer assistant.` |
| 工具 | `pwsh`（每次新开进程，可后台运行）、`read`、`write`、`edit`、`glob`、`grep`、`read_image`、`working_directory`、`job_output` / `job_list` / `job_kill`、`todo_write`、`exit_plan_mode`、`ask_user_question`、`skill`、`web_fetch`；再加我们的记忆、技能建议、定时任务、会话搜索工具和 MCP | `pwsh`（一个一直开着的 PowerShell，变量和当前目录保留）、`read_image`、`working_directory` |
| 对话里追加的消息（只在变化时） | 工作区说明（AGENTS.md / CLAUDE.md）、技能目录、运行环境（当前目录）、时间（最多每 10 分钟一次）、计划模式切换的提示；记忆快照（我们的） | 只有运行环境（当前目录） |
| 工具结果裁剪 | 到压缩阈值时，先把超过 8192 字的工具输出裁成头 4096 + 尾 1024；裁完还超才压缩 | 无 |
| 压缩 | dsh 的阈值（`min(容量×0.8, 容量−输出上限−65536)`）、保留量（`(容量−输出上限)×0.16`）、dsh 的摘要指令和检查点格式 | 同左 |
| 重试 | 最多 5 次，500 毫秒起翻倍，最长 10 秒 | 同左 |

工具的参数、说明、返回格式、错误信息都照抄 dsh 原文（集中在 `core/src/agent/dsh-text.ts` 和各工具文件里，每处注明出处）。

## 代码

- `core/src/agent/harness.ts`：Pi 扩展，按模式替换系统提示词、注册工具、追加上下文消息、裁剪、压缩；`recordedMode()` 读会话的模式。
- `core/src/agent/fs-tools.ts`（read / write / edit / read_image / working_directory，含「先读后改」保护）、`search-tools.ts`（glob / grep，用 Pi 自带的 ripgrep）、`shell.ts`（两种 pwsh 和后台任务）、`interaction-tools.ts`（todo_write / ask_user_question / exit_plan_mode / skill）。
- `core/src/pi/host.ts`：会话创建时决定模式（会话里记录的 → 旧会话用标准 → 新会话用请求的或默认设置），只启用该模式的工具，压缩和重试设置来自后台和 dsh，**不再写用户的 Pi 设置文件**（以前每开一个会话都会改写一次 `~/.pi/agent/settings.json`）。
- 模式记在会话文件里（自定义条目 `df.agent_mode`），之后不变；换模式就新开会话。设置里的 `agentMode` 是新会话的默认值。定时任务总用标准模式（它要用 `schedule_state`）。
- 窗口：输入框里的「标准 / 极简」切换（会话已有内容时会新开会话）、计划模式开关（标准模式）、右栏的待办清单、计划审阅和提问对话框；设置页「Agent 模式」。

## 和 dsh 不完全一样的地方

1. **传输**：dsh 走 DeepSeek 的 Anthropic 兼容接口；我们沿用 Pi 的 OpenAI 兼容接口。Pi 1.4.0 已经正确回传思考内容（reasoning_content），真实测试里两轮带工具的对话没有出现 400。
2. **持久 shell**：dsh 用伪终端（PTY），我们用管道。命令用 base64 传进 PowerShell（Windows PowerShell 读标准输入用系统代码页，中文会乱码）；命令本身的执行方式和 dsh 的包装一致，所以**命令内部抛出的错误同样不显示**，只返回 `[exit code: 1]`（dsh 原样如此）。
3. **运行环境消息和时间**：dsh 在每一步（每次请求）判断是否需要追加；Pi 的扩展只能在每次提问开始时追加，所以 Agent 在一次运行中途切换目录后，新目录要到下一次提问才出现在运行环境里（工具结果本身已经告诉了模型）。
4. **工具结果裁剪**：dsh 把裁剪记录成会话里的替换；我们记下被裁剪的工具调用编号，每次请求前按同样规则裁剪，效果一致，会话文件里保留原文。
5. **长度上限时的停止**：Pi 在输出到达上限时的处理和 dsh 不同（Pi 可能把未完成的工具调用标成失败再继续），没有改。
6. **没有做的 dsh 工具**：子 Agent、工作流、目标追踪、插件管理、网页搜索、`present`；dsh 的 `schedule_*` 用我们自己的定时任务工具代替。
7. **标准 pwsh 的说明**：删掉了 dsh 原文里关于沙箱和 `$env:DSH_*` 变量的两句（我们没有这些）。
8. **审批**：沿用我们的审批，没有用 dsh 的沙箱。命令按内容分类：`Get-*`、`git status/log/diff`、`ls`、`cat` 之类只读命令直接执行，其他的问你。
9. **提问工具**：一次问一个问题，用窗口的选择对话框；多选题暂时按单选处理（可以自己填写回答）。

## 测试

- `core/test/agent-modes.test.ts`：两种模式的提示词和工具清单、上下文消息只发一次、换模式、不写 Pi 设置、先读后改、计划模式、待办、技能，以及读取/搜索/裁剪/压缩阈值/只读命令分类等格式。
- `core/scripts/live-modes.ts`：用真实 DeepSeek 跑小任务（修 bug 并运行、两轮追问）。2026-10-30 的结果：两种模式都通过，没有报错和重试；标准模式修 bug 19 秒，大部分输入命中缓存。

## Codex 审查（2026-10-30）

Codex 只读审查了这次的后台改动，报了 10 个问题，全部修复并加了回归测试（`agent-modes.test.ts` 的「review fixes」和「background job output」两组）：

1. 只读命令分类能被绕过（`Remove-Item -v`、`Write-Output (Remove-Item …)`、`git branch -D`）：现在含括号、花括号、方括号、脚本块的命令一律要审批；版本查询只认常见程序的单独 `--version`；`git branch/remote/tag` 只在纯列出时算只读；`rg --pre`、`-OutVariable` 也要审批。
2. 同一文件的并行编辑会丢修改：`write` / `edit` 按文件加锁，检查版本、读、写、更新观察在锁里完成。
3. 定时任务结束后，后台任务完成会自动开新一轮、绕开计划的工具限制：无人值守的会话里，后台任务完成只留通知，不自动开新一轮。
4. 命令输出全部留在内存：每个输出流内存最多 1 MB，超过 64 KB 时完整输出写到临时文件；持久 shell 每条命令开始时清空缓冲，单条命令最多留 400 万字符（头尾各一半）。
5. 后台任务的完成通知会把输出读走、却只显示「用 job_output 读」：现在只有通知里真的带了输出才算读过。
6. 压缩前裁剪时同一个工具结果被重复计算，可能错误地取消压缩：按工具调用编号去重，只看压缩后还保留的那部分消息。
7. 摘要请求发的是没裁剪的原文：摘要也用裁剪后的样子。
8. 持久 shell 不认负的退出码，会等满 5 分钟：已支持负数。
9. 工作区说明改过一次之后每轮都会重发：同时比较首次和替换两种写法。
10. 会话打开失败或中途取消时留下的内部句柄：已清理。

另外修了：手动「压缩」在短会话上提示「没有可压缩的内容」——dsh 的手动压缩不保留最近的内容（全部压成摘要），现在一致；压缩对话框里的「重点保留」会附在摘要指令后面。
