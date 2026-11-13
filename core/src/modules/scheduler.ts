import { randomUUID } from "node:crypto";
import type { AgentSessionEvent, ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Cron, CronPattern } from "croner";
import type { Core, CoreModule } from "../core.ts";
import { num, RpcError, requireStr, str } from "../core.ts";
import type { Db } from "../db.ts";
import { json, now, parseJson } from "../db.ts";
import { isReadOnlyCall, READ_ONLY_TOOLS, SHELL_TOOLS } from "../ext/approval.ts";
import { recordedSandbox } from "../pi/host.ts";
import type { Run } from "../runs.ts";
import { textOf } from "../runs.ts";
import type { Slot } from "../slots/slot.ts";
import { backfillScheduleOwners, scheduleOwner } from "../t95-migration.ts";
import { backfillScheduleCreators } from "../t96-migration.ts";
import { GoalsModule } from "./goals.ts";
import type { TasksModule } from "./tasks.ts";
import type { Notice } from "../notify.ts";

export type TriggerType = "once" | "interval" | "cron";
/** task = do something; report = produce a result each time; monitor = check for changes, quiet when nothing changed. */
export type ScheduleKind = "task" | "report" | "monitor" | "reminder";
/** What a report does with missed times: skip them, or catch up the most recent one. */
export type MissedPolicy = "skip" | "latest";
export type ScheduleStatus = "active" | "paused" | "pending_approval" | "finished" | "rejected";
export type ScheduleRunStatus = "waiting" | "running" | "needs_input" | "done" | "no_change" | "failed" | "interrupted" | "skipped";
export type DeliveryStatus = "delivered" | "undelivered" | "unknown";
type ScheduleRole = "user" | "butterfly" | "patrol";
const DAY_MS = 86_400_000;

export interface Trigger {
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

export interface Schedule {
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

type EveryDay = { times: string[] } | { everyMs: number };
type ScheduleChangeStatus = "applied" | "proposed" | "rejected";
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

interface ScheduleChangeRow {
	id: string;
	schedule_id: string;
	version_before: number;
	version_after: number;
	actor: ScheduleRole;
	reason: string;
	before: string | null;
	after: string | null;
	summary: string;
	at: number;
	undone_at: number | null;
	status: ScheduleChangeStatus;
}

function toChange(row: ScheduleChangeRow): ScheduleChange {
	return {
		id: row.id, scheduleId: row.schedule_id, versionBefore: row.version_before, versionAfter: row.version_after,
		actor: row.actor, reason: row.reason, before: parseJson(row.before, null), after: parseJson(row.after, null),
		summary: row.summary, at: row.at, undoneAt: row.undone_at, status: row.status,
	};
}

interface ScheduleOccurrence {
	scheduleId: string;
	at: number;
	status: Exclude<ScheduleRunStatus, "waiting"> | "upcoming";
	runId: string | null;
	result: string | null;
	error: string | null;
}

type ScheduleInput = Partial<Schedule> & { expectedVersion?: number; reason?: string };

interface ToolScheduleInput {
	name?: string;
	prompt?: string;
	kind?: ScheduleKind;
	trigger?: TriggerType | "daily" | "weekly";
	times?: string[];
	weekdays?: number[];
	at?: string;
	every_minutes?: number;
	cron?: string;
	timezone?: string;
	missedPolicy?: MissedPolicy;
	reason?: string;
}

const TOOL_SCHEDULE_PROPERTIES = {
	name: { type: "string" },
	prompt: { type: "string", description: "What to do each time, or the optional second line of a reminder" },
	kind: { type: "string", enum: ["task", "report", "monitor", "reminder"] },
	trigger: { type: "string", enum: ["once", "interval", "daily", "weekly", "cron"] },
	times: { type: "array", items: { type: "string" }, description: "daily/weekly: one or more HH:mm times" },
	weekdays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "weekly: 0 = Sunday, 1 = Monday, ..., 6 = Saturday" },
	at: { type: "string", description: "once: ISO 8601 time" },
	every_minutes: { type: "number", description: "interval: at least 10 minutes" },
	cron: { type: "string", description: "cron: five-field expression" },
	timezone: { type: "string", description: "IANA timezone. Defaults to the local timezone." },
	missedPolicy: { type: "string", enum: ["skip", "latest"] },
	reason: { type: "string" },
};

function toolSchedulePatch(input: ToolScheduleInput): ScheduleInput {
	let trigger: Trigger | undefined;
	switch (input.trigger) {
		case "once": trigger = { type: "once", at: input.at ? Date.parse(input.at) : undefined }; break;
		case "interval": trigger = { type: "interval", everyMs: Math.round((input.every_minutes ?? 0) * 60_000) }; break;
		case "cron": trigger = { type: "cron", cron: input.cron, timezone: input.timezone }; break;
		case "daily": case "weekly": {
			const times = input.times;
			const weekdays = input.weekdays ?? [];
			if (!times?.length || times.some(time => !/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(time))) throw new RpcError("bad_request", "请填写有效的时间（时:分）");
			if (input.trigger === "weekly" && (!weekdays.length || weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6))) throw new RpcError("bad_request", "请填写每周的日期（星期日为 0）");
			const byMinute = new Map<number, Set<number>>();
			const minutes = new Set<number>();
			for (const time of times) {
				const [hour, minute] = time.split(":").map(Number) as [number, number];
				minutes.add(hour * 60 + minute);
				const hours = byMinute.get(minute) ?? new Set<number>();
				hours.add(hour);
				byMinute.set(minute, hours);
			}
			const weekly = input.trigger === "weekly";
			const days = weekly ? [...new Set(weekdays)].sort((a, b) => a - b) : [0];
			const offsets = days.flatMap(day => [...minutes].sort((a, b) => a - b).map(minute => day * 1440 + minute));
			const nextCycle = offsets[0]! + (weekly ? 7 : 1) * 1440;
			if (offsets.some((offset, i) => ((offsets[i + 1] ?? nextCycle) - offset) * 60_000 < MIN_AGENT_INTERVAL_MS)) {
				throw new RpcError("bad_request", "两次执行至少间隔 10 分钟");
			}
			const expressions = [...byMinute].sort(([a], [b]) => a - b).map(([minute, hours]) => `${minute} ${[...hours].sort((a, b) => a - b).join(",")} * * ${weekly ? days.join(",") : "*"}`);
			trigger = { type: "cron", timezone: input.timezone, ...(expressions.length === 1 ? { cron: expressions[0] } : { crons: expressions }) };
			break;
		}
	}
	return { name: input.name, prompt: input.prompt, kind: input.kind, trigger, missedPolicy: input.missedPolicy };
}

