import type { Db } from "./db.ts";

const BACKFILL = "t96_schedule_creator_backfill";

export const T96_MIGRATION = `
	ALTER TABLE schedules ADD COLUMN created_role TEXT NOT NULL DEFAULT 'user'
		CHECK (created_role IN ('user', 'butterfly', 'patrol'));
	UPDATE schedules SET created_role = 'butterfly' WHERE created_by = 'agent' AND owner = 'butterfly';
	INSERT INTO app_flags(key, value, at) VALUES ('${BACKFILL}', 'pending', 0);

	CREATE TABLE schedule_changes (
		id TEXT PRIMARY KEY,
		schedule_id TEXT NOT NULL,
		version_before INTEGER NOT NULL,
		version_after INTEGER NOT NULL,
		actor TEXT NOT NULL CHECK (actor IN ('user', 'butterfly', 'patrol')),
		reason TEXT NOT NULL,
		before TEXT,
		after TEXT,
		summary TEXT NOT NULL,
		at INTEGER NOT NULL,
		undone_at INTEGER,
		status TEXT NOT NULL CHECK (status IN ('applied', 'proposed', 'rejected'))
	);
	CREATE INDEX schedule_changes_history ON schedule_changes(schedule_id, at DESC);
	CREATE INDEX schedule_changes_proposed ON schedule_changes(at DESC) WHERE status = 'proposed';
	CREATE INDEX schedule_runs_calendar ON schedule_runs(scheduled_at);
`;

/** T-95 can discover additional owners once the saved session files are available. */
export function backfillScheduleCreators(db: Db): void {
	if (!db.get("SELECT 1 FROM app_flags WHERE key = ?", BACKFILL)) return;
	db.transaction(() => {
		db.run("UPDATE schedules SET created_role = 'butterfly' WHERE created_by = 'agent' AND owner = 'butterfly'");
		db.run("DELETE FROM app_flags WHERE key = ?", BACKFILL);
	});
}
