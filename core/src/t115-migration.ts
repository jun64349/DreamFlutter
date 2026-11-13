export const T115_MIGRATION = `
	CREATE TABLE autonomy_folder_baseline (
		folder TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL,
		PRIMARY KEY(folder,path)
	);
	CREATE TABLE butterfly_chat_tasks (
		mandate_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL UNIQUE,
		session_id TEXT NOT NULL, session_file TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE,
		inputs TEXT NOT NULL, deliverables TEXT NOT NULL, created_at INTEGER NOT NULL,
		stopped_at INTEGER, required_action TEXT
	);
	CREATE INDEX butterfly_chat_tasks_session ON butterfly_chat_tasks(session_id,created_at);

	-- Program-authored chat receipts are transcript entries with zero usage, not requests.
	CREATE TRIGGER butterfly_chat_receipt_usage BEFORE INSERT ON usage_records
	WHEN NEW.provider='dreamflutter-system' AND NEW.model='butterfly-task-receipt'
	BEGIN SELECT RAISE(IGNORE); END;
`;
