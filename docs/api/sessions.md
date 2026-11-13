# 会话、上下文与运行

字段后缀 `?` 表示可省略。通用传输及错误格式见[调用约定](README.md)，类型见[数据结构](types.md)。

## artifacts.list
<!-- api:method -->

- **用途** 按工作区、任务或写笺读取产物索引。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `cwd?: string`（工作目录）；`taskId?: string`（任务 ID）；`noteId?: string`（写笺 ID）；`limit?: number`（最多返回条数）
- **返回** `Artifact[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 将来可开放给模块。
- **源码** [modules/tasks.ts:816](../../core/src/modules/tasks.ts#L816)

## confirm.answer
<!-- api:method -->

- **用途** 向自主授权或会话交互提交回答。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** id: string（必填，确认请求 ID）；response: object（按交互类型，含选择、确认或输入值）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（缺 id）；`gone`（确认已失效或不存在）。
- **事件** [`confirm.changed`](events.md#confirmchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [core.ts:804](../../core/src/core.ts#L804)

## confirm.list
<!-- api:method -->

- **用途** 列出持久化确认记录。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `status?: string`（状态过滤或目标状态）；`limit?: number`（最多返回条数）
- **返回** `Confirmation[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [core.ts:803](../../core/src/core.ts#L803)

## context.checkpoints
<!-- api:method -->

- **用途** 读取选中会话的压缩检查点。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** slotId: string（必填）
- **返回** `{ entryId: string; summary: string; firstKeptEntryId: string; tokensBefore: number; at: string; reported: boolean; }[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/context.ts:283](../../core/src/modules/context.ts#L283)

## context.compactions
<!-- api:method -->

- **用途** 查看压缩历史。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `sessionId?: string`（Pi 会话 ID）；`limit?: number`（最多返回条数）
- **返回** `unknown[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/context.ts:317](../../core/src/modules/context.ts#L317)

## context.compactNow
<!-- api:method -->

- **用途** 为选中的会话立即发起压缩。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** slotId: string（必填）；focus?: string（摘要关注点）
- **返回** `{} | null`。
- **错误** `bad_request`（正在压缩）。
- **事件** [`context.compaction`](events.md#contextcompaction)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/context.ts:278](../../core/src/modules/context.ts#L278)

## context.info
<!-- api:method -->

- **用途** 读取上下文占用、窗口和压缩设置。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** slotId: string（必填，已打开且启动完毕）
- **返回** `{ usage: ContextUsage | null | undefined; contextWindow: number | null; thresholdPercent: number; thresholdTokens: number | null; ownThreshold: number | null; autoCompaction: boolean; background: { on: boolean; ownChoice: number | null; model: "session" | "aux"; leadPercent: number; last: { kind: string; outcome: string; reason: string | null; at: number; } | null; }; compacting: boolean; checkpoints: number; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/context.ts:240](../../core/src/modules/context.ts#L240)

## context.original
<!-- api:method -->

- **用途** 读取压缩前的原始消息片段。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** slotId: string、entryId: string（必填，压缩检查点）
- **返回** `{ entryId: string; role: string; text: string; }[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/context.ts:284](../../core/src/modules/context.ts#L284)

## context.regenerate
<!-- api:method -->

- **用途** 基于原始记录或上一摘要重做压缩。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** slotId: string、entryId: string（必填）；note?: string；focus?: string
- **返回** `{ source: "original" | "previous_summary" | undefined; } | null`。
- **错误** `bad_request`（只能重新生成当前分支最新的压缩检查点）。
- **事件** [`context.compaction`](events.md#contextcompaction)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/context.ts:294](../../core/src/modules/context.ts#L294)

## context.report
<!-- api:method -->

- **用途** 记录对某次压缩的反馈。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** slotId: string、entryId: string（必填）；note?: string
- **返回** `{ id: string; }`。
- **错误** `not_found`（没有这个压缩检查点）；`bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/context.ts:285](../../core/src/modules/context.ts#L285)

## context.setSession
<!-- api:method -->

- **用途** 设置单个会话的压缩阈值与后台处理偏好。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** sessionId?: string 或 slotId?: string（二者择一）；thresholdPercent?: 20–95 的整数或 null；background?: boolean 或 null。null 清除覆盖项
- **返回** `{ thresholdPercent: number | null; background: boolean | null; }`。
- **错误** `bad_request`（压缩阈值是 20–95 之间的整数（上下文窗口的百分比））。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/context.ts:261](../../core/src/modules/context.ts#L261)

## context.stats
<!-- api:method -->

- **用途** 汇总压缩统计。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `since?: number`（起始时间（毫秒））
- **返回** `{normal:{count,p50,p95,cost},background:{count,p50,p95,made,used,useRate,dropped,cost}}`。计数、用时和花费是 number，p50、p95、useRate 在无样本时可为 null，dropped 按原因映射到次数。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/context.ts:320](../../core/src/modules/context.ts#L320)

## files.convert
<!-- api:method -->

- **用途** 将受支持的办公文档转换为文本并返回元数据。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `path: string`（文件或目录路径）
- **返回** `{ text: string; kindLabel: string; path: string; name: string; kind: DocumentKind; chars: number; parts: number | null; size: number; large: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 将来可开放给模块。
- **源码** [modules/documents.ts:263](../../core/src/modules/documents.ts#L263)

## runs.acknowledge
<!-- api:method -->

- **用途** 标记运行结果已读。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`runs.changed`](events.md#runschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [core.ts:821](../../core/src/core.ts#L821)

## runs.get
<!-- api:method -->

- **用途** 读取一次运行的摘要。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `Run | null`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [core.ts:819](../../core/src/core.ts#L819)

## runs.list
<!-- api:method -->

- **用途** 按会话、任务及状态列出运行记录。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `sessionFile?: string`（会话文件路径）；`taskId?: string`（任务 ID）；`status?: string`（状态过滤或目标状态）；`limit?: number`（最多返回条数）
- **返回** `Run[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [core.ts:816](../../core/src/core.ts#L816)

## runs.steps
<!-- api:method -->

- **用途** 读取一次运行记录下的工具步骤。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `runId: string`（运行 ID）
- **返回** `RunStep[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [core.ts:820](../../core/src/core.ts#L820)

## search.all
<!-- api:method -->

- **用途** 跨对话、产物和记忆搜索。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `query: string`（搜索词）；`cwd?: string`（工作目录）；`limit?: number`（最多返回条数）
- **返回** `{ conversations: { target: { page: string; sessionFile: string; entryId: string | null; }; path: string; title: string; snippet: string; entryId: string | null; cwd: string | null; }[]; files: { target: { page: string; path: string; taskId: string | null; }; path: string; taskId: string | null; exists: boolean; }[]; memories: { target: { page: string; itemId: string; }; id: string; content: string; }[]; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 将来可开放给模块。
- **源码** [modules/session-index.ts:473](../../core/src/modules/session-index.ts#L473)

## sessions.children
<!-- api:method -->

- **用途** 列出父会话下的侧边对话。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `parentSession: string`（父会话文件）；`cwd?: string`（工作目录）
- **返回** `SessionRow[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/session-index.ts:497](../../core/src/modules/session-index.ts#L497)

## sessions.delete
<!-- api:method -->

- **用途** 将会话及关联分支移入回收站。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `path: string`（文件或目录路径）
- **返回** `{ deleted: string[]; sideCount: number; batchId: string; expiresAt: number; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`sessions.changed`](events.md#sessionschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。 回收站操作生成 batchId。写入完成后发送 sessions.changed，可用 sessions.restore 恢复。
- **开放范围** 仅内部。
- **源码** [modules/session-index.ts:496](../../core/src/modules/session-index.ts#L496)

## sessions.deletePreview
<!-- api:method -->

- **用途** 列出删除会话时会受影响的分支文件。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `path: string`（文件或目录路径）
- **返回** `{ sideCount: number; paths: string[]; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/session-index.ts:491](../../core/src/modules/session-index.ts#L491)

## sessions.list
<!-- api:method -->

- **用途** 列出指定工作区当前或已归档的对话。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `cwd?: string`（按工作目录过滤）；`archived?: 'exclude'|'only'|'include'`（默认 exclude，only 只看已归档，include 同时列出两类）。
- **返回** `SessionRow[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。 置顶优先，其余按最后一条消息的时间排序。打开旧会话不改变其消息时间。
- **开放范围** 仅内部。
- **源码** [modules/session-index.ts:504](../../core/src/modules/session-index.ts#L504)

## sessions.markSeen
<!-- api:method -->

- **用途** 标记会话已读。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `sessionFile: string`（会话文件路径）
- **返回** `{ ok: boolean; }`。
- **错误** `not_found`（找不到这段对话）；`bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/session-index.ts:509](../../core/src/modules/session-index.ts#L509)

## sessions.purgeExpired
<!-- api:method -->

- **用途** 清除到期回收批次。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ purged: string[]; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** [`sessions.changed`](events.md#sessionschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/session-index.ts:472](../../core/src/modules/session-index.ts#L472)

## sessions.recycleBin
<!-- api:method -->

- **用途** 读取回收批次、原路径和到期时间。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ batchId: string; originalPath: string; deletedAt: number; expiresAt: number; phase: "deleting" | "stored" | "restoring" | "purging"; session: any; }[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/session-index.ts:467](../../core/src/modules/session-index.ts#L467)

## sessions.restore
<!-- api:method -->

- **用途** 按批次恢复会话。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `batchId: string`（批次 ID）
- **返回** `{ restored: string[]; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`sessions.changed`](events.md#sessionschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。 按批次恢复；发生路径冲突或批次失效时无法恢复。
- **开放范围** 仅内部。
- **源码** [modules/session-index.ts:468](../../core/src/modules/session-index.ts#L468)

## sessions.search
<!-- api:method -->

- **用途** 查询会话全文并返回命中位置。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `query: string`（搜索词）；`cwd?: string`（工作目录）；`limit?: number`（最多返回条数）
- **返回** `SearchHit[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 将来可开放给模块。
- **源码** [modules/session-index.ts:519](../../core/src/modules/session-index.ts#L519)

## sessions.setArchived
<!-- api:method -->

- **用途** 修改会话归档状态。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** path: string（必填）；archived?: boolean（省略等同 false）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（path 不是字符串）；`not_found`（会话不存在）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/session-index.ts:527](../../core/src/modules/session-index.ts#L527)

## sessions.setPinned
<!-- api:method -->

- **用途** 修改会话置顶。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** path: string（必填）；pinned?: boolean（省略等同 false）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（path 不是字符串）；`not_found`（会话不存在）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/session-index.ts:523](../../core/src/modules/session-index.ts#L523)

## sessions.workspaces
<!-- api:method -->

- **用途** 按历史会话汇总工作目录。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ cwd: string; last: number; n: number; }[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/session-index.ts:531](../../core/src/modules/session-index.ts#L531)

## slot.attach
<!-- api:method -->

- **用途** 附加已有会话并回放待答交互及实时快照。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** slotId: string（必填，现有会话槽）
- **返回** `{ info: SlotInfo; replay: UiRequest[]; live: Record<string, unknown>[]; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。 返回 info、replay、live。其后只向已附加连接发送 slot.record。
- **开放范围** 仅内部。
- **源码** [core.ts:768](../../core/src/core.ts#L768)

## slot.close
<!-- api:method -->

- **用途** 关闭打开中的或已就绪的会话。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `slotId: string`（活动会话槽 ID）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`slot.closed`](events.md#slotclosed)；按实际状态变化推送，次数与顺序见事件和本节说明。 清理会话后发 slot.closed。关闭打开中的会话也会终止初始化。
- **开放范围** 仅内部。
- **源码** [core.ts:798](../../core/src/core.ts#L798)

## slot.detach
<!-- api:method -->

- **用途** 取消当前连接对会话记录的订阅。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `slotId?: string`（活动会话槽 ID）
- **返回** `{ ok: boolean; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [core.ts:774](../../core/src/core.ts#L774)

## slot.list
<!-- api:method -->

- **用途** 列出已打开会话。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `SlotInfo[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [core.ts:767](../../core/src/core.ts#L767)

## slot.open
<!-- api:method -->

- **用途** 创建或加载 Pi 会话并附加请求连接。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** cwd: string（必填，工作目录）；slotId?: string（客户端指定 ID）；sessionFile?: string（加载存档）；incognito?: boolean；agentMode?: standard 或 minimal；sandbox?: boolean（蝶君）；forkOf?: string；parentSlotId?: string；sideQuote?: string；quoteEntryId?: string
- **返回** `SlotInfo`。
- **错误** `bad_request`（缺 cwd）；`not_found`（引用的会话或父槽无效）；`unavailable`（后台停止）；启动、文件和沙箱错误也可走 `internal`。
- **事件** [`slot.changed`](events.md#slotchanged)、[`slot.record`](events.md#slotrecord)；按实际状态变化推送，次数与顺序见事件和本节说明。 成功打开后 slot.changed。传入有效客户端时附加会话，早期会话记录可能先于 RPC 响应。沙箱槽指向蝶君；隐身槽没有持久会话文件。
- **开放范围** 仅内部。
- **源码** [core.ts:751](../../core/src/core.ts#L751)

## slot.send
<!-- api:method -->

- **用途** 向 Pi 会话提交命令或交互回答。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** slotId: string（必填，允许正在打开的会话槽）；record: object（必填，type: string，id?: string，其他字段见 Pi 命令）。prompt 可带 chatInput 对象，含 text、attachments、materials
- **返回** `{ok:true}`（已接收）；命令执行结果另见 slot.record。
- **错误** `not_found`（槽不存在）；`bad_request`（record.type 缺失或 chatInput 无效）；`unavailable`（退出中提交 prompt）；`busy`（维护中提交 prompt）。命令自身失败见 record.success/error。
- **事件** [`slot.record`](events.md#slotrecord)、[`slot.changed`](events.md#slotchanged)、[`confirm.changed`](events.md#confirmchanged)、[`run.finished`](events.md#runfinished)；按实际状态变化推送，次数与顺序见事件和本节说明。 外层 ok 表示后台已收下命令。普通 Pi 命令的结果由 slot.record 内的 response 报告。流式事件按实际产生顺序推送，response 和流式事件的先后取决于命令。蝶君结构化对话也可能进入交办分流。
- **开放范围** 仅内部。
- **源码** [core.ts:778](../../core/src/core.ts#L778)

## vision.lookup
<!-- api:method -->

- **用途** 按图片哈希读取已有描述。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `hashes?: string[]`（图片哈希列表）
- **返回** `Record<string, ImageDescription>`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/vision.ts:41](../../core/src/modules/vision.ts#L41)

## workspace.removeToolRule
<!-- api:method -->

- **用途** 撤销一条工作区工具许可。
- **调用方** 窗口，工作台。
- **参数** `cwd: string`（工作目录）；`tool: string`（工具名）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [core.ts:829](../../core/src/core.ts#L829)

## workspace.toolRules
<!-- api:method -->

- **用途** 列出指定工作区已保存的工具许可。
- **调用方** 窗口，工作台。
- **参数** `cwd: string`（工作目录）
- **返回** `{ tool: string; created_at: number; }[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [core.ts:826](../../core/src/core.ts#L826)
