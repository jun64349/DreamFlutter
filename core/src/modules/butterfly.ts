import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Core, CoreModule } from "../core.ts";
import { normalizeCwd, RpcError, requireStr, samePath } from "../core.ts";
import { now } from "../db.ts";
import type { Run } from "../runs.ts";
import { sandboxEnv } from "../agent/state.ts";
import { SANDBOX_WORKSPACE } from "../sandbox/sandbox.ts";
import type { Slot } from "../slots/slot.ts";
import type { Material, TasksModule } from "./tasks.ts";
import type { Task } from "./tasks.ts";
import { parseJsonAnswer, type Llm } from "./llm.ts";
import { randomUUID } from "node:crypto";

export const INBOX = `${SANDBOX_WORKSPACE}/inbox`;
export const OUTBOX = `${SANDBOX_WORKSPACE}/outbox`;
const MOVED_FLAG = "desk_moved_to_butterfly";
/** Outbox entries listed at most (the window shows them in a column). */
const OUTBOX_LIMIT = 200;

interface Intent {
	id: string; slot_id: string; task_id: string; goal: string; restatement: string; plan: string;
	state: "waiting" | "needs_input" | "starting" | "started" | "cancelled" | "failed";
	created_at: number; start_at: number | null; missing: string | null; error: string | null;
}

export function butterflyStatus(status: Task["status"]): "in_progress" | "waiting" | "completed" | "failed" {
	if (["needs_input", "interrupted"].includes(status)) return "waiting";
	if (["done", "no_change"].includes(status)) return "completed";
	return status === "failed" ? "failed" : "in_progress";
}

export interface OutboxFile {
	/** Path under the outbox, with forward slashes. */
	name: string;
	/** Where this machine opens it (\\wsl.localhost\...). */
	path: string;
	size: number;
	modifiedAt: number;
}

/**
 * 蝶君 (roadmap 3.5): a role whose sessions run in the WSL sandbox. Its
 * sessions open in its own home folder, so they never show up among the
 * workbench's sessions; its 「工作」 is the old desk (notes, materials, cards)
 * moved over once. Materials go into the sandbox's inbox as copies when a
 * note is handed over; results come back through the outbox.
 */
export class ButterflyModule implements CoreModule {
	private readonly core: Core;
	private readonly tasks: TasksModule;
	readonly home: string;
	/** Outbox contents after the last sandboxed run, to tell new deliveries apart. */
	private known: Map<string, number> | undefined;
	private llm?: Llm;
	private timer?: NodeJS.Timeout;
	private stopping = false;
	private inFlight = new Set<Promise<unknown>>();
	private questions = new Map<string, AbortController>();
	private preparing = new Set<string>();

	constructor(core: Core, tasks: TasksModule, llm?: Llm) {
		this.core = core;
		this.tasks = tasks;
		this.llm = llm;
		this.home = core.paths.butterflyDir;
		mkdirSync(this.home, { recursive: true });
		this.moveDesk();
		core.declareBackup({ id: "butterfly-intents", title: "蝶君开工计划", tables: ["butterfly_intents"] });
		this.register();
	}

