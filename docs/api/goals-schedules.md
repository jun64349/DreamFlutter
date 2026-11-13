# 目标、作业、日程与巡检

字段后缀 `?` 表示可省略。通用传输及错误格式见[调用约定](README.md)，类型见[数据结构](types.md)。

## goals.accept
<!-- api:method -->

- **用途** 批准待处理的目标审批。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `GoalDetail`。
- **错误** `bad_request`（缺审批 ID）；`gone`（审批失效或已处理）。
- **事件** [`goals.changed`](events.md#goalschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/goals.ts:1333](../../core/src/modules/goals.ts#L1333)

## goals.approvals
<!-- api:method -->

- **用途** 列出目标范围和验收审批。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ id: string; goalId: string; revision: number; kind: "scope" | "acceptance"; payload: {}; createdAt: number; actions: string[]; }[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/goals.ts:1332](../../core/src/modules/goals.ts#L1332)

## goals.budget
<!-- api:method -->

- **用途** 读预算快照或调整目标预算。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** id: string（必填）；budget?: Partial<GoalBudget>（省略只读）；operationId?: string
- **返回** 读返回 `BudgetView`，写返回 `GoalDetail`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`goals.changed`](events.md#goalschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。 写入时可改变调度状态并发 goals.changed；读取不产生该事件。
- **开放范围** 仅内部。
- **源码** [modules/goals.ts:1323](../../core/src/modules/goals.ts#L1323)

## goals.control
<!-- api:method -->

- **用途** 按指定动作控制目标或全局急停。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `action: 'pause'|'resume'|'stop_run'|'cancel'|'emergency'|'clear_emergency'`（必填）；`id?: string`（单目标操作必填）；`operationId?: string`（去重键）。
- **返回** `GoalDetail` 或 `{emergency: boolean}`（全局急停）。
- **错误** `bad_request`（目标操作无效）。
- **事件** [`goals.changed`](events.md#goalschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。 单目标或全局控制的允许值见 CONTROLS。队列中的状态更新和运行后的最终状态可能分次推送。
- **开放范围** 仅内部。
- **源码** [modules/goals.ts:1318](../../core/src/modules/goals.ts#L1318)

## goals.counts
<!-- api:method -->

- **用途** 按工作台和蝶君返回各目标视图的数量。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ butterfly: { running: number; done: number; blocked: number; paused: number; decide: number; accept: number; }; workbench: { running: number; done: number; blocked: number; paused: number; decide: number; accept: number; }; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 将来可开放给模块。
- **源码** [modules/goals.ts:1314](../../core/src/modules/goals.ts#L1314)

## goals.create
<!-- api:method -->

- **用途** 创建结构化目标。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** title、originText: string（必填）；source?: GoalSource（默认 user）；mandateRef: string（或 user 来源提供 messageId: string）；slotId?: string；sessionFile?: string；spec?: Partial<GoalSpec>；scope?: Partial<GoalScope>；budget?: Partial<GoalBudget>；why?: string
- **返回** `GoalDetail`，见数据结构。
- **错误** `bad_request`（空标题、原话、授权依据、规格或范围无效）；`not_found`（指定槽或会话不存在）。
- **事件** [`goals.changed`](events.md#goalschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。 无完整规格或工作范围时为草稿，满足调度条件时排队。自主授权字段由后台产生。目标变更推送 goals.changed，后续调度可再发。
- **开放范围** 仅内部。
- **源码** [modules/goals.ts:1316](../../core/src/modules/goals.ts#L1316)

## goals.get
<!-- api:method -->

- **用途** 读取目标、验收、等候、产物和预算详情。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `GoalDetail`，见数据结构。
- **错误** `bad_request`（缺 ID）；`not_found`（目标不存在）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 将来可开放给模块。
- **源码** [modules/goals.ts:1315](../../core/src/modules/goals.ts#L1315)

## goals.history
<!-- api:method -->

- **用途** 读取目标修订历史。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `{ goalId: string; revision: number; originText: string; spec: {}; scope: {}; by: string; why: string | null; at: number; }[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/goals.ts:1331](../../core/src/modules/goals.ts#L1331)

## goals.ledger
<!-- api:method -->

- **用途** 读取目标账本中的预留与结算记录。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）；`limit?: number`（最多返回条数）
- **返回** `{ id: string; goalId: string; taskId: string | null; runId: string | null; requestId: string | null; kind: ChargeKind; state: "reserved" | "settled" | "released"; estCost: number; estInputTokens: number; estOutputTokens: number; estActiveMs: number; cost: number | null; inputTokens: number | null; outputTokens: number | null; activeMs: number | null; costUnknown: boolean; costEstimated: boolean; releaseReason: string | null; createdAt: number; settledAt: number | null; }[]`。
- **错误** `not_found`（没有这个目标）；`bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/goals.ts:1326](../../core/src/modules/goals.ts#L1326)

## goals.list
<!-- api:method -->

- **用途** 按分区、状态及视图列出目标和待决提议。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `status?: string`（状态过滤或目标状态）；`view?: JSON`（视图）；`partition?: JSON`（工作台或蝶君分区）；`limit?: number`（最多返回条数）
- **返回** `(GoalView | GoalProposalView)[]`，见数据结构。
- **错误** `bad_request`（目标归属无效）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 将来可开放给模块。
- **源码** [modules/goals.ts:1305](../../core/src/modules/goals.ts#L1305)

## goals.proposals
<!-- api:method -->

- **用途** 列出尚待决定的目标提议。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ id: string; sessionFile: string; originText: string; createdAt: number; draft: Record<string, unknown>; }[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/goals.ts:1340](../../core/src/modules/goals.ts#L1340)

## goals.proposals.resolve
<!-- api:method -->

- **用途** 接受、编辑或拒绝目标提议。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** id: string、action: accept 或 edit 或 reject（必填）；draft?: object（编辑内容）
- **返回** `GoalDetail`、`{ok:true}` 或 `{id:string,draft:object}`。
- **错误** `bad_request`（目标提议操作无效）。
- **事件** [`goal.proposals.changed`](events.md#goalproposalschanged)、[`goals.changed`](events.md#goalschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。 编辑保留提议并返回草案，拒绝返回 ok，接受返回目标详情。提议变更发 goal.proposals.changed，建目标另有 goals.changed。
- **开放范围** 仅内部。
- **源码** [modules/goals.ts:1341](../../core/src/modules/goals.ts#L1341)

## goals.reject
<!-- api:method -->

- **用途** 拒绝待处理的目标审批。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）；`reason?: string`（变更理由）
- **返回** `GoalDetail`。
- **错误** `bad_request`（缺审批 ID）；`gone`（审批失效或已处理）。
- **事件** [`goals.changed`](events.md#goalschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/goals.ts:1334](../../core/src/modules/goals.ts#L1334)

## goals.signal
<!-- api:method -->

- **用途** 写入供目标恢复等待的外部事件。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）；`eventId: string`；`ref: string`
- **返回** `{ id: string; goalId: string | null; kind: GoalEventKind; dedupeKey: string; payload: {}; createdAt: number; handledAt: number | null; handledByGeneration: number | null; }`。
- **错误** `not_found`（没有这个目标）；`bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/goals.ts:1335](../../core/src/modules/goals.ts#L1335)

## goals.update
<!-- api:method -->

- **用途** 修改目标描述、范围或规格。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** id: string（必填）；expectedRevision?: number；spec?: Partial<GoalSpec>；scope?: Partial<GoalScope>；why?: string
- **返回** `GoalDetail`，见数据结构。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`goals.changed`](events.md#goalschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。 只更新规格与范围；扩大范围进入审批。旧修订返回 version_conflict。实际更改可推送 goals.changed。
- **开放范围** 仅内部。
- **源码** [modules/goals.ts:1317](../../core/src/modules/goals.ts#L1317)

## jobs.list
<!-- api:method -->

- **用途** 列出后台作业及其状态。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** sessionFile?: string；slotId?: string；status?: running、completed、failed、cancelled 或 lost
- **返回** `{ sandboxed: boolean; service: boolean; outputBytes: number; id: string; session_file: string | null; slot_id: string; cwd: string; kind: string; label: string; command: string | null; status: Status; exit_code: number | null; detail: string | null; started_at: number; ended_at: number | null; stopped_by: StopSource | null; output_path: string | null; goal_id: string | null; owner_run_id: string | null; goal_revision: number | null; }[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/jobs.ts:82](../../core/src/modules/jobs.ts#L82)

## jobs.output
<!-- api:method -->

- **用途** 读取作业的增量文本。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** id: string（必填，作业 ID）；from?: 非负整数（UTF-8 字节位置，默认 0）
- **返回** `{text: string, next: number, truncated: boolean, ended: boolean, available?: boolean}`。next 是下一次 from；truncated 表示中间有截断或丢失。
- **错误** `bad_request`（缺 ID 或偏移不是非负安全整数）；`not_found`（作业不存在）。输出文件不可读可返回 available:false。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/jobs.ts:83](../../core/src/modules/jobs.ts#L83)

## jobs.stop
<!-- api:method -->

- **用途** 请求停止后台作业。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `{ ok: boolean; status: "cancelled" | "running" | "failed" | "completed" | "lost"; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`jobs.changed`](events.md#jobschanged)、[`job.finished`](events.md#jobfinished)；按实际状态变化推送，次数与顺序见事件和本节说明。 开始取消后按运行状态决定返回；进入终态先发 jobs.changed，再发 job.finished。
- **开放范围** 仅内部。
- **源码** [modules/jobs.ts:84](../../core/src/modules/jobs.ts#L84)

## patrol.log
<!-- api:method -->

- **用途** 读取巡检日志。
- **调用方** 窗口或后台，蝶君。
- **参数** `limit?: number`（默认 50，限制为 1–200）；`before?: number`（仅返回开始时间早于此 Unix 毫秒值的记录）。
- **返回** `{ id: string; startedAt: number; endedAt: number | null; status: Status | null; manual: boolean; facts: Fact[]; newFacts: Fact[]; factsHash: string | null; note: string | null; actions: unknown[]; notified: boolean; notificationState: NotificationState | null; notificationNote: string | null; model: string | null; cost: number; error: string | null; sessionFile: string | null; sessionAvailable: boolean; }[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/patrol.ts:122](../../core/src/modules/patrol.ts#L122)

## patrol.runNow
<!-- api:method -->

- **用途** 请求立即巡检。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `{ runId: string; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** [`patrol.changed`](events.md#patrolchanged)、[`patrol.finished`](events.md#patrolfinished)；按实际状态变化推送，次数与顺序见事件和本节说明。 先返回 runId。状态变化发 patrol.changed，运行结束再发 patrol.finished。
- **开放范围** 仅内部。
- **源码** [modules/patrol.ts:123](../../core/src/modules/patrol.ts#L123)

## patrol.status
<!-- api:method -->

- **用途** 读取蝶君巡检的进度、配置和预算概况。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `{ enabled: boolean; intervalMin: 30 | 10 | 15 | 60; nextAt: number | null; running: boolean; lastRun: { id: string; endedAt: number; status: Status; note: string; } | null; budgetUsedToday: number; budgetLimit: number; quietNow: boolean; cooldownUntil: number | null; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/patrol.ts:121](../../core/src/modules/patrol.ts#L121)

## schedules.defaults
<!-- api:method -->

- **用途** 读取日程默认时区。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ timezone: string; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1477](../../core/src/modules/scheduler.ts#L1477)

## schedules.fromSession
<!-- api:method -->

- **用途** 从当前会话生成绑定日程。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** slotId: string、trigger: Trigger（必填）；name?: string；prompt?: string（缺省从当前会话取）
- **返回** `ScheduleView`。
- **错误** `bad_request`（这个对话还没有要重复的任务）。
- **事件** [`schedules.changed`](events.md#scheduleschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1420](../../core/src/modules/scheduler.ts#L1420)

## schedules.get
<!-- api:method -->

- **用途** 读取一条日程及近期运行和送达记录。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `ScheduleView & {runs: (ScheduleRun & {deliveries: Delivery[]})[]}`。
- **错误** `not_found`（这个定时任务不存在）；`bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 将来可开放给模块。
- **源码** [modules/scheduler.ts:1429](../../core/src/modules/scheduler.ts#L1429)

## schedules.history
<!-- api:method -->

- **用途** 读取创建、修改、批准或撤销的记录。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `ScheduleChange[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1418](../../core/src/modules/scheduler.ts#L1418)

## schedules.list
<!-- api:method -->

- **用途** 列出日程及最近一次运行。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `ScheduleView[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 将来可开放给模块。
- **源码** [modules/scheduler.ts:1416](../../core/src/modules/scheduler.ts#L1416)

## schedules.occurrences
<!-- api:method -->

- **用途** 查询范围内已经发生与预计发生的日程。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** from、to: number（必填，毫秒，结束须晚于开始且范围不超过 45 天）；everyDay?: boolean（默认 true，false 过滤每日/日内重复项）
- **返回** `{items: ScheduleOccurrence[], schedules: ScheduleView[]}`。
- **错误** `bad_request`（时间无效、区间反向或超过 45 天）。
- **事件** 没有专属于本方法的推送。 同时返回真实运行和未来预览，按发生时间排序。已暂停日程不会贡献未来执行。
- **开放范围** 将来可开放给模块。
- **源码** [modules/scheduler.ts:1417](../../core/src/modules/scheduler.ts#L1417)

## schedules.preview
<!-- api:method -->

- **用途** 预览触发器接下来的执行时刻。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** trigger: Trigger（预览对象；无效值通过返回 error 报告）
- **返回** `{ error: string; next: never[]; } | { error: null; next: number[]; }`。
- **错误** `bad_request`（缺触发器）。可解析但无效的触发器用 result.error 和空 next 报告。
- **事件** 没有专属于本方法的推送。 正常返回 error:null 和最多三个 next 时间。无效触发器以 error 文本和空 next 表示。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1462](../../core/src/modules/scheduler.ts#L1462)

## schedules.remove
<!-- api:method -->

- **用途** 删除日程。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** id: string（必填）；expectedVersion?: number；reason?: string
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。 版本冲突的 error.data 为当前 ScheduleView，已无该日程时为 null。
- **事件** [`schedules.changed`](events.md#scheduleschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1457](../../core/src/modules/scheduler.ts#L1457)

## schedules.runNow
<!-- api:method -->

- **用途** 手动触发一次日程。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `ScheduleRun`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`schedules.changed`](events.md#scheduleschanged)、[`schedules.delivered`](events.md#schedulesdelivered)；按实际状态变化推送，次数与顺序见事件和本节说明。 返回本次运行记录，日程状态推送可先于 RPC 应答。送达时还可发 schedules.delivered。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1461](../../core/src/modules/scheduler.ts#L1461)

## schedules.save
<!-- api:method -->

- **用途** 创建或修改日程。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id?: string`；`name?: string`；`prompt?: string`；`cwd?: string`；`kind?: 'task'|'report'|'monitor'|'reminder'`；`trigger?: Trigger`；`missedPolicy?: 'skip'|'latest'`；`sessionMode?: 'fresh'|'bound'`；`sessionFile?: string`；`allowedTools?: string[]|null`；`expectedVersion?: number`；`reason?: string`。创建时需要有效名称和触发器，非提醒任务还需要提示和工作目录。
- **返回** `ScheduleView`。
- **错误** `bad_request`（日程字段、触发器或版本无效）；`not_found`（编辑目标已不存在）；`version_conflict`（期望版本已过期）。 版本冲突的 error.data 为当前 ScheduleView，已无该日程时为 null。
- **事件** [`schedules.changed`](events.md#scheduleschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。 写入日程后发 schedules.changed。提醒触发只走通知，任务触发才启动运行；创建者与执行归属是不同字段。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1434](../../core/src/modules/scheduler.ts#L1434)

## schedules.setStatus
<!-- api:method -->

- **用途** 切换日程的启用或暂停状态。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** id: string、status: active 或 paused 或 rejected（必填）；expectedVersion?: number
- **返回** `ScheduleView`。
- **错误** `bad_request`（status must be active, paused or rejected）。 版本冲突的 error.data 为当前 ScheduleView，已无该日程时为 null。
- **事件** [`schedules.changed`](events.md#scheduleschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1452](../../core/src/modules/scheduler.ts#L1452)

## schedules.tick
<!-- api:method -->

- **用途** 推进日程调度。
- **调用方** 内部调度或测试，工作台和蝶君。
- **参数** `now?: number`（调度时间（毫秒））
- **返回** `{ ok: boolean; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** [`schedules.changed`](events.md#scheduleschanged)、[`schedules.delivered`](events.md#schedulesdelivered)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1478](../../core/src/modules/scheduler.ts#L1478)

## schedules.undo
<!-- api:method -->

- **用途** 撤销某次日程改动。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `changeId: string`（日程改动 ID）
- **返回** 恢复原日程时为 `ScheduleView`；撤销新建时为 `{ok:true}`。
- **错误** `bad_request`（必需字段缺失或不合法）。 版本冲突的 error.data 为当前 ScheduleView，已无该日程时为 null。
- **事件** [`schedules.changed`](events.md#scheduleschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/scheduler.ts:1419](../../core/src/modules/scheduler.ts#L1419)

## watch.done
<!-- api:method -->

- **用途** 把关注项标为完成。
- **调用方** 窗口或后台，蝶君。
- **参数** `id: string`（对象标识）
- **返回** `{ id: string; text: string; createdBy: WatchOwner; createdAt: number; until: number | null; doneAt: number | null; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`watch.changed`](events.md#watchchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/patrol.ts:132](../../core/src/modules/patrol.ts#L132)

## watch.list
<!-- api:method -->

- **用途** 列出巡检关注项。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `{ id: string; text: string; createdBy: WatchOwner; createdAt: number; until: number | null; doneAt: number | null; }[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/patrol.ts:124](../../core/src/modules/patrol.ts#L124)

## watch.remove
<!-- api:method -->

- **用途** 删除关注项。
- **调用方** 窗口或后台，蝶君。
- **参数** `id: string`（对象标识）
- **返回** `{ ok: boolean; }`。
- **错误** `not_found`（找不到这条留意）；`bad_request`（必需字段缺失或不合法）。
- **事件** [`watch.changed`](events.md#watchchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/patrol.ts:126](../../core/src/modules/patrol.ts#L126)

## watch.save
<!-- api:method -->

- **用途** 保存巡检关注项。
- **调用方** 窗口或后台，蝶君。
- **参数** text: string（必填，关注内容）；id?: string（已有关注项）；until?: number 或 null（到期毫秒）
- **返回** `{ id: string; text: string; createdBy: WatchOwner; createdAt: number; until: number | null; doneAt: number | null; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`watch.changed`](events.md#watchchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。 成功变更推送 watch.changed。关注项属于蝶君巡检。
- **开放范围** 仅内部。
- **源码** [modules/patrol.ts:125](../../core/src/modules/patrol.ts#L125)
