import { randomUUID } from "node:crypto";
import { RpcError } from "../../core.ts";
import { json, parseJson, type Db } from "../../db.ts";
import type { GoalRow } from "./types.ts";

const COMPUTE_MS = 2 * 60 * 60_000;
const EXTERNAL_MS = 7 * 24 * 60 * 60_000;
export const LOST_JOB = "后台重启时这个作业已经不在了";

export type WaitRequest =
	| { kind: "compute"; jobId: string }
	| { kind: "external"; event: "schedule.fired" | "external.event"; ref: string; label: string; deadline?: number }
	| { kind: "user"; questions: string[] };
interface WaitRow {
	id: string; goal_id: string; kind: WaitRequest["kind"]; ref: string; wake_on: string | null;
	deadline: number | null; status: string; revision: number; label: string | null;
}
export interface GoalJob {
	id: string; goal_id: string; goal_revision: number; owner_run_id: string | null; kind: string; label: string;
	status: string; service: number; started_at: number; command: string | null; exit_code: number | null;
}
export function parseWait(value: unknown): WaitRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new RpcError("bad_request", "请说明要等什么");
	const w = value as Record<string, unknown>;
	const text = (v: unknown) => typeof v === "string" && v.trim() ? v.trim().slice(0, 600) : undefined;
	if (w.kind === "compute" && text(w.jobId)) return { kind: "compute", jobId: text(w.jobId)! };
	if (w.kind === "user" && Array.isArray(w.questions)) {
		const questions = w.questions.map(text).filter((q): q is string => !!q).slice(0, 10);
		if (questions.length) return { kind: "user", questions };
	}
	if (w.kind === "external" && (w.event === "schedule.fired" || w.event === "external.event") && text(w.ref) && text(w.label)) {
		const deadline = w.deadline;
		if (deadline === undefined || typeof deadline === "number" && Number.isSafeInteger(deadline) && deadline > 0) {
			return { kind: "external", event: w.event, ref: text(w.ref)!, label: text(w.label)!, deadline };
		}
	}
	throw new RpcError("bad_request", "等待条件无效，请提供真实作业编号、事件与标识，或具体问题");
}

export class GoalWaits {
	private readonly db: Db;
	constructor(db: Db) { this.db = db; }

	job(id: string) { return this.db.get<GoalJob>("SELECT * FROM jobs WHERE id=? AND goal_id IS NOT NULL", id); }
	open(goal: Pick<GoalRow, "id" | "revision">) {
		return this.db.all<WaitRow>("SELECT * FROM goal_waits WHERE goal_id=? AND revision=? AND status='open' ORDER BY rowid", goal.id, goal.revision);
	}
	detail(goal: Pick<GoalRow, "id" | "revision">) {
		return this.open(goal).map(w => ({ id: w.id, kind: w.kind, ref: w.ref, label: w.label, deadline: w.deadline,
			questions: w.kind === "user" ? parseJson<string[]>(w.wake_on, []) : undefined }));
	}
	services(goalId: string) {
		return this.db.all<{ id: string; label: string; kind: string; status: string }>(
			"SELECT id,label,kind,status FROM jobs WHERE goal_id=? AND service=1 AND status='running' ORDER BY started_at,id", goalId);
	}
	cancel(goalId: string, at: number) {
		this.db.run("UPDATE goal_waits SET status='cancelled',resolved_at=? WHERE goal_id=? AND status='open'", at, goalId);
	}
	add(goal: GoalRow, request: WaitRequest, at: number): string {
		let ref: string, label: string, deadline: number | null, wake: string | null;
		switch (request.kind) {
			case "compute": {
				const job = this.job(request.jobId);
				if (!job || job.goal_id !== goal.id || job.goal_revision !== goal.revision) throw new RpcError("not_found", "这个作业不属于目标的当前修订");
				if (job.service) return `常驻服务「${job.label}」会继续运行`;
				if (job.status !== "running") return `作业「${job.label}」已经结束`;
				ref = job.id; label = job.label; deadline = job.started_at + COMPUTE_MS; wake = "job.finished";
				break;
			}
			case "external": {
				if (request.event === "schedule.fired" && !this.db.get("SELECT 1 FROM schedules WHERE id=? AND goal_id=?", request.ref, goal.id)) {
					throw new RpcError("not_found", "这个日程没有关联当前目标");
				}
				const after = this.db.get<{ cursor: number }>("SELECT coalesce(max(rowid),0) cursor FROM goal_events")!.cursor;
				ref = request.ref; label = request.label; deadline = request.deadline ?? at + EXTERNAL_MS; wake = json({ event: request.event, after });
				break;
			}
			case "user":
				ref = "questions"; label = request.questions.join("\n"); deadline = null; wake = json(request.questions);
				break;
		}
		const existing = this.open(goal).find(w => w.kind === request.kind && w.ref === ref);
		if (existing && request.kind === "user") {
			const questions = [...new Set([...parseJson<string[]>(existing.wake_on, []), ...request.questions])].slice(0, 10);
			this.db.run("UPDATE goal_waits SET wake_on=?,label=? WHERE id=?", json(questions), questions.join("\n"), existing.id);
		} else if (!existing) {
			this.db.run(`INSERT INTO goal_waits(id,goal_id,kind,ref,wake_on,deadline,status,created_at,revision,label)
				VALUES(?,?,?,?,?,?,'open',?,?,?)`, randomUUID(), goal.id, request.kind, ref, wake, deadline, at, goal.revision, label);
		}
		return request.kind === "user" ? "已登记需要你补充的问题" : `已登记：等${label}再继续`;
	}
	settle(id: string, status: "resolved" | "expired" | "cancelled", at: number) {
		return !!this.db.run("UPDATE goal_waits SET status=?,resolved_at=? WHERE id=? AND status='open'", status, at, id).changes;
	}
	check(goal: GoalRow, at: number): { remaining: WaitRow[]; lost?: WaitRow; expired?: WaitRow } {
		const remaining: WaitRow[] = [];
		let lost: WaitRow | undefined, expired: WaitRow | undefined;
		for (const wait of this.open(goal)) {
			const job = wait.kind === "compute" ? this.job(wait.ref) : undefined;
			if (wait.kind === "compute" && (!job || job.status === "lost" || job.status === "cancelled" && this.db.get("SELECT 1 FROM jobs WHERE id=? AND stopped_by='shutdown'", wait.ref))) {
				this.settle(wait.id, "cancelled", at); lost ??= wait; continue;
			}
			if (job && job.status !== "running" || wait.kind === "external" && this.signalled(wait, at)) {
				this.settle(wait.id, "resolved", at); continue;
			}
			if (wait.deadline !== null && wait.deadline <= at) {
				this.settle(wait.id, "expired", at); expired ??= wait; continue;
			}
			remaining.push(wait);
		}
		return { remaining, lost, expired };
	}
	private signalled(wait: WaitRow, at: number): boolean {
		const wake = parseJson<{ event?: string; after?: number }>(wait.wake_on, {});
		if (!wake.event) return false;
		return !!this.db.get(`SELECT 1 FROM goal_events WHERE goal_id=? AND kind=? AND rowid>?
			AND json_extract(payload,?)=? AND created_at<=?`, wait.goal_id, wake.event, wake.after ?? 0,
			wake.event === "schedule.fired" ? "$.scheduleId" : "$.ref", wait.ref, Math.min(at, wait.deadline ?? at));
	}
}
