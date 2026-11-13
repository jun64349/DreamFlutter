import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { AutonomyBudget } from "../src/modules/autonomy/budget.ts";
import { GoalsModule } from "../src/modules/goals.ts";
import { selfworkDeliverable, type SelfworkDraft } from "../src/modules/goals/selfwork.ts";
import { SelfworkModule } from "../src/modules/selfwork/index.ts";
import { corePaths } from "../src/paths.ts";
import { MIGRATIONS } from "../src/schema.ts";
import { T119_MIGRATION } from "../src/t119-migration.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

const DAY = 86_400_000;
const explanation = "已经把可验证结论写入约定文件。";
const plan = { action: "proceed", topic: "查验指标", title: "指标笔记", instruction: "写下这次查验的结论", share: true, external: false };
const legacyParent = { id: "legacy-parent", revision: 1 };
type Run = { id: string; source: string; state: string; goal_id: string | null; reason: string | null };

async function fixture(test: TestContext, legacy = false) {
	let at = new Date(2026, 10, 12, 12).getTime();
	const options = { selfwork: { clock: () => at }, personaClock: () => at };
	let t = await startTestCore(legacy ? priorDatabase(at) : undefined, options);
	test.after(() => t.cleanup());
	const local = (logical: string) => join(t.dir, "sandbox", logical.slice("/workspace/".length));
	function configure() {
		t.core.sandboxProvider = () => ({ distro: "df-test-t119", ready: async () => {}, online: () => false });
		t.core.autonomy.sandboxFile = async path => local(path);
		Object.defineProperty(t.core.autonomy, "budget", { value: new AutonomyBudget(t.core.db, () => t.core.settings.get().butterflyDailyBudget, () => at) });
		const resolve = t.core.resolveModel;
		t.core.resolveModel = model => {
			const m = resolve(model);
			return m.provider === "faux" ? { ...m, cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } } : m;
		};
		t.core.settings.update({ butterflyProactivity: "high", patrolQuietEnabled: false });
	}
	configure();
	return {
		get t() { return t; }, get module() { return t.core.module(SelfworkModule)!; },
		get goals() { return t.core.module(GoalsModule)!; },
		local,
		now: () => at,
		tomorrow() { at += DAY; },
		later() { at += 16 * 60_000; },
		async restart() { t = await t.reopen(); configure(); return t; },
		run(id: string) { return t.core.db.get<Run>("SELECT * FROM selfwork_runs WHERE id=?", id)!; },
		longGoal: () => t.core.call("selfwork.longGoals.save", { title: "积累指标经验", instruction: "整理长期图表记录" }, t.client) as Promise<{ id: string; revision: number }>,
		held(id: string, source: "goal" | "learning" | "skill", parent?: { id: string; revision: number }) {
			t.core.db.run(`INSERT INTO selfwork_runs(id,source,long_goal_id,long_goal_revision,state,plan,reason,started_at,day)
				VALUES(?,?,?,?,'held',?,'goal_api_unavailable',?,'legacy')`,
			id, source, parent?.id ?? null, parent?.revision ?? null, JSON.stringify(plan), at);
		},
		draft(id: string, source: "goal" | "learning" | "skill", parent?: { id: string; revision: number }): SelfworkDraft {
			return { refId: id, source, title: plan.title, instruction: plan.instruction, sandbox: true, cwd: t.core.paths.butterflyDir,
				deliverable: selfworkDeliverable(id), mandateRef: parent ? `long-goal:${parent.id}@${parent.revision}` :
					source === "skill" ? `selfwork-skill:${id}` : `idle-learning:${id}` };
		},
	};
}

function priorDatabase(at: number): string {
	const dir = mkdtempSync(join(tmpdir(), "df-t119-upgrade-"));
	const file = corePaths(join(dir, "data")).dbFile;
	mkdirSync(dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	try {
		const version = MIGRATIONS.indexOf(T119_MIGRATION);
		assert.ok(version > 0);
		for (const migration of MIGRATIONS.slice(0, version)) db.exec(migration);
		db.exec(`PRAGMA user_version=${version}`);
		db.prepare("INSERT INTO selfwork_goals VALUES(?,?,?,1,?,?,NULL)").run(legacyParent.id, "旧长期目标", "保存已有草案", at, at);
		for (const id of ["first", "second"]) {
			db.prepare(`INSERT INTO selfwork_runs(id,source,long_goal_id,long_goal_revision,state,plan,reason,started_at,day)
				VALUES(?,'goal',?,1,'held',?,'goal_api_unavailable',?,'legacy')`).run(id, legacyParent.id, JSON.stringify(plan), at);
		}
	} finally { db.close(); }
	return dir;
}

const done = () => fauxAssistantMessage([fauxToolCall("goal_report", { status: "done", note: explanation })]);
function put(path: string, data: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); }

