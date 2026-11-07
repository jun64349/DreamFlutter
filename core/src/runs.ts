import { randomUUID } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Db } from "./db.ts";
import { json, now, parseJson } from "./db.ts";

export type RunStatus = "running" | "done" | "failed" | "aborted" | "interrupted";

export interface Run {
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

export interface RunStep {
	id: number;
	runId: string;
	at: number;
	kind: "tool" | "retry" | "compaction" | "error";
	name: string | null;
	summary: string | null;
	status: string | null;
	durationMs: number | null;
}

export interface RunContext {
	slotId: string;
	cwd: string;
	sessionFile: () => string | undefined;
	sessionId: () => string | undefined;
	taskId: () => string | null;
}

export interface RunListener {
	runStarted?(run: Run): void;
	runFinished?(run: Run): void;
}

const FILE_TOOLS = new Set(["write", "edit"]);

/**
 * Turns one session's event stream into run records: a run spans from
 * agent_start to agent_settled and collects turns, tool steps, usage, cost,
 * errors and touched files.
 */
export class RunRecorder {
	private readonly db: Db;
	private readonly ctx: RunContext;
	private readonly listener: RunListener;
	private run: Run | undefined;
	private readonly toolSteps = new Map<string, { stepId: number; startedAt: number }>();
	private readonly files = new Set<string>();

	constructor(db: Db, ctx: RunContext, listener: RunListener = {}) {
		this.db = db;
		this.ctx = ctx;
		this.listener = listener;
	}

	get current(): Run | undefined {
		return this.run;
	}

	handle(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				if (!this.run) this.start();
				break;
			case "turn_start":
				if (this.run) this.run.turns++;
				break;
			case "message_end":
				this.onMessageEnd(event.message as unknown as Record<string, unknown>);
				break;
			case "tool_execution_start":
				this.onToolStart(event.toolCallId, event.toolName, event.args);
				break;
			case "tool_execution_end":
				this.onToolEnd(event.toolCallId, event.isError, event.durationMs);
				break;
			case "auto_retry_start":
				this.step("retry", null, `第 ${event.attempt}/${event.maxAttempts} 次重试：${event.errorMessage}`, "running");
				break;
			case "compaction_end":
				this.step("compaction", event.reason, event.errorMessage ?? null, event.errorMessage ? "error" : "done");
				// ContextModule owns compaction usage; this listener records only the step.
				break;
			case "agent_settled":
				this.finish(event.aborted ? "aborted" : this.run?.error ? "failed" : "done");
				break;
		}
	}

	/** Closes a run cut short by the session going away. */
	interrupt(): void {
		if (this.run) this.finish("interrupted");
	}

	private start(): void {
		const run: Run = {
			id: randomUUID(),
			slotId: this.ctx.slotId,
			sessionFile: this.ctx.sessionFile() ?? null,
			sessionId: this.ctx.sessionId() ?? null,
			cwd: this.ctx.cwd,
			taskId: this.ctx.taskId(),
			prompt: null,
			status: "running",
			startedAt: now(),
			endedAt: null,
			model: null,
			turns: 0,
			toolCalls: 0,
			toolErrors: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			error: null,
			files: [],
		};
		this.run = run;
		this.files.clear();
		this.toolSteps.clear();
		this.db.run(
			"INSERT INTO runs(id, slot_id, session_file, session_id, cwd, task_id, status, started_at) VALUES(?, ?, ?, ?, ?, ?, 'running', ?)",
			run.id,
			run.slotId,
			run.sessionFile,
			run.sessionId,
			run.cwd,
			run.taskId,
			run.startedAt,
		);
		this.listener.runStarted?.(run);
	}

	private onMessageEnd(message: Record<string, unknown>): void {
		if (!this.run) return;
		if (message.role === "user" && this.run.prompt === null) {
			this.run.prompt = textOf(message.content).slice(0, 500);
		}
		if (message.role !== "assistant") return;
		this.addUsage(message.usage as Record<string, unknown> | undefined);
		if (typeof message.provider === "string" && typeof message.model === "string") {
			this.run.model = `${message.provider}/${message.model}`;
		}
		if (message.stopReason === "error") {
			this.run.error = typeof message.errorMessage === "string" ? message.errorMessage : "模型返回错误";
			this.step("error", null, this.run.error, "error");
		} else if (message.stopReason !== "aborted") {
			// A later successful turn (e.g. after a retry) clears an earlier error.
			this.run.error = null;
		}
	}

