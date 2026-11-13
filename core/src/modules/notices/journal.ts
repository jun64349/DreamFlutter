import type { Core } from "../../core.ts";
import type { CoreSettings } from "../../settings.ts";
import { localDay } from "../session-index.ts";

export type NoticeCategory = "decision" | "blocked" | "review" | "done" | "reminder";
export type NoticeState = "queued" | "muted" | "sent" | "failed";
export interface NoticeIdentity { key: string; category: NoticeCategory; objectRef?: string; itemId?: string | null }
interface Receipt { state: NoticeState; attempts: number; reason: string | null }

export function quietAt(settings: CoreSettings, at: number): boolean {
	if (!settings.patrolQuietEnabled) return false;
	const clock = new Date(at);
	const local = String(clock.getHours()).padStart(2, "0") + ":" + String(clock.getMinutes()).padStart(2, "0");
	const { patrolQuietStart: start, patrolQuietEnd: end } = settings;
	return start <= end ? local >= start && local < end : local >= start || local < end;
}

/** A renewed lease is not a new blockage. Leave T-112's owner intent keys intact. */
export function noticeKey(key: string): string {
	return key.replace(/^(notify:[^:]+:\d+:(?:blocked|budget)):\d+:/, "$1:");
}

export class NoticeJournal {
	private readonly core: Core;
	constructor(core: Core) { this.core = core; }
	private get db() { return this.core.db; }

	recover(): void {
		this.db.run("UPDATE notification_receipts SET state='failed',reason='interrupted' WHERE state='queued' AND attempts>0");
		if (!this.core.settings.get().notifications) this.muteQueue();
	}

	muteQueue(): void {
		this.db.run("UPDATE notification_receipts SET state='muted',reason='notifications_disabled' WHERE state='queued' AND attempts=0");
	}

	private insert(input: NoticeIdentity, at: number): void {
		this.db.run(`INSERT OR IGNORE INTO notification_receipts(key,category,object_ref,item_id,state,created_at)
			VALUES(?,?,?,?,'queued',?)`, noticeKey(input.key), input.category, input.objectRef ?? null, input.itemId ?? null, at);
	}

	quiet(input: NoticeIdentity, at: number, defer: boolean): void {
		const record = () => {
			this.insert(input, at);
			if (this.db.run("UPDATE notification_receipts SET quiet_at=? WHERE key=? AND state='queued' AND attempts=0 AND quiet_at IS NULL",
				at, noticeKey(input.key)).changes) this.metric("quiet_suppressed", at);
			if (!defer) this.mute(input.key, "quiet_hours");
		};
		if (this.db.raw.isTransaction) record();
		else this.db.transaction(record);
	}

	mute(key: string, reason: string): void {
		this.db.run("UPDATE notification_receipts SET state='muted',reason=? WHERE key=? AND state='queued' AND attempts=0", reason, noticeKey(key));
	}

	duplicate(at: number): void { this.metric("duplicate_suppressed", at); }

	private metric(column: "quiet_suppressed" | "duplicate_suppressed", at: number): void {
		this.db.run(`INSERT INTO notification_metrics(day,${column}) VALUES(?,1)
			ON CONFLICT(day) DO UPDATE SET ${column}=${column}+1`, localDay(at));
	}

	claim(input: NoticeIdentity, at: number, options: { quiet?: boolean; mute?: string; retryFailed?: boolean }): { claimed: true } | { claimed: false; state: NoticeState; reason: string } {
		this.insert(input, at);
		const key = noticeKey(input.key);
		const prior = this.db.get<Receipt>("SELECT state,attempts,reason FROM notification_receipts WHERE key=?", key)!;
		const fresh = prior.state === "queued" && prior.attempts === 0;
		if (options.mute) {
			if (fresh) this.mute(key, options.mute);
			return { claimed: false, state: "muted", reason: options.mute };
		}
		if (!fresh && !(options.retryFailed && prior.state === "failed" && prior.attempts === 1 && prior.reason === "delivery_failed")) {
			this.duplicate(at);
			return { claimed: false, state: prior.state, reason: "duplicate" };
		}
		if (options.quiet) {
			this.quiet(input, at, false);
			return { claimed: false, state: "muted", reason: "quiet_hours" };
		}
		this.db.run(`UPDATE notification_receipts SET attempts=attempts+1,state='queued',reason=NULL,
			item_id=COALESCE(item_id,?),object_ref=COALESCE(object_ref,?) WHERE key=?`, input.itemId ?? null, input.objectRef ?? null, key);
		return { claimed: true };
	}

	finish(key: string, state: Exclude<NoticeState, "queued">, at: number, reason: string | null = null): void {
		this.db.run("UPDATE notification_receipts SET state=?,reason=?,sent_at=? WHERE key=? AND state='queued' AND attempts>0",
			state, reason, state === "sent" ? at : null, noticeKey(key));
	}

	sent(key: string): boolean {
		return !!this.db.get("SELECT 1 FROM notification_receipts WHERE key=? AND state='sent'", noticeKey(key));
	}

	latest(objectRef: string): { key: string; category: NoticeCategory } | undefined {
		return this.db.get("SELECT key,category FROM notification_receipts WHERE object_ref=? ORDER BY rowid DESC LIMIT 1", objectRef);
	}

	maySupplement(key: string): boolean {
		const prior = this.db.get<Receipt>("SELECT state,attempts,reason FROM notification_receipts WHERE key=?", noticeKey(key));
		return !prior || prior.state === "queued" && prior.attempts === 0 ||
			prior.state === "failed" && prior.attempts === 1 && prior.reason === "delivery_failed";
	}

	itemSent(id: string, rawId: string): boolean {
		return !!this.db.get("SELECT 1 FROM notification_receipts WHERE item_id IN (?,?) AND state='sent'", id, rawId);
	}
}
