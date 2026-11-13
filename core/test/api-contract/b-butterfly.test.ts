import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ButterflyModule } from "../../src/modules/butterfly.ts";
import { GoalsModule } from "../../src/modules/goals.ts";
import { fields, startContractCore, type Json } from "./b-harness.ts";

const intentFields = "id slot_id task_id goal restatement plan state created_at start_at missing error".split(" ");
const taskFields = "id title goal cwd sessionFile source status noteId scheduleId materialIds result error runs turns cost durationMs currentStep createdAt updatedAt endedAt".split(" ");

it("old Butterfly workflow is still reachable by authenticated windows", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	ws.t.core.sandboxProvider = () => ({ distro: "df-contract-butterfly", ready: async () => {}, online: () => false });
	ws.t.core.module(ButterflyModule)!.local = path => join(ws.t.dir, "sandbox", path.slice("/workspace".length));
	const home = ws.t.core.paths.butterflyDir;
	const info = fields(await ws.call("butterfly.info"), ["home", "distro", "inbox", "outbox"]);
	assert.equal(info.home, home);
	assert.deepEqual(await ws.call("butterfly.outbox"), []);
	assert.deepEqual(await ws.call("butterfly.import", { paths: [] }), { paths: [] });
	const slot = await ws.call("slot.open", { cwd: home, sandbox: true }) as Json;
	assert.deepEqual(await ws.call("butterfly.chat.tasks", { sessionFile: slot.sessionFile }), []);
	await ws.error("butterfly.chat.artifact", { goalId: "missing", name: "report.md" }, "not_found");
	await ws.error("butterfly.handOff", { noteId: "missing" }, "not_found");
	assert.deepEqual(await ws.call("butterfly.tasks"), []);
	const prepareAt = ws.messages.length;
	ws.t.respond(fauxAssistantMessage(JSON.stringify({ restatement: "整理合成记录", plan: "先核对素材", missing: ["哪一份？"] })));
	const first = fields(await ws.call("butterfly.prepare", { slotId: slot.slotId, goal: "整理记录" }), intentFields);
	assert.equal(first.state, "needs_input");
	const prepared = ws.pushes(prepareAt, "butterfly.prepared", "tasks.changed");
	assert.equal(prepared.filter(event => event.event === "butterfly.prepared").length, 1);
	const preparedIndex = prepared.findIndex(event => event.event === "butterfly.prepared");
	assert.deepEqual(prepared[preparedIndex], { event: "butterfly.prepared", intent: first });
	assert.deepEqual(prepared[preparedIndex + 1], { event: "tasks.changed", taskId: first.task_id });
	assert.deepEqual(await ws.call("butterfly.start", { id: first.id, slotId: slot.slotId }), { ok: true, waiting: true });
	ws.t.respond(fauxAssistantMessage(JSON.stringify({ restatement: "整理第一份", plan: "核对第一份", missing: [] })));
	const answered = fields(await ws.call("butterfly.answer", { id: first.id, answer: "第一份" }), intentFields);
	assert.equal(answered.task_id, first.task_id);
	assert.equal(answered.state, "waiting");
	await ws.error("butterfly.answer", { id: first.id, answer: "已经回答" }, "conflict");
	const [task] = await ws.call("butterfly.tasks") as Json[];
	fields(task, [...taskFields, "progress", "delivery", "intent"], ["goalId", "attempt"]);
	assert.deepEqual(await ws.call("butterfly.cancel", { id: answered.id }), { ok: true });
	await ws.error("butterfly.start", { id: answered.id }, "conflict");
	assert.equal(await ws.call("butterfly.tick"), null);
	const note = fields(await ws.call("notes.save", { cwd: home, content: "# 交办写笺" }), ["id", "cwd", "title", "content", "createdAt", "updatedAt"]);
	const handed = fields(await ws.call("butterfly.handOff", { noteId: note.id }), ["task", "prompt"]);
	assert.equal((handed.task as Json).noteId, note.id);
	const outbox = join(ws.t.dir, "sandbox", "outbox");
	mkdirSync(outbox, { recursive: true });
	const outboxAt = ws.messages.length;
	ws.t.respond(() => {
		writeFileSync(join(outbox, "fixture.txt"), "合成交付");
		return fauxAssistantMessage("合成交付完成");
	});
	await ws.command(String(slot.slotId), "prompt", { message: "你好" });
	await ws.t.waitFor(() => ws.pushes(outboxAt, "butterfly.delivery").length === 1);
	const pushes = ws.pushes(outboxAt, "butterfly.outbox");
	assert.equal(pushes.length, 1);
	fields(pushes[0], ["event", "files", "fresh"]);
	assert.deepEqual(await ws.call("butterfly.outbox"), pushes[0]?.files);
	assert.deepEqual(ws.pushes(outboxAt, "butterfly.outbox", "butterfly.delivery").map(event => event.event), ["butterfly.outbox", "butterfly.delivery"]);
	fields(ws.pushes(outboxAt, "butterfly.delivery")[0], ["event", "taskId", "files", "runId"]);
});

