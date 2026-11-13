export const T113_MIGRATION = `
	CREATE TABLE autonomy_spending (
		source TEXT NOT NULL, ref_id TEXT NOT NULL, day TEXT NOT NULL,
		at INTEGER NOT NULL, cost_usd REAL NOT NULL CHECK(cost_usd >= 0),
		PRIMARY KEY(source, ref_id)
	);
	CREATE INDEX autonomy_spending_day ON autonomy_spending(day);
	CREATE TABLE autonomy_events (
		id TEXT PRIMARY KEY, source TEXT NOT NULL, identity TEXT NOT NULL, trust TEXT NOT NULL,
		at INTEGER NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, reason TEXT
	);
	CREATE INDEX autonomy_events_state ON autonomy_events(state, at);
	CREATE TABLE autonomy_audit (
		id INTEGER PRIMARY KEY, event_id TEXT, at INTEGER NOT NULL, reason TEXT NOT NULL
	);
	CREATE TABLE autonomy_rules (
		id TEXT PRIMARY KEY, revision INTEGER NOT NULL, mode TEXT NOT NULL,
		definition TEXT NOT NULL, updated_at INTEGER NOT NULL
	);
	CREATE TABLE autonomy_hits (
		id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, revision INTEGER NOT NULL,
		event_id TEXT NOT NULL, mode TEXT NOT NULL, at INTEGER NOT NULL,
		reason TEXT NOT NULL, cost_usd REAL NOT NULL DEFAULT 0
	);
	CREATE INDEX autonomy_hits_rule ON autonomy_hits(rule_id, at);
	CREATE TABLE autonomy_mandates (
		id TEXT PRIMARY KEY, event_id TEXT NOT NULL, rule_id TEXT, rule_revision INTEGER,
		granted_by TEXT NOT NULL, at INTEGER NOT NULL, definition TEXT NOT NULL,
		approval_id TEXT
	);
	CREATE TABLE autonomy_effects (
		key TEXT PRIMARY KEY, mandate_id TEXT NOT NULL, kind TEXT NOT NULL,
		state TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT, at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX autonomy_effects_state ON autonomy_effects(state, at);
	CREATE TABLE autonomy_confirmations (
		id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL
	);
	CREATE TABLE autonomy_budget_holds (
		source TEXT NOT NULL, ref_id TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL,
		estimate_usd REAL NOT NULL, PRIMARY KEY(source, ref_id)
	);
	CREATE UNIQUE INDEX autonomy_goal_mandate ON goals(mandate_ref)
		WHERE mandate_ref GLOB 'rule:autonomy-*' OR mandate_ref GLOB 'user:autonomy-*';
`;