	start(): void {
		this.core.db.run("UPDATE butterfly_intents SET state='needs_input',error='开工时后台中断，请确认后继续' WHERE state='starting'");
		this.timer = setInterval(() => { void this.tick(); }, 1000); this.timer.unref();
	}
	stop(): void {
		this.stopping = true; clearInterval(this.timer);
		for (const q of this.questions.values()) q.abort();
	}
	private ask(intent: Intent, slot: Slot): void {
		if (this.questions.has(intent.id) || intent.start_at !== null && intent.state !== "needs_input") return;
		const controller = new AbortController(); this.questions.set(intent.id, controller);
		const ui = slot.ui.context();
		const answer = intent.state === "needs_input" && intent.missing
			? ui.input("蝶君等你补充信息", intent.missing, { signal: controller.signal })
			: ui.confirm("蝶君准备开工", `${intent.restatement}\n${intent.plan}`, { signal: controller.signal });
		void answer.then(async (value) => {
			if (this.stopping || controller.signal.aborted) return;
			const current = this.core.db.get<Intent>("SELECT * FROM butterfly_intents WHERE id=?", intent.id);
			if (!current || !["needs_input", "waiting"].includes(current.state)) return;
			if (typeof value === "string" && value.trim()) await this.prepare(slot.slotId, `${intent.goal}\n用户补充：${value}`);
			else if (value === true) {
				this.core.db.run("UPDATE butterfly_intents SET state='waiting',start_at=NULL WHERE id=?", intent.id);
				await this.begin(intent.id);
			} else if (value === false) this.cancel(intent.id);
		}).catch((e) => this.core.log.warn("butterfly: answer failed", e)).finally(() => { if (this.questions.get(intent.id) === controller) this.questions.delete(intent.id); });
	}
	onSlotChanged(slot: Slot): void {
		if (this.stopping || !slot.sandboxed || slot.running || this.preparing.has(slot.slotId)) return;
		for (const intent of this.core.db.all<Intent>("SELECT * FROM butterfly_intents WHERE slot_id=? AND state IN ('waiting','needs_input')", slot.slotId)) this.ask(intent, slot);
	}
	private view(task: Task) {
		const status = butterflyStatus(task.status);
		const intent = this.core.db.get<Intent>("SELECT * FROM butterfly_intents WHERE task_id=? AND state IN ('waiting','needs_input','starting') ORDER BY created_at DESC LIMIT 1", task.id);
		return { ...task, status: intent?.state === "needs_input" || intent?.start_at === null ? "waiting" : status,
			progress: intent ? intent.state === "needs_input" ? "等你补充信息" : "已复述任务，等待开工" : task.currentStep ?? (status === "completed" ? "已完成" : status === "failed" ? "这次没有做成" : status === "waiting" ? "等你处理" : "正在处理任务"),
			delivery: status === "completed" ? { summary: task.result ?? "", files: this.tasks.listArtifacts({ taskId: task.id }), cost: task.cost, durationMs: task.durationMs } : null, intent };
	}
	private cancel(id: string): void {
		const intent = this.core.db.get<Intent>("SELECT * FROM butterfly_intents WHERE id=? AND state IN ('waiting','needs_input')", id);
		if (!intent) return;
		this.questions.get(id)?.abort();
		this.core.db.transaction(() => {
			this.core.db.run("UPDATE butterfly_intents SET state='cancelled' WHERE id=?", id);
			this.core.db.run("UPDATE tasks SET status='failed',error='已取消',ended_at=?,updated_at=? WHERE id=?", Date.now(), Date.now(), intent.task_id);
		});
		this.core.broadcast({ event: "tasks.changed", taskId: intent.task_id });
	}
	async prepare(slotId: string, goal: string): Promise<Intent> {
		if (this.stopping || this.core.maintenance) throw new RpcError("busy", "正在维护数据，请稍后开工");
		if (this.preparing.has(slotId)) throw new RpcError("busy", "正在复述这项任务，请稍后");
		const slot = this.core.slot(slotId);
		if (!slot.sandboxed || slot.running || !goal.trim()) throw new RpcError("bad_request", "请在空闲的蝶君对话中写下要做的事");
		this.preparing.add(slotId);
		const previous = this.core.db.get<Intent>("SELECT * FROM butterfly_intents WHERE slot_id=? AND state IN ('waiting','needs_input') ORDER BY created_at DESC LIMIT 1", slotId);
		if (previous) {
			this.core.db.run("UPDATE butterfly_intents SET state='needs_input',start_at=NULL WHERE id=?", previous.id);
			this.questions.get(previous.id)?.abort();
		}
		try { return await this.preparePlan(slotId, goal); }
		catch (error) {
			if (previous && !this.stopping) {
				this.core.db.run("UPDATE butterfly_intents SET error=? WHERE id=?", "新的任务复述没有完成，请确认原计划后再开工", previous.id);
				this.core.broadcast({ event: "tasks.changed", taskId: previous.task_id });
			}
			throw error;
		} finally { this.preparing.delete(slotId); }
	}
	private async preparePlan(slotId: string, goal: string): Promise<Intent> {
		if (this.stopping || this.core.maintenance) throw new RpcError("busy", "正在维护数据，请稍后开工");
		const slot = this.core.slot(slotId);
		if (!slot.sandboxed || slot.incognito || slot.isSideConversation) throw new RpcError("bad_request", "请在蝶君的普通对话中交办任务");
		if (slot.running) throw new RpcError("busy", "蝶君正在处理这个对话，请稍后再交办");
		if (!goal.trim()) throw new RpcError("bad_request", "请写下要做的事");
		if (!this.llm) throw new RpcError("not_configured", "任务复述模型尚未就绪");
		const answer = await this.llm.complete(goal.slice(0, 12000), { system: '用用户的语言，用一两句话复述理解的任务和计划。只输出 JSON：{"restatement":"任务理解","plan":"打算怎么做","missing":[]}。只有缺少无法合理推断、会阻止开工的关键信息才在 missing 写问题，不问风格偏好。这里仅制定计划，不执行任何操作。', maxTokens: 700, timeoutMs: 30_000, sessionModel: slot.info().model });
		if (this.stopping) throw new RpcError("busy", "后台正在退出");
		const draft = parseJsonAnswer<{ restatement?: string; plan?: string; missing?: unknown }>(answer);
		if (!draft || typeof draft.restatement !== "string" || !draft.restatement.trim() || typeof draft.plan !== "string" || !draft.plan.trim() || !Array.isArray(draft.missing)) throw new RpcError("model", "没能复述任务，请重试");
		const missing = Array.isArray(draft.missing) ? draft.missing.filter((m): m is string => typeof m === "string" && !!m.trim()).slice(0, 3) : [];
		const wait = this.core.settings.get().butterflyStartWaitSeconds;
		const previous = this.core.db.get<Intent>("SELECT * FROM butterfly_intents WHERE slot_id=? AND state IN ('waiting','needs_input') ORDER BY created_at DESC LIMIT 1", slotId);
		const task = previous ? this.tasks.get(previous.task_id)! : this.tasks.create({ cwd: this.home, goal, source: "chat", sessionFile: slot.info().sessionFile });
		if (previous) this.core.db.run("UPDATE tasks SET goal=?,title=?,updated_at=? WHERE id=?", goal, goal.slice(0, 60), Date.now(), task.id);
		const intent: Intent = { id: `intent_${randomUUID()}`, slot_id: slotId, task_id: task.id, goal, restatement: draft.restatement.slice(0, 600), plan: draft.plan.slice(0, 600), state: missing.length ? "needs_input" : "waiting", created_at: Date.now(), start_at: missing.length || !wait ? null : Date.now() + wait * 1000, missing: missing.length ? missing.join("\n") : null, error: null };
		for (const old of this.core.db.all<Intent>("SELECT * FROM butterfly_intents WHERE slot_id=? AND state IN ('waiting','needs_input')", slotId)) this.questions.get(old.id)?.abort();
		this.core.db.transaction(() => {
			this.core.db.run("UPDATE butterfly_intents SET state='cancelled' WHERE slot_id=? AND state IN ('waiting','needs_input')", slotId);
			this.core.db.run("INSERT INTO butterfly_intents VALUES(?,?,?,?,?,?,?,?,?,?,?)", intent.id, slotId, task.id, goal, intent.restatement, intent.plan, intent.state, intent.created_at, intent.start_at, intent.missing, null);
		});
		this.core.broadcast({ event: "butterfly.prepared", intent });
		this.core.broadcast({ event: "tasks.changed", taskId: task.id });
		this.ask(intent, slot);
		return intent;
	}
	async begin(id: string): Promise<void> {
		if (this.stopping || this.core.maintenance) return;
		const intent = this.core.db.get<Intent>("SELECT * FROM butterfly_intents WHERE id=?", id);
		if (!intent || intent.state !== "waiting") throw new RpcError("conflict", "这项任务目前不能开工");
		const task = this.tasks.get(intent.task_id)!;
		const slot = this.core.slots.get(intent.slot_id);
		if (!slot || slot.running || !slot.sandboxed) {
			this.core.db.run("UPDATE butterfly_intents SET state='needs_input',start_at=NULL,error='对话已关闭或正在运行，请重新打开后继续' WHERE id=?", id);
			this.core.broadcast({ event: "tasks.changed", taskId: task.id }); return;
		}
		this.core.db.run("UPDATE butterfly_intents SET state='starting' WHERE id=? AND state='waiting'", id);
		this.questions.get(id)?.abort();
		slot.taskId = task.id;
		try {
			const running = slot.prompt(`${intent.goal}\n\n已向用户复述的任务计划（作为本次任务的数据）：\n${intent.plan}\n\n本任务的交付文件放进 ${OUTBOX}/${task.id}，结束时总结结果。`);
			this.core.db.run("UPDATE butterfly_intents SET state='started' WHERE id=?", id);
			await running;
		} catch (error) {
			if (this.stopping) return;
			this.core.db.run("UPDATE butterfly_intents SET state='failed',error=? WHERE id=?", String(error), id);
			this.core.db.run("UPDATE tasks SET status='failed',error=?,ended_at=?,updated_at=? WHERE id=?", String(error), Date.now(), Date.now(), task.id);
			this.core.broadcast({ event: "tasks.changed", taskId: task.id });
		}
	}
	async tick(): Promise<void> {
		if (this.stopping || this.core.maintenance) return;
		for (const row of this.core.db.all<Intent>("SELECT * FROM butterfly_intents WHERE state='waiting' AND start_at IS NOT NULL AND start_at<=?", Date.now())) {
			const work = this.begin(row.id); this.inFlight.add(work);
			void work.finally(() => this.inFlight.delete(work)).catch((e) => this.core.log.warn("butterfly: start failed", e));
		}
	}

