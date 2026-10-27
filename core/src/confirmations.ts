import type { Db } from "./db.ts";
import { json, now, parseJson } from "./db.ts";
import { dialogKind, type DialogKind } from "./pi/dialogs.ts";
import type { DialogOutcome, UiRequest, UiResponse } from "./pi/ui-bridge.ts";

export type ConfirmationStatus = "pending" | "answered" | "cancelled" | "expired";

export interface Confirmation {
	id: string;
	slotId: string | null;
	sessionFile: string | null;
	cwd: string | null;
	method: string;
	kind: DialogKind;
	title: string;
	request: UiRequest;
	status: ConfirmationStatus;
	answer: UiResponse | null;
	createdAt: number;
	resolvedAt: number | null;
}

interface Row {
	id: string;
	slot_id: string | null;
	session_file: string | null;
	cwd: string | null;
	method: string;
	kind: string;
	title: string;
	request: string;
	status: string;
	answer: string | null;
	created_at: number;
	resolved_at: number | null;
}

export interface DialogOrigin {
	slotId: string;
	sessionFile: string | undefined;
	cwd: string;
}

/**
 * Persistent record of every dialog the agent raised ("confirmation cards"),
 * so the inbox survives closing the window. Answering still goes through the
 * live session's UiBridge; after a core restart pending rows become expired
 * because the run that was waiting on them is gone.
 */
export class ConfirmationStore {
	private readonly db: Db;

	constructor(db: Db) {
		this.db = db;
	}

	opened(origin: DialogOrigin, request: UiRequest): void {
		this.db.run(
			`INSERT OR REPLACE INTO confirmations(id, slot_id, session_file, cwd, method, kind, title, request, status, created_at)
			 VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
			request.id,
			origin.slotId,
			origin.sessionFile ?? null,
			origin.cwd,
			request.method,
			dialogKind(request.title),
			typeof request.title === "string" ? request.title : "",
			json(request),
			now(),
		);
	}

	closed(id: string, outcome: DialogOutcome, response?: UiResponse): void {
		const status: ConfirmationStatus = outcome === "answered" ? "answered" : outcome === "timeout" ? "expired" : "cancelled";
		this.db.run(
			"UPDATE confirmations SET status = ?, answer = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
			status,
			response ? json(response) : null,
			now(),
			id,
		);
	}

	/** Marks dialogs left pending by a previous core process as expired. */
	expireOrphans(): number {
		return this.db.run("UPDATE confirmations SET status = 'expired', resolved_at = ? WHERE status = 'pending'", now()).changes;
	}

	get(id: string): Confirmation | undefined {
		const row = this.db.get<Row>("SELECT * FROM confirmations WHERE id = ?", id);
		return row ? toConfirmation(row) : undefined;
	}

	list(options: { status?: ConfirmationStatus; limit?: number } = {}): Confirmation[] {
		const limit = options.limit ?? 100;
		const rows = options.status
			? this.db.all<Row>("SELECT * FROM confirmations WHERE status = ? ORDER BY created_at DESC LIMIT ?", options.status, limit)
			: this.db.all<Row>("SELECT * FROM confirmations ORDER BY created_at DESC LIMIT ?", limit);
		return rows.map(toConfirmation);
	}

	prune(olderThanMs: number): void {
		this.db.run("DELETE FROM confirmations WHERE status != 'pending' AND created_at < ?", now() - olderThanMs);
	}
}

function toConfirmation(row: Row): Confirmation {
	return {
		id: row.id,
		slotId: row.slot_id,
		sessionFile: row.session_file,
		cwd: row.cwd,
		method: row.method,
		kind: row.kind as DialogKind,
		title: row.title,
		request: parseJson<UiRequest>(row.request, { type: "extension_ui_request", id: row.id, method: row.method }),
		status: row.status as ConfirmationStatus,
		answer: parseJson<UiResponse | null>(row.answer, null),
		createdAt: row.created_at,
		resolvedAt: row.resolved_at,
	};
}
