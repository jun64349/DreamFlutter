export const T101_MIGRATION = `
	CREATE TABLE jobs (
		id TEXT PRIMARY KEY,
		session_file TEXT,
		slot_id TEXT NOT NULL,
		cwd TEXT NOT NULL,
		sandboxed INTEGER NOT NULL CHECK (sandboxed IN (0,1)),
		kind TEXT NOT NULL,
		label TEXT NOT NULL,
		command TEXT,
		service INTEGER NOT NULL DEFAULT 0 CHECK (service IN (0,1)),
		status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled','lost')),
		exit_code INTEGER,
		detail TEXT,
		started_at INTEGER NOT NULL,
		ended_at INTEGER,
		stopped_by TEXT CHECK (stopped_by IN ('model','user','shutdown')),
		output_path TEXT
	);
	CREATE INDEX jobs_started ON jobs(started_at DESC, id);
	CREATE INDEX jobs_slot ON jobs(slot_id, started_at DESC);
	CREATE INDEX jobs_session ON jobs(lower(session_file), started_at DESC);
`;
