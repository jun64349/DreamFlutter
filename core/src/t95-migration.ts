import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Db } from "./db.ts";
import { SANDBOX_ENTRY } from "./pi/host.ts";
import { readSessionEntries } from "./pi/session-metadata.ts";

const BACKFILL = "t95_schedule_owner_backfill";

export const T95_MIGRATION = `
	ALTER TABLE schedules ADD COLUMN owner TEXT NOT NULL DEFAULT 'workbench' CHECK (owner IN ('workbench', 'butterfly'));
	INSERT INTO app_flags(key, value, at) VALUES ('${BACKFILL}', 'pending', 0);
`;

export function scheduleOwner(home: string, cwd: string, sessionFile: string | null): "workbench" | "butterfly" {
	const path = relative(resolve(home).toLowerCase(), resolve(cwd).toLowerCase());
	if (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) return "butterfly";
	if (sessionFile && existsSync(sessionFile)) {
		try {
			if (readSessionEntries(sessionFile).some(entry => entry.type === "custom" && entry.customType === SANDBOX_ENTRY)) return "butterfly";
		} catch {
			// An unreadable bound session cannot be executed. Leave its binding intact.
		}
	}
	return "workbench";
}

/** The installation's home and the session files are available when the scheduler is assembled. */
export function backfillScheduleOwners(db: Db, home: string): void {
	if (!db.get("SELECT 1 FROM app_flags WHERE key = ?", BACKFILL)) return;
	db.transaction(() => {
		const rows = db.all<{ id: string; cwd: string; session_mode: string; session_file: string | null }>("SELECT id, cwd, session_mode, session_file FROM schedules");
		for (const row of rows) {
			const owner = scheduleOwner(home, row.cwd, row.session_mode === "bound" ? row.session_file : null);
			db.run("UPDATE schedules SET owner = ? WHERE id = ?", owner, row.id);
		}
		db.run("DELETE FROM app_flags WHERE key = ?", BACKFILL);
	});
}
