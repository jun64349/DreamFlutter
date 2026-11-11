export const T99_MIGRATION = `
	ALTER TABLE goal_intents ADD COLUMN run_id TEXT;
	ALTER TABLE goal_ledger ADD COLUMN release_reason TEXT;
	CREATE TABLE goal_approvals (
		id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), revision INTEGER NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('acceptance','scope')),
		status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','dropped')),
		payload TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER
	);
	CREATE INDEX goal_approvals_open ON goal_approvals(goal_id, kind) WHERE status='pending';
	CREATE UNIQUE INDEX goal_intents_open_review ON goal_intents(goal_id) WHERE action='review' AND status IN ('pending','started');
`;
