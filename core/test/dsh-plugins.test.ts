import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import * as timeContext from "@deepseek-ai/dsh-time-context";
import { fauxAssistantMessage, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { BackupModule } from "../src/backup/backup.ts";
import { MemoryModule } from "../src/modules/memory.ts";
import { memoryHotwords } from "../src/modules/voice/hotwords.ts";
import type { SlotInfo } from "../src/slots/slot.ts";
import { expectRpcError, startContractHarness, type ContractHarness } from "./api-contract/harness.ts";

async function turn(api: ContractHarness, slotId: string, message: string): Promise<TranscriptContext> {
	let received: TranscriptContext | undefined;
	api.respond(context => { received = context; return fauxAssistantMessage("本轮已完成"); });
	const from = api.events.length;
	await api.call("slot.send", { slotId, record: { type: "prompt", id: "p-" + from, message } });
	await api.waitForEvent("slot.record", event => event.slotId === slotId &&
		(event.record as { type: string }).type === "agent_settled", from);
	assert.ok(received, "model received the workbench request");
	return received;
}

test("an unmodified official plugin mounts in the desktop Core and disposes its contributions", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true });
	const fiber = api.core.cordis.plugin(timeContext, { timeZone: "UTC", refreshIntervalMs: 0 });
	await fiber;
	try {
		await api.call("slot.open", { slotId: "clock", cwd: api.workspace, agentMode: "minimal" });
		assert.match(JSON.stringify((await turn(api, "clock", "请回复")).messages), /Time sampled while preparing turn/);
		await api.call("slot.close", { slotId: "clock" });
		const root = join(api.sessionDir, ".dsh");
		const logs = (await readdir(root, { recursive: true })).filter(file => file.endsWith(".jsonl"));
		assert.equal(logs.length, 1);
		assert.match(await readFile(join(root, logs[0]!), "utf8"), /"kind":"time-context"/);
	} finally { await fiber.dispose(); }
	await api.call("slot.open", { slotId: "plain", cwd: api.workspace, agentMode: "minimal" });
	assert.doesNotMatch(JSON.stringify((await turn(api, "plain", "请再回复")).messages), /Time sampled while preparing turn/);
});

interface PluginRow {
	id: string;
	version: string;
	installed: boolean;
	enabled: boolean;
	active: boolean;
	restartRequired: boolean;
}

async function plugin(api: ContractHarness, id: string, action?: "install" | "remove" | "enable" | "disable"): Promise<PluginRow> {
	const { plugins } = action
		? await api.call<{ plugins: PluginRow[] }>("plugins." + action, { id })
		: await api.call<{ plugins: PluginRow[] }>("plugins.list");
	const result = plugins.find(row => row.id === id);
	assert.ok(result, id);
	return result;
}

