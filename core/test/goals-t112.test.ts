import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { GoalsModule, type GoalScheduler } from "../src/modules/goals.ts";
import type { GoalNoticeReceipt } from "../src/modules/goals/notices.ts";
import { startTestCore, type TestCore } from "./harness.ts";

type Detail = ReturnType<GoalScheduler["detail"]>;

async function setup(test: TestContext, options: { disabled?: boolean; group?: boolean } = {}) {
	let t: TestCore;
	t = await startTestCore(undefined, { gatewayTransport: (model, context, request) => t.faux.streamSimple(model as never, context as never, request) });
	test.after(() => t.cleanup());
	const { id } = await t.core.call("gateway.saveChannel", {
		name: "T112 测试渠道", platform: "deepseek", api: "openai-completions", baseUrl: "https://synthetic.invalid/private/v1",
		enabled: !options.disabled, models: [{ id: "m", contextWindow: 200_000, maxTokens: 8192 }],
		keys: [{ secret: "synthetic-t112-key" }],
	}) as { id: string };
	if (options.group) await t.core.call("gateway.saveGroup", {
		id: "t112", name: "T112 模型组", entries: [{ channel: id, model: "m", priority: 0 }],
	});
	t.core.settings.update({ defaultModel: options.group ? "dreamflutter/t112" : `df-${id}/m` });
	const scheduler = t.core.module(GoalsModule)!.scheduler;
	const create = () => t.core.call("goals.create", {
		title: "验证目标渠道", originText: "核对合成材料", mandateRef: "user:t112",
		spec: { objective: "核对合成材料" }, scope: { cwd: t.workspace }, budget: { maxRuns: 3 },
	}) as Promise<Detail>;
	const until = (id: string, predicate: (goal: Detail) => boolean) => t.waitFor(() => {
		const goal = scheduler.detail(id);
		return predicate(goal) && goal;
	}, 24_000);
	return { t, create, until };
}

const error = (errorMessage: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage });

