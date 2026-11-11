import { RpcError } from "../../core.ts";
import type { Db } from "../../db.ts";
import type { LedgerRow } from "../../ledger/types.ts";
import type { CoreSettings } from "../../settings.ts";
import { object, type BudgetReason, type Goal, type GoalBudget } from "./types.ts";

export type ChargeKind = "main" | "subagent" | "review" | "memory" | "compaction" | "assessment";
export interface Reservation {
	id: string;
	taskId?: string;
	runId?: string;
	requestId?: string;
	kind: ChargeKind;
	costUsd: number;
	costUnknown?: boolean;
	inputTokens?: number;
	outputTokens?: number;
	activeMs?: number;
}
interface ChargeRow {
	id: string; goal_id: string; task_id: string | null; run_id: string | null; request_id: string | null;
	kind: ChargeKind; state: "reserved" | "settled" | "released";
	est_cost: number; est_input_tokens: number; est_output_tokens: number; est_active_ms: number;
	cost: number | null; input_tokens: number | null; output_tokens: number | null; active_ms: number | null;
	cost_estimated: number; created_at: number; settled_at: number | null;
	release_reason: string | null;
	cost_unknown: number;
}
interface Usage { costUsd: number; tokens: number; activeMs: number; runs: number; parallel: number }
export interface BudgetView { limits: GoalBudget; used: Usage; reserved: Usage; remaining: Omit<Usage, "tokens"> & { tokens: number | null } }
const COST_EPSILON = 1e-9;
const CAP_KEYS = ["maxCostUsd", "maxTokens", "maxActiveMs", "maxRuns", "maxParallel"] as const;

export function budgetPatch(input: unknown): Partial<GoalBudget> | null {
	if (input === null) return null;
	const source = object(input, "目标预算");
	const budget: Partial<GoalBudget> = {};
	for (const key of CAP_KEYS) {
		const value = source[key];
		if (value === undefined) continue;
		if (key === "maxTokens" && value === null) { budget.maxTokens = null; continue; }
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (key !== "maxCostUsd" && !Number.isSafeInteger(value))
			|| (key === "maxParallel" && value === 0)) throw new RpcError("bad_request", `目标预算 ${key} 无效`);
		budget[key] = value;
	}
	return budget;
}

function nonnegative(value: number): boolean { return Number.isFinite(value) && value >= 0; }

export function validateReservation(input: Reservation): void {
	if (!input.id.trim() || !["main", "subagent", "review", "memory", "compaction", "assessment"].includes(input.kind)
		|| !nonnegative(input.costUsd)
		|| [input.inputTokens, input.outputTokens, input.activeMs].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
		throw new RpcError("bad_request", "目标预算预留参数无效");
	}
}

export function effectiveBudget(goal: Goal, settings: CoreSettings): GoalBudget {
	const { costUsd, activeMinutes, runs, concurrency } = settings.goalDefaultBudget;
	const autonomous = goal.scope.partition === "butterfly" && (goal.source === "rule" || goal.source === "schedule");
	const factor = autonomous ? settings.goalButterflyBudgetFactor : 1;
	return {
		maxCostUsd: costUsd * factor, maxTokens: null, maxActiveMs: Math.floor(activeMinutes * 60_000 * factor),
		maxRuns: Math.max(1, Math.floor(runs * factor)), maxParallel: Math.max(1, Math.floor(concurrency * factor)),
		...goal.budget,
	};
}

export function exhausted(view: BudgetView, checkCost = true): BudgetReason | null {
	const { remaining } = view;
	if (checkCost && remaining.costUsd <= COST_EPSILON) return "budget_cost";
	if (remaining.tokens !== null && remaining.tokens <= 0) return "budget_tokens";
	if (remaining.activeMs <= 0) return "budget_time";
	if (remaining.runs <= 0) return "budget_runs";
	return null;
}

export function chargeView(row: ChargeRow) {
	return {
		id: row.id, goalId: row.goal_id, taskId: row.task_id, runId: row.run_id, requestId: row.request_id, kind: row.kind, state: row.state,
		estCost: row.est_cost, estInputTokens: row.est_input_tokens, estOutputTokens: row.est_output_tokens, estActiveMs: row.est_active_ms,
		cost: row.cost, inputTokens: row.input_tokens, outputTokens: row.output_tokens, activeMs: row.active_ms,
		costUnknown: !!row.cost_unknown, costEstimated: !!row.cost_estimated, releaseReason: row.release_reason, createdAt: row.created_at, settledAt: row.settled_at,
	};
}

/** All mutations run inside the scheduler's write transaction, including the capacity check. */
export class GoalLedger {
	private readonly db: Db;
	private readonly settings: () => CoreSettings;
	constructor(db: Db, settings: () => CoreSettings) {
		this.db = db;
		this.settings = settings;
	}