test("memory enablement changes on restart while the same conversation and saved memory survive", { timeout: 75_000 }, async t => {
	const instances: ContractHarness[] = [];
	const options = { dshWorkbench: true, dshStandardWorkbench: true };
	const first = await startContractHarness(t, options);
	instances.push(first);
	const sentinel = "紫杉星图";
	const config = join(first.core.paths.dataDir, "system-plugins.json");
	async function close(api: ContractHarness) {
		await api.call("slot.close", { slotId: "desk" });
		await api.close();
		await api.core.shutdown();
	}
	try {
		const { item } = await first.call<{ item: { id: string } }>("memory.save", { content: "项目名：「" + sentinel + "」", scope: "global", pinned: true });
		const opened = await first.call<SlotInfo>("slot.open", { slotId: "desk", cwd: first.workspace, agentMode: "standard" });
		const initial = await turn(first, "desk", "第一轮测试");
		assert.match(JSON.stringify(initial.messages), new RegExp(sentinel));
		const countSnapshots = "SELECT COUNT(*) AS total FROM memory_snapshots";
		const before = first.core.db.get<{ total: number }>(countSnapshots)!.total;
		assert.ok(before > 0);
		await expectRpcError(first.call("plugins.remove", { id: "memory" }), "forbidden");
		const pendingOff = await plugin(first, "memory", "disable");
		assert.equal(pendingOff.enabled, false);
		assert.equal(pendingOff.active, true);
		assert.equal(pendingOff.restartRequired, true);
		assert.equal(JSON.parse(await readFile(config, "utf8")).dfMemory, false);
		await close(first);

		const detached = await startContractHarness(t, options, first.dir);
		instances.push(detached);
		const off = await plugin(detached, "memory");
		assert.equal(off.enabled, false);
		assert.equal(off.active, false);
		assert.equal(off.restartRequired, false);
		assert.equal(detached.core.module(MemoryModule), undefined);
		assert.ok(!detached.core.cordis.get("dfMemory"));
		await expectRpcError(detached.call("memory.runJobs"), "unknown_method");
		assert.deepEqual(detached.core.module(BackupModule)!.unclaimedTables(), []);
		assert.ok(!memoryHotwords(detached.core).includes(sentinel));
		await detached.call("storage.memory");
		await detached.call("slot.open", { slotId: "desk", cwd: first.workspace, sessionFile: opened.sessionFile });
		const bare = await turn(detached, "desk", "第二轮测试");
		assert.doesNotMatch(JSON.stringify(bare.messages), new RegExp(sentinel));
		assert.match(JSON.stringify(bare.messages), /第一轮测试/);
		assert.ok(!getCurrentTools(bare.messages).some(tool => tool.name.startsWith("memory_") || tool.name === "session_search"));
		assert.equal(detached.core.db.get<{ total: number }>(countSnapshots)!.total, before);
		const pendingOn = await plugin(detached, "memory", "enable");
		assert.equal(pendingOn.enabled, true);
		assert.equal(pendingOn.active, false);
		assert.equal(pendingOn.restartRequired, true);
		await close(detached);

		const restored = await startContractHarness(t, options, first.dir);
		instances.push(restored);
		const on = await plugin(restored, "memory");
		assert.equal(on.enabled, true);
		assert.equal(on.active, true);
		assert.equal(on.restartRequired, false);
		const saved = await restored.call<{ item: { id: string; content: string } }>("memory.item", { id: item.id });
		assert.equal(saved.item.id, item.id);
		assert.match(saved.item.content, new RegExp(sentinel));
		await restored.call("slot.open", { slotId: "desk", cwd: first.workspace, sessionFile: opened.sessionFile });
		const again = await turn(restored, "desk", "第三轮测试");
		assert.match(JSON.stringify(again.messages), new RegExp(sentinel));
		assert.match(JSON.stringify(again.messages), /第二轮测试/);
		assert.ok(getCurrentTools(initial.messages).some(tool => tool.name === "memory_search"));
		assert.ok(getCurrentTools(again.messages).some(tool => tool.name === "memory_search"));
	} finally {
		for (const api of instances) await api.core.shutdown();
	}
});

test("the bundled usage plugin mounts official session stats and reconciles with the request ledger", { timeout: 60_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true });
	const id = "usage-dashboard";
	assert.equal((await plugin(api, id)).installed, false);
	await expectRpcError(api.call("plugins.usage"), "unavailable");
	await expectRpcError(api.call("plugins.install", { id: "@deepseek-ai/dsh-time-context" }), "not_found");
	await expectRpcError(api.call("plugins.install", { id: "../usage-dashboard" }), "not_found");
	await api.call("slot.open", { slotId: "usage", cwd: api.workspace, agentMode: "minimal" });
	await turn(api, "usage", "计入账本");
	const session = api.core.slot("usage").nativeSession!;
	assert.ok(session);
	assert.equal(api.core.cordis.sessionProjections.snapshot(session, ["sessionStats"]).values.sessionStats, undefined);

	const installed = await plugin(api, id, "install");
	assert.equal(installed.version, "1.0.0");
	assert.equal(installed.active, true);
	const dashboard = await api.call<{
		since: number; until: number; timeZone: string;
		days: { date: string; requests: number; input: number; output: number; amounts: Record<string, number> }[];
		session: { turns: number; steps: number };
	}>("plugins.usage", { slotId: "usage" });
	assert.equal(dashboard.days.length, 7);
	assert.equal(dashboard.days[0]!.requests, 0);
	assert.ok(dashboard.days.at(-1)!.input > 0);
	assert.ok(dashboard.days.at(-1)!.output > 0);
	const { since, until, timeZone } = dashboard;
	const ledger = await api.call<{ rows: { requests: number; input: number; output: number; amounts: Record<string, number> }[] }>(
		"ledger.summary", { since, until, timeZone, period: "day", groupBy: "all" });
	assert.equal(dashboard.days.at(-1)!.requests, ledger.rows.at(-1)!.requests);
	assert.equal(dashboard.days.at(-1)!.input, ledger.rows.at(-1)!.input);
	assert.equal(dashboard.days.at(-1)!.output, ledger.rows.at(-1)!.output);
	assert.deepEqual(dashboard.days.at(-1)!.amounts, ledger.rows.at(-1)!.amounts);
	assert.equal(dashboard.session.turns, 1);
	assert.equal(dashboard.session.steps, 1);
	assert.deepEqual(dashboard.session, api.core.cordis.sessionProjections.snapshot(session, ["sessionStats"]).values.sessionStats);

	const disabled = await plugin(api, id, "disable");
	assert.equal(disabled.installed, true);
	assert.equal(disabled.active, false);
	await expectRpcError(api.call("plugins.usage"), "unavailable");
	assert.equal(api.core.cordis.sessionProjections.snapshot(session, ["sessionStats"]).values.sessionStats, undefined);
	await turn(api, "usage", "停用时继续对话");
	assert.equal((await plugin(api, id, "enable")).active, true);
	const current = await api.call<typeof dashboard>("plugins.usage", { slotId: "usage" });
	assert.equal(current.session.turns, 2);
	assert.equal(current.days.at(-1)!.requests, dashboard.days.at(-1)!.requests + 1);
	await api.call("sessions.list");
	await api.call("ledger.importHistory");
	assert.deepEqual((await api.call<typeof dashboard>("plugins.usage")).days, current.days);
	assert.equal((await plugin(api, id, "remove")).installed, false);
	await expectRpcError(api.call("plugins.usage"), "unavailable");
	assert.equal(api.core.cordis.sessionProjections.snapshot(session, ["sessionStats"]).values.sessionStats, undefined);
});

