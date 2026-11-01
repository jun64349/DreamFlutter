import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { type Api, type AssistantMessage, fauxAssistantMessage, type FauxResponseFactory, type Model } from "@earendil-works/pi-ai";
import { levelMap, readModelList } from "../src/gateway/catalog.ts";
import { classifyFailure } from "../src/gateway/classify.ts";
import { type ChannelStatus, channelProvider, type Transport } from "../src/gateway/gateway.ts";
import { HealthBook } from "../src/gateway/health.ts";
import { platformForUrl } from "../src/gateway/platforms.ts";
import { readQuota } from "../src/gateway/quota.ts";
import { type CandidateInfo, type GroupEntry, type ModelGroup, pickEntry } from "../src/gateway/router.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

const fail = (message: string): AssistantMessage => fauxAssistantMessage("", { stopReason: "error", errorMessage: message });

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

	it("sends OpenCode Go its conversation header, max_tokens and the model's own thinking levels", async () => {
		await start();
		const { id } = (await t!.core.call("gateway.saveChannel", {
			name: "OpenCode Go",
			platform: "opencode-go",
			api: "openai-completions",
			baseUrl: "https://opencode.ai/inference/go/openai/v1",
			models: [
				{ id: "deepseek-v4.1-flash", reasoning: true, contextWindow: 1_000_000, maxTokens: 384_000 },
				{ id: "not-in-pi-catalog", reasoning: true, efforts: ["none", "low", "high"] },
			],
			keys: [{ secret: "oc_sk_test" }],
		})) as { id: string };
		const seen: { model: Model<Api>; headers: Record<string, unknown>; sessionId: string | undefined }[] = [];
		const reply: FauxResponseFactory = (_context, options, _state, model) => {
			seen.push({ model: model as Model<Api>, headers: { ...options?.headers }, sessionId: options?.sessionId });
			return fauxAssistantMessage("ok");
		};
		t!.respond(reply);
		t!.core.settings.update({ defaultModel: `${channelProvider(id)}/deepseek-v4.1-flash` });
		await t!.core.call("slot.open", { slotId: "s1", cwd: t!.workspace }, t!.client);
		await ask("s1", "你好");

		const chat = seen[0]!;
		assert.ok(chat.sessionId, "Pi sends the session id");
		assert.equal(chat.headers["x-opencode-session"], chat.sessionId, "one stable header per conversation");
		const compat = chat.model.compat as Record<string, unknown>;
		assert.equal(compat.maxTokensField, "max_tokens");
		assert.equal(compat.thinkingFormat, "deepseek", "from Pi's catalog for OpenCode Go");
		assert.equal(compat.supportsStore, false);
		assert.equal(chat.model.thinkingLevelMap?.medium, null, "deepseek-v4.1-flash has no medium effort");
		assert.equal(chat.model.thinkingLevelMap?.max, "max");

		// Work outside a conversation (a connection test, titles, memory) gets a steady header too.
		t!.respond(reply);
		await t!.core.call("gateway.testChannel", { channel: id, model: "not-in-pi-catalog" });
		const test = seen[1]!;
		assert.ok(String(test.headers["x-opencode-session"] ?? "").length > 0);
		assert.deepEqual(test.model.thinkingLevelMap, { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null, off: "none" }, "from the efforts the model list names");
		assert.equal((test.model.compat as Record<string, unknown>).maxTokensField, "max_tokens", "the platform's defaults for models Pi does not know");
	});

	it("suggests OpenCode Go models with what Pi's catalog knows about them", async () => {
		await start();
		const platforms = (await t!.core.call("gateway.platforms", {})) as { id: string; modelDetails: { id: string; contextWindow?: number; efforts?: string[] }[] }[];
		const go = platforms.find((p) => p.id === "opencode-go")!;
		const flash = go.modelDetails.find((m) => m.id === "deepseek-v4.1-flash")!;
		assert.equal(flash.contextWindow, 1_000_000);
		assert.deepEqual(flash.efforts, ["low", "high", "max"]);
	});
});

