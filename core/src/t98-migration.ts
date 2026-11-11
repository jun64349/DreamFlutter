export const T98_MIGRATION = `
	CREATE TABLE goals (
		id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
		title TEXT NOT NULL, origin_text TEXT NOT NULL, spec TEXT NOT NULL, scope TEXT NOT NULL,
		mandate_ref TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('user','card','schedule','rule')),
		status TEXT NOT NULL CHECK (status IN ('draft','queued','running','reviewing','waiting_dependency','waiting_user','paused','blocked','completed','failed','cancelled')),
		reason TEXT, resume_when TEXT,
		stop_intent TEXT CHECK (stop_intent IN ('pause','stop_run','cancel','emergency')),
		current_task_id TEXT, budget TEXT, progress TEXT NOT NULL DEFAULT '{}',
		lease_owner TEXT, lease_generation INTEGER NOT NULL DEFAULT 0, lease_until INTEGER,
		latest_review_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER
	);
	CREATE INDEX goals_status ON goals(status, updated_at);
	CREATE TABLE goal_revisions (
		goal_id TEXT NOT NULL REFERENCES goals(id), revision INTEGER NOT NULL, origin_text TEXT NOT NULL,
		spec TEXT NOT NULL, scope TEXT NOT NULL, "by" TEXT NOT NULL, why TEXT, at INTEGER NOT NULL,
		PRIMARY KEY(goal_id, revision)
	);
	CREATE TABLE goal_events (
		id TEXT PRIMARY KEY, goal_id TEXT REFERENCES goals(id), kind TEXT NOT NULL,
		dedupe_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
		handled_at INTEGER, handled_by_generation INTEGER
	);
	CREATE INDEX goal_events_inbox ON goal_events(goal_id, kind, created_at) WHERE handled_at IS NULL;
	CREATE INDEX goal_events_recent ON goal_events(goal_id, created_at DESC);
	CREATE TABLE goal_intents (
		id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
		revision INTEGER NOT NULL, generation INTEGER NOT NULL, idem_key TEXT NOT NULL UNIQUE,
		action TEXT NOT NULL CHECK (action IN ('run','review','notify')),
		status TEXT NOT NULL CHECK (status IN ('pending','started','dropped','done')),
		reason TEXT, created_at INTEGER NOT NULL, started_at INTEGER
	);
	CREATE INDEX goal_intents_history ON goal_intents(goal_id, revision, generation);
	CREATE UNIQUE INDEX goal_intents_open_run ON goal_intents(goal_id) WHERE action='run' AND status IN ('pending','started');
	CREATE TABLE goal_waits (
		id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
		kind TEXT NOT NULL CHECK (kind IN ('compute','external','user')),
		ref TEXT NOT NULL, wake_on TEXT, deadline INTEGER,
		status TEXT NOT NULL CHECK (status IN ('open','resolved','expired','cancelled')),
		created_at INTEGER NOT NULL, resolved_at INTEGER
	);
	CREATE INDEX goal_waits_open ON goal_waits(goal_id, kind) WHERE status='open';
	CREATE TABLE goal_evidence (
		id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), task_id TEXT, run_id TEXT,
		kind TEXT NOT NULL, ref TEXT, digest TEXT, detail TEXT, version INTEGER NOT NULL, created_at INTEGER NOT NULL,
		UNIQUE(goal_id, version)
	);
	CREATE TABLE goal_reviews (
		id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), revision INTEGER NOT NULL, evidence_version INTEGER NOT NULL,
		layer TEXT NOT NULL CHECK (layer IN ('program','model','user')), verdict TEXT NOT NULL,
		missing TEXT, reasons TEXT, model TEXT, cost REAL, created_at INTEGER NOT NULL
	);
	CREATE INDEX goal_reviews_revision ON goal_reviews(goal_id, revision, evidence_version);
	CREATE TABLE goal_ledger (
		id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), task_id TEXT, run_id TEXT,
		kind TEXT NOT NULL CHECK (kind IN ('main','subagent','review','memory','compaction','assessment')),
		state TEXT NOT NULL CHECK (state IN ('reserved','settled','released')),
		request_id TEXT UNIQUE,
		est_cost REAL NOT NULL, est_input_tokens INTEGER NOT NULL, est_output_tokens INTEGER NOT NULL,
		est_active_ms INTEGER NOT NULL, cost REAL, input_tokens INTEGER, output_tokens INTEGER, active_ms INTEGER,
		cost_estimated INTEGER NOT NULL DEFAULT 1,
		created_at INTEGER NOT NULL, settled_at INTEGER
	);
	CREATE INDEX goal_ledger_usage ON goal_ledger(goal_id, state, created_at);
	ALTER TABLE tasks ADD COLUMN goal_id TEXT REFERENCES goals(id);
	ALTER TABLE tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
	CREATE INDEX tasks_goal ON tasks(goal_id) WHERE goal_id IS NOT NULL;
	ALTER TABLE notices ADD COLUMN goal_id TEXT REFERENCES goals(id);
	ALTER TABLE schedules ADD COLUMN goal_id TEXT REFERENCES goals(id);
`;
