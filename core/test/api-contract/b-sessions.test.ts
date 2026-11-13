import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fields, startContractCore, type Json } from "./b-harness.ts";

const slotFields = "slotId cwd sessionFile sessionId sessionName running compacting pendingDialogs lastActivity createdAt taskId unattended incognito forkOf sessionType willPersist sandbox model agentMode planMode".split(" ");
const sessionFields = "path cwd sessionId parentSession sessionType parentMissing quote quoteEntryId title name createdAt modifiedAt messageCount pinned archived".split(" ");
const hitFields = "path cwd title entryId role snippet modifiedAt".split(" ");

it("session slots, message history, search, archive and recycle use the documented WebSocket shapes", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	const slot = fields(await ws.call("slot.open", { cwd: ws.t.workspace, slotId: "contract" }), slotFields);
	const slotId = String(slot.slotId);
	assert.equal(slot.sandbox, false);
	assert.deepEqual(await ws.call("slot.list"), [slot]);
	const attachment = fields(await ws.call("slot.attach", { slotId }), ["info", "replay", "live"]);
	assert.deepEqual(attachment.info, slot);
	assert.deepEqual(attachment.replay, []);
	assert.deepEqual(attachment.live, []);
	assert.deepEqual(ws.pushes(0, "slot.changed").map(event => fields(event, ["event", "info"]).info), [slot]);
	await ws.error("slot.open", {}, "bad_request");
	await ws.error("slot.attach", { slotId: "missing" }, "not_found");
	await ws.error("slot.send", { slotId, record: {} }, "bad_request");
	await ws.error("slot.send", { slotId: "missing", record: { type: "get_state" } }, "not_found");
	const from = ws.messages.length;
	ws.t.respond(fauxAssistantMessage("已核对契约石榴词"));
	assert.equal((await ws.command(slotId, "prompt", { message: "请核对契约石榴词" })).success, true);
	await ws.t.waitFor(() => ws.pushes(from, "slot.record").some(message => (message.record as Json).type === "agent_settled"));
	const records = ws.pushes(from, "slot.record").map(message => (message.record as Json).type);
	assert.equal(records.filter(type => type === "agent_start").length, 1);
	assert.equal(records.filter(type => type === "agent_settled").length, 1);
	assert.ok(records.indexOf("message_end") < records.indexOf("agent_settled"));
	const messageResult = fields((await ws.command(slotId, "get_messages")).data, ["messages"]);
	assert.ok((messageResult.messages as Json[]).some(message => message.role === "assistant"));
	const sessionFile = String(slot.sessionFile);
	const [row] = await ws.call("sessions.list", { cwd: ws.t.workspace }) as Json[];
	fields(row, sessionFields);
	assert.equal(row!.path, sessionFile);
	assert.deepEqual(await ws.call("sessions.children", { parentSession: sessionFile }), []);
	const hits = await ws.call("sessions.search", { query: "石榴词" }) as Json[];
	assert.ok(hits.length);
	hits.forEach(hit => fields(hit, hitFields));
	fields(await ws.call("search.all", { query: "石榴词" }), ["conversations", "files", "memories"]);
	assert.deepEqual(await ws.call("sessions.markSeen", { sessionFile }), { ok: true });
	assert.deepEqual(await ws.call("sessions.setPinned", { path: sessionFile, pinned: true }), { ok: true });
	assert.deepEqual(await ws.call("sessions.setArchived", { path: sessionFile, archived: true }), { ok: true });
	const archived = await ws.call("sessions.list", { archived: "only" }) as Json[];
	assert.equal(archived[0]?.pinned, true);
	assert.equal(archived[0]?.archived, true);
	for (const method of ["sessions.setPinned", "sessions.setArchived"]) {
		await ws.error(method, {}, "bad_request");
		await ws.error(method, { path: join(ws.t.sessionDir, "missing.jsonl") }, "not_found");
	}
	(await ws.call("sessions.workspaces") as Json[]).forEach(value => fields(value, ["cwd", "last", "n"]));
	assert.deepEqual(await ws.call("slot.detach", { slotId }), { ok: true });
	assert.deepEqual(await ws.call("slot.close", { slotId }), { ok: true });
	assert.equal(ws.pushes(from, "slot.closed").length, 1);
	fields(await ws.call("sessions.deletePreview", { path: sessionFile }), ["sideCount", "paths"]);
	const recycleAt = ws.messages.length;
	const removed = fields(await ws.call("sessions.delete", { path: sessionFile }), ["deleted", "sideCount", "batchId", "expiresAt"]);
	const [recycle] = await ws.call("sessions.recycleBin") as Json[];
	fields(recycle, ["batchId", "originalPath", "deletedAt", "expiresAt", "phase", "session"]);
	assert.deepEqual(await ws.call("sessions.restore", { batchId: removed.batchId }), { restored: [sessionFile] });
	assert.deepEqual(await ws.call("sessions.purgeExpired"), { purged: [] });
	assert.equal(ws.pushes(recycleAt, "sessions.changed").length, 2);
});