	private addUsage(usage: Record<string, unknown> | undefined): void {
		if (!this.run || !usage) return;
		this.run.inputTokens += num(usage.input);
		this.run.outputTokens += num(usage.output);
		this.run.cacheRead += num(usage.cacheRead);
		this.run.cacheWrite += num(usage.cacheWrite);
		this.run.cost += num((usage.cost as Record<string, unknown> | undefined)?.total);
	}

	/** Work done for this run elsewhere (a subagent): its usage and the files it touched count here. */
	absorb(usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }, files: Iterable<string>): void {
		if (!this.run) return;
		this.run.inputTokens += usage.input;
		this.run.outputTokens += usage.output;
		this.run.cacheRead += usage.cacheRead;
		this.run.cacheWrite += usage.cacheWrite;
		this.run.cost += usage.cost;
		for (const file of files) this.files.add(file);
	}

	private onToolStart(toolCallId: string, toolName: string, args: unknown): void {
		if (!this.run) return;
		this.run.toolCalls++;
		const input = (args ?? {}) as Record<string, unknown>;
		const path = typeof input.file_path === "string" ? input.file_path : input.path;
		if (FILE_TOOLS.has(toolName) && typeof path === "string") this.files.add(path);
		const stepId = this.step("tool", toolName, summarizeArgs(toolName, input), "running");
		this.toolSteps.set(toolCallId, { stepId, startedAt: now() });
	}

	private onToolEnd(toolCallId: string, isError: boolean, durationMs: number | undefined): void {
		if (!this.run) return;
		if (isError) this.run.toolErrors++;
		const step = this.toolSteps.get(toolCallId);
		if (!step) return;
		this.toolSteps.delete(toolCallId);
		this.db.run(
			"UPDATE run_steps SET status = ?, duration_ms = ? WHERE id = ?",
			isError ? "error" : "done",
			durationMs ?? now() - step.startedAt,
			step.stepId,
		);
	}

	private step(kind: RunStep["kind"], name: string | null, summary: string | null, status: string): number {
		if (!this.run) return -1;
		return this.db.run(
			"INSERT INTO run_steps(run_id, at, kind, name, summary, status) VALUES(?, ?, ?, ?, ?, ?)",
			this.run.id,
			now(),
			kind,
			name,
			summary,
			status,
		).lastInsertRowid;
	}

	private finish(status: RunStatus): void {
		const run = this.run;
		if (!run) return;
		this.run = undefined;
		run.status = status;
		run.endedAt = now();
		run.files = [...this.files];
		// Steps still "running" never finished (abort, crash).
		this.db.run("UPDATE run_steps SET status = 'interrupted' WHERE run_id = ? AND status = 'running'", run.id);
		this.db.run(
			`UPDATE runs SET status = ?, ended_at = ?, prompt = ?, model = ?, turns = ?, tool_calls = ?, tool_errors = ?,
			 input_tokens = ?, output_tokens = ?, cache_read = ?, cache_write = ?, cost = ?, error = ?, files = ?,
			 session_file = COALESCE(?, session_file), session_id = COALESCE(?, session_id)
			 WHERE id = ?`,
			run.status,
			run.endedAt,
			run.prompt,
			run.model,
			run.turns,
			run.toolCalls,
			run.toolErrors,
			run.inputTokens,
			run.outputTokens,
			run.cacheRead,
			run.cacheWrite,
			run.cost,
			run.error,
			json(run.files),
			this.ctx.sessionFile() ?? null,
			this.ctx.sessionId() ?? null,
			run.id,
		);
		this.listener.runFinished?.(run);
	}
}

/** Run history queries. */
export class RunStore {
	private readonly db: Db;

	constructor(db: Db) {
		this.db = db;
	}

	/** A completed compaction outside a live run is billed at its own occurrence time. */
	recordCompaction(input: {slotId:string; sessionId:string|null; sessionFile:string|null; cwd:string; model:string|null; kind:"background_compaction"|"compaction"; usage:{input:number;output:number;cacheRead:number;cacheWrite:number;cost:number}}): string {
		const id = randomUUID();
		const at = now();
		const u = input.usage;
		this.db.run("INSERT INTO runs(id,slot_id,session_id,session_file,cwd,status,started_at,ended_at,model,input_tokens,output_tokens,cache_read,cache_write,cost,kind) VALUES(?,?,?,?,?,'done',?,?,?,?,?,?,?,?,?)", id,input.slotId,input.sessionId,input.sessionFile,input.cwd,at,at,input.model,u.input,u.output,u.cacheRead,u.cacheWrite,u.cost,input.kind);
		return id;
	}

