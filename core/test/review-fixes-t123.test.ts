import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { it, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Job } from "../src/backup/backup.ts";
import { applyPendingRestore } from "../src/backup/switch.ts";
import { ButterflyModule } from "../src/modules/butterfly.ts";
import { GoalsModule } from "../src/modules/goals.ts";
import { selfworkDeliverable } from "../src/modules/goals/selfwork.ts";
import { SelfworkModule } from "../src/modules/selfwork/index.ts";
import { startTestCore } from "./harness.ts";

async function fixture(test: TestContext) {
	let t = await startTestCore();
	test.after(() => t.cleanup());
	const local = (path: string) => join(t.dir, "fake-sandbox", path.slice("/workspace".length));
	function configure() {
		t.core.sandboxProvider = () => ({ distro: "df-t123-fake", ready: async () => {}, online: () => false });
		t.core.autonomy.sandboxFile = async path => local(path);
		t.core.module(ButterflyModule)!.local = local;
		t.core.module(GoalsModule)!.executor.stop();
	}
	configure();
	return { get t() { return t; }, get goals() { return t.core.module(GoalsModule)!; }, local,
		async reopen() { t = await t.reopen(); configure(); return t; } };
}

it("T123 restoring a legacy held plan requires user confirmation before it can dispatch once", async test => {
	const s = await fixture(test), { t } = s;
	t.core.settings.update({ butterflyProactivity: "high", butterflyDailyBudget: 0.5 });
	const parent = await t.core.call("selfwork.longGoals.save", { title: "整理历史数据", instruction: "写出摘要" }, t.client) as { id: string; revision: number };
	t.core.db.run(`INSERT INTO selfwork_runs(id,source,long_goal_id,long_goal_revision,state,plan,reason,started_at,day)
		VALUES('restored-held','goal',?,?,'held',?,'goal_api_unavailable',?,'legacy')`, parent.id, parent.revision,
		JSON.stringify({ action: "proceed", topic: "复核", title: "样例笔记", instruction: "记录样例结论", share: false, external: false }), Date.now());
	const archive = join(t.dir, "held.dfbackup");
	const job = async (method: string, params: Record<string, unknown>) => {
		const request = await t.core.call(method, params) as Job;
		const result = await t.waitFor(() => t.messages.filter(m => m.event === "backup.job").map(m => m.job as Job)
			.findLast(item => item.id === request.id && item.status !== "running"), 45_000);
		assert.equal(result.status, "done", result.error ?? "");
	};
	await job("backup.export", { path: archive });
	await job("backup.stage", { path: archive });
	await job("backup.apply", {});
	await t.core.shutdown();
	assert.equal(applyPendingRestore(t.core.paths)?.ok, true);
	const restored = await s.reopen();
	const selfwork = restored.core.module(SelfworkModule)!;
	await selfwork.tick();
	const plan = () => restored.core.db.get<{ state: string; reason: string; goal_id: string | null; restore_review_required: number }>(
		"SELECT state,reason,goal_id,restore_review_required FROM selfwork_runs WHERE id='restored-held'")!;
	assert.deepEqual({ ...plan() }, { state: "held", reason: "goal_api_unavailable", goal_id: null, restore_review_required: 1 });
	assert.equal(restored.core.db.get("SELECT 1 FROM goal_selfwork"), undefined);
	assert.throws(() => restored.core.autonomy.acceptSelfwork({ refId: "restored-held", source: "goal", sandbox: true,
		cwd: restored.core.paths.butterflyDir, deliverable: selfworkDeliverable("restored-held"), mandateRef: `long-goal:${parent.id}@${parent.revision}`,
		title: "样例笔记", instruction: "记录样例结论" }), /需要用户核对/);
	const review = await restored.core.call("selfwork.restoredPlans.list", {}, restored.client) as { id: string }[];
	assert.deepEqual(review.map(item => item.id), ["restored-held"]);
	await assert.rejects(restored.core.call("selfwork.restoredPlans.confirm", { id: "restored-held" }));
	await restored.core.call("selfwork.restoredPlans.confirm", { id: "restored-held" }, restored.client);
	await assert.rejects(restored.core.call("selfwork.restoredPlans.confirm", { id: "restored-held" }, restored.client));
	await selfwork.tick();
	const id = plan().goal_id;
	assert.ok(id);
	await selfwork.tick();
	assert.equal(plan().goal_id, id);
	assert.equal(restored.core.db.all("SELECT * FROM goal_selfwork").length, 1);
	assert.equal(restored.faux.state.callCount, 0);
});