describe("gateway: model lists", () => {
	// Trimmed from https://opencode.ai/inference/go/v1/models (2026-11-01).
	const opencode = {
		object: "list",
		data: [
			{
				id: "deepseek-v4.1-flash",
				name: "DeepSeek V4.1 Flash",
				type: "chat",
				modalities: { input: ["text", "image/jpeg", "image/png"], output: ["text"] },
				capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ["low", "high", "max"] } },
				limit: { context: 1000000, output: 384000 },
				cost: { text: { input: { price: 0.15, cache: { read: 0.003 } }, output: { price: 0.6 } } },
				api: { "chat-completions": { base_url: "https://opencode.ai/inference/go/openai/v1" } },
			},
			{
				id: "claude-haiku-5-5",
				name: "Claude Haiku 5.5",
				type: "chat",
				limit: { context: 1000000, output: 128000 },
				api: { messages: { base_url: "https://opencode.ai/inference/go/anthropic/v1" } },
			},
			{ id: "some-image-model", type: "image", api: { "chat-completions": {} } },
		],
	};

	it("keeps the models the channel's API can call, with their limits, prices and thinking levels", () => {
		const openai = readModelList(opencode, "openai-completions");
		assert.deepEqual(openai, [
			{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextWindow: 1000000, maxTokens: 384000, input: ["text", "image"], reasoning: true, efforts: ["low", "high", "max"], cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } },
		]);
		assert.deepEqual(readModelList(opencode, "anthropic-messages").map((m) => m.id), ["claude-haiku-5-5"]);
	});

	it("still reads plain OpenAI and Anthropic lists", () => {
		assert.deepEqual(readModelList({ data: [{ id: "b", object: "model" }, { id: "a", object: "model" }] }, "openai-completions"), [{ id: "a", name: "a" }, { id: "b", name: "b" }]);
		assert.deepEqual(readModelList({ data: [{ type: "model", id: "claude-x", display_name: "Claude X" }] }, "anthropic-messages"), [{ id: "claude-x", name: "Claude X" }]);
	});

	it("maps a list's efforts onto Pi's thinking levels", () => {
		assert.deepEqual(levelMap(["low", "high", "max"]), { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" });
		assert.equal(levelMap([]), undefined);
	});
});

describe("gateway: balances and allowances", () => {
	const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

	it("reads each platform's answer", async () => {
		const deepseek = await readQuota("deepseek-balance", "https://api.deepseek.com/v1", "k", reply({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "110.00" }] }));
		assert.deepEqual({ ...deepseek, checkedAt: 0 }, { type: "balance", amount: 110, currency: "CNY", checkedAt: 0 });
		const glm = await readQuota("glm-quota", "https://open.bigmodel.cn/api/anthropic", "k", reply({ data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 14.5, nextResetTime: 1782259200000 }] } }));
		assert.ok(glm.type === "plan");
		assert.deepEqual(glm.windows, [{ label: "5 小时", usedPercent: 14.5, resetAt: 1782259200000 }]);
		const minimax = await readQuota("minimax-remains", "https://api.minimaxi.com/anthropic", "k", reply({ data: { current_interval_total_count: 100, current_interval_usage_count: 25, expired_time: 1782259200 } }));
		assert.ok(minimax.type === "plan");
		assert.deepEqual(minimax.windows, [{ label: "当前周期", usedPercent: 25, resetAt: 1782259200000 }]);
		const broken = await readQuota("deepseek-balance", "https://api.deepseek.com/v1", "k", reply({}, 401));
		assert.ok(broken.type === "error" && /401/.test(broken.message));
	});

	let t: TestCore | undefined;
	let server: Server | undefined;
	afterEach(async () => {
		await t?.cleanup();
		t = undefined;
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = undefined;
	});

	it("rests a used-up plan until it resets, reminds at 80 %, and warns about a low balance", async () => {
		let glmUsed = 100;
		const resetAt = Date.now() + 2 * 3_600_000;
		let balance = "5.00";
		server = createServer((request, response) => {
			response.setHeader("content-type", "application/json");
			if (request.url?.startsWith("/api/monitor/usage/quota/limit")) {
				assert.equal(request.headers.authorization, "glm-key", "智谱 takes the bare key");
				response.end(JSON.stringify({ data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: glmUsed, nextResetTime: resetAt }] } }));
			} else if (request.url === "/user/balance") {
				response.end(JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: balance }] }));
			} else response.writeHead(404).end("{}");
		});
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		t = await startTestCore();
		const save = (name: string, platform: string, baseUrl: string, key: string, extra: Record<string, unknown> = {}) =>
			t!.core.call("gateway.saveChannel", { name, platform, api: "anthropic-messages", baseUrl, models: [{ id: "m" }], keys: [{ secret: key }], ...extra }) as Promise<{ id: string }>;
		const plan = (await save("智谱", "glm-coding", `${base}/api/anthropic`, "glm-key")).id;
		const paid = (await save("DeepSeek", "deepseek", `${base}/anthropic`, "ds-key", { lowBalance: 10 })).id;

		let status = (await t.core.call("gateway.refreshQuota", {})) as ChannelStatus[];
		const planStatus = status.find((s) => s.id === plan)!;
		assert.equal(planStatus.unavailable?.kind, "quota");
		assert.equal(planStatus.unavailable?.until, resetAt, "rests until the window reopens");
		assert.ok(planStatus.quota?.type === "plan" && planStatus.quota.windows[0]!.usedPercent === 100);
		const paidStatus = status.find((s) => s.id === paid)!;
		assert.ok(paidStatus.quota?.type === "balance" && paidStatus.quota.amount === 5);
		assert.equal(paidStatus.unavailable, null, "a low balance still works");
		const titles = t.notifier.sent.map((n) => n.title);
		assert.ok(titles.includes("智谱 额度已用 100%"));
		assert.ok(titles.includes("DeepSeek 余额不足"));

		glmUsed = 30;
		balance = "4.00";
		status = (await t.core.call("gateway.refreshQuota", {})) as ChannelStatus[];
		assert.equal(status.find((s) => s.id === plan)!.unavailable, null, "back as soon as the allowance is");
		assert.equal(t.notifier.sent.length, 2, "no repeated reminders");
	});
});

