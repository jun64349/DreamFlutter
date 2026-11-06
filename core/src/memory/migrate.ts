import type { Db } from "../db.ts";
import { json, parseJson } from "../db.ts";
import { allowedScopes, type Workspaces } from "./scopes.ts";
import type { MemoryStore } from "./store.ts";
import type { Confidence, ItemKind, ItemScope, MemoryOp, NewItem, SourceInput } from "./types.ts";

export const MIGRATION_FLAG = "memory_v05_migrated";

/** What moving v0.2's memory over did (docs/memory-design.md §11: 「迁移有核对报告」). */
export interface MigrationReport {
	at: number;
	/** v0.2 memories now items (marked 「迁移，待复核」). */
	items: number;
	/** Older versions brought over as superseded, linked to what replaced them. */
	superseded: number;
	/** Candidates now waiting for the user. */
	pending: number;
	/** Lines of the three always-on blocks, now pinned items. */
	blockLines: number;
	/** Left behind, with why. */
	skipped: { id: string; reason: string }[];
	batchId: string | null;
}

interface OldRow {
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
}

const BLOCK_KINDS: Record<string, { kind: ItemKind; title: string }> = {
	about_me: { kind: "background", title: "关于我" },
	preferences: { kind: "preference", title: "偏好与习惯" },
	agreements: { kind: "agreement", title: "当前约定" },
};

/** The v0.2 tables still hold memory nobody moved yet. */
export function migrationDone(db: Db): MigrationReport | undefined {
	const row = db.get<{ value: string }>("SELECT value FROM app_flags WHERE key = ?", MIGRATION_FLAG);
	return row ? parseJson<MigrationReport>(row.value, undefined as never) : undefined;
}

/**
 * Moves v0.2's memory into the v0.5 store once (§11): active memories become
 * level-2 items to review (never level 3 just for being old), with a session
 * source when v0.2 knew one and nothing made up otherwise; superseded ones
 * keep their link; candidates wait for the user as before; the blocks are
 * split into pinned items (a locked block's lines are locked). Ids are kept,
 * so running it again after a crash skips what is already there. The v0.2
 * tables are left as they are.
 */
