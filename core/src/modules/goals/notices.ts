import { randomUUID } from "node:crypto";
import { json, parseJson, type Db } from "../../db.ts";
import type { NotificationState } from "../../notify.ts";

type Sender = "goal" | "patrol";
export interface GoalNoticeReceipt { sender: Sender; state: NotificationState; note?: string }

const receiptKey = (key: string) => `delivery:${key}`;

export function goalNoticeReceipt(db: Db, key: string): GoalNoticeReceipt | null {
	const row = db.get<{ payload: string }>("SELECT payload FROM goal_events WHERE dedupe_key=?", receiptKey(key));
	return parseJson(row?.payload, null);
}

// The receipt travels with goal_events in backups and is already handled when written.
export function recordGoalNotice(db: Db, goalId: string, key: string, sender: Sender, state: NotificationState, at: number, note?: string): void {
	const payload: GoalNoticeReceipt & { notificationKey: string } = {
		notificationKey: key, sender, state,
		...(state === "muted" ? { note: "通知关着" } : note ? { note } : {}),
	};
	db.run(`INSERT INTO goal_events(id,goal_id,kind,dedupe_key,payload,created_at,handled_at)
		VALUES(?,?,'notification.delivery',?,?,?,?) ON CONFLICT(dedupe_key) DO UPDATE SET payload=excluded.payload,handled_at=excluded.handled_at`,
		randomUUID(), goalId, receiptKey(key), json(payload), at, at);
}

export function goalNoticeBlocksPatrol(db: Db, key: string): boolean {
	// Managed goals send through the mandate-checked outbox even when patrol notices are enabled.
	const goalId = /^notify:([^:]+):/.exec(key)?.[1];
	if (goalId && db.get(`SELECT 1 FROM goals WHERE id=? AND
		(mandate_ref GLOB 'rule:autonomy-*' OR mandate_ref GLOB 'user:autonomy-*')`, goalId)) return true;
	const receipt = goalNoticeReceipt(db, key);
	if (!receipt) return !!db.get("SELECT 1 FROM goal_intents WHERE idem_key=? AND action='notify' AND status='pending'", key);
	if (receipt.state === "failed") return receipt.sender === "patrol";
	if (receipt.state !== "queued" || receipt.sender === "patrol") return true;
	return !db.get("SELECT 1 FROM goal_intents WHERE idem_key=? AND status='dropped'", key);
}

export function recoverGoalNotices(db: Db, at: number): void {
	const interrupted = db.all<{ goal_id: string; payload: string }>(`SELECT goal_id,payload FROM goal_events e
		WHERE kind='notification.delivery' AND json_extract(payload,'$.state')='queued'
		AND NOT EXISTS(SELECT 1 FROM goal_intents i WHERE i.idem_key=json_extract(e.payload,'$.notificationKey') AND i.status='pending')`);
	for (const row of interrupted) {
		const { notificationKey, sender } = JSON.parse(row.payload) as GoalNoticeReceipt & { notificationKey: string };
		recordGoalNotice(db, row.goal_id, notificationKey, sender, "failed", at, "发送中断，无法确认是否送达");
	}
}
