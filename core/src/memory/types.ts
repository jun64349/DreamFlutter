/**
 * v0.5 memory model (docs/memory-design.md §2–4). One row per memory item,
 * every version kept; changes go through MemoryStore.commit, which checks
 * them (scope, version, the user-only exceptions) and logs them in batches.
 */

/** customType of the snapshot message in a session (written by memory, left out of compaction by the harness). */
export const MEMORY_MESSAGE_TYPE = "df-memory";

/** 1 近期 / 2 阶段 / 3 长期 (§3). */
export type Level = 1 | 2 | 3;

/**
 * What the memory is about. `persona` holds what the user set about the
 * agent (its name, role, how it addresses the user): never mixed with facts
 * about the user (§15 item 2, 17.7 item 4).
 */
export type ItemKind = "preference" | "background" | "experience" | "decision" | "progress" | "agreement" | "observation" | "persona";
export const ITEM_KINDS: readonly ItemKind[] = ["preference", "background", "experience", "decision", "progress", "agreement", "observation", "persona"];

export type ItemScope = "global" | "workspace" | "group" | "butterfly";
export const ITEM_SCOPES: readonly ItemScope[] = ["global", "workspace", "group", "butterfly"];

export type Confidence = "user_explicit" | "user_confirmed" | "user_reported" | "agent_inferred" | "verified";
export const CONFIDENCES: readonly Confidence[] = ["user_explicit", "user_confirmed", "user_reported", "agent_inferred", "verified"];

/**
 * active / review 待复核 take part in snapshots; the rest are kept but left
 * out. `ended` = its validity ran out (17.3); `withdrawn` = its adding was
 * undone from the memory log.
 */
export type ItemStatus = "active" | "review" | "outdated" | "superseded" | "refuted" | "archived" | "ended" | "forgotten" | "withdrawn";
export const ITEM_STATUSES: readonly ItemStatus[] = ["active", "review", "outdated", "superseded", "refuted", "archived", "ended", "forgotten", "withdrawn"];
export const LIVE_STATUSES: readonly ItemStatus[] = ["active", "review"];

/** normal / long (level 3's default) / locked: kept forever, only the user changes it. */
export type Retention = "normal" | "long" | "locked";
export const RETENTIONS: readonly Retention[] = ["normal", "long", "locked"];

/** Who made a change. `system` = the program itself (validity running out, counter-evidence). */
export type Actor = "user" | "main_agent" | "memory_agent" | "system" | "migration";

export type LinkKind = "derived_from" | "supersedes" | "conflicts" | "refutes";
export type SourceKind = "session" | "task" | "run" | "user_edit" | "migration" | "tool";

export interface MemoryItem {
	id: string;
	version: number;
	level: Level;
	kind: ItemKind;
	content: string;
	conditions: string | null;
	scope: ItemScope;
	workspaceId: string | null;
	groupId: string | null;
	confidence: Confidence;
	status: ItemStatus;
	pinned: boolean;
	retention: Retention;
	/** The background may change it on its own (the user can turn this off per item). */
	autoOk: boolean;
	occurredAt: number | null;
	validFrom: number | null;
	validUntil: number | null;
	lastVerifiedAt: number | null;
	nextReviewAt: number | null;
	/** Only hints for reviews, never evidence (§2.1). */
	lastUsedAt: number | null;
	useCount: number;
	createdAt: number;
	updatedAt: number;
	createdBy: Actor;
}

export interface SourceInput {
	kind: SourceKind;
	/** Session file, task id, run id… */
	ref?: string | null;
	/** A short excerpt, never the whole conversation. */
	excerpt?: string | null;
}

export interface MemorySource extends SourceInput {
	at: number;
}

/** Fields a new item may set; the rest get defaults. */
export interface NewItem {
	/** Set when a later op in the same batch refers to it (MemoryStore.newId). */
	id?: string;
	content: string;
	kind: ItemKind;
	level: Level;
	scope: ItemScope;
	workspaceId?: string | null;
	groupId?: string | null;
	confidence: Confidence;
	conditions?: string | null;
	/** active or review; migration may also bring in what v0.2 kept (superseded…). */
	status?: ItemStatus;
	pinned?: boolean;
	retention?: Retention;
	occurredAt?: number | null;
	validFrom?: number | null;
	validUntil?: number | null;
	nextReviewAt?: number | null;
}

/** Fields an edit may change. Status changes go through their own op so the log can say what happened. */
export interface ItemPatch {
	content?: string;
	kind?: ItemKind;
	level?: Level;
	conditions?: string | null;
	scope?: ItemScope;
	workspaceId?: string | null;
	groupId?: string | null;
	confidence?: Confidence;
	pinned?: boolean;
	retention?: Retention;
	autoOk?: boolean;
	validFrom?: number | null;
	validUntil?: number | null;
	nextReviewAt?: number | null;
	lastVerifiedAt?: number | null;
}

export type MemoryOp =
	| { kind: "add"; item: NewItem; sources?: SourceInput[]; links?: { to: string; kind: LinkKind }[]; reason?: string }
	| { kind: "edit"; id: string; baseVersion?: number; patch: ItemPatch; sources?: SourceInput[]; reason?: string }
	| { kind: "status"; id: string; baseVersion?: number; status: ItemStatus; links?: { to: string; kind: LinkKind }[]; sources?: SourceInput[]; reason?: string };

/** Why a change waits for the user instead of taking effect (§4's exceptions, or the 「写入前要我确认」 setting). */
export type PendingWhy = "locked" | "promote_global" | "confirm";

export interface CommitResult {
	/** null when nothing was applied. */
	batchId: string | null;
	applied: { opId: string; itemId: string; kind: MemoryOp["kind"] }[];
	pending: { pendingId: string; itemId: string | null; why: PendingWhy }[];
	rejected: { index: number; reason: string }[];
}

export interface PendingChange {
	id: string;
	op: MemoryOp;
	itemId: string | null;
	baseVersion: number | null;
	actor: Actor;
	reason: string | null;
	why: PendingWhy;
	scope: ItemScope;
	workspaceId: string | null;
	sessionRef: string | null;
	status: "pending" | "accepted" | "rejected" | "stale";
	createdAt: number;
	resolvedAt: number | null;
	/** The item as it is now (for edits and status changes). */
	current: MemoryItem | null;
}

/** One line of the memory log (§4): what changed, who did it, why, and whether it can be undone. */
export interface LogEntry {
	opId: string;
	batchId: string;
	batchKind: string;
	at: number;
	actor: Actor;
	kind: MemoryOp["kind"] | "undo";
	itemId: string;
	/** The item before the change (null when added). */
	before: MemoryItem | null;
	after: MemoryItem;
	/** Fields that differ between before and after. */
	changed: string[];
	reason: string | null;
	/** The change rests on the agent's inference (shown as 「推测」). */
	inferred: boolean;
	sessionRef: string | null;
	undoOf: string | null;
	undone: boolean;
	/** Not undone yet, and nothing changed the item since. */
	undoable: boolean;
}

export interface LogDay {
	/** Local date, YYYY-MM-DD. */
	day: string;
	entries: LogEntry[];
}
