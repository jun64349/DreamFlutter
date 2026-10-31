import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type AssistantMessage, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { classifyFailure } from "../src/gateway/classify.ts";
import { channelProvider, type Transport } from "../src/gateway/gateway.ts";
import { HealthBook } from "../src/gateway/health.ts";
import { type CandidateInfo, type GroupEntry, type ModelGroup, pickEntry } from "../src/gateway/router.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

describe("gateway: failure kinds", () => {
	it("tells quota, balance, key and throttling apart", () => {
		assert.equal(classifyFailure('429 {"error":{"code":"1316","message":"已达到 5 小时使用上限"}}'), "quota");
		assert.equal(classifyFailure("429 exceeded_current_quota_error: your quota is used up"), "quota");
		assert.equal(classifyFailure("402 Insufficient Balance"), "balance");
		assert.equal(classifyFailure("401 Authentication Fails, Your api key is invalid"), "auth");
		assert.equal(classifyFailure("429 Rate limit reached for requests"), "rate_limit");
		assert.equal(classifyFailure("503 Service Unavailable"), "server");
		assert.equal(classifyFailure("fetch failed"), "network");
		assert.equal(classifyFailure("400 This model's maximum context length is 128000 tokens"), "other", "context overflow is not the channel's fault");
		assert.equal(classifyFailure("request id 14290511 failed validation"), "other", "codes inside longer numbers do not count");
	});
});

describe("gateway: router", () => {
	const entry = (channel: string, priority = 0, weight = 0): GroupEntry => ({ channel, model: "m", priority, weight });
	const group = (entries: GroupEntry[], allowPaidOverflow = true): ModelGroup => ({ id: "g", name: "主力", entries, allowPaidOverflow });
	const ok = (kind: CandidateInfo["kind"] = "payg"): CandidateInfo => ({ kind, name: "x", unavailable: null });

	it("goes in order, stays on the session's entry, and moves on after a failure", () => {
		const g = group([entry("a", 0), entry("b", 1)]);
		const first = pickEntry(g, () => ok(), undefined, undefined);
		assert.ok(first.ok && first.entry.channel === "a");
		const sticky = pickEntry(g, () => ok(), { channel: "b", model: "m" }, undefined);
		assert.ok(sticky.ok && sticky.entry.channel === "b", "a session stays where it is while that works");
		const moved = pickEntry(g, () => ok(), { channel: "a", model: "m" }, { channel: "a", model: "m" });
		assert.ok(moved.ok && moved.entry.channel === "b" && moved.switchedFrom?.channel === "a");
	});

	it("skips resting channels and splits a tier by weight only when weights are set", () => {
		const resting: CandidateInfo = { kind: "payg", name: "A", unavailable: { kind: "rate_limit", message: "", until: Date.now() + 60_000 } };
		const g = group([entry("a", 0), entry("b", 0), entry("c", 1)]);
		const decision = pickEntry(g, (e) => (e.channel === "a" ? resting : ok()), undefined, undefined);
		assert.ok(decision.ok && decision.entry.channel === "b");
		const weighted = group([entry("a", 0, 1), entry("b", 0, 3)]);
		assert.ok((pickEntry(weighted, () => ok(), undefined, undefined, () => 0.1) as { entry: GroupEntry }).entry.channel === "a");
		assert.ok((pickEntry(weighted, () => ok(), undefined, undefined, () => 0.5) as { entry: GroupEntry }).entry.channel === "b");
	});

	it("keeps plan groups off paid channels when told to, and says why", () => {
		const usedUp: CandidateInfo = { kind: "plan", name: "智谱", unavailable: { kind: "quota", message: "", until: Date.now() + 3_600_000 } };
		const info = (e: GroupEntry) => (e.channel === "plan" ? usedUp : { kind: "payg" as const, name: "DeepSeek", unavailable: null });
		const allowed = pickEntry(group([entry("plan", 0), entry("paid", 1)]), info, undefined, undefined);
		assert.ok(allowed.ok && allowed.entry.channel === "paid");
		const blocked = pickEntry(group([entry("plan", 0), entry("paid", 1)], false), info, undefined, undefined);
		assert.ok(!blocked.ok);
		assert.match(blocked.message, /智谱：额度用完，.*恢复/);
		assert.match(blocked.message, /DeepSeek：本组不允许套餐用完后转到付费渠道/);
	});
});

