# Pi 会话协议

窗口经 `slot.send({slotId, record})` 发送 `record: {id?,type,...}`。会话命令应答走 `slot.record`，其 `record` 形如 `{id,type:"response",command,success,data?}` 或 `{id,type:"response",command,success:false,error}`。外层 RPC 的 `ok` 表示命令已交给后台处理。窗口用 record.id 匹配命令应答。以下命令由 [Slot.command](../../core/src/slots/slot.ts#L524) 提供。

## df_navigate_tree

- **用途** 将当前会话分支切换到选中的节点。
- **调用方** 窗口，工作台和蝶君。
- **参数** `entryId: string`（目标节点），`summarize?: boolean`，`customInstructions?: string`（摘要要求）。
- **返回** `{cancelled:boolean, editorText:string|null}`。
- **错误** 节点不存在或导航失败时 Pi 响应 `success:false`；用户取消可成功返回 `cancelled:true`。
- **事件** 命令应答一次。若生成摘要，期间可能收到会话运行或扩展交互记录。
- **开放范围** 仅内部。

## df_branches

- **用途** 获取用户消息所在分支与活动叶节点。
- **调用方** 窗口，工作台和蝶君。
- **参数** 无。
- **返回** `{branches:UserBranch[],leafId:string|null}`。
- **错误** 无专用错误码，异常由 Pi 响应报告。
- **事件** 一条命令应答。
- **开放范围** 仅内部。

## df_tree

- **用途** 读取用于问句导航的会话树。
- **调用方** 窗口，工作台和蝶君。
- **参数** 无。
- **返回** `{nodes:QuestionNode[]}`。
- **错误** 无专用错误码，异常由 Pi 响应报告。
- **事件** 一条命令应答。
- **开放范围** 仅内部。

## df_set_label

- **用途** 设置或清除节点标签。
- **调用方** 窗口，工作台和蝶君。
- **参数** `entryId: string`（节点 ID），`label?: string`（省略时清除）。
- **返回** 成功应答。
- **错误** 标签写入异常走 Pi 的失败应答。
- **事件** 一条命令应答。
- **开放范围** 仅内部。

## df_export

- **用途** 导出当前会话。
- **调用方** 窗口，工作台和蝶君。
- **参数** `format?: string`（`html`、`jsonl`，其余走 Markdown），`outputPath?: string`（输出位置）。
- **返回** `{path:string}`。
- **错误** 文件导出异常走 Pi 的失败应答。
- **事件** 导出结束后一条应答。
- **开放范围** 仅内部。

## df_reload

- **用途** 重新加载当前会话的 Pi 资源与配置。
- **调用方** 窗口，工作台和蝶君。
- **参数** 无。
- **返回** 成功应答。
- **错误** 加载异常走 Pi 的失败应答。
- **事件** 加载完成后一条应答，加载期间可能有 Pi 扩展记录。
- **开放范围** 仅内部。

## df_agent_state

- **用途** 读取 Agent 模式、计划状态与待办。
- **调用方** 窗口，工作台和蝶君。
- **参数** 无。
- **返回** `{agentMode:"standard"|"minimal",planMode:boolean,todos:TodoItem[]|null}`。
- **错误** 无专用错误码，异常由 Pi 响应报告。
- **事件** 查询返回一条命令应答。计划或待办状态变动时另发下列同名记录。
- **开放范围** 仅内部。

### df_agent_state 推送

- **用途** 将计划模式与待办状态变更发送给会话窗口。
- **调用方** 后台发送，已附加的工作台或蝶君会话接收。
- **参数** 无。
- **返回** `{type:"df_agent_state",planMode:boolean,todos:TodoItem[]|null}`，封装于 `slot.record.record`。
- **错误** 无单独失败应答。
- **事件** 每次更新 Agent 状态时发，在命令回执前也可能出现。
- **开放范围** 仅内部。

## df_set_plan_mode

- **用途** 切换标准模式的计划模式。
- **调用方** 窗口，支持计划模式的会话。
- **参数** `on?: boolean`（只有 true 表示开启）。
- **返回** `{planMode:boolean,todos:TodoItem[]|null}`。
- **错误** 无计划模式控制器时应答 `success:false`，文本为「计划模式只在标准模式里可用」。
- **事件** 更新时发 `df_agent_state`，随后命令应答。
- **开放范围** 仅内部。

## df_context_usage

- **用途** 获取当前上下文占用。
- **调用方** 窗口，工作台和蝶君。
- **参数** 无。
- **返回** Pi 上下文统计或 `null`。上下文窗口未知时 `contextWindow` 和 `percent` 可为 0。
- **错误** 模型配置刷新异常走 Pi 的失败应答。
- **事件** 一条命令应答。
- **开放范围** 仅内部。

## 消息和交互记录

- `agent_start`、`agent_end`、`agent_settled` 分别描述 Agent 启动、完成一轮与所有后续处理结束。运行指示以 `agent_settled` 收尾。
- `message_start`、`message_end` 携带消息。`message_update` 携带 `assistantMessageEvent` 增量与可选 `usage`。文本、思考、工具调用分别按内容块索引更新。后台交付可单独补发 `message_end`。
- `tool_execution_start`、`tool_execution_update`、`tool_execution_end` 用 `toolCallId` 关联工具执行。更新可出现多次。
- `extension_ui_request` 可请求选择、确认或输入。窗口用相同请求 ID 发送 `extension_ui_response`，或走可持久化确认的 `confirm.answer`。
- `get_messages` 返回 Pi 消息；`get_session_stats`、`get_state` 读取运行快照。连接恢复时优先用 `slot.attach` 的 `replay` 和 `live` 补当前交互及未完成流。

消息字段见[数据结构](types.md)，事件序列化见 [json-event.ts](../../core/src/pi/json-event.ts)。
