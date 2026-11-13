import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { applyPendingRestore } from "../src/backup/switch.ts";
import { Db } from "../src/db.ts";
import type { Goal } from "../src/modules/goals/types.ts";
import { locator } from "../src/modules/library-registry.ts";
import { SelfworkModule, type GoalDraft, type SelfworkGoalService } from "../src/modules/selfwork/index.ts";
import type { TrialRunner } from "../src/modules/skill-trial.ts";
import { startTestCore, type TestCore } from "./harness.ts";

const minute = 60_000, day = 24 * 60 * minute;
type GoalStatus = Pick<Goal, "status" | "reason" | "stopIntent">;

class GoalPort implements SelfworkGoalService {
	readonly calls: { id: string; draft: GoalDraft; authorize: () => boolean }[] = [];
	readonly statuses = new Map<string, GoalStatus>();
	launch(draft: GoalDraft, authorize: () => boolean): string {
		assert.equal(authorize(), true);
		const id = `fake-goal-${this.calls.length + 1}`;
		this.calls.push({ id, draft, authorize });
		this.statuses.set(id, { status: "running", reason: null, stopIntent: null });
		return id;
	}
	get(id: string) { return this.statuses.get(id); }
	pause(id: string): void { this.statuses.set(id, { status: "paused", reason: "user_paused", stopIntent: "pause" }); }
	complete(id: string): void { this.statuses.set(id, { status: "completed", reason: null, stopIntent: null }); }
}

interface History {
	id: string; source: string; state: string; reason: string | null; topic: string | null; goal_id: string | null;
}
interface Skill { id: string; name: string; source: string; active_version: number; adopted_version: number | null; versions: { version: number; source_ref: string }[] }
let t: TestCore;
let at: number;
let module: SelfworkModule;

function configure(): void {
	t.core.sandboxProvider = () => ({ distro: "df-test-selfwork", ready: async () => {}, online: () => false });
	const resolve = t.core.resolveModel;
	t.core.resolveModel = model => {
		const resolved = resolve(model);
		return resolved.provider === "faux" ? { ...resolved, cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } } : resolved;
	};
	module = t.core.module(SelfworkModule)!;
}

async function setup(goalService?: SelfworkGoalService | null, trialRunner?: TrialRunner): Promise<void> {
	at = Date.now();
	t = await startTestCore(undefined, { selfwork: { clock: () => at, goalService, trialRunner } });
	configure();
	await t.core.autonomy.tick();
}

afterEach(async () => { await t?.cleanup(); });

function user(method: string, params: Record<string, unknown> = {}) { return t.core.call(method, params, t.client); }
function longGoal() {
	return user("selfwork.longGoals.save", { title: "整理图表笔记", instruction: "持续积累数据可视化的经验" }) as Promise<{ id: string; revision: number }>;
}
async function history(): Promise<History[]> { return t.core.call("selfwork.history", {}) as Promise<History[]>; }
async function skills(): Promise<Skill[]> { return t.core.call("selfwork.skills.list", {}) as Promise<Skill[]>; }

const standard = { action: "proceed", topic: "读取表格", title: "表格概览", instruction: "把结论写成 Markdown", share: false };
const skillDraft = { name: "fixture-chart-summary", description: "把图表要点提炼成短摘要", body: "## 步骤\n\n记录图表标题、坐标和主要趋势。" };
function respond(plan: object = standard): void { t.respond(fauxAssistantMessage(JSON.stringify(plan))); }
function respondSkill(change = {}): void { respond({ ...standard, topic: "总结图表", skill: { ...skillDraft, ...change } }); }

function charges(): { source: string; ref_id: string; cost_usd: number }[] {
	return t.core.db.all("SELECT source,ref_id,cost_usd FROM autonomy_spending ORDER BY rowid");
}