describe("gateway: review fixes", () => {
	let t: TestCore | undefined;
	afterEach(async () => {
		await t?.cleanup();
		t = undefined;
	});

	async function start(): Promise<TestCore> {
		const transport: Transport = (model, context, options) => t!.faux.streamSimple(model as never, context as never, options);
		t = await startTestCore(undefined, { gatewayTransport: transport });
		return t;
	}

	async function ask(slotId: string, text: string): Promise<void> {
		const before = settledCount(t!.records(slotId));
		await t!.send(slotId, { id: `p-${text}`, type: "prompt", message: text });
		await t!.waitFor(() => settledCount(t!.records(slotId)) > before, 15_000);
	}

	it("tries the channel's other key before leaving the channel, and never stores a key", async () => {
		await start();
		const keyA = "sk-first-account-0000aaaa";
		const { id } = (await t!.core.call("gateway.saveChannel", {
			name: "两个 Key",
			platform: "deepseek",
			api: "openai-completions",
			baseUrl: "https://example.invalid/v1",
			models: [{ id: "m" }],
			keys: [{ secret: keyA }, { secret: "sk-second-account-1111bbbb" }],
		})) as { id: string };
		const other = (await t!.core.call("gateway.saveChannel", {
			name: "备用",
			platform: "deepseek",
			api: "openai-completions",
			baseUrl: "https://example.invalid/v1",
			models: [{ id: "m" }],
			keys: [{ secret: "sk-spare-2222cccc" }],
		})) as { id: string };
		await t!.core.call("gateway.saveGroup", { id: "main", name: "主力", entries: [{ channel: id, model: "m", priority: 0 }, { channel: other.id, model: "m", priority: 1 }] });
		t!.core.settings.update({ defaultModel: "dreamflutter/main" });
		const asked: (string | undefined)[] = [];
		const reply: FauxResponseFactory = (_context, options) => {
			asked.push(options?.apiKey);
			// A relay that echoes the key it was given.
			return options?.apiKey === keyA ? fail(`402 Insufficient Balance for key ${keyA}`) : fauxAssistantMessage("ok");
		};
		t!.respond(reply, reply);
		await t!.core.call("slot.open", { slotId: "s1", cwd: t!.workspace }, t!.client);
		await ask("s1", "你好");
		assert.deepEqual(asked, [keyA, "sk-second-account-1111bbbb"], "the same channel's healthy key takes the retry");
		assert.equal(t!.messages.filter((m) => m.event === "gateway.switched").length, 0, "no channel switch");

		const errors = t!.core.db.all<{ error: string | null }>("SELECT error FROM gateway_requests WHERE error IS NOT NULL").map((r) => r.error!);
		assert.equal(errors.length, 1);
		assert.ok(!errors[0]!.includes(keyA) && errors[0]!.includes("****aaaa"), errors[0]);
		const channels = (await t!.core.call("gateway.channels", {})) as { id: string; keys: { unavailable: { message: string } | null }[] }[];
		const resting = channels.find((c) => c.id === id)!.keys[0]!.unavailable;
		assert.ok(resting && !resting.message.includes(keyA), "rest reasons shown to the window are masked too");
	});

	it("keeps an invalid key stopped whatever allowance readings say", () => {
		const book = new HealthBook();
		book.fail("c#k", "auth", "401");
		book.fail("c#k", "quota", "1316", Date.now() + 1000);
		assert.equal(book.status("c#k")?.kind, "auth");
		book.clearQuota("c#k");
		assert.equal(book.status("c#k")?.kind, "auth");
	});

	it("does not take an address shared with pay-as-you-go accounts for a plan", () => {
		assert.equal(platformForUrl("https://api.minimaxi.com/v1"), undefined);
		assert.equal(platformForUrl("https://open.bigmodel.cn/api/anthropic")?.id, "glm-coding");
		assert.equal(platformForUrl("https://api.deepseek.com/v1")?.id, "deepseek");
	});
});