it("T119 executes a real learning goal, pauses at the cap and resumes on the next local day", async test => {
	const s = await fixture(test), { t } = s;
	s.goals.executor.stop();
	s.held("learning-plan", "learning");
	s.later();
	await s.module.tick();
	const id = s.run("learning-plan").goal_id!;
	assert.ok(id);
	await t.waitFor(() => s.goals.scheduler.get(id));
	const file = s.local(selfworkDeliverable("learning-plan"));
	// Another billable activity fills the shared budget between acceptance and the request.
	t.core.autonomy.budget.record(0.5, "chat", "earlier");
	s.goals.executor.start();
	await t.waitFor(() => s.goals.scheduler.get(id)?.reason === "autonomy_budget");
	assert.equal(t.faux.state.callCount, 0);
	const restarted = await s.restart();
	await s.module.tick();
	assert.equal(s.goals.scheduler.get(id)?.reason, "autonomy_budget");
	assert.equal(s.run("learning-plan").state, "running");
	assert.equal(restarted.faux.state.callCount, 0);
	put(file, "可验收的学习报告");
	restarted.respond(done(), fauxAssistantMessage("已核对"));
	s.tomorrow();
	await restarted.waitFor(() => s.goals.scheduler.get(id)?.status === "completed", 10_000);
	const charges = restarted.core.db.all<{ source: string; cost_usd: number }>(`SELECT source,cost_usd FROM autonomy_spending
		WHERE ref_id IN (SELECT id FROM goal_ledger WHERE goal_id=?)`, id);
	assert.equal(charges.length, 2);
	assert.ok(charges.every(row => row.source === "learning" && row.cost_usd > 0));
	assert.equal(s.goals.scheduler.detail(id).selfwork?.delivery?.explanation, explanation);
});

it("T119 the goal service meters a trusted skill plan under skill", { timeout: 30_000 }, async test => {
	const s = await fixture(test), { t } = s;
	t.core.db.run(`INSERT INTO selfwork_runs(id,source,state,plan,started_at,day)
		VALUES('skill-plan','skill','planning',?,?,'skill-fixture')`, JSON.stringify({ ...plan, share: false }), s.now());
	put(s.local(selfworkDeliverable("skill-plan")), "技能研究记录");
	t.respond(done(), fauxAssistantMessage("已核对"));
	const id = s.goals.scheduler.launchSelfwork(s.draft("skill-plan", "skill"));
	let finish!: (status: string) => void;
	const terminal = new Promise<string>(resolve => { finish = resolve; });
	const unsubscribe = t.core.onBroadcast(message => {
		if (message.event === "goals.changed" && message.id === id && typeof message.status === "string" &&
			["completed", "failed", "cancelled", "paused", "blocked", "waiting_user"].includes(message.status)) finish(message.status);
	});
	// The executor timer is unref'ed. Keep Node alive while its events drive the assertion.
	const keepAlive = setInterval(() => {}, 60_000);
	try {
		await t.core.autonomy.tick();
		const status = await terminal;
		assert.equal(status, "completed", JSON.stringify(s.goals.scheduler.get(id)));
	} finally {
		clearInterval(keepAlive);
		unsubscribe();
	}
	const charges = t.core.db.all<{ source: string }>(`SELECT source FROM autonomy_spending
		WHERE ref_id IN (SELECT id FROM goal_ledger WHERE goal_id=?)`, id);
	assert.deepEqual(charges.map(row => row.source), ["skill", "skill"]);
});

for (const revoke of ["proactivity", "daily_cap", "edit", "delete"] as const) {
	it(`T119 ${revoke} prevents the next protected operation`, async test => {
		const s = await fixture(test), { t } = s;
		s.goals.executor.stop();
		const parent = await s.longGoal();
		s.held("work-plan", "goal", parent);
		await s.module.tick();
		const id = s.run("work-plan").goal_id!;
		await t.waitFor(() => t.core.db.get("SELECT 1 FROM goal_intents WHERE goal_id=? AND action='run'", id));
		const file = selfworkDeliverable("work-plan");
		let called = false;
		t.respond(async () => {
			called = true;
			if (revoke === "proactivity") t.core.settings.update({ butterflyProactivity: "low" });
			if (revoke === "daily_cap") t.core.settings.update({ butterflyDailyBudget: 0 });
			// Change the stored parent without its RPC callback to exercise the goal's own boundary.
			if (revoke === "edit") t.core.db.run("UPDATE selfwork_goals SET revision=revision+1 WHERE id=?", parent.id);
			if (revoke === "delete") t.core.db.run("UPDATE selfwork_goals SET deleted_at=? WHERE id=?", Date.now(), parent.id);
			return fauxAssistantMessage([fauxToolCall("write", { file_path: file, content: "禁止的写入" })]);
		});
		s.goals.executor.start();
		const paused = await t.waitFor(() => {
			const goal = s.goals.scheduler.get(id);
			return goal?.status === "paused" && goal;
		});
		assert.equal(called, true);
		assert.equal(paused.reason, "needs_permission");
		assert.match(paused.resumeWhen ?? "", revoke === "proactivity" ? /档位/ : revoke === "daily_cap" ? /额度.*0/ : /长期目标/);
		assert.equal(t.core.db.get("SELECT 1 FROM autonomy_effects WHERE kind='deliver'"), undefined);
	});
}