it("protects long goals with user RPCs and revision checks and holds production plans without the required Goal API", async () => {
	await setup(null);
	await assert.rejects(t.core.call("selfwork.longGoals.save", { title: "别人的目标", instruction: "写入" }), /由用户/);
	const created = await longGoal();
	const next = await user("selfwork.longGoals.save", { ...created, title: "新标题", instruction: "保留有用的学习经验" }) as { revision: number };
	assert.equal(next.revision, 2);
	await assert.rejects(user("selfwork.longGoals.save", { ...created, title: "旧值", instruction: "不能覆写" }), /已经变化/);
	t.core.settings.update({ butterflyProactivity: "mid" });
	respond();
	await module.tick();
	const [run] = await history();
	assert.equal(run?.state, "held");
	assert.equal(run.reason, "goal_api_unavailable");
	assert.equal(t.core.db.get("SELECT 1 FROM goals"), undefined);
	assert.equal(charges()[0]?.ref_id, run.id);
	assert.equal(charges()[0]?.source, "goal");
	assert.ok(charges()[0]!.cost_usd > 0);
	at += day;
	await module.tick();
	assert.equal(t.faux.state.callCount, 1, "a known missing interface must not spend again on the same mandate");
	await user("selfwork.longGoals.delete", { id: created.id });
	assert.deepEqual(await user("selfwork.longGoals.list"), []);
});

it("checks both gates, runs only one small goal, and lets a new user conversation take priority", async () => {
	const port = new GoalPort();
	await setup(port);
	const goal = await longGoal();
	t.core.settings.update({ butterflyProactivity: "low" });
	await module.tick();
	assert.deepEqual(await history(), []);
	t.core.settings.update({ butterflyProactivity: "mid", butterflyDailyBudget: 0 });
	await module.tick();
	assert.equal(t.faux.state.callCount, 0);
	t.core.settings.update({ butterflyDailyBudget: 0.5 });
	respond();
	await Promise.all([module.tick(), module.tick(), module.tick()]);
	const launched = port.calls[0]!;
	assert.equal(port.calls.length, 1);
	assert.equal(launched.draft.mandateRef, `long-goal:${goal.id}@1`);
	assert.equal(launched.draft.sandbox, true);
	assert.equal(launched.draft.cwd, t.core.paths.butterflyDir);
	assert.match(launched.draft.deliverable, /^\/workspace\/outbox\/selfwork-.+\.md$/);
	assert.deepEqual(charges().map(c => c.source), ["goal"]);
	const slot = await t.core.openSlot({ cwd: t.core.paths.butterflyDir, sandbox: true, client: t.client });
	let release!: () => void;
	const busy = new Promise<void>(resolve => { release = resolve; });
	t.respond(async () => { await busy; return fauxAssistantMessage("现在处理你交代的事。"); });
	try {
		await slot.prompt("请把我交代的内容先整理一下");
		await t.waitFor(() => port.get(launched.id)?.status === "paused");
		assert.equal((await history())[0]?.reason, "user_priority");
		assert.equal(launched.authorize(), false);
		at += day;
		await module.tick();
		assert.equal(port.calls.length, 1);
	} finally { release(); }
	await t.waitFor(() => !slot.running);
});

it("rechecks authorization on downgrade and zero budget, and honors stopped topics across restart", async () => {
	const port = new GoalPort();
	await setup(port);
	await longGoal();
	t.core.settings.update({ butterflyProactivity: "mid" });
	respond();
	await module.tick();
	const first = port.calls[0]!;
	t.core.settings.update({ butterflyProactivity: "low" });
	assert.equal(first.authorize(), false);
	assert.equal(port.get(first.id)?.status, "paused");
	assert.equal((await history())[0]?.reason, "proactivity");
	at += day;
	t.core.settings.update({ butterflyProactivity: "mid" });
	respond();
	await module.tick();
	const second = port.calls[1]!;
	t.core.settings.update({ butterflyDailyBudget: 0 });
	assert.equal(second.authorize(), false);
	assert.equal((await history())[0]?.reason, "daily_cap");
	at += day;
	t.core.settings.update({ butterflyDailyBudget: 0.5 });
	respond();
	await module.tick();
	const stopped = (await history())[0]!;
	await user("selfwork.stop", { id: stopped.id });
	assert.equal(port.get(stopped.goal_id!)?.status, "paused");
	t = await t.reopen();
	configure();
	assert.equal(port.calls.length, 3);
	at += day;
	respond({ ...standard, topic: "读 取·表格" });
	await module.tick();
	assert.equal(port.calls.length, 3);
	assert.equal((await history())[0]?.reason, "stopped_topic");
	at += 8 * day;
	respond();
	await module.tick();
	assert.equal(port.calls.length, 4);
});

