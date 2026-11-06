import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { relevance, trigrams } from "./text.ts";

/**
 * The task a session is on (docs/memory-design.md §16): a snapshot follows
 * the task, not every message. One session can hold several tasks one after
 * another; a task that the program only guessed is over is 「挂起」, not
 * 「完成」, so the user can say it was the same task after all.
 */

export type TaskStatus = "active" | "suspended" | "ended";

/**
 * Why a task started (16.2): definite boundaries (a new session's first
 * message, every scheduled run, another workspace, the user marking or
 * saying a new task) and the one guessed from signals.
 */
export type BoundaryReason = "session_start" | "scheduled" | "workspace_switch" | "user_marked" | "user_said" | "guessed" | "user_continued";

export interface TaskView {
	id: string;
	sessionId: string;
	scopeKey: string;
	reason: BoundaryReason;
	status: TaskStatus;
	/** The message the task started with (what its snapshot is chosen for). */
	prompt: string | null;
	startedAt: number;
	lastActiveAt: number;
	endedAt: number | null;
	endReason: string | null;
}

interface Row {
	id: string;
	session_id: string;
	scope_key: string;
	reason: string;
	status: string;
	prompt: string | null;
	started_at: number;
	last_active_at: number;
	ended_at: number | null;
	end_reason: string | null;
}

function toView(r: Row): TaskView {
	return {
		id: r.id,
		sessionId: r.session_id,
		scopeKey: r.scope_key,
		reason: r.reason as BoundaryReason,
		status: r.status as TaskStatus,
		prompt: r.prompt,
		startedAt: r.started_at,
		lastActiveAt: r.last_active_at,
		endedAt: r.ended_at,
		endReason: r.end_reason,
	};
}

export class TaskViews {
	private readonly db: Db;
	private readonly clock: () => number;

	constructor(db: Db, clock: () => number) {
		this.db = db;
		this.clock = clock;
	}

	get(id: string): TaskView | undefined {
		const row = this.db.get<Row>("SELECT * FROM memory_task_views WHERE id = ?", id);
		return row ? toView(row) : undefined;
	}

	/** The task [sessionId] is on now. */
	current(sessionId: string): TaskView | undefined {
		const row = this.db.get<Row>("SELECT * FROM memory_task_views WHERE session_id = ? AND status = 'active' ORDER BY started_at DESC, rowid DESC LIMIT 1", sessionId);
		return row ? toView(row) : undefined;
	}

	/** Every task of [sessionId], newest first. */
	list(sessionId: string): TaskView[] {
		return this.db.all<Row>("SELECT * FROM memory_task_views WHERE session_id = ? ORDER BY started_at DESC, rowid DESC", sessionId).map(toView);
	}

	/** Starts a task; the one going on (if any) becomes [previous] (ended, or suspended when the boundary was only guessed). */
	start(input: { sessionId: string; scopeKey: string; reason: BoundaryReason; prompt: string | null; previous?: { status: "ended" | "suspended"; reason: string } }): TaskView {
		const at = this.clock();
		const old = this.current(input.sessionId);
		if (old) this.db.run("UPDATE memory_task_views SET status = ?, ended_at = ?, end_reason = ? WHERE id = ?", input.previous?.status ?? "ended", at, input.previous?.reason ?? input.reason, old.id);
		const id = `t_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
		this.db.run(
			"INSERT INTO memory_task_views(id, session_id, scope_key, reason, status, prompt, started_at, last_active_at) VALUES(?, ?, ?, ?, 'active', ?, ?, ?)",
			id,
			input.sessionId,
			input.scopeKey,
			input.reason,
			input.prompt?.slice(0, 4000) ?? null,
			at,
			at,
		);
		return this.get(id)!;
	}

	touch(id: string): void {
		this.db.run("UPDATE memory_task_views SET last_active_at = ? WHERE id = ?", this.clock(), id);
	}

	/**
	 * 「改为继续上一个」: the guessed new task was the old one after all. The
	 * suspended task is active again; the guessed one ends.
	 */
	resumePrevious(sessionId: string): { resumed: TaskView; dropped: TaskView } | undefined {
		const now = this.current(sessionId);
		if (!now || now.reason !== "guessed") return undefined;
		const previous = this.db.get<Row>("SELECT * FROM memory_task_views WHERE session_id = ? AND status = 'suspended' ORDER BY ended_at DESC, rowid DESC LIMIT 1", sessionId);
		if (!previous) return undefined;
		const at = this.clock();
		this.db.transaction(() => {
			this.db.run("UPDATE memory_task_views SET status = 'ended', ended_at = ?, end_reason = 'user_continued' WHERE id = ?", at, now.id);
			this.db.run("UPDATE memory_task_views SET status = 'active', ended_at = NULL, end_reason = NULL, last_active_at = ? WHERE id = ?", at, previous.id);
		});
		return { resumed: this.get(previous.id)!, dropped: this.get(now.id)! };
	}
}

/** 16.2: the user says one thing is done and another begins (「这件做完了，接下来……」). */
const NEW_TASK =
	/(这件|这个|那件|上一件|前面那件|刚才那件)(事|任务|活儿?)?(就)?(做完了|完成了|结束了|搞定了|先这样)|换个(话题|事儿?|任务)|另外一件事|(说|做|聊)(点|件)(别的|另一件)|新(的)?任务[:：，,]|\blet'?s (move on|switch) to\b|\b(new|different|unrelated) (task|topic|question)\b/i;

export function saysNewTask(prompt: string): boolean {
	return NEW_TASK.test(prompt);
}

/** 16.2: a long pause, or a long message about something else, makes a new task likely (only a signal: a light check decides). */
export const GAP_MS = 2 * 3_600_000;
const LONG_MESSAGE = 40;
/** Three-character overlap only: two-character pairs like 「帮我」 make every request look related. */
const UNRELATED = 0.05;

export function boundarySignal(task: Pick<TaskView, "lastActiveAt" | "prompt">, prompt: string, now: number): "gap" | "topic" | undefined {
	if (now - task.lastActiveAt >= GAP_MS) return "gap";
	if (prompt.trim().length >= LONG_MESSAGE && task.prompt && Math.max(relevance(trigrams(task.prompt), prompt), relevance(trigrams(prompt), task.prompt)) < UNRELATED) return "topic";
	return undefined;
}

/** Below this the light check's 「new task」 is not trusted: the current task goes on (16.2: 「把握低就沿用当前任务」). */
export const NEW_TASK_CONFIDENCE = 0.75;