for (const limit of ["zero", "spent"] as const) it(`T123 a rule stops before read, write and notify when its cap is ${limit}`, async test => {
	const s = await fixture(test), { t, goals } = s;
	t.core.settings.update({ butterflyDailyBudget: 0.5, autonomySources: { schedule: true, folder: false, conversation: true } });
	await t.core.call("autonomy.rules.save", { mode: "auto", rule: { name: "整理", source: "schedule", task: "整理样例", actions: ["read", "write", "notify"] } });
	t.core.autonomy.scheduleFired({ scheduleId: "t123-test", triggerKey: "first", at: Date.now(), createdBy: "user" });
	const row = await t.waitFor(() => t.core.db.get<{ id: string }>("SELECT id FROM goals WHERE source='rule'"));
	const goal = goals.scheduler.get(row.id)!;
	const { user } = await handoff(s, "user.md");
	assert.equal(await t.core.autonomy.checkGoalPath(goal, "read", "/workspace/inbox/report.md"), true);
	if (limit === "zero") t.core.settings.update({ butterflyDailyBudget: 0 });
	else t.core.autonomy.budget.record(0.5, "observe", "settled-observe");
	assert.equal(await t.core.autonomy.checkGoalPath(goal, "read", "/workspace/inbox/report.md"), false);
	assert.equal(await t.core.autonomy.checkGoalPath(goal, "write", "/workspace/outbox/report.md"), false);
	assert.equal(t.core.autonomy.claimNotice(goal, `test-${limit}`), false);
	const paused = goals.scheduler.get(goal.id)!;
	assert.equal(paused.status, "paused");
	assert.equal(paused.reason, "autonomy_budget");
	assert.match(paused.resumeWhen ?? "", limit === "zero" ? /设为 0/ : /每日上限/);
	assert.equal(t.core.autonomy.checkGoal(user, "read", "/workspace/inbox/report.md").ok, true);
});

async function handoff(s: Awaited<ReturnType<typeof fixture>>, ...files: string[]) {
	const { t, goals } = s;
	const slot = await t.core.openSlot({ cwd: t.core.paths.butterflyDir, sandbox: true, client: t.client });
	const { sessionId, sessionFile } = slot.session;
	assert.ok(sessionFile);
	const text = `核对资料并交付 ${files.join("、")}`;
	const eventId = t.core.autonomy.conversation({ sessionId, messageId: "handoff", text, actor: "user" });
	t.core.autonomy.acceptConversation(eventId, { name: "样例交办", task: text }, { sessionId, sessionFile, inputs: [], files });
	const [row] = await t.core.call("butterfly.chat.tasks", { sessionFile }) as { goalId: string; deliverables: string[] }[];
	assert.ok(row);
	assert.equal(row.deliverables.length, files.length);
	const user = await t.waitFor(() => goals.scheduler.get(row.goalId));
	return { user, paths: row.deliverables.map(s.local) };
}

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const PDF = Buffer.from("%PDF-1.4\n");
const evidence = () => fauxAssistantMessage([fauxToolCall("goal_report", { status: "done", note: "按约定核对过。" })]);

it("T123 nonblank text and the correct PNG and PDF signatures pass actual handoff acceptance", async test => {
	const s = await fixture(test), { t, goals } = s;
	const { user, paths } = await handoff(s, "normal.md", "large.txt", "image.png", "manual.pdf");
	const text = Buffer.alloc(8 * 1024 * 1024 + 2, 32);
	text[text.length - 1] = 65;
	for (const [index, bytes] of [Buffer.from("有效内容"), text, PNG, PDF].entries()) {
		mkdirSync(dirname(paths[index]!), { recursive: true });
		writeFileSync(paths[index]!, bytes);
	}
	t.respond(evidence(), fauxAssistantMessage("交付完成"));
	goals.executor.start();
	await t.waitFor(() => goals.scheduler.get(user.id)?.status === "completed", 12_000);
	assert.deepEqual(goals.scheduler.latestProgram(user.id, 1)?.checks.filter(item => item.id.startsWith("chat-file:")).map(item => item.detail),
		["文本含有非空白内容", "文本含有非空白内容", "已核对交付文件头", "已核对交付文件头"]);
});

it("T123 blank, oversized blank, wrong signature and unknown types cannot complete a handoff", async test => {
	const s = await fixture(test), { t, goals } = s;
	const { user, paths } = await handoff(s, "small.md", "large.txt", "fake.png", "unknown.bin");
	for (const [index, bytes] of [Buffer.from("   \r\n\t "), Buffer.alloc(8 * 1024 * 1024 + 1, 32), PDF, PNG].entries()) {
		mkdirSync(dirname(paths[index]!), { recursive: true });
		writeFileSync(paths[index]!, bytes);
	}
	t.respond(evidence(), fauxAssistantMessage("等待验收"));
	goals.executor.start();
	const report = await t.waitFor(() => goals.scheduler.latestProgram(user.id, 1) ?? undefined, 12_000);
	goals.executor.stop();
	assert.notEqual(goals.scheduler.get(user.id)?.status, "completed");
	const checks = report.checks.filter(item => item.id.startsWith("chat-file:"));
	assert.deepEqual(checks.map(item => item.status), ["missing", "missing", "missing", "unverified"]);
	assert.match(checks[3]!.detail, /暂不支持自动核验/);
});
