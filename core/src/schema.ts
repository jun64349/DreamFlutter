/**
 * Forward-only schema migrations; index i upgrades user_version i → i+1.
 * Never edit a shipped entry, append a new one.
 */
export const MIGRATIONS: string[] = [
	// 1: settings, persisted dialogs, run log.
	`
	CREATE TABLE settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);

	CREATE TABLE confirmations (
		id TEXT PRIMARY KEY,
		slot_id TEXT,
		session_file TEXT,
		cwd TEXT,
		method TEXT NOT NULL,
		kind TEXT NOT NULL,
		title TEXT NOT NULL,
		request TEXT NOT NULL,
		status TEXT NOT NULL,
		answer TEXT,
		created_at INTEGER NOT NULL,
		resolved_at INTEGER
	);
	CREATE INDEX confirmations_status ON confirmations(status, created_at);

	CREATE TABLE runs (
		id TEXT PRIMARY KEY,
		slot_id TEXT,
		session_file TEXT,
		session_id TEXT,
		cwd TEXT NOT NULL,
		task_id TEXT,
		prompt TEXT,
		status TEXT NOT NULL,
		started_at INTEGER NOT NULL,
		ended_at INTEGER,
		model TEXT,
		turns INTEGER NOT NULL DEFAULT 0,
		tool_calls INTEGER NOT NULL DEFAULT 0,
		tool_errors INTEGER NOT NULL DEFAULT 0,
		input_tokens INTEGER NOT NULL DEFAULT 0,
		output_tokens INTEGER NOT NULL DEFAULT 0,
		cache_read INTEGER NOT NULL DEFAULT 0,
		cache_write INTEGER NOT NULL DEFAULT 0,
		cost REAL NOT NULL DEFAULT 0,
		error TEXT,
		files TEXT,
		acknowledged INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX runs_session ON runs(session_file, started_at);
	CREATE INDEX runs_started ON runs(started_at);

	CREATE TABLE run_steps (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
		at INTEGER NOT NULL,
		kind TEXT NOT NULL,
		name TEXT,
		summary TEXT,
		status TEXT,
		duration_ms INTEGER
	);
	CREATE INDEX run_steps_run ON run_steps(run_id, id);

	CREATE TABLE workspace_tool_rules (
		cwd TEXT NOT NULL,
		tool TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (cwd, tool)
	);
	`,
	// 2: session index (search, pin/archive, titles) and per-response usage.
	`
	CREATE TABLE session_meta (
		path TEXT PRIMARY KEY,
		cwd TEXT,
		session_id TEXT,
		parent_session TEXT,
		name TEXT,
		first_message TEXT,
		created_at INTEGER,
		modified_at INTEGER,
		size INTEGER,
		message_count INTEGER NOT NULL DEFAULT 0,
		pinned INTEGER NOT NULL DEFAULT 0,
		archived INTEGER NOT NULL DEFAULT 0,
		indexed_mtime INTEGER,
		indexed_size INTEGER
	);
	CREATE INDEX session_meta_cwd ON session_meta(cwd, modified_at);

	CREATE VIRTUAL TABLE session_fts USING fts5(path UNINDEXED, entry_id UNINDEXED, role UNINDEXED, text, tokenize = 'trigram');

	CREATE TABLE usage_records (
		path TEXT NOT NULL,
		entry_id TEXT NOT NULL,
		at INTEGER NOT NULL,
		cwd TEXT,
		provider TEXT,
		model TEXT,
		input INTEGER NOT NULL DEFAULT 0,
		output INTEGER NOT NULL DEFAULT 0,
		cache_read INTEGER NOT NULL DEFAULT 0,
		cache_write INTEGER NOT NULL DEFAULT 0,
		cost REAL NOT NULL DEFAULT 0,
		PRIMARY KEY (path, entry_id)
	);
	CREATE INDEX usage_records_at ON usage_records(at);
	`,
];
