import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { GoalsModule } from "../src/modules/goals.ts";
import { SelfworkModule } from "../src/modules/selfwork/index.ts";
import { localDay } from "../src/modules/session-index.ts";
import { startTestCore } from "./harness.ts";

const idle = 16 * 60_000;
const secret = "synthetic-learning-secret";
const partial = `authorization: Bearer ${secret}\n{"action":"proceed","instruction":"${"内容".repeat(180)}`;
const compact = { action: "proceed", topic: "指标误差", title: "指标笔记", instruction: "在约定 Markdown 文件中记录三条误差来源", share: false };
type History = { id: string; reason: string | null; plan: string | null; goal_id: string | null };

async function fixture(test: TestContext, modelLimit = 8_192) {
	let at = new Date(2026, 10, 12, 12).getTime();
	let t = await startTestCore(undefined, { selfwork: { clock: () => at } });
	test.after(() => t.cleanup());
	function configure() {
		t.core.sandboxProvider = () => ({ distro: "df-t125-fake", ready: async () => {}, online: () => false });
		const resolve = t.core.resolveModel;
		t.core.resolveModel = model => {
			const resolved = resolve(model);
			return resolved.provider === "faux" ? { ...resolved, maxTokens: modelLimit, cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } } : resolved;
		};
		t.core.module(GoalsModule)!.executor.stop();
		t.core.settings.update({ butterflyProactivity: "high", butterflyDailyBudget: 0.5 });
	}
	configure();
	const parent = await t.core.call("selfwork.longGoals.save", { title: "理解指标", instruction: "积累可以复查的指标知识" }, t.client) as { id: string; revision: number };
	// Isolate learning from the independently scheduled long-goal and skill planners.
	t.core.db.run(`INSERT INTO selfwork_runs(id,source,long_goal_id,long_goal_revision,state,started_at,day)
		VALUES('parent-done','goal',?,?,'completed',?,?),('skill-done','skill',NULL,NULL,'completed',?,?)`,
		parent.id, parent.revision, at, localDay(at), at, localDay(at));
	at += idle;
	return {
		get t() { return t; },
		tick: () => t.core.module(SelfworkModule)!.tick(),
		history: () => t.core.db.all<History>("SELECT id,reason,plan,goal_id FROM selfwork_runs WHERE source='learning' ORDER BY rowid"),
		async reopen() { t = await t.reopen(); configure(); at += idle; },
	};
}

it("T125 retries truncation once across restart and keeps bounded redacted text for each attempt", async test => {
	const s = await fixture(test);
	s.t.respond(fauxAssistantMessage(partial, { stopReason: "length" }));
	await s.tick();
	assert.deepEqual(s.history().map(row => row.reason), ["truncated"]);
	await s.reopen();
	s.t.respond(fauxAssistantMessage(partial, { stopReason: "length" }));
	await s.tick();
	await s.tick();
	assert.equal(s.t.faux.state.callCount, 1);
	const history = s.history();
	assert.deepEqual(history.map(row => row.reason), ["truncated", "truncated"]);
	for (const row of history) {
		const { responsePreview } = JSON.parse(row.plan!) as { responsePreview: string };
		assert.equal(responsePreview.length, 240);
		assert.match(responsePreview, /^authorization: 〔已遮盖：疑似密钥〕/);
		assert.ok(!responsePreview.includes(secret));
		assert.equal(row.goal_id, null);
	}
	assert.equal(s.t.core.db.all("SELECT 1 FROM autonomy_spending WHERE source='learning'").length, 2);
	assert.equal(s.t.core.db.get("SELECT 1 FROM autonomy_budget_holds WHERE source='learning'"), undefined);
});

it("T125 retries only after both learning gates allow another request", async test => {
	const s = await fixture(test), { t } = s;
	t.respond(fauxAssistantMessage(partial, { stopReason: "length" }));
	await s.tick();
	t.core.settings.update({ butterflyProactivity: "mid" });
	await s.tick();
	assert.equal(t.faux.state.callCount, 1);
	t.core.settings.update({ butterflyProactivity: "high", butterflyDailyBudget: 0 });
	await s.tick();
	assert.equal(t.faux.state.callCount, 1);
	assert.deepEqual(s.history().map(row => row.reason), ["truncated"]);
	t.core.settings.update({ butterflyDailyBudget: 0.5 });
	t.respond(fauxAssistantMessage('{"action":"none"}'));
	await s.tick();
	assert.equal(t.faux.state.callCount, 2);
	assert.deepEqual(s.history().map(row => row.reason), ["truncated", "no_plan"]);
});

for (const [input, reason] of [[partial, "invalid"], ['{"action":"none"}', "no_plan"]] as const) {
	it(`T125 records ${reason} without making a second planning request`, async test => {
		const s = await fixture(test), { t } = s;
		t.respond(fauxAssistantMessage(input));
		await s.tick();
		await s.tick();
		assert.equal(t.faux.state.callCount, 1);
		const [record] = s.history();
		assert.equal(record?.reason, reason);
		if (reason === "invalid") {
			const preview = (JSON.parse(record!.plan!) as { responsePreview: string }).responsePreview;
			assert.match(preview, /^authorization: 〔已遮盖：疑似密钥〕/);
			assert.equal(preview.length, 240);
		} else assert.equal(record?.plan, null);
	});
}

it("T125 uses 4096 as the learning target and recognizes an incomplete stop at the reported limit", async test => {
	const s = await fixture(test), { t } = s;
	const lengths: (number | undefined)[] = [];
	t.respond((_context, options) => {
		lengths.push(options?.maxTokens);
		// The fake provider estimates one output token per four characters.
		return fauxAssistantMessage('{"action":"proceed",'.padEnd(4096 * 4, "x"));
	});
	await s.tick();
	assert.deepEqual(lengths, [4096]);
	assert.deepEqual(s.history().map(row => row.reason), ["truncated"]);
});

it("T125 clamps to the selected model limit and a compact plan enters the real goal service", async test => {
	const s = await fixture(test, 2048), { t } = s;
	const prompts: { limit: number | undefined; system: string | undefined; reserved: number | undefined }[] = [];
	t.respond((context, options) => {
		const system = context.messages.findLast(message => (message.role as string) === "system") as { content?: string } | undefined;
		const reserved = t.core.db.get<{ estimate_usd: number }>("SELECT estimate_usd FROM autonomy_budget_holds WHERE source='learning'");
		prompts.push({ limit: options?.maxTokens, system: system?.content, reserved: reserved?.estimate_usd });
		return fauxAssistantMessage(JSON.stringify(compact));
	});
	await s.tick();
	assert.equal(prompts[0]?.limit, 2048);
	assert.ok(prompts[0]!.reserved! > 0.004 && prompts[0]!.reserved! < 0.006);
	assert.match(prompts[0]?.system ?? "", /只输出一个紧凑的 JSON 对象，不附推理/);
	const [run] = s.history();
	assert.ok(run?.goal_id);
	const goals = t.core.module(GoalsModule)!;
	const goal = await t.waitFor(() => goals.scheduler.get(run.goal_id!));
	assert.equal(goal.title, compact.title);
	assert.equal(t.core.db.get<{ source: string }>("SELECT source FROM goal_selfwork WHERE goal_id=?", goal.id)?.source, "learning");
});
