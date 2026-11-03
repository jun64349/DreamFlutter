import { randomUUID } from "node:crypto";
import type { AgentSessionEvent, ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import type { Core, CoreModule } from "../core.ts";
import { num, RpcError, requireStr, str } from "../core.ts";
import type { Db } from "../db.ts";
import { json, now, parseJson } from "../db.ts";
import { isReadOnlyCall, READ_ONLY_TOOLS, SHELL_TOOLS } from "../ext/approval.ts";
import type { Run } from "../runs.ts";
import { textOf } from "../runs.ts";
import type { Slot } from "../slots/slot.ts";
import type { TasksModule } from "./tasks.ts";

export type TriggerType = "once" | "interval" | "cron";
/** task = do something; report = produce a result each time; monitor = check for changes, quiet when nothing changed. */
export type ScheduleKind = "task" | "report" | "monitor";
/** What a report does with missed times: skip them, or catch up the most recent one. */
export type MissedPolicy = "skip" | "latest";
export type ScheduleStatus = "active" | "paused" | "pending_approval" | "finished" | "rejected";
export type ScheduleRunStatus = "waiting" | "running" | "needs_input" | "done" | "no_change" | "failed" | "interrupted" | "skipped";
export type DeliveryStatus = "delivered" | "undelivered" | "unknown";

export interface Trigger {
	type: TriggerType;
	/** once: epoch ms. */
	at?: number;
	/** interval: period in ms, counted from [anchor]. */
	everyMs?: number;
	anchor?: number;
	/** cron: five-field expression evaluated in [timezone] (IANA). */
	cron?: string;
	timezone?: string;
}

export interface Schedule {
	id: string;
	name: string;
	prompt: string;
	cwd: string;
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
	createdAt: number;
	updatedAt: number;
}

export interface ScheduleRun {
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

export interface Delivery {
	id: string;
	runId: string;
	channel: "window" | "toast";
	status: DeliveryStatus;
	detail: string | null;
	createdAt: number;
}

/** Late by more than this = missed (the computer was off or asleep). */
export const MISSED_GRACE_MS = 2 * 60_000;
/** Shortest period for schedules the agent creates. */
export const MIN_AGENT_INTERVAL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS = [60_000, 5 * 60_000];
const NO_CHANGE = /^\s*[【\[]?无变化[】\]]?/;
export const SCHEDULE_TOOLS = ["schedule_state", "schedule_create"];

interface ScheduleRow {
	id: string;
	name: string;
	prompt: string;
	cwd: string;
	kind: string;
	trigger: string;
	missed_policy: string;
	session_mode: string;
	session_file: string | null;
	allowed_tools: string | null;
	state: string;
	status: string;
	version: number;
	next_run_at: number | null;
	last_run_at: number | null;
	pending_at: number | null;
	created_by: string;
	created_at: number;
	updated_at: number;
}

function toSchedule(row: ScheduleRow): Schedule {
	return {
		id: row.id,
		name: row.name,
		prompt: row.prompt,
		cwd: row.cwd,
		kind: row.kind as ScheduleKind,
		trigger: parseJson<Trigger>(row.trigger, { type: "once" }),
		missedPolicy: row.missed_policy as MissedPolicy,
		sessionMode: row.session_mode === "bound" ? "bound" : "fresh",
		sessionFile: row.session_file,
		allowedTools: parseJson<string[] | null>(row.allowed_tools, null),
		state: parseJson<Record<string, unknown>>(row.state, {}),
		status: row.status as ScheduleStatus,
		version: row.version,
		nextRunAt: row.next_run_at,
		lastRunAt: row.last_run_at,
		createdBy: row.created_by === "agent" ? "agent" : "user",
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

interface RunRow {
	id: string;
	schedule_id: string;
	trigger_key: string;
	version: number;
	scheduled_at: number | null;
	started_at: number | null;
	ended_at: number | null;
	manual: number;
	catch_up: number;
	status: string;
	attempt: number;
	retry_at: number | null;
	task_id: string | null;
	session_file: string | null;
	result: string | null;
	error: string | null;
	note: string | null;
	external_effects: number;
	cost: number;
}

function toRun(row: RunRow): ScheduleRun {
	return {
		id: row.id,
		scheduleId: row.schedule_id,
		triggerKey: row.trigger_key,
		version: row.version,
		scheduledAt: row.scheduled_at,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		manual: row.manual === 1,
		catchUp: row.catch_up === 1,
		status: row.status as ScheduleRunStatus,
		attempt: row.attempt,
		retryAt: row.retry_at,
		taskId: row.task_id,
		sessionFile: row.session_file,
		result: row.result,
		error: row.error,
		note: row.note,
		externalEffects: row.external_effects === 1,
		cost: row.cost,
	};
}

/** Next fire time strictly after [after], or null when the trigger is used up. */
export function nextOccurrence(trigger: Trigger, after: number): number | null {
	switch (trigger.type) {
		case "once":
			return trigger.at !== undefined && trigger.at > after ? trigger.at : null;
		case "interval": {
			const every = trigger.everyMs ?? 0;
			if (every <= 0) return null;
			const anchor = trigger.anchor ?? after;
			if (anchor > after) return anchor;
			return anchor + (Math.floor((after - anchor) / every) + 1) * every;
		}
		case "cron": {
			const next = new Cron(trigger.cron ?? "", { timezone: trigger.timezone || undefined }).nextRun(new Date(after));
			return next ? next.getTime() : null;
		}
	}
}

/** Checks a trigger and returns why it is invalid (or null). */
export function validateTrigger(trigger: Trigger, options: { minIntervalMs?: number; at?: number } = {}): string | null {
	const at = options.at ?? now();
	switch (trigger.type) {
		case "once":
			if (!trigger.at) return "请设置执行时间";
			return null;
		case "interval":
			if (!trigger.everyMs || trigger.everyMs < 60_000) return "间隔至少 1 分钟";
			if (options.minIntervalMs && trigger.everyMs < options.minIntervalMs) return `间隔至少 ${options.minIntervalMs / 60_000} 分钟`;
			return null;
		case "cron": {
			try {
				const runs = new Cron(trigger.cron ?? "", { timezone: trigger.timezone || undefined }).nextRuns(3, new Date(at));
				if (!runs.length) return "这个日历规则不会再触发";
				if (options.minIntervalMs) {
					for (let i = 1; i < runs.length; i++) {
						if (runs[i]!.getTime() - runs[i - 1]!.getTime() < options.minIntervalMs) return `两次执行至少间隔 ${options.minIntervalMs / 60_000} 分钟`;
					}
				}
				return null;
			} catch (error) {
				return `日历规则不正确：${error instanceof Error ? error.message : String(error)}`;
			}
		}
		default:
			return "未知的触发方式";
	}
}

function formatTime(at: number, timezone?: string): string {
	return new Date(at).toLocaleString("zh-CN", { timeZone: timezone || undefined, hour12: false });
}

/**
 * Scheduled tasks (user's draft §8): schedules, run records and delivery
 * records kept apart; one-off, interval and calendar (cron + timezone)
 * triggers; stable trigger keys so a time is never claimed twice and edits
 * void old triggers; manual runs; missed-time handling by kind; no overlap
 * within a schedule; bounded retries only before any external effect;
 * per-schedule tools and state; quiet monitors; agent-proposed schedules
 * the user approves.
 */
export class SchedulerModule implements CoreModule {
	readonly modelFacing = true;
	private readonly core: Core;
	private readonly db: Db;
	private readonly tasks: TasksModule;
	private timer: NodeJS.Timeout | undefined;
	private ticking: Promise<void> | undefined;
	/** Slot → schedule run executing in it. */
	private readonly active = new Map<string, string>();
	/** Schedules whose run is being started (before its session is open). */
	private readonly starting = new Set<string>();
	readonly clock: () => number;

	constructor(core: Core, tasks: TasksModule, clock: () => number = now) {
		this.core = core;
		this.db = core.db;
		this.tasks = tasks;
		this.clock = clock;
		core.exemptFromApproval(...SCHEDULE_TOOLS);
		tasks.addInboxSource(() =>
			this.list({ status: ["pending_approval"] }).map((s) => ({
				kind: "schedule",
				id: s.id,
				title: `Agent 想创建定时任务「${s.name}」`,
				body: `${this.describeTrigger(s.trigger)}\n${s.prompt}`,
				createdAt: s.createdAt,
				cwd: s.cwd,
				data: s,
			})),
		);
		tasks.onNoticeResolved((notice, action, slot) => this.limitAnswered(notice.taskId, action, slot));
		core.declareBackup({
			id: "schedules",
			title: "定时任务",
			tables: ["schedules", "schedule_runs", "deliveries"],
			paths: { schedules: { cwd: "path", session_file: "path" }, schedule_runs: { session_file: "path" } },
			// Restored schedules wait until the user has looked them over.
			onStage: (db) => db.run("UPDATE schedules SET status = 'paused' WHERE status = 'active'"),
		});
		this.recover();
		this.register();
	}

	/** A scheduled run paused by a run limit: stopping ends it, continuing tracks it again. */
	private limitAnswered(taskId: string | null, action: "continue" | "stop", slot?: Slot): void {
		if (!taskId) return;
		const row = this.db.get<RunRow>("SELECT * FROM schedule_runs WHERE task_id = ? AND status = 'needs_input' ORDER BY started_at DESC LIMIT 1", taskId);
		if (!row) return;
		if (action === "continue" && slot) {
			this.active.set(slot.slotId, row.id);
			slot.taskId = taskId;
			this.updateRun(row.id, { status: "running", note: "运行上限暂停后，用户选择继续" });
		} else {
			this.finishRun(row.id, "interrupted", { note: "运行上限暂停后，用户选择结束" });
		}
	}

	start(): void {
		this.timer = setInterval(() => void this.tick(), 15_000);
		this.timer.unref();
		void this.tick();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
	}

	/** Runs left running by a previous core are interrupted (the slot is gone). */
	private recover(): void {
		this.db.run("UPDATE schedule_runs SET status = 'interrupted', ended_at = ?, note = COALESCE(note, '后台重启时中断') WHERE status IN ('running', 'needs_input')", now());
		// Claimed but not started when the core stopped: the next tick picks them up.
		this.db.run("UPDATE schedule_runs SET retry_at = ? WHERE status = 'waiting' AND retry_at IS NULL", now());
	}

	/** The schedule still wants this run: not deleted, edited or paused since it was claimed (a manual run ignores the pause). */
	private stillWanted(run: ScheduleRun): Schedule | undefined {
		const schedule = this.get(run.scheduleId);
		if (!schedule || schedule.version !== run.version) return undefined;
		if (!run.manual && (schedule.status === "paused" || schedule.status === "pending_approval")) return undefined;
		return schedule;
	}

	// ---- schedules ---------------------------------------------------------------------

	get(id: string): Schedule | undefined {
		const row = this.db.get<ScheduleRow>("SELECT * FROM schedules WHERE id = ?", id);
		return row ? toSchedule(row) : undefined;
	}

	list(filter: { status?: ScheduleStatus[] } = {}): Schedule[] {
		const statuses = filter.status ?? ["active", "paused", "pending_approval", "finished"];
		return this.db
			.all<ScheduleRow>(`SELECT * FROM schedules WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at DESC`, ...statuses)
			.map(toSchedule);
	}

	describeTrigger(trigger: Trigger): string {
		switch (trigger.type) {
			case "once":
				return `一次性：${trigger.at ? formatTime(trigger.at) : "未设置"}`;
			case "interval": {
				const minutes = Math.round((trigger.everyMs ?? 0) / 60_000);
				return minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`;
			}
			case "cron":
				return `按日历：${trigger.cron}（${trigger.timezone || "本地时区"}）`;
		}
	}

	save(input: Partial<Schedule> & { id?: string; createdBy?: "user" | "agent" }): Schedule {
		const existing = input.id ? this.get(input.id) : undefined;
		if (input.id && !existing) throw new RpcError("not_found", "这个定时任务不存在");
		const name = (input.name ?? existing?.name ?? "").trim();
		const prompt = (input.prompt ?? existing?.prompt ?? "").trim();
		const cwd = input.cwd ?? existing?.cwd;
		if (!name) throw new RpcError("bad_request", "请填写名称");
		if (!prompt) throw new RpcError("bad_request", "请填写要做的事");
		if (!cwd) throw new RpcError("bad_request", "缺少工作区");
		const trigger: Trigger = { ...(input.trigger ?? existing?.trigger ?? { type: "once" }) };
		const createdBy = existing?.createdBy ?? input.createdBy ?? "user";
		const at = this.clock();
		if (trigger.type === "interval" && trigger.anchor === undefined) trigger.anchor = at + (trigger.everyMs ?? 0);
		if (trigger.type === "cron" && !trigger.timezone) trigger.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const problem = validateTrigger(trigger, { minIntervalMs: createdBy === "agent" ? MIN_AGENT_INTERVAL_MS : undefined, at });
		if (problem) throw new RpcError("bad_request", problem);
		const kind = (["task", "report", "monitor"] as const).find((k) => k === (input.kind ?? existing?.kind)) ?? "task";
		const sessionMode = (input.sessionMode ?? existing?.sessionMode) === "bound" ? "bound" : "fresh";
		const sessionFile = sessionMode === "bound" ? (input.sessionFile ?? existing?.sessionFile ?? null) : null;
		if (sessionMode === "bound" && !sessionFile) throw new RpcError("bad_request", "绑定会话时需要指定会话");
		let status: ScheduleStatus = input.status ?? existing?.status ?? (createdBy === "agent" ? "pending_approval" : "active");
		if (status === "finished" && input.trigger) status = "active"; // a used-up one-off given a new time
		const nextRunAt = status === "active" ? nextOccurrence(trigger, at - 1) : (existing?.nextRunAt ?? null);
		const schedule: Schedule = {
			id: existing?.id ?? `s_${randomUUID().slice(0, 8)}`,
			name,
			prompt,
			cwd,
			kind,
			trigger,
			missedPolicy: (input.missedPolicy ?? existing?.missedPolicy) === "skip" ? "skip" : "latest",
			sessionMode,
			sessionFile,
			allowedTools: input.allowedTools !== undefined ? input.allowedTools : (existing?.allowedTools ?? null),
			state: existing?.state ?? {},
			status,
			version: (existing?.version ?? 0) + 1,
			nextRunAt: status === "active" ? nextRunAt : null,
			lastRunAt: existing?.lastRunAt ?? null,
			createdBy,
			createdAt: existing?.createdAt ?? at,
			updatedAt: at,
		};
		this.db.run(
			`INSERT INTO schedules(id, name, prompt, cwd, kind, trigger, missed_policy, session_mode, session_file, allowed_tools, state, status, version, next_run_at, last_run_at, created_by, created_at, updated_at)
			 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, cwd = excluded.cwd, kind = excluded.kind, trigger = excluded.trigger,
			 missed_policy = excluded.missed_policy, session_mode = excluded.session_mode, session_file = excluded.session_file, allowed_tools = excluded.allowed_tools,
			 status = excluded.status, version = excluded.version, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at, pending_at = NULL`,
			schedule.id,
			schedule.name,
			schedule.prompt,
			schedule.cwd,
			schedule.kind,
			json(schedule.trigger),
			schedule.missedPolicy,
			schedule.sessionMode,
			schedule.sessionFile,
			schedule.allowedTools ? json(schedule.allowedTools) : null,
			json(schedule.state),
			schedule.status,
			schedule.version,
			schedule.nextRunAt,
			schedule.lastRunAt,
			schedule.createdBy,
			schedule.createdAt,
			schedule.updatedAt,
		);
		this.changed();
		return schedule;
	}

	/** Pause, resume, approve or reject; resuming recomputes the next time from now. */
	setStatus(id: string, status: ScheduleStatus): Schedule {
		const schedule = this.get(id);
		if (!schedule) throw new RpcError("not_found", "这个定时任务不存在");
		const at = this.clock();
		const next = status === "active" ? nextOccurrence(schedule.trigger, at - 1) : null;
		if (status === "active" && next === null && schedule.trigger.type === "once") throw new RpcError("bad_request", "执行时间已经过了，请先修改时间");
		this.db.run("UPDATE schedules SET status = ?, next_run_at = ?, version = version + 1, pending_at = NULL, updated_at = ? WHERE id = ?", status, next, at, id);
		this.changed();
		return this.get(id)!;
	}

	remove(id: string): void {
		this.db.run("DELETE FROM schedules WHERE id = ?", id);
		this.changed();
	}

	private changed(): void {
		this.core.broadcast({ event: "schedules.changed" });
	}

	// ---- runs and deliveries ------------------------------------------------------------

	getRun(id: string): ScheduleRun | undefined {
		const row = this.db.get<RunRow>("SELECT * FROM schedule_runs WHERE id = ?", id);
		return row ? toRun(row) : undefined;
	}

	runs(scheduleId: string, limit = 50): (ScheduleRun & { deliveries: Delivery[] })[] {
		return this.db
			.all<RunRow>("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY COALESCE(started_at, scheduled_at) DESC LIMIT ?", scheduleId, limit)
			.map(toRun)
			.map((run) => ({ ...run, deliveries: this.deliveries(run.id) }));
	}

	deliveries(runId: string): Delivery[] {
		return this.db
			.all<{ id: string; run_id: string; channel: string; status: string; detail: string | null; created_at: number }>("SELECT * FROM deliveries WHERE run_id = ? ORDER BY created_at", runId)
			.map((r) => ({ id: r.id, runId: r.run_id, channel: r.channel as Delivery["channel"], status: r.status as DeliveryStatus, detail: r.detail, createdAt: r.created_at }));
	}

	private updateRun(id: string, patch: Partial<Record<keyof RunRow, string | number | null>>): void {
		const keys = Object.keys(patch);
		if (!keys.length) return;
		this.db.run(`UPDATE schedule_runs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => patch[k as keyof RunRow] ?? null), id);
		this.core.broadcast({ event: "schedules.changed", runId: id });
	}

	/**
	 * Claims a trigger: the unique key makes a second claim of the same time
	 * (two ticks, a restart) a no-op. Returns the run, or undefined if taken.
	 */
	private claim(schedule: Schedule, scheduledAt: number | null, options: { manual?: boolean; catchUp?: boolean; status?: ScheduleRunStatus; note?: string } = {}): ScheduleRun | undefined {
		const id = `sr_${randomUUID().slice(0, 8)}`;
		const key = options.manual ? `manual:${id}` : `${schedule.id}:v${schedule.version}:${scheduledAt}`;
		const result = this.db.run(
			`INSERT OR IGNORE INTO schedule_runs(id, schedule_id, trigger_key, version, scheduled_at, manual, catch_up, status, attempt, note)
			 VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
			id,
			schedule.id,
			key,
			schedule.version,
			scheduledAt,
			options.manual ? 1 : 0,
			options.catchUp ? 1 : 0,
			options.status ?? "waiting",
			options.note ?? null,
		);
		return result.changes ? this.getRun(id) : undefined;
	}

	/**
	 * Whether the schedule has a run going (or starting) other than [exceptRun].
	 * A run waiting on a limit card only counts while it still has a session.
	 */
	private busy(scheduleId: string, exceptRun?: string): boolean {
		if (this.starting.has(scheduleId)) return true;
		const live = new Set(this.active.values());
		return this.db
			.all<{ id: string; status: string }>("SELECT id, status FROM schedule_runs WHERE schedule_id = ? AND status IN ('running', 'needs_input')", scheduleId)
			.some((r) => r.id !== exceptRun && (r.status === "running" || live.has(r.id)));
	}

	/** Checks due schedules and retries; resolves once due runs have started. */
	tick(at = this.clock()): Promise<void> {
		// A backup is copying the data: due runs start on the next tick after it.
		if (this.core.maintenance) return Promise.resolve();
		if (this.ticking) return this.ticking;
		this.ticking = this.doTick(at).finally(() => {
			this.ticking = undefined;
		});
		return this.ticking;
	}

	private async doTick(at: number): Promise<void> {
		const starts: ScheduleRun[] = [];
		for (const row of this.db.all<RunRow>("SELECT * FROM schedule_runs WHERE status = 'waiting' AND retry_at IS NOT NULL AND retry_at <= ?", at)) {
			if (!this.busy(row.schedule_id)) starts.push(toRun(row));
		}
		for (const schedule of this.list({ status: ["active"] })) {
			if (schedule.nextRunAt === null || schedule.nextRunAt > at) continue;
			const { count, latest } = dueTimes(schedule.trigger, schedule.nextRunAt, at);
			const missed = at - schedule.nextRunAt > MISSED_GRACE_MS;
			const next = nextOccurrence(schedule.trigger, at);
			const skippedCount = count - 1;
			const note = skippedCount > 0 ? `错过了 ${count} 次，只补做最近一次` : missed ? "错过了原定时间，补做" : null;
			// A trigger with no further times (a one-off, a cron that ended) is finished.
			this.db.run("UPDATE schedules SET next_run_at = ?, status = ?, updated_at = ? WHERE id = ?", next, next === null ? "finished" : "active", at, schedule.id);
			if (missed && schedule.kind === "report" && schedule.missedPolicy === "skip" && schedule.trigger.type !== "once") {
				this.claim(schedule, latest, { status: "skipped", note: `错过了原定时间（${count} 次），按设置跳过` });
				continue;
			}
			const scheduledAt = schedule.trigger.type === "once" ? schedule.nextRunAt : latest;
			if (this.busy(schedule.id)) {
				// No overlap: remember the trigger, decide after the current run ends.
				this.db.run("UPDATE schedules SET pending_at = ? WHERE id = ?", scheduledAt, schedule.id);
				continue;
			}
			const run = this.claim(schedule, scheduledAt, { catchUp: missed || skippedCount > 0, note: note ?? undefined });
			if (run) starts.push(run);
		}
		this.changed();
		for (const run of starts) await this.execute(run);
	}

	/** Starts a run now, outside the schedule (does not move the next time). */
	async runNow(id: string): Promise<ScheduleRun> {
		const schedule = this.get(id);
		if (!schedule) throw new RpcError("not_found", "这个定时任务不存在");
		if (schedule.status === "pending_approval") throw new RpcError("bad_request", "这个定时任务还没有被批准");
		if (this.busy(id)) throw new RpcError("conflict", "上一次运行还没结束");
		if (this.core.maintenance) throw new RpcError("busy", `${this.core.maintenance}，请稍后再运行`);
		const run = this.claim(schedule, this.clock(), { manual: true, note: "手动运行" })!;
		await this.execute(run);
		return this.getRun(run.id)!;
	}

	private composePrompt(schedule: Schedule, run: ScheduleRun): string {
		const tz = schedule.trigger.timezone;
		const lines = [`<定时任务 名称="${schedule.name}">`];
		if (run.manual) lines.push(`手动触发，时间：${formatTime(this.clock(), tz)}`);
		else if (run.scheduledAt) {
			lines.push(`原定时间：${formatTime(run.scheduledAt, tz)}${tz ? `（${tz}）` : ""}`);
			if (run.catchUp) lines.push(`实际执行：${formatTime(this.clock(), tz)}（补做${run.note ? `，${run.note}` : ""}）`);
		}
		if (run.attempt > 1) lines.push(`这是第 ${run.attempt} 次尝试，上次失败了。`);
		if (Object.keys(schedule.state).length) lines.push(`上次保存的状态：${JSON.stringify(schedule.state)}`);
		lines.push("</定时任务>", "", schedule.prompt, "");
		if (schedule.kind === "monitor") {
			lines.push("这是监控类任务：和上次保存的状态比较。如果没有值得报告的变化，回复的第一行只写「无变化」。无论有没有变化，结束前都用 schedule_state 工具保存这次检查的关键结果，供下次比较。检查失败时如实说明失败原因，不要写「无变化」。");
		} else {
			lines.push("没有人在旁边看着，不要提问，按最合理的方式完成。需要下次参考的信息可以用 schedule_state 工具保存。");
		}
		if (!schedule.allowedTools?.length) lines.push("这个定时任务只允许使用只读工具（读取、查找、抓取网页等）。");
		return lines.join("\n");
	}

	private async execute(run: ScheduleRun): Promise<void> {
		const schedule = this.stillWanted(run);
		if (!schedule) {
			this.updateRun(run.id, { status: "skipped", ended_at: this.clock(), note: "计划已修改、暂停或删除，这次触发作废" });
			return;
		}
		if (this.busy(schedule.id, run.id)) {
			// Never two runs of one schedule at once: try again once the other is done.
			this.updateRun(run.id, { status: "waiting", retry_at: this.clock() + 60_000 });
			return;
		}
		this.starting.add(schedule.id);
		try {
			await this.launch(run, schedule);
		} finally {
			this.starting.delete(schedule.id);
		}
	}

	private async launch(run: ScheduleRun, schedule: Schedule): Promise<void> {
		const task = run.taskId ? this.tasks.get(run.taskId) : undefined;
		const taskId = task?.id ?? this.tasks.create({ cwd: schedule.cwd, goal: schedule.prompt, title: `定时：${schedule.name}`, source: "schedule", scheduleId: schedule.id }).id;
		let slot: Slot;
		try {
			slot = await this.core.openSlot({
				cwd: schedule.cwd,
				sessionFile: schedule.sessionMode === "bound" ? (schedule.sessionFile ?? undefined) : undefined,
				taskId,
				unattended: true,
				// Scheduled runs report through schedule_state, a standard-mode tool.
				agentMode: "standard",
			});
		} catch (error) {
			this.finishRun(run.id, "failed", { error: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (slot.running || this.active.has(slot.slotId)) {
			// The bound session is busy (the user is using it): try again shortly.
			this.updateRun(run.id, { retry_at: this.clock() + 60_000, task_id: taskId, note: "绑定的会话正忙，稍后重试" });
			return;
		}
		if (!this.stillWanted(run)) {
			// Paused, edited or deleted while the session opened.
			this.finishRun(run.id, "skipped", { note: "计划已修改、暂停或删除，这次触发作废" });
			return;
		}
		if (this.core.maintenance) {
			// A backup or restore began while the session opened.
			this.updateRun(run.id, { retry_at: this.clock() + 60_000, task_id: taskId, note: `${this.core.maintenance}，稍后重试` });
			return;
		}
		slot.taskId = taskId;
		this.active.set(slot.slotId, run.id);
		this.updateRun(run.id, { status: "running", started_at: this.clock(), task_id: taskId, retry_at: null, session_file: slot.info().sessionFile });
		this.db.run("UPDATE schedules SET last_run_at = ? WHERE id = ?", this.clock(), schedule.id);
		try {
			await slot.prompt(this.composePrompt(schedule, this.getRun(run.id)!));
		} catch (error) {
			this.active.delete(slot.slotId);
			this.finishRun(run.id, "failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	// ---- run lifecycle -----------------------------------------------------------------

	onSlotEvent(slot: Slot, event: AgentSessionEvent): void {
		const runId = this.active.get(slot.slotId);
		if (!runId || event.type !== "tool_execution_start") return;
		// Memory candidates and skill proposals wait for the user: not external effects.
		const internal = READ_ONLY_TOOLS.has(event.toolName) || SCHEDULE_TOOLS.includes(event.toolName) || event.toolName.startsWith("memory_") || event.toolName === "skill_propose";
		if (!internal) this.updateRun(runId, { external_effects: 1 });
	}

	onSlotChanged(slot: Slot): void {
		const runId = this.active.get(slot.slotId);
		if (!runId || !slot.running) return;
		const run = this.getRun(runId);
		const status: ScheduleRunStatus = slot.ui.pendingCount > 0 ? "needs_input" : "running";
		if (run && run.status !== status && (run.status === "running" || run.status === "needs_input")) this.updateRun(runId, { status });
	}

	onRunFinished(slot: Slot, run: Run): void {
		const runId = this.active.get(slot.slotId);
		if (!runId) return;
		this.active.delete(slot.slotId);
		const record = this.getRun(runId);
		const schedule = record ? this.get(record.scheduleId) : undefined;
		if (!record || !schedule) return;
		const messages = slot.started ? (slot.session.messages as unknown as { role: string; content: unknown }[]) : [];
		const reply = [...messages].reverse().find((m) => m.role === "assistant");
		const result = reply ? textOf(reply.content).slice(0, 2000) : null;
		const limited = run.taskId ? this.db.get("SELECT 1 FROM notices WHERE task_id = ? AND status = 'pending'", run.taskId) : undefined;
		let status: ScheduleRunStatus;
		if (limited) status = "needs_input";
		else if (run.status === "failed") status = "failed";
		else if (run.status === "done") status = schedule.kind === "monitor" && result && NO_CHANGE.test(result) ? "no_change" : "done";
		else status = "interrupted";

		const fresh = this.getRun(runId)!;
		if (status === "failed" && !fresh.externalEffects && fresh.attempt < MAX_ATTEMPTS) {
			// Nothing happened outside yet: safe to try again later.
			this.updateRun(runId, {
				status: "waiting",
				attempt: fresh.attempt + 1,
				retry_at: this.clock() + RETRY_DELAYS[Math.min(fresh.attempt - 1, RETRY_DELAYS.length - 1)]!,
				error: run.error,
				cost: fresh.cost + run.cost,
				task_id: null,
			});
		} else {
			this.finishRun(runId, status, { result, error: run.error, cost: fresh.cost + run.cost, note: status === "failed" && fresh.externalEffects ? "已经执行过会产生外部影响的操作，没有自动重试，请检查后手动处理" : undefined });
		}
		if (status === "no_change" && run.taskId) this.tasks.markNoChange(run.taskId);
		if (slot.unattended && !this.watched(slot)) void this.core.closeSlot(slot.slotId);
		else slot.taskId = null;
		void this.afterRun(schedule.id);
	}

	private watched(slot: Slot): boolean {
		for (const client of this.core.clients) if (client.attached.has(slot.slotId)) return true;
		return false;
	}

	private finishRun(runId: string, status: ScheduleRunStatus, patch: { result?: string | null; error?: string | null; cost?: number; note?: string }): void {
		this.updateRun(runId, {
			status,
			ended_at: this.clock(),
			result: patch.result ?? null,
			error: status === "done" || status === "no_change" ? null : (patch.error ?? null),
			...(patch.cost !== undefined ? { cost: patch.cost } : {}),
			...(patch.note ? { note: patch.note } : {}),
		});
		this.deliver(this.getRun(runId)!);
	}

	/** A trigger that came while the last run was going: run it now if still relevant. */
	private async afterRun(scheduleId: string): Promise<void> {
		const row = this.db.get<{ pending_at: number | null }>("SELECT pending_at FROM schedules WHERE id = ?", scheduleId);
		if (!row?.pending_at) return;
		this.db.run("UPDATE schedules SET pending_at = NULL WHERE id = ?", scheduleId);
		const schedule = this.get(scheduleId);
		if (!schedule || schedule.status === "paused" || schedule.status === "rejected") return;
		const run = this.claim(schedule, row.pending_at, { catchUp: true, note: "上次运行时又到了执行时间，结束后补做" });
		if (run) await this.execute(run);
	}

	/**
	 * Tells the user about a finished run. Quiet monitors (no change) are not
	 * delivered; failures always are.
	 */
	private deliver(run: ScheduleRun): void {
		if (run.status === "no_change" || run.status === "skipped" || run.status === "waiting") return;
		const schedule = this.get(run.scheduleId);
		const title =
			run.status === "failed"
				? `定时任务失败：${schedule?.name}`
				: run.status === "needs_input"
					? `定时任务需要你处理：${schedule?.name}`
					: run.status === "interrupted"
						? `定时任务已中断：${schedule?.name}`
						: `定时任务完成：${schedule?.name}`;
		const body = (run.status === "failed" ? run.error : run.result)?.replace(/\s+/g, " ").slice(0, 200) ?? "";
		const record = (channel: Delivery["channel"], status: DeliveryStatus, detail: string | null) =>
			this.db.run("INSERT INTO deliveries(id, run_id, channel, status, detail, created_at) VALUES(?, ?, ?, ?, ?, ?)", `d_${randomUUID().slice(0, 8)}`, run.id, channel, status, detail, now());
		if (this.core.clients.size > 0) {
			this.core.broadcast({ event: "schedules.delivered", runId: run.id, title, body });
			record("window", "delivered", null);
			return;
		}
		if (!this.core.settings.get().notifications) {
			record("toast", "undelivered", "系统通知已关闭");
			return;
		}
		const pending = this.core.notifier.deliver?.(title, body);
		if (!pending) {
			this.core.notifier.notify(title, body);
			record("toast", "unknown", null);
			return;
		}
		const deliveryId = `d_${randomUUID().slice(0, 8)}`;
		this.db.run("INSERT INTO deliveries(id, run_id, channel, status, detail, created_at) VALUES(?, ?, 'toast', 'unknown', NULL, ?)", deliveryId, run.id, now());
		void pending.then((status) => {
			try {
				this.db.run("UPDATE deliveries SET status = ? WHERE id = ?", status, deliveryId);
			} catch {}
		});
	}

	// ---- tool policy and tools ---------------------------------------------------------

	/**
	 * During a scheduled run only read-only tools and the schedule's allowed
	 * tools run, without dialogs. Memory tools may only propose (explicit=false
	 * makes a candidate the user confirms); nobody asked the agent to remember.
	 */
	toolPolicy(slot: Slot, tool: string, input: Record<string, unknown> = {}): "allow" | "deny" | undefined {
		const runId = this.active.get(slot.slotId);
		if (!runId) return undefined;
		if (isReadOnlyCall(tool, input) || SCHEDULE_TOOLS.includes(tool) || tool === "skill_propose") return "allow";
		if (tool.startsWith("memory_") && input.explicit !== true) return "allow";
		const schedule = this.get(this.getRun(runId)?.scheduleId ?? "");
		const allowed = schedule?.allowedTools ?? [];
		// Older schedules name the shell "bash" or "powershell"; the agent modes call it "pwsh".
		const shellAllowed = SHELL_TOOLS.has(tool) && allowed.some((t) => SHELL_TOOLS.has(t));
		return allowed.includes(tool) || shellAllowed ? "allow" : "deny";
	}

	extensions(slot: { slotId: string }): ExtensionFactory[] {
		const module = this;
		const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
		return [
			(pi: ExtensionAPI) => {
				pi.registerTool({
					name: "schedule_state",
					label: "保存定时任务状态",
					description: "Only inside a scheduled run: save a small JSON object (merged into the schedule's state) that the next run of this schedule receives, e.g. the last checked values.",
					parameters: { type: "object", properties: { state: { type: "object", description: "Keys to set; null removes a key" } }, required: ["state"] } as never,
					async execute(_id, params: { state: Record<string, unknown> }) {
						const runId = module.active.get(slot.slotId);
						const run = runId ? module.getRun(runId) : undefined;
						const schedule = run ? module.get(run.scheduleId) : undefined;
						if (!schedule) return text("现在不是定时任务的运行，没有保存。");
						const next = { ...schedule.state };
						for (const [k, v] of Object.entries(params.state ?? {})) {
							if (v === null) delete next[k];
							else next[k] = v;
						}
						const serialized = json(next);
						if (serialized.length > 4000) return text("状态太大（上限 4000 字符），请只保存关键结果。");
						module.db.run("UPDATE schedules SET state = ? WHERE id = ?", serialized, schedule.id);
						return text("已保存。");
					},
				});
				pi.registerTool({
					name: "schedule_create",
					label: "创建定时任务",
					description:
						"Propose a scheduled task when the user asks for something to happen later or repeatedly. The user approves it before it runs. trigger: once (at: ISO time), interval (every_minutes ≥ 10) or cron (5-field cron, timezone IANA). kind: task, report or monitor (monitor = only report changes).",
					parameters: {
						type: "object",
						properties: {
							name: { type: "string" },
							prompt: { type: "string", description: "What to do each time, self-contained" },
							kind: { type: "string", enum: ["task", "report", "monitor"] },
							trigger: { type: "string", enum: ["once", "interval", "cron"] },
							at: { type: "string", description: "once: ISO 8601 time" },
							every_minutes: { type: "number" },
							cron: { type: "string" },
							timezone: { type: "string" },
						},
						required: ["name", "prompt", "trigger"],
					} as never,
					async execute(_id, params: { name: string; prompt: string; kind?: ScheduleKind; trigger: TriggerType; at?: string; every_minutes?: number; cron?: string; timezone?: string }) {
						const live = module.core.slots.get(slot.slotId);
						try {
							const trigger: Trigger =
								params.trigger === "once"
									? { type: "once", at: params.at ? Date.parse(params.at) : undefined }
									: params.trigger === "interval"
										? { type: "interval", everyMs: Math.round((params.every_minutes ?? 0) * 60_000) }
										: { type: "cron", cron: params.cron, timezone: params.timezone };
							const schedule = module.save({ name: params.name, prompt: params.prompt, kind: params.kind, trigger, cwd: live?.cwd ?? process.cwd(), createdBy: "agent" });
							if (!module.core.clients.size && module.core.settings.get().notifications) module.core.notifier.notify("Agent 想创建一个定时任务", schedule.name);
							return text(`已提交给用户确认（${module.describeTrigger(schedule.trigger)}）。用户批准后才会开始。`);
						} catch (error) {
							return text(`没有创建：${error instanceof Error ? error.message : String(error)}`);
						}
					},
				});
			},
		];
	}

	// ---- methods -----------------------------------------------------------------------

	private register(): void {
		const core = this.core;
		const trigger = (v: unknown): Trigger | undefined => {
			if (!v || typeof v !== "object") return undefined;
			const t = v as Record<string, unknown>;
			const type = (["once", "interval", "cron"] as const).find((x) => x === t.type);
			if (!type) return undefined;
			return { type, at: num(t.at), everyMs: num(t.everyMs), anchor: num(t.anchor), cron: str(t.cron), timezone: str(t.timezone) };
		};
		const withRuns = (s: Schedule) => ({ ...s, describe: this.describeTrigger(s.trigger), lastRun: this.runs(s.id, 1)[0] ?? null });
		core.register("schedules.list", () => this.list().map(withRuns));
		core.register("schedules.get", (p) => {
			const s = this.get(requireStr(p.id, "id"));
			if (!s) throw new RpcError("not_found", "这个定时任务不存在");
			return { ...withRuns(s), runs: this.runs(s.id) };
		});
		core.register("schedules.save", (p) =>
			withRuns(
				this.save({
					id: str(p.id),
					name: str(p.name),
					prompt: str(p.prompt),
					cwd: str(p.cwd),
					kind: str(p.kind) as ScheduleKind | undefined,
					trigger: trigger(p.trigger),
					missedPolicy: str(p.missedPolicy) as MissedPolicy | undefined,
					sessionMode: p.sessionMode === "bound" ? "bound" : p.sessionMode === "fresh" ? "fresh" : undefined,
					sessionFile: str(p.sessionFile),
					allowedTools: Array.isArray(p.allowedTools) ? p.allowedTools.filter((x): x is string => typeof x === "string") : p.allowedTools === null ? null : undefined,
				}),
			),
		);
		core.register("schedules.setStatus", (p) => {
			const status = (["active", "paused", "rejected"] as const).find((s) => s === p.status);
			if (!status) throw new RpcError("bad_request", "status must be active, paused or rejected");
			return withRuns(this.setStatus(requireStr(p.id, "id"), status));
		});
		core.register("schedules.remove", (p) => {
			this.remove(requireStr(p.id, "id"));
			return { ok: true };
		});
		core.register("schedules.runNow", (p) => this.runNow(requireStr(p.id, "id")));
		core.register("schedules.preview", (p) => {
			const t = trigger(p.trigger);
			if (!t) throw new RpcError("bad_request", "trigger is required");
			const problem = validateTrigger(t);
			if (problem) return { error: problem, next: [] };
			const out: number[] = [];
			for (let at: number | null = this.clock() - 1; out.length < 3; ) {
				at = nextOccurrence(t.type === "interval" && t.anchor === undefined ? { ...t, anchor: this.clock() + (t.everyMs ?? 0) } : t, at);
				if (at === null) break;
				out.push(at);
			}
			return { error: null, next: out };
		});
		core.register("schedules.defaults", () => ({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
		core.register("schedules.tick", async (p) => {
			await this.tick(num(p.now) ?? this.clock());
			return { ok: true };
		});
	}
}

/** How many times came due from [first] to [at], and the most recent one. */
export function dueTimes(trigger: Trigger, first: number, at: number): { count: number; latest: number } {
	if (trigger.type === "interval" && trigger.everyMs && trigger.everyMs > 0) {
		const count = Math.floor((at - first) / trigger.everyMs) + 1;
		return { count, latest: first + (count - 1) * trigger.everyMs };
	}
	let count = 0;
	let latest = first;
	for (let t: number | null = first; t !== null && t <= at; t = nextOccurrence(trigger, t)) {
		latest = t;
		count++;
		if (count === 50_000) {
			// Very long gap: skip ahead and find the latest time from two days back.
			const near = nextOccurrence(trigger, Math.max(t, at - 2 * 86_400_000));
			if (near === null || near > at) break;
			t = near;
			latest = near;
		}
	}
	return { count, latest };
}
