import { randomUUID } from "node:crypto";
import { RpcError } from "../core.ts";
import type { Db } from "../db.ts";
import { json, parseJson } from "../db.ts";
import { defaultValidity, promotionBlock } from "./lifecycle.ts";
import { hazardReason, scanMemoryText, suppressionHash } from "./safety.ts";
import { type ScopeSet, visibleIn, writableIn } from "./scopes.ts";
import { relevance, trigrams } from "./text.ts";
import {
	type Actor,
	CONFIDENCES,
	type CommitResult,
	ITEM_KINDS,
	ITEM_SCOPES,
	ITEM_STATUSES,
	type ItemPatch,
	type ItemScope,
	type ItemStatus,
	type LinkKind,
	LIVE_STATUSES,
	type LogDay,
	type LogEntry,
	type MemoryItem,
	type MemoryOp,
	type MemorySource,
	type NewItem,
	type PendingChange,
	type PendingWhy,
	RETENTIONS,
	type SourceInput,
} from "./types.ts";

export interface CommitInput {
	actor: Actor;
	ops: MemoryOp[];
	/** Why this batch happened (shown on the log's batch). */
	reason?: string | null;
	/** What kind of work made the batch: save, edit, extract, migration, confirm, undo… */
	batchKind?: string;
	/** Scopes the actor may touch; undefined = any (the user, in the memory page). */
	allowed?: ScopeSet;
	/** The main agent acts on the user's explicit request (「记住…」). */
	explicit?: boolean;
	/** The session the change came from. */
	sessionRef?: string | null;
	/** Wait for the user whatever the settings say (an unattended run: nobody asked it to remember anything). */
	confirm?: boolean;
	costUsd?: number;
}

export interface ListFilter {
	statuses?: readonly ItemStatus[];
	/** Only what a session with these scopes may read. */
	set?: ScopeSet;
	scope?: ItemScope;
	workspaceId?: string;
	level?: number;
	pinned?: boolean;
	query?: string;
	limit?: number;
}

interface ItemRow {
	id: string;
	version: number;
	level: number;
	kind: string;
	content: string;
	conditions: string | null;
	scope: string;
	workspace_id: string | null;
	group_id: string | null;
	confidence: string;
	status: string;
	pinned: number;
	retention: string;
	auto_ok: number;
	occurred_at: number | null;
	valid_from: number | null;
	valid_until: number | null;
	last_verified_at: number | null;
	next_review_at: number | null;
	last_used_at: number | null;
	use_count: number;
	created_at: number;
	updated_at: number;
	created_by: string;
}

function toItem(row: ItemRow): MemoryItem {
	return {
		id: row.id,
		version: row.version,
		level: row.level as MemoryItem["level"],
		kind: row.kind as MemoryItem["kind"],
		content: row.content,
		conditions: row.conditions,
		scope: row.scope as ItemScope,
		workspaceId: row.workspace_id,
		groupId: row.group_id,
		confidence: row.confidence as MemoryItem["confidence"],
		status: row.status as ItemStatus,
		pinned: row.pinned === 1,
		retention: row.retention as MemoryItem["retention"],
		autoOk: row.auto_ok === 1,
		occurredAt: row.occurred_at,
		validFrom: row.valid_from,
		validUntil: row.valid_until,
		lastVerifiedAt: row.last_verified_at,
		nextReviewAt: row.next_review_at,
		lastUsedAt: row.last_used_at,
		useCount: row.use_count,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		createdBy: row.created_by as Actor,
	};
}

const COLUMNS =
	"id, version, level, kind, content, conditions, scope, workspace_id, group_id, confidence, status, pinned, retention, auto_ok, occurred_at, valid_from, valid_until, last_verified_at, next_review_at, last_used_at, use_count, created_at, updated_at, created_by";

function values(item: MemoryItem) {
	return [
		item.id,
		item.version,
		item.level,
		item.kind,
		item.content,
		item.conditions,
		item.scope,
		item.workspaceId,
		item.groupId,
		item.confidence,
		item.status,
		item.pinned ? 1 : 0,
		item.retention,
		item.autoOk ? 1 : 0,
		item.occurredAt,
		item.validFrom,
		item.validUntil,
		item.lastVerifiedAt,
		item.nextReviewAt,
		item.lastUsedAt,
		item.useCount,
		item.createdAt,
		item.updatedAt,
		item.createdBy,
	] as const;
}

/** Longest memory text accepted (one fact, §17.2 item 2: atomic entries). */
export const MAX_CONTENT = 2000;

/** Fields whose change is not a change of the memory itself (left out of the log's 「改了什么」). */
const BOOKKEEPING = new Set(["version", "updatedAt", "lastUsedAt", "useCount"]);
/** Fields a restore puts back. */
const RESTORABLE = ["content", "kind", "level", "conditions", "scope", "workspaceId", "groupId", "confidence", "pinned", "retention", "autoOk", "validFrom", "validUntil", "nextReviewAt"] as const;
/** A patch of only these says when the item was looked at, not what it says: allowed on locked items too. */
const REVIEW_ONLY = new Set(["lastVerifiedAt", "nextReviewAt"]);

type Check = { apply: true } | { reject: string } | { pending: PendingWhy; review?: boolean };

/**
 * The memory store and its gate (docs/memory-design.md §4–5, 「程序侧守门」):
 * every change is an op checked for scope, version and the user-only
 * exceptions, applied in one transaction per batch, versioned and logged.
 * Whatever is not allowed to take effect on its own waits in
 * memory_pending for the user.
 */
export class MemoryStore {
	private readonly db: Db;
	readonly clock: () => number;
	private readonly confirmWrites: () => boolean;
	private readonly listeners = new Set<(batchId: string | null) => void>();
	/** Physical disk guard, separate from the user's optional background pause. */
	writeBlocked: () => string | null = () => null;

	constructor(db: Db, options: { clock?: () => number; confirmWrites?: () => boolean } = {}) {
		this.db = db;
		this.clock = options.clock ?? Date.now;
		this.confirmWrites = options.confirmWrites ?? (() => false);
	}