it("window queries and run records expose complete empty or populated responses", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	const slot = fields(await ws.call("slot.open", { cwd: ws.t.workspace }), slotFields);
	const slotId = String(slot.slotId);
	for (const method of ["artifacts.list", "confirm.list", "runs.list", "context.compactions"]) {
		assert.deepEqual(await ws.call(method), []);
	}
	assert.deepEqual(await ws.call("vision.lookup", { hashes: ["not-cached"] }), {});
	assert.deepEqual(await ws.call("workspace.toolRules", { cwd: ws.t.workspace }), []);
	assert.deepEqual(await ws.call("workspace.removeToolRule", { cwd: ws.t.workspace, tool: "read" }), { ok: true });
	assert.deepEqual(await ws.call("context.checkpoints", { slotId }), []);
	fields(await ws.call("context.info", { slotId }), ["usage", "contextWindow", "thresholdPercent", "thresholdTokens", "ownThreshold", "autoCompaction", "background", "compacting", "checkpoints"]);
	assert.deepEqual(await ws.call("context.setSession", { slotId, thresholdPercent: 70, background: true }), { thresholdPercent: 70, background: true });
	fields(await ws.call("context.stats"), ["normal", "background"]);
	await ws.error("context.setSession", { slotId, thresholdPercent: 5 }, "bad_request");
	await ws.error("context.original", { slotId, entryId: "missing" }, "not_found");
	await ws.error("confirm.answer", { id: "missing", response: {} }, "gone");
	assert.equal(await ws.call("runs.get", { id: "missing" }), null);
	assert.deepEqual(await ws.call("runs.steps", { runId: "missing" }), []);
	const before = ws.messages.length;
	ws.t.respond(fauxAssistantMessage("运行记录"));
	await ws.command(slotId, "prompt", { message: "记录这一轮" });
	const run = await ws.t.waitFor(() => ws.pushes(before, "run.finished")[0]?.run as Json | undefined);
	assert.deepEqual(await ws.call("runs.get", { id: run.id }), { ...run, kind: "conversation" });
	assert.deepEqual(await ws.call("runs.acknowledge", { id: run.id }), { ok: true });
	assert.equal(ws.pushes(before, "run.finished").length, 1);
	assert.equal(ws.pushes(before, "runs.changed").length, 1);
	const plain = join(ws.t.workspace, "fixture.txt");
	writeFileSync(plain, "fixture");
	await ws.error("files.convert", {}, "bad_request");
	const converted = fields(await ws.call("files.convert", { path: plain }), ["text", "kindLabel", "path", "name", "kind", "chars", "parts", "size", "large"]);
	assert.deepEqual(converted, { path: plain, name: "fixture.txt", kind: "text", text: "fixture", chars: 7, parts: null, size: 7, large: false, kindLabel: "文本" });
	await ws.error("context.report", { slotId, entryId: "missing" }, "not_found");
	await ws.error("context.regenerate", { slotId }, "bad_request");
	await ws.error("context.compactNow", { slotId: "missing" }, "not_found");
});

