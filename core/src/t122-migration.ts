export const T122_MIGRATION = `
	CREATE TABLE butterfly_chat_preparations (
		goal_id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		session_file TEXT NOT NULL,
		input_key TEXT NOT NULL,
		state TEXT NOT NULL CHECK(state IN ('preparing','retry','cancelled')),
		manifest TEXT,
		cleanup_pending INTEGER NOT NULL DEFAULT 1,
		stop_key TEXT UNIQUE,
		stop_text TEXT,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX butterfly_chat_preparations_session ON butterfly_chat_preparations(session_id,state,created_at);
`;