it("reads a completed Butterfly delivery through the window", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	const local = (path: string) => join(ws.t.dir, "sandbox", path.slice("/workspace".length));
	ws.t.core.sandboxProvider = () => ({ distro: "df-contract-artifacts", ready: async () => {}, online: () => false });
	ws.t.core.module(ButterflyModule)!.local = local;
	ws.t.core.autonomy.sandboxFile = async path => local(path);
	const goals = ws.t.core.module(GoalsModule)!;
	goals.executor.stop();
	const { slotId, sessionFile } = await ws.call("slot.open", {
		cwd: ws.t.core.paths.butterflyDir, sandbox: true,
	}) as { slotId: string; sessionFile: string };
	const prompt = "请先核对给定资料，再汇总，最后交付 report.md。";
	assert.equal((await ws.command(slotId, "prompt", { message: prompt })).success, true);
	const [task] = await ws.call("butterfly.chat.tasks", { sessionFile }) as { goalId: string; deliverables: string[] }[];
	assert.ok(task?.deliverables[0]);
	const path = local(task.deliverables[0]);
	const content = "合成交付报告";
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	ws.t.respond(fauxAssistantMessage([fauxToolCall("goal_report", {
		status: "done", note: "核对了原始材料与汇总数字，报告包含约定的结果。",
	})]), fauxAssistantMessage("已交付"));
	goals.executor.start();
	await ws.t.waitFor(() => ws.t.core.autonomy.effects.get(`chat-delivery:${task.goalId}`)?.state === "completed", 22_000);
	assert.deepEqual(await ws.call("butterfly.chat.artifact", { goalId: task.goalId, name: "report.md" }), {
		name: "report.md", path, size: Buffer.byteLength(content),
	});
	await ws.error("butterfly.chat.artifact", { goalId: task.goalId, name: "../report.md" }, "not_found");
});