it("requires sustained idle in high before learning and records the goal outcome with its real source id", async () => {
	const port = new GoalPort();
	await setup(port);
	await longGoal();
	t.core.settings.update({ butterflyProactivity: "mid" });
	respond();
	await module.tick();
	const [work] = port.calls;
	port.complete(work!.id);
	await module.tick();
	assert.equal(port.calls.length, 1);
	assert.ok(t.core.db.get("SELECT 1 FROM memory_sources WHERE kind='work' AND ref=?", work!.id));
	t.core.settings.update({ butterflyProactivity: "high" });
	at += 14 * minute;
	await module.tick();
	assert.equal(port.calls.length, 1);
	at += 2 * minute;
	respond({ ...standard, title: "图表研究方法" });
	await module.tick();
	const learned = port.calls[1]!;
	assert.equal(learned.draft.source, "learning");
	assert.match(learned.draft.mandateRef, /^idle-learning:/);
	port.complete(learned.id);
	t.core.settings.update({ butterflyProactivity: "mid" });
	await module.tick();
	assert.ok(t.core.db.get("SELECT 1 FROM memory_sources WHERE kind='learning' AND ref=?", learned.id));
	assert.deepEqual(charges().map(c => c.source), ["goal", "learning"]);
});

it("holds a plan that needs the outside and routes only a question through the proactive entry", async () => {
	const port = new GoalPort();
	await setup(port);
	await longGoal();
	const chats: { reason: string; refId: string }[] = [];
	t.core.persona.proactive.request = async input => { chats.push(input); return { ok: false, reason: "quiet_hours" }; };
	respond({ ...standard, action: "external", title: "查看沙箱外的表格" });
	await module.tick();
	assert.equal(port.calls.length, 0);
	assert.equal((await history())[0]?.reason, "external_needs_user");
	assert.equal(chats.length, 1);
	assert.match(chats[0]!.reason, /另行授权.*查看沙箱外的表格/);
});

it("tests the exact skill bytes in the sandbox before registration, and supports private use, adoption, versions and deletion", async () => {
	const testInputs: string[] = [];
	const runner: TrialRunner = async (distro, input) => {
		assert.equal(distro, "df-test-selfwork");
		const data = JSON.parse(input);
		assert.equal(data.script, "check.py");
		assert.match(Buffer.from(data.files["check.py"], "base64").toString(), /hashlib.sha256/);
		const markdown = Buffer.from(data.files["SKILL.md"], "base64").toString();
		testInputs.push(markdown);
		return { code: 0, stderr: "", stdout: JSON.stringify({ ok: testInputs.length !== 1, exitCode: testInputs.length === 1 ? 1 : 0,
			runtime: "butterfly-sandbox", stdout: testInputs.length === 1 ? "" : "skill-document-ok\n" }) };
	};
	await setup(null, runner);
	await longGoal();
	at += 16 * minute;
	respond();
	await module.tick(); // Long-term plan held by missing production Goal API.
	respond();
	await module.tick(); // Idle learning plan held by the same interface.
	respondSkill();
	await module.tick();
	assert.equal((await history())[0]?.reason, "skill_trial_failed");
	assert.deepEqual(await skills(), []);
	at += day;
	respondSkill();
	await module.tick();
	const [skill] = await skills();
	assert.equal(skill?.source, "butterfly_self");
	assert.equal(skill.active_version, 1);
	assert.equal(skill.adopted_version, null);
	assert.match(testInputs[1]!, /主要趋势/);
	assert.equal(charges().filter(c => c.source === "skill").length, 2);
	const open = async (sandbox: boolean) => {
		const slot = await t.core.openSlot({ cwd: sandbox ? t.core.paths.butterflyDir : t.workspace, sandbox, client: t.client });
		try { return slot.session.resourceLoader.getSkills().skills.find(item => item.name === skillDraft.name); }
		finally { await t.core.closeSlot(slot.slotId); }
	};
	const privateSkill = await open(true);
	assert.ok(privateSkill);
	assert.equal(t.core.library.get("skill", locator(privateSkill.filePath)).sourceKind, "butterfly_self");
	assert.equal(await open(false), undefined);
	await assert.rejects(t.core.call("selfwork.skills.adopt", { id: skill.id }), /由用户/);
	await user("selfwork.skills.adopt", { id: skill.id, cwd: t.workspace });
	assert.ok(await open(false));
	at += day;
	respondSkill({ body: "## 步骤\n\n核对图例和单位，再提炼趋势。" });
	await module.tick();
	assert.equal((await skills())[0]?.active_version, 2);
	assert.equal((await skills())[0]?.adopted_version, 1);
	await user("selfwork.skills.rollback", { id: skill.id, version: 1 });
	assert.equal((await skills())[0]?.active_version, 1);
	assert.equal((await skills())[0]?.versions.length, 2);
	await user("selfwork.skills.delete", { id: skill.id });
	assert.equal(existsSync(privateSkill.filePath), false);
	assert.equal(await open(true), undefined);
	assert.equal(await open(false), undefined);
	assert.deepEqual(await skills(), []);
});