describe("gateway: rest periods", () => {
	it("doubles rests, waits out quotas, and stops bad keys", () => {
		let clock = 1_000_000;
		const book = new HealthBook(() => clock);
		book.fail("a#k", "rate_limit", "429");
		assert.equal(book.status("a#k")?.until, clock + 30_000);
		clock += 30_000;
		assert.equal(book.status("a#k"), null, "after the rest the next request tries again");
		book.fail("a#k", "rate_limit", "429");
		assert.equal(book.status("a#k")?.until, clock + 60_000, "a second failure rests twice as long");
		book.fail("b#k", "quota", "1316", clock + 7_200_000);
		assert.equal(book.status("b#k")?.until, clock + 7_200_000);
		book.fail("c#k", "auth", "401");
		clock += 10 * 24 * 3_600_000;
		assert.equal(book.status("c#k")?.kind, "auth", "a bad key stays stopped until the user edits it");
		book.reset("c");
		assert.equal(book.status("c#k"), null);
	});
});

describe("gateway: in a session", () => {
	let t: TestCore | undefined;
	afterEach(async () => {
		await t?.cleanup();
		t = undefined;
	});

	/** Every channel request goes to the faux model; responses can look at which channel was asked. */
	async function start(): Promise<TestCore> {
		const transport: Transport = (model, context, options) => t!.faux.streamSimple(model as never, context as never, options);
		t = await startTestCore(undefined, { gatewayTransport: transport });
		return t;
	}

	const fail = (message: string): AssistantMessage => fauxAssistantMessage("", { stopReason: "error", errorMessage: message });

	async function channel(name: string, platform: string, keys: string[]): Promise<string> {
		const result = (await t!.core.call("gateway.saveChannel", {
			name,
			platform,
			api: "openai-completions",
			baseUrl: "https://example.invalid/v1",
			models: [{ id: "m", contextWindow: 200_000, maxTokens: 8_192 }],
			keys: keys.map((secret) => ({ secret })),
		})) as { id: string };
		return result.id;
	}

	async function ask(slotId: string, text: string): Promise<void> {
		const before = settledCount(t!.records(slotId));
		await t!.send(slotId, { id: `p-${text}`, type: "prompt", message: text });
		await t!.waitFor(() => settledCount(t!.records(slotId)) > before, 15_000);
	}

	function lastAssistant(slotId: string): AssistantMessage {
		const ends = t!.records(slotId).filter((r) => r.type === "message_end" && (r.message as { role?: string }).role === "assistant");
		return ends.at(-1)!.message as AssistantMessage;
	}

	it("moves a conversation to the next channel when the first one's money runs out, and stays there", async () => {
		await start();
		const plan = await channel("套餐 A", "glm-coding", ["key-a"]);
		const paid = await channel("按量 B", "deepseek", ["key-b"]);
		await t!.core.call("gateway.saveGroup", { id: "main", name: "主力", entries: [{ channel: plan, model: "m", priority: 0 }, { channel: paid, model: "m", priority: 1 }] });
		t!.core.settings.update({ defaultModel: "dreamflutter/main" });

		const asked: { provider: string; key: string | undefined }[] = [];
		const reply: FauxResponseFactory = (_context, options, _state, model) => {
			asked.push({ provider: model.provider, key: options?.apiKey });
			return model.provider === channelProvider(plan) ? fail("402 Insufficient Balance") : fauxAssistantMessage("来自 B");
		};
		t!.respond(reply, reply);
		await t!.core.call("slot.open", { slotId: "s1", cwd: t!.workspace }, t!.client);
		await ask("s1", "你好");

		assert.deepEqual(asked, [
			{ provider: channelProvider(plan), key: "key-a" },
			{ provider: channelProvider(paid), key: "key-b" },
		]);
		const answer = lastAssistant("s1");
		assert.equal(answer.stopReason, "stop");
		assert.equal(answer.content.map((c) => (c.type === "text" ? c.text : "")).join(""), "来自 B");
		const switched = t!.messages.find((m) => m.event === "gateway.switched");
		assert.ok(switched, "the window hears about the switch");
		assert.match(String(switched.from), /套餐 A/);
		assert.equal(switched.toPaid, true);

		const rows = t!.core.db.all<{ channel: string; ok: number; error_kind: string | null }>("SELECT channel, ok, error_kind FROM gateway_requests ORDER BY id");
		assert.deepEqual(rows.map((r) => ({ ...r })), [
			{ channel: plan, ok: 0, error_kind: "balance" },
			{ channel: paid, ok: 1, error_kind: null },
		]);
		const channels = (await t!.core.call("gateway.channels", {})) as { id: string; unavailable: { kind: string } | null }[];
		assert.equal(channels.find((c) => c.id === plan)?.unavailable?.kind, "balance");

		t!.respond(reply);
		await ask("s1", "再问一次");
		assert.equal(asked.length, 3);
		assert.equal(asked[2]!.provider, channelProvider(paid), "the next question stays on the channel that works");
	});

	it("takes a plan's used-up window as a quota, and rotates a channel's keys", async () => {
		await start();
		const plan = await channel("套餐 A", "glm-coding", ["key-a"]);
		const paid = await channel("按量 B", "deepseek", ["key-b1", "key-b2"]);
		await t!.core.call("gateway.saveGroup", { id: "main", name: "主力", entries: [{ channel: plan, model: "m", priority: 0 }, { channel: paid, model: "m", priority: 1 }] });
		t!.core.settings.update({ defaultModel: "dreamflutter/main" });
		const keys: (string | undefined)[] = [];
		const reply: FauxResponseFactory = (_context, options, _state, model) => {
			keys.push(options?.apiKey);
			return model.provider === channelProvider(plan) ? fail('429 {"error":{"code":"1316","message":"已达到 5 小时使用上限"}}') : fauxAssistantMessage("ok");
		};
		t!.respond(reply, reply, reply);
		await t!.core.call("slot.open", { slotId: "s1", cwd: t!.workspace }, t!.client);
		await t!.core.call("slot.open", { slotId: "s2", cwd: t!.workspace }, t!.client);
		await ask("s1", "一");
		await ask("s2", "二");
		const channels = (await t!.core.call("gateway.channels", {})) as { id: string; unavailable: { kind: string } | null }[];
		assert.equal(channels.find((c) => c.id === plan)?.unavailable?.kind, "quota");
		assert.deepEqual(keys, ["key-a", "key-b1", "key-b2"], "the second session gets the channel's next key");
	});

	it("leaves the error alone when a channel's model was picked directly", async () => {
		await start();
		const paid = await channel("按量 B", "deepseek", ["key-b"]);
		t!.core.settings.update({ defaultModel: `${channelProvider(paid)}/m` });
		t!.respond(fail("402 Insufficient Balance"));
		await t!.core.call("slot.open", { slotId: "s1", cwd: t!.workspace }, t!.client);
		await ask("s1", "你好");
		assert.equal(lastAssistant("s1").errorMessage, "402 Insufficient Balance", "Pi shows the platform's own message");
		assert.equal(t!.core.db.all("SELECT id FROM gateway_requests").length, 1, "and does not retry a balance error");
	});

	it("explains why nothing is available instead of failing quietly", async () => {
		await start();
		const plan = await channel("套餐 A", "glm-coding", ["key-a"]);
		const paid = await channel("按量 B", "deepseek", ["key-b"]);
		await t!.core.call("gateway.saveGroup", { id: "main", name: "主力", entries: [{ channel: plan, model: "m", priority: 0 }, { channel: paid, model: "m", priority: 1 }], allowPaidOverflow: false });
		t!.core.settings.update({ defaultModel: "dreamflutter/main" });
		const quota: FauxResponseFactory = () => fail('429 {"error":{"code":"1316","message":"已达到 5 小时使用上限"}}');
		t!.respond(quota);
		await t!.core.call("slot.open", { slotId: "s1", cwd: t!.workspace }, t!.client);
		await ask("s1", "你好");
		const error = lastAssistant("s1").errorMessage ?? "";
		assert.match(error, /套餐 A：额度用完/);
		assert.match(error, /按量 B：本组不允许套餐用完后转到付费渠道/);
	});

	it("turns the old fallback chain into the group 「自动」 under the same model key", async () => {
		await start();
		t!.core.settings.update({ fallbackModels: ["faux/faux-1", "df-gone/m"] });
		t = await t!.reopen();
		const groups = (await t.core.call("gateway.groups", {})) as { id: string; name: string; entries: { channel: string; model: string }[] }[];
		const auto = groups.find((g) => g.id === "auto");
		assert.equal(auto?.name, "自动");
		assert.deepEqual(auto?.entries.map((e) => `${e.channel}|${e.model}`), ["pi:faux|faux-1", "gone|m"]);
	});
});