it("context compaction exposes a checkpoint, original text, report and regeneration events", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	ws.t.core.settings.update({ autoCompaction: false, backgroundCompaction: "off" });
	const { slotId } = await ws.call("slot.open", { cwd: ws.t.workspace }) as { slotId: string };
	for (const message of ["记住合成事实：现行端口 8453。", "合成材料 " + "rivers and meadows. ".repeat(100)]) {
		const from = ws.messages.length;
		ws.t.respond(fauxAssistantMessage("收到"));
		await ws.command(slotId, "prompt", { message });
		await ws.t.waitFor(() => ws.pushes(from, "slot.record").some(event => (event.record as Json).type === "agent_settled"));
	}
	const from = ws.messages.length;
	ws.t.respond(fauxAssistantMessage("初始合成摘要"));
	assert.ok(await ws.call("context.compactNow", { slotId }));
	const [checkpoint] = await ws.call("context.checkpoints", { slotId }) as Json[];
	fields(checkpoint, ["entryId", "summary", "firstKeptEntryId", "tokensBefore", "at", "reported"]);
	const original = await ws.call("context.original", { slotId, entryId: checkpoint!.entryId }) as Json[];
	assert.ok(original.length);
	for (const row of original) fields(row, ["entryId", "role", "text"]);
	fields(await ws.call("context.report", { slotId, entryId: checkpoint!.entryId, note: "补充已知端口" }), ["id"]);
	ws.t.respond(fauxAssistantMessage("更正后的合成摘要"));
	assert.equal((await ws.call("context.regenerate", { slotId, entryId: checkpoint!.entryId }) as Json).source, "original");
	await ws.t.waitFor(() => ws.pushes(from, "context.compaction").length >= 2);
	const events = ws.pushes(from, "context.compaction");
	assert.equal(events.length, 2);
	assert.ok(events.every(event => event.slotId === slotId));
	const available = ws.pushes(from, "context.available");
	assert.equal(available.length, 2);
	for (const event of available) {
		assert.equal(fields(event, ["event", "slotId", "sessionId", "reason", "tokensBefore"]).slotId, slotId);
	}
});

it("image relay and unavailable vision push their documented fields once", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII=";
	for (const [model, expected] of [["faux/faux-1", "vision.relayed"], ["faux/faux-text", "vision.missing"]]) {
		ws.t.core.settings.update({ visionModel: model });
		const { slotId } = await ws.call("slot.open", { cwd: ws.t.workspace }) as { slotId: string };
		assert.equal((await ws.command(slotId, "set_model", { provider: "faux", modelId: "faux-text" })).success, true);
		if (expected === "vision.relayed") ws.t.respond(fauxAssistantMessage("红色方块"));
		ws.t.respond(fauxAssistantMessage("收到图片"));
		const at = ws.messages.length;
		await ws.command(slotId, "prompt", { message: "看看这张合成图", images: [{ type: "image", data: png, mimeType: "image/png" }] });
		await ws.t.waitFor(() => ws.pushes(at, "slot.record").some(event => (event.record as Json).type === "agent_settled"));
		const events = ws.pushes(at, "vision.relayed", "vision.missing");
		assert.equal(events.length, 1);
		const event = fields(events[0], expected === "vision.relayed" ? ["event", "slotId", "hashes", "model"] : ["event", "slotId", "model"]);
		assert.equal(event.event, expected);
		assert.equal(event.slotId, slotId);
		if (expected === "vision.relayed") {
			const cache = await ws.call("vision.lookup", { hashes: event.hashes }) as Record<string, Json>;
			assert.equal(cache[(event.hashes as string[])[0]!]?.text, "红色方块");
		}
	}
});
