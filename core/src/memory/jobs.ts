import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { json, parseJson } from "../db.ts";

/**
 * The memory agent's job queue (docs/memory-design.md §7): one job at a
 * time, by priority; failures retried twice with growing pauses, then
 * failed with the reason; ordinary work put off (never dropped) when the
 * memory budget for the day is spent or tidying is paused.
 */

export type JobKind = "extract" | "tidy_l1" | "review" | "conflict" | "snapshot" | "capacity";
export type JobStatus = "queued" | "running" | "done" | "skipped" | "deferred" | "failed";

/**
 * §7: the user's corrections > the current task's snapshot > extraction after a task > a possible
 * contradiction (after extraction, which may already settle it) > periodic tidying.
 */
export const PRIORITY = { correction: 100, snapshot: 80, extract: 50, conflict: 40, periodic: 10 } as const;
/** Below this, a job waits while tidying is paused or the budget is spent: only the user's own corrections go ahead (snapshot preparation is background spending too, §7). */
const ORDINARY = PRIORITY.correction;
export const MAX_RETRIES = 2;
const RETRY_BASE_MS = 60_000;

/** A shutdown interrupts work; it is not a provider failure or a retry. */
export class MemoryJobInterrupted extends Error {
	readonly costUsd: number;
	constructor(costUsd = 0) {
		super("记忆整理被退出中断，下次启动继续");
		this.costUsd = costUsd;
	}
}

export interface MemoryJob {
	id: string;
	kind: JobKind;
	scopeKey: string;
	payload: Record<string, unknown>;
	dedupeKey: string | null;
	priority: number;
	status: JobStatus;
	attempts: number;
	runAfter: number;
	costUsd: number;
	error: string | null;
	result: Record<string, unknown> | null;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
}

export interface JobOutcome {
	status: "done" | "skipped";
	costUsd?: number;
	result?: Record<string, unknown>;
}

interface JobRow {
	id: string;
	kind: string;
	scope_key: string;
	payload: string;
	dedupe_key: string | null;
	priority: number;
	status: string;
	attempts: number;
	run_after: number;
	cost_usd: number;
	error: string | null;
	result: string | null;
	created_at: number;
	started_at: number | null;
	ended_at: number | null;
}

function toJob(r: JobRow): MemoryJob {
	return {
		id: r.id,
		kind: r.kind as JobKind,
		scopeKey: r.scope_key,
		payload: parseJson<Record<string, unknown>>(r.payload, {}),
		dedupeKey: r.dedupe_key,
		priority: r.priority,
		status: r.status as JobStatus,
		attempts: r.attempts,
		runAfter: r.run_after,
		costUsd: r.cost_usd,
		error: r.error,
		result: r.result ? parseJson<Record<string, unknown>>(r.result, {}) : null,
		createdAt: r.created_at,
		startedAt: r.started_at,
		endedAt: r.ended_at,
	};
}

export class MemoryJobs {
	private readonly db: Db;
	private readonly clock: () => number;
	private readonly options: {
		run: (job: MemoryJob) => Promise<JobOutcome>;
		/** USD the memory agent may still spend today; Infinity = no limit. */
		budgetLeft: () => number;
		paused: () => boolean;
		/** Physical space/maintenance blocks every priority, including urgent corrections. */
		blocked?: () => boolean;
		/** When the budget is spent: the next time it is worth trying (the next local midnight). */
		nextBudgetAt: () => number;
		onChange?: (job: MemoryJob) => void;
	};
	private draining: Promise<void> | undefined;
	private again = false;
	private stopped = false;

	constructor(db: Db, clock: () => number, options: MemoryJobs["options"]) {
		this.db = db;
		this.clock = clock;
		this.options = options;
	}

	get(id: string): MemoryJob | undefined {
		const row = this.db.get<JobRow>("SELECT * FROM memory_jobs WHERE id = ?", id);
		return row ? toJob(row) : undefined;
	}

	list(filter: { status?: JobStatus[]; limit?: number } = {}): MemoryJob[] {
		const statuses = filter.status;
		const rows = statuses?.length
			? this.db.all<JobRow>(`SELECT * FROM memory_jobs WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at DESC, rowid DESC LIMIT ?`, ...statuses, filter.limit ?? 100)
			: this.db.all<JobRow>("SELECT * FROM memory_jobs ORDER BY created_at DESC, rowid DESC LIMIT ?", filter.limit ?? 100);
		return rows.map(toJob);
	}

