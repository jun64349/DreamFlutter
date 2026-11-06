import { randomUUID } from "node:crypto";
import { normalizeCwd } from "../core.ts";
import type { Db } from "../db.ts";
import type { ItemKind, ItemScope, MemoryItem } from "./types.ts";

export interface Workspace {
	id: string;
	path: string;
	/** Global memories about the user's personal background show up in this workspace (§8). */
	globalBackground: boolean;
	createdAt: number;
}

/**
 * Which memories a session may read and write (docs/memory-design.md §8).
 * Every place that reads memory or history goes through one of these.
 */
export interface ScopeSet {
	/** The workbench workspace the session is in; null in 蝶君. */
	workspaceId: string | null;
	/** Shared groups the workspace belongs to. */
	groupIds: string[];
	/** A 蝶君 session: reads global and 蝶君's partition, never a workspace's. */
	butterfly: boolean;
	/** Global memories of kind background are shown (a workspace can turn them off). */
	globalBackground: boolean;
	/** Distinguishes cached materials and snapshots per scope. */
	key: string;
}

/** Kinds that are about the user personally (a workspace can hide the global ones, §8). */
const PERSONAL_KINDS: readonly ItemKind[] = ["background"];

/** Workspaces with a stable id: a path that changes (renamed folder, restored backup) keeps its memories. */
export class Workspaces {
	private readonly db: Db;
	private readonly clock: () => number;

	constructor(db: Db, clock: () => number) {
		this.db = db;
		this.clock = clock;
	}

	/** The workspace at [path], created on first use. */
	ensure(path: string): Workspace {
		const existing = this.byPath(path);
		if (existing) return existing;
		const id = `w_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
		this.db.run("INSERT INTO workspaces(id, path, path_key, created_at) VALUES(?, ?, ?, ?)", id, path, normalizeCwd(path), this.clock());
		return this.get(id)!;
	}

	byPath(path: string): Workspace | undefined {
		const row = this.db.get<WorkspaceRow>("SELECT * FROM workspaces WHERE path_key = ?", normalizeCwd(path));
		return row ? toWorkspace(row) : undefined;
	}

	get(id: string): Workspace | undefined {
		const row = this.db.get<WorkspaceRow>("SELECT * FROM workspaces WHERE id = ?", id);
		return row ? toWorkspace(row) : undefined;
	}

	list(): Workspace[] {
		return this.db.all<WorkspaceRow>("SELECT * FROM workspaces ORDER BY created_at").map(toWorkspace);
	}

	/** The folder moved: its memories follow the id. */
	move(id: string, path: string): void {
		this.db.run("UPDATE workspaces SET path = ?, path_key = ? WHERE id = ?", path, normalizeCwd(path), id);
	}

	setGlobalBackground(id: string, on: boolean): void {
		this.db.run("UPDATE workspaces SET global_background = ? WHERE id = ?", on ? 1 : 0, id);
	}

	groupsOf(id: string): string[] {
		return this.db.all<{ group_id: string }>("SELECT group_id FROM workspace_group_members WHERE workspace_id = ?", id).map((r) => r.group_id);
	}
}

interface WorkspaceRow {
	id: string;
	path: string;
	global_background: number;
	created_at: number;
}

function toWorkspace(row: WorkspaceRow): Workspace {
	return { id: row.id, path: row.path, globalBackground: row.global_background === 1, createdAt: row.created_at };
}

/** The scopes a session in [cwd] may use; 蝶君's sessions are the ones in its home folder. */
export function allowedScopes(workspaces: Workspaces, cwd: string, butterflyHome: string): ScopeSet {
	if (isInside(cwd, butterflyHome)) return { workspaceId: null, groupIds: [], butterfly: true, globalBackground: true, key: "butterfly" };
	const workspace = workspaces.ensure(cwd);
	const groupIds = workspaces.groupsOf(workspace.id);
	return { workspaceId: workspace.id, groupIds, butterfly: false, globalBackground: workspace.globalBackground, key: `workspace:${workspace.id}` };
}

function isInside(path: string, folder: string): boolean {
	const p = normalizeCwd(path);
	const f = normalizeCwd(folder);
	return p === f || p.startsWith(f.endsWith("\\") || f.endsWith("/") ? f : `${f}\\`) || p.startsWith(`${f}/`);
}

/** Whether [item] is readable from [set]. */
export function visibleIn(item: Pick<MemoryItem, "scope" | "workspaceId" | "groupId" | "kind">, set: ScopeSet): boolean {
	switch (item.scope) {
		case "global":
			return set.globalBackground || !PERSONAL_KINDS.includes(item.kind);
		case "workspace":
			return !set.butterfly && item.workspaceId !== null && item.workspaceId === set.workspaceId;
		case "group":
			return !set.butterfly && item.groupId !== null && set.groupIds.includes(item.groupId);
		case "butterfly":
			return set.butterfly;
	}
}

/** Whether a session in [set] may put a memory in [scope] (and that workspace or group). */
export function writableIn(target: { scope: ItemScope; workspaceId?: string | null; groupId?: string | null }, set: ScopeSet): boolean {
	switch (target.scope) {
		case "global":
			return true;
		case "workspace":
			return !set.butterfly && !!target.workspaceId && target.workspaceId === set.workspaceId;
		case "group":
			return !set.butterfly && !!target.groupId && set.groupIds.includes(target.groupId);
		case "butterfly":
			return set.butterfly;
	}
}

/** Where a memory goes when the scope is not clear: the session's own partition, never global (§4). */
export function homeScope(set: ScopeSet): { scope: ItemScope; workspaceId: string | null } {
	return set.butterfly ? { scope: "butterfly", workspaceId: null } : { scope: "workspace", workspaceId: set.workspaceId };
}
