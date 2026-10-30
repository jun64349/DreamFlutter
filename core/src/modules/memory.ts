import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Core, CoreModule } from "../core.ts";
import { normalizeCwd, RpcError, requireStr, samePath, str } from "../core.ts";
import type { Db } from "../db.ts";
import { json, now, parseJson } from "../db.ts";
import type { Run } from "../runs.ts";
import { textOf } from "../runs.ts";
import type { Slot } from "../slots/slot.ts";
import { parseJsonAnswer, type Llm } from "./llm.ts";

export type MemoryKind = "preference" | "background" | "experience";
export type MemoryScope = "global" | "workspace";
/** user = the user said it; agent = the agent inferred it (user confirmed); manual = typed in the memory page. */
export type MemorySource = "user" | "agent" | "manual";
export type MemoryStatus = "active" | "candidate" | "superseded" | "deleted" | "rejected" | "applied";
export type CandidateAction = "add" | "update" | "delete";

export interface Memory {
	id: string;
	scope: MemoryScope;
	cwd: string | null;
	kind: MemoryKind;
	content: string;
	source: MemorySource;
	sourceSession: string | null;
	status: MemoryStatus;
	/** Candidates: what accepting does. */
	action: CandidateAction | null;
	/** Candidates updating or deleting an existing memory. */
	targetId: string | null;
	replacedBy: string | null;
	/** Why it is worth remembering / evidence. */
	reason: string | null;
	createdAt: number;
	updatedAt: number;
}

export const BLOCKS = [
	{ key: "about_me", title: "关于我" },
	{ key: "preferences", title: "偏好与习惯" },
	{ key: "agreements", title: "当前约定" },
] as const;
export type BlockKey = (typeof BLOCKS)[number]["key"];
export const BLOCK_LIMIT = 1500;

const KIND_LABEL: Record<MemoryKind, string> = { preference: "偏好", background: "背景", experience: "经验" };
export const MEMORY_MESSAGE_TYPE = "df-memory";
export const MEMORY_TOOLS = ["memory_search", "memory_save", "memory_update", "memory_forget", "memory_block_edit", "session_search"];

interface Row {
	id: string;
	scope: string;
	cwd: string | null;
	kind: string;
	content: string;
	source: string;
	source_session: string | null;
	status: string;
	action: string | null;
	target_id: string | null;
	replaced_by: string | null;
	reason: string | null;
	created_at: number;
	updated_at: number;
}