it("desk, tasks, notices, autonomy and persona use the documented fields", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	const cwd = ws.t.workspace;
	assert.deepEqual(await ws.call("desk.get", { cwd }), { notes: [], materials: [], tasks: [], artifacts: [] });
	await ws.error("desk.get", {}, "bad_request");
	const at = ws.messages.length;
	const note = fields(await ws.call("notes.save", { cwd, content: "# 旧窗口夹具" }), ["id", "cwd", "title", "content", "createdAt", "updatedAt"]);
	assert.deepEqual(ws.pushes(at, "desk.changed"), [{ event: "desk.changed", cwd }]);
	const desk = fields(await ws.call("desk.get", { cwd }), ["notes", "materials", "tasks", "artifacts"]);
	assert.deepEqual(desk.notes, [note]);
	const created = fields(await ws.call("tasks.create", { cwd, goal: "合成任务" }), ["task", "prompt"]);
	const task = fields(created.task, taskFields, ["goalId", "attempt"]);
	assert.deepEqual(await ws.call("tasks.get", { id: task.id }), { task, runs: [], artifacts: [] });
	assert.deepEqual(await ws.call("tasks.list", { cwd }), [task]);
	const slot = await ws.call("slot.open", { cwd }) as Json;
	assert.deepEqual(await ws.call("tasks.bind", { slotId: slot.slotId, taskId: task.id }), { ok: true });
	const bound = fields(await ws.call("tasks.forSession", { sessionFile: slot.sessionFile }), taskFields, ["goalId", "attempt"]);
	assert.equal(bound.id, task.id);
	assert.deepEqual(await ws.call("tasks.remove", { id: task.id }), { ok: true });
	await ws.error("tasks.get", { id: task.id }, "not_found");
	assert.deepEqual(await ws.call("notices.list"), []);
	assert.deepEqual(await ws.call("inbox.list"), []);
	await ws.error("notices.resolve", { id: "missing", action: "stop" }, "gone");
	const personas = await ws.call("persona.presets") as Json[];
	assert.equal(personas.length, 4);
	personas.forEach(persona => fields(persona, ["id", "name", "description", "example"]));
	assert.equal(typeof await ws.call("persona.proactivity.allows", { kind: "learning" }), "boolean");
	await ws.error("autonomy.rules.save", { rule: {} }, "bad_request");
	const rule = fields(await ws.call("autonomy.rules.save", { rule: { name: "合成规则", task: "整理", source: "conversation", scope: { kind: "sandbox" } } }),
		["id", "revision", "mode", "name", "task", "source", "scope", "actions", "delivery", "filter", "assess", "updatedAt"]);
	assert.deepEqual(await ws.call("autonomy.rules.list"), [rule]);
	assert.equal((await ws.call("autonomy.rules.mode", { id: rule.id, mode: "off" }) as Json).mode, "off");
	assert.deepEqual(await ws.call("autonomy.rules.hits", { id: rule.id }), []);
	assert.deepEqual(await ws.call("autonomy.rules.delete", { id: rule.id }), { ok: true });
	await ws.error("autonomy.rules.mode", { id: rule.id, mode: "observe" }, "not_found");
});

