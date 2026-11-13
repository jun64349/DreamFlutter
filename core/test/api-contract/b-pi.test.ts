import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fields, startContractCore, type Json } from "./b-harness.ts";

it("runs all nine df commands over slot.record and checks their success and failure envelopes", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	const { slotId } = await ws.call("slot.open", { cwd: ws.t.workspace }) as { slotId: string };
	const before = ws.messages.length;
	ws.t.respond(fauxAssistantMessage("这是一条可导出的回复"));
	await ws.command(slotId, "prompt", { message: "生成一个树节点" });
	await ws.t.waitFor(() => ws.pushes(before, "slot.record").some(msg => (msg.record as Json).type === "agent_settled"));

	async function ok(type: string, params?: Json) {
		const reply = fields(await ws.command(slotId, type, params), ["id", "type", "command", "success"], ["data"]);
		assert.equal(reply.type, "response");
		assert.equal(reply.command, type);
		assert.equal(reply.success, true, JSON.stringify(reply));
		assert.equal(ws.pushes(before, "slot.record").filter(msg => (msg.record as Json).id === reply.id).length, 1);
		return reply.data;
	}
	async function fail(type: string, params?: Json, slot = slotId, expected?: string) {
		const reply = fields(await ws.command(slot, type, params), ["id", "type", "command", "success", "error"]);
		assert.equal(reply.type, "response");
		assert.equal(reply.command, type);
		assert.equal(reply.success, false);
		assert.equal(typeof reply.error, "string");
		if (expected !== undefined) assert.equal(reply.error, expected);
		assert.equal(ws.pushes(before, "slot.record").filter(msg => (msg.record as Json).id === reply.id).length, 1);
	}
	const tree = fields(await ok("df_tree"), ["nodes"]);
	const [node] = tree.nodes as Json[];
	fields(node, ["entryId", "parentId", "text", "timestamp", "active", "target"]);
	const branches = fields(await ok("df_branches"), ["branches", "leafId"]);
	fields((branches.branches as Json[])[0], ["entryId", "index", "total", "targets"]);
	assert.equal(await ok("df_set_label", { entryId: node!.entryId, label: "契约标签" }), undefined);
	const outputPath = join(ws.t.workspace, "session-export.md");
	assert.deepEqual(await ok("df_export", { format: "markdown", outputPath }), { path: outputPath });
	assert.match(readFileSync(outputPath, "utf8"), /生成一个树节点/);
	await fail("df_export", { outputPath: join(ws.t.workspace, "missing", "export.md") });
	fields(await ok("df_navigate_tree", { entryId: node!.target }), ["cancelled", "editorText"]);
	await fail("df_navigate_tree", { entryId: "does-not-exist" });
	assert.equal(await ok("df_reload"), undefined);
	fields(await ok("df_agent_state"), ["agentMode", "planMode", "todos"]);
	const planAt = ws.messages.length;
	assert.deepEqual(await ok("df_set_plan_mode", { on: true }), { planMode: true, todos: null });
	const changed = ws.pushes(planAt, "slot.record").map(msg => msg.record as Json);
	assert.equal(changed.filter(record => record.type === "df_agent_state").length, 1);
	fields(changed.find(record => record.type === "df_agent_state"), ["type", "planMode", "todos"]);
	assert.ok(changed.findIndex(record => record.type === "df_agent_state") < changed.findIndex(record => record.command === "df_set_plan_mode"));
	const usage = await ok("df_context_usage");
	if (usage !== null) fields(usage, ["tokens", "contextWindow", "percent"]);
	const minimal = await ws.call("slot.open", { cwd: ws.t.workspace, agentMode: "minimal" }) as { slotId: string };
	await fail("df_set_plan_mode", { on: true }, minimal.slotId, "计划模式只在标准模式里可用");
	await ws.error("slot.send", { slotId: "not-open", record: { type: "df_tree" } }, "not_found");

	const session = ws.t.core.slot(slotId).session;
	const message = "合成会话依赖失败";
	const throwFixtureError = () => { throw new Error(message); };
	for (const type of ["df_tree", "df_branches", "df_agent_state"]) {
		const mocked = test.mock.method(session.sessionManager, "getEntries", throwFixtureError);
		try { await fail(type, undefined, slotId, message); }
		finally { mocked.mock.restore(); }
	}
	const labels = test.mock.method(session.sessionManager, "appendLabelChange", throwFixtureError);
	try { await fail("df_set_label", { entryId: node!.entryId, label: "写入失败" }, slotId, message); }
	finally { labels.mock.restore(); }
	const reload = test.mock.method(session, "reload", async () => throwFixtureError());
	try { await fail("df_reload", undefined, slotId, message); }
	finally { reload.mock.restore(); }
	const context = test.mock.method(session, "getContextUsage", throwFixtureError);
	try { await fail("df_context_usage", undefined, slotId, message); }
	finally { context.mock.restore(); }
});
