# 数据结构

字段以窗口收到的 JSON 为准。`?` 表示可省略；`null` 是明确的空值。数字时间通常为 Unix 毫秒。Pi 会话条目中的 `timestamp` 一般为 ISO 日期字符串，消息正文中的同名字段为毫秒。会话文件路径 `sessionFile`、Pi `sessionId` 和活动连接使用的 `slotId` 各自独立。

### Pi 消息

消息按 `role` 区分。用户消息的 `content` 可为文本或内容块数组；助手消息包含 `content: ContentBlock[]`，常见块为 `{type:'text',text}`、`{type:'thinking',thinking}`、`{type:'toolCall',id,name,arguments}`。图像块带 `data` 与 `mimeType`。工具结果用 `toolCallId` 和 `toolName` 关联，另含 `isError`、`content` 和可选 `details`。助手消息还可能带 `provider`、`model`、`usage`、`stopReason`、`errorMessage`。事件外层的 `entryId` 用于定位已落盘的会话节点，详见 [Pi 协议](pi.md)。

### 目标、日程与视图

- `GoalView` 在 Goal 上加 `kind:'goal', view, stage, next`。view 取 running、done、blocked、paused、decide、accept。提议项 `GoalProposalView` 另带 `kind:'goal_proposal', view:'decide', id, title, sessionFile, originText, draft, partition:'butterfly', createdAt, updatedAt, stage, next`。
- `GoalDetail` 在 Goal 上加 `stage, next, executionEnded, artifactsGenerated, machineAccepted, awaitingAcceptance, completed, checks, missing, review, artifacts, approvals, stillRunning, waits, services, irreversible, budgetStatus, costUnknown, recentEvents, emergency`，自主工作还可有 `selfwork`。`review` 含判定、缺项、后续问题和证据版本；`waits` 包括用户、计算与外部等待。预算明细和完整投影见 [GoalScheduler.detail](../../core/src/modules/goals.ts)。
- `ScheduleView` 在 Schedule 上加 `describe:string, everyDay:{times:string[]}|{everyMs:number}|null, lastRun`。lastRun 有值时是 ScheduleRun 与 deliveries 数组。历史运行和送达回执按日程查询。
- `Trigger` 按 type 选择字段。once 提供 at，interval 提供 everyMs 并可带 anchor，cron 提供 cron 或 crons 并可带 IANA 时区。

### 记忆与设置

- `MemoryItemView` 在 MemoryItem 上补工作区路径、可能过时提示、复核配置、来源与使用概况。查询单项可返回其批次历史和关联数据。状态值见 [memory/types.ts](../../core/src/memory/types.ts)。
- CoreSettings 是当前完整设置，更新接收补丁。默认值和各字段有效范围以 [settings.ts](../../core/src/settings.ts) 为准。修改设置时通过 settings.changed 查看实际生效的键。语音字段的意义见 [语音设置](voice.md)。

### LegacyMemoryItem