it("rejects built-in and user name conflicts before a sandbox trial", async () => {
	let calls = 0;
	await setup(null, async () => { calls++; return { code: 1, stdout: "", stderr: "" }; });
	await longGoal();
	at += 16 * minute;
	respond(); await module.tick();
	respond(); await module.tick();
	const catalog = await t.core.call("skills.list", { cwd: t.workspace }) as { name: string; scope: string }[];
	const builtin = catalog.find(item => item.scope === "builtin" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(item.name));
	assert.ok(builtin);
	respondSkill({ name: builtin.name }); await module.tick();
	assert.equal((await history())[0]?.reason, "skill_name_taken");
	const folder = join(t.agentDir, "skills", skillDraft.name);
	mkdirSync(folder, { recursive: true });
	const file = join(folder, "SKILL.md");
	const original = `---\nname: ${skillDraft.name}\ndescription: Existing user skill\n---\nOriginal\n`;
	writeFileSync(file, original);
	at += day;
	respondSkill(); await module.tick();
	assert.equal((await history())[0]?.reason, "skill_name_taken");
	assert.equal(calls, 0);
	assert.deepEqual(await skills(), []);
});

it("includes long goals and a held run in an actual backup and restore", async () => {
	await setup(null);
	await longGoal();
	respond();
	await module.tick();
	const out = join(t.dir, "t116.dfbackup");
	type Job = { id: string; status: string };
	async function job(core: TestCore, method: string, params: Record<string, unknown>) {
		const started = await core.core.call(method, params) as Job;
		const result = await core.waitFor(() => core.messages.map(event => event.job as Job | undefined)
			.find(item => item?.id === started.id && ["done", "failed", "cancelled"].includes(item.status)), 30_000);
		assert.equal(result.status, "done", JSON.stringify(result));
	}
	await job(t, "backup.export", { path: out, kind: "manual", credentials: "none" });
	const target = await startTestCore();
	try {
		await job(target, "backup.stage", { path: out });
		await job(target, "backup.apply", {});
		const paths = target.core.paths;
		await target.core.shutdown();
		assert.equal(applyPendingRestore(paths)?.ok, true);
		const db = new Db(paths.dbFile);
		try {
			assert.ok(db.get("SELECT 1 FROM selfwork_goals WHERE title='整理图表笔记'"));
			assert.ok(db.get("SELECT 1 FROM selfwork_runs WHERE state='held' AND reason='goal_api_unavailable'"));
		} finally { db.close(); }
	} finally { await target.cleanup(); }
});