	/** Runs left "running" by a previous core process. */
	interruptOrphans(): Run[] {
		const orphans = this.db.all<RunRow>("SELECT * FROM runs WHERE status = 'running'").map(toRun);
		this.db.run("UPDATE runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'", now());
		this.db.run("UPDATE run_steps SET status = 'interrupted' WHERE status = 'running'");
		return orphans.map((run) => ({ ...run, status: "interrupted" as const }));
	}

	get(id: string): Run | undefined {
		const row = this.db.get<RunRow>("SELECT * FROM runs WHERE id = ?", id);
		return row ? toRun(row) : undefined;
	}

	list(filter: { sessionFile?: string; taskId?: string; status?: RunStatus; limit?: number } = {}): Run[] {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (filter.sessionFile) {
			where.push("session_file = ?");
			params.push(filter.sessionFile);
		}
		if (filter.taskId) {
			where.push("task_id = ?");
			params.push(filter.taskId);
		}
		if (filter.status) {
			where.push("status = ?");
			params.push(filter.status);
		}
		const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC LIMIT ?`;
		return this.db.all<RunRow>(sql, ...params, filter.limit ?? 50).map(toRun);
	}

	steps(runId: string): RunStep[] {
		return this.db
			.all<{ id: number; run_id: string; at: number; kind: string; name: string | null; summary: string | null; status: string | null; duration_ms: number | null }>(
				"SELECT * FROM run_steps WHERE run_id = ? ORDER BY id",
				runId,
			)
			.map((row) => ({
				id: row.id,
				runId: row.run_id,
				at: row.at,
				kind: row.kind as RunStep["kind"],
				name: row.name,
				summary: row.summary,
				status: row.status,
				durationMs: row.duration_ms,
			}));
	}

	/** Interrupted runs the user has not dismissed yet (resume cards). */
	unacknowledgedInterrupted(): Run[] {
		return this.db.all<RunRow>("SELECT * FROM runs WHERE status = 'interrupted' AND acknowledged = 0 ORDER BY started_at DESC LIMIT 20").map(toRun);
	}

	acknowledge(id: string): void {
		this.db.run("UPDATE runs SET acknowledged = 1 WHERE id = ?", id);
	}

	/** Request-time USD amounts only; run summaries never participate in money statistics. */
	costSince(since: number, filter: { unattendedOnly?: boolean } = {}): number {
		const sql = filter.unattendedOnly
			? "SELECT COALESCE(SUM(l.amount),0) total FROM request_ledger l JOIN runs r ON r.id=l.run_id JOIN tasks t ON t.id=r.task_id WHERE l.requested_at>=? AND l.currency='USD' AND t.source='schedule'"
			: "SELECT COALESCE(SUM(amount),0) total FROM request_ledger WHERE requested_at>=? AND currency='USD'";
		try {
			return Number(this.db.get<{ total: number }>(sql, since)?.total ?? 0);
		} catch {
			return 0;
		}
	}
}

interface RunRow {
	kind: Run["kind"];
	id: string;
	slot_id: string | null;
	session_file: string | null;
	session_id: string | null;
	cwd: string;
	task_id: string | null;
	prompt: string | null;
	status: string;
	started_at: number;
	ended_at: number | null;
	model: string | null;
	turns: number;
	tool_calls: number;
	tool_errors: number;
	input_tokens: number;
	output_tokens: number;
	cache_read: number;
	cache_write: number;
	cost: number;
	error: string | null;
	files: string | null;
}

function toRun(row: RunRow): Run {
	return {
		kind: row.kind,
		id: row.id,
		slotId: row.slot_id,
		sessionFile: row.session_file,
		sessionId: row.session_id,
		cwd: row.cwd,
		taskId: row.task_id,
		prompt: row.prompt,
		status: row.status as RunStatus,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		model: row.model,
		turns: row.turns,
		toolCalls: row.tool_calls,
		toolErrors: row.tool_errors,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		cacheRead: row.cache_read,
		cacheWrite: row.cache_write,
		cost: row.cost,
		error: row.error,
		files: parseJson<string[]>(row.files, []),
	};
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
		.join("")
		.trim();
}

function summarizeArgs(toolName: string, input: Record<string, unknown>): string {
	const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);
	const first = str("command") ?? str("file_path") ?? str("path") ?? str("pattern") ?? str("query") ?? str("url") ?? str("cd") ?? str("job_id") ?? str("name");
	const text = first ?? JSON.stringify(input);
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine || toolName;
}
