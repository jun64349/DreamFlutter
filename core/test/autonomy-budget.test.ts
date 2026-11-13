import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Db } from "../src/db.ts";
import { AutonomyBudget } from "../src/modules/autonomy/budget.ts";
import { SettingsStore } from "../src/settings.ts";

it("T113 autonomous spending survives restart and resets at local midnight", test => {
	const dir = mkdtempSync(join(tmpdir(), "df-t113-budget-"));
	const file = join(dir, "db.sqlite");
	let db = new Db(file);
	test.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
	let now = new Date(2026, 10, 12, 23, 59).getTime();
	const makeBudget = () => {
		const settings = new SettingsStore(db);
		return { settings, budget: new AutonomyBudget(db, () => settings.get().butterflyDailyBudget, () => now) };
	};
	const first = makeBudget();
	first.settings.update({ patrolDailyBudget: 0 });
	assert.deepEqual(first.budget.check(0.5, "chat"), { ok: true });
	first.budget.record(0.2, "observe", "hit");
	first.budget.record(0.2, "observe", "hit");
	assert.equal(first.budget.spentToday(), 0.2);
	assert.deepEqual(first.budget.check(0.31, "goal"), { ok: false, reason: "daily_cap" });
	assert.deepEqual(first.budget.check(0.3, "goal"), { ok: true });
	first.budget.record(0.35, "goal", "round");
	db.close();
	db = new Db(file);
	const next = makeBudget();
	assert.equal(next.budget.spentToday(), 0.55);
	assert.deepEqual(next.budget.check(0, "learning"), { ok: false, reason: "daily_cap" });
	now = new Date(2026, 10, 13).getTime();
	assert.equal(next.budget.spentToday(), 0);
	assert.deepEqual(next.budget.check(0.5, "skill"), { ok: true });
	next.settings.update({ butterflyDailyBudget: 0 });
	assert.deepEqual(next.budget.check(0, "chat"), { ok: false, reason: "daily_cap" });
});
