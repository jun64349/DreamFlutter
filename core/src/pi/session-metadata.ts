import { readFileSync } from "node:fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Db } from "../db.ts";
import { parseJson } from "../db.ts";

export const SIDE_ENTRY = "df.sideConversation";
export const HISTORY_ENTRY = "df.inheritedHistory";

export interface SideConversation {
	sessionId: string;
	quote: string;
	quoteEntryId: string | null;
}

/** Markers copied from an ancestor belong to that ancestor, not the new session. */
export function sideConversation(manager: Pick<SessionManager, "getEntries" | "getSessionId">): SideConversation | undefined {
	return sideFromEntries(manager.getEntries(), manager.getSessionId());
}

export function sideFromEntries(entries: readonly unknown[], sessionId: string): SideConversation | undefined {
	for (const raw of entries) {
		const e = raw as { type?: string; customType?: string; data?: SideConversation };
		if (e.type === "custom" && e.customType === SIDE_ENTRY && e.data?.sessionId === sessionId) return e.data;
	}
	return undefined;
}

export function readSessionEntries(path: string): Record<string, any>[] {
	return readFileSync(path, "utf8").split("\n").flatMap((line) => {
		try {
			const entry = line.trim() ? JSON.parse(line) : null;
			return entry && typeof entry === "object" && !Array.isArray(entry) ? [entry] : [];
		} catch { return []; }
	});
}

export function isSideFile(path: string): boolean {
	const entries = readSessionEntries(path);
	return !!sideFromEntries(entries, entries.find((e) => e.type === "session")?.id ?? "");
}

/** Exact markers/cache first; timestamp fallback is only an approximation for legacy orphans. */
export function inheritedIds(entries: readonly Record<string, any>[], sessionId: string, parent: string | null, createdAt: number | string, db?: Db): Set<string> {
	const marker = entries.find((e) => e.type === "custom" && e.customType === HISTORY_ENTRY && e.data?.sessionId === sessionId);
	if (marker) {
		const end = entries.findIndex((e) => e.id === marker.data.lastEntryId);
		return new Set(end < 0 ? [] : entries.slice(0, end + 1).map((e) => e.id));
	}
	if (!parent) return new Set();
	const cached = db?.get<{ entry_ids: string }>("SELECT entry_ids FROM session_inherited_history WHERE session_id = ? AND parent_session = ?", sessionId, parent);
	const ids = cached ? parseJson<unknown>(cached.entry_ids, undefined) : undefined;
	if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) return new Set(ids);
	// Legacy files predate our boundary marker. Shared entry IDs are authoritative
	// while the source exists (including forks created in the same millisecond).
	let source: Set<string>;
	try { source = new Set(readSessionEntries(parent).map((e) => e.id)); }
	catch {
		const time = typeof createdAt === "string" ? Date.parse(createdAt) : createdAt;
		return new Set(entries.filter((e) => {
			const usage = e.type === "message" ? e.message?.usage : ["usage", "compaction", "branch_summary"].includes(e.type) ? e.usage : undefined;
			return usage && typeof usage === "object" && Date.parse(e.timestamp) <= time;
		}).map((e) => e.id));
	}
	const confirmed = entries.filter((e) => typeof e.id === "string" && source.has(e.id)).map((e) => e.id);
	// Never cache a time estimate or write back to the old JSONL. An empty exact set is meaningful too.
	db?.run("INSERT INTO session_inherited_history(session_id, parent_session, entry_ids) VALUES(?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET parent_session = excluded.parent_session, entry_ids = excluded.entry_ids", sessionId, parent, JSON.stringify(confirmed));
	return new Set(confirmed);
}