function toMemory(row: Row): Memory {
	return {
		id: row.id,
		scope: row.scope as MemoryScope,
		cwd: row.cwd,
		kind: row.kind as MemoryKind,
		content: row.content,
		source: row.source as MemorySource,
		sourceSession: row.source_session,
		status: row.status as MemoryStatus,
		action: row.action as CandidateAction | null,
		targetId: row.target_id,
		replacedBy: row.replaced_by,
		reason: row.reason,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** Character trigrams (lower-cased, whitespace-collapsed): works for Chinese and English alike. */
function trigrams(text: string): Set<string> {
	const clean = text.toLowerCase().replace(/\s+/g, " ").trim();
	const out = new Set<string>();
	for (let i = 0; i + 3 <= clean.length; i++) out.add(clean.slice(i, i + 3));
	if (clean.length > 0 && clean.length < 3) out.add(clean);
	return out;
}

/** Relevance of [memory] to [query] by shared trigrams, normalized by memory length. */
export function relevance(query: Set<string>, memory: string): number {
	const grams = trigrams(memory);
	if (grams.size === 0) return 0;
	let shared = 0;
	for (const g of grams) if (query.has(g)) shared++;
	return shared / Math.sqrt(grams.size);
}

/** Rough token estimate: CJK characters ~1 token each, other text ~4 characters per token. */
export function estimateTokens(text: string): number {
	const cjk = (text.match(/[　-鿿＀-￯]/g) ?? []).length;
	return cjk + Math.ceil((text.length - cjk) / 4);
}

/**
 * Long-term memory (user's draft §1–2): always-on blocks, individual
 * memories with scope, kind, source and history, a per-task snapshot the
 * agent gets at task start, agent tools, and candidate extraction after runs
 * that the user confirms.
 */
export class MemoryModule implements CoreModule {
	readonly modelFacing = true;
	private readonly core: Core;
	private readonly db: Db;
	private readonly llm: Llm;
	/** Session id → refresh the snapshot at the next prompt. */
	private readonly refreshRequested = new Set<string>();
	private readonly extracting = new Set<string>();

	constructor(core: Core, llm: Llm) {
		this.core = core;
		this.db = core.db;
		this.llm = llm;
		core.exemptFromApproval(...MEMORY_TOOLS);
		this.register();
	}

	private get enabled(): boolean {
		return this.core.settings.get().memoryEnabled;
	}

	// ---- store -------------------------------------------------------------------------

	get(id: string): Memory | undefined {
		const row = this.db.get<Row>("SELECT * FROM memories WHERE id = ?", id);
		return row ? toMemory(row) : undefined;
	}

	list(filter: { status?: MemoryStatus | MemoryStatus[]; cwd?: string; query?: string; limit?: number } = {}): Memory[] {
		const statuses = filter.status ? (Array.isArray(filter.status) ? filter.status : [filter.status]) : ["active"];
		let rows = this.db
			.all<Row>(`SELECT * FROM memories WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY updated_at DESC`, ...statuses)
			.map(toMemory);
		if (filter.cwd) rows = rows.filter((m) => m.scope === "global" || samePath(m.cwd, filter.cwd));
		if (filter.query?.trim()) {
			const q = filter.query.trim().toLowerCase();
			const grams = trigrams(q);
			rows = rows
				.map((m) => ({ m, score: m.content.toLowerCase().includes(q) ? 100 : relevance(grams, m.content) }))
				.filter((x) => x.score > 0.3)
				.sort((a, b) => b.score - a.score)
				.map((x) => x.m);
		}
		return rows.slice(0, filter.limit ?? 500);
	}

	add(input: {
		content: string;
		kind?: MemoryKind;
		scope?: MemoryScope;
		cwd?: string | null;
		source: MemorySource;
		status?: MemoryStatus;
		action?: CandidateAction;
		targetId?: string | null;
		reason?: string | null;
		sourceSession?: string | null;
	}): Memory {
		const content = input.content.trim();
		if (!content) throw new RpcError("bad_request", "记忆内容不能为空");
		const scope = input.scope ?? "global";
		const at = now();
		const memory: Memory = {
			id: `m_${randomUUID().slice(0, 8)}`,
			scope,
			cwd: scope === "workspace" && input.cwd ? input.cwd : null,
			kind: input.kind ?? "background",
			content,
			source: input.source,
			sourceSession: input.sourceSession ?? null,
			status: input.status ?? "active",
			action: input.action ?? (input.status === "candidate" ? "add" : null),
			targetId: input.targetId ?? null,
			replacedBy: null,
			reason: input.reason ?? null,
			createdAt: at,
			updatedAt: at,
		};
		this.db.run(
			`INSERT INTO memories(id, scope, cwd, kind, content, source, source_session, status, action, target_id, reason, created_at, updated_at)
			 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			memory.id,
			memory.scope,
			memory.cwd,
			memory.kind,
			memory.content,
			memory.source,
			memory.sourceSession,
			memory.status,
			memory.action,
			memory.targetId,
			memory.reason,
			at,
			at,
		);
		this.changed();
		return memory;
	}

	/** Edits keep history: the old version is superseded by a new row. */
	edit(id: string, patch: { content?: string; kind?: MemoryKind; scope?: MemoryScope; cwd?: string | null }): Memory {
		const old = this.get(id);
		if (!old || old.status !== "active") throw new RpcError("not_found", "这条记忆不存在或已失效");
		const next = this.add({
			content: patch.content ?? old.content,
			kind: patch.kind ?? old.kind,
			scope: patch.scope ?? old.scope,
			cwd: patch.cwd !== undefined ? patch.cwd : old.cwd,
			source: old.source === "agent" ? "agent" : "manual",
			reason: old.reason,
			sourceSession: old.sourceSession,
		});
		this.db.run("UPDATE memories SET status = 'superseded', replaced_by = ?, updated_at = ? WHERE id = ?", next.id, now(), id);
		this.changed();
		return next;
	}

	remove(id: string): void {
		this.db.run("UPDATE memories SET status = 'deleted', updated_at = ? WHERE id = ? AND status = 'active'", now(), id);
		this.changed();
	}

	history(id: string): Memory[] {
		const chain: Memory[] = [];
		let current = this.get(id);
		const seen = new Set<string>();
		// Walk back through versions this one replaced.
		while (current && !seen.has(current.id)) {
			seen.add(current.id);
			chain.push(current);
			const previous = this.db.get<Row>("SELECT * FROM memories WHERE replaced_by = ?", current.id);
			current = previous ? toMemory(previous) : undefined;
		}
		return chain;
	}

	/** Accepts a candidate, optionally with edited content. */
	accept(id: string, content?: string): Memory | undefined {
		const candidate = this.get(id);
		if (!candidate || candidate.status !== "candidate") throw new RpcError("not_found", "这条候选记忆已经处理过了");
		const at = now();
		if (candidate.action === "delete") {
			if (candidate.targetId) this.db.run("UPDATE memories SET status = 'deleted', updated_at = ? WHERE id = ? AND status = 'active'", at, candidate.targetId);
			this.db.run("UPDATE memories SET status = 'applied', updated_at = ? WHERE id = ?", at, id);
			this.changed();
			return undefined;
		}
		if (candidate.targetId?.startsWith("block:")) {
			this.setBlock(candidate.targetId.slice(6), { content: (content ?? candidate.content).trim() });
			this.db.run("UPDATE memories SET status = 'applied', updated_at = ? WHERE id = ?", at, id);
			this.changed();
			return undefined;
		}
		this.db.run("UPDATE memories SET status = 'active', content = ?, action = NULL, updated_at = ? WHERE id = ?", (content ?? candidate.content).trim(), at, id);
		if (candidate.action === "update" && candidate.targetId) {
			this.db.run("UPDATE memories SET status = 'superseded', replaced_by = ?, updated_at = ? WHERE id = ? AND status = 'active'", id, at, candidate.targetId);
		}
		this.changed();
		return this.get(id);
	}

	reject(id: string): void {
		this.db.run("UPDATE memories SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'candidate'", now(), id);
		this.changed();
	}

	blocks(): { key: BlockKey; title: string; content: string; locked: boolean; updatedAt: number | null }[] {
		const rows = new Map(this.db.all<{ key: string; content: string; locked: number; updated_at: number }>("SELECT * FROM memory_blocks").map((r) => [r.key, r]));
		return BLOCKS.map((b) => {
			const row = rows.get(b.key);
			return { key: b.key, title: b.title, content: row?.content ?? "", locked: row?.locked === 1, updatedAt: row?.updated_at ?? null };
		});
	}

	setBlock(key: string, patch: { content?: string; locked?: boolean }): void {
		if (!BLOCKS.some((b) => b.key === key)) throw new RpcError("bad_request", `未知的记忆块：${key}`);
		const current = this.blocks().find((b) => b.key === key)!;
		const content = (patch.content ?? current.content).slice(0, BLOCK_LIMIT);
		const locked = patch.locked ?? current.locked;
		this.db.run(
			"INSERT INTO memory_blocks(key, content, locked, updated_at) VALUES(?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET content = excluded.content, locked = excluded.locked, updated_at = excluded.updated_at",
			key,
			content,
			locked ? 1 : 0,
			now(),
		);
		this.changed();
	}

	private changed(): void {
		this.core.broadcast({ event: "memory.changed" });
	}

	// ---- snapshot ----------------------------------------------------------------------

	/** The memory a task starts with: blocks plus the memories most related to [prompt]. */
	snapshot(prompt: string, cwd: string): { content: string; ids: string[] } {
		const blocks = this.blocks().filter((b) => b.content.trim());
		const budget = this.core.settings.get().memoryBudgetTokens;
		const grams = trigrams(prompt);
		const candidates = this.list({ cwd })
			.map((m) => ({ m, score: relevance(grams, m.content) + (m.scope === "workspace" ? 0.3 : 0) + (m.kind === "preference" ? 0.2 : 0) }))
			.sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt);
		const picked: Memory[] = [];
		let used = 0;
		for (const { m } of candidates) {
			const cost = estimateTokens(m.content) + 6;
			if (used + cost > budget) continue;
			picked.push(m);
			used += cost;
			if (picked.length >= 30) break;
		}
		if (blocks.length === 0 && picked.length === 0) return { content: "", ids: [] };
		const lines = [`<记忆快照 生成于 ${new Date().toLocaleDateString("zh-CN")}>`, "以下是 DreamFlutter 为这个任务准备的用户长期记忆，任务期间保持不变。"];
		for (const block of blocks) lines.push("", `## ${block.title}`, block.content.trim());
		if (picked.length) {
			lines.push("", "## 可能相关的记忆");
			for (const m of picked) lines.push(`- [${KIND_LABEL[m.kind]}${m.scope === "workspace" ? "·本工作区" : ""}] ${m.content} (#${m.id})`);
		}
		lines.push(
			"</记忆快照>",
			"需要更多背景时用 memory_search 查找，也可以用 session_search 查以前的对话。用户明确要求你记住的事，用 memory_save 并设 explicit=true；你自己总结出的经验或推断，用 memory_save 设 explicit=false，会交给用户确认后才生效。",
		);
		return { content: lines.join("\n"), ids: picked.map((m) => m.id) };
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

			pi.registerTool({
				name: "memory_search",
				label: "查找记忆",
				description: "Search the user's long-term memory (preferences, background, past experience). Use when the snapshot lacks something you need.",
				parameters: { type: "object", properties: { query: { type: "string", description: "What to look for" } }, required: ["query"] } as never,
				async execute(_id, params: { query: string }) {
					if (!module.enabled || incognito()) return text("记忆功能已关闭。");
					const hits = module.list({ query: params.query, cwd: current()?.cwd, limit: 12 });
					const blocks = module.blocks().filter((b) => b.content && b.content.toLowerCase().includes(params.query.toLowerCase()));
					if (!hits.length && !blocks.length) return text("没有找到相关记忆。");
					return text(
						[...blocks.map((b) => `[${b.title}] ${b.content}`), ...hits.map((m) => `- [${KIND_LABEL[m.kind]}] ${m.content} (#${m.id}，更新于 ${new Date(m.updatedAt).toLocaleDateString("zh-CN")})`)].join("\n"),
					);
				},
			});

			pi.registerTool({
				name: "memory_save",
				label: "记住",
				description:
					"Save something to the user's long-term memory. Set explicit=true only when the user explicitly asked you to remember it (saved immediately). Otherwise (your own inference or lesson learned) set explicit=false: it becomes a candidate the user confirms.",
				parameters: {
					type: "object",
					properties: {
						content: { type: "string", description: "One self-contained fact, preference or lesson, in the user's language" },
						kind: { type: "string", enum: ["preference", "background", "experience"] },
						scope: { type: "string", enum: ["global", "workspace"], description: "workspace = only relevant to the current folder/project" },
						explicit: { type: "boolean" },
						reason: { type: "string", description: "Why this is worth remembering" },
					},
					required: ["content", "explicit"],
				} as never,
				async execute(_id, params: { content: string; kind?: MemoryKind; scope?: MemoryScope; explicit: boolean; reason?: string }) {
					if (!module.enabled || incognito()) return text("记忆功能已关闭，没有保存。");
					const slotNow = current();
					const memory = module.add({
						content: params.content,
						kind: params.kind,
						scope: params.scope,
						cwd: slotNow?.cwd ?? null,
						source: params.explicit ? "user" : "agent",
						status: params.explicit ? "active" : "candidate",
						reason: params.reason,
						sourceSession: slotNow?.info().sessionFile ?? null,
					});
					return text(params.explicit ? `已记住（#${memory.id}）。` : `已作为候选记忆提交给用户确认（#${memory.id}）。`);
				},
			});

			pi.registerTool({
				name: "memory_update",
				label: "修改记忆",
				description: "Propose a correction to an existing memory (by its #id). Applied immediately only when explicit=true (the user asked); otherwise the user confirms.",
				parameters: {
					type: "object",
					properties: { id: { type: "string" }, content: { type: "string" }, explicit: { type: "boolean" }, reason: { type: "string" } },
					required: ["id", "content", "explicit"],
				} as never,
				async execute(_id, params: { id: string; content: string; explicit: boolean; reason?: string }) {
					if (!module.enabled || incognito()) return text("记忆功能已关闭。");
					const target = module.get(params.id.replace(/^#/, ""));
					if (!target || target.status !== "active") return text("没有找到这条记忆。");
					if (params.explicit) return text(`已更新（#${module.edit(target.id, { content: params.content }).id}）。`);
					const c = module.add({ ...target, content: params.content, source: "agent", status: "candidate", action: "update", targetId: target.id, reason: params.reason, sourceSession: current()?.info().sessionFile ?? null });
					return text(`修改建议已提交给用户确认（#${c.id}）。`);
				},
			});

			pi.registerTool({
				name: "memory_forget",
				label: "忘记",
				description: "Remove a memory (by #id) that is wrong or outdated. Applied immediately only when explicit=true (the user asked); otherwise the user confirms.",
				parameters: { type: "object", properties: { id: { type: "string" }, explicit: { type: "boolean" }, reason: { type: "string" } }, required: ["id", "explicit"] } as never,
				async execute(_id, params: { id: string; explicit: boolean; reason?: string }) {
					if (!module.enabled || incognito()) return text("记忆功能已关闭。");
					const target = module.get(params.id.replace(/^#/, ""));
					if (!target || target.status !== "active") return text("没有找到这条记忆。");
					if (params.explicit) {
						module.remove(target.id);
						return text("已忘记。");
					}
					module.add({ ...target, source: "agent", status: "candidate", action: "delete", targetId: target.id, reason: params.reason, sourceSession: current()?.info().sessionFile ?? null });
					return text("删除建议已提交给用户确认。");
				},
			});

			pi.registerTool({
				name: "memory_block_edit",
				label: "修改常驻记忆",
				description:
					"Rewrite one always-on memory block: about_me, preferences or agreements (shown in the snapshot). Applied directly only when explicit=true and the block is not locked; otherwise the user confirms the new text.",
				parameters: {
					type: "object",
					properties: { key: { type: "string", enum: BLOCKS.map((b) => b.key) }, content: { type: "string", description: "The complete new text of the block" }, explicit: { type: "boolean" }, reason: { type: "string" } },
					required: ["key", "content", "explicit"],
				} as never,
				async execute(_id, params: { key: string; content: string; explicit: boolean; reason?: string }) {
					if (!module.enabled || incognito()) return text("记忆功能已关闭。");
					const block = module.blocks().find((b) => b.key === params.key);
					if (!block) return text("没有这个记忆块。");
					if (params.explicit && !block.locked) {
						module.setBlock(block.key, { content: params.content });
						return text(`已更新「${block.title}」。`);
					}
					module.add({ content: params.content.slice(0, BLOCK_LIMIT), kind: "background", source: "agent", status: "candidate", action: "update", targetId: `block:${block.key}`, reason: params.reason ?? `修改「${block.title}」`, sourceSession: current()?.info().sessionFile ?? null });
					return text(block.locked ? `「${block.title}」已锁定，修改建议已提交给用户确认。` : "修改建议已提交给用户确认。");
				},
			});

			pi.registerTool({
				name: "session_search",
				label: "查找以前的对话",
				description: "Full-text search over the user's past conversations (all workspaces). Returns matching snippets with session titles.",
				parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } as never,
				async execute(_id, params: { query: string }) {
					if (incognito()) return text("临时对话中不能查找以前的对话。");
					const result = (await module.core.call("sessions.search", { query: params.query, limit: 12 })) as { title: string; role: string; snippet: string; modifiedAt: number | null }[];
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

	// ---- candidate extraction ----------------------------------------------------------

	onRunFinished(slot: Slot, run: Run): void {
		const settings = this.core.settings.get();
		if (run.status !== "done" || !settings.memoryEnabled || !settings.memoryAutoExtract || slot.incognito || slot.unattended) return;
		void this.extract(slot).catch((error) => this.core.log.warn("memory extraction failed", error));
	}

	/** Proposes candidate memories from what was said since the last extraction. */
	async extract(slot: Slot): Promise<Memory[]> {
		const session = slot.session;
		const sessionId = session.sessionId;
		if (this.extracting.has(sessionId)) return [];
		const messages = (session.messages as unknown as { role: string; content: unknown }[]).filter((m) => m.role === "user" || m.role === "assistant");
		const done = this.db.get<{ message_count: number }>("SELECT message_count FROM memory_extraction WHERE session_id = ?", sessionId)?.message_count ?? 0;
		const fresh = messages.slice(Math.min(done, messages.length));
		const userText = fresh.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n");
		if (userText.trim().length < 12) return [];
		this.extracting.add(sessionId);
		try {
			const transcript = fresh
				.map((m) => `${m.role === "user" ? "用户" : "助手"}：${textOf(m.content).slice(0, 1500)}`)
				.join("\n\n")
				.slice(-8000);
			const related = this.list({ query: userText.slice(0, 500), cwd: slot.cwd, limit: 15 });
			const existing = related.length ? related.map((m) => `#${m.id} [${m.kind}] ${m.content}`).join("\n") : "（无）";
			const answer = await this.llm.complete(
				`已有的相关记忆：\n${existing}\n\n最近的对话：\n${transcript}`,
				{
					system:
						"你负责维护用户的长期记忆。从对话中找出值得长期记住的信息：稳定的个人偏好、个人或工作背景、经确认有效的做事经验。" +
						"不要提取一次性任务细节、闲聊或助手自己的话。和已有记忆对比：新信息用 add；修正已有记忆用 update（给 target_id）；已有记忆被明确推翻用 delete；重复的不要输出。" +
						'只输出 JSON 数组，例如 [{"action":"add","kind":"preference","scope":"global","content":"喜欢简洁的中文回答","reason":"用户说……"}]。没有就输出 []。' +
						"kind 取 preference/background/experience；scope 取 global（任何场合都适用）或 workspace（只和当前项目有关）。content 用用户的语言，一条一件事。",
					maxTokens: 1200,
					sessionModel: slot.info().model,
					timeoutMs: 60_000,
				},
			);
			const items = parseJsonAnswer<{ action?: string; kind?: string; scope?: string; content?: string; reason?: string; target_id?: string }[]>(answer) ?? [];
			const created: Memory[] = [];
			const known = new Set(this.list({ status: ["active", "candidate"] }).map((m) => m.content.trim()));
			for (const item of items.slice(0, 8)) {
				const action = (["add", "update", "delete"] as const).find((a) => a === item.action) ?? "add";
				const target = item.target_id ? this.get(item.target_id.replace(/^#/, "")) : undefined;
				if (action !== "add" && (!target || target.status !== "active")) continue;
				const content = (action === "delete" ? target!.content : item.content ?? "").trim();
				if (!content || (action === "add" && known.has(content))) continue;
				created.push(
					this.add({
						content,
						kind: (["preference", "background", "experience"] as const).find((k) => k === item.kind) ?? target?.kind ?? "background",
						scope: item.scope === "workspace" ? "workspace" : (target?.scope ?? "global"),
						cwd: slot.cwd,
						source: "agent",
						status: "candidate",
						action,
						targetId: target?.id ?? null,
						reason: item.reason ?? null,
						sourceSession: slot.info().sessionFile,
					}),
				);
			}
			this.db.run(
				"INSERT INTO memory_extraction(session_id, message_count, updated_at) VALUES(?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET message_count = excluded.message_count, updated_at = excluded.updated_at",
				sessionId,
				messages.length,
				now(),
			);
			if (created.length && !this.core.clients.size && this.core.settings.get().notifications) {
				this.core.notifier.notify("有新的候选记忆", `${created.length} 条，打开 DreamFlutter 的「记忆」确认`);
			}
			return created;
		} finally {
			this.extracting.delete(sessionId);
		}
	}

	// ---- methods -----------------------------------------------------------------------

	private register(): void {
		const core = this.core;
		const kind = (v: unknown) => (["preference", "background", "experience"] as const).find((k) => k === v);
		const scope = (v: unknown) => (["global", "workspace"] as const).find((k) => k === v);
		core.register("memory.list", (p) =>
			this.list({
				status: (Array.isArray(p.status) ? p.status : typeof p.status === "string" ? [p.status] : undefined) as MemoryStatus[] | undefined,
				cwd: str(p.cwd),
				query: str(p.query),
				limit: typeof p.limit === "number" ? p.limit : undefined,
			}),
		);
		core.register("memory.add", (p) =>
			this.add({ content: requireStr(p.content, "content"), kind: kind(p.kind), scope: scope(p.scope), cwd: str(p.cwd) ?? null, source: "manual" }),
		);
		core.register("memory.edit", (p) =>
			this.edit(requireStr(p.id, "id"), { content: str(p.content), kind: kind(p.kind), scope: scope(p.scope), cwd: p.cwd === null ? null : str(p.cwd) }),
		);
		core.register("memory.remove", (p) => {
			this.remove(requireStr(p.id, "id"));
			return { ok: true };
		});
		core.register("memory.history", (p) => this.history(requireStr(p.id, "id")));
		core.register("memory.accept", (p) => this.accept(requireStr(p.id, "id"), str(p.content)) ?? { ok: true });
		core.register("memory.reject", (p) => {
			this.reject(requireStr(p.id, "id"));
			return { ok: true };
		});
		core.register("memory.blocks", () => this.blocks());
		core.register("memory.setBlock", (p) => {
			this.setBlock(requireStr(p.key, "key"), { content: typeof p.content === "string" ? p.content : undefined, locked: typeof p.locked === "boolean" ? p.locked : undefined });
			return this.blocks();
		});
		core.register("memory.snapshots", (p) => this.snapshotsFor(requireStr(p.sessionId, "sessionId")));
		core.register("memory.refresh", (p) => {
			this.refreshRequested.add(requireStr(p.sessionId, "sessionId"));
			return { ok: true };
		});
		core.register("memory.extractNow", async (p) => this.extract(core.slot(p.slotId)));
		core.register("memory.export", () => ({ blocks: this.blocks(), memories: this.list({ status: ["active"] }), exportedAt: now() }));
		core.register("memory.clear", (p) => {
			const at = now();
			if (p.scope === "workspace") {
				const cwd = normalizeCwd(requireStr(p.cwd, "cwd"));
				for (const m of this.list({ status: ["active", "candidate"] })) if (m.scope === "workspace" && m.cwd && normalizeCwd(m.cwd) === cwd) this.db.run("UPDATE memories SET status = 'deleted', updated_at = ? WHERE id = ?", at, m.id);
			} else {
				this.db.run("UPDATE memories SET status = 'deleted', updated_at = ? WHERE status IN ('active', 'candidate')", at);
				this.db.run("UPDATE memory_blocks SET content = '', updated_at = ?", at);
			}
			this.changed();
			return { ok: true };
		});
	}
}
