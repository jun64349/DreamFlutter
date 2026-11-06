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
	// 3: long-term memory, memory blocks, snapshots; proposals waiting for the user.
	`
	CREATE TABLE memories (
		id TEXT PRIMARY KEY,
		scope TEXT NOT NULL,
		cwd TEXT,
		kind TEXT NOT NULL,
		content TEXT NOT NULL,
		source TEXT NOT NULL,
		source_session TEXT,
		status TEXT NOT NULL,
		action TEXT,
		target_id TEXT,
		replaced_by TEXT,
		reason TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX memories_status ON memories(status, updated_at);

	CREATE TABLE memory_blocks (
		key TEXT PRIMARY KEY,
		content TEXT NOT NULL DEFAULT '',
		locked INTEGER NOT NULL DEFAULT 0,
		updated_at INTEGER NOT NULL
	);

	CREATE TABLE memory_snapshots (
		session_id TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		content TEXT NOT NULL,
		memory_ids TEXT NOT NULL,
		PRIMARY KEY (session_id, created_at)
	);

	CREATE TABLE memory_extraction (
		session_id TEXT PRIMARY KEY,
		message_count INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);

	CREATE TABLE proposals (
		id TEXT PRIMARY KEY,
		kind TEXT NOT NULL,
		title TEXT NOT NULL,
		payload TEXT NOT NULL,
		status TEXT NOT NULL,
		source_session TEXT,
		cwd TEXT,
		created_at INTEGER NOT NULL,
		resolved_at INTEGER
	);
	CREATE INDEX proposals_status ON proposals(status, created_at);
	`,
	// 4: tasks, the desk (notes, materials, artifacts) and limit cards. cwd_key = normalized cwd for lookups.
	`
	CREATE TABLE tasks (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		goal TEXT NOT NULL,
		cwd TEXT NOT NULL,
		cwd_key TEXT NOT NULL,
		session_file TEXT,
		source TEXT NOT NULL,
		status TEXT NOT NULL,
		note_id TEXT,
		schedule_id TEXT,
		materials TEXT NOT NULL DEFAULT '[]',
		result TEXT,
		error TEXT,
		runs INTEGER NOT NULL DEFAULT 0,
		turns INTEGER NOT NULL DEFAULT 0,
		cost REAL NOT NULL DEFAULT 0,
		duration_ms INTEGER NOT NULL DEFAULT 0,
		current_step TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		ended_at INTEGER
	);
	CREATE INDEX tasks_cwd ON tasks(cwd_key, updated_at);
	CREATE INDEX tasks_session ON tasks(session_file);
	CREATE INDEX tasks_status ON tasks(status, updated_at);
	CREATE INDEX tasks_note ON tasks(note_id);

	CREATE TABLE notes (
		id TEXT PRIMARY KEY,
		cwd TEXT NOT NULL,
		cwd_key TEXT NOT NULL,
		title TEXT NOT NULL,
		content TEXT NOT NULL DEFAULT '',
		archived INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX notes_cwd ON notes(cwd_key, updated_at);

	CREATE TABLE materials (
		id TEXT PRIMARY KEY,
		cwd TEXT NOT NULL,
		cwd_key TEXT NOT NULL,
		kind TEXT NOT NULL,
		title TEXT NOT NULL,
		path TEXT,
		content TEXT,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX materials_cwd ON materials(cwd_key, created_at);

	CREATE TABLE artifacts (
		id TEXT PRIMARY KEY,
		cwd TEXT NOT NULL,
		cwd_key TEXT NOT NULL,
		task_id TEXT,
		note_id TEXT,
		path TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		UNIQUE (task_id, path)
	);
	CREATE INDEX artifacts_cwd ON artifacts(cwd_key, updated_at);

	CREATE TABLE notices (
		id TEXT PRIMARY KEY,
		kind TEXT NOT NULL,
		title TEXT NOT NULL,
		body TEXT,
		slot_id TEXT,
		session_file TEXT,
		task_id TEXT,
		cwd TEXT,
		status TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		resolved_at INTEGER
	);
	CREATE INDEX notices_status ON notices(status, created_at);
	`,
	// 5: scheduled tasks - schedules, their runs (one per claimed trigger) and deliveries.
	`
	CREATE TABLE schedules (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		prompt TEXT NOT NULL,
		cwd TEXT NOT NULL,
		kind TEXT NOT NULL,
		trigger TEXT NOT NULL,
		missed_policy TEXT NOT NULL,
		session_mode TEXT NOT NULL,
		session_file TEXT,
		allowed_tools TEXT,
		state TEXT NOT NULL DEFAULT '{}',
		status TEXT NOT NULL,
		version INTEGER NOT NULL DEFAULT 1,
		next_run_at INTEGER,
		last_run_at INTEGER,
		pending_at INTEGER,
		created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX schedules_due ON schedules(status, next_run_at);

	CREATE TABLE schedule_runs (
		id TEXT PRIMARY KEY,
		schedule_id TEXT NOT NULL,
		trigger_key TEXT NOT NULL UNIQUE,
		version INTEGER NOT NULL,
		scheduled_at INTEGER,
		started_at INTEGER,
		ended_at INTEGER,
		manual INTEGER NOT NULL DEFAULT 0,
		catch_up INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL,
		attempt INTEGER NOT NULL DEFAULT 1,
		retry_at INTEGER,
		task_id TEXT,
		session_file TEXT,
		result TEXT,
		error TEXT,
		note TEXT,
		external_effects INTEGER NOT NULL DEFAULT 0,
		cost REAL NOT NULL DEFAULT 0
	);
	CREATE INDEX schedule_runs_schedule ON schedule_runs(schedule_id, scheduled_at);
	CREATE INDEX schedule_runs_status ON schedule_runs(status, retry_at);

	CREATE TABLE deliveries (
		id TEXT PRIMARY KEY,
		run_id TEXT NOT NULL,
		channel TEXT NOT NULL,
		status TEXT NOT NULL,
		detail TEXT,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX deliveries_run ON deliveries(run_id);
	`,
	// 6: model gateway - channels and their keys, model groups, one row per model request, last quota reading.
	`
	CREATE TABLE gateway_channels (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		platform TEXT,
		kind TEXT NOT NULL,
		api TEXT NOT NULL,
		base_url TEXT NOT NULL,
		models TEXT NOT NULL DEFAULT '[]',
		headers TEXT,
		auth_header INTEGER NOT NULL DEFAULT 0,
		enabled INTEGER NOT NULL DEFAULT 1,
		top_up REAL,
		low_balance REAL,
		sort INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE gateway_keys (
		id TEXT PRIMARY KEY,
		channel_id TEXT NOT NULL REFERENCES gateway_channels(id) ON DELETE CASCADE,
		label TEXT,
		secret TEXT NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1,
		sort INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX gateway_keys_channel ON gateway_keys(channel_id);

	CREATE TABLE gateway_groups (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		entries TEXT NOT NULL DEFAULT '[]',
		allow_paid_overflow INTEGER NOT NULL DEFAULT 1,
		sort INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE gateway_requests (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		at INTEGER NOT NULL,
		channel TEXT NOT NULL,
		key_id TEXT,
		model TEXT NOT NULL,
		group_id TEXT,
		session_id TEXT,
		ok INTEGER NOT NULL,
		error_kind TEXT,
		error TEXT,
		ttft_ms INTEGER,
		duration_ms INTEGER,
		input INTEGER NOT NULL DEFAULT 0,
		output INTEGER NOT NULL DEFAULT 0,
		cache_read INTEGER NOT NULL DEFAULT 0,
		cache_write INTEGER NOT NULL DEFAULT 0,
		cost REAL NOT NULL DEFAULT 0
	);
	CREATE INDEX gateway_requests_at ON gateway_requests(at);
	CREATE INDEX gateway_requests_channel ON gateway_requests(channel, at);

	CREATE TABLE gateway_quota (
		channel TEXT PRIMARY KEY,
		data TEXT NOT NULL,
		checked_at INTEGER NOT NULL
	);
	`,
	// 7: Showcard cards (state, desk flag, declaration epoch), their remembered grants and emitted events; image descriptions for models without vision.
	`
	CREATE TABLE cards (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		cwd TEXT,
		session_file TEXT,
		tool_call_id TEXT,
		origin TEXT NOT NULL,
		digest TEXT NOT NULL,
		epoch INTEGER NOT NULL DEFAULT 1,
		version INTEGER NOT NULL DEFAULT 1,
		state TEXT NOT NULL DEFAULT '{}',
		on_desk INTEGER NOT NULL DEFAULT 0,
		height INTEGER,
		snapshot_at INTEGER,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX cards_session ON cards(session_file);

	CREATE TABLE card_grants (
		card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
		kind TEXT NOT NULL,
		subject TEXT NOT NULL,
		epoch INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (card_id, kind, subject)
	);

	CREATE TABLE card_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		payload TEXT,
		at INTEGER NOT NULL
	);

	CREATE TABLE image_descriptions (
		hash TEXT PRIMARY KEY,
		model TEXT NOT NULL,
		text TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);
	`,
	// 8: one-off data moves done by modules (the desk moving to 蝶君).
	`
	CREATE TABLE app_flags (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		at INTEGER NOT NULL
	);
	`,
	// 9: v0.5 memory (docs/memory-design.md §2): workspaces with a stable id, memory items with
	// every version, sources, links, the op log in batches (the memory log, undoable), and
	// changes waiting for the user. The v0.2 tables stay, read-only, for one version.
	`
	CREATE TABLE workspaces (
		id TEXT PRIMARY KEY,
		path TEXT NOT NULL,
		path_key TEXT NOT NULL UNIQUE,
		global_background INTEGER NOT NULL DEFAULT 1,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE workspace_groups (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE workspace_group_members (
		group_id TEXT NOT NULL REFERENCES workspace_groups(id) ON DELETE CASCADE,
		workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		PRIMARY KEY (group_id, workspace_id)
	);

	CREATE TABLE memory_items (
		id TEXT PRIMARY KEY,
		version INTEGER NOT NULL,
		level INTEGER NOT NULL,
		kind TEXT NOT NULL,
		content TEXT NOT NULL,
		conditions TEXT,
		scope TEXT NOT NULL,
		workspace_id TEXT,
		group_id TEXT,
		confidence TEXT NOT NULL,
		status TEXT NOT NULL,
		pinned INTEGER NOT NULL DEFAULT 0,
		retention TEXT NOT NULL DEFAULT 'normal',
		auto_ok INTEGER NOT NULL DEFAULT 1,
		occurred_at INTEGER,
		valid_from INTEGER,
		valid_until INTEGER,
		last_verified_at INTEGER,
		next_review_at INTEGER,
		last_used_at INTEGER,
		use_count INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		created_by TEXT NOT NULL
	);
	CREATE INDEX memory_items_scope ON memory_items(scope, workspace_id, status);
	CREATE INDEX memory_items_status ON memory_items(status, updated_at);

	CREATE TABLE memory_versions (
		item_id TEXT NOT NULL,
		version INTEGER NOT NULL,
		snapshot TEXT NOT NULL,
		op_id TEXT,
		at INTEGER NOT NULL,
		PRIMARY KEY (item_id, version)
	);

	CREATE TABLE memory_sources (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		item_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		ref TEXT,
		excerpt TEXT,
		at INTEGER NOT NULL
	);
	CREATE INDEX memory_sources_item ON memory_sources(item_id);
	CREATE INDEX memory_sources_ref ON memory_sources(ref);

	CREATE TABLE memory_links (
		from_id TEXT NOT NULL,
		to_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		at INTEGER NOT NULL,
		PRIMARY KEY (from_id, to_id, kind)
	);
	CREATE INDEX memory_links_to ON memory_links(to_id);

	CREATE TABLE memory_batches (
		id TEXT PRIMARY KEY,
		actor TEXT NOT NULL,
		kind TEXT NOT NULL,
		reason TEXT,
		session_ref TEXT,
		cost_usd REAL NOT NULL DEFAULT 0,
		at INTEGER NOT NULL,
		undone_at INTEGER
	);

	CREATE TABLE memory_ops (
		id TEXT PRIMARY KEY,
		batch_id TEXT NOT NULL REFERENCES memory_batches(id),
		actor TEXT NOT NULL,
		kind TEXT NOT NULL,
		item_id TEXT NOT NULL,
		before_version INTEGER,
		after_version INTEGER NOT NULL,
		reason TEXT,
		inferred INTEGER NOT NULL DEFAULT 0,
		undo_of TEXT,
		at INTEGER NOT NULL,
		undone_at INTEGER
	);
	CREATE INDEX memory_ops_at ON memory_ops(at);
	CREATE INDEX memory_ops_item ON memory_ops(item_id);
	CREATE INDEX memory_ops_batch ON memory_ops(batch_id);

	CREATE TABLE memory_pending (
		id TEXT PRIMARY KEY,
		kind TEXT NOT NULL,
		item_id TEXT,
		base_version INTEGER,
		op TEXT NOT NULL,
		actor TEXT NOT NULL,
		reason TEXT,
		why TEXT NOT NULL,
		scope TEXT NOT NULL,
		workspace_id TEXT,
		session_ref TEXT,
		status TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		resolved_at INTEGER
	);
	CREATE INDEX memory_pending_status ON memory_pending(status, created_at);
	`,
];