	get(id: string) { return this.db.get<ChargeRow>("SELECT * FROM goal_ledger WHERE id = ?", id); }
	costUnknown(goalId: string): boolean {
		return !!this.db.get("SELECT 1 FROM goal_ledger WHERE goal_id=? AND state<>'released' AND cost_unknown=1 LIMIT 1", goalId);
	}

	entries(goalId: string, limit: number) {
		return this.db.all<ChargeRow>("SELECT * FROM goal_ledger WHERE goal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?", goalId, limit).map(chargeView);
	}

	view(goal: Goal): BudgetView {
		const row = this.db.get<{
			usedCost: number; heldCost: number; usedTokens: number; heldTokens: number; usedTime: number; heldTime: number;
			usedRuns: number; totalRuns: number; parallel: number;
		}>(`SELECT
			total(CASE WHEN state='settled' THEN g.cost END) usedCost,
			total(CASE WHEN state='reserved' THEN est_cost END) heldCost,
			total(CASE WHEN state='settled' THEN g.input_tokens + g.output_tokens END) usedTokens,
			total(CASE WHEN state='reserved' THEN est_input_tokens + est_output_tokens END) heldTokens,
			total(CASE WHEN run_id IS NULL AND state='settled' THEN active_ms END) usedTime,
			total(CASE WHEN run_id IS NULL AND state='reserved' THEN est_active_ms END) heldTime,
			count(DISTINCT CASE WHEN g.kind='main' AND state='settled' AND r.id IS NULL THEN COALESCE('run:' || run_id, 'charge:' || g.id) END) usedRuns,
			count(DISTINCT CASE WHEN g.kind='main' AND r.id IS NULL THEN COALESCE('run:' || run_id, 'charge:' || g.id) END) totalRuns,
			count(CASE WHEN state='reserved' AND cost_estimated=0 THEN 1 END) parallel
			FROM goal_ledger g LEFT JOIN runs r ON r.id=g.run_id WHERE goal_id = ? AND state IN ('reserved','settled')`, goal.id)!;
		const runs = this.db.all<{ started_at: number; ended_at: number | null }>(
			"SELECT r.started_at,r.ended_at FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.goal_id=? AND r.started_at IS NOT NULL ORDER BY r.started_at", goal.id);
		const now = Date.now();
		let covered = 0;
		for (const run of runs) {
			const end = run.ended_at ?? now;
			row.usedTime += Math.max(0, end - Math.max(covered, run.started_at));
			covered = Math.max(covered, end);
		}
		row.usedRuns += runs.length;
		row.totalRuns += runs.length;
		const limits = effectiveBudget(goal, this.settings());
		return {
			limits,
			used: { costUsd: row.usedCost, tokens: row.usedTokens, activeMs: row.usedTime, runs: row.usedRuns, parallel: 0 },
			reserved: { costUsd: row.heldCost, tokens: row.heldTokens, activeMs: row.heldTime, runs: row.totalRuns - row.usedRuns, parallel: row.parallel },
			remaining: {
				costUsd: Math.max(0, limits.maxCostUsd - row.usedCost - row.heldCost),
				tokens: limits.maxTokens === null ? null : Math.max(0, limits.maxTokens - row.usedTokens - row.heldTokens),
				activeMs: Math.max(0, limits.maxActiveMs - row.usedTime - row.heldTime),
				runs: Math.max(0, limits.maxRuns - row.totalRuns), parallel: Math.max(0, limits.maxParallel - row.parallel),
			},
		};
	}

	wouldExceed(goal: Goal, input: Reservation): BudgetReason | "concurrency" | null {
		const { remaining, limits, used, reserved } = this.view(goal);
		if (!input.costUnknown && used.costUsd + reserved.costUsd + input.costUsd > limits.maxCostUsd + COST_EPSILON) return "budget_cost";
		if (limits.maxTokens !== null && used.tokens + reserved.tokens + (input.inputTokens ?? 0) + (input.outputTokens ?? 0) > limits.maxTokens) return "budget_tokens";
		if (used.activeMs + reserved.activeMs + (input.activeMs ?? 0) > limits.maxActiveMs) return "budget_time";
		if (input.kind === "main" && remaining.runs === 0 && (!input.runId || !this.db.get(`SELECT 1 FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.goal_id=? AND r.id=?
			UNION ALL SELECT 1 FROM goal_ledger WHERE goal_id=? AND run_id=? AND kind='main' AND state IN ('reserved','settled')`,
			goal.id, input.runId, goal.id, input.runId))) return "budget_runs";
		if (remaining.parallel <= 0) return "concurrency";
		return null;
	}