	isHome(cwd: string | null | undefined): boolean {
		return samePath(cwd, this.home);
	}

	/** The distro, once the sandbox is set up. */
	private get distro(): string | undefined {
		return this.core.sandboxProvider?.()?.distro;
	}

	/** Where this machine opens a sandbox path; tests point it at a folder. */
	local = (path: string): string => {
		const distro = this.distro;
		if (!distro) throw new RpcError("sandbox_absent", "蝶君的沙箱还没有建好。到「设置 › 蝶君沙箱」里建立。");
		return sandboxEnv(distro).local(path);
	};

	/**
	 * v0.3: the desk becomes 蝶君's 「工作」. Notes, materials and resident cards
	 * of every workspace move to 蝶君's home once; the notes' artifacts follow
	 * their notes. Tasks stay where they ran.
	 */
	private moveDesk(): void {
		const db = this.core.db;
		if (db.get("SELECT key FROM app_flags WHERE key = ?", MOVED_FLAG)) return;
		const key = normalizeCwd(this.home);
		db.run("UPDATE notes SET cwd = ?, cwd_key = ?", this.home, key);
		db.run("UPDATE materials SET cwd = ?, cwd_key = ? WHERE cwd_key <> ?", this.home, key, key);
		// The same file added on two desks becomes one material.
		db.run("DELETE FROM materials WHERE path IS NOT NULL AND id NOT IN (SELECT MIN(id) FROM materials WHERE path IS NOT NULL GROUP BY lower(path))");
		db.run("UPDATE artifacts SET cwd = ?, cwd_key = ? WHERE note_id IS NOT NULL", this.home, key);
		db.run("UPDATE cards SET cwd = ? WHERE on_desk = 1", this.home);
		db.run("INSERT INTO app_flags(key, value, at) VALUES(?, '1', ?)", MOVED_FLAG, now());
	}