	/** Adds a job; one with the same [dedupeKey] still waiting is returned instead (one event, one job: 16.3). */
	enqueue(input: { kind: JobKind; scopeKey: string; payload?: Record<string, unknown>; priority: number; dedupeKey?: string }): MemoryJob {
		if (input.dedupeKey) {
			const waiting = this.db.get<JobRow>("SELECT * FROM memory_jobs WHERE dedupe_key = ? AND status IN ('queued', 'deferred') LIMIT 1", input.dedupeKey);
			if (waiting) return toJob(waiting);
		}
		const id = `j_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
		const at = this.clock();
		this.db.run(
			"INSERT INTO memory_jobs(id, kind, scope_key, payload, dedupe_key, priority, status, attempts, run_after, created_at) VALUES(?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)",
			id,
			input.kind,
			input.scopeKey,
			json(input.payload ?? {}),
			input.dedupeKey ?? null,
			input.priority,
			at,
			at,
		);
		const job = this.get(id)!;
		this.options.onChange?.(job);
		return job;
	}

	/** A job left running when the process stopped runs again. */
	recoverInterrupted(): number {
		return this.db.run("UPDATE memory_jobs SET status = 'queued', started_at = NULL WHERE status = 'running'").changes;
	}

	/** Runs every job that is due, one at a time; a call while draining makes it look again at the end. */
	drain(): Promise<void> {
		if (this.stopped) return this.draining ?? Promise.resolve();
		if (this.draining) {
			this.again = true;
			return this.draining;
		}
		this.draining = (async () => {
			try {
				do {
					this.again = false;
					while (await this.runNext());
				} while (this.again);
			} finally {
				this.draining = undefined;
			}
		})();
		return this.draining;
	}

	/** Stops claiming jobs and waits only for work already in progress. */
	async stop(): Promise<void> {
		this.stopped = true;
		this.again = false;
		await this.draining;
	}

	private next(): MemoryJob | undefined {
		if (this.stopped || this.options.blocked?.()) return undefined;
		const paused = this.options.paused();
		const row = this.db.get<JobRow>(
			`SELECT * FROM memory_jobs WHERE status IN ('queued', 'deferred') AND run_after <= ? ${paused ? `AND priority >= ${ORDINARY}` : ""} ORDER BY priority DESC, created_at, rowid LIMIT 1`,
			this.clock(),
		);
		return row ? toJob(row) : undefined;
	}

	/** Runs the most urgent due job; false when there is none. */
	private async runNext(): Promise<boolean> {
		const job = this.next();
		if (!job) return false;
		if (job.priority < ORDINARY && this.options.budgetLeft() <= 0) {
			// Put off, not dropped: shown in the memory page as waiting for tomorrow's budget.
			this.set(job.id, { status: "deferred", run_after: this.options.nextBudgetAt(), error: "今天的记忆后台预算用完了" });
			return true;
		}
		const at = this.clock();
		this.set(job.id, { status: "running", started_at: at, attempts: job.attempts + 1, error: null });
		try {
			const outcome = await this.options.run({ ...job, attempts: job.attempts + 1, status: "running" });
			this.set(job.id, { status: outcome.status, ended_at: this.clock(), cost_usd: job.costUsd + (outcome.costUsd ?? 0), result: outcome.result ? json(outcome.result) : null });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const cost = (error as { costUsd?: number }).costUsd ?? 0;
			if ((this.stopped && error instanceof MemoryJobInterrupted) || this.options.blocked?.()) {
				this.set(job.id, { status: "queued", attempts: job.attempts, run_after: this.clock(), started_at: null, ended_at: null, error: null, cost_usd: job.costUsd + cost });
			} else if (job.attempts + 1 <= MAX_RETRIES) {
				this.set(job.id, { status: "queued", run_after: this.clock() + RETRY_BASE_MS * 2 ** job.attempts, error: message, cost_usd: job.costUsd + cost, started_at: null });
			} else {
				this.set(job.id, { status: "failed", ended_at: this.clock(), error: message, cost_usd: job.costUsd + cost });
			}
		}
		return true;
	}

	private set(id: string, fields: Record<string, string | number | null>): void {
		const keys = Object.keys(fields);
		this.db.run(`UPDATE memory_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => fields[k]!), id);
		const job = this.get(id);
		if (job) this.options.onChange?.(job);
	}
}
