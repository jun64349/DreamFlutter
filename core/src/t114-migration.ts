export const T114_MIGRATION = `
	CREATE TABLE butterfly_proactive (
		ref_id TEXT PRIMARY KEY,
		requested_at INTEGER NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('waiting','generating','sending','sent','skipped')),
		reason TEXT,
		estimate_usd REAL,
		sent_at INTEGER,
		sent_day TEXT,
		session_file TEXT,
		entry_id TEXT,
		replied_at INTEGER
	);
	CREATE INDEX butterfly_proactive_day ON butterfly_proactive(sent_day, sent_at)
		WHERE state IN ('sent','sending');
`;
