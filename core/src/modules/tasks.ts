import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Core, CoreModule } from "../core.ts";
import { normalizeCwd, num, RpcError, requireStr, str } from "../core.ts";
import type { Db } from "../db.ts";
import { json, now, parseJson } from "../db.ts";
import type { Run } from "../runs.ts";
import { textOf } from "../runs.ts";
import type { Slot } from "../slots/slot.ts";

export type TaskStatus = "waiting" | "running" | "needs_input" | "done" | "no_change" | "failed" | "interrupted";
export type TaskSource = "chat" | "note" | "template" | "schedule";

export interface Task {
	id: string;
	title: string;
	goal: string;
	cwd: string;
	sessionFile: string | null;
	source: TaskSource;
	status: TaskStatus;
	noteId: string | null;
	scheduleId: string | null;
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

export interface Note {
	id: string;
	cwd: string;
	title: string;
	content: string;
	createdAt: number;
	updatedAt: number;
}

export type MaterialKind = "file" | "folder" | "text";

export interface Material {
	id: string;
	cwd: string;
	kind: MaterialKind;
	title: string;
	path: string | null;
	content: string | null;
	createdAt: number;
}

export interface Artifact {
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

export type NoticeKind = "limit_turns" | "limit_budget";

/** A card the core raises for the user (run limits...), resolved from the inbox. */
export interface Notice {
	id: string;
	kind: NoticeKind;
	title: string;
	body: string | null;
	slotId: string | null;
	sessionFile: string | null;
	taskId: string | null;
	cwd: string | null;
	status: "pending" | "continued" | "stopped";
	createdAt: number;
	resolvedAt: number | null;
}

const TERMINAL: TaskStatus[] = ["done", "no_change", "failed", "interrupted"];

interface TaskRow {
	id: string;
	title: string;
	goal: string;
	cwd: string;
	session_file: string | null;
	source: string;
	status: string;
	note_id: string | null;
	schedule_id: string | null;
	materials: string;
	result: string | null;
	error: string | null;
	runs: number;
	turns: number;
	cost: number;
	duration_ms: number;
	current_step: string | null;
	created_at: number;
	updated_at: number;
	ended_at: number | null;
}

function toTask(row: TaskRow): Task {
	return {
		id: row.id,
		title: row.title,
		goal: row.goal,
		cwd: row.cwd,
		sessionFile: row.session_file,
		source: row.source as TaskSource,
		status: row.status as TaskStatus,
		noteId: row.note_id,
		scheduleId: row.schedule_id,
		materialIds: parseJson<string[]>(row.materials, []),
		result: row.result,
		error: row.error,
		runs: row.runs,
		turns: row.turns,
		cost: row.cost,
		durationMs: row.duration_ms,
		currentStep: row.current_step,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		endedAt: row.ended_at,
	};
}

function oneLine(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function startOfToday(at = now()): number {
	const d = new Date(at);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/**
 * Tasks (user's draft §4, §5, §7): every session is a task (goal, status,
 * cost, artifacts), tasks handed over from the desk carry their note and
 * materials; the desk itself (notes, materials, artifacts per workspace);
 * run limits that pause a run and raise a card; and the combined inbox.
 */
export class TasksModule implements CoreModule {
	private readonly core: Core;
	private readonly db: Db;
	/** Slot → extra turns granted by "continue" on a turn-limit card. */
	private readonly extraTurns = new Map<string, number>();
	/** Day (start ms) the user chose to keep going past the daily budget. */
	private budgetOverrideDay = 0;
	/** Runs already stopped by a limit (one card per run). */
	private readonly stoppedRuns = new Set<string>();
	/** Other modules' items for the inbox (e.g. schedules waiting for approval). */
	private readonly inboxSources: (() => Record<string, unknown>[])[] = [];
	/** Called when the user answers a limit card (before a continued run starts). */
	private readonly noticeListeners: ((notice: Notice, action: "continue" | "stop", slot?: Slot) => void)[] = [];

	constructor(core: Core) {
		this.core = core;
		this.db = core.db;
		this.register();
		this.recoverInterrupted();
	}

	// ---- tasks -------------------------------------------------------------------------

	get(id: string): Task | undefined {
		const row = this.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
		return row ? toTask(row) : undefined;
	}

	list(filter: { cwd?: string; status?: TaskStatus[]; source?: TaskSource; noteId?: string; limit?: number } = {}): Task[] {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (filter.cwd) {
			where.push("cwd_key = ?");
			params.push(normalizeCwd(filter.cwd));
		}
		if (filter.status?.length) {
			where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
			params.push(...filter.status);
		}
		if (filter.source) {
			where.push("source = ?");
			params.push(filter.source);
		}
		if (filter.noteId) {
			where.push("note_id = ?");
			params.push(filter.noteId);
		}
		const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`;
		return this.db.all<TaskRow>(sql, ...params, filter.limit ?? 100).map(toTask);
	}

	create(input: {
		cwd: string;
		goal: string;
		title?: string;
		source: TaskSource;
		noteId?: string | null;
		scheduleId?: string | null;
		materialIds?: string[];
		sessionFile?: string | null;
	}): Task {
		const goal = input.goal.trim();
		if (!goal) throw new RpcError("bad_request", "任务目标不能为空");
		const at = now();
		const task: Task = {
			id: `t_${randomUUID().slice(0, 8)}`,
			title: oneLine(input.title?.trim() || goal, 60),
			goal,
			cwd: input.cwd,
			sessionFile: input.sessionFile ?? null,
			source: input.source,
			status: "waiting",
			noteId: input.noteId ?? null,
			scheduleId: input.scheduleId ?? null,
			materialIds: input.materialIds ?? [],
			result: null,
			error: null,
			runs: 0,
			turns: 0,
			cost: 0,
			durationMs: 0,
			currentStep: null,
			createdAt: at,
			updatedAt: at,
			endedAt: null,
		};
		this.db.run(
			`INSERT INTO tasks(id, title, goal, cwd, cwd_key, session_file, source, status, note_id, schedule_id, materials, created_at, updated_at)
			 VALUES(?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?)`,
			task.id,
			task.title,
			task.goal,
			task.cwd,
			normalizeCwd(task.cwd),
			task.sessionFile,
			task.source,
			task.noteId,
			task.scheduleId,
			json(task.materialIds),
			at,
			at,
		);
		this.changed(task.id);
		return task;
	}

	private update(id: string, patch: Partial<Record<keyof TaskRow, string | number | null>>): void {
		const keys = Object.keys(patch);
		if (!keys.length) return;
		this.db.run(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...keys.map((k) => patch[k as keyof TaskRow] ?? null), now(), id);
		this.changed(id);
	}

	private changed(id: string): void {
		this.core.broadcast({ event: "tasks.changed", taskId: id });
	}

	/** The task a session belongs to; chat sessions get one at their first run. */
	resolveTaskId(slot: Slot): string | null {
		if (slot.incognito) return null;
		const file = slot.info().sessionFile;
		if (!file) return null;
		const existing = this.db.get<{ id: string }>("SELECT id FROM tasks WHERE session_file = ? ORDER BY created_at DESC LIMIT 1", file);
		if (existing) return existing.id;
		const prompt = slot.lastPrompt ?? slot.info().sessionName ?? "对话";
		return this.create({ cwd: slot.cwd, goal: prompt, source: "chat", sessionFile: file }).id;
	}

	/**
	 * The prompt that starts a task: the goal, plus the note and materials it
	 * carries. Materials are referenced by path (the agent reads them with its
	 * tools); pasted text is included inline.
	 */
	composePrompt(input: { goal: string; noteId?: string | null; materialIds?: string[] }): string {
		const parts = [input.goal.trim()];
		const note = input.noteId ? this.getNote(input.noteId) : undefined;
		if (note) parts.push("", `<写笺 标题="${note.title}">`, note.content.trim() || "（空）", "</写笺>");
		const materials = (input.materialIds ?? []).map((id) => this.getMaterial(id)).filter((m): m is Material => !!m);
		if (materials.length) {
			parts.push("", "<资料>");
			for (const m of materials) {
				if (m.kind === "text") parts.push(`<文本 标题="${m.title}">`, (m.content ?? "").slice(0, 20_000), "</文本>");
				else parts.push(`- ${m.kind === "folder" ? "文件夹" : "文件"}：${m.path}`);
			}
			parts.push("</资料>", "需要时用工具读取上面列出的文件或文件夹。");
		}
		return parts.join("\n");
	}

	/** Crash recovery: tasks left running by a previous core are interrupted. */
	private recoverInterrupted(): void {
		this.db.run("UPDATE tasks SET status = 'interrupted', current_step = NULL, updated_at = ? WHERE status IN ('running', 'needs_input') OR (status = 'waiting' AND runs > 0)", now());
	}

	// ---- run lifecycle -----------------------------------------------------------------

	onRunStarted(slot: Slot, run: Run): void {
		if (!run.taskId) return;
		const task = this.get(run.taskId);
		if (!task) return;
		this.update(task.id, {
			status: "running",
			session_file: task.sessionFile ?? slot.info().sessionFile,
			error: null,
			current_step: null,
			ended_at: null,
		});
	}

	onSlotChanged(slot: Slot): void {
		const run = slot.currentRun;
		if (!run?.taskId || !slot.running) return;
		const task = this.get(run.taskId);
		if (!task) return;
		const status: TaskStatus = slot.ui.pendingCount > 0 ? "needs_input" : "running";
		if (task.status !== status) this.update(task.id, { status });
	}

	onSlotEvent(slot: Slot, event: AgentSessionEvent): void {
		const run = slot.currentRun;
		if (!run) return;
		if (event.type === "tool_execution_start" && run.taskId) {
			const args = (event.args ?? {}) as Record<string, unknown>;
			const target = ["path", "command", "pattern", "query", "url"].map((k) => args[k]).find((v) => typeof v === "string") as string | undefined;
			this.db.run("UPDATE tasks SET current_step = ? WHERE id = ?", oneLine(`${event.toolName}${target ? `：${target}` : ""}`, 120), run.taskId);
		}
		if (event.type === "turn_start") this.checkLimits(slot, run);
	}

	onRunFinished(slot: Slot, run: Run): void {
		this.stoppedRuns.delete(run.id);
		if (!run.taskId) return;
		const task = this.get(run.taskId);
		if (!task) return;
		const limited = this.db.get<{ id: string }>("SELECT id FROM notices WHERE task_id = ? AND status = 'pending'", task.id);
		const status: TaskStatus = limited
			? "needs_input"
			: run.status === "done"
				? "done"
				: run.status === "failed"
					? "failed"
					: "interrupted";
		const messages = slot.started ? (slot.session.messages as unknown as { role: string; content: unknown }[]) : [];
		const lastReply = [...messages].reverse().find((m) => m.role === "assistant");
		const result = lastReply ? textOf(lastReply.content).slice(0, 2000) : task.result;
		this.db.run(
			`UPDATE tasks SET status = ?, result = ?, error = ?, runs = runs + 1, turns = turns + ?, cost = cost + ?, duration_ms = duration_ms + ?,
			 current_step = NULL, ended_at = ?, session_file = COALESCE(session_file, ?), title = CASE WHEN source = 'chat' AND ? IS NOT NULL THEN ? ELSE title END,
			 updated_at = ? WHERE id = ?`,
			status,
			result ?? null,
			run.error,
			run.turns,
			run.cost,
			(run.endedAt ?? now()) - run.startedAt,
			now(),
			run.sessionFile,
			slot.info().sessionName,
			slot.info().sessionName,
			now(),
			task.id,
		);
		for (const file of run.files) this.addArtifact(task, isAbsolute(file) ? file : resolve(run.cwd, file));
		this.changed(task.id);
		if (task.noteId) this.core.broadcast({ event: "desk.changed", cwd: task.cwd });
	}

	/** Marks the task of a schedule run as "no change" (monitoring found nothing new). */
	markNoChange(taskId: string): void {
		this.update(taskId, { status: "no_change" });
	}

	// ---- run limits (F6) ---------------------------------------------------------------

	private checkLimits(slot: Slot, run: Run): void {
		if (this.stoppedRuns.has(run.id)) return;
		const settings = this.core.settings.get();
		const turnLimit = (slot.unattended ? settings.maxTurnsUnattended : settings.maxTurnsPerRun) + (this.extraTurns.get(slot.slotId) ?? 0);
		if (turnLimit > 0 && run.turns > turnLimit) {
			this.pauseRun(slot, run, "limit_turns", `已达到单次运行的最大轮数（${turnLimit} 轮）`, "任务已暂停。可以让它继续，或者到此为止。");
			return;
		}
		const budget = settings.dailyBudgetUsd;
		if (budget > 0 && this.budgetOverrideDay !== startOfToday()) {
			// Finished runs are in the database; runs still going only know their cost in memory.
			let spent = this.core.runs.costSince(startOfToday());
			for (const s of this.core.slots.values()) spent += s.currentRun?.cost ?? 0;
			if (spent >= budget) {
				this.pauseRun(slot, run, "limit_budget", `今天的花费已达到上限（$${spent.toFixed(2)} / $${budget.toFixed(2)}）`, "任务已暂停。可以今天内不再限制并继续，或者到此为止。");
			}
		}
	}

	private pauseRun(slot: Slot, run: Run, kind: NoticeKind, title: string, body: string): void {
		this.stoppedRuns.add(run.id);
		const notice: Notice = {
			id: `n_${randomUUID().slice(0, 8)}`,
			kind,
			title,
			body,
			slotId: slot.slotId,
			sessionFile: slot.info().sessionFile,
			taskId: run.taskId,
			cwd: slot.cwd,
			status: "pending",
			createdAt: now(),
			resolvedAt: null,
		};
		this.db.run(
			"INSERT INTO notices(id, kind, title, body, slot_id, session_file, task_id, cwd, status, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
			notice.id,
			notice.kind,
			notice.title,
			notice.body,
			notice.slotId,
			notice.sessionFile,
			notice.taskId,
			notice.cwd,
			notice.createdAt,
		);
		this.core.log.info(`run ${run.id} stopped: ${title}`);
		void slot.session.abort();
		this.core.broadcast({ event: "notices.changed", notice });
		if (this.core.settings.get().notifications) this.core.notifier.notify(title, slot.info().sessionName ?? slot.cwd);
	}

	listNotices(status: Notice["status"] | undefined = "pending"): Notice[] {
		const rows = status
			? this.db.all<NoticeRow>("SELECT * FROM notices WHERE status = ? ORDER BY created_at DESC LIMIT 100", status)
			: this.db.all<NoticeRow>("SELECT * FROM notices ORDER BY created_at DESC LIMIT 100");
		return rows.map(toNotice);
	}

	/** "Continue" reopens the session when needed and asks the agent to go on. */
	async resolveNotice(id: string, action: "continue" | "stop"): Promise<{ slotId: string | null }> {
		const row = this.db.get<NoticeRow>("SELECT * FROM notices WHERE id = ?", id);
		if (!row || row.status !== "pending") throw new RpcError("gone", "这张卡片已经处理过了");
		const notice = toNotice(row);
		this.db.run("UPDATE notices SET status = ?, resolved_at = ? WHERE id = ?", action === "continue" ? "continued" : "stopped", now(), id);
		this.core.broadcast({ event: "notices.changed" });
		if (action === "stop") {
			if (notice.taskId) this.update(notice.taskId, { status: "interrupted" });
			for (const listener of this.noticeListeners) listener(notice, "stop");
			return { slotId: null };
		}
		let slot = notice.slotId ? this.core.slots.get(notice.slotId) : undefined;
		if (!slot && notice.sessionFile && existsSync(notice.sessionFile)) {
			slot = await this.core.openSlot({ cwd: notice.cwd ?? process.cwd(), sessionFile: notice.sessionFile });
		}
		if (!slot) throw new RpcError("gone", "这个任务的会话已经不在了");
		if (notice.kind === "limit_turns") {
			const settings = this.core.settings.get();
			this.extraTurns.set(slot.slotId, (this.extraTurns.get(slot.slotId) ?? 0) + (slot.unattended ? settings.maxTurnsUnattended : settings.maxTurnsPerRun));
		} else {
			this.budgetOverrideDay = startOfToday();
		}
		for (const listener of this.noticeListeners) listener(notice, "continue", slot);
		await slot.prompt("请从刚才停下的地方继续，完成剩下的部分。");
		return { slotId: slot.slotId };
	}

	// ---- desk: notes, materials, artifacts ----------------------------------------------

	getNote(id: string): Note | undefined {
		const row = this.db.get<NoteRow>("SELECT * FROM notes WHERE id = ?", id);
		return row ? toNote(row) : undefined;
	}

	listNotes(cwd: string): Note[] {
		return this.db.all<NoteRow>("SELECT * FROM notes WHERE cwd_key = ? AND archived = 0 ORDER BY updated_at DESC", normalizeCwd(cwd)).map(toNote);
	}

	saveNote(input: { id?: string; cwd: string; title?: string; content?: string }): Note {
		const at = now();
		const existing = input.id ? this.getNote(input.id) : undefined;
		if (input.id && !existing) throw new RpcError("not_found", "这份写笺不存在");
		const content = input.content ?? existing?.content ?? "";
		const title = (input.title ?? existing?.title ?? "").trim() || oneLine(content.split("\n").find((l) => l.trim()) ?? "", 40).replace(/^#+\s*/, "") || "未命名写笺";
		if (existing) {
			this.db.run("UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ?", title, content, at, existing.id);
		} else {
			input.id = `w_${randomUUID().slice(0, 8)}`;
			this.db.run("INSERT INTO notes(id, cwd, cwd_key, title, content, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)", input.id, input.cwd, normalizeCwd(input.cwd), title, content, at, at);
		}
		const note = this.getNote(input.id!)!;
		this.core.broadcast({ event: "desk.changed", cwd: note.cwd });
		return note;
	}

	removeNote(id: string): void {
		const note = this.getNote(id);
		this.db.run("UPDATE notes SET archived = 1, updated_at = ? WHERE id = ?", now(), id);
		if (note) this.core.broadcast({ event: "desk.changed", cwd: note.cwd });
	}

	getMaterial(id: string): Material | undefined {
		const row = this.db.get<MaterialRow>("SELECT * FROM materials WHERE id = ?", id);
		return row ? toMaterial(row) : undefined;
	}

	listMaterials(cwd: string): Material[] {
		return this.db.all<MaterialRow>("SELECT * FROM materials WHERE cwd_key = ? ORDER BY created_at DESC", normalizeCwd(cwd)).map(toMaterial);
	}

	addMaterial(input: { cwd: string; kind: MaterialKind; path?: string; content?: string; title?: string }): Material {
		if (input.kind === "text") {
			if (!input.content?.trim()) throw new RpcError("bad_request", "资料内容不能为空");
		} else {
			if (!input.path || !existsSync(input.path)) throw new RpcError("not_found", "找不到这个文件或文件夹");
			const dup = this.db.get<{ id: string }>("SELECT id FROM materials WHERE cwd_key = ? AND lower(path) = lower(?)", normalizeCwd(input.cwd), input.path);
			if (dup) return this.getMaterial(dup.id)!;
		}
		const material: Material = {
			id: `r_${randomUUID().slice(0, 8)}`,
			cwd: input.cwd,
			kind: input.kind,
			title: input.title?.trim() || (input.path ? basename(input.path) : oneLine(input.content ?? "", 30)),
			path: input.kind === "text" ? null : input.path!,
			content: input.kind === "text" ? input.content!.trim() : null,
			createdAt: now(),
		};
		this.db.run(
			"INSERT INTO materials(id, cwd, cwd_key, kind, title, path, content, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
			material.id,
			material.cwd,
			normalizeCwd(material.cwd),
			material.kind,
			material.title,
			material.path,
			material.content,
			material.createdAt,
		);
		this.core.broadcast({ event: "desk.changed", cwd: material.cwd });
		return material;
	}

	removeMaterial(id: string): void {
		const material = this.getMaterial(id);
		this.db.run("DELETE FROM materials WHERE id = ?", id);
		if (material) this.core.broadcast({ event: "desk.changed", cwd: material.cwd });
	}

	private addArtifact(task: Task, path: string): void {
		const at = now();
		this.db.run(
			`INSERT INTO artifacts(id, cwd, cwd_key, task_id, note_id, path, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(task_id, path) DO UPDATE SET updated_at = excluded.updated_at`,
			`a_${randomUUID().slice(0, 8)}`,
			task.cwd,
			normalizeCwd(task.cwd),
			task.id,
			task.noteId,
			path,
			at,
			at,
		);
	}

	listArtifacts(filter: { cwd?: string; taskId?: string; noteId?: string; limit?: number }): Artifact[] {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (filter.cwd) {
			where.push("cwd_key = ?");
			params.push(normalizeCwd(filter.cwd));
		}
		if (filter.taskId) {
			where.push("task_id = ?");
			params.push(filter.taskId);
		}
		if (filter.noteId) {
			where.push("note_id = ?");
			params.push(filter.noteId);
		}
		const rows = this.db.all<ArtifactRow>(
			`SELECT * FROM artifacts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`,
			...params,
			filter.limit ?? 100,
		);
		// The same file touched by several tasks shows once (latest).
		const seen = new Set<string>();
		const out: Artifact[] = [];
		for (const row of rows) {
			const key = row.path.toLowerCase();
			if (!filter.taskId && seen.has(key)) continue;
			seen.add(key);
			let size: number | null = null;
			let exists = false;
			try {
				const stat = statSync(row.path);
				exists = stat.isFile();
				size = stat.size;
			} catch {}
			out.push({ id: row.id, cwd: row.cwd, taskId: row.task_id, noteId: row.note_id, path: row.path, exists, size, createdAt: row.created_at, updatedAt: row.updated_at });
		}
		return out;
	}

	// ---- inbox -------------------------------------------------------------------------

	onNoticeResolved(listener: (notice: Notice, action: "continue" | "stop", slot?: Slot) => void): void {
		this.noticeListeners.push(listener);
	}

	addInboxSource(source: () => Record<string, unknown>[]): void {
		this.inboxSources.push(source);
	}

	/** Everything waiting for the user, newest first. */
	inbox(): Record<string, unknown>[] {
		const items: Record<string, unknown>[] = [];
		for (const c of this.core.confirmations.list({ status: "pending" })) {
			items.push({ kind: c.kind === "approval" ? "approval" : c.kind === "trust" ? "trust" : "question", id: c.id, title: c.title, createdAt: c.createdAt, cwd: c.cwd, sessionFile: c.sessionFile, slotId: c.slotId, data: c.request });
		}
		for (const n of this.listNotices("pending")) {
			items.push({ kind: "limit", id: n.id, title: n.title, body: n.body, createdAt: n.createdAt, cwd: n.cwd, sessionFile: n.sessionFile, slotId: n.slotId, data: n });
		}
		const memories = this.db.all<{ id: string; content: string; created_at: number; cwd: string | null }>("SELECT id, content, created_at, cwd FROM memories WHERE status = 'candidate' ORDER BY created_at DESC");
		for (const m of memories) items.push({ kind: "memory", id: m.id, title: m.content, createdAt: m.created_at, cwd: m.cwd });
		const proposals = this.db.all<{ id: string; title: string; created_at: number; cwd: string | null }>("SELECT id, title, created_at, cwd FROM proposals WHERE status = 'pending' ORDER BY created_at DESC");
		for (const p of proposals) items.push({ kind: "proposal", id: p.id, title: p.title, createdAt: p.created_at, cwd: p.cwd });
		for (const r of this.core.runs.unacknowledgedInterrupted()) {
			items.push({ kind: "interrupted", id: r.id, title: r.prompt ?? "被中断的任务", createdAt: r.startedAt, cwd: r.cwd, sessionFile: r.sessionFile, data: r });
		}
		for (const source of this.inboxSources) items.push(...source());
		return items.sort((a, b) => (b.createdAt as number) - (a.createdAt as number));
	}

	// ---- methods -----------------------------------------------------------------------

	private register(): void {
		const core = this.core;
		const statuses = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : undefined) as TaskStatus[] | undefined;
		core.register("tasks.list", (p) =>
			this.list({ cwd: str(p.cwd), status: statuses(p.status), source: str(p.source) as TaskSource | undefined, noteId: str(p.noteId), limit: num(p.limit) }),
		);
		core.register("tasks.get", (p) => {
			const task = this.get(requireStr(p.id, "id"));
			if (!task) throw new RpcError("not_found", "这个任务不存在");
			return { task, runs: core.runs.list({ taskId: task.id, limit: 20 }), artifacts: this.listArtifacts({ taskId: task.id }) };
		});
		core.register("tasks.forSession", (p) => {
			const row = this.db.get<TaskRow>("SELECT * FROM tasks WHERE session_file = ? ORDER BY created_at DESC LIMIT 1", requireStr(p.sessionFile, "sessionFile"));
			return row ? toTask(row) : null;
		});
		core.register("tasks.create", (p) => {
			const goal = requireStr(p.goal, "goal");
			const materialIds = Array.isArray(p.materialIds) ? p.materialIds.filter((x): x is string => typeof x === "string") : [];
			const task = this.create({
				cwd: requireStr(p.cwd, "cwd"),
				goal,
				title: str(p.title),
				source: (["note", "template", "chat"] as const).find((s) => s === p.source) ?? "chat",
				noteId: str(p.noteId) ?? null,
				materialIds,
			});
			return { task, prompt: this.composePrompt({ goal, noteId: task.noteId, materialIds }) };
		});
		core.register("tasks.bind", (p) => {
			const task = this.get(requireStr(p.taskId, "taskId"));
			if (!task) throw new RpcError("not_found", "这个任务不存在");
			const slot = core.slot(p.slotId);
			slot.taskId = task.id;
			const file = slot.info().sessionFile;
			if (file && !task.sessionFile) this.update(task.id, { session_file: file });
			return { ok: true };
		});
		core.register("tasks.remove", (p) => {
			const id = requireStr(p.id, "id");
			this.db.run("DELETE FROM tasks WHERE id = ?", id);
			this.db.run("DELETE FROM artifacts WHERE task_id = ?", id);
			this.changed(id);
			return { ok: true };
		});
		core.register("notes.list", (p) => this.listNotes(requireStr(p.cwd, "cwd")));
		core.register("notes.get", (p) => this.getNote(requireStr(p.id, "id")) ?? null);
		core.register("notes.save", (p) =>
			this.saveNote({ id: str(p.id), cwd: requireStr(p.cwd, "cwd"), title: typeof p.title === "string" ? p.title : undefined, content: typeof p.content === "string" ? p.content : undefined }),
		);
		core.register("notes.remove", (p) => {
			this.removeNote(requireStr(p.id, "id"));
			return { ok: true };
		});
		core.register("materials.list", (p) => this.listMaterials(requireStr(p.cwd, "cwd")));
		core.register("materials.add", (p) =>
			this.addMaterial({
				cwd: requireStr(p.cwd, "cwd"),
				kind: (["file", "folder", "text"] as const).find((k) => k === p.kind) ?? "file",
				path: str(p.path),
				content: str(p.content),
				title: str(p.title),
			}),
		);
		core.register("materials.remove", (p) => {
			this.removeMaterial(requireStr(p.id, "id"));
			return { ok: true };
		});
		core.register("artifacts.list", (p) => this.listArtifacts({ cwd: str(p.cwd), taskId: str(p.taskId), noteId: str(p.noteId), limit: num(p.limit) }));
		core.register("desk.get", (p) => {
			const cwd = requireStr(p.cwd, "cwd");
			return {
				notes: this.listNotes(cwd),
				materials: this.listMaterials(cwd),
				tasks: this.list({ cwd, limit: 30 }),
				artifacts: this.listArtifacts({ cwd, limit: 50 }),
			};
		});
		core.register("notices.list", (p) => this.listNotices(p.status === "all" ? undefined : ((str(p.status) as Notice["status"] | undefined) ?? "pending")));
		core.register("notices.resolve", (p) => this.resolveNotice(requireStr(p.id, "id"), p.action === "continue" ? "continue" : "stop"));
		core.register("inbox.list", () => this.inbox());
	}
}

export function isTerminal(status: TaskStatus): boolean {
	return TERMINAL.includes(status);
}

interface NoteRow {
	id: string;
	cwd: string;
	title: string;
	content: string;
	created_at: number;
	updated_at: number;
}

function toNote(row: NoteRow): Note {
	return { id: row.id, cwd: row.cwd, title: row.title, content: row.content, createdAt: row.created_at, updatedAt: row.updated_at };
}

interface MaterialRow {
	id: string;
	cwd: string;
	kind: string;
	title: string;
	path: string | null;
	content: string | null;
	created_at: number;
}

function toMaterial(row: MaterialRow): Material {
	return { id: row.id, cwd: row.cwd, kind: row.kind as MaterialKind, title: row.title, path: row.path, content: row.content, createdAt: row.created_at };
}

interface ArtifactRow {
	id: string;
	cwd: string;
	task_id: string | null;
	note_id: string | null;
	path: string;
	created_at: number;
	updated_at: number;
}

interface NoticeRow {
	id: string;
	kind: string;
	title: string;
	body: string | null;
	slot_id: string | null;
	session_file: string | null;
	task_id: string | null;
	cwd: string | null;
	status: string;
	created_at: number;
	resolved_at: number | null;
}

function toNotice(row: NoticeRow): Notice {
	return {
		id: row.id,
		kind: row.kind as NoticeKind,
		title: row.title,
		body: row.body,
		slotId: row.slot_id,
		sessionFile: row.session_file,
		taskId: row.task_id,
		cwd: row.cwd,
		status: row.status as Notice["status"],
		createdAt: row.created_at,
		resolvedAt: row.resolved_at,
	};
}
