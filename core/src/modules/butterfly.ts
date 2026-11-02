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

export const INBOX = `${SANDBOX_WORKSPACE}/inbox`;
export const OUTBOX = `${SANDBOX_WORKSPACE}/outbox`;
const MOVED_FLAG = "desk_moved_to_butterfly";
/** Outbox entries listed at most (the window shows them in a column). */
const OUTBOX_LIMIT = 200;

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

	constructor(core: Core, tasks: TasksModule) {
		this.core = core;
		this.tasks = tasks;
		this.home = core.paths.butterflyDir;
		mkdirSync(this.home, { recursive: true });
		this.moveDesk();
		this.register();
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
		if (!slot.sandboxed) return;
		void this.outbox().then((files) => {
			const before = this.known ?? new Map<string, number>();
			const fresh = files.filter((f) => (before.get(f.name) ?? 0) < f.modifiedAt && f.modifiedAt >= run.startedAt - 1000);
			this.known = new Map(files.map((f) => [f.name, f.modifiedAt]));
			this.core.broadcast({ event: "butterfly.outbox", files, fresh: fresh.map((f) => f.name) });
			if (fresh.length && this.core.settings.get().notifications && !this.core.clients.size) {
				this.core.notifier.notify("蝶君交付了新文件", fresh.map((f) => f.name).join("、"));
			}
		});
	}

	private register(): void {
		const core = this.core;
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