it("T119 checks the promised file and hands a durable result to memory and proactive chat only once", async test => {
	const s = await fixture(test), { t } = s;
	const slot = await t.core.openSlot({ cwd: t.core.paths.butterflyDir, sandbox: true, client: t.client });
	t.respond(fauxAssistantMessage("收到"));
	await t.send(slot.slotId, { type: "prompt", id: "ordinary", message: "你好" });
	await t.waitFor(() => settledCount(t.records(slot.slotId)) === 1);
	await t.waitFor(() => !slot.running);
	const parent = await s.longGoal();
	// Run the actual T116 planner, then the actual goal executor, with a scripted provider.
	t.respond(fauxAssistantMessage(JSON.stringify(plan)), done(), fauxAssistantMessage("先核对"),
		() => {
			const work = t.core.db.get<Run>("SELECT * FROM selfwork_runs WHERE long_goal_id=?", parent.id)!;
			put(s.local(selfworkDeliverable(work.id)), "已经生成");
			return done();
		},
		fauxAssistantMessage("验收通过"), fauxAssistantMessage("图表笔记整理好了。"));
	await s.module.tick();
	const run = t.core.db.get<Run>("SELECT * FROM selfwork_runs WHERE long_goal_id=?", parent.id)!;
	const id = run.goal_id!;
	await t.waitFor(() => s.run(run.id).state === "completed", 15_000);
	assert.equal(s.goals.scheduler.detail(id).selfwork?.delivery?.files[0], selfworkDeliverable(run.id));
	assert.equal(readFileSync(s.local(selfworkDeliverable(run.id)), "utf8"), "已经生成");
	assert.equal(t.core.db.get("SELECT 1 FROM goal_reviews WHERE goal_id=? AND layer='model'", id), undefined);
	assert.ok(t.core.db.get("SELECT 1 FROM goal_reviews WHERE goal_id=? AND layer='program' AND verdict='continue'", id));
	await t.waitFor(() => t.core.db.get("SELECT 1 FROM butterfly_proactive WHERE ref_id=? AND state='sent'", `selfwork:${run.id}`));
	const counts = (core: TestCore) => [
		core.core.db.get<{ n: number }>("SELECT count(*) n FROM memory_sources WHERE ref=? AND kind='work'", id)!.n,
		core.core.db.get<{ n: number }>("SELECT count(*) n FROM butterfly_proactive WHERE ref_id=? AND state='sent'", `selfwork:${run.id}`)!.n,
	];
	assert.deepEqual(counts(t), [1, 1]);
	const next = await s.restart();
	await s.module.tick();
	assert.deepEqual(counts(next), [1, 1]);
	assert.equal(next.faux.state.callCount, 0);
});

it("T119 persisted drafts survive acceptance and restart exactly once, with user goals taking priority", async test => {
	const s = await fixture(test, true), { t } = s;
	const parent = legacyParent;
	assert.equal(t.core.db.get<{ user_version: number }>("PRAGMA user_version")?.user_version, MIGRATIONS.length);
	const draft = s.draft("first", "goal", parent);
	assert.throws(() => s.goals.scheduler.launchSelfwork({ ...draft, source: "skill" }), /可信来源/);
	await s.module.tick();
	const id = s.run("first").goal_id!;
	assert.ok(id);
	assert.equal(s.goals.scheduler.launchSelfwork(draft), id);
	assert.throws(() => s.goals.scheduler.launchSelfwork(s.draft("second", "goal", parent)), /UNIQUE/);
	assert.equal(s.run("second").state, "held");
	s.goals.executor.stop();
	const next = await s.restart();
	s.goals.executor.stop();
	await s.module.tick();
	await next.waitFor(() => s.goals.scheduler.get(id));
	assert.equal(s.run("first").goal_id, id);
	assert.equal(s.run("second").goal_id, null);
	assert.equal(next.core.db.get<{ n: number }>("SELECT count(*) n FROM goal_selfwork")?.n, 1);
	s.goals.scheduler.create({ title: "用户优先", originText: "用户的事", mandateRef: "user:t119",
		scope: { cwd: next.core.paths.butterflyDir, partition: "butterfly", sandbox: true }, spec: { objective: "用户的事" } });
	assert.equal(s.goals.scheduler.selfworkCanRun(id), false);
	assert.equal(next.faux.state.callCount, 0);
});
