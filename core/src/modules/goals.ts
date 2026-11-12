import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { type Core, type CoreModule, type Params, RpcError, normalizeCwd, samePath, requireStr, str } from "../core.ts";
import { type Db, json, now, parseJson } from "../db.ts";
import type { Slot } from "../slots/slot.ts";
import { SessionManager, type AgentSessionEvent, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Run } from "../runs.ts";
import { recordedSandbox } from "../pi/host.ts";
import { redact } from "../security/redaction.ts";
import { notificationQueueState, type NotificationState } from "../notify.ts";
import { widensScope, type ProgramReport, type ReviewVerdict, type ToolReceipt } from "./goals/acceptance.ts";
import { goalChannelFailure, type ChannelFailure } from "./goals/channel.ts";
import { GoalExecutor } from "./goals/executor.ts";
import { GoalWaits, LOST_JOB, type WaitRequest } from "./goals/waits.ts";
import { GOAL_NOTICE_TITLES, GOAL_VIEWS, GoalViews, goalNotice, type GoalView } from "./goals/presentation.ts";
import { goalNoticeReceipt, recordGoalNotice, recoverGoalNotices } from "./goals/notices.ts";
import { budgetPatch, chargeView, costDenial, effectiveBudget, exhausted, GoalLedger, validateReservation,
	type NormalRequest, type Reservation, type SettlementEstimate } from "./goals/budget.ts";
import {
	GOAL_STATUSES, isTerminal, object, readScope, readSpec, ready, toEvent, toGoal, toIntent, validMandate,
	type BudgetReason, type EventRow, type Goal, type GoalBudget, type GoalControl, type GoalEventKind,
	type GoalReason, type GoalRow, type GoalSource, type GoalStatus, type IntentRow, type RunFinished, type StopIntent,
} from "./goals/types.ts";

const EMERGENCY = "goal_emergency";
const LEASE_MS = 60_000;
const BUDGET_FIELD = { budget_cost: "maxCostUsd", budget_tokens: "maxTokens", budget_time: "maxActiveMs", budget_runs: "maxRuns" } as const;
const CONTROLS = ["pause", "resume", "stop_run", "cancel", "emergency", "clear_emergency"] as const;
const SOURCES = ["user", "card", "schedule", "rule"] as const;
type GoalPatch = Partial<Record<keyof GoalRow, SQLInputValue>>;
type ApprovalRow = { id: string; goal_id: string; revision: number; kind: "acceptance" | "scope"; status: string; payload: string; created_at: number };
type ReviewRow = { id: string; goal_id: string; revision: number; evidence_version: number; layer: "program" | "model" | "user"; verdict: string; missing: string | null; reasons: string | null; model: string | null; cost: number | null; created_at: number };
type EvidenceRow = { kind: string; ref: string | null; detail: string | null; revision?: number; version: number; created_at: number; run_id: string | null };

/** An immediate write transaction makes capacity reads and conditional writes one operation across connections. */
function write<T>(db: Db, operation: () => T): T {
	db.raw.exec("BEGIN IMMEDIATE");
	try {
		const result = operation();
		db.raw.exec("COMMIT");
		return result;
	} catch (error) {
		db.raw.exec("ROLLBACK");
		throw error;
	}
}

function compare(db: Db, before: GoalRow, patch: GoalPatch, at: number): boolean {
	const fields = Object.entries({ ...patch, updated_at: at });
	return db.run(`UPDATE goals SET ${fields.map(([key]) => `${key}=?`).join(", ")}
		WHERE id=? AND lease_generation=? AND revision=? AND stop_intent IS ?
			AND status=? AND lease_owner IS ? AND lease_until IS ? AND budget IS ?`,
		...fields.map(([, value]) => value), before.id, before.lease_generation, before.revision, before.stop_intent,
		before.status, before.lease_owner, before.lease_until, before.budget).changes === 1;
}

function dropIntents(db: Db, id: string, claimed = false): void {
	db.run(`UPDATE goal_intents SET status='dropped' WHERE goal_id=? AND (status='pending' OR (? AND status='started'))`, id, Number(claimed));
}

function fenced(row: GoalRow): GoalPatch {
	return { lease_owner: null, lease_generation: row.lease_generation + 1, lease_until: null };
}

function pause(row: GoalRow, reason: GoalReason, resumeWhen: string): GoalPatch {
	return { ...fenced(row), status: "paused", reason, resume_when: resumeWhen, ended_at: null };
}

function stageImported(db: Db): void {
	const at = now();
	for (const row of db.all<GoalRow>("SELECT * FROM goals WHERE status NOT IN ('completed','failed','cancelled')")) {
		if (compare(db, row, pause(row, "imported", "核对导入的工作区和授权后继续"), at)) {
			dropIntents(db, row.id, true);
			db.run("UPDATE goal_approvals SET status='dropped', resolved_at=? WHERE goal_id=? AND status='pending'", at, row.id);
		}
	}
}

