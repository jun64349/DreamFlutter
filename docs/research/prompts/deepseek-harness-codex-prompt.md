任务：研究 DeepSeek 官方开源的 agent 框架 DeepSeek Harness（dsh）的「标准模式（standard 预设）」和「极简模式（minimal 预设）」，对照我们的桌面 Agent 应用 DreamFlutter 的后台，写一份中文分析报告和改造方案，目标是让我们的 agent 在 DeepSeek 模型上表现更好。本次只读：不要修改任何文件，把完整报告作为你最后一条消息输出（Markdown）。

【dsh 源码（稀疏检出，只读参考）】C:\Users\21669\AppData\Local\Temp\claude\E--claude-DreamFlutter\af32413f-878e-4995-8168-193829b053a3\scratchpad\dsh-ref
重点文件：
- packages/bundle/web-app/presets/standard.patch.yml、minimal.patch.yml（两个预设的完整组成）
- packages/bundle/sdk-minimal/（README、src/index.ts、cordis.patch.yml：独立的极简两工具组合）
- .agents/notes/archived/bug-fix/2026-08-10-minimal-preset-owns-rl-composition.md、.agents/notes/archived/feature/2026-07-29-persistent-bash-str-replace-editor.md、2026-08-11-minimal-profiles-bare-two-tool-runtime.md、2026-08-10-minimal-read-image-tool.md（极简模式 = DeepSeek 模型 RL 训练时的环境组成）
- packages/shell/tool-bash-persistent、tool-pwsh-persistent、tool-bash、tool-pwsh（持久 shell 的工具描述、参数、超时、输出截断）
- packages/fs/tool-str-replace-editor、tool-fs、tool-fs-search（编辑器工具的确切 schema 和描述）
- packages/llm/llm-deepseek/src（adapter.ts、translate.ts、replay.ts、serialize.ts、request-extensions.ts、defaults.ts、models.ts：reasoning_content 如何回传、思考参数、缓存稳定性、空回复重试、图片处理等）
- packages/compaction/compaction-basic、compaction-tool-result-pruner（压缩策略和工具结果裁剪阈值）
- packages/preset/persona、packages/prompt/、docs/subsystems/system-prompt.md（系统提示词如何拼装，complete 模式、runtime context）

【我们的后台】E:\claude\DreamFlutter\core（Node 22 + TypeScript，进程内嵌 Pi SDK：@earendil-works/pi-coding-agent，源码在 core/node_modules/@earendil-works/pi-coding-agent，模型层是 core/node_modules/@earendil-works/pi-ai）
- core/src/pi/host.ts：createSessionRuntime，每个会话的 SettingsManager、扩展、资源加载
- core/src/app.ts、core/src/modules/*.ts（记忆快照注入、技能、任务、web_fetch 工具、调度器等扩展）、core/src/ext/approval.ts（工具审批）、core/src/ext/fallback.ts（备用模型）
- 用户的模型配置：~/.pi/agent/models.json 中 provider cc-switch-deep-seek，api 为 openai-completions，baseUrl https://api.deepseek.com/v1，模型 deepseek-flash（DeepSeek-V4.1-Flash，reasoning: true，支持图片）。不要读取或输出 apiKey。
- 运行环境是 Windows（PowerShell 为主，也有 Git Bash）
- 文档 E:\claude\DreamFlutter\docs\HANDOFF.md、docs\architecture.md 有整体架构

请回答并给出文件出处（路径 + 行号或函数名）：
1. 标准模式和极简模式分别让模型看到什么：系统提示词原文（极简模式是否就是一句 "You are a helpful software engineer assistant."、是否抑制 runtime context）、工具清单（名字、参数 schema、描述原文）、超时与输出截断、压缩和工具结果裁剪参数、计划模式/待办等。两者的定位差异（极简 = RL 训练时的组合）。
2. dsh 的 DeepSeek 适配器里对模型效果有影响的做法：思考内容（reasoning_content）在工具调用之间和多轮之间如何回传或丢弃；请求参数（thinking、temperature、max_tokens 等）；为提示缓存命中做的稳定性设计（工具目录跨模式不变等）；错误和空回复的重试；图片。
3. 我们现在通过 Pi 发给 DeepSeek 的是什么：Pi 默认系统提示词和我们追加的内容（记忆快照、技能列表等）、默认工具集（read/bash/edit/write/grep/find/ls 等）和我们加的工具、Pi 的 openai-completions 提供方对 DeepSeek reasoning_content 的处理（是否回传、是否会导致 400 或效果下降）、压缩设置。
4. 差距分析，以及给 DreamFlutter 的具体改造方案：
   a. 两种模式都适用的 DeepSeek 传输层修正（例如 reasoning_content 回传规则、缓存友好的提示词顺序）；
   b. 新增「Agent 模式」设置：「标准」（参考 dsh 标准预设：哪些工具、提示词结构、工具结果裁剪、压缩）和「极简」（尽量复刻 dsh 极简的 RL 组合：一句话系统提示词、持久 PowerShell/bash + str_replace_editor + 读图，不注入额外上下文），说明在 Pi 里用什么扩展点实现（自定义工具、替换系统提示词、关闭默认工具），以及与我们已有功能（审批、记忆、技能、书桌任务、定时任务）的关系和取舍；
   c. 需要改的文件清单、每处改动要点、要加的测试（core/test 里用 pi-ai 的 faux 假模型）、风险和验证方法（包括用真实 DeepSeek 对比两种模式的简单评测办法）。
报告要具体到可以直接照着实现，不要空泛的建议。

【补充要求（2026-10-30 第二次运行）】
- 用户的要求是：我们的 agent loop 要**严格按照** dsh 的标准模式和极简模式来设计（不是「参考」）。所以请把两种模式各自完整的 agent loop 讲清楚：每一轮请求怎么拼（system / messages / tools 的顺序和内容）、工具调用怎么执行和回填、思考内容怎么保留、什么时候裁剪和压缩、什么时候停止、出错怎么重试。然后逐条标出 Pi 能否做到同样的行为、做不到时用什么办法（扩展钩子、自定义 streamFn/provider、包一层、或者需要绕开 Pi 的哪一部分）。
- 上一次运行已经发现（可以直接沿用，再核实一下）：书桌目前由宿主管理，没有实际注册 desk_* 工具；Pi 的 setAutoCompactionEnabled() 会写入共享设置，不能直接用它做每个会话独立的模式开关，需要会话内设置隔离。
- 上一次运行在最后写报告时被中断，所以这次请控制节奏：先读重点文件，不要通读整个 node_modules；报告写成一份完整的 Markdown，长度在 6000～12000 字之间，最后一条消息必须是完整报告。
- 报告最后加一节「需要用户决定的问题」，列出实现前必须由用户拍板的取舍（例如极简模式下审批、记忆、技能怎么处理）。
