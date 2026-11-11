export const T97_MIGRATION = `
	CREATE TABLE patrol_runs (
		id TEXT PRIMARY KEY,
		started_at INTEGER NOT NULL,
		ended_at INTEGER,
		status TEXT CHECK (status IN ('quiet','handled','notified','waiting_user','error','skipped')),
		manual INTEGER NOT NULL CHECK (manual IN (0,1)),
		facts TEXT NOT NULL DEFAULT '[]',
		new_facts TEXT NOT NULL DEFAULT '[]',
		facts_hash TEXT,
		note TEXT,
		actions TEXT NOT NULL DEFAULT '[]',
		notified INTEGER NOT NULL DEFAULT 0 CHECK (notified IN (0,1)),
		model TEXT,
		cost REAL NOT NULL DEFAULT 0,
		error TEXT,
		session_file TEXT,
		notification TEXT,
		attention_resolved_at INTEGER
	);
	CREATE INDEX patrol_runs_started ON patrol_runs(started_at, id);
	CREATE INDEX patrol_runs_notification ON patrol_runs(started_at) WHERE notification IS NOT NULL AND notified=0;
	CREATE TABLE watch_items (
		id TEXT PRIMARY KEY,
		text TEXT NOT NULL,
		created_by TEXT NOT NULL CHECK (created_by IN ('user','butterfly','patrol')),
		created_at INTEGER NOT NULL,
		until INTEGER,
		done_at INTEGER
	);
`;
