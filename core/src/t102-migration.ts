export const T102_MIGRATION = `
	ALTER TABLE jobs ADD COLUMN goal_id TEXT;
	ALTER TABLE jobs ADD COLUMN owner_run_id TEXT;
	ALTER TABLE jobs ADD COLUMN goal_revision INTEGER;
	CREATE INDEX jobs_goal ON jobs(goal_id, goal_revision, status);
	ALTER TABLE goals ADD COLUMN session_file TEXT;
	CREATE INDEX goals_session ON goals(lower(session_file));
	ALTER TABLE goal_waits ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
	ALTER TABLE goal_waits ADD COLUMN label TEXT;
	CREATE INDEX goal_waits_open_deadline ON goal_waits(deadline) WHERE status='open';
	ALTER TABLE goal_ledger ADD COLUMN cost_unknown INTEGER NOT NULL DEFAULT 0;
	UPDATE goals SET reason='restart_check',resume_when='模型价格未知，可以继续，费用无法估算'
	WHERE status='paused' AND reason='budget_cost' AND resume_when='模型缺少可用价格，核对渠道价格后继续';
	CREATE TABLE goal_proposals (
		id TEXT PRIMARY KEY, session_file TEXT NOT NULL, message_id TEXT NOT NULL,
		origin_text TEXT NOT NULL, draft TEXT NOT NULL, created_at INTEGER NOT NULL,
		status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
		goal_id TEXT, UNIQUE(session_file, message_id)
	);
`;
