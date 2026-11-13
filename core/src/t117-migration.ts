export const T117_MIGRATION = `
	CREATE TABLE notification_receipts (
		key TEXT PRIMARY KEY,
		category TEXT NOT NULL,
		object_ref TEXT,
		item_id TEXT,
		state TEXT NOT NULL CHECK(state IN ('queued','muted','sent','failed')),
		attempts INTEGER NOT NULL DEFAULT 0,
		reason TEXT,
		created_at INTEGER NOT NULL,
		quiet_at INTEGER,
		sent_at INTEGER
	);
	CREATE INDEX notification_receipts_item ON notification_receipts(item_id) WHERE item_id IS NOT NULL;
	CREATE INDEX notification_receipts_object ON notification_receipts(object_ref) WHERE object_ref IS NOT NULL;
	CREATE INDEX notification_receipts_sent ON notification_receipts(sent_at) WHERE sent_at IS NOT NULL;
	CREATE TABLE notification_metrics (
		day TEXT PRIMARY KEY,
		quiet_suppressed INTEGER NOT NULL DEFAULT 0,
		duplicate_suppressed INTEGER NOT NULL DEFAULT 0
	);
`;