export function migrateV02(db: Db, store: MemoryStore, workspaces: Workspaces, butterflyHome: string): MigrationReport | undefined {
	if (migrationDone(db)) return undefined;
	const report: MigrationReport = { at: store.clock(), items: 0, superseded: 0, pending: 0, blockLines: 0, skipped: [], batchId: null };
	const rows = db.all<OldRow>("SELECT * FROM memories ORDER BY created_at, rowid");
	const byId = new Map(rows.map((r) => [r.id, r]));
	const ops: MemoryOp[] = [];
	const linkOps: { from: string; to: string }[] = [];

	const where = (row: OldRow): { scope: ItemScope; workspaceId: string | null } => {
		if (row.scope !== "workspace" || !row.cwd) return { scope: "global", workspaceId: null };
		const set = allowedScopes(workspaces, row.cwd, butterflyHome);
		return set.butterfly ? { scope: "butterfly", workspaceId: null } : { scope: "workspace", workspaceId: set.workspaceId };
	};
	const kindOf = (kind: string): ItemKind => (["preference", "background", "experience"].includes(kind) ? (kind as ItemKind) : "background");
	const sourcesOf = (row: OldRow): SourceInput[] =>
		row.source_session ? [{ kind: "session", ref: row.source_session, excerpt: row.reason }] : [{ kind: "migration", excerpt: "v0.2 记忆（没有记录来源）" }];

	for (const row of rows) {
		if (row.status !== "active" && row.status !== "superseded") continue;
		const confidence: Confidence = row.source === "agent" ? "user_confirmed" : "user_explicit";
		const item: NewItem = {
			id: row.id,
			content: row.content,
			kind: kindOf(row.kind),
			level: 2,
			...where(row),
			confidence,
			status: row.status === "active" ? "review" : "superseded",
			occurredAt: row.created_at,
		};
		ops.push({ kind: "add", item, sources: sourcesOf(row), reason: row.status === "active" ? "迁移，待复核" : "迁移：v0.2 里的旧版本" });
		if (row.status === "active") report.items++;
		else {
			report.superseded++;
			if (row.replaced_by && byId.has(row.replaced_by)) linkOps.push({ from: row.replaced_by, to: row.id });
		}
	}
	// The newer version supersedes the older one (links go on the newer item).
	for (const op of ops) {
		if (op.kind !== "add") continue;
		const links = linkOps.filter((l) => l.from === op.item.id).map((l) => ({ to: l.to, kind: "supersedes" as const }));
		if (links.length) op.links = links;
	}

	const blocks = db.all<{ key: string; content: string; locked: number }>("SELECT key, content, locked FROM memory_blocks");
	for (const block of blocks) {
		const info = BLOCK_KINDS[block.key];
		if (!info || !block.content.trim()) continue;
		splitBlock(block.content).forEach((line, i) => {
			ops.push({
				kind: "add",
				item: { id: `m_blk_${block.key}_${i + 1}`, content: line, kind: info.kind, level: 2, scope: "global", confidence: "user_explicit", pinned: true, retention: block.locked ? "locked" : "normal" },
				sources: [{ kind: "migration", excerpt: `v0.2 常驻记忆「${info.title}」` }],
				reason: `迁移：常驻记忆「${info.title}」`,
			});
			report.blockLines++;
		});
	}

	const result = store.commit({ actor: "migration", ops, reason: "从 v0.2 的记忆迁移", batchKind: "migration" });
	report.batchId = result.batchId;
	for (const rejected of result.rejected) {
		const op = ops[rejected.index]!;
		if (rejected.reason === "这条记忆已经存在") continue; // a run before this one got that far
		report.skipped.push({ id: op.kind === "add" ? (op.item.id ?? "?") : op.id, reason: rejected.reason });
	}

	for (const row of rows) {
		if (row.status === "candidate") {
			const op = candidateOp(row, where(row), store);
			if (typeof op === "string") {
				report.skipped.push({ id: row.id, reason: op });
				continue;
			}
			if (db.get("SELECT 1 FROM memory_pending WHERE json_extract(op, '$.reason') = ? AND actor = 'migration'", `v0.2 候选 #${row.id}`)) continue;
			store.propose(op, { actor: "migration", why: "confirm", reason: row.reason, sessionRef: row.source_session });
			report.pending++;
		} else if (row.status !== "active" && row.status !== "superseded") {
			report.skipped.push({ id: row.id, reason: row.status === "rejected" ? "v0.2 里被拒绝的候选" : row.status === "deleted" ? "v0.2 里已删除" : "v0.2 里已经处理过的修改建议" });
		}
	}

	db.run("INSERT OR REPLACE INTO app_flags(key, value, at) VALUES(?, ?, ?)", MIGRATION_FLAG, json(report), report.at);
	return report;
}

/** v0.2's candidate as a change waiting for the user, or why it cannot be one. */
function candidateOp(row: OldRow, where: { scope: ItemScope; workspaceId: string | null }, store: MemoryStore): MemoryOp | string {
	const reason = `v0.2 候选 #${row.id}`;
	const sources: SourceInput[] = row.source_session ? [{ kind: "session", ref: row.source_session, excerpt: row.reason }] : [];
	const kind: ItemKind = ["preference", "background", "experience"].includes(row.kind) ? (row.kind as ItemKind) : "background";
	if (row.target_id?.startsWith("block:")) {
		const block = BLOCK_KINDS[row.target_id.slice(6)];
		if (!block) return "修改的常驻记忆已不存在";
		return { kind: "add", item: { content: row.content, kind: block.kind, level: 2, scope: "global", confidence: "agent_inferred", pinned: true }, sources, reason };
	}
	if (row.action === "update" || row.action === "delete") {
		const target = row.target_id ? store.get(row.target_id) : undefined;
		if (!target) return "要修改的记忆已不存在";
		return row.action === "update" ? { kind: "edit", id: target.id, patch: { content: row.content }, sources, reason } : { kind: "status", id: target.id, status: "forgotten", reason };
	}
	return { kind: "add", item: { content: row.content, kind, level: 1, ...where, confidence: "agent_inferred" }, sources, reason };
}

/** A block's text as one item per line or bullet (atomic entries, 17.2 item 2). */
export function splitBlock(text: string): string[] {
	return text
		.split(/\r?\n+/)
		.map((line) => line.replace(/^\s*(?:[-*•·]|\d+[.、)])\s*/, "").trim())
		.filter((line) => line.length > 0);
}