旧格式返回 `id, scope, cwd, kind, content, source, sourceSession, status, action, targetId, replacedBy, reason, createdAt, updatedAt`。已保存条目还含 `level, pinned, version`，待确认条目可含 `why`。路径和引用可为 null。范围只显示 global 或 workspace，状态为 active、deleted、superseded 或 candidate。完整转换见 [MemoryModule.legacy](../../core/src/modules/memory.ts#L1311)。

### McpServerForm

必填 `name: string` 和 `transport: "stdio" | "http"`。stdio 需要 `command: string`，可带 `args?: string[]`、`cwd?: string` 和 `env?: Record<string, FormValue>`。HTTP 需要 `url: string`，可带 `headers?: Record<string, FormValue>`。两种均可带 `description?: string`、`exposure?: string`、`enabled?: boolean`、`timeout?: number`。敏感字段的表单结构见 [mcp.ts](../../core/src/modules/mcp.ts#L20)。

### UpdateStatus

- `state`、`message` 为当前更新阶段和显示文本。`checkedAt` 为毫秒或 null，`progress` 为数字进度。
- `available` 为 null 或 `{version:string,notes:string,page:string,size:number,sha256:string}`，其中 size 为字节。`downloaded`、`canInstall`、`canStartup` 为布尔值。`signature` 是下载包签名核验结果或 null。
- `application` 为应用构建信息。`coreVersion`、`nodeVersion`、`platform`、`arch` 为字符串，`piVersion` 可为 null。
- `autoCheckUpdates`、`startOnLogin` 为布尔值，`closeBehavior` 为 tray 或 quit。`recovery` 为 null 或含 phase、from、to、backup、error、acceptedWrites 的恢复快照。字段实现见 [UpdateModule.status](../../core/src/update/module.ts#L117)。

## 会话、消息、运行

### SlotInfo

[slots/slot.ts:16](../../core/src/slots/slot.ts#L16)

```ts
interface SlotInfo {
	slotId: string;
	cwd: string;
	sessionFile: string | null;
	sessionId: string | null;
	sessionName: string | null;
	running: boolean;
	compacting: boolean;
	pendingDialogs: number;
	lastActivity: number;
	createdAt: number;
	taskId: string | null;
	/** Opened by the core itself (scheduler) rather than a window. */
	unattended: boolean;
	/** Temporary chat: in memory only, no memory read or write. */
	incognito: boolean;
	/** Side conversation source. Excluded from top-level reattachment even when saved. */
	forkOf: string | null;
	sessionType: "ordinary" | "side";
	willPersist: boolean;
	/** Runs in 蝶君's sandbox. */
	sandbox: boolean;
	model: string | null;
	/** Agent mode of the open session (null while starting). */
	agentMode: AgentMode | null;
	/** Standard mode: plan mode is on. */
	planMode: boolean;
}
```

### SessionRow

[modules/session-index.ts:11](../../core/src/modules/session-index.ts#L11)

```ts
interface SessionRow {
	path: string;
	cwd: string | null;
	sessionId: string | null;
	parentSession: string | null;
	sessionType: "ordinary" | "side";
	parentMissing: boolean;
	quote: string | null;
	quoteEntryId: string | null;
	title: string;
	name: string | null;
	createdAt: number | null;
	modifiedAt: number | null;
	messageCount: number;
	pinned: boolean;
	archived: boolean;
}
```

### UserBranch

[slots/slot.ts:769](../../core/src/slots/slot.ts#L769)

```ts
interface UserBranch {
	/** The user message entry on the active branch. */
	entryId: string;
	/** Its position among sibling user messages (edited resends), oldest first. */
	index: number;
	total: number;
	/** For each sibling: the entry to navigate to (its latest continuation). */
	targets: string[];
}
```

### QuestionNode

[slots/slot.ts:824](../../core/src/slots/slot.ts#L824)

```ts
interface QuestionNode {
	entryId: string;
	/** The nearest earlier question, or null for a first question. */
	parentId: string | null;
	/** The question's text, shortened. */
	text: string;
	timestamp: string;
	/** On the branch shown now. */
	active: boolean;
	/** Where to navigate to show this question's branch (its latest continuation). */
	target: string;
}
```

### SearchHit

[modules/session-index.ts:29](../../core/src/modules/session-index.ts#L29)

```ts
interface SearchHit {
	path: string;
	cwd: string | null;
	title: string;
	entryId: string;
	role: string;
	snippet: string;
	modifiedAt: number | null;
}
```

### Confirmation

[confirmations.ts:8](../../core/src/confirmations.ts#L8)

```ts
interface Confirmation {
	id: string;
	slotId: string | null;
	sessionFile: string | null;
	cwd: string | null;
	method: string;
	kind: DialogKind;
	title: string;
	request: UiRequest;
	status: ConfirmationStatus;
	answer: UiResponse | null;
	createdAt: number;
	resolvedAt: number | null;
}
```

### UiRequest

[pi/ui-bridge.ts:5](../../core/src/pi/ui-bridge.ts#L5)

```ts
type UiRequest = { type: "extension_ui_request"; id: string; method: string } & Record<string, unknown>;
```

### TodoItem

[agent/state.ts:11](../../core/src/agent/state.ts#L11)

```ts
interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
}
```

### ChatInput

[modules/goals/chat-task.ts:25](../../core/src/modules/goals/chat-task.ts#L25)

```ts
type ChatInput = { text: string; attachments: ChatAttachment[]; materials: string[] };
```

### ChatAttachment

[modules/goals/chat-task.ts:24](../../core/src/modules/goals/chat-task.ts#L24)

```ts
type ChatAttachment = { path: string; kind: "file" | "folder" | "document" };
```

### Run

[runs.ts:8](../../core/src/runs.ts#L8)

```ts
interface Run {
	kind?: "conversation" | "background_compaction" | "compaction";
	id: string;
	slotId: string | null;
	sessionFile: string | null;
	sessionId: string | null;
	cwd: string;
	taskId: string | null;
	prompt: string | null;
	status: RunStatus;
	startedAt: number;
	endedAt: number | null;
	model: string | null;
	turns: number;
	toolCalls: number;
	toolErrors: number;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	error: string | null;
	/** Files written or edited during the run (artifact candidates). */
	files: string[];
}
```

### RunStep

[runs.ts:34](../../core/src/runs.ts#L34)

```ts
interface RunStep {
	id: number;
	runId: string;
	at: number;
	kind: "tool" | "retry" | "compaction" | "error";
	name: string | null;
	summary: string | null;
	status: string | null;
	durationMs: number | null;
}
```

### Task

[modules/tasks.ts:19](../../core/src/modules/tasks.ts#L19)

```ts
interface Task {
	id: string;
	title: string;
	goal: string;
	cwd: string;
	sessionFile: string | null;
	source: TaskSource;
	status: TaskStatus;
	noteId: string | null;
	scheduleId: string | null;
	goalId?: string;
	attempt?: number;
	materialIds: string[];
	/** Last reply of the agent (shortened). */
	result: string | null;
	error: string | null;
	runs: number;
	turns: number;
	cost: number;
	durationMs: number;
	/** What the agent is doing right now (tool and target). */
	currentStep: string | null;
	createdAt: number;
	updatedAt: number;
	endedAt: number | null;
}
```

### Artifact

[modules/tasks.ts:67](../../core/src/modules/tasks.ts#L67)

```ts
interface Artifact {
	id: string;
	cwd: string;
	taskId: string | null;
	noteId: string | null;
	path: string;
	exists: boolean;
	size: number | null;
	createdAt: number;
	updatedAt: number;
}
```

## 目标和日程

### Goal

[modules/goals/types.ts:39](../../core/src/modules/goals/types.ts#L39)

```ts
interface Goal {
	id: string;
	revision: number;
	title: string;
	originText: string;
	spec: GoalSpec;
	scope: GoalScope;
	mandateRef: string;
	source: GoalSource;
	status: GoalStatus;
	reason: GoalReason | null;
	resumeWhen: string | null;
	stopIntent: StopIntent | null;
	currentTaskId: string | null;
	budget: Partial<GoalBudget> | null;
	progress: Record<string, unknown>;
	leaseOwner: string | null;
	leaseGeneration: number;
	leaseUntil: number | null;
	latestReviewId: string | null;
	createdAt: number;
	updatedAt: number;
	endedAt: number | null;
	sessionFile: string | null;
}
```

### GoalSpec

[modules/goals/types.ts:18](../../core/src/modules/goals/types.ts#L18)

```ts
interface GoalSpec {
	objective: string;
	constraints: { text: string; kind: "must" | "must_not"; check?: Check }[];
	acceptance: { id: string; text: string; layer: "program" | "model" | "user"; check?: Check }[];
	deliverables: string[];
}
```

### GoalScope

[modules/goals/types.ts:24](../../core/src/modules/goals/types.ts#L24)

```ts
interface GoalScope {
	cwd: string | null;
	partition: "workbench" | "butterfly";
	sandbox: boolean;
	allowedTools?: string[];
	allowedPaths?: string[];
	externalActions?: { tool: "bash" | "pwsh" | "powershell"; command: string }[];
}
```

### GoalBudget

[modules/goals/types.ts:32](../../core/src/modules/goals/types.ts#L32)

```ts
interface GoalBudget {
	maxCostUsd: number;
	maxTokens: number | null;
	maxActiveMs: number;
	maxRuns: number;
	maxParallel: number;
}
```

### GoalStatus

[modules/goals/types.ts:5](../../core/src/modules/goals/types.ts#L5)

```ts
type GoalStatus = typeof GOAL_STATUSES[number];
```

### GoalReason

[modules/goals/types.ts:10](../../core/src/modules/goals/types.ts#L10)

```ts
type GoalReason = BudgetReason | "user_paused" | "restart_check" | "imported" | "stalled"
	| "missing_input" | "needs_decision" | "needs_permission" | "waiting_job" | "waiting_subagent" | "waiting_event"
	| "review_unparsable" | "run_failed" | "prep_failed" | "acceptance" | "channel_unavailable" | "autonomy_budget";
```

### GoalSource

[modules/goals/types.ts:6](../../core/src/modules/goals/types.ts#L6)

```ts
type GoalSource = "user" | "card" | "schedule" | "rule";
```

### Schedule

[modules/scheduler.ts:44](../../core/src/modules/scheduler.ts#L44)

```ts
interface Schedule {
	id: string;
	name: string;
	prompt: string;
	cwd: string;
	owner: "workbench" | "butterfly";
	kind: ScheduleKind;
	trigger: Trigger;
	missedPolicy: MissedPolicy;
	/** fresh = a new session per run; bound = always run in [sessionFile]. */
	sessionMode: "fresh" | "bound";
	sessionFile: string | null;
	/** Tools a run may use besides read-only ones (null = read-only only). */
	allowedTools: string[] | null;
	/** Small per-schedule memory the agent keeps between runs (last result...). */
	state: Record<string, unknown>;
	status: ScheduleStatus;
	/** Bumped on every edit: triggers claimed under an older version are void. */
	version: number;
	nextRunAt: number | null;
	lastRunAt: number | null;
	createdBy: "user" | "agent";
	createdRole: ScheduleRole;
	createdAt: number;
	updatedAt: number;
}
```

### Trigger

[modules/scheduler.ts:30](../../core/src/modules/scheduler.ts#L30)

```ts
interface Trigger {
	type: TriggerType;
	/** once: epoch ms. */
	at?: number;
	/** interval: period in ms, counted from [anchor]. */
	everyMs?: number;
	anchor?: number;
	/** cron: five-field expression evaluated in [timezone] (IANA). */
	cron?: string;
	/** A union of five-field expressions for times with different minute values. */
	crons?: string[];
	timezone?: string;
}
```

### ScheduleRun

[modules/scheduler.ts:71](../../core/src/modules/scheduler.ts#L71)

```ts
interface ScheduleRun {
	id: string;
	scheduleId: string;
	triggerKey: string;
	version: number;
	/** When it was supposed to run. */
	scheduledAt: number | null;
	startedAt: number | null;
	endedAt: number | null;
	manual: boolean;
	catchUp: boolean;
	status: ScheduleRunStatus;
	attempt: number;
	retryAt: number | null;
	taskId: string | null;
	sessionFile: string | null;
	result: string | null;
	error: string | null;
	note: string | null;
	externalEffects: boolean;
	cost: number;
}
```

### Delivery

[modules/scheduler.ts:94](../../core/src/modules/scheduler.ts#L94)

```ts
interface Delivery {
	id: string;
	runId: string;
	channel: "window" | "toast";
	status: DeliveryStatus;
	detail: string | null;
	createdAt: number;
}
```

### ScheduleChange

[modules/scheduler.ts:105](../../core/src/modules/scheduler.ts#L105)

```ts
interface ScheduleChange {
	id: string;
	scheduleId: string;
	versionBefore: number;
	versionAfter: number;
	actor: ScheduleRole;
	reason: string;
	before: Schedule | null;
	after: Schedule | null;
	summary: string;
	at: number;
	undoneAt: number | null;
	status: ScheduleChangeStatus;
}
```

### ScheduleOccurrence

[modules/scheduler.ts:143](../../core/src/modules/scheduler.ts#L143)

```ts
interface ScheduleOccurrence {
	scheduleId: string;
	at: number;
	status: Exclude<ScheduleRunStatus, "waiting"> | "upcoming";
	runId: string | null;
	result: string | null;
	error: string | null;
}
```

## 通知、卡片和等你处理

### Notice

[notify.ts:22](../../core/src/notify.ts#L22)

```ts
interface Notice extends NoticeIdentity {
	object: string;
	situation: string;
	impact: string;
	action: string;
	target: NotificationTarget;
}
```

### NoticeIdentity

[modules/notices/journal.ts:7](../../core/src/modules/notices/journal.ts#L7)

```ts
interface NoticeIdentity { key: string; category: NoticeCategory; objectRef?: string; itemId?: string | null }
```

### NotificationTarget

[notify.ts:12](../../core/src/notify.ts#L12)

```ts
interface NotificationTarget {
	page: string;
	slotId?: string | null;
	sessionFile?: string | null;
	taskId?: string | null;
	runId?: string | null;
	itemId?: string | null;
	goalId?: string | null;
}
```

### AttentionItem

[modules/attention.ts:12](../../core/src/modules/attention.ts#L12)

```ts
interface AttentionItem {
	id: string; kind: string; group: "now" | "later"; title: string; reason: string;
	origin: { role: "workbench" | "butterfly"; sessionName: string | null; sessionFile: string | null; slotId: string | null; cwd: string | null };
	target: { page: string; sessionFile?: string | null; slotId?: string | null; itemId: string };
	actions: string[]; data: Record<string, unknown>;
}
```

### ActionReceipt

[modules/attention.ts:18](../../core/src/modules/attention.ts#L18)

```ts
interface ActionReceipt {
	id: string; itemId: string; status: "pending" | "applied" | "cancelled" | "failed";
	undoable: boolean; undoUntil: number | null; remainingMs: number; result?: unknown; error?: string;
}
```

### Card

[cards/cards.ts:56](../../core/src/cards/cards.ts#L56)

```ts
interface Card {
	id: string;
	title: string;
	cwd: string | null;
	/** Conversation the card lives in (ephemeral); null for resident cards. */
	sessionFile: string | null;
	toolCallId: string | null;
	origin: CardOrigin;
	/** Resident entity on the desk (pinned or imported). */
	resident: boolean;
	pinnedFrom: string | null;
	epoch: number;
	version: number;
	height: number | null;
	snapshotAt: number | null;
	createdAt: number;
	updatedAt: number;
	bindings: { id: string; tool: string; label: string; description: string | null; known: boolean; units: Unit[] }[];
	malformed: Record<string, string>;
	preferredWidth: number | null;
	specVersion: string;
	specSupported: boolean;
	hasAssets: boolean;
}
```

### Grant

[cards/cards.ts:81](../../core/src/cards/cards.ts#L81)

```ts
interface Grant {
	kind: GrantKind;
	subject: string;
	scope: "session" | "always";
}
```

### Envelope

[cards/cards.ts:105](../../core/src/cards/cards.ts#L105)

```ts
interface Envelope {
	ok: boolean;
	result: Record<string, unknown>;
	error?: string;
	code?: string;
}
```

### PermissionQuestion

[cards/cards.ts:115](../../core/src/cards/cards.ts#L115)

```ts
interface PermissionQuestion {
	kind: GrantKind;
	subject: string;
	bindingId: string;
	tool: string;
	label: string;
	description: string | null;
	/** The complete call as it will run (§4.6). */
	call: string;
	/** Reads local data and can send it out, together with what was granted before (§4.6). */
	danger: boolean;
	origin: CardOrigin;
	/** Echoed back with the answer: the declaration is checked again before acting (§5.8). */
	epoch: number;
	digest: string;
}
```

### RequestAnswer

[cards/cards.ts:113](../../core/src/cards/cards.ts#L113)

```ts
type RequestAnswer = Envelope | { ask: PermissionQuestion };
```

## 记忆、模型和启动

### MemoryItem

[memory/types.ts:46](../../core/src/memory/types.ts#L46)

```ts
interface MemoryItem {
	id: string;
	version: number;
	level: Level;
	kind: ItemKind;
	content: string;
	conditions: string | null;
	scope: ItemScope;
	workspaceId: string | null;
	groupId: string | null;
	confidence: Confidence;
	status: ItemStatus;
	pinned: boolean;
	retention: Retention;
	/** The background may change it on its own (the user can turn this off per item). */
	autoOk: boolean;
	occurredAt: number | null;
	validFrom: number | null;
	validUntil: number | null;
	lastVerifiedAt: number | null;
	nextReviewAt: number | null;
	/** Only hints for reviews, never evidence (§2.1). */
	lastUsedAt: number | null;
	useCount: number;
	createdAt: number;
	updatedAt: number;
	createdBy: Actor;
}
```

### MemorySource

[memory/types.ts:83](../../core/src/memory/types.ts#L83)

```ts
interface MemorySource extends SourceInput {
	at: number;
}
```

### ChannelInput

[gateway/gateway.ts:84](../../core/src/gateway/gateway.ts#L84)

```ts
interface ChannelInput {
	id?: string;
	name: string;
	platform?: string;
	kind?: ChannelKind;
	api: ChannelApi;
	baseUrl: string;
	models: ChannelModel[];
	headers?: Record<string, string>;
	authHeader?: boolean;
	enabled?: boolean;
	topUp?: number | null;
	lowBalance?: number | null;
	/** Keys: existing ones by id (label/enabled edits), new ones with [secret]. Omitted keys are removed. */
	keys: { id?: string; label?: string; secret?: string; enabled?: boolean }[];
}
```

### ChannelModel

[gateway/gateway.ts:34](../../core/src/gateway/gateway.ts#L34)

```ts
interface ChannelModel {
	/** Complete Pi model metadata retained through import and editing. */
	[key: string]: unknown;
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
	/** The model's own thinking values, from the model list (e.g. low/high/max). */
	efforts?: string[];
	/** User-confirmed capabilities for models absent from the catalog. */
	thinkingLevels?: string[];
}
```

### ChannelInfo

[gateway/gateway.ts:59](../../core/src/gateway/gateway.ts#L59)

```ts
interface ChannelInfo {
	origin?: string;
	oauth?: boolean;
	id: string;
	/** "df": stored here; "pi": a provider configured in Pi (keys stay in Pi's files). */
	source: "df" | "pi";
	provider: string;
	name: string;
	platform: string | null;
	kind: ChannelKind;
	api: string;
	baseUrl: string;
	models: ChannelModel[];
	headers?: Record<string, string>;
	authHeader: boolean;
	enabled: boolean;
	topUp: number | null;
	/** Remind when the balance falls below this. */
	lowBalance: number | null;
	keys: ChannelKeyInfo[];
	unavailable: Unavailable | null;
	/** The models model lists show (0.8.3); null = all of them. */
	common?: string[] | null;
}
```

### ChannelKeyInfo

[gateway/gateway.ts:50](../../core/src/gateway/gateway.ts#L50)

```ts
interface ChannelKeyInfo {
	id: string;
	label: string;
	enabled: boolean;
	/** Last four characters, for telling keys apart. */
	hint: string;
	unavailable: Unavailable | null;
}
```

### GroupInput

[gateway/gateway.ts:101](../../core/src/gateway/gateway.ts#L101)

```ts
interface GroupInput {
	id?: string;
	name: string;
	entries: GroupEntry[];
	allowPaidOverflow?: boolean;
}
```

### ModelGroup

[gateway/router.ts:14](../../core/src/gateway/router.ts#L14)

```ts
interface ModelGroup {
	id: string;
	name: string;
	entries: GroupEntry[];
	/** When the plan channels are used up, go on with pay-as-you-go ones. */
	allowPaidOverflow: boolean;
}
```

### GroupEntry

[gateway/router.ts:5](../../core/src/gateway/router.ts#L5)

```ts
interface GroupEntry {
	channel: string;
	model: string;
	/** Lower goes first. Entries sharing a priority are one tier. */
	priority: number;
	/** Share within its tier; 0 everywhere in the tier = take them in list order. */
	weight: number;
}
```

### LedgerRow

[ledger/types.ts:9](../../core/src/ledger/types.ts#L9)

```ts
interface LedgerRow {
	id: string; requested_at: number; completed_at: number | null; state: string; channel: string | null; provider: string; model: string;
	purpose: Purpose; workspace: string | null; session_id: string | null; run_id: string | null; slot_id: string | null;
	success: number | null; input: number | null; output: number | null; cache_read: number | null; cache_write: number | null; reasoning: number | null;
	amount: number | null; currency: string | null; amount_source: string; price_version: string; price_snapshot: string | null;
	allowance: number | null; allowance_unit: string | null; allowance_source: string | null; billing_source: string | null;
	ttft_ms: number | null; duration_ms: number | null; origin: string; message_key: string | null; error_code: string | null;
}
```

### SetupInput

[modules/setup.ts:8](../../core/src/modules/setup.ts#L8)

```ts
interface SetupInput {
	/** Picked before launching this core with the existing --data-dir option. */
	dataRoot?: string;
	userName?: string;
	channel?: ChannelInput;
	channelId?: string;
	models?: SetupModels;
	defaultWorkspace?: string | null;
	sandbox?: "now" | "later";
}
```

### SetupModels

[modules/setup.ts:7](../../core/src/modules/setup.ts#L7)

```ts
interface SetupModels { conversation: string | null; small: string | null; large: string | null; vision?: string | null; }
```

### StartupState

[startup.ts:2](../../core/src/startup.ts#L2)

```ts
interface StartupState { phases: StartupPhase[]; current: StartupPhase | null; ready: boolean; }
```

### RuleDefinition

[modules/autonomy/rules.ts:21](../../core/src/modules/autonomy/rules.ts#L21)

```ts
interface RuleDefinition {
	name: string;
	source: Source;
	filter: { scheduleId?: string; folder?: string; extension?: string };
	task: string;
	scope: Scope;
	actions: Action[];
	delivery: string;
	assess: boolean;
}
```

### Rule

[modules/autonomy/rules.ts:31](../../core/src/modules/autonomy/rules.ts#L31)

```ts
interface Rule extends RuleDefinition { id: string; revision: number; mode: RuleMode; updatedAt: number }
```

## 后台设置

### CoreSettings

[settings.ts:21](../../core/src/settings.ts#L21)

```ts
interface CoreSettings {
	voiceMode: "local" | "cloud";
	voiceCloudProvider: string;
	voiceIdleMinutes: number;
	autoCheckUpdates: boolean;
	startOnLogin: boolean;
	closeBehavior: "tray" | "quit";
	/** Package indexes apply only to tool child processes; inherit changes nothing. */
	pythonPackageSource: "inherit" | "pypi" | "tuna" | "ustc";
	npmPackageSource: "inherit" | "npm" | "npmmirror";
	/** Separate web-tool setting, unrelated to model channels. */
	webFetchBackend: "local" | "deepseek";
	approvalMode: ApprovalMode;
	/** Canonical path exceptions explicitly chosen by the user, per workspace. */
	securityPathExceptions: Record<string, string[]>;
	/** Mode new sessions start in. */
	agentMode: AgentModeSetting;
	autoCompaction: boolean;
	/** Compaction threshold as a percentage of the model's context window (roadmap 5.12); a session can set its own. Never above dsh's safe threshold. */
	compactionThresholdPercent: number;
	/**
	 * Background compaction (roadmap 5.12): auto = on in 蝶君 and scheduled (long-task) sessions, off in 工作台's
	 * ordinary conversations until measured; on / off for every session. A session can set its own.
	 */
	backgroundCompaction: "auto" | "on" | "off";
	/** Who writes the background summary: the session's own model (summary quality matters; user 2026-11-07) or the cheaper auxiliary one. */
	backgroundCompactionModel: "session" | "aux";
	/** Share of the threshold at which the background summary is written, in percent (user 2026-11-07: 85, to be tuned on our own tests). */
	backgroundCompactionLeadPercent: number;
	/** provider/id the UI preselects for new sessions; null lets Pi decide. */
	defaultModel: string | null;
	smallTaskModel: string | null;
	largeTaskModel: string | null;
	/** Advanced purpose overrides; compaction also accepts session/small. */
	modelOverrides: ModelOverrides;
	butterflyStartWaitSeconds: 0 | 10 | 60;
	firstSetupComplete: boolean;
	userName: string;
	defaultWorkspace: string | null;
	sandboxSetupChoice: "now" | "later";
	defaultThinking: string | null;
	/** Per-model context window overrides, keyed by provider/id. */
	modelContextWindows: Record<string, number>;
	/** The models of a channel that model lists show, keyed by channel id (0.8.3). Absent = the channel's default. */
	commonModels: Record<string, string[]>;
	/** Cheap model for titles, memory extraction and summaries; null = session model. */
	auxModel: string | null;
	/** Model (or model group) that describes images for models without vision; null = pick one that can see. */
	visionModel: string | null;
	/** Ordered provider/id list tried when the primary model fails. */
	fallbackModels: string[];
	memoryEnabled: boolean;
	memoryAutoExtract: boolean;
	memoryDetail: "brief" | "standard" | "detailed";
	memoryWriteFrequency: "standard" | "low";
	/** Tokens of long-term memory injected at task start. */
	memoryBudgetTokens: number;
	/** 「写入前要我确认」: memory changes the agents make wait for the user (docs/memory-design.md §4); off = they take effect and go in the memory log. */
	memoryConfirmWrites: boolean;
	/** Model the memory agent uses (provider/id or a model group); null = the auxiliary model (memory-design §5). */
	memoryModel: string | null;
	/** USD the memory agent may spend a day on ordinary work; 0 = none (memory-design §7). */
	memoryDailyBudgetUsd: number;
	/** 「暂停整理」: the memory agent's ordinary work waits; snapshots are still used. */
	memoryPaused: boolean;
	/** Active capacity of one partition (global, each workspace, 蝶君): tokens of the text of active and 「待复核」 items (memory-design §12 item 4). */
	memoryCapacityTokens: number;
	/** G-07: physical free-space threshold; memory writes resume automatically above it. */
	memoryMinFreeBytes: number;
	autoTitle: boolean;
	/** Daily spending cap for all runs, in USD; 0 = no cap. */
	dailyBudgetUsd: number;
	/** Monthly spending cap for all runs, in USD; 0 = no cap. */
	monthlyBudgetUsd: number;
	/** Turn cap for one run started from a window; 0 = no cap. */
	maxTurnsPerRun: number;
	/** Turn cap for one unattended run. */
	maxTurnsUnattended: number;
	notifications: boolean;
	scheduleMissedDefault: "skip" | "latest";
	goalDefaultBudget: GoalDefaultBudget;
	goalButterflyBudgetFactor: number;
	goalReviewModel: string | null;
	goalProposalEnabled: boolean;
	/** Minutes an idle session stays loaded with no UI attached. */
	idleSessionMinutes: number;
	/** 蝶君's sandbox may reach the internet (never the local network); false = offline. */
	sandboxOnline: boolean;
	/** Seconds the agent's questions wait before the recommended answer is taken; 0 = wait for the user. */
	askTimeoutSeconds: number;
	patrolEnabled: boolean;
	patrolIntervalMin: 10 | 15 | 30 | 60;
	patrolQuietEnabled: boolean;
	patrolQuietStart: string;
	patrolQuietEnd: string;
	patrolModel: string | null;
	patrolDailyBudget: number;
	butterflyDailyBudget: number;
	autonomySources: { conversation: boolean; schedule: boolean; folder: boolean };
	autonomyFolders: string[];
	patrolStaleHours: number;
	patrolKeepDays: number;
	patrolChecks: PatrolChecks;
	butterflyPersona: ButterflyPersona;
	butterflyProactivity: ButterflyProactivity;
}
```

### GoalDefaultBudget

[settings.ts:11](../../core/src/settings.ts#L11)

```ts
interface GoalDefaultBudget {
	costUsd: number;
	activeMinutes: number;
	runs: number;
	concurrency: number;
}
```
