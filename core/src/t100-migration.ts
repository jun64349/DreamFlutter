export const T100_MIGRATION = `
	CREATE TABLE session_seen (
		session_key TEXT PRIMARY KEY,
		seen_at INTEGER NOT NULL
	);
	CREATE TABLE patrol_reported (
		fact_key TEXT PRIMARY KEY
	);
	INSERT OR IGNORE INTO patrol_reported(fact_key)
	SELECT 'watch_due:' || w.id
	FROM watch_items w
	WHERE EXISTS (
		SELECT 1 FROM patrol_runs p, json_each(p.new_facts) f
		WHERE json_extract(f.value, '$.key') LIKE 'watch:' || w.id || ':until:%'
	);
`;