for (const fixture of [
	{ name: "401", error: "401 Authentication failed: synthetic-t112-key https://synthetic.invalid/private/v1", detail: /渠道认证失败（401）/, requests: 1 },
	{ name: "quota", error: "429 insufficient_quota: synthetic-t112-key https://synthetic.invalid/private/v1", detail: /渠道额度或订阅用完（429）/, requests: 1 },
	{ name: "disabled group", error: "", detail: /没有可用的渠道/, requests: 0 },
	{ name: "group rejecting its only key", error: "401 Authentication failed", detail: /渠道认证失败（401）/, requests: 1 },
]) {
	it(`T112 ${fixture.name} pauses the goal without charging a round`, async test => {
		const disabled = !fixture.error;
		const { t, create, until } = await setup(test, { disabled, group: disabled || fixture.name.startsWith("group") });
		if (fixture.error) t.respond(error(fixture.error));
		const goal = await create();
		const result = await until(goal.id, current => ["paused", "blocked", "failed"].includes(current.status));
		assert.equal(result.status, "paused");
		assert.equal(result.reason, "channel_unavailable");
		assert.match(result.resumeWhen ?? "", fixture.detail);
		assert.doesNotMatch(result.resumeWhen ?? "", /synthetic|https:\/\//);
		assert.equal(result.budgetStatus.used.runs, 0);
		assert.equal(t.faux.state.callCount, fixture.requests);
		assert.equal(t.core.db.get(`SELECT 1 FROM goal_intents WHERE goal_id=? AND action IN ('run','review')
			AND status IN ('pending','started')`, goal.id), undefined);
	});
}

it("T112 a temporary 429 uses the existing retry and can complete in the same round", async test => {
	const { t, create, until } = await setup(test);
	t.respond(error("429 Rate limit reached for requests"), fauxAssistantMessage("[目标已完成]\n核对完成"), context => {
		const content = context.messages.at(-1)?.content;
		const { revision, evidence_version } = JSON.parse(typeof content === "string" ? content : content?.map(part => "text" in part ? part.text : "").join("") ?? "");
		return fauxAssistantMessage(JSON.stringify({ verdict: "done", revision, evidence_version, next: "", missing: [], questions: [] }));
	});
	const goal = await create();
	const result = await until(goal.id, current => ["completed", "paused", "blocked", "failed"].includes(current.status));
	assert.equal(result.status, "completed");
	assert.equal(result.budgetStatus.used.runs, 1);
	assert.equal(t.faux.state.callCount, 3);
});

it("T112 exhausted temporary retries pause with a channel reason", async test => {
	const { t, create, until } = await setup(test);
	t.respond(...Array.from({ length: 6 }, () => error("429 Rate limit reached for requests")));
	const goal = await create();
	const result = await until(goal.id, current => ["paused", "blocked", "failed"].includes(current.status));
	assert.equal(result.reason, "channel_unavailable");
	assert.match(result.resumeWhen ?? "", /渠道持续限流（429），重试后仍不可用/);
	assert.equal(result.budgetStatus.used.runs, 1);
	assert.equal(t.faux.state.callCount, 6);
});

it("T112 a review authentication failure pauses immediately and preserves the completed execution round", async test => {
	const { t, create, until } = await setup(test);
	t.respond(fauxAssistantMessage("[目标已完成]\n已核对"), error("401 Authentication failed"));
	const goal = await create();
	const result = await until(goal.id, current => ["paused", "blocked", "failed"].includes(current.status));
	assert.equal(result.status, "paused");
	assert.equal(result.reason, "channel_unavailable");
	assert.match(result.resumeWhen ?? "", /渠道认证失败（401）/);
	assert.equal(result.budgetStatus.used.runs, 1);
	assert.equal(t.faux.state.callCount, 2);
});

for (const muted of [false, true]) {
	it(`T112 a Butterfly question records ${muted ? "muted" : "failed native"} delivery and keeps the dialog`, async test => {
		const t = await startTestCore();
		test.after(() => t.cleanup());
		t.core.settings.update({ notifications: !muted });
		t.core.sandboxProvider = () => ({ distro: "df-test-t112", ready: async () => {}, online: () => false });
		let attempts = 0;
		Object.defineProperty(t.notifier, "deliver", { value: async () => { attempts++; return "undelivered"; } });
		t.respond(fauxAssistantMessage(fauxToolCall("goal_wait", { kind: "user", questions: ["选择合成材料 A 还是 B？"] }), { stopReason: "toolUse" }),
			fauxAssistantMessage("等你决定"));
		const goal = await t.core.call("goals.create", {
			title: "测试目标提问", originText: "核对合成材料", mandateRef: "user:t112",
			scope: { cwd: t.core.paths.butterflyDir, partition: "butterfly", sandbox: true }, spec: { objective: "核对材料" },
		}) as Detail;
		const dialog = await t.waitFor(() => t.core.confirmations.list({ status: "pending" }).find(item => item.title.includes("选择合成材料")));
		const scheduler = t.core.module(GoalsModule)!.scheduler;
		const delivery = await t.waitFor(() => scheduler.detail(goal.id).recentEvents
			.filter(event => event.kind === "notification.delivery")
			.map(event => event.payload as GoalNoticeReceipt)
			.find(receipt => receipt.state === (muted ? "muted" : "failed")));
		assert.ok(dialog);
		assert.equal(attempts, muted ? 0 : 1);
		if (muted) {
			assert.equal(delivery.note, "通知关着");
			assert.equal(t.messages.some(event => event.event === "notification" && event.kind === "butterfly.waiting"), false);
			assert.deepEqual(t.notifier.sent, []);
			t.core.settings.update({ notifications: true });
		}
		await t.waitFor(() => !scheduler.pendingIntents().some(intent => intent.goal_id === goal.id && intent.action === "notify"));
		assert.equal(attempts, muted ? 0 : 1);
	});
}
