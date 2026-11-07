import type { Db } from "../db.ts";
import { redact } from "./redaction.ts";

export const POLICY_VERSION = "T63-1";
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export interface AuditContext { slotId?: string; runId?: string; requestId?: string; }
export interface AuditEvent extends AuditContext { time: number; policy: string; kind: string; object: string; decision: string; reason: string; }

/** Local, inspectable audit. No tool content or credential values are accepted here. */
export class SecurityAudit {
	private db: Db;
	private now: () => number;
	constructor(db: Db, now = Date.now) {
		this.db = db; this.now = now;
		db.raw.exec(`CREATE TABLE IF NOT EXISTS security_audit (
			id INTEGER PRIMARY KEY, time INTEGER NOT NULL, policy TEXT NOT NULL, kind TEXT NOT NULL,
			object TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL,
			slotId TEXT, runId TEXT, requestId TEXT);
			CREATE INDEX IF NOT EXISTS security_audit_time ON security_audit(time)`);
		this.cleanup();
	}
	cleanup(): void { this.db.run("DELETE FROM security_audit WHERE time < ?", this.now() - RETENTION_MS); }
	record(kind: string, object: string, decision: string, reason: string, context: AuditContext = {}): void {
		this.cleanup();
		this.db.run("INSERT INTO security_audit(time,policy,kind,object,decision,reason,slotId,runId,requestId) VALUES(?,?,?,?,?,?,?,?,?)",
			this.now(), POLICY_VERSION, kind, redact(object, true), decision, redact(reason, true),
			context.slotId ?? null, context.runId ?? null, context.requestId ?? null);
	}
	query(options: { before?: number; limit?: number; kind?: string } = {}): AuditEvent[] {
		this.cleanup();
		return this.db.all<AuditEvent>("SELECT * FROM security_audit WHERE id < ? AND (? IS NULL OR kind = ?) ORDER BY id DESC LIMIT ?",
			Number.isSafeInteger(options.before) ? options.before! : Number.MAX_SAFE_INTEGER,
			options.kind ?? null, options.kind ?? null, Math.min(1000, Math.max(1, Math.trunc(Number.isFinite(options.limit) ? options.limit! : 100))))
			.map((event) => ({ ...event, object: redact(event.object, true), reason: redact(event.reason, true) }));
	}
	export(): string {
		this.cleanup();
		const rows = this.db.all<AuditEvent>("SELECT * FROM security_audit ORDER BY id");
		return rows.map((row) => JSON.stringify({ ...row, object: redact(row.object, true), reason: redact(row.reason, true) })).join("\n");
	}
}