	/**
	 * Copies the materials into the inbox (files and folders as copies, pasted
	 * text as a Markdown file) and returns their sandbox paths. Copies replace
	 * earlier ones of the same name.
	 */
	async importMaterials(materials: Material[]): Promise<string[]> {
		if (!materials.length) return [];
		const inbox = this.local(INBOX);
		await mkdir(inbox, { recursive: true });
		const out: string[] = [];
		for (const m of materials) {
			const name = m.kind === "text" ? `${safeName(m.title) || m.id}.md` : basename(m.path ?? "");
			if (!name) continue;
			const target = join(inbox, name);
			if (m.kind === "text") await writeFile(target, `${m.content ?? ""}\n`, "utf8");
			else if (m.path && existsSync(m.path)) await cp(m.path, target, { recursive: true, force: true });
			else continue;
			out.push(`${INBOX}/${name}`);
		}
		return out;
	}

	/** Files dropped on 蝶君's conversation: copied into the inbox. */
	async importPaths(paths: string[]): Promise<string[]> {
		const inbox = this.local(INBOX);
		await mkdir(inbox, { recursive: true });
		const out: string[] = [];
		for (const path of paths) {
			if (!existsSync(path)) continue;
			const name = basename(path);
			await cp(path, join(inbox, name), { recursive: true, force: true });
			out.push(`${INBOX}/${name}`);
		}
		return out;
	}