function inside(root: string, file: string): boolean {
	const path = relative(root, file);
	return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** First slice's read-only check. Unverified acceptance stays outstanding. */
function programPending(goal: Goal): boolean {
	return goal.spec.acceptance.some(item => {
		if (item.layer !== "program") return false;
		const file = item.check?.args?.path;
		if (item.check?.kind !== "file_exists" || typeof file !== "string" || !goal.scope.cwd || goal.scope.sandbox) return true;
		try {
			const root = realpathSync(goal.scope.cwd);
			const candidate = resolve(root, file);
			if (!inside(root, candidate)) return true;
			const target = realpathSync(candidate);
			if (!inside(root, target)) return true;
			const allowed = goal.scope.allowedPaths;
			return (allowed !== undefined && !allowed.some(path => inside(resolve(root, path), target))) || !statSync(target).isFile();
		} catch { return true; }
	});
}

export class GoalScheduler {
	private readonly core: Core;
	private readonly clock: () => number;
	private readonly hasProgramSteps: (goal: Goal) => boolean;
	private readonly db: Db;
	private readonly owner = randomUUID();
	readonly ledger: GoalLedger;
	readonly waits: GoalWaits;
	readonly views: GoalViews;

	constructor(
		core: Core,
		clock: () => number = now,
		hasProgramSteps: (goal: Goal) => boolean = programPending,
	) {
		this.core = core;
		this.clock = clock;
		this.hasProgramSteps = hasProgramSteps;
		this.db = core.db;
		this.ledger = new GoalLedger(this.db, () => core.settings.get());
		this.waits = new GoalWaits(this.db);
		this.views = new GoalViews(core);
	}

	private row(id: string) { return this.db.get<GoalRow>("SELECT * FROM goals WHERE id=?", id); }
	private required(id: string) {
		const row = this.row(id);
		if (!row) throw new RpcError("not_found", "没有这个目标");
		return row;
	}
	get(id: string): Goal | undefined { const row = this.row(id); return row && toGoal(row); }

	list(status: GoalStatus | undefined, limit: number, view?: GoalView, partition?: Goal["scope"]["partition"]) {
		return this.views.list(status, limit, view, partition);
	}
	detail(id: string) {
		const goal = toGoal(this.required(id));
		const run = this.latestRun(id, goal.revision);
		const program = this.latestProgram(id, goal.revision);
		const review = this.db.get<ReviewRow>("SELECT * FROM goal_reviews WHERE id=?", goal.latestReviewId);
		const reasons = parseJson<{ next?: string; questions?: string[] }>(review?.reasons, {});
		const evidenceVersion = this.evidenceVersion(id);
		const artifacts = this.views.artifacts(goal);
		const approvals = this.approvals(id);
		return {
			...goal, ...this.views.labels(goal, artifacts[0]?.name), budgetStatus: this.ledger.view(goal), costUnknown: this.ledger.costUnknown(id), recentEvents: this.events(id, 20), emergency: this.emergency(),
			executionEnded: !!run?.ended_at, artifactsGenerated: artifacts.length > 0,
			machineAccepted: review?.layer === "model" && review.verdict === "done" && review.revision === goal.revision
				&& (review.evidence_version === evidenceVersion || goal.status === "completed"),
			awaitingAcceptance: goal.status === "waiting_user" && goal.reason === "acceptance",
			completed: goal.status === "completed", checks: program?.checks ?? [],
			missing: program?.checks.filter(check => check.status !== "passed") ?? [],
			review: review ? { verdict: review.verdict, missing: parseJson<string[]>(review.missing, []), next: reasons.next ?? null,
				questions: reasons.questions ?? [], model: review.model, evidenceVersion: review.evidence_version } : null,
			artifacts, approvals, stillRunning: this.core.module(GoalsModule)?.executor.stillRunning(id) ?? [],
			waits: this.waits.detail(goal), services: this.waits.services(id),
			irreversible: this.db.all<EvidenceRow>("SELECT * FROM goal_evidence WHERE goal_id=? AND kind='effect' ORDER BY version", id)
				.map(row => ({ at: row.created_at, runId: row.run_id, ...parseJson<Record<string, unknown>>(row.detail, {}) })),
		};
	}

	private latestRun(id: string, revision: number) {
		return this.db.get<{ ended_at: number | null }>(`SELECT r.ended_at FROM goal_intents i JOIN runs r ON r.id=i.run_id
			WHERE i.goal_id=? AND i.revision=? AND i.action='run' ORDER BY r.started_at DESC,r.rowid DESC LIMIT 1`, id, revision);
	}
	history(id: string) {
		this.required(id);
		const rows = this.db.all<{ goal_id: string; revision: number; origin_text: string; spec: string; scope: string; by: string; why: string | null; at: number }>(
			'SELECT * FROM goal_revisions WHERE goal_id=? ORDER BY revision DESC', id,
		);
		return rows.map(row => ({
			goalId: row.goal_id, revision: row.revision, originText: row.origin_text, spec: parseJson(row.spec, {}), scope: parseJson(row.scope, {}),
			by: row.by, why: row.why, at: row.at,
		}));
	}
	private events(id: string, limit: number) {
		return this.db.all<EventRow>("SELECT * FROM goal_events WHERE goal_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?", id, limit).map(toEvent);
	}
	private approvals(id?: string) {
		const rows = id
			? this.db.all<ApprovalRow>("SELECT * FROM goal_approvals WHERE status='pending' AND goal_id=? ORDER BY created_at", id)
			: this.db.all<ApprovalRow>("SELECT * FROM goal_approvals WHERE status='pending' ORDER BY created_at");
		return rows.map(row => ({
			id: row.id, goalId: row.goal_id, revision: row.revision, kind: row.kind,
			payload: parseJson(row.payload, {}), createdAt: row.created_at, actions: ["accept", "reject"],
		}));
	}
	pendingApprovals() { return this.approvals(); }
	private approval(row: GoalRow, kind: ApprovalRow["kind"], payload: object): string {
		const id = randomUUID();
		this.db.run("INSERT INTO goal_approvals(id,goal_id,revision,kind,status,payload,created_at) VALUES(?,?,?,?,'pending',?,?)",
			id, row.id, row.revision, kind, json(payload), this.clock());
		return id;
	}
	private dropApprovals(id: string): void {
		this.db.run("UPDATE goal_approvals SET status='dropped', resolved_at=? WHERE goal_id=? AND status='pending'", this.clock(), id);
	}
	resolveApproval(id: string, accept: boolean, note?: string) {
		const goalId = write(this.db, () => {
			const approval = this.db.get<ApprovalRow>("SELECT * FROM goal_approvals WHERE id=? AND status='pending'", id);
			if (!approval) throw new RpcError("gone", "这个待确认事项已经处理或失效");
			const row = this.required(approval.goal_id), at = this.clock();
			if (row.revision !== approval.revision || this.emergency()) throw new RpcError("version_conflict", "目标刚被修改或停止，请重新读取");
			if (approval.kind === "acceptance" && (row.stop_intent || row.status !== "waiting_user" || row.reason !== "acceptance")) {
				throw new RpcError("gone", "这个目标当前未在等待验收");
			}
			const payload = parseJson<Record<string, unknown>>(approval.payload, {});
			const patch: GoalPatch = {};
			if (approval.kind === "scope") {
				if (accept) Object.assign(patch, {
					scope: json(readScope(payload.scope)), spec: json(readSpec(payload.spec)), revision: row.revision + 1,
					progress: "{}", latest_review_id: null,
				});
				if (!row.stop_intent && row.status !== "paused" && !isTerminal(row.status)) Object.assign(patch, {
					status: ready(toGoal({ ...row, ...patch } as GoalRow)) ? "queued" : "draft", reason: null, resume_when: null,
				});
			} else if (accept) {
				Object.assign(patch, { status: "completed", reason: null, resume_when: null, ended_at: at });
				this.evidence(row, "user_ack", null, { approvalId: approval.id }, null);
			} else {
				if (!note?.trim()) throw new RpcError("bad_request", "请填写退回原因");
				Object.assign(patch, { status: "queued", revision: row.revision + 1, reason: null, resume_when: null, progress: "{}", latest_review_id: null });
				this.evidence({ ...row, revision: row.revision + 1 }, "user_feedback", null, { reason: note.trim().slice(0, 4000) }, null);
			}
			if (!compare(this.db, row, { ...fenced(row), ...patch }, at)) throw new RpcError("version_conflict", "目标刚被修改，请重新读取");
			this.db.run("UPDATE goal_approvals SET status=?, resolved_at=? WHERE id=? AND status='pending'", accept ? "accepted" : "rejected", at, approval.id);
			const current = this.required(row.id);
			if (current.revision !== row.revision) {
				this.waits.cancel(row.id, at);
				this.revision(current, approval.kind === "scope" ? str(payload.why) ?? "确认授权范围" : note ?? null);
			}
			if (current.status === "completed") this.enqueueNotification(current);
			return row.id;
		});
		this.changed(goalId);
		this.process(goalId);
		return this.detail(goalId);
	}
	private revision(row: GoalRow, why: string | null): void {
		this.db.run('INSERT INTO goal_revisions(goal_id, revision, origin_text, spec, scope, "by", why, at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
			row.id, row.revision, row.origin_text, row.spec, row.scope, "user", why, this.clock());
	}
	private changed(id: string): void {
		const row = this.row(id);
		if (row) {
			this.enqueueNotification(row);
			this.core.broadcast({ event: "goals.changed", id, status: row.status, revision: row.revision });
		}
	}

	create(p: Params, proposalId?: string) {
		const originText = requireStr(p.originText, "originText");
		if (!originText.trim()) throw new RpcError("bad_request", "请保留目标原话");
		const title = requireStr(p.title, "title").trim();
		if (!title) throw new RpcError("bad_request", "请填写目标标题");
		const source: GoalSource | undefined = p.source === undefined ? "user" : SOURCES.find(value => value === p.source);
		const mandateRef = requireStr(p.mandateRef ?? (source === "user" && str(p.messageId) ? `user:${p.messageId}` : undefined), "mandateRef");
		if (!source || !validMandate(source, mandateRef)) throw new RpcError("bad_request", "目标来源和授权依据不匹配");
		const slot = p.slotId !== undefined ? this.core.slot(requireStr(p.slotId, "slotId")) : undefined;
		const sessionFile = str(p.sessionFile) ?? slot?.info().sessionFile ?? null;
		if (slot && (slot.incognito || !sessionFile || !samePath(sessionFile, slot.info().sessionFile))) throw new RpcError("bad_request", "目标需要一个已保存的普通会话");
		let sessionScope: Goal["scope"] | undefined;
		if (sessionFile) {
			this.core.assertTaskSession(sessionFile);
			if (!statSync(sessionFile).isFile()) throw new RpcError("not_found", "找不到目标会话");
			const manager = slot?.session.sessionManager ?? SessionManager.open(sessionFile);
			const sandbox = slot?.sandboxed ?? recordedSandbox(manager);
			sessionScope = { cwd: slot?.cwd ?? manager.getHeader()?.cwd ?? null, partition: sandbox ? "butterfly" : "workbench", sandbox };
		}
		const scope = readScope({ ...sessionScope, ...object(p.scope ?? {}, "目标范围") });
		if (sessionScope && (!samePath(scope.cwd, sessionScope.cwd) || scope.sandbox !== sessionScope.sandbox)) throw new RpcError("bad_request", "目标范围与已选会话不一致");
		const spec = readSpec(p.spec ?? {});
		const budget = p.budget === undefined ? null : budgetPatch(p.budget);
		const id = `g_${randomUUID().slice(0, 8)}`;
		const at = this.clock();
		write(this.db, () => {
			if (proposalId && !this.db.get("SELECT 1 FROM goal_proposals WHERE id=? AND status='pending'", proposalId)) throw new RpcError("gone", "这个目标提议已经处理");
			if (sessionFile && this.goalForSession(sessionFile)) throw new RpcError("conflict", "这个会话已有正在处理的目标");
			const emergency = this.emergency();
			const status = emergency ? "paused" : ready({ spec, scope }) ? "queued" : "draft";
			this.db.run(`INSERT INTO goals(id,title,origin_text,spec,scope,mandate_ref,source,status,reason,resume_when,stop_intent,budget,created_at,updated_at,session_file)
				VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, title, originText, json(spec), json(scope), mandateRef, source, status,
			status === "draft" ? "missing_input" : emergency ? "user_paused" : null,
			status === "draft" ? "补齐目标结果和工作区" : emergency ? "解除紧急停止后继续" : null,
				emergency ? "emergency" : null, budget && json(budget), at, at, sessionFile);
			if (sessionFile) {
				const task = this.db.get<{ id: string }>("SELECT id FROM tasks WHERE lower(session_file)=? AND goal_id IS NULL AND cwd_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1", normalizeCwd(sessionFile), normalizeCwd(scope.cwd!));
				if (task) {
					this.db.run("UPDATE tasks SET goal_id=? WHERE id=? AND goal_id IS NULL", id, task.id);
					this.db.run("UPDATE goals SET current_task_id=? WHERE id=?", task.id, id);
				}
			}
			if (proposalId) this.db.run("UPDATE goal_proposals SET status='accepted',goal_id=? WHERE id=? AND status='pending'", id, proposalId);
			this.revision(this.required(id), str(p.why) ?? null);
		});
		this.changed(id);
		this.process(id);
		return this.detail(id);
	}

	goalForSession(sessionFile: string): Goal | undefined {
		const row = this.db.get<GoalRow>(`SELECT g.* FROM goals g WHERE g.status NOT IN ('completed','cancelled','failed') AND
			(lower(g.session_file)=? OR EXISTS(SELECT 1 FROM tasks t WHERE t.goal_id=g.id AND lower(t.session_file)=?))
			ORDER BY g.created_at DESC,g.rowid DESC LIMIT 1`, normalizeCwd(sessionFile), normalizeCwd(sessionFile));
		return row && toGoal(row);
	}
	goalForSlot(slot: Slot): Goal | undefined {
		if (slot.incognito || slot.isSideConversation) return undefined;
		const taskGoal = slot.taskId ? this.db.get<{ goal_id: string | null }>("SELECT goal_id FROM tasks WHERE id=?", slot.taskId)?.goal_id : null;
		const goal = taskGoal ? this.get(taskGoal) : undefined;
		if (goal && !isTerminal(goal.status)) return goal;
		const file = slot.info().sessionFile;
		return file ? this.goalForSession(file) : undefined;
	}

	receiveInput(id: string, key: string, text: string): boolean {
		if (this.db.get("SELECT 1 FROM goal_events WHERE dedupe_key=?", key)) return false;
		this.post(id, "user.input", key, { text });
		return true;
	}
	beginInput(id: string, key: string, taskId: string): { goal: Goal; intent: IntentRow } | null {
		const result = write(this.db, () => {
			const row = this.required(id);
			const event = this.db.get<EventRow>("SELECT * FROM goal_events WHERE goal_id=? AND dedupe_key=? AND kind='user.input' AND handled_at IS NULL", id, key);
			if (!event || row.stop_intent || row.status === "paused" || isTerminal(row.status) || this.emergency() || this.core.maintenance) return null;
			if (!this.db.get("SELECT 1 FROM tasks WHERE id=? AND goal_id=?", taskId, id) || !this.idle(id)) return null;
			const limit = exhausted(this.ledger.view(toGoal(row)), false);
			if (limit) { this.pauseBudget(row, limit); return null; }
			const at = this.clock(), generation = row.lease_generation + 1;
			if (!compare(this.db, row, { status: "running", reason: null, resume_when: null, lease_owner: this.owner, lease_until: at + LEASE_MS,
				lease_generation: generation, current_task_id: taskId }, at)) return null;
			dropIntents(this.db, id, true);
			this.handled(event, generation);
			const intentId = randomUUID();
			this.db.run(`INSERT INTO goal_intents(id,goal_id,revision,generation,idem_key,action,status,reason,created_at,started_at)
				VALUES(?,?,?,?,?,'run','started','user',?,?)`, intentId, id, row.revision, generation, `input:${event.id}`, at, at);
			return { goal: this.get(id)!, intent: this.db.get<IntentRow>("SELECT * FROM goal_intents WHERE id=?", intentId)! };
		});
		if (result) this.changed(id);
		return result;
	}
	dismissInput(id: string, key: string): void {
		this.db.run("UPDATE goal_events SET handled_at=? WHERE goal_id=? AND dedupe_key=? AND handled_at IS NULL", this.clock(), id, key);
	}
	deliverInput(intent: IntentRow, key: string): boolean {
		if (!this.isCurrent(intent, "running")) return false;
		return !!this.db.run(`UPDATE goal_events SET handled_at=?,handled_by_generation=?
			WHERE goal_id=? AND dedupe_key=? AND kind='user.input' AND handled_at IS NULL`,
			this.clock(), intent.generation, intent.goal_id, key).changes;
	}

	update(id: string, p: Params, active?: IntentRow) {
		const edited = write(this.db, () => {
			const row = this.required(id), goal = toGoal(row);
			if (active && !this.isCurrent(active, "running")) throw new RpcError("conflict", "这个执行已结束或修订");
			if (p.expectedRevision !== undefined && p.expectedRevision !== row.revision) throw new RpcError("version_conflict", "目标刚被修改，请重新读取");
			const spec = p.spec === undefined ? goal.spec : readSpec(p.spec, goal.spec);
			const scope = p.scope === undefined ? goal.scope : readScope({ ...goal.scope, ...object(p.scope, "目标范围") });
			if (json(spec) === row.spec && json(scope) === row.scope) return false;
			this.dropApprovals(id);
			if (widensScope(goal.scope, scope)) {
				const pending = this.approval(row, "scope", { scope, spec, why: str(p.why) ?? null, originalStatus: row.status, originalReason: row.reason });
				if (!row.stop_intent && !this.emergency() && !isTerminal(row.status) && row.status !== "paused") {
					if (!compare(this.db, row, { ...fenced(row), status: "waiting_user", reason: "needs_permission", resume_when: "等你确认新的执行范围" }, this.clock())) {
						throw new RpcError("version_conflict", "目标刚被修改，请重新读取");
					}
					dropIntents(this.db, id, true);
				}
				return !!pending;
			}
			let status = row.status;
			let reason = row.reason;
			let resumeWhen = row.resume_when;
			if (!row.stop_intent && !this.emergency() && !["paused", "cancelled", "failed"].includes(status)) {
				status = ready({ spec, scope }) ? "queued" : "draft";
				reason = status === "draft" ? "missing_input" : null;
				resumeWhen = status === "draft" ? "补齐目标结果和工作区" : null;
			}
			if (!compare(this.db, row, {
				...(active ? {} : fenced(row)), revision: row.revision + 1, spec: json(spec), scope: json(scope), latest_review_id: null, progress: "{}",
				status: active ? "running" : status, reason, resume_when: resumeWhen, ended_at: isTerminal(status) ? row.ended_at : null,
			}, this.clock())) return false;
			if (active) {
				this.db.run("UPDATE goal_intents SET revision=? WHERE id=? AND status='started'", row.revision + 1, active.id);
				dropIntents(this.db, id);
			} else dropIntents(this.db, id, true);
			const next = this.required(id);
			this.waits.cancel(id, this.clock());
			this.revision(next, str(p.why) ?? null);
			const event = this.insertEvent(id, "user.control", `revision:${id}:${next.revision}`, { action: "update", revision: next.revision });
			this.handled(event, next.lease_generation);
			return true;
		});
		if (edited) { this.changed(id); this.process(id); }
		return this.detail(id);
	}

	private emergency() { return !!this.db.get("SELECT 1 FROM app_flags WHERE key=?", EMERGENCY); }

	control(id: string | undefined, action: GoalControl, operationId: string = randomUUID()) {
		let applied = false;
		const affected = write(this.db, () => {
			const global = action === "emergency" || action === "clear_emergency";
			const target = global ? null : this.required(requireStr(id, "id"));
			const event = this.insertEvent(target?.id ?? null, "user.control", `control:${operationId}`, { action });
			if (event.handled_at !== null) return [];
			if (global) {
				this.handled(event, 0);
				if (action === "clear_emergency") {
					this.db.run("DELETE FROM app_flags WHERE key=?", EMERGENCY);
					return this.db.all<{ id: string }>("SELECT id FROM goals WHERE stop_intent='emergency'").map(row => row.id);
				}
				this.db.run("INSERT OR REPLACE INTO app_flags(key,value,at) VALUES(?, '1', ?)", EMERGENCY, this.clock());
				applied = true;
				const ids: string[] = [];
				for (const row of this.db.all<GoalRow>("SELECT * FROM goals WHERE status NOT IN ('completed','failed','cancelled')")) {
					const patch = pause(row, "user_paused", "解除紧急停止后继续");
					if (!compare(this.db, row, { ...patch, stop_intent: row.stop_intent ?? "emergency" }, this.clock())) continue;
					dropIntents(this.db, row.id, true);
					this.dropApprovals(row.id);
					ids.push(row.id);
				}
				this.db.run("UPDATE goal_intents SET status='dropped' WHERE status='pending'");
				return ids;
			}
			const row = target!;
			const patch = this.controlPatch(row, action as Exclude<GoalControl, "emergency" | "clear_emergency">);
			if (!patch || !compare(this.db, row, patch, this.clock())) {
				this.handled(event, row.lease_generation);
				return [];
			}
			dropIntents(this.db, row.id, true);
			applied = true;
			if (action !== "resume") this.dropApprovals(row.id);
			if (action === "cancel") this.waits.cancel(row.id, this.clock());
			this.handled(event, this.required(row.id).lease_generation);
			return [row.id];
		});
		for (const goalId of affected) this.changed(goalId);
		if (applied && action === "pause") this.core.module(GoalsModule)?.executor.discardInputs(id);
		if (applied && (action === "stop_run" || action === "cancel" || action === "emergency")) {
			this.core.module(GoalsModule)?.executor.requestStop(action === "emergency" ? undefined : id, action);
		}
		if (action === "emergency" || action === "clear_emergency") return { emergency: this.emergency() };
		if (action === "resume" && affected.length) this.process(id!);
		return this.detail(id!);
	}

	private controlPatch(row: GoalRow, action: "pause" | "stop_run" | "cancel" | "resume"): GoalPatch | null {
		if (action === "resume") {
			if (this.emergency()) throw new RpcError("conflict", "请先解除紧急停止");
			if (!["paused", "cancelled", "failed", "blocked", "waiting_user"].includes(row.status)) return null;
			if (row.status === "waiting_user" && (row.reason === "acceptance" || this.approvals(row.id).length)) throw new RpcError("conflict", "请先处理这个目标的待确认事项");
			const goal = toGoal(row);
			if (budgetReason(row.reason) || exhausted(this.ledger.view(goal), false)) throw new RpcError("conflict", "请先放宽这个目标的预算");
			const canRun = ready(goal);
			return { ...fenced(row), stop_intent: null, status: canRun ? "queued" : "draft",
				reason: canRun ? null : "missing_input", resume_when: canRun ? null : "补齐目标结果和工作区", ended_at: null };
		}
		if (isTerminal(row.status)) return null;
		if (action === "cancel") return { ...fenced(row), status: "cancelled", reason: null, resume_when: null, stop_intent: "cancel", ended_at: this.clock() };
		return { ...pause(row, "user_paused", "由你继续这个目标"), stop_intent: action satisfies StopIntent };
	}

	setBudget(id: string, input: unknown, operationId: string = randomUUID()) {
		const requested = budgetPatch(input);
		const changed = write(this.db, () => {
			const row = this.required(id), goal = toGoal(row);
			const next = requested === null ? null : { ...goal.budget, ...requested };
			const event = this.insertEvent(id, "budget.changed", `budget:${operationId}`, { budget: requested });
			if (event.handled_at !== null) return false;
			const patch: GoalPatch = { budget: next && json(next) };
			const reason = budgetReason(row.reason);
			if (row.status === "paused" && reason) {
				const key = BUDGET_FIELD[reason], settings = this.core.settings.get();
				const currentLimit = effectiveBudget(goal, settings)[key] ?? Infinity;
				const nextLimit = effectiveBudget({ ...goal, budget: next }, settings)[key] ?? Infinity;
				if (nextLimit > currentLimit) { patch.reason = null; patch.resume_when = "预算已调整，可以继续"; }
			}
			if (!compare(this.db, row, patch, this.clock())) return false;
			this.handled(event, row.lease_generation);
			return true;
		});
		if (changed) { this.changed(id); this.process(id); }
		return this.detail(id);
	}

	private insertEvent(goalId: string | null, kind: GoalEventKind, key: string, payload: object): EventRow {
		const body = json(payload);
		this.db.run(`INSERT INTO goal_events(id, goal_id, kind, dedupe_key, payload, created_at)
			VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`, randomUUID(), goalId, kind, key, body, this.clock());
		const row = this.db.get<EventRow>("SELECT * FROM goal_events WHERE dedupe_key=?", key)!;
		if (row.goal_id !== goalId || row.kind !== kind) throw new RpcError("conflict", "目标事件去重键已被使用");
		if ((kind === "user.control" || kind === "budget.changed") && row.payload !== body) throw new RpcError("conflict", "目标操作标识已被使用");
		return row;
	}

	private handled(event: EventRow, generation: number): void {
		this.db.run("UPDATE goal_events SET handled_at=?, handled_by_generation=? WHERE id=? AND handled_at IS NULL", this.clock(), generation, event.id);
	}

	post(goalId: string, kind: GoalEventKind, key: string, payload: object) {
		const row = this.insertEvent(goalId, kind, key, payload);
		if (["run.finished", "user.input", "budget.changed", "schedule.fired", "external.event", "job.finished"].includes(kind)) this.process(goalId);
		return toEvent(this.db.get<EventRow>("SELECT * FROM goal_events WHERE id=?", row.id)!);
	}

	private hasUserInput(id: string): boolean {
		return !!this.db.get("SELECT 1 FROM goal_events WHERE goal_id=? AND kind LIKE 'user.%' AND handled_at IS NULL LIMIT 1", id);
	}
	private idle(id: string): boolean {
		const tasks = this.db.all<{ id: string; session_file: string | null }>("SELECT id,session_file FROM tasks WHERE goal_id=?", id);
		return !this.core.sessionSlots().some(slot => {
			if (!slot.running && !slot.compacting && !(slot.started && slot.session.pendingMessageCount > 0)) return false;
			const file = slot.info().sessionFile;
			return tasks.some(task => task.id === slot.taskId || task.id === slot.currentRun?.taskId
				|| !!file && task.session_file?.toLowerCase() === file.toLowerCase());
		});
	}
	private hasWait(id: string): boolean { return this.waits.open(this.required(id)).length > 0; }

	registerWait(intent: IntentRow, request: WaitRequest): string {
		const line = write(this.db, () => {
			if (!this.isCurrent(intent, "running")) throw new RpcError("conflict", "这个执行已结束或修订");
			return this.waits.add(this.required(intent.goal_id), request, this.clock());
		});
		this.changed(intent.goal_id);
		return line;
	}
	jobChanged(id: string): void {
		const job = this.waits.job(id);
		if (!job) return;
		const row = this.row(job.goal_id);
		if (!row) return;
		if (job.status === "running") {
			if (!job.service && !row.stop_intent && !isTerminal(row.status) && row.revision === job.goal_revision) {
				write(this.db, () => this.waits.add(this.required(row.id), { kind: "compute", jobId: id }, this.clock()));
				this.changed(row.id);
				this.process(row.id);
			}
		} else this.post(row.id, "job.finished", `job:${id}`, { jobId: id, status: job.status, runId: job.owner_run_id, revision: job.goal_revision });
	}
	tickWaits(): void {
		for (const row of this.db.all<{ id: string }>(`SELECT id FROM goals WHERE stop_intent IS NULL
			AND (status='waiting_dependency' OR status='waiting_user' AND reason='needs_decision')`)) this.process(row.id);
	}
	userWaits() {
		return this.db.all<GoalRow>("SELECT * FROM goals WHERE status='waiting_user' AND reason='needs_decision' AND stop_intent IS NULL")
			.flatMap(row => this.waits.detail(row).filter(wait => wait.kind === "user").map(wait => ({ goal: toGoal(row), ...wait })));
	}
	openQuestionIds(): Set<string> {
		return new Set(this.db.all<{ id: string }>(`SELECT w.id FROM goal_waits w JOIN goals g ON g.id=w.goal_id
			WHERE w.kind='user' AND w.status='open' AND w.revision=g.revision AND g.stop_intent IS NULL
			AND (g.status IN ('running','queued') OR (g.status='waiting_user' AND g.reason='needs_decision'))`).map(row => row.id));
	}
	answerWait(id: string, waitId: string, answer: string): void {
		const changed = write(this.db, () => {
			const row = this.required(id);
			if (this.emergency() || !this.openQuestionIds().has(waitId) || !this.waits.open(row).some(wait => wait.id === waitId)) return false;
			if (!answer.trim()) {
				this.waits.settle(waitId, "cancelled", this.clock());
				return row.status !== "waiting_user" || compare(this.db, row, { status: "blocked", resume_when: "补充所需信息后继续" }, this.clock());
			}
			this.waits.settle(waitId, "resolved", this.clock());
			this.evidence(row, "user_feedback", null, { reason: answer.trim().slice(0, 4000) }, null);
			return row.status !== "waiting_user" || compare(this.db, row, { status: "queued", reason: null, resume_when: null }, this.clock());
		});
		if (changed) { this.changed(id); this.process(id); }
	}
	report(intent: IntentRow, runId: string, report: object): void {
		if (!this.isCurrent(intent, "running")) throw new RpcError("conflict", "这个执行已结束或修订");
		this.post(intent.goal_id, "goal.reported", `report:${runId}:${randomUUID()}`, { ...report, runId, revision: intent.revision });
	}
	latestReport(id: string, runId: string, revision: number): Record<string, unknown> | undefined {
		const row = this.db.get<{ payload: string }>(`SELECT payload FROM goal_events WHERE goal_id=? AND kind='goal.reported'
			AND json_extract(payload,'$.runId')=? AND json_extract(payload,'$.revision')=? ORDER BY rowid DESC LIMIT 1`, id, runId, revision);
		return row ? parseJson(row.payload, {}) : undefined;
	}

	private reconcileWaits(id: string): boolean {
		const changed = write(this.db, () => {
			const row = this.required(id);
			if (!["running", "queued", "reviewing", "waiting_dependency", "waiting_user"].includes(row.status)
				|| row.status === "waiting_user" && row.reason !== "needs_decision") return false;
			const { remaining, lost, expired } = this.waits.check(row, this.clock());
			const user = remaining.find(wait => wait.kind === "user");
			const first = user ?? remaining[0];
			const patch: GoalPatch | null = lost ? pause(row, "restart_check", `${LOST_JOB}：${lost.label ?? lost.ref}`)
				: expired ? { ...fenced(row), status: "blocked", reason: expired.kind === "compute" ? "waiting_job" : "waiting_event", resume_when: `等待超时：${expired.label ?? expired.ref}` }
				: first ? { status: user ? "waiting_user" : "waiting_dependency", reason: user ? "needs_decision" : first.kind === "external" ? "waiting_event" : this.waits.job(first.ref)?.kind === "subagent" ? "waiting_subagent" : "waiting_job",
					resume_when: first.label ?? first.ref }
				: row.status === "waiting_dependency" ? { status: "queued", reason: null, resume_when: null } : null;
			if (!patch || row.status === patch.status && row.reason === patch.reason && row.resume_when === patch.resume_when) return false;
			if (!compare(this.db, row, patch, this.clock())) return false;
			if (patch.status !== "queued") {
				this.db.run("UPDATE goal_intents SET status='done' WHERE goal_id=? AND action='run' AND status='started'", id);
				dropIntents(this.db, id, true);
				this.db.run("UPDATE goal_events SET handled_at=?,handled_by_generation=? WHERE goal_id=? AND handled_at IS NULL AND kind='run.finished'",
					this.clock(), row.lease_generation, id);
			}
			return true;
		});
		if (changed) this.changed(id);
		return this.hasWait(id);
	}

	private lease(id: string): GoalRow | undefined {
		return write(this.db, () => {
			const row = this.row(id), at = this.clock();
			if (!row || row.stop_intent || isTerminal(row.status) || this.emergency()) return undefined;
			if (row.lease_owner === this.owner && (row.lease_until ?? 0) > at) return row;
			if (row.lease_owner !== this.owner && (row.lease_until ?? 0) > at) return undefined;
			const generation = row.lease_generation + Number(row.lease_owner !== this.owner);
			if (!compare(this.db, row, { lease_owner: this.owner, lease_generation: generation, lease_until: at + LEASE_MS }, at)) return undefined;
			if (generation !== row.lease_generation) dropIntents(this.db, row.id, true);
			return this.row(id);
		});
	}

	process(id: string): void {
		if (this.core.maintenance) return;
		const row = this.row(id);
		if (!row) return;
		if (row.stop_intent || isTerminal(row.status) || row.status === "paused" || this.emergency()) {
			this.db.run(`UPDATE goal_events SET handled_at=?, handled_by_generation=? WHERE goal_id=?
				AND kind IN ('run.finished','schedule.fired') AND handled_at IS NULL`, this.clock(), row.lease_generation, id);
			return;
		}
		if (this.hasUserInput(id)) { dropIntents(this.db, id); return; }
		if (!this.idle(id)) return;
		if (this.reconcileWaits(id)) return;
		const status = this.required(id).status;
		if (status === "paused" || status === "waiting_user" || status === "blocked") return;
		const leased = this.lease(id);
		if (!leased) return;
		const events = this.db.all<EventRow>(`SELECT * FROM goal_events WHERE goal_id=? AND kind IN ('run.finished','budget.changed','schedule.fired','external.event','job.finished')
			AND handled_at IS NULL ORDER BY created_at, rowid`, id);
		for (const event of events) {
			const current = this.required(id);
			if (current.lease_owner !== this.owner || current.stop_intent) return;
			if (event.kind === "budget.changed") { this.handled(event, current.lease_generation); continue; }
			if (event.kind === "schedule.fired" || event.kind === "external.event" || event.kind === "job.finished") {
				// A schedule can wake a queued goal, never revive a stopped or terminal one.
				this.handled(event, current.lease_generation);
				continue;
			}
			const run = parseJson<RunFinished | null>(event.payload, null);
			if (!run || run.revision !== current.revision || run.generation !== current.lease_generation || !["queued", "running"].includes(current.status)) {
				this.handled(event, current.lease_generation);
				continue;
			}
			const goal = toGoal(current);
			const managed = !!this.db.get("SELECT 1 FROM goal_intents WHERE goal_id=? AND action='run' AND status='started' AND run_id=?", id, run.runId);
			if (current.status === "running" && !managed) {
				this.handled(event, current.lease_generation);
				continue;
			}
			const runRecord = managed && run.status === "failed" ? this.core.runs.get(run.runId) : undefined;
			const channel = runRecord ? goalChannelFailure(runRecord.error, this.db, runRecord) : null;
			const limit = managed ? this.turnBudgetReason(current) : exhausted(this.ledger.view(goal));
			const prepFailed = managed && run.status === "failed" && !this.ledger.hasRequest(run.runId);
			const hasSteps = !managed && !limit && run.status === "done" && this.hasProgramSteps(goal);
			const canContinue = hasSteps && !run.reportedComplete;
			const status = channel || limit ? "paused" : prepFailed ? "failed" : managed ? "reviewing" : run.status !== "done" ? "failed" : canContinue ? "queued" : "reviewing";
			if (!this.commitRun(current, event, run, status, limit, managed, prepFailed, channel)) return;
		}
		const current = this.required(id);
		if (current.status === "queued" && current.lease_owner === this.owner && !current.stop_intent && ready(toGoal(current))) {
			this.queue(current);
		}
	}

	private commitRun(row: GoalRow, event: EventRow, run: RunFinished, status: GoalStatus, limit: BudgetReason | null, managed: boolean, prepFailed: boolean, channel: ChannelFailure | null): boolean {
		const committed = write(this.db, () => {
			if (!this.stillIdle(row.id) || this.db.get<{ handled_at: number | null }>("SELECT handled_at FROM goal_events WHERE id=?", event.id)?.handled_at !== null) return false;
			const at = this.clock();
			if ((row.lease_until ?? 0) <= at) return false;
			const fresh = this.required(row.id);
			// Costs can change while the read-only program check runs. Re-evaluate before committing.
			const currentLimit = limit ?? (managed ? this.turnBudgetReason(fresh) : exhausted(this.ledger.view(toGoal(fresh))));
			const patch: GoalPatch = channel ? pause(row, "channel_unavailable", channel.detail)
				: currentLimit ? pause(row, currentLimit, "放宽目标预算后继续") : {
				status, reason: prepFailed ? "prep_failed" : status === "failed" ? "run_failed" : null,
				resume_when: prepFailed ? redact(this.core.runs.get(run.runId)?.error ?? "模型请求未发出", true) : null,
				ended_at: status === "failed" ? at : null,
			};
			if (!compare(this.db, row, { ...patch, current_task_id: run.taskId }, at)) return false;
			if (channel?.permanent) this.db.run("UPDATE goal_intents SET reason='channel_unavailable' WHERE goal_id=? AND action='run' AND status='started' AND run_id=?", row.id, run.runId);
			else if (prepFailed) this.ledger.markUnsentRun(row.id, row.lease_generation, "prep_failed");
			this.db.run("UPDATE goal_intents SET status='done' WHERE goal_id=? AND revision=? AND generation=? AND status='started'",
				row.id, row.revision, row.lease_generation);
			if (status === "queued" && !currentLimit) this.insertIntent(row, "run.finished");
			else {
				dropIntents(this.db, row.id);
				if (status === "reviewing" && !currentLimit
					&& (managed || this.db.get("SELECT 1 FROM runs WHERE id=? AND task_id=?", run.runId, run.taskId))) this.insertReview(row, run.runId);
			}
			this.handled(event, row.lease_generation);
			return true;
		});
		if (committed) this.changed(row.id);
		return committed;
	}

	private stillIdle(id: string): boolean {
		if (this.emergency() || this.core.maintenance || !this.idle(id) || this.hasWait(id)) return false;
		if (this.hasUserInput(id)) { dropIntents(this.db, id); return false; }
		return true;
	}

	private queue(row: GoalRow): void {
		const changed = write(this.db, () => {
			if (!this.stillIdle(row.id)) return false;
			const limit = exhausted(this.ledger.view(toGoal(this.required(row.id))), false);
			if (limit) return this.pauseBudget(row, limit);
			if (this.openIntent(row.id)) return false;
			if (!compare(this.db, row, { lease_until: this.clock() + LEASE_MS }, this.clock())) return false;
			this.insertIntent(row, "ready");
			return true;
		});
		if (changed) this.changed(row.id);
	}

	private openIntent(id: string) {
		return this.db.get("SELECT 1 FROM goal_intents WHERE goal_id=? AND action='run' AND status IN ('pending','started')", id);
	}
	pendingIntents(): IntentRow[] {
		return this.db.all<IntentRow>("SELECT * FROM goal_intents WHERE status='pending' ORDER BY created_at,rowid");
	}
	private insertReview(row: GoalRow, runId: string): void {
		this.db.run(`INSERT INTO goal_intents(id,goal_id,revision,generation,idem_key,action,status,reason,created_at,run_id)
			VALUES(?, ?, ?, ?, ?, 'review','pending','program', ?, ?) ON CONFLICT(idem_key) DO NOTHING`,
			randomUUID(), row.id, row.revision, row.lease_generation, `review:${runId}`, this.clock(), runId);
	}
	private enqueueNotification(row: GoalRow): void {
		const notice = goalNotice(row);
		if (!notice) return;
		const inserted = this.db.run(`INSERT INTO goal_intents(id,goal_id,revision,generation,idem_key,action,status,reason,created_at)
			VALUES(?, ?, ?, ?, ?, 'notify','pending',?, ?) ON CONFLICT(idem_key) DO NOTHING`,
			randomUUID(), row.id, row.revision, row.lease_generation, notice.key, notice.kind, this.clock());
		if (inserted.changes && !goalNoticeReceipt(this.db, notice.key)) {
			recordGoalNotice(this.db, row.id, notice.key, "goal", notificationQueueState(this.core), this.clock());
		}
	}
	mutePendingNotifications(): void {
		for (const intent of this.db.all<IntentRow>(`SELECT * FROM goal_intents i WHERE action='notify' AND (status='pending'
			OR (status='done' AND reason='decision' AND EXISTS(SELECT 1 FROM goals g WHERE g.id=i.goal_id
				AND g.status='waiting_user' AND g.revision=i.revision AND g.lease_generation=i.generation)))`)) {
			const receipt = goalNoticeReceipt(this.db, intent.idem_key);
			if (!receipt && intent.status === "pending" || receipt?.sender === "goal" && receipt.state === "queued") {
				recordGoalNotice(this.db, intent.goal_id, intent.idem_key, "goal", "muted", this.clock());
			}
		}
	}
	questionNotification<T>(goalId: string, slotId: string, open: () => T): T {
		const row = this.required(goalId);
		const notice = goalNotice(row);
		if (notice?.kind !== "decision" || !toGoal(row).scope.sandbox) return open();
		const prior = goalNoticeReceipt(this.db, notice.key);
		const muted = prior?.state === "muted" || notificationQueueState(this.core) === "muted";
		const report = (state: NotificationState) => {
			if (prior?.state !== "sent") recordGoalNotice(this.db, row.id, notice.key, "goal", state, this.clock());
		};
		return this.core.notifications.withSlotDelivery(slotId, muted || prior?.state === "sent", report, open);
	}
	takeNotification(intent: IntentRow) {
		return write(this.db, () => {
			const row = this.required(intent.goal_id);
			if (this.emergency()) return null;
			const notice = goalNotice(row);
			const valid = notice?.key === intent.idem_key;
			const updated = this.db.run("UPDATE goal_intents SET status=?,started_at=? WHERE id=? AND status='pending'", valid ? "done" : "dropped", this.clock(), intent.id);
			if (!updated.changes || !valid) return null;
			const goal = toGoal(row);
			const prior = goalNoticeReceipt(this.db, notice.key);
			if (prior && (prior.state !== "queued" || prior.sender !== "goal")) return null;
			if (notificationQueueState(this.core) === "muted") {
				recordGoalNotice(this.db, row.id, notice.key, "goal", "muted", this.clock());
				return null;
			}
			// Existing task notices and butterfly question dialogs already deliver these prompts.
			if (notice.kind === "budget" && this.db.get(`SELECT 1 FROM notices WHERE goal_id=? AND kind='goal_budget'
				AND created_at>=? LIMIT 1`, row.id, intent.created_at)) {
				recordGoalNotice(this.db, row.id, notice.key, "goal", "failed", this.clock(), "任务已接管提醒，无法确认系统送达");
				return null;
			}
			recordGoalNotice(this.db, row.id, notice.key, "goal", "queued", this.clock());
			if (notice.kind === "decision" && goal.scope.sandbox && this.waits.open(row).some(wait => wait.kind === "user")
				&& (goal.sessionFile || this.db.get("SELECT 1 FROM tasks WHERE id=? AND session_file IS NOT NULL", row.current_task_id))) return null;
			return { goal, key: notice.key, title: GOAL_NOTICE_TITLES[notice.kind] };
		});
	}
	private insertIntent(row: GoalRow, reason: string): void {
		if (this.openIntent(row.id)) return;
		const sequence = this.db.get<{ count: number }>("SELECT count(*) count FROM goal_intents WHERE goal_id=? AND revision=? AND generation=?",
			row.id, row.revision, row.lease_generation)!.count + 1;
		const key = `${row.id}:${row.revision}:${row.lease_generation}:${sequence}`;
		this.db.run(`INSERT INTO goal_intents(id,goal_id,revision,generation,idem_key,action,status,reason,created_at)
			VALUES(?, ?, ?, ?, ?, 'run', 'pending', ?, ?) ON CONFLICT(idem_key) DO NOTHING`,
			randomUUID(), row.id, row.revision, row.lease_generation, key, reason, this.clock());
	}

	/** Claiming only changes persisted intent state. */
	claimIntent(intentId: string, authorize: (goal: Readonly<Goal>) => boolean) {
		const intent = this.db.get<IntentRow>("SELECT * FROM goal_intents WHERE id=? AND status='pending' AND action='run'", intentId);
		if (!intent) return null;
		const row = this.required(intent.goal_id);
		if (row.status !== "queued" || row.stop_intent || row.lease_owner !== this.owner
			|| row.revision !== intent.revision || row.lease_generation !== intent.generation || !this.stillIdle(row.id)) return null;
		const goal = toGoal(row);
		const allowed = validMandate(goal.source, goal.mandateRef) && authorize(goal);
		let changed = false;
		const result = write(this.db, () => {
			if (!this.stillIdle(row.id)) return null;
			const fresh = this.required(row.id);
			const limit = exhausted(this.ledger.view(toGoal(fresh)), false);
			if (limit) { changed = this.pauseBudget(row, limit); return null; }
			if (this.ledger.view(toGoal(fresh)).remaining.parallel <= 0) return null;
			if (!allowed) {
				changed = compare(this.db, row, { ...fenced(row), status: "waiting_user", reason: "needs_permission", resume_when: "核对目标授权后继续" }, this.clock());
				if (changed) dropIntents(this.db, row.id);
				return null;
			}
			const at = this.clock();
			if (!this.db.get("SELECT 1 FROM goal_intents WHERE id=? AND status='pending'", intentId)
				|| !compare(this.db, row, { lease_until: at + LEASE_MS }, at)) return null;
			const claimed = this.db.run("UPDATE goal_intents SET status='started', started_at=? WHERE id=? AND status='pending' AND revision=? AND generation=?",
				at, intentId, row.revision, row.lease_generation);
			return claimed.changes ? toIntent(this.db.get<IntentRow>("SELECT * FROM goal_intents WHERE id=?", intentId)!) : null;
		});
		if (changed) this.changed(row.id);
		return result;
	}

	private validClaim(intent: IntentRow, row: GoalRow, expectedStatus: GoalStatus): boolean {
		return !this.emergency() && !this.core.maintenance && !row.stop_intent && row.status === expectedStatus
			&& row.revision === intent.revision && row.lease_generation === intent.generation && row.lease_owner === this.owner;
	}

	retryClaim(intent: IntentRow): void {
		const row = this.required(intent.goal_id);
		const pending = this.validClaim(intent, row, "queued");
		this.db.run("UPDATE goal_intents SET status=?,started_at=NULL WHERE id=? AND status='started' AND run_id IS NULL",
			pending ? "pending" : "dropped", intent.id);
	}

	beginRun(intent: IntentRow, taskId: string, authorize: (goal: Goal) => boolean): Goal | null {
		const snapshot = this.required(intent.goal_id);
		if (!this.validClaim(intent, snapshot, "queued") || !authorize(toGoal(snapshot))) return null;
		const changed = write(this.db, () => {
			const row = this.required(intent.goal_id);
			if (!this.validClaim(intent, row, "queued") || !this.stillIdle(row.id) || row.scope !== snapshot.scope
				|| !this.db.get("SELECT 1 FROM goal_intents WHERE id=? AND status='started' AND run_id IS NULL", intent.id)
				|| !this.db.get("SELECT 1 FROM tasks WHERE id=? AND goal_id=?", taskId, row.id)) return false;
			return compare(this.db, row, { status: "running", current_task_id: taskId, lease_until: this.clock() + LEASE_MS }, this.clock());
		});
		if (changed) this.changed(intent.goal_id);
		return changed ? this.get(intent.goal_id)! : null;
	}

	bindRun(intent: IntentRow, runId: string): boolean {
		const row = this.required(intent.goal_id);
		if (!this.validClaim(intent, row, "running")) return false;
		return !!this.db.run("UPDATE goal_intents SET run_id=? WHERE id=? AND status='started' AND run_id IS NULL", runId, intent.id).changes;
	}

	isCurrent(intent: IntentRow, status: "running" | "reviewing"): boolean {
		const row = this.row(intent.goal_id);
		return !!row && this.validClaim(intent, row, status) && !!this.db.get("SELECT 1 FROM goal_intents WHERE id=? AND status='started'", intent.id);
	}

	abandon(intent: IntentRow, failure?: string): void {
		const changed = write(this.db, () => {
			const row = this.required(intent.goal_id);
			const failed = failure && this.validClaim(intent, row, row.status) && ["queued", "running", "reviewing"].includes(row.status);
			if (failed && intent.action === "run") this.ledger.markUnsentRun(row.id, row.lease_generation, "prep_failed");
			this.db.run("UPDATE goal_intents SET status='dropped' WHERE id=? AND status='started'", intent.id);
			if (!failure || !failed) return false;
			return compare(this.db, row, {
				...fenced(row), status: "failed", reason: "prep_failed", resume_when: redact(failure, true), ended_at: this.clock(),
			}, this.clock());
		});
		if (changed) this.changed(intent.goal_id);
	}

	claimReview(intent: IntentRow): Goal | null {
		return write(this.db, () => {
			const row = this.required(intent.goal_id);
			if (!this.validClaim(intent, row, "reviewing") || !this.stillIdle(row.id)) return null;
			const claimed = this.db.run("UPDATE goal_intents SET status='started',started_at=? WHERE id=? AND status='pending'", this.clock(), intent.id);
			return claimed.changes ? toGoal(row) : null;
		});
	}

	private evidenceVersion(id: string): number {
		return this.db.get<{ version: number }>("SELECT COALESCE(MAX(version),0) version FROM goal_evidence WHERE goal_id=?", id)!.version;
	}
	private evidence(row: GoalRow, kind: string, ref: string | null, detail: object, runId: string | null): number {
		const version = this.evidenceVersion(row.id) + 1;
		this.db.run(`INSERT INTO goal_evidence(id,goal_id,task_id,run_id,kind,ref,detail,version,created_at)
			VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), row.id, row.current_task_id, runId, kind, ref,
			json({ ...detail, revision: row.revision }), version, this.clock());
		return version;
	}
	recordTool(intent: IntentRow, runId: string, receipt: ToolReceipt, effect?: string): void {
		write(this.db, () => {
			const row = this.required(intent.goal_id);
			if (this.validClaim(intent, row, "running")) this.evidence(row, "tool_receipt", receipt.id, receipt, runId);
			// A stopped or superseded run can still have completed an external action.
			if (effect) this.evidence({ ...row, revision: intent.revision }, "effect", receipt.id, { tool: receipt.tool, description: effect, confirmed: receipt.ok }, runId);
		});
	}
	receipts(id: string, revision: number): ToolReceipt[] {
		return this.db.all<{ detail: string }>("SELECT detail FROM goal_evidence WHERE goal_id=? AND kind='tool_receipt' AND json_extract(detail,'$.revision')=? ORDER BY version", id, revision)
			.map(row => parseJson<ToolReceipt>(row.detail, { id: "", tool: "", ok: false }));
	}
	feedback(id: string, revision: number): string | null {
		const row = this.db.get<{ reason: string }>(`SELECT json_extract(detail,'$.reason') reason FROM goal_evidence
			WHERE goal_id=? AND kind='user_feedback' AND json_extract(detail,'$.revision')=? ORDER BY version DESC LIMIT 1`, id, revision);
		return row?.reason ?? null;
	}
	lastReviewAdvice(id: string, revision: number): string | null {
		const row = this.db.get<{ next: string }>(`SELECT json_extract(reasons,'$.next') AS next FROM goal_reviews
			WHERE goal_id=? AND revision=? AND layer='model' ORDER BY created_at DESC,rowid DESC LIMIT 1`, id, revision);
		return row?.next ?? null;
	}
	latestProgram(id: string, revision: number): ProgramReport | null {
		const row = this.db.get<{ detail: string }>(`SELECT detail FROM goal_evidence
			WHERE goal_id=? AND kind='program' AND json_extract(detail,'$.revision')=? ORDER BY version DESC LIMIT 1`, id, revision);
		return parseJson(row?.detail, null);
	}

	finishProgram(intent: IntentRow, report: ProgramReport, run: { id: string; status: string; error: string | null }, receipts: ToolReceipt[], reportedComplete: boolean) {
		const result = write(this.db, () => {
			const row = this.required(intent.goal_id);
			if (!this.validClaim(intent, row, "reviewing") || !this.isCurrent(intent, "reviewing")) return null;
			const missing = report.checks.filter(check => check.status !== "passed");
			const previous = parseJson<{ fingerprint?: string; stall?: number; rerouted?: boolean; lastProgressAt?: number }>(row.progress, {});
			const error = run.error?.replace(/\b\d+\b/g, "#").replace(/\s+/g, " ").slice(0, 500) ?? null;
			const fingerprint = createHash("sha256").update(json({
				checks: report.checks.map(check => [check.id, check.status]),
				files: report.files.map(file => [file.path, file.sha256, file.size]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
				error, receipts: [...new Set(receipts.filter(receipt => receipt.command).map(receipt => `${receipt.command}:${receipt.exitCode}`))].sort(),
			})).digest("hex");
			const same = previous.fingerprint === fingerprint;
			const stall = same ? (previous.stall ?? 0) + 1 : 0;
			const blocked = same && previous.rerouted === true && stall > 2;
			const rerouted = same && stall >= 2;
			const diagnosis = error ? "同一错误反复出现" : receipts.some(receipt => ["read", "grep", "glob"].includes(receipt.tool))
				? "反复读取材料，验收项和产物没有变化" : "反复规划，验收项和产物没有变化";
			const lastFiles = new Map(this.latestProgram(row.id, row.revision)?.files.map(file => [file.path, file.sha256]));
			const revised = report.files.some(file => file.artifact && file.sha256 && file.sha256 !== lastFiles.get(file.path));
			const review = !blocked && run.status === "done" && missing.length === 0 && (reportedComplete || revised);
			const nextStatus = blocked ? "blocked" : review ? "reviewing" : "queued";
			const progress = { fingerprint, stall, rerouted, lastProgressAt: same ? previous.lastProgressAt : this.clock() };
			if (!compare(this.db, row, {
				status: nextStatus, progress: json(progress), reason: blocked ? "stalled" : null, resume_when: blocked ? diagnosis : null,
			}, this.clock())) return null;
			const version = this.evidence(row, "program", null, report, run.id);
			this.recordReview(row, version, "program", missing.length ? "continue" : "done", missing.map(check => check.id), { checks: report.checks }, null, 0);
			if (!review) {
				this.db.run("UPDATE goal_intents SET status='done' WHERE id=? AND status='started'", intent.id);
				if (!blocked) this.insertIntent(row, rerouted ? "reroute" : "program");
			}
			return { review, version };
		});
		if (result) this.changed(intent.goal_id);
		return result;
	}

	private recordReview(row: GoalRow, version: number, layer: ReviewRow["layer"], verdict: string, missing: string[], reasons: object, model: string | null, cost: number): string {
		const id = randomUUID();
		this.db.run(`INSERT INTO goal_reviews(id,goal_id,revision,evidence_version,layer,verdict,missing,reasons,model,cost,created_at)
			VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, row.id, row.revision, version, layer, verdict, json(missing), json(reasons), model, cost, this.clock());
		return id;
	}
	finishReview(intent: IntentRow, version: number, verdict: ReviewVerdict | null, model: string | null, cost: number, channel: ChannelFailure | null = null): boolean {
		const changed = write(this.db, () => {
			const row = this.required(intent.goal_id);
			if (!this.validClaim(intent, row, "reviewing") || !this.isCurrent(intent, "reviewing") || this.evidenceVersion(row.id) !== version
				|| verdict && (verdict.revision !== row.revision || verdict.evidence_version !== version)) return false;
			const goal = toGoal(row), at = this.clock();
			let status: GoalStatus, reason: GoalReason | null = null, resumeWhen: string | null = null;
			switch (verdict?.verdict) {
				case "done":
					if (verdict.missing.length) { status = "queued"; break; }
					status = goal.spec.acceptance.some(check => check.layer === "user") ? "waiting_user" : "completed";
					if (status === "waiting_user") { reason = "acceptance"; resumeWhen = "等你验收产物"; }
					break;
				case "continue": status = "queued"; break;
				case "wait": {
					if (verdict.wait) this.waits.add(row, verdict.wait, at);
					status = "queued";
					break;
				}
				case "blocked": status = "blocked"; reason = "prep_failed"; resumeWhen = verdict.next || "补齐验收条件后继续"; break;
				case "needs_user": {
					const questions = verdict.questions.length ? verdict.questions : verdict.next ? [verdict.next] : [];
					if (questions.length) this.waits.add(row, { kind: "user", questions }, at);
					status = questions.length ? "queued" : "blocked"; reason = questions.length ? null : "needs_decision";
					break;
				}
				default:
					status = channel ? "paused" : "blocked";
					reason = channel ? "channel_unavailable" : "review_unparsable";
					resumeWhen = channel?.detail ?? "审查结果无法读取";
			}
			const reviewId = this.recordReview(row, version, "model", verdict?.verdict === "done" && verdict.missing.length ? "continue" : verdict?.verdict ?? (channel ? "channel_unavailable" : "unparsable"),
				verdict?.missing ?? [], { next: verdict?.next ?? channel?.detail ?? null, questions: verdict?.questions ?? [] }, model, cost);
			if (!compare(this.db, row, {
				...(channel ? fenced(row) : {}), status, reason, resume_when: resumeWhen, latest_review_id: reviewId, ended_at: status === "completed" ? at : null,
			}, at)) throw new RpcError("version_conflict", "审查结论已过期");
			const event = this.insertEvent(row.id, "review.done", `review:${reviewId}`, { reviewId, revision: row.revision, evidenceVersion: version });
			this.handled(event, row.lease_generation);
			this.db.run("UPDATE goal_intents SET status='done' WHERE id=? AND status='started'", intent.id);
			if (status === "queued") this.insertIntent(row, parseJson<{ rerouted?: boolean }>(row.progress, {}).rerouted ? "reroute" : "review");
			if (status === "waiting_user" && reason === "acceptance") this.approval(row, "acceptance", { reviewId, evidenceVersion: version });
			if (status === "completed") this.enqueueNotification(row);
			return true;
		});
		if (changed) { this.changed(intent.goal_id); this.process(intent.goal_id); }
		return changed;
	}

	private pauseBudget(row: GoalRow, reason: BudgetReason, detail = "放宽目标预算后继续"): boolean {
		if (row.stop_intent || isTerminal(row.status) || row.status === "paused") return false;
		if (!compare(this.db, row, pause(row, reason, detail), this.clock())) return false;
		this.ledger.markUnsentRun(row.id, row.lease_generation, "budget_denied");
		dropIntents(this.db, row.id);
		return true;
	}

	reserve(id: string, requested: Reservation, finishing?: IntentRow, normal?: NormalRequest) {
		let input = requested;
		validateReservation(input);
		const normalInput = normal && { ...input, ...normal };
		if (normalInput) validateReservation(normalInput);
		let paused = false;
		const result = write(this.db, () => {
			const row = this.required(id);
			const pausedRun = !!finishing && row.status === "paused" && row.stop_intent === "pause"
				&& row.revision === finishing.revision && !!input.runId
				&& !!this.db.get("SELECT 1 FROM goal_intents WHERE id=? AND goal_id=? AND action='run' AND run_id=?", finishing.id, id, input.runId);
			const available = !this.emergency() && !this.core.maintenance
				&& (pausedRun || !row.stop_intent && ["queued", "running", "reviewing"].includes(row.status));
			const prior = this.ledger.get(input.id);
			if (prior) {
				if (normalInput && prior.est_output_tokens === normalInput.outputTokens && prior.est_cost === normalInput.costUsd) input = normalInput;
				if (prior.goal_id !== id || prior.kind !== input.kind || prior.run_id !== (input.runId ?? null)
					|| prior.task_id !== (input.taskId ?? null) || prior.est_cost !== input.costUsd || !!prior.cost_unknown !== !!input.costUnknown
					|| prior.est_input_tokens !== (input.inputTokens ?? 0) || prior.est_output_tokens !== (input.outputTokens ?? 0)
					|| prior.est_active_ms !== (input.activeMs ?? 0) || (input.requestId && prior.request_id !== input.requestId)) {
					throw new RpcError("conflict", "预留标识已被另一笔预算使用");
				}
				return prior.state === "reserved" && available
					? { ok: true as const, entry: chargeView(prior) }
					: { ok: false as const, reason: budgetReason(row.reason) ?? "unavailable" as const };
			}
			if (!available) {
				return { ok: false as const, reason: budgetReason(row.reason) ?? "unavailable" as const };
			}
			const goal = toGoal(row);
			let reason = this.ledger.wouldExceed(goal, input);
			if (reason === "budget_cost" && normalInput) {
				input = normalInput;
				reason = this.ledger.wouldExceed(goal, input);
			}
			if (reason) {
				const detail = reason === "budget_cost" ? costDenial(this.ledger.view(goal).remaining.costUsd, input.costUsd) : undefined;
				if (reason !== "concurrency") paused = this.pauseBudget(row, reason, detail);
				return { ok: false as const, reason };
			}
			return { ok: true as const, entry: this.ledger.reserve(id, input, this.clock()) };
		});
		if (paused || result.ok) this.changed(id);
		return result;
	}

	settle(id: string, requestId: string, fallback?: SettlementEstimate) {
		const result = write(this.db, () => {
			const entry = this.ledger.settle(id, requestId, this.clock(), fallback);
			const row = this.required(entry.goalId);
			const view = this.ledger.view(toGoal(row));
			const reason = !entry.costUnknown && view.used.costUsd > view.limits.maxCostUsd + 1e-9 ? "budget_cost" : this.turnBudgetReason(row);
			if (reason) this.pauseBudget(row, reason);
			return entry;
		});
		this.changed(result.goalId);
		return result;
	}
	release(id: string) {
		const result = write(this.db, () => this.ledger.release(id, this.clock()));
		this.changed(result.goalId);
		return result;
	}
	enforceBudget(id: string): BudgetReason | null {
		let paused = false;
		const reason = write(this.db, () => {
			const row = this.required(id);
			if (row.status === "paused") return budgetReason(row.reason);
			const limit = this.turnBudgetReason(row);
			if (limit) paused = this.pauseBudget(row, limit);
			return limit;
		});
		if (paused) this.changed(id);
		return reason;
	}

	private turnBudgetReason(row: GoalRow): BudgetReason | null {
		const view = this.ledger.view(toGoal(row));
		// A run counted at its first reservation may finish within the other limits.
		return exhausted({ ...view, remaining: { ...view.remaining, runs: 1 } }, false);
	}

	recover(): void {
		write(this.db, () => {
			const at = this.clock();
			this.ledger.recover(at);
			recoverGoalNotices(this.db, at);
			for (const row of this.db.all<GoalRow>(`SELECT * FROM goals g WHERE g.status NOT IN ('completed','failed','cancelled')
				AND (g.status IN ('running','reviewing','waiting_dependency','waiting_user')
					OR EXISTS (SELECT 1 FROM goal_intents i WHERE i.goal_id=g.id AND i.action<>'notify' AND i.status IN ('pending','started'))
					OR EXISTS (SELECT 1 FROM goal_ledger l WHERE l.goal_id=g.id AND l.state='reserved'))`)) {
				const waiting = this.waits.open(row);
				if (!row.stop_intent && row.status === "waiting_dependency" && waiting.length
					&& waiting.every(wait => wait.kind === "compute" && this.waits.job(wait.ref)?.status === "running")) {
					if (compare(this.db, row, fenced(row), at)) dropIntents(this.db, row.id, true);
					continue;
				}
				const lost = waiting.find(wait => wait.kind === "compute" && ["lost", "cancelled", undefined].includes(this.waits.job(wait.ref)?.status));
				const patch = row.stop_intent || row.status === "paused" ? fenced(row)
					: pause(row, "restart_check", lost ? `${LOST_JOB}：${lost.label ?? lost.ref}` : "核对上次执行和预算后继续");
				if (compare(this.db, row, patch, at)) {
					dropIntents(this.db, row.id, true);
					this.dropApprovals(row.id);
					if (lost) this.waits.settle(lost.id, "cancelled", at);
					this.db.run("UPDATE goal_events SET handled_at=? WHERE goal_id=? AND kind='user.input' AND handled_at IS NULL", at, row.id);
				}
			}
		});
	}
}

function budgetReason(value: GoalReason | null): BudgetReason | null {
	return value && Object.hasOwn(BUDGET_FIELD, value) ? value as BudgetReason : null;
}

function limit(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) ? Math.max(1, Math.min(value, 500)) : 100;
}

export class GoalsModule implements CoreModule {
	private readonly core: Core;
	readonly scheduler: GoalScheduler;
	readonly executor: GoalExecutor;
	private unsubscribe?: () => void;
	private unlistenSettings?: () => void;
	constructor(core: Core) {
		this.core = core;
		const scheduler = this.scheduler = new GoalScheduler(core);
		this.executor = new GoalExecutor(core, scheduler);
		core.declareBackup({
			id: "goals", title: "目标、修订、事件、续跑意图和目标账本",
			tables: ["goals", "goal_revisions", "goal_events", "goal_intents", "goal_waits", "goal_evidence", "goal_reviews", "goal_ledger", "goal_approvals", "goal_proposals"],
			paths: {
				goals: { scope: "json", spec: "json", session_file: "path" }, goal_revisions: { scope: "json", spec: "json" },
				goal_events: { payload: "json" }, goal_evidence: { ref: "path", detail: "json" },
				goal_approvals: { payload: "json" },
				goal_proposals: { session_file: "path", draft: "json" },
			},
			onStage: stageImported,
		});
		core.register("goals.list", p => {
			const status = GOAL_STATUSES.find(status => status === p.status);
			if (p.status !== undefined && !status) throw new RpcError("bad_request", "目标状态无效");
			const view = GOAL_VIEWS.find(view => view === p.view);
			if (p.view !== undefined && !view) throw new RpcError("bad_request", "目标视图无效");
			const partition = p.partition === "workbench" || p.partition === "butterfly" ? p.partition : undefined;
			if (p.partition !== undefined && !partition) throw new RpcError("bad_request", "目标归属无效");
			return scheduler.list(status, limit(p.limit), view, partition);
		});
		core.register("goals.counts", () => scheduler.views.counts());
		core.register("goals.get", p => scheduler.detail(requireStr(p.id, "id")));
		core.register("goals.create", p => scheduler.create(p));
		core.register("goals.update", p => scheduler.update(requireStr(p.id, "id"), p));
		core.register("goals.control", p => {
			const action = CONTROLS.find(action => action === p.action);
			if (!action) throw new RpcError("bad_request", "目标操作无效");
			return scheduler.control(str(p.id), action, str(p.operationId));
		});
		core.register("goals.budget", p => p.budget === undefined
			? scheduler.detail(requireStr(p.id, "id")).budgetStatus
			: scheduler.setBudget(requireStr(p.id, "id"), p.budget, str(p.operationId)));
		core.register("goals.ledger", p => {
			const id = requireStr(p.id, "id");
			if (!scheduler.get(id)) throw new RpcError("not_found", "没有这个目标");
			return scheduler.ledger.entries(id, limit(p.limit));
		});
		core.register("goals.history", p => scheduler.history(requireStr(p.id, "id")));
		core.register("goals.approvals", () => scheduler.pendingApprovals());
		core.register("goals.accept", p => scheduler.resolveApproval(requireStr(p.id, "id"), true));
		core.register("goals.reject", p => scheduler.resolveApproval(requireStr(p.id, "id"), false, str(p.reason)));
		core.register("goals.signal", p => {
			const id = requireStr(p.id, "id");
			if (!scheduler.get(id)) throw new RpcError("not_found", "没有这个目标");
			return scheduler.post(id, "external.event", `external:${id}:${requireStr(p.eventId, "eventId")}`, { ref: requireStr(p.ref, "ref") });
		});
		core.register("goals.proposals", () => this.executor.proposals.pending());
		core.register("goals.proposals.resolve", p => {
			if (p.action !== "accept" && p.action !== "edit" && p.action !== "reject") throw new RpcError("bad_request", "目标提议操作无效");
			return this.executor.proposals.resolve(requireStr(p.id, "id"), p.action, p.draft);
		});
	}
	start(): void {
		this.scheduler.recover();
		if (notificationQueueState(this.core) === "muted") this.scheduler.mutePendingNotifications();
		this.unlistenSettings = this.core.settings.onChange((settings, changed) => {
			if (!settings.notifications && changed.includes("notifications")) this.scheduler.mutePendingNotifications();
		});
		this.unsubscribe = this.core.onBroadcast(message => {
			if (message.event === "jobs.changed" && typeof message.goalId === "string" && typeof message.id === "string") this.scheduler.jobChanged(message.id);
		});
		this.executor.start();
	}
	stop(): void { this.unsubscribe?.(); this.unlistenSettings?.(); this.executor.stop(); }
	extensions(slot: { slotId: string; sideConversation?: boolean }): ExtensionFactory[] {
		return slot.sideConversation ? [] : this.executor.extensions(slot.slotId);
	}
	onRunStarted(slot: Slot, run: Run): void { this.executor.onRunStarted(slot, run); }
	onSlotEvent(slot: Slot, event: AgentSessionEvent): void { this.executor.onSlotEvent(slot, event); }
	toolPolicy(slot: Slot, tool: string): "allow" | "deny" | undefined { return this.executor.toolPolicy(slot.slotId, tool); }
	onSlotChanged(slot: Slot): void {
		if (slot.running || slot.compacting || !slot.taskId) return;
		const goal = this.core.db.get<{ goal_id: string | null }>("SELECT goal_id FROM tasks WHERE id=?", slot.taskId)?.goal_id;
		if (goal) this.scheduler.process(goal);
	}
}
