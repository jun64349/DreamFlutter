# 蝶君、任务与等你处理

字段后缀 `?` 表示可省略。通用传输及错误格式见[调用约定](README.md)，类型见[数据结构](types.md)。

## attention.list
<!-- api:method -->

- **用途** 列出立即处理、稍后处理和正在执行的动作。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ now: AttentionItem[]; later: AttentionItem[]; counts: { now: number; later: number; total: number; }; pending: ActionReceipt[]; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/attention.ts:39](../../core/src/modules/attention.ts#L39)

## attention.metrics
<!-- api:method -->

- **用途** 读取最近的每日处理指标。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `days?: number`（天数）
- **返回** `DailyMetrics[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/attention.ts:41](../../core/src/modules/attention.ts#L41)

## attention.prioritized
<!-- api:method -->

- **用途** 列出带决策、阻塞和验收语义的优先事项。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ id: string; category: "decision" | "blocked" | "review"; object: string; occurredAt: number; situation: string; actions: string[]; target: AttentionItem["target"] & { goalId?: string; }; notified: boolean; }[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/attention.ts:40](../../core/src/modules/attention.ts#L40)

## attention.receipt
<!-- api:method -->

- **用途** 读取动作回执。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `ActionReceipt`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/attention.ts:45](../../core/src/modules/attention.ts#L45)

## attention.resolve
<!-- api:method -->

- **用途** 为指定事项提交动作。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（必填，事项 ID），`action: string`（必填，从该事项的 actions 取），`response?: object`（回答时含 value，验收退回时含 reason）。
- **返回** `ActionReceipt`。稍后处理先返回 pending；立即处理等待执行结束，通常返回 applied 或 failed。
- **错误** `unavailable`（后台退出），`conflict`（同事项已在处理），`gone`（事项已处理或不存在），`bad_request`（动作或回答无效）。执行失败见回执。
- **事件** 先发 `attention.action`（pending），再发 `attention.changed`。执行结束可再发回执和列表变化。later 事项留 5 秒可撤销。
- **开放范围** 仅内部。
- **源码** [modules/attention.ts:43](../../core/src/modules/attention.ts#L43)

## attention.undo
<!-- api:method -->

- **用途** 撤销仍在撤销窗口内的动作。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `ActionReceipt`。
- **错误** `bad_request`（缺回执 ID）；`gone`（回执已不在撤销窗口）。
- **事件** 成功后发 `attention.action`（cancelled），然后发 `attention.changed`。
- **开放范围** 仅内部。
- **源码** [modules/attention.ts:44](../../core/src/modules/attention.ts#L44)

## autonomy.rules.delete
<!-- api:method -->

- **用途** 删除规则。
- **调用方** 窗口或后台，蝶君。
- **参数** `id: string`（对象标识）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/autonomy/index.ts:111](../../core/src/modules/autonomy/index.ts#L111)

## autonomy.rules.hits
<!-- api:method -->

- **用途** 读取规则命中记录。
- **调用方** 窗口或后台，蝶君。
- **参数** `id: string`（对象标识）；`limit?: JSON`（最多返回条数）
- **返回** `{ eventId: string; costUsd: number; revision: number; at: number; mode: RuleMode; reason: string; }[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/autonomy/index.ts:115](../../core/src/modules/autonomy/index.ts#L115)

## autonomy.rules.list
<!-- api:method -->

- **用途** 列出自主规则。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `Rule[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/autonomy/index.ts:108](../../core/src/modules/autonomy/index.ts#L108)

## autonomy.rules.mode
<!-- api:method -->

- **用途** 切换指定规则的模式。
- **调用方** 窗口或后台，蝶君。
- **参数** id: string、mode: RuleMode（必填）
- **返回** `Rule`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/autonomy/index.ts:110](../../core/src/modules/autonomy/index.ts#L110)

## autonomy.rules.save
<!-- api:method -->

- **用途** 创建或更新自主规则。
- **调用方** 窗口或后台，蝶君。
- **参数** rule: RuleDefinition（必填）；id?: string（更新规则）；mode?: RuleMode
- **返回** `Rule`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/autonomy/index.ts:109](../../core/src/modules/autonomy/index.ts#L109)

## butterfly.answer
<!-- api:method -->

旧，0.12 换掉。新待答通过 attention.resolve 或对应的 confirm.answer。

- **用途** 回答旧交办的准备问题。
- **调用方** 窗口或后台，蝶君。
- **参数** `id: string`（对象标识）；`answer: string`
- **返回** `Intent`。
- **错误** `conflict`（这项任务没有在等回答）；`bad_request`（必需字段缺失或不合法）。
- **事件** [`tasks.changed`](events.md#taskschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/butterfly.ts:447](../../core/src/modules/butterfly.ts#L447)

## butterfly.cancel
<!-- api:method -->

旧，0.12 换掉。新目标用 goals.control 的 cancel。

- **用途** 取消旧交办。
- **调用方** 窗口或后台，蝶君。
- **参数** `id: string`（对象标识）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`tasks.changed`](events.md#taskschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/butterfly.ts:452](../../core/src/modules/butterfly.ts#L452)

## butterfly.chat.artifact
<!-- api:method -->

- **用途** 定位该交办已登记的交付文件。
- **调用方** 窗口或后台，蝶君。
- **参数** `goalId: string`（目标 ID）；`name: string`（名称）
- **返回** `{ name: string; path: string; size: number; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/goals/chat-workflow.ts:56](../../core/src/modules/goals/chat-workflow.ts#L56)

## butterfly.chat.tasks
<!-- api:method -->

- **用途** 读取由此蝶君会话交办的目标及交付。
- **调用方** 窗口或后台，蝶君。
- **参数** `sessionFile: string`（会话文件路径）
- **返回** `{ goalId: string; status: "cancelled" | "running" | "failed" | "blocked" | "completed" | "draft" | "queued" | "reviewing" | "waiting_dependency" | "waiting_user" | "paused" | "uncertain"; reason: string | null; title: string | null; plan: string | null; inputs: string[]; deliverables: string[]; createdAt: number; delivery: { state: EffectState; receipt: string | null; goalId: string; files: string[]; explanation: string; external?: boolean; } | null; }[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/goals/chat-workflow.ts:55](../../core/src/modules/goals/chat-workflow.ts#L55)

## butterfly.handOff
<!-- api:method -->

- **用途** 把写笺及其关联资料交给蝶君。
- **调用方** 窗口或后台，蝶君。
- **参数** `noteId: string`（写笺 ID）
- **返回** `{ task: Task; prompt: string; }`。
- **错误** `not_found`（这份写笺不存在）；`busy`（后台正在退出）；`bad_request`（必需字段缺失或不合法）。
- **事件** [`tasks.changed`](events.md#taskschanged)、[`desk.changed`](events.md#deskchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/butterfly.ts:456](../../core/src/modules/butterfly.ts#L456)

## butterfly.import
<!-- api:method -->

- **用途** 复制所选文件进蝶君收件箱。
- **调用方** 窗口或后台，蝶君。
- **参数** `paths?: string[]`
- **返回** `{ paths: string[]; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/butterfly.ts:465](../../core/src/modules/butterfly.ts#L465)

## butterfly.info
<!-- api:method -->

- **用途** 读取蝶君工作目录、沙箱与收发目录。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `{ home: string; distro: string | null; inbox: string; outbox: string; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/butterfly.ts:454](../../core/src/modules/butterfly.ts#L454)

## butterfly.outbox
<!-- api:method -->

- **用途** 列出蝶君发件箱文件。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `OutboxFile[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/butterfly.ts:455](../../core/src/modules/butterfly.ts#L455)

## butterfly.prepare
<!-- api:method -->

旧，0.12 换掉。新交办通过 slot.send 的结构化蝶君对话进入目标服务。

- **用途** 为旧交办生成准备内容或待补充问题。
- **调用方** 窗口或后台，蝶君。
- **参数** `slotId: string`（活动会话槽 ID）；`goal: string`
- **返回** `Intent`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`butterfly.prepared`](events.md#butterflyprepared)、[`tasks.changed`](events.md#taskschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/butterfly.ts:434](../../core/src/modules/butterfly.ts#L434)

## butterfly.start
<!-- api:method -->

旧，0.12 换掉。新交办沿 slot.send、goals.control 的流程。

- **用途** 启动或继续已准备的旧交办。
- **调用方** 窗口或后台，蝶君。
- **参数** `id: string`（对象标识）；`slotId?: string`（活动会话槽 ID）
- **返回** `{ ok: boolean; waiting: boolean; } | { ok: boolean; waiting?: undefined; }`。
- **错误** `conflict`（请重新打开这项任务的蝶君对话）；`bad_request`（必需字段缺失或不合法）。
- **事件** [`tasks.changed`](events.md#taskschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/butterfly.ts:435](../../core/src/modules/butterfly.ts#L435)

## butterfly.tasks
<!-- api:method -->

旧，0.12 换掉。新交办读 butterfly.chat.tasks，目标总览用 goals.list。

- **用途** 列出旧交办流程的任务与进度。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `{ status: "failed" | "waiting" | "in_progress" | "completed"; progress: string; delivery: { summary: string; files: Artifact[]; cost: number; durationMs: number; } | null; intent: Intent | undefined; id: string; title: string; goal: string; cwd: string; sessionFile: string | null; source: TaskSource; noteId: string | null; scheduleId: string | null; goalId?: string; attempt?: number; materialIds: string[]; result: string | null; error: string | null; runs: number; turns: number; cost: number; durationMs: number; currentStep: string | null; createdAt: number; updatedAt: number; endedAt: number | null; }[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/butterfly.ts:432](../../core/src/modules/butterfly.ts#L432)

## butterfly.tick
<!-- api:method -->

- **用途** 立即推动蝶君的后台扫描。
- **调用方** 仅内部，蝶君后台调度或测试。
- **参数** 无。
- **返回** WebSocket 返回 `null`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/butterfly.ts:453](../../core/src/modules/butterfly.ts#L453)

## desk.get
<!-- api:method -->

- **用途** 读取工作区写笺、资料、任务和产物。
- **调用方** 窗口，工作台。
- **参数** `cwd: string`（工作目录）
- **返回** `{ notes: Note[]; materials: Material[]; tasks: Task[]; artifacts: Artifact[]; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/tasks.ts:817](../../core/src/modules/tasks.ts#L817)

## inbox.list
<!-- api:method -->

- **用途** 汇总等你处理的待处理对象。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `Record<string, unknown>[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/tasks.ts:828](../../core/src/modules/tasks.ts#L828)

## notes.save
<!-- api:method -->

旧，0.12 换掉。编辑写笺的窗口测试仍有旧夹具，读取侧继续用 desk.get。

- **用途** 新建或保存写笺。
- **调用方** 窗口，工作台。
- **参数** `id?: string`（对象标识）；`cwd: string`（工作目录）；`title?: string`（显示标题）；`content?: string`（正文）
- **返回** `Note`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`desk.changed`](events.md#deskchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/tasks.ts:795](../../core/src/modules/tasks.ts#L795)

## notices.list
<!-- api:method -->

- **用途** 列出已持久化的任务通知。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `status?: string`（状态过滤或目标状态）
- **返回** `Notice[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/tasks.ts:826](../../core/src/modules/tasks.ts#L826)

## notices.resolve
<!-- api:method -->

- **用途** 处理一条任务通知，按动作返回可打开的会话。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）；`action?: string`（执行动作）
- **返回** `{ slotId: string | null; }`。
- **错误** `bad_request`（缺通知 ID）；`gone`（通知已经处理或不存在）。
- **事件** [`notices.changed`](events.md#noticeschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/tasks.ts:827](../../core/src/modules/tasks.ts#L827)

## persona.presets
<!-- api:method -->

- **用途** 列出蝶君的四种预设性格。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `{ id: string; name: "静" | "暖" | "利落" | "灵动"; description: "安静可靠，话少，带点文气。" | "亲切体贴，愿意多说一点。" | "先说结论和下一步，少寒暄。" | "活泼，爱打比方，偶尔开玩笑。"; example: "资料已理好，放在原处。你得空再看。" | "我把资料理好了。你今天要是忙，等有空再一起看也行。" | "两份资料已整理完。明天请确认剩余一项。" | "两份资料都归队啦，最后一项还在门口等你明天确认。"; }[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/persona/index.ts:19](../../core/src/modules/persona/index.ts#L19)

## persona.proactivity.allows
<!-- api:method -->

- **用途** 按当前主动性判断某类行为是否允许。
- **调用方** 窗口或后台，蝶君。
- **参数** `kind: string`（类别）
- **返回** `boolean`。
- **错误** `bad_request`（未知的蝶君自主行动类型）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/persona/index.ts:21](../../core/src/modules/persona/index.ts#L21)

## selfwork.history
<!-- api:method -->

- **用途** 读取自主工作记录。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `Run[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/selfwork/index.ts:146](../../core/src/modules/selfwork/index.ts#L146)

## selfwork.longGoals.delete
<!-- api:method -->

- **用途** 移除长期目标。
- **调用方** 窗口或后台，蝶君。
- **参数** `id: string`（对象标识）
- **返回** `{ deleted: string; }`。
- **错误** `not_found`（没有这个长期目标）；`bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/selfwork/index.ts:138](../../core/src/modules/selfwork/index.ts#L138)

## selfwork.longGoals.list
<!-- api:method -->

- **用途** 列出蝶君长期目标。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `LongGoal[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/selfwork/index.ts:125](../../core/src/modules/selfwork/index.ts#L125)

## selfwork.longGoals.save
<!-- api:method -->

- **用途** 保存或修改长期目标。
- **调用方** 窗口或后台，蝶君。
- **参数** id: string、title: string、instruction: string；revision?: number（更新时比对）
- **返回** `LongGoal | undefined`。
- **错误** `bad_request`（请填写长期目标标题和说明）；`conflict`（长期目标已经变化，请重新读取）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/selfwork/index.ts:126](../../core/src/modules/selfwork/index.ts#L126)

## selfwork.restoredPlans.confirm
<!-- api:method -->

- **用途** 确认一个恢复计划可以继续。
- **调用方** 窗口或后台，蝶君。
- **参数** `id: string`（对象标识）
- **返回** `Run | undefined`。
- **错误** `conflict`（这份恢复的草案已处理或不再可用）；`bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/selfwork/index.ts:117](../../core/src/modules/selfwork/index.ts#L117)

## selfwork.restoredPlans.list
<!-- api:method -->

- **用途** 列出恢复后仍待确认的自主计划。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `(Run & { restore_review_required: 1; })[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/selfwork/index.ts:113](../../core/src/modules/selfwork/index.ts#L113)

## selfwork.skills.adopt
<!-- api:method -->

- **用途** 采用自写技能。
- **调用方** 窗口或后台，蝶君。
- **参数** `id: string`（对象标识）；`cwd?: string`（工作目录）
- **返回** `SkillRow`。
- **错误** `conflict`（技能版本已变化，请重新查看）；`bad_request`（必需字段缺失或不合法）。
- **事件** [`skills.changed`](events.md#skillschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/selfwork/skills.ts:39](../../core/src/modules/selfwork/skills.ts#L39)

## selfwork.skills.delete
<!-- api:method -->

- **用途** 删除自写技能。
- **调用方** 窗口或后台，蝶君。
- **参数** `id: string`（对象标识）
- **返回** `{ deleted: string; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`skills.changed`](events.md#skillschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/selfwork/skills.ts:61](../../core/src/modules/selfwork/skills.ts#L61)

## selfwork.skills.list
<!-- api:method -->

- **用途** 列出蝶君自写技能及版本。
- **调用方** 窗口或后台，蝶君。
- **参数** 无。
- **返回** `{ source: string; versions: Omit<Version, "content">[]; id: string; name: string; active_version: number; adopted_version: number | null; }[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/selfwork/skills.ts:35](../../core/src/modules/selfwork/skills.ts#L35)

## selfwork.skills.rollback
<!-- api:method -->

- **用途** 把自写技能切回指定版本。
- **调用方** 窗口或后台，蝶君。
- **参数** `id: string`（对象标识）；`version?: number`（版本号）
- **返回** `SkillRow`。
- **错误** `bad_request`（找不到已验证的技能版本）。
- **事件** [`skills.changed`](events.md#skillschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/selfwork/skills.ts:52](../../core/src/modules/selfwork/skills.ts#L52)

## selfwork.stop
<!-- api:method -->

- **用途** 停止指定自主工作。
- **调用方** 窗口或后台，蝶君。
- **参数** `id: string`（对象标识）
- **返回** `Run | undefined`。
- **错误** `not_found`（没有这条自主工作）；`bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/selfwork/index.ts:147](../../core/src/modules/selfwork/index.ts#L147)

## tasks.bind
<!-- api:method -->

- **用途** 把任务和运行中的会话绑定。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `taskId: string`（任务 ID）；`slotId?: string`（活动会话槽 ID）
- **返回** `{ ok: boolean; }`。
- **错误** `not_found`（这个任务不存在）；`bad_request`（侧边对话不参与任务）。
- **事件** [`tasks.changed`](events.md#taskschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/tasks.ts:775](../../core/src/modules/tasks.ts#L775)

## tasks.create
<!-- api:method -->

- **用途** 创建任务并返回给模型的提示文本。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `goal: string`；`materialIds?: string[]`（资料 ID 列表）；`cwd: string`（工作目录）；`title?: string`（显示标题）；`source?: JSON`（来源）；`noteId?: string`（写笺 ID）
- **返回** `{ task: Task; prompt: string; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`tasks.changed`](events.md#taskschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/tasks.ts:762](../../core/src/modules/tasks.ts#L762)

## tasks.forSession
<!-- api:method -->

- **用途** 从会话定位关联任务。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `sessionFile: string`（会话文件路径）
- **返回** `Task | null`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/tasks.ts:758](../../core/src/modules/tasks.ts#L758)

## tasks.get
<!-- api:method -->

- **用途** 读取任务、运行和产物。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `{ task: Task; runs: Run[]; artifacts: Artifact[]; }`。
- **错误** `not_found`（这个任务不存在）；`bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/tasks.ts:753](../../core/src/modules/tasks.ts#L753)

## tasks.list
<!-- api:method -->

- **用途** 按工作区或状态列出任务。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `cwd?: string`（工作目录）；`status?: string`（状态过滤或目标状态）；`source?: string`（来源）；`noteId?: string`（写笺 ID）；`limit?: number`（最多返回条数）
- **返回** `Task[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/tasks.ts:750](../../core/src/modules/tasks.ts#L750)

## tasks.remove
<!-- api:method -->

- **用途** 删除任务。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`tasks.changed`](events.md#taskschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/tasks.ts:786](../../core/src/modules/tasks.ts#L786)
