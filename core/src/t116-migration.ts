export const T116_MIGRATION = `
	CREATE TABLE selfwork_goals (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		instruction TEXT NOT NULL,
		revision INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		deleted_at INTEGER
	);
	CREATE TABLE selfwork_runs (
		id TEXT PRIMARY KEY,
		source TEXT NOT NULL CHECK(source IN ('goal','learning','skill')),
		long_goal_id TEXT REFERENCES selfwork_goals(id),
		long_goal_revision INTEGER,
		goal_id TEXT UNIQUE,
		state TEXT NOT NULL CHECK(state IN ('planning','testing','held','running','completed','skipped','stopped')),
		topic TEXT,
		plan TEXT,
		reason TEXT,
		started_at INTEGER NOT NULL,
		day TEXT NOT NULL,
		ended_at INTEGER
	);
	CREATE UNIQUE INDEX selfwork_single_active ON selfwork_runs ((1)) WHERE state IN ('planning','testing','running');
	CREATE INDEX selfwork_runs_schedule ON selfwork_runs (day, source, long_goal_id);
	CREATE INDEX selfwork_runs_stopped ON selfwork_runs (topic, ended_at) WHERE state='stopped';
	CREATE TABLE selfwork_skills (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL COLLATE NOCASE UNIQUE,
		active_version INTEGER NOT NULL,
		adopted_version INTEGER,
		deleted_at INTEGER
	);
	CREATE TABLE selfwork_skill_versions (
		skill_id TEXT NOT NULL REFERENCES selfwork_skills(id),
		version INTEGER NOT NULL,
		source_ref TEXT NOT NULL REFERENCES selfwork_runs(id),
		description TEXT NOT NULL,
		content TEXT NOT NULL,
		tested_at INTEGER NOT NULL,
		PRIMARY KEY (skill_id, version)
	);
`;
