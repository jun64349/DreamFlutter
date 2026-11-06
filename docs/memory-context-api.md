# v0.5 记忆与上下文后台接口补充（T-09）

依据：第 8 步派工第 1、2 节及修订 R-1。接口为 Core RPC；窗口通过现有客户端调用。侧边会话仍按 `session-relationships.md` 隔离。本文件不改变界面设计。

## 设置与自动提取

`settings.get/update` 增加：

| 字段 | 值与默认值 | 作用 |
| --- | --- | --- |
| `memoryDetail` | `brief` / `standard`（默认）/ `detailed` | 仅控制自动提取内容。简要仅接受用户明确事实/决定，拒绝推断和进展；标准沿用现有规则；详细主动整理近期进展和推断偏好，新增仍为一级并经过现有守门。 |
| `memoryWriteFrequency` | `standard`（默认）/ `low` | 标准在每次成功运行后排队；低频持久记录尚未提取的消息边界，在任务边界、关闭、切换或下次后台启动时转入持久队列。没有 `high`。 |

手动 `memory.extractNow` 不受详细程度和频率影响；整理日历不变。已有 enabled、autoExtract、paused、预算、会话模式和无痕/侧边/无人值守限制继续适用。关闭后台提取时保留延后记录，恢复开启后可在下个边界/关闭/启动处理。

低频队列携带 `throughEntryId`，只处理该条消息及之前未提取的消息，不偷取下一任务新输入；重复排队以会话和边界去重，已经处理的边界跳过。排队与删除延后记录在一个事务中完成，模型失败沿用持久任务重试。

## 未保存提示

`memory.unsaved({sessionId})` 返回 `null` 或：

```ts
{
  slotId: string; sessionId: string; runId: string;
  replyEntryId: string | null; // 对应助手回复在会话文件中的条目 id
  pendingIds: string[];       // 该运行产生的待确认项
  claim: string; suggestion: string; pending: boolean; at: number;
}
```

新提示事件为 `{event:'memory.unsaved', ...上述记录}`。提示仅在内存中，重启丢失，不是历史通知系统。

`memory.save` 保留原参数，增加可选 `unsavedRef:{sessionId,runId}`。仅在保存实际成功、引用与现有提示同时匹配时清除该提示，并广播：

```ts
{event:'memory.unsaved', sessionId, runId, replyEntryId, cleared:true}
```

旧运行的保存操作不会清掉新运行的提示；失败不会清除。窗口可以用返回的 `pendingIds` 跳到待确认项。

## 保存与恢复回执

`memory.restore`、`memory.undo`、`memory.undoBatch`、`memory.acceptPending` 保留各自原有结果（含部分成功/冲突），增加：

```ts
currentTask: 'next_call' | 'next_task'
```

本次实际变更涉及已加载快照中的条目时为 `next_call`，否则为 `next_task`。与 `save/update` 相同，文案应为“下次调用开始使用”或“下个任务开始使用”，不能称“当前已采用”。

用户纠正和 `explicit=true` 的主 Agent 修改会刷新所有加载该条目的快照；后台推断改写不刷新。纠正快照在模型调用末尾明确覆盖历史回复、搜索结果和旧摘要，不重写原会话消息。

主 Agent 任何结果为全局的写入都进入 `why:'promote_global'` 待确认。近似重复的工作区条目通过 `memory_save(scope:'global')` 请求全局时也进入确认，不能被去重逻辑吞掉；先遗忘再新建全局仍须确认。用户 UI 直接操作和接受待确认项可以生效。

## 日志分页

`memory.log` 参数保留 `since`（含）、`until`（不含）、`days`、`itemId`、`limit`，增加 `cursor`、`scope`、`cwd`。`limit` 按条目计，默认 100，范围 1–500。

返回值由原来的分组数组变为分页对象：

```ts
{
  days: Array<{day:string; entries:LogEntry[]}>;
  cursor: string | null; // 下一页游标；末页 null
  hasMore: boolean;
}
```

按 `at DESC, opId DESC` 稳定排序；游标是服务端生成的不透明字符串。加载下一页时保持相同筛选，跨页同一天需要合并显示。无效游标返回 `bad_request`。`scope` 精确匹配条目当时的范围，`cwd` 匹配其工作区；两者同时传入时取交集。未知工作区返回空列表，不创建工作区。

普通条目沿用原 `before/after`、`opId`、`batchId`、`actor`、`kind`、`reason`、`inferred`、`undoable` 等字段。新增彻底删除条目：

```ts
{
  kind:'purge'; batchKind:'purge'; actor:'user';
  before:null; after:null; undoable:false;
  scope:string; workspaceId:string|null; level:number;
  // 仍含 opId、batchId、itemId、at；reason 只描述范围和层级
}
```

彻底删除日志无正文、无来源摘录；不能撤销，不要假设 `after` 永不为空。不会恢复删除前的旧日志文本。

## 彻底删除的来源会话

`memory.purge({id,confirm:true})` 返回：

```ts
{
  sessions: Array<{path:string; title:string; exists:boolean}>;
  notes: string[];
}
```

标题使用索引中的名称、首条消息，缺失时以文件名兜底；`exists` 按当前文件是否存在判定。后台不在 purge 内自动删会话。用户选择删除来源会话后，窗口调用已有 `sessions.deletePreview/delete`，连带规则遵循 T-07。

## 压缩检查点

`context.regenerate({slotId,entryId?,note?,focus?})` 只接受当前分支最新检查点；不传 `entryId` 时选择最新；无检查点或指定旧检查点返回 `bad_request`。成功结果保留原压缩结果，并增加：

```ts
source: 'original' | 'previous_summary'
```

`original` 表示原消息估算可装入窗口、按原文重写；`previous_summary` 表示原文过大，使用旧摘要和保留的消息修订。未产出压缩仍返回 `null`，失败不清除报告；成功只解决被重写检查点的报告。`context.report` 仍接受任意当前分支检查点。

普通压缩、后台候选和重新生成均在系统提示及最终压缩指令中附同范围失效事实清单（已推翻、已遗忘、已纠正的旧版本）；要求逐处标注失效，不能当当前事实。候选保存的是生成前的指令指纹，期间发生纠正会让候选失效。历史原文不删除。

`memory.warning(kind:'summary_revived')` 仍是警告，不自动重写；匹配忽略部分空格/标点/人称，也比对关键数字，允许误报或漏报。窗口针对最新检查点提供重新生成入口。

## 幂等与费用

任务/快照准备按 `sessionId + 用户 message entryId` 持久去重，同一消息多次进入模型上下文只准备一次；不按 RPC 请求 id 去重，不把产生第二条用户消息的重发当成同一事件。只读允许快照素材及边界判断，拒绝工具写入与自动/手动提取，不生成候选或正式记忆。

压缩用量唯一入账方为 ContextModule。运行中计入当前 run；运行结束后完成的后台候选单独记 `runs.kind='background_compaction'`，未采用也计费，`startedAt/endedAt` 为费用发生时间。运行外的普通手动压缩记 `kind='compaction'`。原运行记录为 `kind='conversation'`；旧结束记录不回改。独立费用行不启动任务，不触发自动记忆提取。

数据库升级 11 新增操作明确意图标记、消息准备去重表、低频延后表、无正文删除日志及 `runs.kind`；全部沿用前向 schema 升级机制。