	/** The prompt that hands a note to 蝶君: the note, where the materials are, where results go. */
	composeHandOff(note: { title: string; content: string }, inboxPaths: string[]): string {
		const parts = [
			`用户把下面这份写笺交给你。按写笺里的要求去做；要求不清楚的地方先问用户。`,
			"",
			`<写笺 标题="${note.title}">`,
			note.content.trim() || "（空）",
			"</写笺>",
		];
		if (inboxPaths.length) parts.push("", "资料的副本已经放进 inbox：", ...inboxPaths.map((p) => `- ${p}`));
		parts.push("", `做好的结果放进 ${OUTBOX}，用户在那里查看并保存到自己的电脑。`);
		return parts.join("\n");
	}

	async outbox(): Promise<OutboxFile[]> {
		let root: string;
		try {
			root = this.local(OUTBOX);
		} catch {
			return []; // no sandbox yet
		}
		const files: OutboxFile[] = [];
		const walk = async (dir: string, prefix: string): Promise<void> => {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (files.length >= OUTBOX_LIMIT) return;
				const path = join(dir, entry.name);
				const name = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (entry.isDirectory()) await walk(path, name);
				else if (entry.isFile()) {
					try {
						const s = await stat(path);
						files.push({ name, path, size: s.size, modifiedAt: Math.round(s.mtimeMs) });
					} catch {}
				}
			}
		};
		await walk(root, "");
		return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
	}

	onRunStarted(slot: Slot): void {
		if (!slot.sandboxed || this.known) return;
		void this.outbox().then((files) => {
			this.known ??= new Map(files.map((f) => [f.name, f.modifiedAt]));
		});
	}

	/** After 蝶君's run: tell the window what is new or changed in the outbox. */
	onRunFinished(slot: Slot, run: Run): void {
		if (!slot.sandboxed || this.stopping) return;
		void this.outbox().then((files) => {
			if (this.stopping) return;
			const before = this.known ?? new Map<string, number>();
			const fresh = files.filter((f) => (before.get(f.name) ?? 0) < f.modifiedAt && f.modifiedAt >= run.startedAt - 1000);
			this.known = new Map(files.map((f) => [f.name, f.modifiedAt]));
			this.core.broadcast({ event: "butterfly.outbox", files, fresh: fresh.map((f) => f.name) });
			const planned = run.taskId && this.core.db.get("SELECT 1 FROM butterfly_intents WHERE task_id=?", run.taskId);
			// Concurrent tasks share the outbox; a planned task owns only its directory.
			const delivered = planned ? files.filter((f) => f.name.startsWith(`${run.taskId}/`)) : fresh;
			if (run.taskId) for (const file of delivered) this.tasks.recordArtifact(run.taskId, file.path);
			this.core.broadcast({ event: "butterfly.delivery", taskId: run.taskId, files: delivered, runId: run.id });
		});
	}

	private register(): void {
		const core = this.core;
		core.register("butterfly.tasks", () => this.tasks.list({ cwd: this.home, limit: 200 }).map((t) => this.view(t)));
		core.register("butterfly.task", (p) => { const task = this.tasks.get(requireStr(p.id, "id")); if (!task || !this.isHome(task.cwd)) throw new RpcError("not_found", "没有这项蝶君任务"); return this.view(task); });
		core.register("butterfly.prepare", (p) => this.prepare(requireStr(p.slotId, "slotId"), requireStr(p.goal, "goal")));
		core.register("butterfly.start", async (p) => {
			const id = requireStr(p.id, "id");
			if (typeof p.slotId === "string") {
				const intent = core.db.get<Intent>("SELECT * FROM butterfly_intents WHERE id=?", id), slot = core.slot(p.slotId);
				const task = intent ? this.tasks.get(intent.task_id) : undefined;
				if (!intent || !task || !["waiting", "needs_input"].includes(intent.state) || !slot.sandboxed || !this.isHome(slot.cwd) || task.sessionFile && !samePath(task.sessionFile, slot.info().sessionFile)) throw new RpcError("conflict", "请重新打开这项任务的蝶君对话");
				core.db.run("UPDATE butterfly_intents SET slot_id=? WHERE id=?", slot.slotId, id);
				if (intent.state === "needs_input" && intent.missing) { this.ask({ ...intent, slot_id: slot.slotId }, slot); return { ok: true, waiting: true }; }
				core.db.run("UPDATE butterfly_intents SET state='waiting' WHERE id=?", id);
			}
			await this.begin(id); return { ok: true };
		});
		core.register("butterfly.answer", async (p) => {
			const intent = core.db.get<Intent>("SELECT * FROM butterfly_intents WHERE id=?", requireStr(p.id, "id"));
			if (!intent || intent.state !== "needs_input") throw new RpcError("conflict", "这项任务没有在等回答");
			return this.prepare(intent.slot_id, `${intent.goal}\n用户补充：${requireStr(p.answer, "answer")}`);
		});
		core.register("butterfly.cancel", (p) => { this.cancel(requireStr(p.id, "id")); return { ok: true }; });
		core.register("butterfly.tick", () => this.tick());
		core.register("butterfly.info", () => ({ home: this.home, distro: this.distro ?? null, inbox: INBOX, outbox: OUTBOX }));
		core.register("butterfly.outbox", () => this.outbox());
		core.register("butterfly.handOff", async (p) => {
			const note = this.tasks.getNote(requireStr(p.noteId, "noteId"));
			if (!note) throw new RpcError("not_found", "这份写笺不存在");
			this.local(INBOX); // no task without a sandbox to run it in
			const inbox = await this.importMaterials(this.tasks.listMaterials(this.home));
			const task = this.tasks.create({ cwd: this.home, goal: note.content.trim() || note.title, title: note.title, source: "note", noteId: note.id });
			return { task, prompt: this.composeHandOff(note, inbox) };
		});
		core.register("butterfly.import", async (p) => {
			const paths = Array.isArray(p.paths) ? p.paths.filter((x): x is string => typeof x === "string") : [];
			return { paths: await this.importPaths(paths) };
		});
	}
}

/** A file name from a title: no path separators or characters Windows refuses. */
export function safeName(title: string): string {
	return title
		.replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 60);
}