	onChange(listener: (batchId: string | null) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(batchId: string | null): void {
		for (const listener of this.listeners) listener(batchId);
	}

	newId(): string {
		return `m_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
	}

	// ---- reading -----------------------------------------------------------------------

	get(id: string): MemoryItem | undefined {
		const row = this.db.get<ItemRow>(`SELECT ${COLUMNS} FROM memory_items WHERE id = ?`, id);
		return row ? toItem(row) : undefined;
	}

	list(filter: ListFilter = {}): MemoryItem[] {
		const statuses = filter.statuses ?? LIVE_STATUSES;
		const where = [`status IN (${statuses.map(() => "?").join(",")})`];
		const params: (string | number)[] = [...statuses];
		if (filter.scope) {
			where.push("scope = ?");
			params.push(filter.scope);
		}
		if (filter.workspaceId) {
			where.push("workspace_id = ?");
			params.push(filter.workspaceId);
		}
		if (filter.level) {
			where.push("level = ?");
			params.push(filter.level);
		}
		if (filter.pinned !== undefined) {
			where.push("pinned = ?");
			params.push(filter.pinned ? 1 : 0);
		}
		let items = this.db.all<ItemRow>(`SELECT ${COLUMNS} FROM memory_items WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, rowid DESC`, ...params).map(toItem);
		if (filter.set) {
			const set = filter.set;
			items = items.filter((item) => visibleIn(item, set));
		}
		const query = filter.query?.trim().toLowerCase();
		if (query) {
			const grams = trigrams(query);
			items = items
				.map((item) => ({ item, score: item.content.toLowerCase().includes(query) ? 100 : relevance(grams, item.content) }))
				.filter((x) => x.score > 0.3)
				.sort((a, b) => b.score - a.score)
				.map((x) => x.item);
		}
		return items.slice(0, filter.limit ?? 1000);
	}

	/** Every version of an item, newest first. */
	versions(id: string): { version: number; item: MemoryItem; opId: string | null; at: number }[] {
		return this.db
			.all<{ version: number; snapshot: string; op_id: string | null; at: number }>("SELECT * FROM memory_versions WHERE item_id = ? ORDER BY version DESC", id)
			.map((r) => ({ version: r.version, item: parseJson<MemoryItem>(r.snapshot, null as never), opId: r.op_id, at: r.at }));
	}

	version(id: string, version: number): MemoryItem | undefined {
		const row = this.db.get<{ snapshot: string }>("SELECT snapshot FROM memory_versions WHERE item_id = ? AND version = ?", id, version);
		return row ? parseJson<MemoryItem>(row.snapshot, null as never) : undefined;
	}

	sources(id: string): MemorySource[] {
		return this.db
			.all<{ kind: string; ref: string | null; excerpt: string | null; at: number }>("SELECT kind, ref, excerpt, at FROM memory_sources WHERE item_id = ? ORDER BY at, id", id)
			.map((r) => ({ kind: r.kind as MemorySource["kind"], ref: r.ref, excerpt: r.excerpt, at: r.at }));
	}

	links(id: string): { from: string; to: string; kind: LinkKind; at: number }[] {
		return this.db
			.all<{ from_id: string; to_id: string; kind: string; at: number }>("SELECT * FROM memory_links WHERE from_id = ? OR to_id = ? ORDER BY at", id, id)
			.map((r) => ({ from: r.from_id, to: r.to_id, kind: r.kind as LinkKind, at: r.at }));
	}

	// ---- changing ----------------------------------------------------------------------

	/**
	 * Checks and applies [input.ops]. Ops that pass are applied together in one
	 * transaction (one batch); ops that may not take effect on their own wait
	 * for the user; the rest are rejected with a reason. A failure while
	 * writing rolls the whole batch back.
	 */
	commit(input: CommitInput): CommitResult {
		const result: CommitResult = { batchId: null, applied: [], pending: [], rejected: [] };
		const blocked = this.writeBlocked();
		if (blocked) return { ...result, rejected: input.ops.map((_, index) => ({ index, reason: blocked })) };
		const at = this.clock();
		this.db.transaction(() => {
			const batch = () => {
				if (result.batchId) return result.batchId;
				result.batchId = `b_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
				this.db.run(
					"INSERT INTO memory_batches(id, actor, kind, reason, session_ref, cost_usd, at) VALUES(?, ?, ?, ?, ?, ?, ?)",
					result.batchId,
					input.actor,
					input.batchKind ?? "change",
					input.reason ?? null,
					input.sessionRef ?? null,
					input.costUsd ?? 0,
					at,
				);
				return result.batchId;
			};
			input.ops.forEach((op, index) => {
				const current = op.kind === "add" ? undefined : this.get(op.id);
				const check = this.check(op, current, input);
				if ("reject" in check) {
					result.rejected.push({ index, reason: check.reject });
					return;
				}
				if ("pending" in check) {
					result.pending.push({ pendingId: this.addPending(op, current, input, check.pending, at), itemId: current?.id ?? null, why: check.pending, index });
					if (check.review && current && current.status !== "review") {
						const review: MemoryOp = { kind: "status", id: current.id, status: "review", reason: op.reason ?? "有新的修改建议，等用户复核" };
						result.applied.push({ opId: this.apply(review, current, input, batch(), at), itemId: current.id, kind: "status", index });
					}
					return;
				}
				const opId = this.apply(op, current, input, batch(), at);
				result.applied.push({ opId, itemId: op.kind === "add" ? this.db.get<{ item_id: string }>("SELECT item_id FROM memory_ops WHERE id = ?", opId)!.item_id : op.id, kind: op.kind, index });
			});
		});
		if (result.applied.length || result.pending.length) this.changed(result.batchId);
		return result;
	}

	private check(op: MemoryOp, current: MemoryItem | undefined, input: CommitInput): Check {
		const actor = input.actor;
		const byUser = actor === "user";
		if (op.kind === "add") {
			const item = op.item;
			const bad = validateNew(item, actor) ?? this.unsafe(item.content, actor);
			if (bad) return { reject: bad };
			if (item.id && this.get(item.id)) return { reject: "这条记忆已经存在" };
			if (input.allowed && !writableIn(item, input.allowed)) return { reject: "不在这次允许的范围里" };
			// Migration brings over what the user locked in v0.2.
			if (!byUser && actor !== "migration" && item.retention === "locked") return { reject: "只有用户本人能锁定记忆" };
			if (actor === "main_agent" && item.scope === "global") return { pending: "promote_global" };
			if (this.mustConfirm(op, input)) return { pending: "confirm" };
			return { apply: true };
		}
		if (!current) return { reject: "没有这条记忆" };
		if (input.allowed && !inScope(current, input.allowed)) return { reject: "不在这次允许的范围里" };
		if (op.baseVersion !== undefined && op.baseVersion !== current.version) return { reject: `这条记忆已经有更新（现在是第 ${current.version} 版），请按最新内容重新判断` };
		if (actor === "memory_agent" && op.baseVersion === undefined) return { reject: "缺少版本号" };
		if (op.kind === "edit") {
			const bad = validatePatch(op.patch, current) ?? (op.patch.content !== undefined ? this.unsafe(op.patch.content, actor) : undefined);
			if (bad) return { reject: bad };
			const target = { scope: op.patch.scope ?? current.scope, workspaceId: op.patch.workspaceId !== undefined ? op.patch.workspaceId : current.workspaceId, groupId: op.patch.groupId !== undefined ? op.patch.groupId : current.groupId };
			if (target.scope === "workspace" && !target.workspaceId) return { reject: "工作区记忆要指明工作区" };
			if (target.scope === "group" && !target.groupId) return { reject: "共享组记忆要指明共享组" };
			if (actor === "main_agent" && target.scope === "global") return { pending: "promote_global" };
			const touched = Object.entries(op.patch).filter(([, v]) => v !== undefined).map(([k]) => k);
			if (!byUser && touched.length && touched.every((k) => REVIEW_ONLY.has(k))) return { apply: true };
			if (!byUser) {
				// Raising a level rests on evidence the program checks (§3, §12 item 3); lowering is recorded like any change.
				if (op.patch.level !== undefined && op.patch.level > current.level) {
					// Judged on the item as the patch leaves it (new conditions count), from the level it has now.
					const block = promotionBlock({ ...current, ...definedOnly(op.patch), level: current.level } as MemoryItem, op.patch.level, this.sources(current.id), this.clock());
					if (block) return { reject: block };
				}
				if (op.patch.retention === "locked") return { reject: "只有用户本人能锁定记忆" };
				if (current.retention === "locked") return { pending: "locked", review: true };
				if (target.scope === "global" && current.scope !== "global") return { pending: "promote_global" };
				if (input.allowed && op.patch.scope !== undefined && !writableIn(target, input.allowed)) return { reject: "不在这次允许的范围里" };
				if (!current.autoOk && actor !== "main_agent") return { pending: "confirm" };
			}
		} else {
			if (!ITEM_STATUSES.includes(op.status)) return { reject: `未知的状态：${op.status}` };
			if (op.status === current.status) return { reject: "状态没有变化" };
			if (op.status === "withdrawn") return { reject: "撤回只能通过记忆日志的「撤销」" };
			if (actor === "main_agent" && current.scope === "global") return { pending: "promote_global" };
			if (!byUser) {
				if (current.retention === "locked" && op.status !== "review") return { pending: "locked", review: true };
				if (!current.autoOk && actor !== "main_agent" && op.status !== "review") return { pending: "confirm" };
			}
		}
		if (this.mustConfirm(op, input)) return { pending: "confirm" };
		return { apply: true };
	}

	/**
	 * Text memory may not hold (17.2 item 3, §10): secrets, instructions to the
	 * model, invisible characters — from anyone. And what the user had deleted
	 * for good does not come back through the background (§12 item 8); the
	 * user may write it again themselves.
	 */
	private unsafe(content: string, actor: Actor): string | undefined {
		const hazard = scanMemoryText(content);
		if (hazard) return hazardReason(hazard);
		if (actor !== "user" && this.db.get("SELECT 1 FROM memory_suppressions WHERE pattern_hash = ? LIMIT 1", suppressionHash(content))) return "用户要求彻底删除过这条内容，不再记";
		return undefined;
	}

	/** 「写入前要我确认」 is on: back to §4's table of what may take effect without the user. */
	private mustConfirm(op: MemoryOp, input: CommitInput): boolean {
		if (input.confirm && input.actor !== "user") return true;
		if (!this.confirmWrites()) return false;
		switch (input.actor) {
			case "user":
			case "system":
			case "migration":
				return false;
			case "main_agent":
				return !input.explicit;
			case "memory_agent":
				if (op.kind === "add") return !(op.item.level === 1 && op.item.kind === "progress");
				if (op.kind === "status") return op.status !== "review";
				return true;
		}
	}

	private apply(op: MemoryOp, current: MemoryItem | undefined, input: CommitInput, batchId: string, at: number): string {
		const opId = `o_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
		let next: MemoryItem;
		if (op.kind === "add") {
			const item = op.item;
			const scope = normalizeScope(item.scope, item.workspaceId ?? null, item.groupId ?? null);
			next = {
				id: item.id ?? this.newId(),
				version: 1,
				level: item.level,
				kind: item.kind,
				content: item.content.trim(),
				conditions: item.conditions?.trim() || null,
				...scope,
				confidence: item.confidence,
				status: item.status ?? "active",
				pinned: item.pinned ?? false,
				retention: item.retention ?? (item.level === 3 ? "long" : "normal"),
				autoOk: true,
				occurredAt: item.occurredAt ?? null,
				validFrom: item.validFrom ?? null,
				// 17.3: a judgment about tools or the environment the background wrote gets 30 days when it gave none.
				validUntil: item.validUntil ?? (input.actor === "user" || input.actor === "migration" ? null : defaultValidity(item.kind, at)),
				lastVerifiedAt: null,
				nextReviewAt: item.nextReviewAt ?? null,
				lastUsedAt: null,
				useCount: 0,
				createdAt: at,
				updatedAt: at,
				createdBy: input.actor,
			};
			this.db.run(`INSERT INTO memory_items(${COLUMNS}) VALUES(${COLUMNS.split(",").map(() => "?").join(",")})`, ...values(next));
		} else {
			const base = current!;
			if (op.kind === "edit") {
				const patch = op.patch;
				const merged = { ...base, ...definedOnly(patch) } as MemoryItem;
				if (patch.content !== undefined) merged.content = patch.content.trim();
				if (patch.conditions !== undefined) merged.conditions = patch.conditions?.trim() || null;
				Object.assign(merged, normalizeScope(merged.scope, merged.workspaceId, merged.groupId));
				// Raised to level 3 keeps it long unless the user chose otherwise; dropped from 3 goes back to normal.
				if (patch.level === 3 && patch.retention === undefined && merged.retention === "normal") merged.retention = "long";
				if (patch.level !== undefined && patch.level < 3 && patch.retention === undefined && merged.retention === "long") merged.retention = "normal";
				next = merged;
			} else {
				next = { ...base, status: op.status };
			}
			next.version = base.version + 1;
			next.updatedAt = at;
			this.write(next);
		}
		this.db.run("INSERT INTO memory_versions(item_id, version, snapshot, op_id, at) VALUES(?, ?, ?, ?, ?)", next.id, next.version, json(next), opId, at);
		for (const source of op.sources ?? []) this.addSource(next.id, source, at);
		if (op.kind !== "edit") for (const link of op.links ?? []) this.db.run("INSERT OR IGNORE INTO memory_links(from_id, to_id, kind, at) VALUES(?, ?, ?, ?)", next.id, link.to, link.kind, at);
		const inferred = next.confidence === "agent_inferred";
		this.db.run(
			"INSERT INTO memory_ops(id, batch_id, actor, kind, item_id, before_version, after_version, reason, inferred, explicit_requested, at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			opId,
			batchId,
			input.actor,
			op.kind,
			next.id,
			current?.version ?? null,
			next.version,
			op.reason ?? input.reason ?? null,
			inferred ? 1 : 0,
			input.actor === "main_agent" && input.explicit === true ? 1 : 0,
			at,
		);
		return opId;
	}

	private write(item: MemoryItem): void {
		const cols = COLUMNS.split(",").map((c) => c.trim()).slice(1);
		const v = values(item);
		this.db.run(`UPDATE memory_items SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, ...v.slice(1), item.id);
	}

	private addSource(itemId: string, source: SourceInput, at: number): void {
		this.db.run("INSERT INTO memory_sources(item_id, kind, ref, excerpt, at) VALUES(?, ?, ?, ?, ?)", itemId, source.kind, source.ref ?? null, source.excerpt?.slice(0, 300) ?? null, at);
	}

	/** Marks the sources of a deleted session (17.10 item 5: the memories stay, the source says so). */
	markSessionDeleted(sessionRef: string): number {
		return this.db.run("UPDATE memory_sources SET excerpt = COALESCE(excerpt, '') || '（会话已删除）', kind = 'session' WHERE ref = ? AND kind = 'session' AND (excerpt IS NULL OR excerpt NOT LIKE '%（会话已删除）')", sessionRef).changes;
	}

	/**
	 * Records that [from] and [to] contradict each other (memory_links
	 * `conflicts`), when the memory agent found it and the item already waits
	 * for review (no new version: the relation is not a change of the text).
	 */
	link(from: string, to: string, kind: LinkKind): void {
		this.db.run("INSERT OR IGNORE INTO memory_links(from_id, to_id, kind, at) VALUES(?, ?, ?, ?)", from, to, kind, this.clock());
	}

	/** Conflict relations made since [since] (a reason for the next review). */
	conflictsSince(since: number): { from: string; to: string; at: number }[] {
		return this.db.all<{ from_id: string; to_id: string; at: number }>("SELECT from_id, to_id, at FROM memory_links WHERE kind = 'conflicts' AND at > ?", since).map((r) => ({ from: r.from_id, to: r.to_id, at: r.at }));
	}

	/**
	 * Items changed after [since] by anything but the batch kinds in [except]
	 * (a review's own changes are not a reason for the next review: §12 item 1
	 * 「没有变化不调模型」).
	 */
	changedSince(since: number, except: readonly string[] = []): Set<string> {
		const rows = this.db.all<{ item_id: string }>(
			`SELECT DISTINCT o.item_id FROM memory_ops o JOIN memory_batches b ON b.id = o.batch_id WHERE o.at > ? ${except.length ? `AND b.kind NOT IN (${except.map(() => "?").join(",")})` : ""}`,
			since,
			...except,
		);
		return new Set(rows.map((r) => r.item_id));
	}

	/** Whether [id]'s running out was already handled after [since] (marked for review once, not every sweep). */
	expiredBefore(id: string, since: number): boolean {
		return !!this.db.get("SELECT 1 FROM memory_ops o JOIN memory_batches b ON b.id = o.batch_id WHERE o.item_id = ? AND b.kind = 'expire' AND o.at >= ? LIMIT 1", id, since);
	}

	/** What a batch changed: item ids and whether their text is new (added, or edited text). */
	batchChanges(batchId: string): { itemId: string; kind: string; newText: boolean; actor: Actor; batchKind: string }[] {
		const rows = this.db.all<{ item_id: string; kind: string; before_version: number | null; after_version: number; actor: string; batch_kind: string }>(
			"SELECT o.item_id, o.kind, o.before_version, o.after_version, o.actor, b.kind AS batch_kind FROM memory_ops o JOIN memory_batches b ON b.id = o.batch_id WHERE o.batch_id = ? ORDER BY o.rowid",
			batchId,
		);
		return rows.map((r) => {
			let newText = r.kind === "add";
			if (r.kind === "edit" && r.before_version !== null) newText = this.version(r.item_id, r.before_version)?.content !== this.version(r.item_id, r.after_version)?.content;
			return { itemId: r.item_id, kind: r.kind, newText, actor: r.actor as Actor, batchKind: r.batch_kind };
		});
	}

	/** Bookkeeping only (§2.1: hints for reviews, never evidence); no version, no log line. */
	markUsed(ids: string[]): void {
		if (this.writeBlocked()) return;
		const at = this.clock();
		for (const id of ids) this.db.run("UPDATE memory_items SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?", at, id);
	}

	// ---- restoring and deleting for good (§9, §12 item 8) ------------------------------

	/**
	 * Puts [id] back as it was at [version] (§9 「单条恢复」): one change of its
	 * own by the user, in the log like any other, so it can be undone too.
	 */
	restore(id: string, version: number): CommitResult {
		const current = this.get(id);
		if (!current) throw new RpcError("not_found", "没有这条记忆");
		const old = this.version(id, version);
		if (!old) throw new RpcError("not_found", `没有第 ${version} 版`);
		const patch: ItemPatch = {};
		for (const key of RESTORABLE) if (JSON.stringify(old[key]) !== JSON.stringify(current[key])) (patch as Record<string, unknown>)[key] = old[key];
		const ops: MemoryOp[] = [];
		if (Object.keys(patch).length) ops.push({ kind: "edit", id, patch, reason: `恢复到第 ${version} 版` });
		// A withdrawn add comes back as active: 「withdrawn」 is only for the log's undo.
		const status = old.status === "withdrawn" ? "active" : old.status;
		if (status !== current.status) ops.push({ kind: "status", id, status, reason: `恢复到第 ${version} 版` });
		if (!ops.length) throw new RpcError("bad_request", "和那一版一样，不用恢复");
		const result = this.commit({ actor: "user", ops, batchKind: "restore", reason: `恢复到第 ${version} 版` });
		if (!result.applied.length && result.rejected.length) throw new RpcError("bad_request", result.rejected[0]!.reason);
		return result;
	}

	/**
	 * Deletes [id] for good, only for the user (§12 item 8): the item, every
	 * version, its sources, relations, materials, waiting changes and log
	 * lines go; its text is taken out of recorded snapshots; what is kept is a
	 * fingerprint without the text, so the background never extracts it again
	 * from the same conversation. Cannot be undone. Returns the conversations
	 * it came from (the window offers to delete that part too).
	 */
	purge(id: string): { sessions: string[] } {
		const current = this.get(id);
		if (!current) throw new RpcError("not_found", "没有这条记忆");
		const texts = new Set([current.content, ...this.versions(id).map((v) => v.item.content)]);
		const sessions = [...new Set(this.sources(id).filter((s) => s.kind === "session" && s.ref).map((s) => s.ref!))];
		const at = this.clock();
		this.db.transaction(() => {
			for (const text of texts) {
				const hash = suppressionHash(text);
				if (sessions.length) for (const ref of sessions) this.db.run("INSERT INTO memory_suppressions(pattern_hash, source_ref, at) VALUES(?, ?, ?)", hash, ref, at);
				else this.db.run("INSERT INTO memory_suppressions(pattern_hash, source_ref, at) VALUES(?, NULL, ?)", hash, at);
				if (text.length >= 4) this.db.run("UPDATE memory_snapshots SET content = replace(content, ?, '（已彻底删除的记忆）') WHERE instr(content, ?) > 0", text, text);
				// v0.2's tables, kept read-only after the migration, still hold it.
				if (text.length >= 4) this.db.run("UPDATE memory_blocks SET content = replace(content, ?, '') WHERE instr(content, ?) > 0", text, text);
				this.db.run("DELETE FROM memories WHERE content = ?", text);
			}
			this.db.run("DELETE FROM memories WHERE id = ?", id);
			this.db.run("DELETE FROM memory_items WHERE id = ?", id);
			this.db.run("DELETE FROM memory_versions WHERE item_id = ?", id);
			this.db.run("DELETE FROM memory_sources WHERE item_id = ?", id);
			this.db.run("DELETE FROM memory_links WHERE from_id = ? OR to_id = ?", id, id);
			this.db.run("DELETE FROM memory_ops WHERE item_id = ?", id);
			this.db.run("DELETE FROM memory_pending WHERE item_id = ? OR instr(op, ?) > 0", id, id);
			this.db.run("DELETE FROM memory_materials WHERE instr(item_ids, ?) > 0", id);
			// The log keeps that something was deleted for good, never what.
			const batchId = "b_" + randomUUID();
			this.db.run("INSERT INTO memory_batches(id, actor, kind, reason, at) VALUES(?, 'user', 'purge', '彻底删除了一条记忆', ?)", batchId, at);
			this.db.run("INSERT INTO memory_purge_log VALUES(?,?,?,?,?,?,?)", "purge_"+randomUUID(), batchId, id, at, current.scope, current.workspaceId, current.level);
		});
		this.changed(null);
		return { sessions };
	}

	// ---- waiting for the user ----------------------------------------------------------

	private addPending(op: MemoryOp, current: MemoryItem | undefined, input: CommitInput, why: PendingWhy, at: number): string {
		const id = `p_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
		const scope = op.kind === "add" ? normalizeScope(op.item.scope, op.item.workspaceId ?? null, op.item.groupId ?? null) : { scope: current!.scope, workspaceId: current!.workspaceId };
		this.db.run(
			"INSERT INTO memory_pending(id, kind, item_id, base_version, op, actor, reason, why, scope, workspace_id, session_ref, status, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
			id,
			op.kind,
			current?.id ?? null,
			current?.version ?? null,
			json(op),
			input.actor,
			op.reason ?? input.reason ?? null,
			why,
			scope.scope,
			scope.workspaceId,
			input.sessionRef ?? null,
			at,
		);
		return id;
	}

	/** Puts [op] straight into the waiting list (v0.2's candidates, brought over as they were). */
	propose(op: MemoryOp, input: { actor: Actor; why: PendingWhy; reason?: string | null; sessionRef?: string | null }): string {
		const blocked = this.writeBlocked();
		if (blocked) throw new RpcError("storage_paused", blocked);
		const current = op.kind === "add" ? undefined : this.get(op.id);
		if (op.kind !== "add" && !current) throw new RpcError("not_found", "没有这条记忆");
		const id = this.addPending(op, current, { actor: input.actor, ops: [], reason: input.reason, sessionRef: input.sessionRef }, input.why, this.clock());
		this.changed(null);
		return id;
	}

	pending(filter: { status?: PendingChange["status"]; set?: ScopeSet } = {}): PendingChange[] {
		const rows = this.db.all<PendingRow>("SELECT * FROM memory_pending WHERE status = ? ORDER BY created_at DESC, rowid DESC", filter.status ?? "pending");
		return rows.map((r) => this.toPending(r)).filter((p) => !filter.set || writableIn(p, filter.set));
	}

	getPending(id: string): PendingChange | undefined {
		const row = this.db.get<PendingRow>("SELECT * FROM memory_pending WHERE id = ?", id);
		return row ? this.toPending(row) : undefined;
	}

	private toPending(r: PendingRow): PendingChange {
		return {
			id: r.id,
			op: parseJson<MemoryOp>(r.op, null as never),
			itemId: r.item_id,
			baseVersion: r.base_version,
			actor: r.actor as Actor,
			reason: r.reason,
			why: r.why as PendingWhy,
			scope: r.scope as ItemScope,
			workspaceId: r.workspace_id,
			sessionRef: r.session_ref,
			status: r.status as PendingChange["status"],
			createdAt: r.created_at,
			resolvedAt: r.resolved_at,
			current: r.item_id ? (this.get(r.item_id) ?? null) : null,
		};
	}

	/**
	 * The user accepts a waiting change, optionally with other text. The item
	 * changed since it was proposed: refused (§5 「确认时重查版本」), the user
	 * looks again.
	 */
	acceptPending(id: string, override: { content?: string } = {}): CommitResult {
		const pending = this.getPending(id);
		if (!pending || pending.status !== "pending") throw new RpcError("not_found", "这条待确认的改动已经处理过了");
		if (pending.itemId) {
			const current = this.get(pending.itemId);
			// The review mark set when it was proposed does not count as a change.
			const markedForReview = current && current.version === (pending.baseVersion ?? 0) + 1 && this.version(current.id, current.version)?.status === "review" && current.status === "review";
			if (!current || (current.version !== pending.baseVersion && !markedForReview)) {
				this.resolvePending(id, "stale");
				throw new RpcError("conflict", "这条记忆在提议之后已经有更新，请按最新内容重新看");
			}
		}
		let op = pending.op;
		if (override.content !== undefined) {
			if (op.kind === "add") op = { ...op, item: { ...op.item, content: override.content } };
			else if (op.kind === "edit") op = { ...op, patch: { ...op.patch, content: override.content } };
		}
		if (op.kind !== "add") op = { ...op, baseVersion: undefined };
		// A change proposed for a locked item puts it back to active once the user agrees.
		const ops: MemoryOp[] = [op];
		const current = pending.itemId ? this.get(pending.itemId) : undefined;
		if (current?.status === "review" && pending.why === "locked" && op.kind === "edit") ops.push({ kind: "status", id: current.id, status: "active" });
		const result = this.commit({ actor: "user", ops, reason: pending.reason ? `确认：${pending.reason}` : "确认", batchKind: "confirm", sessionRef: pending.sessionRef });
		if (result.rejected.length && !result.applied.length) throw new RpcError("bad_request", result.rejected[0]!.reason);
		this.resolvePending(id, "accepted");
		return result;
	}

	rejectPending(id: string): void {
		const pending = this.getPending(id);
		if (!pending || pending.status !== "pending") return;
		this.resolvePending(id, "rejected");
		this.changed(null);
	}

	private resolvePending(id: string, status: PendingChange["status"]): void {
		this.db.run("UPDATE memory_pending SET status = ?, resolved_at = ? WHERE id = ?", status, this.clock(), id);
	}

	// ---- the memory log and undo ---------------------------------------------------------

	/** Changes from [since] to [until], newest first, grouped by local day. */
	log(filter: { since?: number; until?: number; itemId?: string; limit?: number; opIds?: string[] } = {}): LogDay[] {
		const where = ["o.at >= ?", "o.at < ?"];
		const params: (string | number)[] = [filter.since ?? 0, filter.until ?? Number.MAX_SAFE_INTEGER];
		if (filter.itemId) {
			where.push("o.item_id = ?");
			params.push(filter.itemId);
		}
		if (filter.opIds) {
			if (!filter.opIds.length) return [];
			where.push("o.id IN ("+filter.opIds.map(() => "?").join(",")+")");
			params.push(...filter.opIds);
		}
		const rows = this.db.all<OpRow & { batch_kind: string; session_ref: string | null }>(
			`SELECT o.*, b.kind AS batch_kind, b.session_ref FROM memory_ops o JOIN memory_batches b ON b.id = o.batch_id WHERE ${where.join(" AND ")} ORDER BY o.at DESC, o.rowid DESC LIMIT ?`,
			...params,
			filter.limit ?? 500,
		);
		const days: LogDay[] = [];
		for (const row of rows) {
			const after = this.version(row.item_id, row.after_version);
			if (!after) continue;
			const before = row.before_version !== null ? (this.version(row.item_id, row.before_version) ?? null) : null;
			const current = this.get(row.item_id);
			const entry: LogEntry = {
				opId: row.id,
				batchId: row.batch_id,
				batchKind: row.batch_kind,
				at: row.at,
				actor: row.actor as Actor,
				kind: row.kind as LogEntry["kind"],
				itemId: row.item_id,
				before,
				after,
				changed: before ? diff(before, after) : [],
				reason: row.reason,
				inferred: row.inferred === 1,
				sessionRef: row.session_ref,
				undoOf: row.undo_of,
				undone: row.undone_at !== null,
				undoable: row.undone_at === null && row.kind !== "undo" && current?.version === row.after_version,
			};
			const day = localDay(row.at);
			const last = days[days.length - 1];
			if (last?.day === day) last.entries.push(entry);
			else days.push({ day, entries: [entry] });
		}
		return days;
	}

	/** Stable keyset pagination, including body-free purge receipts. */
	logPage(filter: {since?:number;until?:number;itemId?:string;limit?:number;cursor?:string;scope?:string;workspaceId?:string} = {}) {
		let cursor: {at:number;id:string} | undefined;
		if (filter.cursor) {
			try {cursor=JSON.parse(Buffer.from(filter.cursor,"base64url").toString());} catch {throw new RpcError("bad_request","无效的日志游标");}
			if (!cursor || !Number.isFinite(cursor.at) || typeof cursor.id !== "string") throw new RpcError("bad_request","无效的日志游标");
		}
		const limit = Math.max(1,Math.min(500,Math.floor(filter.limit ?? 100)));
		const rows = this.db.all<{id:string;at:number;batch_id:string;item_id:string;scope:ItemScope;workspace_id:string|null;level:number;purged:number}>(
			"SELECT * FROM (SELECT o.id,o.at,o.batch_id,o.item_id,json_extract(v.snapshot,'$.scope') AS scope,json_extract(v.snapshot,'$.workspaceId') AS workspace_id,json_extract(v.snapshot,'$.level') AS level,0 AS purged FROM memory_ops o JOIN memory_versions v ON v.item_id=o.item_id AND v.version=o.after_version UNION ALL SELECT id,at,batch_id,item_id,scope,workspace_id,level,1 AS purged FROM memory_purge_log) WHERE at>=? AND at<? AND (? IS NULL OR item_id=?) AND (? IS NULL OR scope=?) AND (? IS NULL OR workspace_id=?) AND (at<? OR (at=? AND id<?)) ORDER BY at DESC,id DESC LIMIT ?",
			filter.since ?? 0,filter.until ?? Number.MAX_SAFE_INTEGER,filter.itemId ?? null,filter.itemId ?? null,filter.scope ?? null,filter.scope ?? null,filter.workspaceId ?? null,filter.workspaceId ?? null,cursor?.at ?? Number.MAX_SAFE_INTEGER,cursor?.at ?? Number.MAX_SAFE_INTEGER,cursor?.id ?? "",limit+1);
		const picked=rows.slice(0,limit);
		const entries=new Map(this.log({opIds:picked.filter(r=>!r.purged).map(r=>r.id),limit}).flatMap(d=>d.entries).map(e=>[e.opId,e]));
		type PurgeEntry = Omit<LogEntry,"after"|"kind"> & {after:null;kind:"purge";scope:ItemScope;level:number;workspaceId:string|null};
		const days:{day:string;entries:(LogEntry|PurgeEntry)[]}[]=[];
		for (const row of picked) {
			const e:LogEntry|PurgeEntry|undefined = row.purged ? {opId:row.id,batchId:row.batch_id,batchKind:"purge",at:row.at,actor:"user",kind:"purge",itemId:row.item_id,before:null,after:null,changed:[],reason:"彻底删除了一条"+row.scope+"/"+row.level+"级记忆",inferred:false,sessionRef:null,undoOf:null,undone:false,undoable:false,scope:row.scope,level:row.level,workspaceId:row.workspace_id} : entries.get(row.id);
			if (!e) continue;
			const day=localDay(row.at);const last=days.at(-1);
			if (last?.day===day) last.entries.push(e); else days.push({day,entries:[e]});
		}
		const last=picked.at(-1); const hasMore=rows.length>limit;
		return {days,hasMore,cursor:hasMore && last ? Buffer.from(JSON.stringify({at:last.at,id:last.id})).toString("base64url") : null};
	}

	/** Undoes one change, if nothing changed the item since; recorded as a change of its own. */
	undo(opId: string): { batchId: string | null; undone: string[]; conflicts: { opId: string; itemId: string; reason: string }[] } {
		const blocked = this.writeBlocked();
		if (blocked) throw new RpcError("storage_paused", blocked);
		const out = { batchId: null as string | null, undone: [] as string[], conflicts: [] as { opId: string; itemId: string; reason: string }[] };
		this.db.transaction(() => this.undoOne(opId, out));
		if (out.undone.length) this.changed(out.batchId);
		return out;
	}

	/**
	 * Undoes a whole batch (a tidy-up, a soft forget, a migration), newest
	 * change first. Items the user changed since are left alone and listed as
	 * conflicts (§9: 「之后被用户改过的条目不覆盖」).
	 */
	undoBatch(batchId: string): { batchId: string | null; undone: string[]; conflicts: { opId: string; itemId: string; reason: string }[] } {
		const blocked = this.writeBlocked();
		if (blocked) throw new RpcError("storage_paused", blocked);
		const out = { batchId: null as string | null, undone: [] as string[], conflicts: [] as { opId: string; itemId: string; reason: string }[] };
		const ops = this.db.all<OpRow>("SELECT * FROM memory_ops WHERE batch_id = ? AND undone_at IS NULL AND kind <> 'undo' ORDER BY at DESC, rowid DESC", batchId);
		// Several changes of one item in the batch (a restore sets text and status) go back together, to before the first.
		const byItem = new Map<string, OpRow[]>();
		for (const op of ops) byItem.set(op.item_id, [...(byItem.get(op.item_id) ?? []), op]);
		this.db.transaction(() => {
			for (const [, group] of byItem) this.undoOne(group[0]!.id, out, group.slice(1));
			if (!out.conflicts.length && out.undone.length) this.db.run("UPDATE memory_batches SET undone_at = ? WHERE id = ?", this.clock(), batchId);
		});
		if (out.undone.length) this.changed(out.batchId);
		return out;
	}

	/** Undoes [opId] and, with it, [earlier] changes of the same item (newest first): back to before the oldest of them. */
	private undoOne(opId: string, out: { batchId: string | null; undone: string[]; conflicts: { opId: string; itemId: string; reason: string }[] }, earlier: OpRow[] = []): void {
		const op = this.db.get<OpRow>("SELECT * FROM memory_ops WHERE id = ?", opId);
		if (!op) throw new RpcError("not_found", "没有这条记录");
		const conflict = (reason: string) => out.conflicts.push({ opId, itemId: op.item_id, reason });
		if (op.undone_at !== null) return void conflict("已经撤销过了");
		if (op.kind === "undo") return void conflict("撤销本身不能再撤销，可以从历史版本恢复");
		const current = this.get(op.item_id);
		if (!current) return void conflict("这条记忆已经不存在");
		if (current.version !== op.after_version) return void conflict("这条记忆之后又改过，没有覆盖");
		const at = this.clock();
		const back = earlier.length ? earlier[earlier.length - 1]!.before_version : op.before_version;
		let next: MemoryItem;
		if (back === null) {
			next = { ...current, status: "withdrawn" };
		} else {
			const previous = this.version(op.item_id, back);
			if (!previous) return void conflict("找不到改动前的版本");
			next = { ...previous, useCount: current.useCount, lastUsedAt: current.lastUsedAt, createdAt: current.createdAt };
		}
		next.version = current.version + 1;
		next.updatedAt = at;
		if (!out.batchId) {
			out.batchId = `b_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
			this.db.run("INSERT INTO memory_batches(id, actor, kind, reason, at) VALUES(?, 'user', 'undo', NULL, ?)", out.batchId, at);
		}
		const undoId = `o_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
		this.write(next);
		this.db.run("INSERT INTO memory_versions(item_id, version, snapshot, op_id, at) VALUES(?, ?, ?, ?, ?)", next.id, next.version, json(next), undoId, at);
		this.db.run(
			"INSERT INTO memory_ops(id, batch_id, actor, kind, item_id, before_version, after_version, reason, inferred, undo_of, at) VALUES(?, ?, 'user', 'undo', ?, ?, ?, ?, 0, ?, ?)",
			undoId,
			out.batchId,
			next.id,
			current.version,
			next.version,
			"撤销",
			opId,
			at,
		);
		for (const id of [opId, ...earlier.map((e) => e.id)]) {
			this.db.run("UPDATE memory_ops SET undone_at = ? WHERE id = ?", at, id);
			out.undone.push(id);
		}
	}
}

interface OpRow {
	id: string;
	batch_id: string;
	actor: string;
	kind: string;
	item_id: string;
	before_version: number | null;
	after_version: number;
	reason: string | null;
	inferred: number;
	undo_of: string | null;
	at: number;
	undone_at: number | null;
}

interface PendingRow {
	id: string;
	kind: string;
	item_id: string | null;
	base_version: number | null;
	op: string;
	actor: string;
	reason: string | null;
	why: string;
	scope: string;
	workspace_id: string | null;
	session_ref: string | null;
	status: string;
	created_at: number;
	resolved_at: number | null;
}

function validateNew(item: NewItem, actor: Actor): string | undefined {
	if (!item.content?.trim()) return "记忆内容不能为空";
	if (item.content.trim().length > MAX_CONTENT) return `一条记忆最多 ${MAX_CONTENT} 个字，请拆成几条`;
	if (!ITEM_KINDS.includes(item.kind)) return `未知的类别：${item.kind}`;
	if (![1, 2, 3].includes(item.level)) return `未知的层级：${item.level}`;
	if (!ITEM_SCOPES.includes(item.scope)) return `未知的范围：${item.scope}`;
	if (!CONFIDENCES.includes(item.confidence)) return `未知的确认情况：${item.confidence}`;
	if (item.retention && !RETENTIONS.includes(item.retention)) return `未知的保留方式：${item.retention}`;
	if (item.status && !ITEM_STATUSES.includes(item.status)) return `未知的状态：${item.status}`;
	if (item.status && item.status !== "active" && item.status !== "review" && actor !== "migration") return "新记忆只能是生效或待复核";
	if (item.scope === "workspace" && !item.workspaceId) return "工作区记忆要指明工作区";
	if (item.scope === "group" && !item.groupId) return "共享组记忆要指明共享组";
	return undefined;
}

function validatePatch(patch: ItemPatch, current: MemoryItem): string | undefined {
	if (patch.content !== undefined && !patch.content.trim()) return "记忆内容不能为空";
	if (patch.content !== undefined && patch.content.trim().length > MAX_CONTENT) return `一条记忆最多 ${MAX_CONTENT} 个字，请拆成几条`;
	if (patch.kind !== undefined && !ITEM_KINDS.includes(patch.kind)) return `未知的类别：${patch.kind}`;
	if (patch.level !== undefined && ![1, 2, 3].includes(patch.level)) return `未知的层级：${patch.level}`;
	if (patch.scope !== undefined && !ITEM_SCOPES.includes(patch.scope)) return `未知的范围：${patch.scope}`;
	if (patch.confidence !== undefined && !CONFIDENCES.includes(patch.confidence)) return `未知的确认情况：${patch.confidence}`;
	if (patch.retention !== undefined && !RETENTIONS.includes(patch.retention)) return `未知的保留方式：${patch.retention}`;
	const merged = { ...current, ...definedOnly(patch) } as MemoryItem;
	if (patch.content !== undefined) merged.content = patch.content.trim();
	if (patch.conditions !== undefined) merged.conditions = patch.conditions?.trim() || null;
	Object.assign(merged, normalizeScope(merged.scope, merged.workspaceId, merged.groupId));
	if (diff(current, merged).length === 0) return "没有改动";
	return undefined;
}

function normalizeScope(scope: ItemScope, workspaceId: string | null, groupId: string | null): { scope: ItemScope; workspaceId: string | null; groupId: string | null } {
	switch (scope) {
		case "global":
		case "butterfly":
			return { scope, workspaceId: null, groupId: null };
		case "workspace":
			return { scope, workspaceId, groupId: null };
		case "group":
			return { scope, workspaceId: null, groupId };
	}
}

function definedOnly<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Whether [item]'s scope is one [set] covers (regardless of the global background switch). */
function inScope(item: Pick<MemoryItem, "scope" | "workspaceId" | "groupId">, set: ScopeSet): boolean {
	return writableIn(item, set);
}

function diff(a: MemoryItem, b: MemoryItem): string[] {
	const out: string[] = [];
	for (const key of Object.keys(b) as (keyof MemoryItem)[]) {
		if (BOOKKEEPING.has(key)) continue;
		if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out.push(key);
	}
	return out;
}

export function localDay(at: number): string {
	const d = new Date(at);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
