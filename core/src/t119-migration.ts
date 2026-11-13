export const T119_MIGRATION = `
	CREATE TABLE goal_selfwork (
		run_id TEXT PRIMARY KEY REFERENCES selfwork_runs(id),
		goal_id TEXT NOT NULL UNIQUE, mandate_id TEXT NOT NULL UNIQUE,
		source TEXT NOT NULL CHECK(source IN ('goal','learning','skill')),
		source_ref TEXT NOT NULL, deliverable TEXT NOT NULL,
		paused_day TEXT, delivery TEXT
	);
`;
