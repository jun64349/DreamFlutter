# 记忆

字段后缀 `?` 表示可省略。通用传输及错误格式见[调用约定](README.md)，类型见[数据结构](types.md)。

## memory.acceptPending
<!-- api:method -->

- **用途** 确认待定记忆变更。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）；`content?: string`（正文）
- **返回** `CommitResult & { currentTask: "next_call" | "next_task"; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`memory.changed`](events.md#memorychanged)、[`memory.correction`](events.md#memorycorrection)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1147](../../core/src/modules/memory.ts#L1147)

## memory.blocks
<!-- api:method -->

- **用途** 列出旧版记忆块。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ key: string; title: string; content: string; locked: boolean; updatedAt: number | null; }[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1276](../../core/src/modules/memory.ts#L1276)

## memory.boundaries
<!-- api:method -->

- **用途** 读取会话内记忆任务边界历史。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `sessionId: string`（Pi 会话 ID）
- **返回** `{ id: string; sessionId: string; reason: string; at: number; before: TaskView | null; after: TaskView; changed: boolean; undone: boolean; }[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1021](../../core/src/modules/memory.ts#L1021)

## memory.clear
<!-- api:method -->

- **用途** 按范围清除记忆。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `scope?: string`（范围）；`cwd: string`（工作目录）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`memory.changed`](events.md#memorychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1227](../../core/src/modules/memory.ts#L1227)

## memory.continueTask
<!-- api:method -->

- **用途** 继续前一个记忆任务并丢弃当前边界。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `sessionId: string`（Pi 会话 ID）
- **返回** `{ resumed: TaskView; dropped: TaskView; }`。
- **错误** `bad_request`（当前任务不是程序猜出来的新任务，没有可以接回去的上一个任务）。
- **事件** [`memory.task`](events.md#memorytask)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1180](../../core/src/modules/memory.ts#L1180)

## memory.corrections
<!-- api:method -->

- **用途** 按会话、运行或消息查记忆纠正回执。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `sessionId: string`（Pi 会话 ID）；`runId?: string`（运行 ID）；`entryId?: string`（消息或检查点 ID）
- **返回** `{ runId: string | null; entryId: string | null; at: number; batchId: string | null; status: string; changes: { itemId: string; before: MemoryItem | null; after: MemoryItem; undoable: boolean; }[]; }[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1018](../../core/src/modules/memory.ts#L1018)

## memory.export
<!-- api:method -->

- **用途** 导出记忆条目和来源。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ items: { sources: MemorySource[]; workspacePath: string | null; possiblyOutdated: boolean; review: { owner: string; nextAt: number | null; pendingIds: string[]; lastVerifiedAt: number | null; cadence: string; paused: boolean; } | null; id: string; version: number; level: Level; kind: ItemKind; content: string; conditions: string | null; scope: ItemScope; workspaceId: string | null; groupId: string | null; confidence: Confidence; status: ItemStatus; pinned: boolean; retention: Retention; autoOk: boolean; occurredAt: number | null; validFrom: number | null; validUntil: number | null; lastVerifiedAt: number | null; nextReviewAt: number | null; lastUsedAt: number | null; useCount: number; createdAt: number; updatedAt: number; createdBy: Actor; }[]; workspaces: Workspace[]; blocks: { key: string; title: string; content: string; locked: boolean; updatedAt: number | null; }[]; memories: Record<string, unknown>[]; exportedAt: number; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1219](../../core/src/modules/memory.ts#L1219)

## memory.extractNow
<!-- api:method -->

- **用途** 立即排入一次记忆提取。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** slotId: string（必填）
- **返回** `MemoryJob | null`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** [`memory.jobs.changed`](events.md#memoryjobschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1204](../../core/src/modules/memory.ts#L1204)

## memory.item
<!-- api:method -->

- **用途** 读取单条记忆及来源、版本等详情。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `{item: MemoryItemView, versions: MemoryVersion[], sources: MemorySource[], links: MemoryLink[], log: LogEntry[]}`。
- **错误** `not_found`（没有这条记忆）；`bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 将来可开放给模块。
- **源码** [modules/memory.ts:1067](../../core/src/modules/memory.ts#L1067)

## memory.items
<!-- api:method -->

- **用途** 按范围、状态和搜索词列出记忆。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `cwd?: string`；`status?: ItemStatus|ItemStatus[]`；`scope?: ItemScope`；`workspaceId?: string`；`level?: 1|2|3`；`pinned?: boolean`；`query?: string`；`limit?: number`。
- **返回** `MemoryItemView[]`；包含范围及版本字段。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 将来可开放给模块。
- **源码** [modules/memory.ts:1052](../../core/src/modules/memory.ts#L1052)

## memory.jobs
<!-- api:method -->

- **用途** 查询记忆后台作业。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `status?: string`（状态过滤或目标状态）；`limit?: number`（最多返回条数）
- **返回** `MemoryJob[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1212](../../core/src/modules/memory.ts#L1212)

## memory.list
<!-- api:method -->

旧，0.12 换掉。记忆列表读 memory.items，候选读 memory.pending。

- **用途** 通过兼容接口列出记忆。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `status?: string`（状态过滤或目标状态）；`cwd?: string`（工作目录）；`query?: string`（搜索词）；`limit?: number`（最多返回条数）
- **返回** `Record<string, unknown>[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1239](../../core/src/modules/memory.ts#L1239)

## memory.log
<!-- api:method -->

- **用途** 按日期聚合记忆日志并分页。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `days?: number`（天数）；`since?: number`（起始时间（毫秒））；`scope?: string`（范围）；`cwd?: string`（工作目录）；`until?: number`（截止时间（毫秒））；`itemId?: string`（记忆条目 ID）；`limit?: number`（最多返回条数）；`cursor?: string`（分页游标）；`sessionId?: string`（Pi 会话 ID）
- **返回** `{ boundaries: { id: string; sessionId: string; reason: string; at: number; before: TaskView | null; after: TaskView; changed: boolean; undone: boolean; }[]; days: { entries: ({ after: { workspacePath: string | null; possiblyOutdated: boolean; review: { owner: string; nextAt: number | null; pendingIds: string[]; lastVerifiedAt: number | null; cadence: string; paused: boolean; } | null; id: string; version: number; level: Level; kind: ItemKind; content: string; conditions: string | null; scope: ItemScope; workspaceId: string | null; groupId: string | null; confidence: Confidence; status: ItemStatus; pinned: boolean; retention: Retention; autoOk: boolean; occurredAt: number | null; validFrom: number | null; validUntil: number | null; lastVerifiedAt: number | null; nextReviewAt: number | null; lastUsedAt: number | null; useCount: number; createdAt: number; updatedAt: number; createdBy: Actor; } | null; before: { workspacePath: string | null; possiblyOutdated: boolean; review: { owner: string; nextAt: number | null; pendingIds: string[]; lastVerifiedAt: number | null; cadence: string; paused: boolean; } | null; id: string; version: number; level: Level; kind: ItemKind; content: string; conditions: string | null; scope: ItemScope; workspaceId: string | null; groupId: string | null; confidence: Confidence; status: ItemStatus; pinned: boolean; retention: Retention; autoOk: boolean; occurredAt: number | null; validFrom: number | null; validUntil: number | null; lastVerifiedAt: number | null; nextReviewAt: number | null; lastUsedAt: number | null; useCount: number; createdAt: number; updatedAt: number; createdBy: Actor; } | null; opId: string; batchId: string; batchKind: string; at: number; actor: Actor; kind: MemoryOp["kind"] | "undo"; itemId: string; changed: string[]; reason: string | null; inferred: boolean; sessionRef: string | null; undoOf: string | null; undone: boolean; undoable: boolean; } | { after: { workspacePath: string | null; possiblyOutdated: boolean; review: { owner: string; nextAt: number | null; pendingIds: string[]; lastVerifiedAt: number | null; cadence: string; paused: boolean; } | null; id: string; version: number; level: Level; kind: ItemKind; content: string; conditions: string | null; scope: ItemScope; workspaceId: string | null; groupId: string | null; confidence: Confidence; status: ItemStatus; pinned: boolean; retention: Retention; autoOk: boolean; occurredAt: number | null; validFrom: number | null; validUntil: number | null; lastVerifiedAt: number | null; nextReviewAt: number | null; lastUsedAt: number | null; useCount: number; createdAt: number; updatedAt: number; createdBy: Actor; } | null; before: { workspacePath: string | null; possiblyOutdated: boolean; review: { owner: string; nextAt: number | null; pendingIds: string[]; lastVerifiedAt: number | null; cadence: string; paused: boolean; } | null; id: string; version: number; level: Level; kind: ItemKind; content: string; conditions: string | null; scope: ItemScope; workspaceId: string | null; groupId: string | null; confidence: Confidence; status: ItemStatus; pinned: boolean; retention: Retention; autoOk: boolean; occurredAt: number | null; validFrom: number | null; validUntil: number | null; lastVerifiedAt: number | null; nextReviewAt: number | null; lastUsedAt: number | null; useCount: number; createdAt: number; updatedAt: number; createdBy: Actor; } | null; at: number; reason: string | null; itemId: string; opId: string; batchId: string; batchKind: string; actor: Actor; changed: string[]; inferred: boolean; sessionRef: string | null; undoOf: string | null; undone: boolean; undoable: boolean; kind: "purge"; scope: ItemScope; level: number; workspaceId: string | null; })[]; day: string; }[]; hasMore: boolean; cursor: string | null; }`。
- **错误** `bad_request`（未知的记忆范围）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1117](../../core/src/modules/memory.ts#L1117)

## memory.migrationReport
<!-- api:method -->

- **用途** 读取记忆迁移报告。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `MigrationReport | null`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1168](../../core/src/modules/memory.ts#L1168)

## memory.newTask
<!-- api:method -->

- **用途** 标记接下来切换到新任务。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `sessionId: string`（Pi 会话 ID）
- **返回** `{ ok: boolean; note: string; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1174](../../core/src/modules/memory.ts#L1174)

## memory.pending
<!-- api:method -->

- **用途** 列出待确认记忆变更。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `cwd?: string`（工作目录）
- **返回** `PendingChange[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1146](../../core/src/modules/memory.ts#L1146)

## memory.purge
<!-- api:method -->

- **用途** 永久清理记忆并报告关联会话。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** id: string、confirm: true（必填）
- **返回** `{ sessions: { path: string; title: string; exists: boolean; }[]; notes: string[]; }`。
- **错误** `bad_request`（彻底删除要再确认一次（confirm: true），删除后不能恢复）。
- **事件** [`memory.changed`](events.md#memorychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。 返回仍引用旧记忆的会话定位和说明；用户界面可以据此提示清理范围。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1136](../../core/src/modules/memory.ts#L1136)

## memory.refresh
<!-- api:method -->

- **用途** 刷新会话的记忆上下文。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `sessionId: string`（Pi 会话 ID）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1199](../../core/src/modules/memory.ts#L1199)

## memory.rejectPending
<!-- api:method -->

- **用途** 驳回待定记忆变更。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`memory.changed`](events.md#memorychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1157](../../core/src/modules/memory.ts#L1157)

## memory.restore
<!-- api:method -->

- **用途** 恢复指定记忆。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`、`version: number`（必填，选择要恢复到的历史版本）。
- **返回** `{ item: { workspacePath: string | null; possiblyOutdated: boolean; review: { owner: string; nextAt: number | null; pendingIds: string[]; lastVerifiedAt: number | null; cadence: string; paused: boolean; } | null; id: string; version: number; level: Level; kind: ItemKind; content: string; conditions: string | null; scope: ItemScope; workspaceId: string | null; groupId: string | null; confidence: Confidence; status: ItemStatus; pinned: boolean; retention: Retention; autoOk: boolean; occurredAt: number | null; validFrom: number | null; validUntil: number | null; lastVerifiedAt: number | null; nextReviewAt: number | null; lastUsedAt: number | null; useCount: number; createdAt: number; updatedAt: number; createdBy: Actor; }; batchId: string | null; applied: { opId: string; itemId: string; kind: MemoryOp["kind"]; index: number; }[]; pending: { pendingId: string; itemId: string | null; why: PendingWhy; index: number; }[]; rejected: { index: number; reason: string; }[]; currentTask: "next_call" | "next_task"; }`。
- **错误** `bad_request`（version is required）。
- **事件** [`memory.changed`](events.md#memorychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1129](../../core/src/modules/memory.ts#L1129)

## memory.runJobs
<!-- api:method -->

- **用途** 手动驱动记忆后台作业。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ ok: boolean; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** [`memory.jobs.changed`](events.md#memoryjobschanged)、[`memory.changed`](events.md#memorychanged)、[`memory.notice`](events.md#memorynotice)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1213](../../core/src/modules/memory.ts#L1213)

## memory.save
<!-- api:method -->

- **用途** 保存记忆，可接续待保存回执。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** content: string（必填）；kind?: ItemKind；level?: 1 或 2 或 3；scope?: ItemScope；workspaceId?: string 或 cwd?: string（workspace 范围）；groupId?: string（group 范围）；conditions?: string；pinned?: boolean；retention?: Retention；validUntil?: number；unsavedRef?: {sessionId: string, runId: string}
- **返回** `CommitResult & {item: MemoryItemView, currentTask: 'next_task'}`。CommitResult 含 batchId、applied、pending、rejected。
- **错误** `bad_request`（缺正文、工作区或分组参数不足，或批次提交被拒，包括存储保护拒写）。
- **事件** [`memory.changed`](events.md#memorychanged)、[`memory.unsaved`](events.md#memoryunsaved)；按实际状态变化推送，次数与顺序见事件和本节说明。 成功写入批次后可发 memory.changed；匹配并清除 unsavedRef 时再发 memory.unsaved。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1073](../../core/src/modules/memory.ts#L1073)

## memory.sessionMode
<!-- api:method -->

- **用途** 读取会话的记忆模式。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `sessionId: string`（Pi 会话 ID）
- **返回** `{ mode: SessionMemoryMode; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1190](../../core/src/modules/memory.ts#L1190)

## memory.setBlock
<!-- api:method -->

- **用途** 修改指定旧版记忆块。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `key: string`；`content?: string`（正文）；`locked?: boolean`
- **返回** `{ key: string; title: string; content: string; locked: boolean; updatedAt: number | null; }[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`memory.changed`](events.md#memorychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1277](../../core/src/modules/memory.ts#L1277)

## memory.setSessionMode
<!-- api:method -->

- **用途** 设置会话的记忆模式。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `sessionId: string`（Pi 会话 ID）；`mode?: string`（模式）
- **返回** `{ mode: "off" | "normal" | "readonly"; }`。
- **错误** `bad_request`（mode 是 normal、readonly 或 off）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1191](../../core/src/modules/memory.ts#L1191)

## memory.setStatus
<!-- api:method -->

- **用途** 改变记忆状态。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`、`status: ItemStatus`（必填）；`version?: number`；`reason?: string`。
- **返回** `{ item: { workspacePath: string | null; possiblyOutdated: boolean; review: { owner: string; nextAt: number | null; pendingIds: string[]; lastVerifiedAt: number | null; cadence: string; paused: boolean; } | null; id: string; version: number; level: Level; kind: ItemKind; content: string; conditions: string | null; scope: ItemScope; workspaceId: string | null; groupId: string | null; confidence: Confidence; status: ItemStatus; pinned: boolean; retention: Retention; autoOk: boolean; occurredAt: number | null; validFrom: number | null; validUntil: number | null; lastVerifiedAt: number | null; nextReviewAt: number | null; lastUsedAt: number | null; useCount: number; createdAt: number; updatedAt: number; createdBy: Actor; }; currentTask: "next_task" | "next_call"; batchId: string | null; applied: { opId: string; itemId: string; kind: MemoryOp["kind"]; index: number; }[]; pending: { pendingId: string; itemId: string | null; why: PendingWhy; index: number; }[]; rejected: { index: number; reason: string; }[]; }`。
- **错误** `bad_request`（status is required）。
- **事件** [`memory.changed`](events.md#memorychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1110](../../core/src/modules/memory.ts#L1110)

## memory.setWorkspaceBackground
<!-- api:method -->

- **用途** 修改工作区记忆后台处理开关。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）；`on?: boolean`
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`memory.changed`](events.md#memorychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1163](../../core/src/modules/memory.ts#L1163)

## memory.snapshotInfo
<!-- api:method -->

- **用途** 读取指定会话最近的快照。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `sessionId: string`（Pi 会话 ID）
- **返回** `SnapshotRow | null`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1170](../../core/src/modules/memory.ts#L1170)

## memory.snapshots
<!-- api:method -->

- **用途** 列出注入到指定会话的记忆快照。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `sessionId: string`（Pi 会话 ID）
- **返回** `(SnapshotRow & { memoryIds: string[]; })[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1169](../../core/src/modules/memory.ts#L1169)

## memory.spending
<!-- api:method -->

- **用途** 读取今日记忆处理花费和预算。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ today: number; dailyBudget: number; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1218](../../core/src/modules/memory.ts#L1218)

## memory.tasks
<!-- api:method -->

- **用途** 列出会话里的记忆任务。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `sessionId: string`（Pi 会话 ID）
- **返回** `TaskView[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1173](../../core/src/modules/memory.ts#L1173)

## memory.undo
<!-- api:method -->

- **用途** 按操作 ID 撤销记忆改动。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `opId: string`
- **返回** `{ batchId: string | null; undone: string[]; conflicts: { opId: string; itemId: string; reason: string; }[]; } & { currentTask: "next_call" | "next_task"; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`memory.changed`](events.md#memorychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1127](../../core/src/modules/memory.ts#L1127)

## memory.undoBatch
<!-- api:method -->

- **用途** 撤销一批记忆改动。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `batchId: string`（批次 ID）
- **返回** `{ batchId: string | null; undone: string[]; conflicts: { opId: string; itemId: string; reason: string; }[]; } & { currentTask: "next_call" | "next_task"; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`memory.changed`](events.md#memorychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1145](../../core/src/modules/memory.ts#L1145)

## memory.undoBoundary
<!-- api:method -->

- **用途** 撤销一次记忆任务边界变更。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `{ sessionId: string; task: TaskView | null; }`。
- **错误** `bad_request`（缺 id）；`not_found`（边界不存在或已撤销）；后续已有新的边界判断、无法撤销时返回 `internal`。
- **事件** [`memory.task`](events.md#memorytask)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1022](../../core/src/modules/memory.ts#L1022)

## memory.unsaved
<!-- api:method -->

- **用途** 读取会话最近的待保存声明。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `sessionId: string`（Pi 会话 ID）
- **返回** `UnsavedClaim | null`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1128](../../core/src/modules/memory.ts#L1128)

## memory.update
<!-- api:method -->

- **用途** 更新已有记忆。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（必填）；`version?: number`；`reason?: string`。补丁字段可包括 content、kind、level、conditions、scope、cwd、workspaceId、groupId、confidence、pinned、retention、autoOk、validUntil、nextReviewAt。conditions、validUntil、nextReviewAt 可用 null 清除。
- **返回** `{ item: { workspacePath: string | null; possiblyOutdated: boolean; review: { owner: string; nextAt: number | null; pendingIds: string[]; lastVerifiedAt: number | null; cadence: string; paused: boolean; } | null; id: string; version: number; level: Level; kind: ItemKind; content: string; conditions: string | null; scope: ItemScope; workspaceId: string | null; groupId: string | null; confidence: Confidence; status: ItemStatus; pinned: boolean; retention: Retention; autoOk: boolean; occurredAt: number | null; validFrom: number | null; validUntil: number | null; lastVerifiedAt: number | null; nextReviewAt: number | null; lastUsedAt: number | null; useCount: number; createdAt: number; updatedAt: number; createdBy: Actor; }; currentTask: "next_task" | "next_call"; batchId: string | null; applied: { opId: string; itemId: string; kind: MemoryOp["kind"]; index: number; }[]; pending: { pendingId: string; itemId: string | null; why: PendingWhy; index: number; }[]; rejected: { index: number; reason: string; }[]; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 实际提交修改后发 `memory.changed`，按 batchId 标识变更。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1105](../../core/src/modules/memory.ts#L1105)

## memory.whyNot
<!-- api:method -->

- **用途** 解释一条记忆未进入会话的原因。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `sessionId: string`（Pi 会话 ID）；`itemId: string`（记忆条目 ID）；`cwd?: string`（工作目录）
- **返回** `{ reason: string; snapshotId: string | null; at: number | null; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1171](../../core/src/modules/memory.ts#L1171)

## memory.workspaces
<!-- api:method -->

- **用途** 列出记忆工作区和后台处理偏好。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `Workspace[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/memory.ts:1162](../../core/src/modules/memory.ts#L1162)
