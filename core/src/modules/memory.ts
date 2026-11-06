import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Core, CoreModule, Params } from "../core.ts";
import { normalizeCwd, num, RpcError, requireStr, str } from "../core.ts";
import type { Db } from "../db.ts";
import { json, now, parseJson } from "../db.ts";
import { migrateV02, migrationDone, splitBlock } from "../memory/migrate.ts";
import { allowedScopes, homeScope, type ScopeSet, Workspaces } from "../memory/scopes.ts";
import { MemoryStore } from "../memory/store.ts";
import { estimateTokens, nearDuplicate, relevance, saysMore, trigrams } from "../memory/text.ts";
import {
	type Actor,
	type CommitResult,
	CONFIDENCES,
	ITEM_KINDS,
	ITEM_SCOPES,
	ITEM_STATUSES,
	type ItemKind,
	type ItemPatch,
	type ItemScope,
	type ItemStatus,
	type Level,
	LIVE_STATUSES,
	type MemoryItem,
	type MemoryOp,
	type PendingChange,
	RETENTIONS,
} from "../memory/types.ts";
import type { Run } from "../runs.ts";
import { textOf } from "../runs.ts";
import type { Slot } from "../slots/slot.ts";
import { parseJsonAnswer, type Llm } from "./llm.ts";
import { TasksModule } from "./tasks.ts";

export { estimateTokens, nearDuplicate, overlap, relevance, saysMore } from "../memory/text.ts";

/** An item in v0.2's shape (memory.list, memory.add… until the memory page moves to the v0.5 methods). */
export interface Memory {
	id: string;
	scope: "global" | "workspace";
	cwd: string | null;
	kind: string;
	content: string;
	source: "user" | "agent" | "manual";
	sourceSession: string | null;
	status: "active" | "candidate" | "superseded" | "deleted";
	action: "add" | "update" | "delete" | null;
	targetId: string | null;
	replacedBy: string | null;
	reason: string | null;
	createdAt: number;
	updatedAt: number;
}

export const MEMORY_MESSAGE_TYPE = "df-memory";
export const MEMORY_TOOLS = ["memory_search", "memory_save", "memory_update", "memory_forget", "session_search"];

const KIND_LABEL: Record<ItemKind, string> = {
	preference: "偏好",
	background: "背景",
	experience: "经验",
	decision: "决定",
	progress: "进展",
	agreement: "约定",
	observation: "观察",
	persona: "Agent 设定",
};
const LEVEL_LABEL: Record<Level, string> = { 1: "近期", 2: "阶段", 3: "长期" };

/** v0.2's three always-on blocks, kept for the memory page until 0.5's own (they are pinned items now). */
export const BLOCKS = [
	{ key: "about_me", title: "关于我", kind: "background" },
	{ key: "preferences", title: "偏好与习惯", kind: "preference" },
	{ key: "agreements", title: "当前约定", kind: "agreement" },
] as const;

/** Kinds a user-stated memory starts at level 2 with (the rest start at 1, §3). */
const STABLE_KINDS: readonly ItemKind[] = ["preference", "background", "agreement", "persona", "decision"];

/**
 * Long-term memory (docs/memory-design.md). The store and its gate live in
 * src/memory/; this module wires them into sessions (snapshot, agent tools,
 * extraction after runs) and the window (memory.* methods, the memory log).
 */
export class MemoryModule implements CoreModule {
	readonly modelFacing = true;
	private readonly core: Core;
	private readonly db: Db;
	private readonly llm: Llm;
	readonly store: MemoryStore;
	readonly workspaces: Workspaces;
	/** Session id → refresh the snapshot at the next prompt. */
	private readonly refreshRequested = new Set<string>();
	private readonly extracting = new Set<string>();

	constructor(core: Core, llm: Llm, options: { clock?: () => number } = {}) {
		this.core = core;
		this.db = core.db;
		this.llm = llm;
		const clock = options.clock ?? now;
		this.store = new MemoryStore(core.db, { clock, confirmWrites: () => core.settings.get().memoryConfirmWrites });
		this.workspaces = new Workspaces(core.db, clock);
		this.store.onChange((batchId) => core.broadcast({ event: "memory.changed", batchId }));
		core.declareBackup({
			id: "memory",
			title: "记忆",
			tables: [
				"memories",
				"memory_blocks",
				"memory_snapshots",
				"memory_extraction",
				"workspaces",
				"workspace_groups",
				"workspace_group_members",
				"memory_items",
				"memory_versions",
				"memory_sources",
				"memory_links",
				"memory_batches",
				"memory_ops",
				"memory_pending",
			],
			paths: {
				memories: { cwd: "path", source_session: "path" },
				workspaces: { path: "path", path_key: "key" },
				memory_sources: { ref: "path" },
				memory_batches: { session_ref: "path" },
				memory_pending: { session_ref: "path", op: "json" },
			},
		});
		core.exemptFromApproval(...MEMORY_TOOLS);
		const report = migrateV02(core.db, this.store, this.workspaces, core.paths.butterflyDir);
		if (report) core.log.info(`memory: moved v0.2 memory over (${report.items} items, ${report.blockLines} block lines, ${report.pending} waiting, ${report.skipped.length} left out)`);
		this.register();
	}

