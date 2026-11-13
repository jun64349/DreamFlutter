import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { AutonomyModule } from "../src/modules/autonomy/index.ts";
import { startTestCore } from "./harness.ts";

it("T115 autonomy startup recovery leaves an in-flight chat reservation with its owner", async test => {
	// Trigger exactly the first recovery tick after reserving, independent of startup speed.
	test.mock.method(AutonomyModule.prototype, "start", () => {});
	const t = await startTestCore();
	test.after(() => t.cleanup());
	const { autonomy } = t.core;
	assert.equal(autonomy.budget.reserve(0.4, "chat", "draft"), true);
	// Core has started, but the first autonomy tick has not yet reconciled holds.
	await autonomy.tick();
	assert.deepEqual(autonomy.budget.check(0.2, "goal"), { ok: false, reason: "daily_cap" });
	assert.equal(autonomy.budget.settle("chat", "draft", 0.35), 0.35);
	assert.equal(autonomy.budget.spentToday(), 0.35);
});

it("T115 a new folder records a baseline and detects additions and edits across restart", async test => {
	let t = await startTestCore();
	test.after(() => t.cleanup());
	const folder = join(t.dir, "watch");
	mkdirSync(folder);
	const older = join(folder, "older.txt");
	writeFileSync(older, "existed at registration");
	t.core.settings.update({ autonomyFolders: [folder] });
	const count = () => t.core.db.get<{ n: number }>("SELECT count(*) n FROM autonomy_events WHERE source='folder'")!.n;
	await t.core.autonomy.scan();
	assert.equal(count(), 0);
	t = await t.reopen();
	writeFileSync(older, "edited after restart");
	writeFileSync(join(folder, "new.txt"), "new");
	await t.core.autonomy.scan();
	assert.equal(count(), 2);
	await t.core.autonomy.scan();
	assert.equal(count(), 2);
	t.core.settings.update({ autonomyFolders: [] });
	writeFileSync(join(folder, "while-off.txt"), "already there when re-added");
	t.core.settings.update({ autonomyFolders: [folder] });
	await t.core.autonomy.scan();
	assert.equal(count(), 2);
});