it("attention and selfwork queries, validations and longitudinal goals", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	assert.deepEqual(await ws.call("attention.list"), { now: [], later: [], counts: { now: 0, later: 0, total: 0 }, pending: [] });
	assert.deepEqual(await ws.call("attention.prioritized"), []);
	assert.equal((await ws.call("attention.metrics", { days: 1 }) as Json[]).length, 1);
	for (const method of ["attention.resolve", "attention.undo", "attention.receipt"]) {
		await ws.error(method, {}, "bad_request");
		await ws.error(method, { id: "missing", action: "allow" }, method === "attention.receipt" ? "not_found" : "gone");
	}
	ws.t.core.db.run("INSERT INTO notices(id,kind,title,status,created_at) VALUES('contract-notice','limit_turns','合成待处理','pending',?)", Date.now());
	const notices = await ws.call("notices.list") as Json[];
	assert.equal(notices[0]?.id, "contract-notice");
	const pending = await ws.call("attention.list") as { now: Json[]; later: Json[] };
	const item = [...pending.now, ...pending.later][0]!;
	assert.ok(item);
	await ws.error("attention.resolve", { id: item.id, action: "invalid" }, "bad_request");
	const from = ws.messages.length;
	const receipt = fields(await ws.call("attention.resolve", { id: item.id, action: "end" }),
		["id", "itemId", "status", "undoable", "undoUntil", "remainingMs"], ["result", "error"]);
	const actions = ws.pushes(from, "attention.action", "attention.changed");
	assert.deepEqual(actions.slice(0, 2).map(event => event.event), ["attention.action", "attention.changed"]);
	assert.equal((actions[0]?.receipt as Json).status, "pending");
	assert.equal(ws.pushes(from, "notices.changed").length, 1);
	if (receipt.status === "pending") {
		assert.equal((await ws.call("attention.undo", { id: receipt.id }) as Json).status, "cancelled");
	} else {
		assert.equal(receipt.status, "applied");
		await ws.error("attention.undo", { id: receipt.id }, "gone");
	}
	assert.equal((await ws.call("attention.receipt", { id: receipt.id }) as Json).itemId, item.id);
	for (const method of ["selfwork.history", "selfwork.restoredPlans.list", "selfwork.skills.list", "selfwork.longGoals.list"]) {
		assert.deepEqual(await ws.call(method), []);
	}
	await ws.error("selfwork.longGoals.save", {}, "bad_request");
	const first = fields(await ws.call("selfwork.longGoals.save", { title: "合成长目标", instruction: "记录结果" }),
		["id", "title", "instruction", "revision"]);
	assert.deepEqual(await ws.call("selfwork.longGoals.list"), [first]);
	await ws.error("selfwork.longGoals.save", { id: first.id, title: "改名", instruction: "记录结果", revision: 0 }, "conflict");
	assert.deepEqual(await ws.call("selfwork.longGoals.delete", { id: first.id }), { deleted: first.id });
	await ws.error("selfwork.longGoals.delete", { id: first.id }, "not_found");
	await ws.error("selfwork.restoredPlans.confirm", { id: "missing" }, "conflict");
	for (const method of ["selfwork.stop", "selfwork.skills.adopt", "selfwork.skills.delete", "selfwork.skills.rollback"]) {
		await ws.error(method, { id: "missing", version: 1 }, "not_found");
	}
	ws.t.core.db.run(`INSERT INTO selfwork_runs(id,source,state,started_at,day,restore_review_required)
		VALUES('contract-run','learning','held',?,'2000-01-01',1)`, Date.now());
	const [restored] = await ws.call("selfwork.restoredPlans.list") as Json[];
	assert.equal(restored?.id, "contract-run");
	assert.equal(restored?.restore_review_required, 1);
	assert.equal((await ws.call("selfwork.restoredPlans.confirm", { id: restored?.id }) as Json).restore_review_required, 0);
	assert.deepEqual(await ws.call("selfwork.restoredPlans.list"), []);
	assert.equal((await ws.call("selfwork.stop", { id: restored?.id }) as Json).state, "stopped");
	const [run] = await ws.call("selfwork.history") as Json[];
	assert.equal(run?.id, restored?.id);
	ws.t.core.db.run("INSERT INTO selfwork_skills(id,name,active_version) VALUES('fixture-skill','contract-generated-skill',2)");
	for (const version of [1, 2]) ws.t.core.db.run(`INSERT INTO selfwork_skill_versions(skill_id,version,source_ref,description,content,tested_at)
		VALUES('fixture-skill',?,'contract-run','合成说明',?,?)`, version, "---\nname: contract-generated-skill\ndescription: synthetic fixture\n---\nRead fixture.", Date.now());
	const [skill] = await ws.call("selfwork.skills.list") as Json[];
	fields(skill, ["id", "name", "active_version", "adopted_version", "source", "versions"]);
	await ws.error("selfwork.skills.rollback", { id: skill?.id, version: 0 }, "bad_request");
	const skillAt = ws.messages.length;
	assert.equal((await ws.call("selfwork.skills.rollback", { id: skill?.id, version: 1 }) as Json).active_version, 1);
	assert.equal((await ws.call("selfwork.skills.adopt", { id: skill?.id, cwd: ws.t.workspace }) as Json).adopted_version, 1);
	assert.deepEqual(await ws.call("selfwork.skills.delete", { id: skill?.id }), { deleted: skill?.id });
	assert.equal(ws.pushes(skillAt, "skills.changed").length, 3);
});
