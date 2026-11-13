import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { expectKeys, expectRpcError, startContractHarness } from "./harness.ts";

const types = readFileSync(new URL("../../../docs/api/types.md", import.meta.url), "utf8");
const settingsFields = [...types.split("interface CoreSettings {")[1]!.split("\n}")[0]!.matchAll(/^\t([A-Za-z]\w*)\??:/gm)].map(match => match[1]!);
const setupFields = ["completed", "dataRoot", "userName", "defaultWorkspace", "models", "sandbox", "locations"];

test("core.hello, core.activity, core.startup, app.exitState and packageSources.status", async t => {
	const api = await startContractHarness(t);
	const hello = await api.call("core.hello");
	expectKeys(hello, ["version", "piVersion", "pid", "port", "dataDir", "butterflyHome", "agentDir", "sessionDir", "slots", "settings", "interruptedRuns", "pendingConfirmations"]);
	assert.equal(hello.dataDir, api.core.paths.dataDir);
	expectKeys(hello.settings, settingsFields);
	assert.deepEqual(await api.call("core.activity"), { running: [], count: 0 });
	expectKeys(await api.call("app.exitState"), ["busy", "conversations"]);
	const startup = await api.call<{ phases: unknown[]; current: unknown; ready: boolean }>("core.startup");
	expectKeys(startup, ["phases", "current", "ready"]);
	assert.equal(startup.ready, true);
	for (const phase of startup.phases) expectKeys(phase, ["name", "text", "at", "durationMs"]);
	const from = api.events.length;
	api.core.startup.mark("contract-fixture", "Contract fixture", true);
	const pushed = await api.waitForEvent("core.startup", undefined, from);
	assert.deepEqual(pushed, { event: "core.startup", ...await api.call<object>("core.startup") });
	assert.equal(api.events.slice(from).filter(e => e.event === "core.startup").length, 1);
	const sources = await api.call("packageSources.status", { cwd: api.workspace });
	expectKeys(sources, ["nextHost", "recent", "python", "npm"]);
	expectKeys(sources.python, ["inherit", "pypi", "tuna", "ustc"]);
	expectKeys(sources.npm, ["inherit", "npm", "npmmirror"]);
	await expectRpcError(api.call("app.setStartup", { enabled: true }), "internal");
});

test("settings.get and settings.update validate all wire fields and send exactly one push before reply", async t => {
	const api = await startContractHarness(t);
	const other = await api.connect();
	const before = await api.call("settings.get");
	expectKeys(before, settingsFields);
	const start = api.events.length;
	const changed = await api.call("settings.update", { userName: "合约测试", voiceIdleMinutes: -1, imaginary: true });
	expectKeys(changed, settingsFields);
	assert.deepEqual(changed, { ...before, userName: "合约测试" });
	assert.deepEqual(api.events.slice(start).filter(event => event.event === "settings.changed"), [
		{ event: "settings.changed", changed: ["userName"], settings: changed },
	]);
	assert.deepEqual(await other.waitForEvent("settings.changed"), api.events[start]);
	await api.call("settings.update", { userName: "合约测试", voiceIdleMinutes: -1 });
	assert.equal(api.events.slice(start).filter(event => event.event === "settings.changed").length, 1);
});

test("core.notify and notifications.presence expose validation and delivery", async t => {
	const api = await startContractHarness(t);
	await expectRpcError(api.call("notifications.presence"), "bad_request");
	assert.deepEqual(await api.call("notifications.presence", { foreground: true }), { ok: true });
	await expectRpcError(api.call("core.notify"), "bad_request");
	await api.call("settings.update", { notifications: true, patrolQuietEnabled: false });
	const start = api.events.length;
	assert.deepEqual(await api.call("core.notify", { title: "Contract notice", body: "Isolated delivery" }), { ok: true });
	await api.waitFor(() => api.notifier.sent.length === 1);
	assert.deepEqual(api.notifier.sent, [{ title: "Contract notice", body: "Isolated delivery" }]);
	assert.equal(api.events.slice(start).filter(item => item.event === "notification").length, 0);
	assert.deepEqual(await api.call("notifications.presence", { foreground: false }), { ok: true });
	const notice = { key: "contract-notice", title: "Fixture title", body: "Fixture body", target: { page: "chat" } };
	assert.equal(api.core.notifications.publish("workbench.done", notice), true);
	assert.equal(api.core.notifications.publish("workbench.done", notice), false);
	const pushed = await api.waitForEvent("notification", undefined, start);
	expectKeys(pushed, ["event", "id", "kind", "key", "category", "object", "situation", "impact", "action", "target", "title", "body", "at"]);
	assert.deepEqual(pushed.target, notice.target);
	assert.equal(api.events.slice(start).filter(e => e.event === "notification").length, 1);
});

test("setup status, directory, recommendations, channel test and completion contracts", async t => {
	const api = await startContractHarness(t);
	expectKeys(await api.call("setup.status"), setupFields);
	await expectRpcError(api.call("setup.validateDataRoot"), "bad_request");
	const path = await api.call("setup.validateDataRoot", { path: api.workspace });
	expectKeys(path, ["path", "exists", "freeBytes", "launchArgs"]);
	assert.equal(path.exists, true);
	await expectRpcError(api.call("setup.recommendModels"), "bad_request");
	await expectRpcError(api.call("setup.recommendModels", { channel: "absent" }), "not_found");
	await expectRpcError(api.call("setup.testChannel"), "bad_request");
	await expectRpcError(api.call("setup.testChannel", { channel: "absent" }), "not_found");
	await expectRpcError(api.call("setup.complete", { userName: 10 }), "bad_request");
	api.core.maintenance = "fixture";
	try { await expectRpcError(api.call("setup.complete"), "busy"); }
	finally { api.core.maintenance = undefined; }
	await expectRpcError(api.call("setup.complete", { channelId: "absent" }), "not_found");
	const at = api.events.length;
	const result = await api.call("setup.complete", { userName: "测试", sandbox: "later" });
	expectKeys(result, [...setupFields, "channelId", "restartRequired", "sandboxStatus"]);
	expectKeys(result.models, ["conversation", "small", "large", "vision"]);
	assert.equal(result.completed, true);
	const pushed = api.events.slice(at).filter(event => event.event === "settings.changed");
	assert.equal(pushed.length, 1);
	expectKeys(pushed[0], ["event", "settings", "changed"]);
	assert.deepEqual(await api.call("setup.status"), Object.fromEntries(setupFields.map(key => [key, result[key]])));
	expectKeys(await api.call("setup.complete"), [...setupFields, "alreadyCompleted", "restartRequired"]);
});

test("core.shutdown replies before closing the isolated database", async t => {
	const api = await startContractHarness(t);
	let stopped = false;
	api.core.onShutdown(() => { stopped = true; });
	assert.deepEqual(await api.call("core.shutdown"), { ok: true });
	await api.waitFor(() => stopped);
});
