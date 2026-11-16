import assert from "node:assert/strict";
import { it } from "node:test";
import { SelfworkModule } from "../src/modules/selfwork/index.ts";
import { startTestCore } from "./harness.ts";

it("disabling a long goal leaves its current plan alive and excludes it from later selection", async () => {
	const t = await startTestCore();
	try {
		t.core.sandboxProvider = () => ({ distro: "fixture", ready: async () => {}, online: () => false });
		t.core.settings.update({ butterflyProactivity: "high", butterflyDailyBudget: 1 });
		const goal = await t.core.call("selfwork.longGoals.save", { title: "学习", instruction: "记笔记" }, t.client) as { id: string; revision: number; enabled: boolean };
		assert.equal(goal.enabled, true);
		const at = Date.now();
		t.core.db.run(`INSERT INTO selfwork_runs(id,source,long_goal_id,long_goal_revision,state,started_at,day)
			VALUES('current','goal',?,?,'planning',?,'2026-11-13')`, goal.id, goal.revision, at);
		const disabled = await t.core.call("selfwork.longGoals.setEnabled", { id: goal.id, enabled: false, revision: goal.revision }, t.client) as { enabled: boolean; revision: number; lastStudiedAt: number | null; noteCount: number | null };
		assert.equal(disabled.enabled, false);
		assert.equal(disabled.noteCount, null);
		const current = t.core.db.get<{ state: string; long_goal_revision: number }>("SELECT state,long_goal_revision FROM selfwork_runs WHERE id='current'")!;
		assert.equal(current.state, "planning");
		assert.equal(current.long_goal_revision, disabled.revision);
		t.core.db.run("UPDATE selfwork_runs SET state='completed',ended_at=? WHERE id='current'", at + 1);
		const [listed] = await t.core.call("selfwork.longGoals.list", {}) as Array<{ lastStudiedAt: number }>;
		assert.equal(listed!.lastStudiedAt, at + 1);
		await t.core.module(SelfworkModule)!.tick();
		assert.equal(t.core.db.get("SELECT 1 FROM selfwork_runs WHERE source='goal' AND id<>'current'"), undefined);
	} finally { await t.cleanup(); }
});
