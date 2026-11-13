# 后台推送事件

每条推送是独立的 JSON 对象。除会话附加和各事件明确说明的特例外，事件通过后台连接广播。刷新型事件允许重复，不携带完整状态时重新查询。

## attention.action
<!-- api:event -->

- **用途** 待处理动作回执变化。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 receipt: ActionReceipt。
- **错误** 无单独的 RPC 错误响应。
- **事件** 按 receipt.id 跟踪。先发 pending；执行结束发 applied 或 failed，在可撤销时间内撤销则发 cancelled。随后可有 attention.changed。
- **开放范围** 仅内部。
- **源码** [modules/attention.ts:284](../../core/src/modules/attention.ts#L284)

## attention.changed
<!-- api:event -->

- **用途** 待处理总数需刷新。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 counts: {now: number, later: number, total: number}。
- **错误** 无单独的 RPC 错误响应。
- **事件** 事项或回执变动后可多次发；按需重新查询。
- **开放范围** 仅内部。
- **源码** [modules/attention.ts:283](../../core/src/modules/attention.ts#L283)

## backup.job
<!-- api:event -->

- **用途** 备份或恢复作业进度。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 job: Job。
- **错误** 无单独的 RPC 错误响应。
- **事件** 作业开始和阶段、终态变更时可多次发。
- **开放范围** 仅内部。
- **源码** [backup/backup.ts:337](../../core/src/backup/backup.ts#L337)

## backup.migrating
<!-- api:event -->

- **用途** 首次迁移旧数据目录。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 from: string, to: string。
- **错误** 无单独的 RPC 错误响应。
- **事件** 复制旧数据之前发；晚连接的窗口可能错过。
- **开放范围** 仅内部。
- **源码** [backup/backup.ts:145](../../core/src/backup/backup.ts#L145)

## backup.restarting
<!-- api:event -->

- **用途** 恢复需要重启。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 无附加字段。
- **错误** 无单独的 RPC 错误响应。
- **事件** 应用恢复准备完毕后、安排退出前发。
- **开放范围** 仅内部。
- **源码** [backup/backup.ts:471](../../core/src/backup/backup.ts#L471)

## butterfly.delivery
<!-- api:event -->

- **用途** 旧交办关联产物送达。
- **调用方** 窗口接收。蝶君。
- **参数** 无请求参数。
- **返回** 推送对象。旧运行可带 `taskId: string|null`、`files: OutboxFile[]`、`runId: string`；对话目标另以交付消息和会话刷新呈现。
- **错误** 无单独的 RPC 错误响应。
- **事件** 扫描完成后先发 butterfly.outbox，再发本事件。受对话目标的验收和交付分流约束。
- **开放范围** 仅内部。
- **源码** [modules/butterfly.ts:424](../../core/src/modules/butterfly.ts#L424)

## butterfly.outbox
<!-- api:event -->

- **用途** 扫描发现发件箱新文件。
- **调用方** 窗口接收。蝶君。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 files: OutboxFile[], fresh: string[]。
- **错误** 无单独的 RPC 错误响应。
- **事件** 扫描发现新文件时发，fresh 为新文件名。
- **开放范围** 仅内部。
- **源码** [modules/butterfly.ts:416](../../core/src/modules/butterfly.ts#L416)

## butterfly.prepared
<!-- api:event -->

- **用途** 旧交办准备完成。
- **调用方** 窗口接收。蝶君。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 intent: Intent。
- **错误** 无单独的 RPC 错误响应。
- **事件** 新准备落库后发，随后 tasks.changed。
- **开放范围** 仅内部。
- **源码** [modules/butterfly.ts:174](../../core/src/modules/butterfly.ts#L174)

## card.changed
<!-- api:event -->

- **用途** 卡片创建或更新。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 card: Card。
- **错误** 无单独的 RPC 错误响应。
- **事件** 数据写入后发；按 card.id 更新。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:322](../../core/src/cards/cards.ts#L322)、[cards/cards.ts:358](../../core/src/cards/cards.ts#L358)

## card.emitted
<!-- api:event -->

- **用途** 卡片发出应用事件。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 cardId: string, title: string, sessionFile: string 或 null, name: string, payload: JSON, at: number。
- **错误** 无单独的 RPC 错误响应。
- **事件** 记录卡片应用事件后逐条发。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:647](../../core/src/cards/cards.ts#L647)

## card.removed
<!-- api:event -->

- **用途** 卡片已删除。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 cardId: string。
- **错误** 无单独的 RPC 错误响应。
- **事件** 每张删除的卡片各发一条。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:400](../../core/src/cards/cards.ts#L400)

## confirm.changed
<!-- api:event -->

- **用途** 确认记录新增或状态更新。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 confirmation: Confirmation。
- **错误** 无单独的 RPC 错误响应。
- **事件** 确认建立和最终回答各可发；按确认 ID 更新。
- **开放范围** 仅内部。
- **源码** [core.ts:628](../../core/src/core.ts#L628)、[core.ts:641](../../core/src/core.ts#L641)、[modules/autonomy/index.ts:300](../../core/src/modules/autonomy/index.ts#L300)、[modules/autonomy/index.ts:312](../../core/src/modules/autonomy/index.ts#L312)、[modules/goals/chat-workflow.ts:295](../../core/src/modules/goals/chat-workflow.ts#L295)

## context.available
<!-- api:event -->

- **用途** 一次成功的上下文压缩完成后通知等待方。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 slotId: string, sessionId: string 或 null, reason: string, tokensBefore: number。
- **错误** 无单独的 RPC 错误响应。
- **事件** 会话发出有结果、未中止的 compaction_end 时发；一次成功压缩对应一条。
- **开放范围** 仅内部。
- **源码** [modules/context.ts:173](../../core/src/modules/context.ts#L173)

## context.compaction
<!-- api:event -->

- **用途** 上下文压缩已记录。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 slotId: string, sessionId: string 或 null；另含压缩日志字段。
- **错误** 无单独的 RPC 错误响应。
- **事件** 每条压缩记录保存后发。
- **开放范围** 仅内部。
- **源码** [modules/context.ts:160](../../core/src/modules/context.ts#L160)

## core.startup
<!-- api:event -->

- **用途** 启动阶段、完成情况或耗时更新。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 StartupState。
- **错误** 无单独的 RPC 错误响应。
- **事件** 每次 StartupTracker 变更发；启动器另收同结构 IPC。
- **开放范围** 仅内部。
- **源码** [core.ts:229](../../core/src/core.ts#L229)、[main.ts:54](../../core/src/main.ts#L54)

## desk.changed
<!-- api:event -->

- **用途** 写笺或资料列表更新。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 cwd: string。
- **错误** 无单独的 RPC 错误响应。
- **事件** 写笺、资料以及相关任务变动后发。
- **开放范围** 仅内部。
- **源码** [modules/tasks.ts:437](../../core/src/modules/tasks.ts#L437)、[modules/tasks.ts:599](../../core/src/modules/tasks.ts#L599)、[modules/tasks.ts:606](../../core/src/modules/tasks.ts#L606)、[modules/tasks.ts:646](../../core/src/modules/tasks.ts#L646)、[modules/tasks.ts:653](../../core/src/modules/tasks.ts#L653)

## gateway.alert
<!-- api:event -->

- **用途** 渠道通知进入投递。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 title: string, body: string。
- **错误** 无单独的 RPC 错误响应。
- **事件** 通知服务允许并开始投递时发；同业务键受去重和通知策略约束。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:323](../../core/src/gateway/gateway.ts#L323)

## gateway.changed
<!-- api:event -->

- **用途** 渠道、组或健康数据变更。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 无附加字段。
- **错误** 无单独的 RPC 错误响应。
- **事件** 写入后按实际变更多次发；刷新列表和状态。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:260](../../core/src/gateway/gateway.ts#L260)、[gateway/gateway.ts:425](../../core/src/gateway/gateway.ts#L425)、[gateway/gateway.ts:786](../../core/src/gateway/gateway.ts#L786)、[gateway/gateway.ts:1062](../../core/src/gateway/gateway.ts#L1062)

## gateway.switched
<!-- api:event -->

- **用途** 模型组选择切换到另一个成员。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 sessionId: string 或 null, group: string, from: string, to: string, reason: string。
- **错误** 无单独的 RPC 错误响应。
- **事件** 发现成员切换时发，每次实际切换一条。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:819](../../core/src/gateway/gateway.ts#L819)

## goal.proposals.changed
<!-- api:event -->

- **用途** 目标待决提议变化。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 无附加字段。
- **错误** 无单独的 RPC 错误响应。
- **事件** 保存、编辑或处理目标提议后发。
- **开放范围** 仅内部。
- **源码** [modules/goals/proposals.ts:74](../../core/src/modules/goals/proposals.ts#L74)

## goals.changed
<!-- api:event -->

- **用途** 目标状态或修订变化。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 id: string, status: GoalStatus, revision: number。
- **错误** 无单独的 RPC 错误响应。
- **事件** 调度期间一个目标可发多次，以最新详情为准。
- **开放范围** 仅内部。
- **源码** [modules/goals.ts:298](../../core/src/modules/goals.ts#L298)

## job.finished
<!-- api:event -->

- **用途** 作业进入终态。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，字段与 [jobs.changed](#jobschanged) 相同。
- **错误** 无单独的 RPC 错误响应。
- **事件** 终态更新时紧随 jobs.changed。
- **开放范围** 仅内部。
- **源码** [modules/jobs.ts:245](../../core/src/modules/jobs.ts#L245)

## jobs.changed
<!-- api:event -->

- **用途** 作业创建、更新或终结。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象。id: string、sessionFile: string 或 null、status: 作业状态；目标作业还带 goalId: string、ownerRunId: string 或 null、revision: number 或 null。
- **错误** 无单独的 RPC 错误响应。
- **事件** 状态变更后发；终态事件前先发本事件。
- **开放范围** 仅内部。
- **源码** [modules/jobs.ts:244](../../core/src/modules/jobs.ts#L244)

## library.changed
<!-- api:event -->

- **用途** 库登记信息变更。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 无附加字段。
- **错误** 无单独的 RPC 错误响应。
- **事件** 登记提交后发；重新读技能或 MCP 库。
- **开放范围** 仅内部。
- **源码** [core.ts:236](../../core/src/core.ts#L236)

## mcp.changed
<!-- api:event -->

- **用途** MCP 库或启用状态变化。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 无附加字段。
- **错误** 无单独的 RPC 错误响应。
- **事件** 登记、移除、切换或同步后可发。
- **开放范围** 仅内部。
- **源码** [modules/mcp.ts:76](../../core/src/modules/mcp.ts#L76)、[modules/mcp.ts:335](../../core/src/modules/mcp.ts#L335)

## memory.changed
<!-- api:event -->

- **用途** 记忆数据变更。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 batchId: string 或 null。
- **错误** 无单独的 RPC 错误响应。
- **事件** 批量提交后可按批次发；全局变更或兼容路径可发 null。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:139](../../core/src/modules/memory.ts#L139)、[modules/memory.ts:1165](../../core/src/modules/memory.ts#L1165)、[storage/storage.ts:53](../../core/src/storage/storage.ts#L53)

## memory.correction
<!-- api:event -->

- **用途** 会话中的记忆纠正回执。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 sessionId: string, runId: string 或 null, entryId?: string；另含批次和改动列表。
- **错误** 无单独的 RPC 错误响应。
- **事件** 纠正提交时可发，绑定最终回复时可再发，按批次和消息关联。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:668](../../core/src/modules/memory.ts#L668)、[modules/memory.ts:953](../../core/src/modules/memory.ts#L953)、[modules/memory.ts:1153](../../core/src/modules/memory.ts#L1153)

## memory.jobs.changed
<!-- api:event -->

- **用途** 记忆作业状态更新。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 job: MemoryJob。
- **错误** 无单独的 RPC 错误响应。
- **事件** 排队、开始、重试、终态等变化时可多次发。
- **开放范围** 仅内部。
- **源码** [memory/work.ts:177](../../core/src/memory/work.ts#L177)

## memory.notice
<!-- api:event -->

- **用途** 记忆容量不足或过期待复核。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 kind: capacity_full 或 expired_protected；前者 scopeKey: string, tokens: number, capacity: number，后者 itemIds: string[]。
- **错误** 无单独的 RPC 错误响应。
- **事件** 保留检查或清理检测到条件时发。
- **开放范围** 仅内部。
- **源码** [memory/work.ts:368](../../core/src/memory/work.ts#L368)、[memory/work.ts:377](../../core/src/memory/work.ts#L377)、[memory/work.ts:522](../../core/src/memory/work.ts#L522)

## memory.storage
<!-- api:event -->

- **用途** 记忆存储可写状态变化。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 paused: boolean, freeBytes: number 或 null, minimumBytes: number, reason: string 或 null。
- **错误** 无单独的 RPC 错误响应。
- **事件** 容量监测更新时发。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:209](../../core/src/modules/memory.ts#L209)

## memory.task
<!-- api:event -->

- **用途** 会话的记忆任务边界变化。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 sessionId: string, kind: string, taskId: string 或 null, previousTaskId?: string 或 null, decisionId?: string。
- **错误** 无单独的 RPC 错误响应。
- **事件** 自动切分或用户继续时发。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:419](../../core/src/modules/memory.ts#L419)、[modules/memory.ts:1025](../../core/src/modules/memory.ts#L1025)、[modules/memory.ts:1187](../../core/src/modules/memory.ts#L1187)

## memory.unsaved
<!-- api:event -->

- **用途** 发现待保存记忆声明或将它清除。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 sessionId: string, runId: string, replyEntryId: string 或 null, cleared?: boolean；声明包含摘要字段。
- **错误** 无单独的 RPC 错误响应。
- **事件** 声明出现时发，成功接续保存后可再发 cleared。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:943](../../core/src/modules/memory.ts#L943)、[modules/memory.ts:1100](../../core/src/modules/memory.ts#L1100)

## memory.warning
<!-- api:event -->

- **用途** 记忆注入命中拦截或历史摘要复活提示。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 kind: blocked 或 summary_revived, itemIds: string[], sessionId?: string。
- **错误** 无单独的 RPC 错误响应。
- **事件** 按分支在上下文构建或压缩处理期间发。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:254](../../core/src/modules/memory.ts#L254)、[modules/memory.ts:653](../../core/src/modules/memory.ts#L653)

## notices.changed
<!-- api:event -->

- **用途** 任务通知列表变化。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 notice?: Notice。
- **错误** 无单独的 RPC 错误响应。
- **事件** 新建时可带 notice；处理或清理时可只发刷新信号。
- **开放范围** 仅内部。
- **源码** [modules/tasks.ts:515](../../core/src/modules/tasks.ts#L515)、[modules/tasks.ts:539](../../core/src/modules/tasks.ts#L539)、[modules/tasks.ts:551](../../core/src/modules/tasks.ts#L551)

## notification
<!-- api:event -->

- **用途** 通知被投递到窗口。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** `{ event: "notification"; id: string; kind: string; key: string; category: string; object: string; situation: string; impact: string; action: string; target: NotificationTarget; title: string; body: string; at: number; objectRef?: string; itemId?: string }`。`target` 包含 `page`，可带 `slotId`、`sessionFile`、`taskId`、`runId`、`itemId` 或 `goalId`。
- **错误** 无单独的 RPC 错误响应。
- **事件** 通知服务完成策略检查、去重后发；静默队列可能延迟；同业务键通过回执去重。
- **开放范围** 仅内部。
- **源码** [notify.ts:177](../../core/src/notify.ts#L177)

## patrol.changed
<!-- api:event -->

- **用途** 巡检视图需刷新。
- **调用方** 窗口接收。蝶君。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 无附加字段。
- **错误** 无单独的 RPC 错误响应。
- **事件** 状态变化后发；运行开始、结束等各可产生。
- **开放范围** 仅内部。
- **源码** [modules/patrol.ts:629](../../core/src/modules/patrol.ts#L629)

## patrol.finished
<!-- api:event -->

- **用途** 巡检结束。
- **调用方** 窗口接收。蝶君。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 runId: string, status: 巡检终态。
- **错误** 无单独的 RPC 错误响应。
- **事件** 结束并记录后发。
- **开放范围** 仅内部。
- **源码** [modules/patrol.ts:630](../../core/src/modules/patrol.ts#L630)

## piMigration.changed
<!-- api:event -->

- **用途** 迁移或生成状态更新。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 status: 迁移状态对象。
- **错误** 无单独的 RPC 错误响应。
- **事件** 迁移相关状态改变时发，长操作可能有多条。
- **开放范围** 仅内部。
- **源码** [gateway/pi-migration.ts:106](../../core/src/gateway/pi-migration.ts#L106)

## piMigration.oauth
<!-- api:event -->

- **用途** OAuth 流程事件、提示或终态。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 login: OAuth 登录状态。
- **错误** 无单独的 RPC 错误响应。
- **事件** 按登录 ID 跟踪；可经历多个浏览器指示、输入提示，最后收到终态。
- **开放范围** 仅内部。
- **源码** [gateway/pi-migration.ts:89](../../core/src/gateway/pi-migration.ts#L89)、[gateway/pi-migration.ts:96](../../core/src/gateway/pi-migration.ts#L96)、[gateway/pi-migration.ts:101](../../core/src/gateway/pi-migration.ts#L101)

## proposals.changed
<!-- api:event -->

- **用途** 技能或 MCP 待定提议变化。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 无附加字段。
- **错误** 无单独的 RPC 错误响应。
- **事件** 新提议或处理提议后发；技能批准后可紧随 skills.changed。
- **开放范围** 仅内部。
- **源码** [modules/mcp.ts:172](../../core/src/modules/mcp.ts#L172)、[modules/mcp.ts:291](../../core/src/modules/mcp.ts#L291)、[modules/skills.ts:339](../../core/src/modules/skills.ts#L339)、[modules/skills.ts:384](../../core/src/modules/skills.ts#L384)、[modules/skills.ts:391](../../core/src/modules/skills.ts#L391)

## providers.changed
<!-- api:event -->

- **用途** Pi 提供方配置变化。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 无附加字段。
- **错误** 无单独的 RPC 错误响应。
- **事件** 配置或凭据状态更新后发。
- **开放范围** 仅内部。
- **源码** [modules/providers.ts:266](../../core/src/modules/providers.ts#L266)

## run.finished
<!-- api:event -->

- **用途** 一次可记录的运行完成。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 `run: Run`。普通会话的即时运行对象可省略 kind；`runs.get` 的持久化投影包含 kind。
- **错误** 无单独的 RPC 错误响应。
- **事件** 运行完成并落库后发；每个已完成运行一条。
- **开放范围** 仅内部。
- **源码** [core.ts:672](../../core/src/core.ts#L672)

## runs.changed
<!-- api:event -->

- **用途** 运行列表内容需刷新。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 无附加字段。
- **错误** 无单独的 RPC 错误响应。
- **事件** 已读标记等修改后发。
- **开放范围** 仅内部。
- **源码** [core.ts:823](../../core/src/core.ts#L823)、[modules/attention.ts:261](../../core/src/modules/attention.ts#L261)

## sandbox.changed
<!-- api:event -->

- **用途** 沙箱状态改变。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 status: SandboxStatus。
- **错误** 无单独的 RPC 错误响应。
- **事件** 异步读取最新状态后发，准备过程可多次发。
- **开放范围** 仅内部。
- **源码** [sandbox/sandbox.ts:295](../../core/src/sandbox/sandbox.ts#L295)

## schedules.changed
<!-- api:event -->

- **用途** 日程或运行状态变更。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 ids: string[], versions: Record<string, number>, runId?: string。
- **错误** 无单独的 RPC 错误响应。
- **事件** 编辑、状态切换或运行进度可多次发；存在 runId 时可刷新该运行。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:795](../../core/src/modules/scheduler.ts#L795)

## schedules.delivered
<!-- api:event -->

- **用途** 日程送达。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 runId: string, title: string, body: string, target: NotificationTarget。
- **错误** 无单独的 RPC 错误响应。
- **事件** 仅在送达处理路径发；单次触发可有多种送达渠道，按 runId 查询回执。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1202](../../core/src/modules/scheduler.ts#L1202)

## sessions.changed
<!-- api:event -->

- **用途** 会话索引需要刷新。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 batchId?: string。
- **错误** 无单独的 RPC 错误响应。
- **事件** 回收、恢复、索引或交付后可能多次发；回收相关可能携带批次。
- **开放范围** 仅内部。
- **源码** [modules/session-index.ts:362](../../core/src/modules/session-index.ts#L362)、[modules/session-index.ts:470](../../core/src/modules/session-index.ts#L470)、[modules/goals/chat-workflow.ts:403](../../core/src/modules/goals/chat-workflow.ts#L403)、[modules/persona/proactive.ts:280](../../core/src/modules/persona/proactive.ts#L280)

## settings.changed
<!-- api:event -->

- **用途** 有效设置发生变化。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 settings: CoreSettings, changed: string[]。
- **错误** 无单独的 RPC 错误响应。
- **事件** 同一补丁的有效变更合成一条，值相同或无效字段无推送。
- **开放范围** 仅内部。
- **源码** [core.ts:275](../../core/src/core.ts#L275)

## skills.changed
<!-- api:event -->

- **用途** 技能列表更新。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 无附加字段。
- **错误** 无单独的 RPC 错误响应。
- **事件** 技能写入、启停、删除、试用或接纳后可发。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:243](../../core/src/modules/skills.ts#L243)、[modules/skills.ts:250](../../core/src/modules/skills.ts#L250)、[modules/skills.ts:256](../../core/src/modules/skills.ts#L256)、[modules/skills.ts:275](../../core/src/modules/skills.ts#L275)、[modules/skills.ts:303](../../core/src/modules/skills.ts#L303)、[modules/skills.ts:385](../../core/src/modules/skills.ts#L385)、[modules/skills.ts:553](../../core/src/modules/skills.ts#L553)、[modules/selfwork/skills.ts:93](../../core/src/modules/selfwork/skills.ts#L93)

## slot.changed
<!-- api:event -->

- **用途** 活动会话信息更新。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 info: SlotInfo。
- **错误** 无单独的 RPC 错误响应。
- **事件** 会话加入列表、运行状态切换等均可能发；按 slotId 更新快照。
- **开放范围** 仅内部。
- **源码** [core.ts:529](../../core/src/core.ts#L529)、[core.ts:619](../../core/src/core.ts#L619)

## slot.closed
<!-- api:event -->

- **用途** 会话离开活动列表。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 slotId: string。
- **错误** 无单独的 RPC 错误响应。
- **事件** 关闭清理后发。
- **开放范围** 仅内部。
- **源码** [core.ts:592](../../core/src/core.ts#L592)

## slot.record
<!-- api:event -->

- **用途** 附加会话的 Pi 记录。
- **调用方** 窗口接收。发送给附加对应会话的连接，个别回执只给提交命令的连接。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 slotId: string, record: PiRecord。
- **错误** 无单独的 RPC 错误响应。
- **事件** 同一会话按实际发出顺序接收；交办处理的命令回执可只发请求连接，交付和主动聊天也可补发 message_end。
- **开放范围** 仅内部。
- **源码** [core.ts:615](../../core/src/core.ts#L615)、[core.ts:791](../../core/src/core.ts#L791)、[modules/goals/chat-workflow.ts:324](../../core/src/modules/goals/chat-workflow.ts#L324)、[modules/persona/proactive.ts:277](../../core/src/modules/persona/proactive.ts#L277)

## storage.restarting
<!-- api:event -->

- **用途** 数据迁移即将重启。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 无附加字段。
- **错误** 无单独的 RPC 错误响应。
- **事件** 迁移进入需重启阶段后发。
- **开放范围** 仅内部。
- **源码** [storage/storage.ts:37](../../core/src/storage/storage.ts#L37)

## tasks.changed
<!-- api:event -->

- **用途** 任务状态或数据已更新。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 taskId: string。
- **错误** 无单独的 RPC 错误响应。
- **事件** 任务写入、执行进度或蝶君交办状态变化后可多次发。
- **开放范围** 仅内部。
- **源码** [modules/butterfly.ts:130](../../core/src/modules/butterfly.ts#L130)、[modules/butterfly.ts:147](../../core/src/modules/butterfly.ts#L147)、[modules/butterfly.ts:175](../../core/src/modules/butterfly.ts#L175)、[modules/butterfly.ts:187](../../core/src/modules/butterfly.ts#L187)、[modules/butterfly.ts:200](../../core/src/modules/butterfly.ts#L200)、[modules/tasks.ts:306](../../core/src/modules/tasks.ts#L306)

## templates.changed
<!-- api:event -->

- **用途** 模板列表更新。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 无附加字段。
- **错误** 无单独的 RPC 错误响应。
- **事件** 模板修改、移除或切换后发。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:243](../../core/src/modules/skills.ts#L243)、[modules/skills.ts:457](../../core/src/modules/skills.ts#L457)、[modules/skills.ts:464](../../core/src/modules/skills.ts#L464)、[modules/skills.ts:609](../../core/src/modules/skills.ts#L609)

## updates.changed
<!-- api:event -->

- **用途** 更新状态或阶段变化。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 status: 更新状态对象。
- **错误** 无单独的 RPC 错误响应。
- **事件** 下载、安装、取消等期间可多次发。
- **开放范围** 仅内部。
- **源码** [update/module.ts:116](../../core/src/update/module.ts#L116)

## updates.closeWindow
<!-- api:event -->

- **用途** 后台请求关闭窗口以应用更新。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 无附加字段。
- **错误** 无单独的 RPC 错误响应。
- **事件** 准备阶段的 updates.changed 后发，窗口关闭后进入备份和更新。
- **开放范围** 仅内部。
- **源码** [update/module.ts:233](../../core/src/update/module.ts#L233)

## vision.missing
<!-- api:event -->

- **用途** 当前对话模型无法处理图像且没有可用转述。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 slotId: string, model: string。
- **错误** 无单独的 RPC 错误响应。
- **事件** 图像处理遇到相应条件时发。
- **开放范围** 仅内部。
- **源码** [modules/vision.ts:119](../../core/src/modules/vision.ts#L119)

## vision.relayed
<!-- api:event -->

- **用途** 视觉辅助模型已生成转述。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 slotId: string, hashes: string[], model: string。
- **错误** 无单独的 RPC 错误响应。
- **事件** 生成新描述后发。
- **开放范围** 仅内部。
- **源码** [modules/vision.ts:132](../../core/src/modules/vision.ts#L132)

## watch.changed
<!-- api:event -->

- **用途** 关注项列表变化。
- **调用方** 窗口接收。蝶君。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 无附加字段。
- **错误** 无单独的 RPC 错误响应。
- **事件** 保存、删除或标为完成后发。
- **开放范围** 仅内部。
- **源码** [modules/patrol.ts:631](../../core/src/modules/patrol.ts#L631)

## webSearch.changed
<!-- api:event -->

- **用途** 网页搜索状态更新。
- **调用方** 窗口接收。根据对象归属用于工作台、蝶君或全局设置。
- **参数** 无请求参数。
- **返回** 推送对象，含 `event` 和 status: 搜索配置和用量状态。
- **错误** 无单独的 RPC 错误响应。
- **事件** 配置或运行状态变化时发。
- **开放范围** 仅内部。
- **源码** [modules/search.ts:108](../../core/src/modules/search.ts#L108)
