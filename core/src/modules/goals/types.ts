import { RpcError } from "../../core.ts";
import { parseJson } from "../../db.ts";

export const GOAL_STATUSES = ["draft", "queued", "running", "reviewing", "waiting_dependency", "waiting_user", "paused", "blocked", "completed", "failed", "cancelled"] as const;
export type GoalStatus = typeof GOAL_STATUSES[number];
export type GoalSource = "user" | "card" | "schedule" | "rule";
export type StopIntent = "pause" | "stop_run" | "cancel" | "emergency";
export type GoalControl = StopIntent | "resume" | "clear_emergency";
export type BudgetReason = "budget_cost" | "budget_tokens" | "budget_time" | "budget_runs";
export type GoalReason = BudgetReason | "user_paused" | "restart_check" | "imported" | "stalled"
	| "missing_input" | "needs_decision" | "needs_permission" | "waiting_job" | "waiting_subagent" | "waiting_event"
	| "review_unparsable" | "run_failed" | "prep_failed" | "acceptance" | "channel_unavailable" | "autonomy_budget";
export type GoalEventKind = "run.finished" | "user.input" | "user.control" | "job.finished" | "schedule.fired"
	| "external.event" | "goal.reported" | "review.done" | "budget.changed" | "memory.candidate_ready" | "context.ready" | "rule.matched"
	| "notification.delivery";

interface Check { kind: string; args?: Record<string, unknown> }
export interface GoalSpec {
	objective: string;
	constraints: { text: string; kind: "must" | "must_not"; check?: Check }[];
	acceptance: { id: string; text: string; layer: "program" | "model" | "user"; check?: Check }[];
	deliverables: string[];
}
export interface GoalScope {
	cwd: string | null;
	partition: "workbench" | "butterfly";
	sandbox: boolean;
	allowedTools?: string[];
	allowedPaths?: string[];
	externalActions?: { tool: "bash" | "pwsh" | "powershell"; command: string }[];
}
export interface GoalBudget {
	maxCostUsd: number;
	maxTokens: number | null;
	maxActiveMs: number;
	maxRuns: number;
	maxParallel: number;
}
export interface Goal {
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
export interface GoalRow {
	id: string; revision: number; title: string; origin_text: string; spec: string; scope: string;
	mandate_ref: string; source: GoalSource; status: GoalStatus; reason: GoalReason | null; resume_when: string | null;
	stop_intent: StopIntent | null; current_task_id: string | null; budget: string | null; progress: string;
	lease_owner: string | null; lease_generation: number; lease_until: number | null;
	latest_review_id: string | null; created_at: number; updated_at: number; ended_at: number | null; session_file: string | null;
}
export interface EventRow {
	id: string; goal_id: string | null; kind: GoalEventKind; dedupe_key: string; payload: string;
	created_at: number; handled_at: number | null; handled_by_generation: number | null;
}
export interface IntentRow {
	id: string; goal_id: string; revision: number; generation: number; idem_key: string; action: "run" | "review" | "notify";
	status: "pending" | "started" | "dropped" | "done"; reason: string | null; created_at: number; started_at: number | null;
	run_id: string | null;
}
export interface RunFinished {
	runId: string;
	taskId: string;
	revision: number;
	generation: number;
	status: "done" | "failed" | "aborted" | "interrupted";
	reportedComplete?: boolean;
	error?: string | null;
	model?: string | null;
}

const EMPTY_SPEC: GoalSpec = { objective: "", constraints: [], acceptance: [], deliverables: [] };
const EMPTY_SCOPE: GoalScope = { cwd: null, partition: "workbench", sandbox: false };

export function toGoal(row: GoalRow): Goal {
	return {
		id: row.id, revision: row.revision, title: row.title, originText: row.origin_text,
		spec: parseJson(row.spec, EMPTY_SPEC), scope: parseJson(row.scope, EMPTY_SCOPE), mandateRef: row.mandate_ref,
		source: row.source, status: row.status, reason: row.reason, resumeWhen: row.resume_when,
		stopIntent: row.stop_intent, currentTaskId: row.current_task_id, budget: parseJson(row.budget, null),
		progress: parseJson(row.progress, {}), leaseOwner: row.lease_owner, leaseGeneration: row.lease_generation, leaseUntil: row.lease_until,
		latestReviewId: row.latest_review_id, createdAt: row.created_at, updatedAt: row.updated_at, endedAt: row.ended_at, sessionFile: row.session_file,
	};
}
export function toEvent(row: EventRow) {
	return {
		id: row.id, goalId: row.goal_id, kind: row.kind, dedupeKey: row.dedupe_key, payload: parseJson(row.payload, {}),
		createdAt: row.created_at, handledAt: row.handled_at, handledByGeneration: row.handled_by_generation,
	};
}
export function toIntent(row: IntentRow) {
	return {
		id: row.id, goalId: row.goal_id, revision: row.revision, generation: row.generation, idemKey: row.idem_key,
		action: row.action, status: row.status, reason: row.reason, createdAt: row.created_at, startedAt: row.started_at,
		runId: row.run_id,
	};
}

export function object(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new RpcError("bad_request", `${name} 格式无效`);
	return value as Record<string, unknown>;
}
function array(value: unknown, name: string): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new RpcError("bad_request", `${name} 必须是列表`);
	return value;
}
function text(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new RpcError("bad_request", `${name} 不能为空`);
	return value;
}
function check(value: unknown): Check | undefined {
	if (value === undefined) return undefined;
	const row = object(value, "验收检查");
	return { kind: text(row.kind, "检查方式"), ...(row.args === undefined ? {} : { args: object(row.args, "检查参数") }) };
}
export function readSpec(value: unknown, current: GoalSpec = EMPTY_SPEC): GoalSpec {
	const row = object(value, "目标内容");
	if (row.objective !== undefined && typeof row.objective !== "string") throw new RpcError("bad_request", "目标结果格式无效");
	const constraints = row.constraints === undefined ? current.constraints : array(row.constraints, "约束").map(value => {
		const rule = object(value, "约束");
		if (rule.kind !== "must" && rule.kind !== "must_not") throw new RpcError("bad_request", "约束类型无效");
		return { kind: rule.kind, text: text(rule.text, "约束"), check: check(rule.check) } as GoalSpec["constraints"][number];
	});
	const acceptance = row.acceptance === undefined ? current.acceptance : array(row.acceptance, "验收条件").map(value => {
		const rule = object(value, "验收条件");
		if (rule.layer !== "program" && rule.layer !== "model" && rule.layer !== "user") throw new RpcError("bad_request", "验收层无效");
		return { id: text(rule.id, "验收条件 ID"), text: text(rule.text, "验收条件"), layer: rule.layer, check: check(rule.check) } as GoalSpec["acceptance"][number];
	});
	if (new Set(acceptance.map(item => item.id)).size !== acceptance.length) throw new RpcError("bad_request", "验收条件 ID 重复");
	return {
		objective: (row.objective as string | undefined)?.trim() ?? current.objective,
		constraints, acceptance,
		deliverables: row.deliverables === undefined ? current.deliverables : array(row.deliverables, "产物").map(item => text(item, "产物")),
	};
}