	start(): void {
		this.core.module(TasksModule)?.addInboxSource(() =>
			this.store.pending().map((p) => ({ kind: "memory", id: p.id, title: pendingText(p), createdAt: p.createdAt, cwd: p.workspaceId ? (this.workspaces.get(p.workspaceId)?.path ?? null) : null })),
		);
	}

	private get enabled(): boolean {
		return this.core.settings.get().memoryEnabled;
	}

	/** The scopes a session in [cwd] reads and writes. */
	scopesFor(cwd: string): ScopeSet {
		return allowedScopes(this.workspaces, cwd, this.core.paths.butterflyDir);
	}

	private where(item: MemoryItem): string {
		switch (item.scope) {
			case "global":
				return "全局";
			case "butterfly":
				return "蝶君";
			case "group":
				return "共享组";
			case "workspace":
				return "本工作区";
		}
	}

	// ---- snapshot (step 2 of 0.5 rebuilds this with the budget and materials) ---------------

	/** The memory a task starts with: pinned items plus the ones most related to [prompt]. */
	snapshot(prompt: string, cwd: string): { content: string; ids: string[] } {
		const set = this.scopesFor(cwd);
		const live = this.store.list({ set, statuses: LIVE_STATUSES });
		const pinned = live.filter((m) => m.pinned);
		const budget = this.core.settings.get().memoryBudgetTokens;
		const grams = trigrams(prompt);
		const candidates = live
			.filter((m) => !m.pinned)
			.map((m) => ({ m, score: relevance(grams, m.content) + (m.scope !== "global" ? 0.3 : 0) + (m.kind === "preference" ? 0.2 : 0) - (m.status === "review" ? 0.5 : 0) }))
			.sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt);
		let used = pinned.reduce((sum, m) => sum + estimateTokens(m.content) + 6, 0);
		const picked: MemoryItem[] = [];
		for (const { m } of candidates) {
			const cost = estimateTokens(m.content) + 6;
			if (used + cost > budget) continue;
			picked.push(m);
			used += cost;
			if (picked.length >= 30) break;
		}
		if (pinned.length === 0 && picked.length === 0) return { content: "", ids: [] };
		const line = (m: MemoryItem) => `- [${KIND_LABEL[m.kind]}${m.scope !== "global" ? `·${this.where(m)}` : ""}${m.status === "review" ? "·待核对" : ""}] ${m.content} (#${m.id})`;
		const persona = [...pinned, ...picked].filter((m) => m.kind === "persona");
		const lines = [`<记忆快照 生成于 ${new Date(this.store.clock()).toLocaleDateString("zh-CN")}>`, "以下是 DreamFlutter 为这个任务准备的记忆，任务期间保持不变。条目以「用户」为主语；标「待核对」的还没核实，用之前留意。"];
		if (persona.length) lines.push("", "## 用户给你（Agent）的设定", ...persona.map(line));
		const pinnedOther = pinned.filter((m) => m.kind !== "persona");
		if (pinnedOther.length) lines.push("", "## 常驻", ...pinnedOther.map(line));
		const related = picked.filter((m) => m.kind !== "persona");
		if (related.length) lines.push("", "## 可能相关的记忆", ...related.map(line));
		lines.push(
			"</记忆快照>",
			"需要更多背景时用 memory_search 查找，也可以用 session_search 查以前的对话。用户明确要求你记住的事，用 memory_save 并设 explicit=true；你自己总结或推测的，设 explicit=false（会标成「推测」）。保存会直接生效并记入记忆日志，用户可以随时修改或撤销。",
		);
		const ids = [...pinned, ...picked].map((m) => m.id);
		return { content: lines.join("\n"), ids };
	}

	snapshotsFor(sessionId: string): { createdAt: number; content: string; memoryIds: string[] }[] {
		return this.db
			.all<{ created_at: number; content: string; memory_ids: string }>("SELECT * FROM memory_snapshots WHERE session_id = ? ORDER BY created_at DESC", sessionId)
			.map((r) => ({ createdAt: r.created_at, content: r.content, memoryIds: parseJson<string[]>(r.memory_ids, []) }));
	}

	// ---- extension ---------------------------------------------------------------------

	/** Snapshot injection and memory tools for one session slot. */
	extension(slot: { slotId: string }): ExtensionFactory {
		const module = this;
		return (pi: ExtensionAPI) => {
			const current = () => module.core.slots.get(slot.slotId);
			const incognito = () => current()?.incognito === true;
			const scopes = () => module.scopesFor(current()?.cwd ?? process.cwd());
			const sessionRef = () => current()?.info().sessionFile ?? null;
			/** A scheduled run: its memory changes wait for the user (nobody asked it to remember). */
			const unattended = () => current()?.unattended === true;

			pi.on("before_agent_start", (event, ctx) => {
				if (!module.enabled || incognito() || event.messageType !== "user") return undefined;
				const sessionId = ctx.sessionManager.getSessionId();
				const inContext = ctx.sessionManager
					.buildContextEntries()
					.some((e) => e.type === "custom_message" && (e as { customType?: string }).customType === MEMORY_MESSAGE_TYPE);
				if (inContext && !module.refreshRequested.has(sessionId)) return undefined;
				module.refreshRequested.delete(sessionId);
				const snapshot = module.snapshot(event.prompt, ctx.cwd);
				if (!snapshot.content) return undefined;
				module.store.markUsed(snapshot.ids);
				module.db.run(
					"INSERT OR REPLACE INTO memory_snapshots(session_id, created_at, content, memory_ids) VALUES(?, ?, ?, ?)",
					sessionId,
					now(),
					snapshot.content,
					json(snapshot.ids),
				);
				return { message: { customType: MEMORY_MESSAGE_TYPE, content: snapshot.content, display: false, details: { memoryIds: snapshot.ids } } };
			});

			const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
			const off = () => !module.enabled || incognito();
			/** 16.5's receipt: 「已保存」 only once the change is committed; waiting is said as waiting. */
			const receipt = (result: CommitResult, done: (item: MemoryItem) => string): string => {
				const applied = result.applied.find((a) => a.kind !== "status" || result.applied.length === 1) ?? result.applied[0];
				if (result.pending.length) {
					const why = result.pending[0]!.why;
					return why === "locked" ? "这条记忆被用户锁定了，修改建议已交给用户确认（没有生效）。" : why === "promote_global" ? "把工作区的记忆变成全局要用户决定，已交给用户确认（没有生效）。" : "已提出，等用户确认（还没有生效）。";
				}
				if (applied) {
					const item = module.store.get(applied.itemId);
					if (item) return done(item);
				}
				return `没有保存：${result.rejected[0]?.reason ?? "未知原因"}`;
			};

			pi.registerTool({
				name: "memory_search",
				label: "查找记忆",
				description: "Search the user's long-term memory (preferences, background, decisions, past experience). Use when the snapshot lacks something you need.",
				parameters: { type: "object", properties: { query: { type: "string", description: "What to look for" } }, required: ["query"] } as never,
				async execute(_id, params: { query: string }) {
					if (off()) return text("记忆功能已关闭。");
					const hits = module.store.list({ set: scopes(), query: params.query, limit: 12 });
					if (!hits.length) return text("没有找到相关记忆。");
					return text(
						hits
							.map((m) => `- [${KIND_LABEL[m.kind]}·${module.where(m)}·${LEVEL_LABEL[m.level]}${m.status === "review" ? "·待核对" : ""}] ${m.content} (#${m.id}，更新于 ${new Date(m.updatedAt).toLocaleDateString("zh-CN")})`)
							.join("\n"),
					);
				},
			});

			pi.registerTool({
				name: "memory_save",
				label: "记住",
				description:
					"Save one thing to long-term memory; it takes effect at once and goes in the user's memory log (they can change or undo it). Set explicit=true only when the user asked you to remember it; otherwise (your own inference or lesson learned) explicit=false, shown as 「推测」. " +
					"One fact per call. Write it about the user, in the third person (「用户……」). What the user set about you (your name, role, how to address them) is kind=persona, e.g. 「用户称 Agent 为……」, never a fact about the user. " +
					"Do not save: failures caused by a missing tool or setup (save how it was fixed instead), errors that went away on retry, attempts that never worked, one-off task details, or what skills and project rules already say. If a memory already says much the same, use memory_update.",
				parameters: {
					type: "object",
					properties: {
						content: { type: "string", description: "One self-contained fact, preference or lesson, in the user's language" },
						kind: { type: "string", enum: ITEM_KINDS },
						scope: { type: "string", enum: ["global", "workspace"], description: "workspace = only for the current folder/project (蝶君: its own partition). When unsure, workspace." },
						explicit: { type: "boolean" },
						long_term: { type: "boolean", description: "The user said to remember it for good" },
						pinned: { type: "boolean", description: "The user wants it in every conversation" },
						valid_until: { type: "string", description: "YYYY-MM-DD when it stops being true (「这周在赶论文」), if known" },
						reason: { type: "string", description: "Why this is worth remembering" },
					},
					required: ["content", "explicit"],
				} as never,
				async execute(_id, params: { content: string; kind?: ItemKind; scope?: "global" | "workspace"; explicit: boolean; long_term?: boolean; pinned?: boolean; valid_until?: string; reason?: string }) {
					if (off()) return text("记忆功能已关闭，没有保存。");
					const set = scopes();
					const kind = ITEM_KINDS.includes(params.kind as ItemKind) ? (params.kind as ItemKind) : "background";
					const target = params.scope === "global" ? { scope: "global" as ItemScope, workspaceId: null } : homeScope(set);
					const commit = (ops: MemoryOp[]) => module.store.commit({ actor: "main_agent", ops, explicit: params.explicit, allowed: set, sessionRef: sessionRef(), batchKind: "save", reason: params.reason, confirm: unattended() });
					// Much the same as a memory already there: a fuller version updates it, a shorter one is not saved twice.
					const twin = nearDuplicate(params.content, module.store.list({ set }));
					if (twin) {
						if (!saysMore(params.content, twin.content)) return text(`已经有相同意思的记忆（#${twin.id}：${twin.content}），没有重复保存。`);
						const result = commit([{ kind: "edit", id: twin.id, baseVersion: twin.version, patch: { content: params.content }, sources: [{ kind: "session", ref: sessionRef() }], reason: params.reason ?? "说得更完整" }]);
						return text(receipt(result, (item) => `已有相近的记忆，已把它改成新的说法（#${item.id}）。`));
					}
					const level: Level = params.explicit && params.long_term ? 3 : params.explicit && STABLE_KINDS.includes(kind) ? 2 : 1;
					const validUntil = params.valid_until && /^\d{4}-\d{2}-\d{2}$/.test(params.valid_until) ? new Date(`${params.valid_until}T23:59:59`).getTime() : null;
					const result = commit([
						{
							kind: "add",
							item: {
								content: params.content,
								kind,
								level,
								...target,
								confidence: params.explicit ? "user_explicit" : "agent_inferred",
								pinned: params.explicit && params.pinned === true,
								validUntil,
							},
							sources: [{ kind: "session", ref: sessionRef(), excerpt: params.reason ?? null }],
							reason: params.reason,
						},
					]);
					return text(receipt(result, (item) => `已保存到${module.where(item)}·${LEVEL_LABEL[item.level]}记忆（#${item.id}${params.explicit ? "" : "，标为推测"}）。`));
				},
			});

			pi.registerTool({
				name: "memory_update",
				label: "修改记忆",
				description: "Correct an existing memory (by its #id). Takes effect at once and goes in the memory log; set explicit=true when the user asked for the change. A memory the user locked only gets a suggestion.",
				parameters: {
					type: "object",
					properties: { id: { type: "string" }, content: { type: "string" }, explicit: { type: "boolean" }, reason: { type: "string" } },
					required: ["id", "content", "explicit"],
				} as never,
				async execute(_id, params: { id: string; content: string; explicit: boolean; reason?: string }) {
					if (off()) return text("记忆功能已关闭。");
					const target = module.store.get(params.id.replace(/^#/, ""));
					if (!target || !LIVE_STATUSES.includes(target.status)) return text("没有找到这条记忆。");
					const result = module.store.commit({
						actor: "main_agent",
						ops: [{ kind: "edit", id: target.id, baseVersion: target.version, patch: { content: params.content }, sources: [{ kind: "session", ref: sessionRef() }], reason: params.reason }],
						explicit: params.explicit,
						allowed: scopes(),
						sessionRef: sessionRef(),
						batchKind: "save",
						confirm: unattended(),
					});
					return text(receipt(result, (item) => `已修改（#${item.id}）。`));
				},
			});

			pi.registerTool({
				name: "memory_forget",
				label: "忘记",
				description: "A memory (by #id) is wrong or outdated. explicit=true (the user asked to forget it): it is set aside at once (recoverable from the memory log). Otherwise it is marked for review.",
				parameters: { type: "object", properties: { id: { type: "string" }, explicit: { type: "boolean" }, reason: { type: "string" } }, required: ["id", "explicit"] } as never,
				async execute(_id, params: { id: string; explicit: boolean; reason?: string }) {
					if (off()) return text("记忆功能已关闭。");
					const target = module.store.get(params.id.replace(/^#/, ""));
					if (!target || !LIVE_STATUSES.includes(target.status)) return text("没有找到这条记忆。");
					const status: ItemStatus = params.explicit ? "forgotten" : "review";
					if (status === target.status) return text("这条记忆已经在待复核里了。");
					const result = module.store.commit({
						actor: "main_agent",
						ops: [{ kind: "status", id: target.id, baseVersion: target.version, status, reason: params.reason ?? (params.explicit ? "用户要求忘记" : "可能已过时") }],
						explicit: params.explicit,
						allowed: scopes(),
						sessionRef: sessionRef(),
						batchKind: "save",
						confirm: unattended(),
					});
					return text(receipt(result, () => (params.explicit ? "已忘记（可以在记忆日志里恢复）。" : "已标为待复核。")));
				},
			});

			pi.registerTool({
				name: "session_search",
				label: "查找以前的对话",
				description: "Full-text search over the user's past conversations in this workspace. Returns matching snippets with session titles.",
				parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } as never,
				async execute(_id, params: { query: string }) {
					if (incognito()) return text("临时对话中不能查找以前的对话。");
					// §8: the same scope as memory: this workspace (or 蝶君's home), never another one's history.
					const set = scopes();
					const cwd = set.butterfly ? module.core.paths.butterflyDir : current()?.cwd;
					const result = (await module.core.call("sessions.search", { query: params.query, limit: 12, ...(cwd ? { cwd } : {}) })) as { title: string; role: string; snippet: string; modifiedAt: number | null }[];
					if (!result.length) return text("没有找到。");
					return text(
						result
							.map((h) => `- 「${h.title}」${h.modifiedAt ? `（${new Date(h.modifiedAt).toLocaleDateString("zh-CN")}）` : ""} ${h.role === "user" ? "用户" : "助手"}：${h.snippet}`)
							.join("\n"),
					);
				},
			});
		};
	}

	extensions(slot: { slotId: string }): ExtensionFactory[] {
		return [this.extension(slot)];
	}

	// ---- extraction after a run (step 3 of 0.5 hands this to the memory agent) ----------------

	onRunFinished(slot: Slot, run: Run): void {
		const settings = this.core.settings.get();
		if (run.status !== "done" || !settings.memoryEnabled || !settings.memoryAutoExtract || slot.incognito || slot.unattended) return;
		void this.extract(slot).catch((error) => this.core.log.warn("memory extraction failed", error));
	}

	/** Adds what was said since the last extraction to memory (auto-applied, in the memory log). */
	async extract(slot: Slot): Promise<CommitResult | undefined> {
		const session = slot.session;
		const sessionId = session.sessionId;
		if (this.extracting.has(sessionId)) return undefined;
		const messages = (session.messages as unknown as { role: string; content: unknown }[]).filter((m) => m.role === "user" || m.role === "assistant");
		const done = this.db.get<{ message_count: number }>("SELECT message_count FROM memory_extraction WHERE session_id = ?", sessionId)?.message_count ?? 0;
		const fresh = messages.slice(Math.min(done, messages.length));
		const userText = fresh.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n");
		if (userText.trim().length < 12) return undefined;
		this.extracting.add(sessionId);
		try {
			const set = this.scopesFor(slot.cwd);
			const sessionRef = slot.info().sessionFile;
			const transcript = fresh
				.map((m) => `${m.role === "user" ? "用户" : "助手"}：${textOf(m.content).slice(0, 1500)}`)
				.join("\n\n")
				.slice(-8000);
			// All the memories in scope (not just the ones sharing words with this conversation), so the same thing is not added again.
			const shown = this.store.list({ set, limit: 80 });
			const versions = new Map(shown.map((m) => [m.id, m.version]));
			const existing = shown.map((m) => `#${m.id} [${m.kind}] ${m.content}`).join("\n") || "（无）";
			const answer = await this.llm.complete(`已有的记忆：\n${existing}\n\n最近的对话：\n${transcript}`, {
				system:
					"你负责维护用户的长期记忆。从对话中找出值得长期记住的信息：用户稳定的偏好、个人或工作背景、定下的决定和约定、经确认有效的做事经验；还有这次任务做完了什么、定了什么、下一步是什么（每个任务最多 3 条，每条一句，kind 用 progress）。" +
					"对话里的「助手」是 DreamFlutter 里的 Agent（用户可能叫它「蝶君」等名字）；助手的名字、身份、能力和它说过的话都不是用户的信息。用户给 Agent 定的设定（名字、称呼、角色）用 kind=persona，写成「用户称 Agent 为……」。" +
					"不要提取：缺软件、没装好、路径不对、没配凭据造成的失败（要记的是怎么修好的）；重试就好了的临时错误；没有解决的失败；一次性的任务经过；闲聊；助手自己的话。一条只写一件事。" +
					"和已有记忆逐条对比：意思相同或相近的不要输出（换个说法也算重复）；比已有记忆更完整或有修正时用 update（给 target_id）；已有记忆被明确推翻用 delete（给 target_id）；真正的新信息才用 add。" +
					'只输出 JSON 数组，例如 [{"action":"add","kind":"preference","scope":"global","content":"用户喜欢简洁的中文回答","said":true,"reason":"用户说……"}]。没有就输出 []。' +
					"kind 取 preference/background/experience/decision/progress/agreement/observation/persona；scope 取 global（任何场合都适用）或 workspace（只和当前项目有关）；said=true 表示用户亲口说的，false 表示你的推测。content 用用户的语言、以「用户」为主语。",
				maxTokens: 1200,
				sessionModel: slot.info().model,
				timeoutMs: 60_000,
			});
			const items = parseJsonAnswer<{ action?: string; kind?: string; scope?: string; content?: string; reason?: string; target_id?: string; said?: boolean }[]>(answer) ?? [];
			const ops: MemoryOp[] = [];
			const added: { content: string }[] = [];
			const known = this.store.list({ set });
			for (const item of items.slice(0, 8)) {
				const action = (["add", "update", "delete"] as const).find((a) => a === item.action) ?? "add";
				const kind = ITEM_KINDS.find((k) => k === item.kind) ?? "background";
				const sources = [{ kind: "session" as const, ref: sessionRef, excerpt: item.reason ?? null }];
				const content = (item.content ?? "").trim();
				if (action !== "add") {
					const target = item.target_id ? this.store.get(item.target_id.replace(/^#/, "")) : undefined;
					if (!target || !versions.has(target.id)) continue;
					if (action === "delete") ops.push({ kind: "status", id: target.id, baseVersion: versions.get(target.id), status: "refuted", sources, reason: item.reason ?? "被新的对话推翻" });
					else if (content) ops.push({ kind: "edit", id: target.id, baseVersion: versions.get(target.id), patch: { content }, sources, reason: item.reason ?? "说得更完整" });
					continue;
				}
				if (!content) continue;
				// The model still repeats itself now and then: a near repeat is dropped, or an update when it says more.
				const twin = nearDuplicate(content, [...known, ...added]);
				if (twin && !saysMore(content, twin.content)) continue;
				if (twin && "id" in twin) {
					const target = twin as MemoryItem;
					ops.push({ kind: "edit", id: target.id, baseVersion: target.version, patch: { content }, sources, reason: item.reason ?? "说得更完整" });
					continue;
				}
				if (twin) continue;
				const target = item.scope === "global" ? { scope: "global" as ItemScope, workspaceId: null } : homeScope(set);
				ops.push({ kind: "add", item: { content, kind, level: 1, ...target, confidence: item.said === true ? "user_reported" : "agent_inferred" }, sources, reason: item.reason });
				added.push({ content });
			}
			const result = ops.length ? this.store.commit({ actor: "memory_agent", ops, allowed: set, sessionRef, batchKind: "extract", reason: "对话结束后的整理" }) : undefined;
			this.db.run(
				"INSERT INTO memory_extraction(session_id, message_count, updated_at) VALUES(?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET message_count = excluded.message_count, updated_at = excluded.updated_at",
				sessionId,
				messages.length,
				now(),
			);
			if (result?.pending.length && !this.core.clients.size && this.core.settings.get().notifications) {
				this.core.notifier.notify("有记忆改动等你确认", `${result.pending.length} 条，打开 DreamFlutter 的「记忆」查看`);
			}
			return result;
		} finally {
			this.extracting.delete(sessionId);
		}
	}

	// ---- methods -----------------------------------------------------------------------

	/** An item for the window: with its workspace's folder. */
	private decorate(item: MemoryItem): MemoryItem & { workspacePath: string | null } {
		return { ...item, workspacePath: item.workspaceId ? (this.workspaces.get(item.workspaceId)?.path ?? null) : null };
	}

	/** The scope of a new item the user adds from the window. */
	private userTarget(p: Params): { scope: ItemScope; workspaceId: string | null; groupId: string | null } {
		const scope = (ITEM_SCOPES.find((s) => s === p.scope) ?? "global") as ItemScope;
		if (scope === "workspace") {
			const workspaceId = str(p.workspaceId) ?? (str(p.cwd) ? this.workspaces.ensure(str(p.cwd)!).id : undefined);
			if (!workspaceId) throw new RpcError("bad_request", "工作区记忆要指明工作区");
			return { scope, workspaceId, groupId: null };
		}
		if (scope === "group") return { scope, workspaceId: null, groupId: requireStr(p.groupId, "groupId") };
		return { scope, workspaceId: null, groupId: null };
	}

	private userCommit(ops: MemoryOp[], batchKind: string, reason?: string): CommitResult {
		const result = this.store.commit({ actor: "user", ops, batchKind, reason });
		if (!result.applied.length && result.rejected.length) throw new RpcError("bad_request", result.rejected[0]!.reason);
		return result;
	}

	private register(): void {
		const core = this.core;
		const store = this.store;
		const many = <T extends string>(v: unknown, allowed: readonly T[]): T[] | undefined => {
			const list = Array.isArray(v) ? v : typeof v === "string" ? [v] : undefined;
			return list?.filter((x): x is T => allowed.includes(x as T));
		};
		const level = (v: unknown): Level | undefined => (v === 1 || v === 2 || v === 3 ? v : undefined);
		const patchOf = (p: Params): ItemPatch => {
			const patch: ItemPatch = {};
			if (typeof p.content === "string") patch.content = p.content;
			if (ITEM_KINDS.includes(p.kind as ItemKind)) patch.kind = p.kind as ItemKind;
			if (level(p.level)) patch.level = level(p.level);
			if (p.conditions === null || typeof p.conditions === "string") patch.conditions = p.conditions as string | null;
			if (typeof p.scope === "string") Object.assign(patch, this.userTarget(p));
			if (CONFIDENCES.includes(p.confidence as never)) patch.confidence = p.confidence as ItemPatch["confidence"];
			if (typeof p.pinned === "boolean") patch.pinned = p.pinned;
			if (RETENTIONS.includes(p.retention as never)) patch.retention = p.retention as ItemPatch["retention"];
			if (typeof p.autoOk === "boolean") patch.autoOk = p.autoOk;
			if (p.validUntil === null || typeof p.validUntil === "number") patch.validUntil = p.validUntil as number | null;
			if (p.nextReviewAt === null || typeof p.nextReviewAt === "number") patch.nextReviewAt = p.nextReviewAt as number | null;
			return patch;
		};

		// The v0.5 methods (docs/api: the memory log is 「默认自动生效」's safety net, §4).
		core.register("memory.items", (p) => {
			const set = str(p.cwd) ? this.scopesFor(str(p.cwd)!) : undefined;
			return store
				.list({
					statuses: many(p.status, ITEM_STATUSES),
					set,
					scope: ITEM_SCOPES.find((s) => s === p.scope),
					workspaceId: str(p.workspaceId),
					level: level(p.level),
					pinned: typeof p.pinned === "boolean" ? p.pinned : undefined,
					query: str(p.query),
					limit: num(p.limit),
				})
				.map((m) => this.decorate(m));
		});
		core.register("memory.item", (p) => {
			const id = requireStr(p.id, "id");
			const item = store.get(id);
			if (!item) throw new RpcError("not_found", "没有这条记忆");
			return { item: this.decorate(item), versions: store.versions(id), sources: store.sources(id), links: store.links(id), log: store.log({ itemId: id }).flatMap((d) => d.entries) };
		});
		core.register("memory.save", (p) => {
			const kind = (ITEM_KINDS.find((k) => k === p.kind) ?? "background") as ItemKind;
			const result = this.userCommit(
				[
					{
						kind: "add",
						item: {
							content: requireStr(p.content, "content"),
							kind,
							level: level(p.level) ?? 2,
							...this.userTarget(p),
							confidence: "user_explicit",
							conditions: str(p.conditions) ?? null,
							pinned: p.pinned === true,
							retention: RETENTIONS.find((r) => r === p.retention),
							validUntil: num(p.validUntil) ?? null,
						},
						sources: [{ kind: "user_edit" }],
					},
				],
				"user",
			);
			return { ...result, item: this.decorate(store.get(result.applied[0]!.itemId)!) };
		});
		core.register("memory.update", (p) => {
			const id = requireStr(p.id, "id");
			const result = this.userCommit([{ kind: "edit", id, baseVersion: num(p.version), patch: patchOf(p), sources: [{ kind: "user_edit" }] }], "user", str(p.reason));
			return { ...result, item: this.decorate(store.get(id)!) };
		});
		core.register("memory.setStatus", (p) => {
			const id = requireStr(p.id, "id");
			const status = ITEM_STATUSES.find((s) => s === p.status);
			if (!status) throw new RpcError("bad_request", "status is required");
			const result = this.userCommit([{ kind: "status", id, baseVersion: num(p.version), status, reason: str(p.reason) }], "user", str(p.reason));
			return { ...result, item: this.decorate(store.get(id)!) };
		});
		core.register("memory.log", (p) => {
			const days = num(p.days);
			const since = num(p.since) ?? (days ? store.clock() - days * 86_400_000 : undefined);
			return store.log({ since, until: num(p.until), itemId: str(p.itemId), limit: num(p.limit) }).map((d) => ({ ...d, entries: d.entries.map((e) => ({ ...e, after: this.decorate(e.after), before: e.before && this.decorate(e.before) })) }));
		});
		core.register("memory.undo", (p) => store.undo(requireStr(p.opId, "opId")));
		core.register("memory.undoBatch", (p) => store.undoBatch(requireStr(p.batchId, "batchId")));
		core.register("memory.pending", (p) => store.pending({ set: str(p.cwd) ? this.scopesFor(str(p.cwd)!) : undefined }));
		core.register("memory.acceptPending", (p) => store.acceptPending(requireStr(p.id, "id"), { content: str(p.content) }));
		core.register("memory.rejectPending", (p) => {
			store.rejectPending(requireStr(p.id, "id"));
			return { ok: true };
		});
		core.register("memory.workspaces", () => this.workspaces.list());
		core.register("memory.setWorkspaceBackground", (p) => {
			this.workspaces.setGlobalBackground(requireStr(p.id, "id"), p.on === true);
			core.broadcast({ event: "memory.changed", batchId: null });
			return { ok: true };
		});
		core.register("memory.migrationReport", () => migrationDone(this.db) ?? null);
		core.register("memory.snapshots", (p) => this.snapshotsFor(requireStr(p.sessionId, "sessionId")));
		core.register("memory.refresh", (p) => {
			this.refreshRequested.add(requireStr(p.sessionId, "sessionId"));
			return { ok: true };
		});
		core.register("memory.extractNow", async (p) => this.extract(core.slot(p.slotId)) ?? null);
		core.register("memory.export", () => ({
			items: store.list({ statuses: ITEM_STATUSES }).map((m) => ({ ...this.decorate(m), sources: store.sources(m.id) })),
			workspaces: this.workspaces.list(),
			// v0.2's shape, for what reads exports made before 0.5.
			blocks: this.blocks(),
			memories: store.list().map((m) => this.legacy(m)),
			exportedAt: now(),
		}));
		core.register("memory.clear", (p) => {
			let items = store.list();
			if (p.scope === "workspace") {
				const ws = this.workspaces.byPath(normalizeCwd(requireStr(p.cwd, "cwd")));
				items = ws ? items.filter((m) => m.scope === "workspace" && m.workspaceId === ws.id) : [];
			}
			// One batch: 「清空」 can be undone from the memory log in one go.
			if (items.length) store.commit({ actor: "user", ops: items.map((m) => ({ kind: "status" as const, id: m.id, status: "forgotten" as const })), batchKind: "clear", reason: p.scope === "workspace" ? "清空本工作区的记忆" : "清空全部记忆" });
			return { ok: true };
		});

		// v0.2's methods, on the v0.5 store, until the memory page moves over (0.5 step 8).
		core.register("memory.list", (p) => {
			const statuses = many(p.status, ["active", "candidate", "superseded", "deleted"] as const) ?? ["active"];
			const set = str(p.cwd) ? this.scopesFor(str(p.cwd)!) : undefined;
			const out: Record<string, unknown>[] = [];
			if (statuses.includes("candidate")) out.push(...store.pending({ set }).map((c) => this.legacyPending(c)));
			const itemStatuses: ItemStatus[] = [];
			if (statuses.includes("active")) itemStatuses.push("active", "review");
			if (statuses.includes("superseded")) itemStatuses.push("superseded", "outdated", "refuted", "archived");
			if (statuses.includes("deleted")) itemStatuses.push("forgotten", "withdrawn", "ended");
			if (itemStatuses.length) out.push(...store.list({ statuses: itemStatuses, set, query: str(p.query), limit: num(p.limit) }).filter((m) => !isBlockItem(m)).map((m) => this.legacy(m)));
			return out;
		});
		core.register("memory.add", (p) => {
			const kind = (ITEM_KINDS.find((k) => k === p.kind) ?? "background") as ItemKind;
			const result = this.userCommit([{ kind: "add", item: { content: requireStr(p.content, "content"), kind, level: 2, ...this.userTarget(p), confidence: "user_explicit" }, sources: [{ kind: "user_edit" }] }], "user");
			return this.legacy(store.get(result.applied[0]!.itemId)!);
		});
		core.register("memory.edit", (p) => {
			const id = requireStr(p.id, "id");
			const patch = patchOf({ content: p.content, kind: p.kind, ...(typeof p.scope === "string" ? { scope: p.scope, cwd: p.cwd } : {}) });
			this.userCommit([{ kind: "edit", id, patch, sources: [{ kind: "user_edit" }] }], "user");
			return this.legacy(store.get(id)!);
		});
		core.register("memory.remove", (p) => {
			const item = store.get(requireStr(p.id, "id"));
			if (item && LIVE_STATUSES.includes(item.status)) this.userCommit([{ kind: "status", id: item.id, status: "forgotten" }], "user");
			return { ok: true };
		});
		core.register("memory.history", (p) => store.versions(requireStr(p.id, "id")).map((v) => this.legacy(v.item)));
		core.register("memory.accept", (p) => {
			store.acceptPending(requireStr(p.id, "id"), { content: str(p.content) });
			return { ok: true };
		});
		core.register("memory.reject", (p) => {
			store.rejectPending(requireStr(p.id, "id"));
			return { ok: true };
		});
		core.register("memory.blocks", () => this.blocks());
		core.register("memory.setBlock", (p) => {
			this.setBlock(requireStr(p.key, "key"), { content: typeof p.content === "string" ? p.content : undefined, locked: typeof p.locked === "boolean" ? p.locked : undefined });
			return this.blocks();
		});
	}

	/** v0.2's blocks, read from the pinned global items of the matching kind. */
	blocks(): { key: string; title: string; content: string; locked: boolean; updatedAt: number | null }[] {
		const pinned = this.store.list({ pinned: true, scope: "global" });
		return BLOCKS.map((b) => {
			const items = pinned.filter((m) => m.kind === b.kind).reverse();
			return { key: b.key, title: b.title, content: items.map((m) => m.content).join("\n"), locked: items.length > 0 && items.every((m) => m.retention === "locked"), updatedAt: items.length ? Math.max(...items.map((m) => m.updatedAt)) : null };
		});
	}

	/** Writing a v0.2 block: its lines become pinned items (one batch). */
	setBlock(key: string, patch: { content?: string; locked?: boolean }): void {
		const block = BLOCKS.find((b) => b.key === key);
		if (!block) throw new RpcError("bad_request", `未知的记忆块：${key}`);
		const items = this.store.list({ pinned: true, scope: "global" }).filter((m) => m.kind === block.kind);
		const ops: MemoryOp[] = [];
		if (patch.content !== undefined) {
			const lines = splitBlock(patch.content);
			for (const m of items) if (!lines.includes(m.content)) ops.push({ kind: "status", id: m.id, status: "forgotten", reason: `从「${block.title}」里删掉` });
			for (const line of lines) {
				if (items.some((m) => m.content === line)) continue;
				ops.push({ kind: "add", item: { content: line, kind: block.kind, level: 2, scope: "global", confidence: "user_explicit", pinned: true, retention: (patch.locked ?? items[0]?.retention === "locked") ? "locked" : "normal" }, sources: [{ kind: "user_edit" }] });
			}
		}
		if (patch.locked !== undefined) for (const m of items) if ((m.retention === "locked") !== patch.locked) ops.push({ kind: "edit", id: m.id, patch: { retention: patch.locked ? "locked" : "normal" } });
		if (ops.length) this.store.commit({ actor: "user", ops, batchKind: "user", reason: `修改「${block.title}」` });
	}

	/** An item in v0.2's shape. */
	private legacy(m: MemoryItem): Record<string, unknown> {
		const created = m.createdBy as Actor;
		return {
			id: m.id,
			scope: m.scope === "global" ? "global" : "workspace",
			cwd: m.scope === "butterfly" ? this.core.paths.butterflyDir : m.workspaceId ? (this.workspaces.get(m.workspaceId)?.path ?? null) : null,
			kind: m.kind,
			content: m.content,
			source: created === "user" ? "manual" : m.confidence === "user_explicit" ? "user" : "agent",
			sourceSession: this.store.sources(m.id).find((s) => s.kind === "session")?.ref ?? null,
			status: LIVE_STATUSES.includes(m.status) ? "active" : m.status === "forgotten" || m.status === "withdrawn" || m.status === "ended" ? "deleted" : "superseded",
			action: null,
			targetId: null,
			replacedBy: null,
			reason: null,
			createdAt: m.createdAt,
			updatedAt: m.updatedAt,
			level: m.level,
			pinned: m.pinned,
			version: m.version,
		};
	}

	private legacyPending(p: PendingChange): Record<string, unknown> {
		const op = p.op;
		const content = op.kind === "add" ? op.item.content : op.kind === "edit" ? (op.patch.content ?? p.current?.content ?? "") : (p.current?.content ?? "");
		const kind = op.kind === "add" ? op.item.kind : (p.current?.kind ?? "background");
		return {
			id: p.id,
			scope: p.scope === "global" ? "global" : "workspace",
			cwd: p.scope === "butterfly" ? this.core.paths.butterflyDir : p.workspaceId ? (this.workspaces.get(p.workspaceId)?.path ?? null) : null,
			kind,
			content,
			source: "agent",
			sourceSession: p.sessionRef,
			status: "candidate",
			action: op.kind === "add" ? "add" : op.kind === "status" ? "delete" : "update",
			targetId: p.itemId,
			replacedBy: null,
			reason: p.reason,
			createdAt: p.createdAt,
			updatedAt: p.createdAt,
			why: p.why,
		};
	}
}

/** A pinned global item the v0.2 page shows inside a block, not in the list. */
function isBlockItem(m: MemoryItem): boolean {
	return m.pinned && m.scope === "global" && BLOCKS.some((b) => b.kind === m.kind);
}

/** One line for a waiting change (the inbox). */
function pendingText(p: PendingChange): string {
	const op = p.op;
	if (op.kind === "add") return op.item.content;
	if (op.kind === "edit") return op.patch.content ?? p.current?.content ?? "修改记忆";
	return p.current?.content ?? "记忆状态变化";
}
