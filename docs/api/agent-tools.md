# Agent 工具

工具参数由 Pi 的 tool schema 校验，执行返回 content 数组与 details 对象。错误可能是工具失败、带说明的正常文本或等待用户批准的结果。工具不走窗口的 JSON-RPC 调用。

- 标准工作台以宿主工作区为工具环境。标准蝶君以沙箱为环境，使用 Bash、Python 和作业输出。
- 最小模式的 harness 工具为 pwsh、read_image、working_directory。标记为 modelFacing 的模块不向最小模式装载。
- 激活列表还随计划模式、沙箱联网、只读范围、信任、审批、模型能力、子会话、记忆设置、定时运行及目标状态变化。列出工具仅表示存在定义。动态 MCP 工具由已配置且启用的服务提供，蝶君另需允许。
- 标准工作台和蝶君均注册 Git 工具。工作台按宿主审批策略运行，蝶君使用沙箱仓库与路径范围。普通工作台会话的注册表可包含 `autonomy_draft_rule` 和 `goal_*`，实际轮次按各工具的适用条件激活。最小模式可能登记目标工具，普通对话只激活三种基础工具。
- 任务模板会加入 Pi 命令，技能可在实际会话的资源列表出现。以上两类不是固定的工具名。

## agent

- **用途** 派给子 Agent 一项独立工作。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** `description: string`、`prompt: string`（必填）；`role?: string`，其余见工具 schema。
- **返回** 子 Agent 结果、用量和执行详情。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/subagents.ts:94](../../core/src/modules/subagents.ts#L94)

## ask_user_question

- **用途** 向用户提出待答问题。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** questions: object[]。问号表示可省略，完整 schema 见源码。
- **返回** 用户选择或输入，扩展交互期间等待。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/interaction-tools.ts:127](../../core/src/agent/interaction-tools.ts#L127)

## autonomy_draft_rule

- **用途** 起草待用户确认的自主规则。
- **调用方** Agent 工具，蝶君。
- **参数** RuleDefinition 对象。问号表示可省略，完整 schema 见源码。
- **返回** 确认 ID 和提示，推送 confirm.changed。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/autonomy/index.ts:320](../../core/src/modules/autonomy/index.ts#L320)

## bash

- **用途** 在蝶君沙箱执行 Bash。
- **调用方** Agent 工具，蝶君。
- **参数** command: string；description?、timeout? 等。问号表示可省略，完整 schema 见源码。
- **返回** 输出、退出结果或后台作业 ID。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/sandbox-shell.ts:157](../../core/src/agent/sandbox-shell.ts#L157)

## edit

- **用途** 按指定原文片段局部编辑。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** file_path: string；改动文本参数见工具 schema。问号表示可省略，完整 schema 见源码。
- **返回** 修改结果或匹配失败信息。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/fs-tools.ts:178](../../core/src/agent/fs-tools.ts#L178)

## exit_plan_mode

- **用途** 把计划送给用户审阅。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** plan: string。问号表示可省略，完整 schema 见源码。
- **返回** 批准或继续修改的结果，可更新 df_agent_state。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/interaction-tools.ts:188](../../core/src/agent/interaction-tools.ts#L188)

## git_branch_create

- **用途** 新建本地分支。
- **调用方** Agent 工具，工作台和蝶君，按宿主审批或沙箱仓库范围。
- **参数** name: string。问号表示可省略，完整 schema 见源码。
- **返回** 分支创建结果。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [git/tools.ts:7](../../core/src/git/tools.ts#L7)

## git_branches

- **用途** 列出本地分支。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** 无。问号表示可省略，完整 schema 见源码。
- **返回** 分支与当前分支。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [git/tools.ts:7](../../core/src/git/tools.ts#L7)

## git_commit

- **用途** 提交当前已暂存内容。
- **调用方** Agent 工具，工作台和蝶君，按宿主审批或沙箱仓库范围。
- **参数** message: string。问号表示可省略，完整 schema 见源码。
- **返回** 提交 ID 或失败说明。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [git/tools.ts:7](../../core/src/git/tools.ts#L7)

## git_diff

- **用途** 查看 Git 改动。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** staged?: boolean；paths?: string[]。问号表示可省略，完整 schema 见源码。
- **返回** 差异和文件。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [git/tools.ts:7](../../core/src/git/tools.ts#L7)

## git_history

- **用途** 查看本地 Git 历史。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** limit?: integer（1–100）。问号表示可省略，完整 schema 见源码。
- **返回** 提交列表。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [git/tools.ts:7](../../core/src/git/tools.ts#L7)

## git_recover

- **用途** 从持久恢复点恢复。
- **调用方** Agent 工具，工作台和蝶君，按宿主审批或沙箱仓库范围。
- **参数** id: string；abortRevert?: boolean。问号表示可省略，完整 schema 见源码。
- **返回** 恢复结果。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [git/tools.ts:7](../../core/src/git/tools.ts#L7)

## git_recovery_points

- **用途** 列出已有 Git 恢复点。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** 无。问号表示可省略，完整 schema 见源码。
- **返回** 恢复点列表。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [git/tools.ts:7](../../core/src/git/tools.ts#L7)

## git_revert

- **用途** 创建反向提交。
- **调用方** Agent 工具，工作台和蝶君，按宿主审批或沙箱仓库范围。
- **参数** commit: string。问号表示可省略，完整 schema 见源码。
- **返回** 回退结果或冲突。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [git/tools.ts:7](../../core/src/git/tools.ts#L7)

## git_stage

- **用途** 暂存指定相对路径。
- **调用方** Agent 工具，工作台和蝶君，按宿主审批或沙箱仓库范围。
- **参数** paths: string[]。问号表示可省略，完整 schema 见源码。
- **返回** 暂存结果。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [git/tools.ts:7](../../core/src/git/tools.ts#L7)

## git_status

- **用途** 查看本地 Git 状态。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** 无。问号表示可省略，完整 schema 见源码。
- **返回** 分支、HEAD、文件及操作状态。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [git/tools.ts:7](../../core/src/git/tools.ts#L7)

## git_switch

- **用途** 切换到本地分支。
- **调用方** Agent 工具，工作台和蝶君，按宿主审批或沙箱仓库范围。
- **参数** name: string。问号表示可省略，完整 schema 见源码。
- **返回** 分支切换结果。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [git/tools.ts:7](../../core/src/git/tools.ts#L7)

## glob

- **用途** 按 glob 模式查文件。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** pattern: string；path?: string。问号表示可省略，完整 schema 见源码。
- **返回** 匹配路径列表。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/search-tools.ts:100](../../core/src/agent/search-tools.ts#L100)

## goal_propose

- **用途** 为合格的蝶君多阶段请求提出目标草案。
- **调用方** Agent 工具，蝶君，且限符合条件的普通会话轮次。
- **参数** title、boundary: string、spec: object；allowedPaths?: string[]；budget?: object。问号表示可省略，完整 schema 见源码。
- **返回** 待决提议，推送 goal.proposals.changed。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/goals/tools.ts:21](../../core/src/modules/goals/tools.ts#L21)

## goal_report

- **用途** 报告目标已做完、受阻或需要用户回答。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限，仅目标执行轮次。
- **参数** status: done 或 blocked 或 needs_user；note?: string；questions?: string[]。问号表示可省略，完整 schema 见源码。
- **返回** 调度器收到报告，验收状态由调度器决定。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/goals/tools.ts:21](../../core/src/modules/goals/tools.ts#L21)

## goal_status

- **用途** 读取本轮所执行的目标。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限，仅目标执行轮次。
- **参数** 无。问号表示可省略，完整 schema 见源码。
- **返回** 目标、验收和预算信息。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/goals/tools.ts:21](../../core/src/modules/goals/tools.ts#L21)

## goal_update

- **用途** 提出目标规格或范围修订。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限，仅目标执行轮次。
- **参数** spec?、scope?: object；why?: string。问号表示可省略，完整 schema 见源码。
- **返回** 目标修订或等待授权状态。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/goals/tools.ts:21](../../core/src/modules/goals/tools.ts#L21)

## goal_wait

- **用途** 记录目标等待条件。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限，仅目标执行轮次。
- **参数** kind: compute 或 external 或 user；jobId?、event?、ref?、label?、deadline?、questions?。问号表示可省略，完整 schema 见源码。
- **返回** 等待登记及状态。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/goals/tools.ts:21](../../core/src/modules/goals/tools.ts#L21)

## grep

- **用途** 按正则搜索内容。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** pattern: string；path?、glob? 等。问号表示可省略，完整 schema 见源码。
- **返回** 匹配内容及位置。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/search-tools.ts:200](../../core/src/agent/search-tools.ts#L200)

## job_kill

- **用途** 请求终止所属后台作业。
- **调用方** Agent 工具，工作台。
- **参数** job_id: string；reason?: string。问号表示可省略，完整 schema 见源码。
- **返回** 取消结果。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/shell.ts:325](../../core/src/agent/shell.ts#L325)

## job_list

- **用途** 列出当前标准工作台会话可见的后台作业。
- **调用方** Agent 工具，工作台。
- **参数** 无。问号表示可省略，完整 schema 见源码。
- **返回** 作业状态。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/shell.ts:314](../../core/src/agent/shell.ts#L314)

## job_output

- **用途** 读取所属后台作业的输出。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** job_id: string；wait?: boolean；超时参数见 schema。问号表示可省略，完整 schema 见源码。
- **返回** 作业输出、增量或退出状态。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/shell.ts:290](../../core/src/agent/shell.ts#L290)

## mcp_register

- **用途** 登记一个 MCP 服务待用户处理。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** server: object；sourceUrl?: string。问号表示可省略，完整 schema 见源码。
- **返回** 提议及其当前状态。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/mcp.ts:297](../../core/src/modules/mcp.ts#L297)

## mcp_test

- **用途** 检查已信任 MCP 服务。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** name: string。问号表示可省略，完整 schema 见源码。
- **返回** 连接测试、工具列表、耗时与失败原因。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/mcp.ts:305](../../core/src/modules/mcp.ts#L305)

## memory_forget

- **用途** 请求遗忘已有记忆。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** id: string、explicit: boolean；reason?: string。问号表示可省略，完整 schema 见源码。
- **返回** 状态或待确认回执。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:829](../../core/src/modules/memory.ts#L829)

## memory_save

- **用途** 提交待记住的事实、偏好或经验。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** content: string；范围等见 schema。问号表示可省略，完整 schema 见源码。
- **返回** 已写入、待确认或拒绝的结果。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:714](../../core/src/modules/memory.ts#L714)

## memory_search

- **用途** 搜索当前会话可见记忆。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** query: string。问号表示可省略，完整 schema 见源码。
- **返回** 匹配的记忆片段。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:688](../../core/src/modules/memory.ts#L688)

## memory_update

- **用途** 请求纠正已有记忆。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** id、content: string；explicit: boolean；reason?: string。问号表示可省略，完整 schema 见源码。
- **返回** 修改或确认回执。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:802](../../core/src/modules/memory.ts#L802)

## patrol_update_log

- **用途** 为当前运行中的巡检提交结果。
- **调用方** Agent 工具，蝶君，仅当前巡检能写入。
- **参数** note、status: string；goalActions?: object[]。问号表示可省略，完整 schema 见源码。
- **返回** 巡检记录确认文本。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/patrol.ts:669](../../core/src/modules/patrol.ts#L669)

## pwsh

- **用途** 在宿主工作区运行 PowerShell。
- **调用方** Agent 工具，工作台。
- **参数** command: string；description?、timeout? 等，最小模式使用持久会话。问号表示可省略，完整 schema 见源码。
- **返回** 输出与执行状态，标准模式可有后台作业。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/shell.ts:383](../../core/src/agent/shell.ts#L383)

## python

- **用途** 在蝶君沙箱的会话内运行 Python。
- **调用方** Agent 工具，蝶君。
- **参数** code: string；timeout?: number。问号表示可省略，完整 schema 见源码。
- **返回** 文本与生成的图像或作业结果。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/python-kernel.ts:375](../../core/src/agent/python-kernel.ts#L375)

## read

- **用途** 读取文件、目录或文本窗口。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** file_path: string；offset?、limit?: number。问号表示可省略，完整 schema 见源码。
- **返回** 文本、行号及截断提示。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/fs-tools.ts:69](../../core/src/agent/fs-tools.ts#L69)

## read_card

- **用途** 读取卡片状态或源文件。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** card_id: string；source?: boolean。问号表示可省略，完整 schema 见源码。
- **返回** 卡片元数据、状态或源码。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:841](../../core/src/cards/cards.ts#L841)

## read_document

- **用途** 读取办公文档的指定片段。
- **调用方** Agent 工具，标准工作台；蝶君的文档处理由沙箱工具路径负责。
- **参数** path: string；start_index?、max_chars? 等见 schema。问号表示可省略，完整 schema 见源码。
- **返回** 文本、长度、位置和文档元数据。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/documents.ts:285](../../core/src/modules/documents.ts#L285)

## read_image

- **用途** 读取图片作为模型输入。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** file_path: string。问号表示可省略，完整 schema 见源码。
- **返回** 图像块与尺寸信息。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/fs-tools.ts:283](../../core/src/agent/fs-tools.ts#L283)

## render_html

- **用途** 渲染工作区内的 HTML 并返回截图。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** file_path: string；可选渲染设置见 schema。问号表示可省略，完整 schema 见源码。
- **返回** PNG 或产物及渲染结果。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/render-html.ts:98](../../core/src/agent/render-html.ts#L98)

## save_monitor_state

- **用途** 保存旧工作台监测任务状态。
- **调用方** Agent 工具，工作台，只在旧工作台定时运行中启用。
- **参数** state: object。问号表示可省略，完整 schema 见源码。
- **返回** 写入提示；只在有效日程运行中写入。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1261](../../core/src/modules/scheduler.ts#L1261)

## schedule_create

- **用途** 新建蝶君日程。
- **调用方** Agent 工具，蝶君。
- **参数** name: string、trigger: string；其余见 schema。问号表示可省略，完整 schema 见源码。
- **返回** scheduleId、action、line。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1305](../../core/src/modules/scheduler.ts#L1305)

## schedule_list

- **用途** 列出蝶君日程。
- **调用方** Agent 工具，蝶君。
- **参数** from?、to?: number；status?: string。问号表示可省略，完整 schema 见源码。
- **返回** items 及显示用文本。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1317](../../core/src/modules/scheduler.ts#L1317)

## schedule_remove

- **用途** 删除蝶君日程或提出删除申请。
- **调用方** Agent 工具，蝶君。
- **参数** id: string、version: number；reason?: string。问号表示可省略，完整 schema 见源码。
- **返回** 删除或提出审批，返回 scheduleId、action、line。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1364](../../core/src/modules/scheduler.ts#L1364)

## schedule_run_now

- **用途** 立即触发一次蝶君日程。
- **调用方** Agent 工具，蝶君。
- **参数** id: string。问号表示可省略，完整 schema 见源码。
- **返回** scheduleId、action、line。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1383](../../core/src/modules/scheduler.ts#L1383)

## schedule_state

- **用途** 保存定时任务下次需要的少量状态。
- **调用方** Agent 工具，蝶君。
- **参数** state: object。问号表示可省略，完整 schema 见源码。
- **返回** 写入提示；只在有效的日程运行中写入。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1261](../../core/src/modules/scheduler.ts#L1261)

## schedule_update

- **用途** 修改蝶君日程或提出用户日程改动。
- **调用方** Agent 工具，蝶君。
- **参数** id: string、version: number；其余字段按改动填写。问号表示可省略，完整 schema 见源码。
- **返回** 更新或提出审批，返回 scheduleId、action、line。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1337](../../core/src/modules/scheduler.ts#L1337)

## session_search

- **用途** 搜索当前分区的会话记录。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** query: string。问号表示可省略，完整 schema 见源码。
- **返回** 会话及匹配片段。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:854](../../core/src/modules/memory.ts#L854)

## show_card

- **用途** 呈现当前会话的卡片。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** title、html: string；可选字段见 schema。问号表示可省略，完整 schema 见源码。
- **返回** 卡片 ID、展示或保存结果。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:805](../../core/src/cards/cards.ts#L805)

## skill

- **用途** 载入指定技能说明。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** name: string。问号表示可省略，完整 schema 见源码。
- **返回** 技能内容和相关路径。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/interaction-tools.ts:231](../../core/src/agent/interaction-tools.ts#L231)

## skill_propose

- **用途** 起草技能提议。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** name、description: string；技能内容等见 schema。问号表示可省略，完整 schema 见源码。
- **返回** 提议结果。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:509](../../core/src/modules/skills.ts#L509)

## skill_register

- **用途** 登记待用户复核的技能。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** name、description、content: string；scope?、files?、sourceKind?、sourceUrl?。问号表示可省略，完整 schema 见源码。
- **返回** 提议 ID 和 pending 状态。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:491](../../core/src/modules/skills.ts#L491)

## skill_route

- **用途** 在真正的新任务中更新技能候选。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** task: string、newTask: boolean。问号表示可省略，完整 schema 见源码。
- **返回** 技能候选与原因。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/skill-routing.ts:136](../../core/src/modules/skill-routing.ts#L136)

## skill_script_trial

- **用途** 在隔离环境试运行技能脚本。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** filePath? 或 proposalId?；script?、args?、timeoutMs?、maxOutputBytes?。问号表示可省略，完整 schema 见源码。
- **返回** 退出码、输出、产物或错误。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:505](../../core/src/modules/skills.ts#L505)

## skill_test

- **用途** 静态校验技能。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** filePath?: string 或 proposalId?: string。问号表示可省略，完整 schema 见源码。
- **返回** 检查结果。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:500](../../core/src/modules/skills.ts#L500)

## todo_write

- **用途** 替换当前会话待办清单。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** todos: TodoItem[]。问号表示可省略，完整 schema 见源码。
- **返回** 当前清单，另更新 df_agent_state。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/interaction-tools.ts:25](../../core/src/agent/interaction-tools.ts#L25)

## tool_search

- **用途** 搜索当前会话可发现的工具并加载符合条件的工具。
- **调用方** Pi 的 Agent 工具，标准工作台和蝶君；受已登记工具、命名空间和曝光设置约束。
- **参数** `query: string`（必填，非空）；`limit?: number`（正整数，最多加载的匹配数）。
- **返回** 可发现工具的匹配结果及载入提示。
- **错误** 无法发现或启用时通过 Pi 工具结果报告。
- **事件** 通过 `slot.record` 发工具执行记录。
- **开放范围** 仅内部。

## watch_add

- **用途** 新增蝶君关注项。
- **调用方** Agent 工具，蝶君。
- **参数** text: string；until?: number。问号表示可省略，完整 schema 见源码。
- **返回** `{content,details:{line:string,id:string}}`。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/patrol.ts:687](../../core/src/modules/patrol.ts#L687)

## watch_done

- **用途** 完成关注项。
- **调用方** Agent 工具，蝶君。
- **参数** id: string。问号表示可省略，完整 schema 见源码。
- **返回** 显示文本。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/patrol.ts:696](../../core/src/modules/patrol.ts#L696)

## web_fetch

- **用途** 抓取公开网页并提取正文。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** url: string。问号表示可省略，完整 schema 见源码。
- **返回** 文本和网页元数据。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/harness.ts:212](../../core/src/agent/harness.ts#L212)

## web_search

- **用途** 用配置的网页搜索后端查询。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限，须启用相应搜索后端。
- **参数** query: string；count?: number；need_content?: boolean。问号表示可省略，完整 schema 见源码。
- **返回** 结果与来源链接。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [modules/search.ts:149](../../core/src/modules/search.ts#L149)

## working_directory

- **用途** 查看或修改会话工具目录。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** cd?: string。问号表示可省略，完整 schema 见源码。
- **返回** 当前目录和变更结果。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/fs-tools.ts:330](../../core/src/agent/fs-tools.ts#L330)

## write

- **用途** 保存完整文件内容。
- **调用方** Agent 工具，工作台和蝶君，按实际会话权限。
- **参数** file_path: string、content: string。问号表示可省略，完整 schema 见源码。
- **返回** 写入结果。
- **错误** 参数或会话权限不满足时，工具结果报告错误或拒绝。
- **事件** 模型轮次经 slot.record 转发工具执行记录；业务推送按所执行的操作产生。
- **开放范围** 仅内部。
- **源码** [agent/fs-tools.ts:108](../../core/src/agent/fs-tools.ts#L108)