export function readScope(value: unknown): GoalScope {
	const row = object(value, "目标范围");
	const partition = row.partition ?? "workbench";
	if (partition !== "workbench" && partition !== "butterfly") throw new RpcError("bad_request", "目标归属无效");
	const sandbox = partition === "butterfly";
	if (row.sandbox !== undefined && row.sandbox !== sandbox) throw new RpcError("bad_request", "目标归属和沙箱范围不一致");
	return {
		cwd: row.cwd == null ? null : text(row.cwd, "工作区"), partition, sandbox,
		...(row.allowedTools === undefined ? {} : { allowedTools: array(row.allowedTools, "授权工具").map(item => text(item, "工具名称")) }),
		...(row.allowedPaths === undefined ? {} : { allowedPaths: array(row.allowedPaths, "授权路径").map(item => text(item, "路径")) }),
		...(row.externalActions === undefined ? {} : { externalActions: array(row.externalActions, "授权外部动作").map(value => {
			const { tool, command } = object(value, "外部动作");
			if (tool !== "bash" && tool !== "pwsh" && tool !== "powershell") throw new RpcError("bad_request", "外部动作工具无效");
			return { tool, command: text(command, "授权命令") };
		}) }),
	};
}
export function validMandate(source: GoalSource, ref: string): boolean {
	if (source === "user" || source === "card") return /^user:[^\s]+$/.test(ref);
	const pattern = source === "rule" ? /^rule:[^\s@]+@[1-9]\d*$/ : /^schedule:[^\s@]+@[1-9]\d*$/;
	return pattern.test(ref);
}
export function isTerminal(status: GoalStatus): boolean {
	return status === "completed" || status === "cancelled" || status === "failed";
}
export function ready(goal: Pick<Goal, "spec" | "scope">): boolean {
	return !!(goal.spec.objective.trim() && goal.scope.cwd);
}