test("the window shortcut bundle persists installs, disablement and removal without duplicate effects", { timeout: 60_000 }, async t => {
	const first = await startContractHarness(t);
	const peer = await first.connect();
	const id = "window-shortcuts";
	const bindings = { bindings: [{ command: "spending.open", key: "KeyU", control: true, shift: true }] };
	assert.deepEqual(await first.call("plugins.shortcuts"), { bindings: [] });
	const options = { id };
	const attempt = peer.events.length;
	await Promise.all([first.call("plugins.install", options), peer.call("plugins.install", options)]);
	await peer.waitForEvent("plugins.changed", e => e.id === id, attempt);
	assert.equal(peer.events.slice(attempt).filter(event => event.event === "plugins.changed").length, 1);
	assert.deepEqual(await first.call("plugins.shortcuts"), bindings);
	await Promise.all([first.close(), peer.close()]);
	await first.core.shutdown();

	const second = await startContractHarness(t, {}, first.dir);
	assert.deepEqual(await second.call("plugins.shortcuts"), bindings);
	assert.equal((await plugin(second, id, "disable")).active, false);
	assert.deepEqual(await second.call("plugins.shortcuts"), { bindings: [] });
	assert.equal((await plugin(second, id, "install")).enabled, false);
	await second.close();
	await second.core.shutdown();

	const third = await startContractHarness(t, {}, first.dir);
	assert.equal((await plugin(third, id)).installed, true);
	assert.deepEqual(await third.call("plugins.shortcuts"), { bindings: [] });
	assert.equal((await plugin(third, id, "enable")).active, true);
	assert.deepEqual(await third.call("plugins.shortcuts"), bindings);
	assert.equal((await plugin(third, id, "remove")).installed, false);
	assert.deepEqual(await third.call("plugins.shortcuts"), { bindings: [] });
	assert.equal((await plugin(third, id, "install")).active, true);
	assert.deepEqual(await third.call("plugins.shortcuts"), bindings);
	await third.close();
	await third.core.shutdown();
});

test("a failed plugin profile write rolls back install and preserves an active plugin on failed removal", async t => {
	const api = await startContractHarness(t);
	const id = "window-shortcuts";
	const options = { id };
	const failedWrite = join(api.core.paths.dataDir, `system-plugins.json.${process.pid}.tmp`);
	const before = api.events.length;
	await mkdir(failedWrite);
	await expectRpcError(api.call("plugins.install", options), "unavailable");
	assert.equal((await plugin(api, id)).installed, false);
	assert.deepEqual(await api.call("plugins.shortcuts"), { bindings: [] });
	assert.equal(api.events.slice(before).some(event => event.event === "plugins.changed"), false);
	await rmdir(failedWrite);
	assert.equal((await plugin(api, id, "install")).active, true);

	await mkdir(failedWrite);
	await expectRpcError(api.call("plugins.remove", options), "unavailable");
	assert.equal((await plugin(api, id)).active, true);
	assert.ok(api.core.cordis.get("dfWindowShortcuts")?.length);
	await rmdir(failedWrite);
	assert.equal((await plugin(api, id, "remove")).active, false);
});