	reserve(goalId: string, input: Reservation, at: number) {
		if (input.taskId && !this.db.get("SELECT 1 FROM tasks WHERE id = ? AND goal_id = ?", input.taskId, goalId)) {
			throw new RpcError("bad_request", "工作项不属于这个目标");
		}
		if (input.requestId) this.request(input.requestId, input.runId ?? null);
		if (input.requestId && this.db.get("SELECT 1 FROM goal_ledger WHERE request_id = ?", input.requestId)) throw new RpcError("conflict", "这笔请求已经记入目标账本");
		this.db.run(`INSERT INTO goal_ledger(id, goal_id, task_id, run_id, request_id, kind, state, est_cost, est_input_tokens, est_output_tokens, est_active_ms, created_at,cost_unknown)
			VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?)`,
		input.id, goalId, input.taskId ?? null, input.runId ?? null, input.requestId ?? null, input.kind,
		input.costUsd, input.inputTokens ?? 0, input.outputTokens ?? 0, input.activeMs ?? 0, at, Number(!!input.costUnknown));
		return chargeView(this.get(input.id)!);
	}

	private request(id: string, runId: string | null): LedgerRow {
		const row = this.db.get<LedgerRow>("SELECT * FROM request_ledger WHERE id = ?", id);
		if (!row) throw new RpcError("not_found", "找不到逐请求账本记录");
		if (runId && row.run_id && row.run_id !== runId) throw new RpcError("conflict", "请求不属于这次运行");
		return row;
	}

	link(id: string, requestId: string): void {
		const entry = this.get(id);
		if (!entry || entry.state !== "reserved") throw new RpcError("conflict", "找不到可关联的目标预算预留");
		this.request(requestId, entry.run_id);
		this.db.run("UPDATE goal_ledger SET request_id=? WHERE id=? AND (request_id IS NULL OR request_id=?)", requestId, id, requestId);
	}

	settle(id: string, requestId: string, at: number) {
		const entry = this.get(id);
		if (!entry) throw new RpcError("not_found", "找不到目标预算预留");
		if (entry.request_id && entry.request_id !== requestId) throw new RpcError("conflict", "预留已绑定到另一笔请求");
		if (entry.state === "settled") return chargeView(entry);
		if (entry.state === "released") throw new RpcError("conflict", "这笔预留已释放");
		const request = this.request(requestId, entry.run_id);
		if (request.state === "pending") throw new RpcError("conflict", "请求还没有结算");
		if (this.db.get("SELECT 1 FROM goal_ledger WHERE request_id = ? AND id <> ?", requestId, id)) throw new RpcError("conflict", "这笔请求已经记入目标账本");
		const usd = request.currency === "USD" && request.amount !== null && nonnegative(request.amount) ? request.amount : null;
		const unknown = usd === null && !!entry.cost_unknown;
		this.db.run(`UPDATE goal_ledger SET state='settled', request_id=?, cost=?, input_tokens=?, output_tokens=?, active_ms=?, cost_estimated=?, cost_unknown=?, settled_at=?
			WHERE id=? AND state='reserved'`,
		requestId, unknown ? null : usd ?? entry.est_cost, (request.input ?? entry.est_input_tokens) + (request.cache_read ?? 0) + (request.cache_write ?? 0),
		request.output ?? entry.est_output_tokens, request.duration_ms ?? entry.est_active_ms,
		Number(!unknown && (usd === null || ["price_estimate", "provider_estimate"].includes(request.amount_source))), Number(unknown), at, id);
		return chargeView(this.get(id)!);
	}

	release(id: string, at: number) {
		const entry = this.get(id);
		if (!entry) throw new RpcError("not_found", "找不到目标预算预留");
		if (entry.state === "released") return chargeView(entry);
		if (entry.state !== "reserved" || entry.request_id) throw new RpcError("conflict", "已经关联请求的预留需要结算");
		this.db.run("UPDATE goal_ledger SET state='released', settled_at=? WHERE id=? AND state='reserved'", at, id);
		return chargeView(this.get(id)!);
	}

	recover(at: number): void {
		const linked = this.db.all<{ id: string; request_id: string }>(`SELECT g.id, g.request_id FROM goal_ledger g JOIN request_ledger r ON r.id=g.request_id
			WHERE g.state='reserved' AND r.state<>'pending'`);
		for (const row of linked) this.settle(row.id, row.request_id, at);
		this.db.run(`UPDATE goal_ledger SET state='released', settled_at=?, release_reason='restart_unsent'
			WHERE state='reserved' AND run_id IS NOT NULL AND request_id IS NULL
			AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=goal_ledger.run_id AND r.started_at IS NOT NULL)`, at);
		this.db.run("UPDATE goal_ledger SET cost_estimated=1 WHERE state='reserved'");
	}
}
