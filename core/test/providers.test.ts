import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { cleanTitle } from "../src/modules/auto-title.ts";
import type { ProviderInfo } from "../src/modules/providers.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

describe("providers", () => {
	let t: TestCore;

	beforeEach(async () => {
		t = await startTestCore();
	});

	afterEach(async () => {
		await t.cleanup();
	});

	it("saves a custom provider to models.json with an encrypted key, and removes it", { skip: process.platform !== "win32" }, async () => {
		const modelsPath = join(t.agentDir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: { keep: { baseUrl: "https://x", api: "openai-completions", apiKey: "literal", models: [] } } }));
		await t.core.call("providers.saveCustom", {
			id: "my-gw",
			name: "我的网关",
			baseUrl: "https://gw.example.com/v1/",
			api: "openai-completions",
			apiKey: "sk-secret-value",
			models: [{ id: "m1", contextWindow: 64000, cost: { input: 1, output: 2 } }],
		});
		const raw = readFileSync(modelsPath, "utf8");
		assert.ok(!raw.includes("sk-secret-value"), "the key is not stored in plain text");
		const config = JSON.parse(raw);
		assert.equal(config.providers.keep.apiKey, "literal", "other providers are untouched");
		const entry = config.providers["my-gw"];
		assert.equal(entry.baseUrl, "https://gw.example.com/v1");
		assert.match(entry.apiKey, /^!.*secret\.mjs/);
		assert.deepEqual(entry.models[0].cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
		assert.ok(existsSync(`${modelsPath}.before-dreamflutter`), "the original file is backed up once");
		assert.ok(t.messages.some((m) => m.event === "providers.changed"));

		// Editing without a new key keeps the stored one.
		await t.core.call("providers.saveCustom", { id: "my-gw", baseUrl: "https://gw.example.com/v1", api: "openai-completions", models: [{ id: "m2" }] });
		const again = JSON.parse(readFileSync(modelsPath, "utf8")).providers["my-gw"];
		assert.equal(again.apiKey, entry.apiKey);
		assert.deepEqual(again.models.map((m: { id: string }) => m.id), ["m2"]);

		await t.core.call("providers.removeCustom", { id: "my-gw" });
		assert.equal(JSON.parse(readFileSync(modelsPath, "utf8")).providers["my-gw"], undefined);
	});

	it("validates the custom provider form", async () => {
		await assert.rejects(t.core.call("providers.saveCustom", { id: "bad id!", baseUrl: "https://x", api: "openai-completions", apiKey: "k", models: [{ id: "m" }] }), /ID/);
		await assert.rejects(t.core.call("providers.saveCustom", { id: "ok", baseUrl: "ftp://x", api: "openai-completions", apiKey: "k", models: [{ id: "m" }] }), /http/);
		await assert.rejects(t.core.call("providers.saveCustom", { id: "ok", baseUrl: "https://x", api: "openai-completions", models: [{ id: "m" }] }), /API Key/);
	});

	it("lists providers with configured ones first", async () => {
		const list = (await t.core.call("providers.list", {})) as ProviderInfo[];
		assert.equal(list[0]!.id, "faux");
		assert.equal(list[0]!.configured, true);
		assert.equal(list[0]!.models[0]!.id, "faux-1");
	});

	it("tests a connection with a tiny request", async () => {
		t.respond(fauxAssistantMessage("OK"));
		const result = (await t.core.call("providers.test", { provider: "faux" })) as { ok: boolean; reply: string };
		assert.equal(result.ok, true);
		assert.equal(result.reply, "OK");
		t.respond(fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" }));
		const failed = (await t.core.call("providers.test", { provider: "faux" })) as { ok: boolean; error: string };
		assert.equal(failed.ok, false);
		assert.match(failed.error, /API Key/);
	});

	it("fetches the model list of an OpenAI-compatible endpoint", async () => {
		let auth = "";
		const server: Server = createServer((req, res) => {
			auth = String(req.headers.authorization ?? "");
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model" }] }));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		try {
			const port = (server.address() as { port: number }).port;
			const models = (await t.core.call("providers.fetchModels", { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "k1" })) as { id: string }[];
			assert.deepEqual(models.map((m) => m.id), ["a-model", "b-model"]);
			assert.equal(auth, "Bearer k1");
		} finally {
			server.close();
		}
	});
});

describe("auto title", () => {
	it("names a session after its first exchange", async () => {
		const t = await startTestCore();
		t.core.settings.update({ autoTitle: true });
		try {
			await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
			t.respond(fauxAssistantMessage("这是一份关于秋季旅行的建议……"), fauxAssistantMessage("“秋季旅行建议”"));
			await t.send("s1", { id: "p", type: "prompt", message: "秋天去哪里旅行好？" });
			await t.waitFor(() => settledCount(t.records("s1")) === 1);
			await t.waitFor(() => t.core.slot("s1").session.sessionName);
			assert.equal(t.core.slot("s1").session.sessionName, "秋季旅行建议");
		} finally {
			await t.cleanup();
		}
	});

	it("cleans model output into a short title", () => {
		assert.equal(cleanTitle("标题：《周报整理》\n解释……"), "周报整理");
		assert.equal(cleanTitle('"Trip ideas."'), "Trip ideas");
	});
});