function expectedVersion(value: unknown, required = false): number | undefined {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new RpcError("bad_request", "请提供有效的日程版本号");
	return value;
}

function toolText(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function toolError(error: unknown) {
	return toolText(error instanceof Error ? error.message : String(error));
}

function toolResult(schedule: Schedule, action: "created" | "updated" | "removed" | "proposed" | "ran", line: string) {
	return toolText(line, { scheduleId: schedule.id, action, line });
}

/** Late by more than this = missed (the computer was off or asleep). */
export const MISSED_GRACE_MS = 2 * 60_000;
/** Shortest period for schedules the agent creates. */
export const MIN_AGENT_INTERVAL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS = [60_000, 5 * 60_000];
const NO_CHANGE = /^\s*[【\[]?无变化[】\]]?/;
const WORKBENCH_STATE_TOOL = "save_monitor_state";
const SAFE_SCHEDULE_TOOLS = new Set(["schedule_state", "schedule_list", WORKBENCH_STATE_TOOL]);
const TOOL_VERSION_CONFLICT = "这件事刚被改过，请先用 schedule_list 重新读一次";

interface ScheduleRow {
	id: string;
	name: string;
	prompt: string;
	cwd: string;
	owner: Schedule["owner"];
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
	created_role: ScheduleRole;
	created_at: number;
	updated_at: number;
}

function toSchedule(row: ScheduleRow): Schedule {
	return {
		id: row.id,
		name: row.name,
		prompt: row.prompt,
		cwd: row.cwd,
		owner: row.owner,
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
		createdRole: row.created_role,
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
	return occurrenceRule(trigger)(after);
}

function occurrenceRule(trigger: Trigger): (after: number) => number | null {
	switch (trigger.type) {
		case "once":
			return (after) => trigger.at !== undefined && trigger.at > after ? trigger.at : null;
		case "interval": {
			const every = trigger.everyMs ?? 0;
			return (after) => {
				if (every <= 0) return null;
				const anchor = trigger.anchor ?? after;
				if (anchor > after) return anchor;
				return anchor + (Math.floor((after - anchor) / every) + 1) * every;
			};
		}
		case "cron": {
			const rules = cronExpressions(trigger).map(expression => new Cron(expression, { timezone: trigger.timezone || undefined }));
			return (after) => {
				let first: number | null = null;
				const date = new Date(after);
				for (const rule of rules) {
					const next = rule.nextRun(date)?.getTime();
					if (next !== undefined && (first === null || next < first)) first = next;
				}
				return first;
			};
		}
	}
}

function cronExpressions(trigger: Trigger): string[] {
	return trigger.crons ?? [trigger.cron ?? ""];
}

function everyDay(trigger: Trigger): EveryDay | null {
	if (trigger.type === "interval" && trigger.everyMs && trigger.everyMs < DAY_MS) return { everyMs: trigger.everyMs };
	if (trigger.type !== "cron") return null;
	if (cronExpressions(trigger).some(expression => !/^(?:\S+\s+){2}\*\s+\*\s+\*$/.test(expression.trim()))) return null;
	return { times: cronClockTimes(trigger) };
}

function cronClockTimes(trigger: Trigger): string[] {
	const times = new Set<string>();
	for (const expression of cronExpressions(trigger)) {
		const { hour, minute } = new CronPattern(expression, trigger.timezone);
		for (let h = 0; h < hour.length; h++) {
			if (!hour[h]) continue;
			for (let m = 0; m < minute.length; m++) {
				if (minute[m]) times.add(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
			}
		}
	}
	return [...times].sort();
}

/** Checks a trigger and returns why it is invalid (or null). */
export function validateTrigger(trigger: Trigger, options: { minIntervalMs?: number; at?: number } = {}): string | null {
	const at = options.at ?? now();
	switch (trigger.type) {
		case "once":
			if (!trigger.at || !Number.isFinite(new Date(trigger.at).getTime())) return "请设置执行时间";
			return null;
		case "interval":
			if (trigger.everyMs === undefined || !Number.isSafeInteger(trigger.everyMs) || trigger.everyMs < 60_000) return "间隔至少 1 分钟";
			if (options.minIntervalMs && trigger.everyMs < options.minIntervalMs) return `间隔至少 ${options.minIntervalMs / 60_000} 分钟`;
			return null;
		case "cron": {
			try {
				if (trigger.crons && (trigger.crons.length === 0 || trigger.crons.length > 60 || trigger.crons.some(expression => expression.trim().split(/\s+/).length !== 5))) return "请提供有效的五字段日历规则";
				const next = occurrenceRule(trigger);
				let previous = next(at);
				if (previous === null) return "这个日历规则不会再触发";
				if (options.minIntervalMs) {
					for (let i = 1; i < 3; i++) {
						const following = next(previous);
						if (following === null) break;
						if (following - previous < options.minIntervalMs) return `两次执行至少间隔 ${options.minIntervalMs / 60_000} 分钟`;
						previous = following;
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
 * per-schedule tools and state; quiet monitors; reminders and a versioned
 * history of changes made by the user and 蝶君.
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
		backfillScheduleOwners(this.db, core.paths.butterflyDir);
		backfillScheduleCreators(this.db);
		core.exemptFromApproval(...SAFE_SCHEDULE_TOOLS);
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
			tables: ["schedules", "schedule_runs", "deliveries", "schedule_changes"],
			paths: { schedules: { cwd: "path", session_file: "path" }, schedule_runs: { session_file: "path" }, schedule_changes: { before: "json", after: "json" } },
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
			case "cron": {
				const daily = everyDay(trigger);
				if (daily && "times" in daily) return `每天 ${daily.times.map(time => time.replace(/^0/, "")).join("、")}`;
				const expressions = cronExpressions(trigger);
				const weekdays = expressions[0]?.trim().match(/^\S+\s+\S+\s+\*\s+\*\s+([0-6](?:,[0-6])*)$/)?.[1];
				if (weekdays && expressions.every(expression => expression.trim().split(/\s+/).slice(2).join(" ") === `* * ${weekdays}`)) {
					const days = weekdays.split(",").map(day => "日一二三四五六"[Number(day)]).join("、");
					return `每周${days} ${cronClockTimes(trigger).map(time => time.replace(/^0/, "")).join("、")}`;
				}
				return `按日历：${expressions.join(" / ")}（${trigger.timezone || "本地时区"}）`;
			}
		}
	}

	private view(schedule: Schedule) {
		return { ...schedule, describe: this.describeTrigger(schedule.trigger), everyDay: everyDay(schedule.trigger), lastRun: this.runs(schedule.id, 1)[0] ?? null };
	}

	private checkVersion(schedule: Schedule | undefined, expectedVersion?: number, message = "这件事刚被别人改过"): void {
		if (expectedVersion !== undefined && expectedVersion !== schedule?.version) {
			throw new RpcError("version_conflict", message, schedule ? this.view(schedule) : null);
		}
	}

	save(input: ScheduleInput, actor: ScheduleRole = "user"): Schedule {
		const existing = input.id ? this.get(input.id) : undefined;
		this.checkVersion(existing, input.expectedVersion);
		if (input.id && !existing) throw new RpcError("not_found", "这个定时任务不存在");
		const schedule = this.prepareSave(input, existing, actor);
		this.applyChange(this.makeChange(existing ?? null, schedule, actor, input.reason ?? "save"));
		return schedule;
	}

	private prepareSave(input: ScheduleInput, existing: Schedule | undefined, actor: ScheduleRole): Schedule {
		const name = (input.name ?? existing?.name ?? "").trim();
		const prompt = (input.prompt ?? existing?.prompt ?? "").trim();
		const cwd = input.cwd ?? existing?.cwd ?? this.core.paths.butterflyDir;
		const kind = (["task", "report", "monitor", "reminder"] as const).find((k) => k === (input.kind ?? existing?.kind)) ?? "task";
		if (!name) throw new RpcError("bad_request", "请填写名称");
		if (!prompt && kind !== "reminder") throw new RpcError("bad_request", "请填写要做的事");
		if (!cwd) throw new RpcError("bad_request", "缺少工作区");
		const trigger: Trigger = { ...(input.trigger ?? existing?.trigger ?? { type: "once" }) };
		const createdRole = existing?.createdRole ?? actor;
		const createdBy = existing?.createdBy ?? (createdRole === "user" ? "user" : "agent");
		const at = this.clock();
		if (trigger.type === "interval" && trigger.anchor === undefined) trigger.anchor = at + (trigger.everyMs ?? 0);
		if (trigger.type === "cron" && !trigger.timezone) trigger.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const problem = validateTrigger(trigger, { minIntervalMs: (input.trigger || !existing) && actor !== "user" ? MIN_AGENT_INTERVAL_MS : undefined, at });
		if (problem) throw new RpcError("bad_request", problem);
		const sessionMode = (input.sessionMode ?? existing?.sessionMode) === "bound" ? "bound" : "fresh";
		const sessionFile = sessionMode === "bound" ? (input.sessionFile ?? existing?.sessionFile ?? null) : null;
		if (sessionMode === "bound" && !sessionFile) throw new RpcError("bad_request", "绑定会话时需要指定会话");
		if (sessionFile) this.core.assertTaskSession(sessionFile);
		const owner = input.owner ?? (existing && existing.cwd === cwd && existing.sessionFile === sessionFile
			? existing.owner : scheduleOwner(this.core.paths.butterflyDir, cwd, sessionFile));
		const status = input.status ?? (existing?.status === "finished" && input.trigger ? "active" : existing?.status) ?? "active";
		const nextRunAt = status === "active" ? nextOccurrence(trigger, at - 1) : null;
		if (input.status === "active" && nextRunAt === null && trigger.type === "once") throw new RpcError("bad_request", "执行时间已经过了，请先修改时间");
		return {
			id: existing?.id ?? `s_${randomUUID().slice(0, 8)}`,
			name,
			prompt,
			cwd,
			owner,
			kind,
			trigger,
			missedPolicy: input.missedPolicy ?? existing?.missedPolicy ?? this.core.settings.get().scheduleMissedDefault,
			sessionMode,
			sessionFile,
			allowedTools: input.allowedTools !== undefined ? input.allowedTools : (existing?.allowedTools ?? null),
			state: existing?.state ?? {},
			status,
			version: (existing?.version ?? 0) + 1,
			nextRunAt: status === "active" ? nextRunAt : null,
			lastRunAt: existing?.lastRunAt ?? null,
			createdBy,
			createdRole,
			createdAt: existing?.createdAt ?? at,
			updatedAt: at,
		};
	}

	private writeSchedule(schedule: Schedule): void {
		this.db.run(
			`INSERT INTO schedules(id, name, prompt, cwd, kind, trigger, missed_policy, session_mode, session_file, allowed_tools, state, status, version, next_run_at, last_run_at, created_by, created_at, updated_at, owner, created_role)
			 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, cwd = excluded.cwd, kind = excluded.kind, trigger = excluded.trigger,
			 missed_policy = excluded.missed_policy, session_mode = excluded.session_mode, session_file = excluded.session_file, allowed_tools = excluded.allowed_tools,
			 status = excluded.status, version = excluded.version, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at, owner = excluded.owner, pending_at = NULL`,
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
			schedule.owner,
			schedule.createdRole,
		);
	}

	/** Pause, resume, approve or reject; resuming recomputes the next time from now. */
	setStatus(id: string, status: ScheduleStatus, expectedVersion?: number): Schedule {
		const schedule = this.get(id);
		this.checkVersion(schedule, expectedVersion);
		if (!schedule) throw new RpcError("not_found", "这个定时任务不存在");
		const at = this.clock();
		const next = status === "active" ? nextOccurrence(schedule.trigger, at - 1) : null;
		if (status === "active" && next === null && schedule.trigger.type === "once") throw new RpcError("bad_request", "执行时间已经过了，请先修改时间");
		const after = { ...schedule, status, nextRunAt: next, version: schedule.version + 1, updatedAt: at };
		this.applyChange(this.makeChange(schedule, after, "user", "status"));
		return after;
	}

	remove(id: string, expectedVersion?: number, actor: ScheduleRole = "user", reason = "remove"): void {
		const schedule = this.get(id);
		this.checkVersion(schedule, expectedVersion);
		if (schedule) this.applyChange(this.makeChange(schedule, null, actor, reason));
	}

	private summary(before: Schedule | null, after: Schedule | null): string {
		if (!before) return "新建";
		if (!after) return "删除";
		if (before.status !== after.status) {
			if (after.status === "paused") return "暂停";
			if (after.status === "active") return "启用";
			if (after.status === "rejected") return "拒绝";
		}
		if (json(before.trigger) !== json(after.trigger)) return `把时间从${this.describeTrigger(before.trigger)}改成${this.describeTrigger(after.trigger)}`;
		if (before.name !== after.name) return `把名称从「${before.name}」改成「${after.name}」`;
		return `修改「${after.name}」`;
	}

	private makeChange(before: Schedule | null, after: Schedule | null, actor: ScheduleRole, reason: string, versionBefore = before?.version ?? 0): ScheduleChange {
		const summary = this.summary(before, after);
		return {
			id: randomUUID(), scheduleId: (after ?? before)!.id, versionBefore, versionAfter: versionBefore + 1,
			actor, reason, before, after, summary: reason === "undo" ? `撤销改动，${summary}` : summary,
			at: this.clock(), undoneAt: null, status: "applied",
		};
	}

	private insertChange(change: ScheduleChange): void {
		this.db.run(`INSERT INTO schedule_changes(id, schedule_id, version_before, version_after, actor, reason, before, after, summary, at, status)
			VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		change.id, change.scheduleId, change.versionBefore, change.versionAfter, change.actor, change.reason,
		change.before && json(change.before), change.after && json(change.after), change.summary, change.at, change.status);
	}

	private applyChange(change: ScheduleChange, options: { undoId?: string; proposed?: boolean } = {}): void {
		this.db.transaction(() => {
			if (change.after) this.writeSchedule(change.after);
			else this.db.run("DELETE FROM schedules WHERE id = ?", change.scheduleId);
			if (options.proposed) {
				this.db.run("UPDATE schedule_changes SET status = 'applied', before = ?, after = ? WHERE id = ?", change.before && json(change.before), change.after && json(change.after), change.id);
			} else this.insertChange(change);
			if (options.undoId) this.db.run("UPDATE schedule_changes SET undone_at = ? WHERE id = ?", change.at, options.undoId);
		});
		this.changed([{ id: change.scheduleId, version: change.versionAfter }]);
	}

	private history(id: string): ScheduleChange[] {
		return this.db.all<ScheduleChangeRow>("SELECT * FROM schedule_changes WHERE schedule_id = ? ORDER BY at DESC, rowid DESC", id).map(toChange);
	}

	private change(id: string): ScheduleChange | undefined {
		const row = this.db.get<ScheduleChangeRow>("SELECT * FROM schedule_changes WHERE id = ?", id);
		return row && toChange(row);
	}

	private deletion(id: string): ScheduleChange | undefined {
		const row = this.db.get<ScheduleChangeRow>(`SELECT * FROM schedule_changes
			WHERE schedule_id = ? AND status = 'applied' AND after IS NULL ORDER BY version_after DESC LIMIT 1`, id);
		return row && toChange(row);
	}

	private reschedule(snapshot: Schedule, current: Schedule | null, version: number): Schedule {
		const at = this.clock();
		return {
			...snapshot, version, updatedAt: at,
			state: current?.state ?? snapshot.state,
			lastRunAt: current ? current.lastRunAt : snapshot.lastRunAt,
			nextRunAt: snapshot.status === "active" ? nextOccurrence(snapshot.trigger, at - 1) : null,
		};
	}

	private undo(changeId: string) {
		const change = this.change(changeId);
		if (!change || change.status !== "applied") throw new RpcError("not_found", "没有可撤销的日程改动");
		const current = this.get(change.scheduleId);
		const version = current?.version ?? this.deletion(change.scheduleId)?.versionAfter;
		if (version !== change.versionAfter || change.undoneAt !== null) {
			throw new RpcError("version_conflict", "这件事刚被别人改过", current ? this.view(current) : null);
		}
		const restored = change.before && this.reschedule(change.before, current ?? null, version + 1);
		this.applyChange(this.makeChange(current ?? null, restored, "user", "undo", version), { undoId: change.id });
		return restored ? this.view(restored) : { ok: true };
	}

	proposedChanges(): ScheduleChange[] {
		return this.db.all<ScheduleChangeRow>("SELECT * FROM schedule_changes WHERE status = 'proposed' ORDER BY at DESC, rowid DESC").map(toChange);
	}

	private propose(before: Schedule, after: Schedule | null, reason: string, actor: "butterfly" | "patrol"): void {
		const change = { ...this.makeChange(before, after, actor, reason), status: "proposed" as const };
		this.insertChange(change);
		this.changed([before]);
		this.core.notifications.publish("butterfly.waiting", {
			title: "蝶君有件事等你决定", body: change.summary, target: { page: "attention", itemId: `schedule_change:${change.id}` },
		});
	}

	resolveChange(id: string, approve: boolean) {
		const change = this.change(id);
		if (!change || change.status !== "proposed") throw new RpcError("gone", "这项日程改动已经处理过了");
		const current = this.get(change.scheduleId);
		if (!approve || !current || current.version !== change.versionBefore) {
			this.db.run("UPDATE schedule_changes SET status = 'rejected' WHERE id = ?", id);
			this.changed([{ id: change.scheduleId, version: current?.version ?? this.deletion(change.scheduleId)?.versionAfter ?? change.versionBefore }]);
			if (approve) throw new RpcError("version_conflict", "这件事在你同意前又被改过");
			return { ok: true };
		}
		const after = change.after && this.reschedule(change.after, current, change.versionAfter);
		this.applyChange({ ...change, before: current, after }, { proposed: true });
		return after ? this.view(after) : { ok: true };
	}

	private changed(schedules: readonly Pick<Schedule, "id" | "version">[], runId?: string): void {
		const versions = Object.fromEntries(schedules.map(s => [s.id, s.version]));
		this.core.broadcast({ event: "schedules.changed", ids: Object.keys(versions), versions, ...(runId ? { runId } : {}) });
	}

	private occurrences(from: unknown, to: unknown, includeEveryDay = true) {
		if (typeof from !== "number" || typeof to !== "number" || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)
			|| Math.abs(from) > 8.64e15 || Math.abs(to) > 8.64e15 || to <= from || to - from > 45 * DAY_MS) {
			throw new RpcError("bad_request", "请选择不超过 45 天的有效时间范围");
		}
		const at = this.clock();
		const schedules = new Map<string, Schedule>();
		const items: ScheduleOccurrence[] = [];
		const eligible = new Map<string, Schedule | undefined>();
		const find = (id: string) => {
			if (!eligible.has(id)) {
				const schedule = this.get(id) ?? this.deletion(id)?.before ?? undefined;
				eligible.set(id, schedule && (includeEveryDay || !everyDay(schedule.trigger)) ? schedule : undefined);
			}
			return eligible.get(id);
		};
		const runs = this.db.all<RunRow>("SELECT * FROM schedule_runs WHERE scheduled_at >= ? AND scheduled_at < ?", from, to);
		for (const run of runs) {
			const schedule = find(run.schedule_id);
			if (!schedule) continue;
			schedules.set(schedule.id, schedule);
			items.push({ scheduleId: schedule.id, at: run.scheduled_at!, status: run.status === "waiting" ? "running" : run.status as ScheduleOccurrence["status"], runId: run.id, result: run.result, error: run.error });
		}
		for (const schedule of this.list({ status: ["active"] })) {
			if (schedule.nextRunAt === null || schedule.nextRunAt >= to || !find(schedule.id)) continue;
			const next = occurrenceRule(schedule.trigger);
			for (let time = next(Math.max(at, from, schedule.nextRunAt) - 1); time !== null && time < to; time = next(time)) {
				schedules.set(schedule.id, schedule);
				items.push({ scheduleId: schedule.id, at: time, status: "upcoming", runId: null, result: null, error: null });
			}
		}
		items.sort((a, b) => a.at - b.at || a.scheduleId.localeCompare(b.scheduleId) || (a.runId ?? "").localeCompare(b.runId ?? ""));
		return { items, schedules: [...schedules.values()].map(schedule => this.view(schedule)) };
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
		const run = this.getRun(id);
		if (run) this.changed([{ id: run.scheduleId, version: this.get(run.scheduleId)?.version ?? this.deletion(run.scheduleId)?.versionAfter ?? run.version }], id);
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
		const advanced: Schedule[] = [];
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
			advanced.push(schedule);
			if (missed && schedule.missedPolicy === "skip" && (schedule.kind === "reminder" || schedule.trigger.type !== "once")) {
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
		if (advanced.length) this.changed(advanced);
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
		const stateTool = schedule.owner === "butterfly" ? "schedule_state" : WORKBENCH_STATE_TOOL;
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
			lines.push(`这是监控类任务：和上次保存的状态比较。如果没有值得报告的变化，回复的第一行只写「无变化」。无论有没有变化，结束前都用 ${stateTool} 工具保存这次检查的关键结果，供下次比较。检查失败时如实说明失败原因，不要写「无变化」。`);
		} else {
			lines.push(`没有人在旁边看着，不要提问，按最合理的方式完成。需要下次参考的信息可以用 ${stateTool} 工具保存。`);
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
			if (schedule.owner === "butterfly") this.core.autonomy.scheduleFired({
				scheduleId: schedule.id, triggerKey: run.triggerKey, at: run.scheduledAt ?? this.clock(), createdBy: schedule.createdBy,
			});
			const goalId = this.db.get<{ goal_id: string | null }>("SELECT goal_id FROM schedules WHERE id=?", schedule.id)?.goal_id;
			if (goalId) {
				const goals = this.core.module(GoalsModule)?.scheduler;
				if (!goals?.get(goalId)) {
					this.finishRun(run.id, "failed", { error: "找不到这项日程所关联的目标" });
					return;
				}
				goals.post(goalId, "schedule.fired", `schedule:${schedule.id}:${run.triggerKey}`, {
					scheduleId: schedule.id, scheduleRunId: run.id, version: run.version, scheduledAt: run.scheduledAt,
				});
				const at = this.clock();
				this.updateRun(run.id, { status: "done", started_at: at, ended_at: at, retry_at: null, result: "已交给目标调度者" });
				this.db.run("UPDATE schedules SET last_run_at=? WHERE id=?", at, schedule.id);
				return;
			}
			if (schedule.kind === "reminder") {
				const at = this.clock();
				this.db.run("UPDATE schedule_runs SET started_at = ?, retry_at = NULL WHERE id = ?", at, run.id);
				this.db.run("UPDATE schedules SET last_run_at = ? WHERE id = ?", at, schedule.id);
				this.finishRun(run.id, "done", { result: "已提醒", cost: 0 });
			} else await this.launch(run, schedule);
		} finally {
			this.starting.delete(schedule.id);
		}
	}

	private async launch(run: ScheduleRun, schedule: Schedule): Promise<void> {
		const sandbox = schedule.owner === "butterfly";
		const cwd = sandbox ? this.core.paths.butterflyDir : schedule.cwd;
		if (sandbox) {
			try {
				const provider = this.core.sandboxProvider?.();
				if (!provider) throw new Error("sandbox unavailable");
				await provider.ready();
			} catch {
				this.finishRun(run.id, "failed", { error: "蝶君的沙箱还没准备好" });
				return;
			}
			if (!this.stillWanted(run)) {
				this.updateRun(run.id, { status: "skipped", ended_at: this.clock(), note: "计划已修改、暂停或删除，这次触发作废" });
				return;
			}
			if (this.core.maintenance) {
				this.updateRun(run.id, { retry_at: this.clock() + 60_000, note: `${this.core.maintenance}，稍后重试` });
				return;
			}
		}
		// Recheck persisted schedules too, before creating any general task.
		try {
			if (schedule.sessionMode === "bound" && schedule.sessionFile) this.core.assertTaskSession(schedule.sessionFile);
		} catch (error) {
			this.finishRun(run.id, "failed", { error: error instanceof Error ? error.message : String(error) });
			return;
		}
		const task = run.taskId ? this.tasks.get(run.taskId) : undefined;
		const taskId = task?.id ?? this.tasks.create({ cwd, goal: schedule.prompt, title: `定时：${schedule.name}`, source: "schedule", scheduleId: schedule.id }).id;
		let slot: Slot;
		try {
			slot = await this.core.openSlot({
				cwd,
				sandbox,
				sessionFile: schedule.sessionMode === "bound" ? (schedule.sessionFile ?? undefined) : undefined,
				taskId,
				unattended: true,
				// Scheduled runs need their state tool from standard mode.
				agentMode: "standard",
			});
		} catch (error) {
			this.finishRun(run.id, "failed", { error: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (sandbox && !slot.sandboxed) {
			this.finishRun(run.id, "failed", { error: "绑定的会话不是蝶君的沙箱会话" });
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
		const internal = READ_ONLY_TOOLS.has(event.toolName) || SAFE_SCHEDULE_TOOLS.has(event.toolName) || event.toolName.startsWith("memory_") || event.toolName === "skill_propose";
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
		if (!record) return;
		const messages = slot.started ? (slot.session.messages as unknown as { role: string; content: unknown }[]) : [];
		const reply = [...messages].reverse().find((m) => m.role === "assistant");
		const result = reply ? textOf(reply.content).slice(0, 2000) : null;
		const limited = run.taskId ? this.db.get("SELECT 1 FROM notices WHERE task_id = ? AND status = 'pending'", run.taskId) : undefined;
		let status: ScheduleRunStatus;
		if (limited) status = "needs_input";
		else if (run.status === "failed") status = "failed";
		else if (run.status === "done") status = schedule?.kind === "monitor" && result && NO_CHANGE.test(result) ? "no_change" : "done";
		else status = "interrupted";

		const fresh = this.getRun(runId)!;
		if (status === "failed" && schedule && !fresh.externalEffects && fresh.attempt < MAX_ATTEMPTS) {
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
		void this.afterRun(record.scheduleId);
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
		const schedule = this.get(run.scheduleId) ?? this.deletion(run.scheduleId)?.before;
		const reminder = schedule?.kind === "reminder" && run.status === "done";
		const label =
			run.status === "failed"
				? `定时任务失败：${schedule?.name}`
				: run.status === "needs_input"
					? `定时任务需要你处理：${schedule?.name}`
					: run.status === "interrupted"
						? `定时任务已中断：${schedule?.name}`
						: `定时任务完成：${schedule?.name}`;
		const title = reminder ? "提醒" : schedule?.owner === "butterfly" ? `蝶君 · ${label}` : label;
		const body = reminder ? [schedule.name, schedule.prompt].filter(Boolean).join("\n")
			: (run.status === "failed" ? run.error : run.result)?.replace(/\s+/g, " ").slice(0, 200) ?? "";
		const record = (channel: Delivery["channel"], status: DeliveryStatus, detail: string | null, id = `d_${randomUUID().slice(0, 8)}`) =>
			this.db.run("INSERT INTO deliveries(id, run_id, channel, status, detail, created_at) VALUES(?, ?, ?, ?, ?, ?)", id, run.id, channel, status, detail, now());
		const notice: Notice = { key: `schedule:${run.id}:${run.status}`, objectRef: run.id,
			category: reminder ? "reminder" : run.status === "needs_input" ? "decision" : run.status === "done" ? "done" : "blocked",
			object: schedule?.name ?? "定时任务", situation: reminder ? "提醒" : label.split("：")[0]!,
			impact: body || (run.status === "done" ? "本次定时执行已结束" : "本次定时执行暂时不能继续"),
			action: reminder ? "查看日程" : "查看执行结果", target: { page: "schedule", itemId: run.id, runId: run.id } };
		const window = !reminder && this.core.clients.size > 0 ? (copy: { title: string; body: string }) => {
			record("window", "delivered", null);
			this.core.broadcast({ event: "schedules.delivered", runId: run.id, ...copy, target: notice.target });
		} : undefined;
		const deliveryId = `d_${randomUUID().slice(0, 8)}`;
		let started = false;
		void this.core.notifications.send(notice, { at: this.clock(), window, quiet: reminder ? "ignore" : undefined,
			started: window ? undefined : () => { record("toast", "unknown", null, deliveryId); started = true; },
			legacy: reminder || window ? { title, body } : undefined }).then(({ state, native, reason }) => {
			if (reason === "duplicate" || window && state === "sent") return;
			if (started) { this.db.run("UPDATE deliveries SET status=? WHERE id=?", native ?? "undelivered", deliveryId); return; }
			record(window ? "window" : "toast", native ?? "undelivered",
				reason === "notifications_disabled" ? "系统通知已关闭" : reason === "quiet_hours" ? "处于静默时段" : null);
		}).catch(error => this.core.log.warn("无法记录定时通知结果", error));
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
		if (isReadOnlyCall(tool, input) || SAFE_SCHEDULE_TOOLS.has(tool) || tool === "skill_propose") return "allow";
		if (tool.startsWith("memory_") && input.explicit !== true) return "allow";
		const schedule = this.get(this.getRun(runId)?.scheduleId ?? "");
		const allowed = schedule?.allowedTools ?? [];
		// Older schedules name the shell "bash" or "powershell"; the agent modes call it "pwsh".
		const shellAllowed = SHELL_TOOLS.has(tool) && allowed.some((t) => SHELL_TOOLS.has(t));
		return allowed.includes(tool) || shellAllowed ? "allow" : "deny";
	}

	extensions(slot: { slotId: string }): ExtensionFactory[] {
		return [pi => {
			pi.on("session_start", (_event, ctx) => {
				if (recordedSandbox(ctx.sessionManager)) {
					this.registerStateTool(pi, slot.slotId, "schedule_state");
					this.registerScheduleTools(pi, slot.slotId);
					return;
				}
				// Legacy workbench schedules can still save state during a scheduler run.
				let registered = false;
				pi.on("before_agent_start", () => {
					if (!this.active.has(slot.slotId)) return;
					if (!registered) {
						this.registerStateTool(pi, slot.slotId, WORKBENCH_STATE_TOOL);
						registered = true;
					} else if (!pi.getActiveTools().includes(WORKBENCH_STATE_TOOL)) {
						pi.setActiveTools([...pi.getActiveTools(), WORKBENCH_STATE_TOOL]);
					}
				});
				pi.on("agent_settled", () => {
					if (registered) pi.setActiveTools(pi.getActiveTools().filter(name => name !== WORKBENCH_STATE_TOOL));
				});
			});
		}];
	}

	private registerStateTool(pi: ExtensionAPI, slotId: string, name: string): void {
		pi.registerTool({
			name,
			label: "保存定时任务状态",
			description: "Inside a scheduled run, save a small JSON object for the next run. Null removes a key.",
			parameters: { type: "object", properties: { state: { type: "object" } }, required: ["state"] } as never,
			execute: async (_id, params: { state: Record<string, unknown> }) => {
				const run = this.getRun(this.active.get(slotId) ?? "");
				const schedule = run ? this.stillWanted(run) : undefined;
				if (!schedule) return toolText("现在没有可保存状态的定时任务运行。");
				const next = { ...schedule.state, ...params.state };
				for (const key of Object.keys(next)) if (next[key] === null) delete next[key];
				const serialized = json(next);
				if (serialized.length > 4000) return toolText("状态太大（上限 4000 字符），请只保存关键结果。");
				this.db.run("UPDATE schedules SET state = ? WHERE id = ?", serialized, schedule.id);
				return toolText("已保存。");
			},
		});
	}

	private registerScheduleTools(pi: ExtensionAPI, slotId: string): void {
		const verifySlot = () => {
			const slot = this.core.slots.get(slotId);
			if (!slot?.sandboxed) throw new RpcError("bad_request", "请在蝶君的沙箱会话里管理日程");
			return slot;
		};
		const actor = (): "butterfly" | "patrol" => verifySlot().session.sessionManager.getEntries()
			.some(entry => entry.type === "custom" && entry.customType === "df.patrol") ? "patrol" : "butterfly";
		const find = (id: string) => {
			verifySlot();
			const schedule = this.get(id);
			if (!schedule || schedule.owner !== "butterfly") throw new RpcError("not_found", "没有这件蝶君日程");
			return schedule;
		};
		const versioned = (params: { id: string; version: number }) => {
			verifySlot();
			const schedule = this.get(params.id);
			if (!schedule && this.deletion(params.id)?.before?.owner === "butterfly") throw new RpcError("version_conflict", TOOL_VERSION_CONFLICT);
			const current = find(params.id);
			this.checkVersion(current, expectedVersion(params.version, true), TOOL_VERSION_CONFLICT);
			return current;
		};
		const idProperty = { type: "string", description: "ID returned by schedule_list" };
		const versionProperty = { type: "integer", minimum: 1, description: "Version returned by schedule_list" };
		pi.registerTool({
			name: "schedule_create",
			label: "新建日程",
			description: "Create an active Butterfly schedule. Use reminder for a notification without a model run. Use daily/weekly with times, interval with every_minutes, once with at, or cron.",
			parameters: { type: "object", properties: TOOL_SCHEDULE_PROPERTIES, required: ["name", "trigger"] } as never,
			execute: async (_id, params: ToolScheduleInput) => {
				try {
					const schedule = this.save({ ...toolSchedulePatch(params), owner: "butterfly", reason: params.reason }, actor());
					return toolResult(schedule, "created", `已加入日程：${this.describeTrigger(schedule.trigger)} ${schedule.name}`);
				} catch (error) { return toolError(error); }
			},
		});
		pi.registerTool({
			name: "schedule_list",
			label: "查看日程",
			description: "Read Butterfly schedules and their current versions. Optionally supply both from and to (epoch ms, up to 45 days), or a status.",
			parameters: { type: "object", properties: {
				from: { type: "integer" }, to: { type: "integer" },
				status: { type: "string", enum: ["active", "paused", "pending_approval", "finished", "rejected"] },
			} } as never,
			execute: async (_id, params: { from?: number; to?: number; status?: ScheduleStatus }) => {
				try {
					verifySlot();
					const schedules = params.from !== undefined || params.to !== undefined
						? this.occurrences(params.from, params.to).schedules : this.list({ status: params.status ? [params.status] : undefined });
					const items = schedules
						.filter(s => s.owner === "butterfly" && this.get(s.id) && (!params.status || s.status === params.status))
						.map(s => ({ id: s.id, name: s.name, version: s.version, describe: this.describeTrigger(s.trigger), createdRole: s.createdRole, status: s.status, kind: s.kind }));
					return toolText(items.length ? json(items) : "没有符合条件的日程。", { items });
				} catch (error) { return toolError(error); }
			},
		});
		pi.registerTool({
			name: "schedule_update",
			label: "修改日程",
			description: "Edit a Butterfly schedule using its current version from schedule_list. User-created schedules need the user's approval.",
			parameters: { type: "object", properties: {
				...TOOL_SCHEDULE_PROPERTIES, id: idProperty, version: versionProperty,
				status: { type: "string", enum: ["active", "paused"] },
			}, required: ["id", "version"] } as never,
			execute: async (_id, params: ToolScheduleInput & { id: string; version: number; status?: "active" | "paused" }) => {
				try {
					const before = versioned(params);
					const role = actor();
					const after = this.prepareSave({ ...toolSchedulePatch(params), status: params.status }, before, role);
					const reason = params.reason ?? "update";
					if (before.createdRole === "user") {
						this.propose(before, after, reason, role);
						return toolResult(before, "proposed", `想改你建的「${before.name}」，已放进等你处理`);
					}
					const change = this.makeChange(before, after, role, reason);
					this.applyChange(change);
					const description = before.status !== after.status ? change.summary
						: json(before.trigger) !== json(after.trigger) ? `改成${this.describeTrigger(after.trigger)}`
							: before.name !== after.name ? `改名为「${after.name}」` : "已更新";
					return toolResult(after, "updated", `已改：「${before.name}」${description}`);
				} catch (error) { return toolError(error); }
			},
		});
		pi.registerTool({
			name: "schedule_remove",
			label: "删除日程",
			description: "Remove a Butterfly schedule using its current version from schedule_list. User-created schedules need approval.",
			parameters: { type: "object", properties: { id: idProperty, version: versionProperty, reason: { type: "string" } }, required: ["id", "version"] } as never,
			execute: async (_id, params: { id: string; version: number; reason?: string }) => {
				try {
					const schedule = versioned(params);
					const reason = params.reason ?? "remove";
					const role = actor();
					if (schedule.createdRole === "user") {
						this.propose(schedule, null, reason, role);
						return toolResult(schedule, "proposed", `想删你建的「${schedule.name}」，已放进等你处理`);
					}
					this.remove(schedule.id, params.version, role, reason);
					return toolResult(schedule, "removed", `已删除日程：${schedule.name}`);
				} catch (error) { return toolError(error); }
			},
		});
		pi.registerTool({
			name: "schedule_run_now",
			label: "立即执行日程",
			description: "Run one Butterfly schedule now without changing its next scheduled time. A reminder sends one notification.",
			parameters: { type: "object", properties: { id: idProperty }, required: ["id"] } as never,
			execute: async (_id, params: { id: string }) => {
				try {
					const schedule = find(params.id);
					const run = await this.runNow(schedule.id);
					if (run.status === "failed" || run.status === "skipped") return toolText(run.error ?? run.note ?? "这次日程没能执行。");
					return toolResult(schedule, "ran", schedule.kind === "reminder" ? `已提醒：${schedule.name}` : `已触发日程：${schedule.name}`);
				} catch (error) { return toolError(error); }
			},
		});
	}

	// ---- methods -----------------------------------------------------------------------

	private register(): void {
		const core = this.core;
		const trigger = (v: unknown): Trigger | undefined => {
			if (!v || typeof v !== "object") return undefined;
			const t = v as Record<string, unknown>;
			const type = (["once", "interval", "cron"] as const).find((x) => x === t.type);
			if (!type) return undefined;
			let crons: string[] | undefined;
			if (type === "cron" && t.crons !== undefined) {
				if (!Array.isArray(t.crons) || !t.crons.every((expression): expression is string => typeof expression === "string")) throw new RpcError("bad_request", "请提供有效的日历规则");
				crons = t.crons;
			}
			return { type, at: num(t.at), everyMs: num(t.everyMs), anchor: num(t.anchor), cron: str(t.cron), crons, timezone: str(t.timezone) };
		};
		const withRuns = (s: Schedule) => this.view(s);
		core.register("schedules.list", () => this.list().map(withRuns));
		core.register("schedules.occurrences", p => this.occurrences(p.from, p.to, p.everyDay !== false));
		core.register("schedules.history", p => this.history(requireStr(p.id, "id")));
		core.register("schedules.undo", p => this.undo(requireStr(p.changeId, "changeId")));
		core.register("schedules.fromSession", (p) => {
			const slot = core.slot(requireStr(p.slotId, "slotId"));
			const file = slot.info().sessionFile;
			if (slot.incognito || !file) throw new RpcError("bad_request", "请先保存这个对话再安排定时任务");
			core.assertTaskSession(file);
			const prompt = str(p.prompt)?.trim() || slot.lastPrompt?.trim();
			if (!prompt) throw new RpcError("bad_request", "这个对话还没有要重复的任务");
			return withRuns(this.save({ name: str(p.name) || slot.info().sessionName || "再做一次", prompt, cwd: slot.cwd, trigger: trigger(p.trigger), sessionMode: "bound", sessionFile: file }));
		});
		core.register("schedules.get", (p) => {
			const s = this.get(requireStr(p.id, "id"));
			if (!s) throw new RpcError("not_found", "这个定时任务不存在");
			return { ...withRuns(s), runs: this.runs(s.id) };
		});
		core.register("schedules.save", (p) =>
			withRuns(
				this.save({
					id: str(p.id),
					expectedVersion: expectedVersion(p.expectedVersion),
					reason: str(p.reason),
					name: str(p.name),
					prompt: str(p.prompt),
					cwd: str(p.cwd),
					kind: str(p.kind) as ScheduleKind | undefined,
					trigger: trigger(p.trigger),
					missedPolicy: p.missedPolicy === "skip" || p.missedPolicy === "latest" ? p.missedPolicy : undefined,
					sessionMode: p.sessionMode === "bound" ? "bound" : p.sessionMode === "fresh" ? "fresh" : undefined,
					sessionFile: str(p.sessionFile),
					allowedTools: Array.isArray(p.allowedTools) ? p.allowedTools.filter((x): x is string => typeof x === "string") : p.allowedTools === null ? null : undefined,
				}),
			),
		);
		core.register("schedules.setStatus", (p) => {
			const status = (["active", "paused", "rejected"] as const).find((s) => s === p.status);
			if (!status) throw new RpcError("bad_request", "status must be active, paused or rejected");
			return withRuns(this.setStatus(requireStr(p.id, "id"), status, expectedVersion(p.expectedVersion)));
		});
		core.register("schedules.remove", (p) => {
			this.remove(requireStr(p.id, "id"), expectedVersion(p.expectedVersion), "user", str(p.reason));
			return { ok: true };
		});
		core.register("schedules.runNow", (p) => this.runNow(requireStr(p.id, "id")));
		core.register("schedules.preview", (p) => {
			const t = trigger(p.trigger);
			if (!t) throw new RpcError("bad_request", "trigger is required");
			const problem = validateTrigger(t);
			if (problem) return { error: problem, next: [] };
			const out: number[] = [];
			const clock = this.clock();
			const next = occurrenceRule(t.type === "interval" && t.anchor === undefined ? { ...t, anchor: clock + (t.everyMs ?? 0) } : t);
			for (let at: number | null = clock - 1; out.length < 3; ) {
				at = next(at);
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
	const next = occurrenceRule(trigger);
	for (let t: number | null = first; t !== null && t <= at; t = next(t)) {
		latest = t;
		count++;
		if (count === 50_000) {
			// Very long gap: skip ahead and find the latest time from two days back.
			const near = next(Math.max(t, at - 2 * DAY_MS));
			if (near === null || near > at) break;
			t = near;
			latest = near;
		}
	}
	return { count, latest };
}
