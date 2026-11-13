import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { GoalsModule } from "../../src/modules/goals.ts";
import { JobsModule } from "../../src/modules/jobs.ts";
import { fields, startContractCore, type Json } from "./b-harness.ts";

const goalFields = "id revision title originText spec scope mandateRef source status reason resumeWhen stopIntent currentTaskId budget progress leaseOwner leaseGeneration leaseUntil latestReviewId createdAt updatedAt endedAt sessionFile".split(" ");
const detailFields = [...goalFields, ..."stage next executionEnded artifactsGenerated machineAccepted awaitingAcceptance completed checks missing review artifacts approvals stillRunning waits services irreversible budgetStatus costUnknown recentEvents emergency".split(" ")];
const scheduleFields = "id name prompt cwd owner kind trigger missedPolicy sessionMode sessionFile allowedTools state status version nextRunAt lastRunAt createdBy createdRole createdAt updatedAt describe everyDay lastRun".split(" ");
const watchFields = ["id", "text", "createdBy", "createdAt", "until", "doneAt"];

it("goal draft, revision, control, budget, ledger and errors use WebSocket", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	await ws.t.core.module(GoalsModule)!.executor.stop();
	assert.deepEqual(await ws.call("goals.list"), []);
	assert.deepEqual(await ws.call("goals.approvals"), []);
	assert.deepEqual(await ws.call("goals.proposals"), []);
	const counts = fields(await ws.call("goals.counts"), ["butterfly", "workbench"]);
	for (const value of Object.values(counts)) fields(value, ["running", "done", "blocked", "paused", "decide", "accept"]);
	await ws.error("goals.create", {}, "bad_request");
	const at = ws.messages.length;
	const goal = fields(await ws.call("goals.create", { title: "任务", originText: "请完成合成任务", messageId: "m1",
		scope: { cwd: ws.t.workspace, partition: "workbench", sandbox: false }, spec: { objective: "合成目标" } }), detailFields, ["selfwork"]);
	assert.equal(goal.revision, 1);
	const id = goal.id;
	assert.deepEqual(await ws.call("goals.get", { id }), goal);
	const [view] = await ws.call("goals.list") as Json[];
	fields(view, [...goalFields, "kind", "view", "stage", "next"]);
	fields(await ws.call("goals.budget", { id }), ["limits", "used", "remaining", "reserved"]);
	const edit = fields(await ws.call("goals.update", { id, expectedRevision: 1, spec: { objective: "修订内容" } }), detailFields, ["selfwork"]);
	assert.equal(edit.revision, 2);
	await ws.error("goals.update", { id, expectedRevision: 1 }, "version_conflict");
	const history = await ws.call("goals.history", { id }) as Json[];
	history.forEach(row => fields(row, ["goalId", "revision", "originText", "spec", "scope", "by", "why", "at"]));
	assert.deepEqual(history.map(row => row.revision), [2, 1]);
	assert.deepEqual(await ws.call("goals.ledger", { id }), []);
	const signal = fields(await ws.call("goals.signal", { id, eventId: "1", ref: "fixture" }), ["id", "goalId", "kind", "dedupeKey", "payload", "createdAt", "handledAt", "handledByGeneration"]);
	assert.equal(signal.kind, "external.event");
	await ws.error("goals.control", { id, action: "invalid" }, "bad_request");
	assert.equal((await ws.call("goals.control", { id, action: "pause" }) as Json).status, "paused");
	const changed = ws.pushes(at, "goals.changed").map(event => fields(event, ["event", "id", "status", "revision"]));
	assert.equal(changed[0]?.id, id);
	assert.ok(changed.findIndex(event => event.revision === 1) < changed.findIndex(event => event.revision === 2));
	for (const method of ["goals.get", "goals.ledger", "goals.signal"]) await ws.error(method, { id: "missing" }, "not_found");
	for (const method of ["goals.accept", "goals.reject"]) await ws.error(method, { id: "missing" }, "gone");
	await ws.error("goals.proposals.resolve", { id: "missing", action: "invalid" }, "bad_request");
	await ws.error("goals.proposals.resolve", { id: "missing", action: "reject" }, "not_found");
	for (const [action, revision] of [["accept", 2], ["reject", 3]] as const) {
		ws.t.core.db.run(`INSERT INTO goal_approvals(id,goal_id,revision,kind,status,payload,created_at)
			VALUES(?,?,?,'scope','pending',?,?)`, action, String(id), revision, JSON.stringify({ scope: edit.scope, spec: edit.spec }), Date.now());
		const [approval] = await ws.call("goals.approvals") as Json[];
		fields(approval, ["id", "goalId", "revision", "kind", "payload", "createdAt", "actions"]);
		assert.equal(approval?.id, action);
		fields(await ws.call(`goals.${action}`, { id: action }), detailFields, ["selfwork"]);
		await ws.error(`goals.${action}`, { id: action }, "gone");
	}
	const slot = await ws.call("slot.open", { cwd: ws.t.workspace }) as Json;
	ws.t.core.db.run(`INSERT INTO goal_proposals(id,session_file,message_id,origin_text,draft,created_at,status)
		VALUES('fixture-proposal',?,'message','合成提议',?,?,'pending')`, String(slot.sessionFile), JSON.stringify({ title: "提议" }), Date.now());
	const [proposal] = await ws.call("goals.proposals") as Json[];
	fields(proposal, ["id", "sessionFile", "originText", "createdAt", "draft"]);
	assert.deepEqual(await ws.call("goals.proposals.resolve", { id: proposal?.id, action: "edit" }), { id: proposal?.id, draft: proposal?.draft });
	const proposalAt = ws.messages.length;
	assert.deepEqual(await ws.call("goals.proposals.resolve", { id: proposal?.id, action: "reject" }), { ok: true });
	assert.deepEqual(ws.pushes(proposalAt, "goal.proposals.changed"), [{ event: "goal.proposals.changed" }]);
	await ws.error("goals.proposals.resolve", { id: proposal?.id, action: "reject" }, "gone");
});

it("calendar versions, history, occurrences and watch events have stable shape and order", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	const start = Date.now() + 3_600_000;
	const trigger = { type: "once", at: start };
	fields(await ws.call("schedules.defaults"), ["timezone"]);
	assert.deepEqual(await ws.call("schedules.preview", { trigger }), { error: null, next: [start] });
	await ws.error("schedules.preview", {}, "bad_request");
	assert.deepEqual(await ws.call("schedules.list"), []);
	const at = ws.messages.length;
	const schedule = fields(await ws.call("schedules.save", { name: "合成提醒", kind: "reminder", trigger }), scheduleFields);
	const id = schedule.id;
	assert.deepEqual(await ws.call("schedules.list"), [schedule]);
	const first = ws.pushes(at, "schedules.changed");
	assert.equal(first.length, 1);
	assert.deepEqual(first[0], { event: "schedules.changed", ids: [id], versions: { [String(id)]: 1 } });
	const details = fields(await ws.call("schedules.get", { id }), [...scheduleFields, "runs"]);
	assert.deepEqual(details.runs, []);
	const occurrence = fields(await ws.call("schedules.occurrences", { from: start - 60_000, to: start + 60_000 }), ["items", "schedules"]);
	fields((occurrence.items as Json[])[0], ["scheduleId", "at", "status", "runId", "result", "error"]);
	await ws.error("schedules.occurrences", { from: start, to: start - 1 }, "bad_request");
	await ws.error("schedules.get", { id: "missing" }, "not_found");
	await ws.error("schedules.setStatus", { id, status: "bad" }, "bad_request");
	const paused = fields(await ws.call("schedules.setStatus", { id, status: "paused", expectedVersion: 1 }), scheduleFields);
	assert.deepEqual((await ws.error("schedules.save", { id, expectedVersion: 1, name: "过期" }, "version_conflict")).data, paused);
	const history = await ws.call("schedules.history", { id }) as Json[];
	assert.equal(history.length, 2);
	fields(history[0], ["id", "scheduleId", "actor", "reason", "status", "before", "after", "summary", "versionBefore", "versionAfter", "at", "undoneAt"]);
	const undone = fields(await ws.call("schedules.undo", { changeId: history[0]!.id }), scheduleFields);
	assert.equal(undone.status, "active");
	assert.equal(undone.version, 3);
	await ws.error("schedules.undo", { changeId: "missing" }, "not_found");
	assert.deepEqual(await ws.call("schedules.tick", { now: start - 1 }), { ok: true });
	const run = await ws.call("schedules.runNow", { id }) as Json;
	assert.equal(run.scheduleId, id);
	assert.equal(run.status, "done");
	assert.deepEqual(await ws.call("schedules.remove", { id, expectedVersion: 3 }), { ok: true });
	const slot = await ws.call("slot.open", { cwd: ws.t.workspace }) as Json;
	const bound = fields(await ws.call("schedules.fromSession", { slotId: slot.slotId, prompt: "合成任务", trigger }), scheduleFields);
	assert.equal(bound.sessionMode, "bound");
	await ws.error("schedules.fromSession", { slotId: slot.slotId, trigger }, "bad_request");
	const deliveryAt = ws.messages.length;
	ws.t.respond(fauxAssistantMessage([fauxToolCall("save_monitor_state", { state: { fixture: true } })], { stopReason: "toolUse" }),
		fauxAssistantMessage("定时任务完成"));
	const boundRun = fields(await ws.call("schedules.runNow", { id: bound.id }), "id scheduleId triggerKey version scheduledAt startedAt endedAt manual catchUp status attempt retryAt taskId sessionFile result error note externalEffects cost".split(" "));
	await ws.t.waitFor(() => ws.pushes(deliveryAt, "schedules.delivered").some(event => event.runId === boundRun.id));
	const delivered = ws.pushes(deliveryAt, "schedules.delivered").filter(event => event.runId === boundRun.id);
	assert.equal(delivered.length, 1);
	fields(delivered[0], ["event", "runId", "title", "body", "target"]);
	assert.deepEqual((await ws.call("schedules.get", { id: bound.id }) as Json).state, { fixture: true });
	const watchAt = ws.messages.length;
	const watch = fields(await ws.call("watch.save", { text: "观察合成记录" }), watchFields);
	assert.deepEqual(await ws.call("watch.list"), [watch]);
	fields(await ws.call("watch.done", { id: watch.id }), watchFields);
	assert.deepEqual(await ws.call("watch.remove", { id: watch.id }), { ok: true });
	assert.equal(ws.pushes(watchAt, "watch.changed").length, 3);
});

it("patrol emits progress then a single terminal event and job queries report missing IDs", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	ws.t.core.sandboxProvider = () => ({ distro: "df-contract-patrol", ready: async () => {}, online: () => false });
	fields(await ws.call("patrol.status"), ["enabled", "intervalMin", "nextAt", "running", "lastRun", "budgetUsedToday", "budgetLimit", "quietNow", "cooldownUntil"]);
	const before = ws.messages.length;
	const { runId } = fields(await ws.call("patrol.runNow"), ["runId"]);
	await ws.t.waitFor(() => ws.pushes(before, "patrol.finished").some(event => event.runId === runId));
	const [log] = await ws.call("patrol.log", { limit: 1 }) as Json[];
	fields(log, ["id", "startedAt", "endedAt", "status", "manual", "facts", "newFacts", "factsHash", "note", "actions", "notified", "notificationState", "notificationNote", "model", "cost", "error", "sessionFile", "sessionAvailable"]);
	const changes = ws.pushes(before, "patrol.changed", "patrol.finished");
	assert.equal(changes[0]?.event, "patrol.changed");
	assert.deepEqual(changes.filter(event => event.event === "patrol.finished"), [{ event: "patrol.finished", runId, status: log!.status }]);
	await ws.error("patrol.runNow", {}, "cooldown");
	assert.deepEqual(await ws.call("jobs.list"), []);
	await ws.error("jobs.list", { status: "missing" }, "bad_request");
	await ws.error("jobs.output", { id: "missing" }, "not_found");
	await ws.error("jobs.stop", { id: "missing" }, "not_found");
	const cache = join(ws.t.core.paths.cacheDir, "jobs");
	mkdirSync(cache, { recursive: true });
	const output = join(cache, "contract-job.log");
	writeFileSync(output, "记录");
	ws.t.core.db.run(`INSERT INTO jobs(id,slot_id,cwd,sandboxed,kind,label,status,exit_code,started_at,ended_at,output_path)
		VALUES('contract-job','slot',?,0,'pwsh','测试作业','completed',0,1,2,?)`, ws.t.workspace, output);
	const [job] = await ws.call("jobs.list", { slotId: "slot" }) as Json[];
	fields(job, "id session_file slot_id cwd sandboxed kind label command service status exit_code detail started_at ended_at stopped_by output_path goal_id owner_run_id goal_revision outputBytes".split(" "));
	assert.deepEqual(await ws.call("jobs.output", { id: job!.id }), { text: "记录", next: 6, truncated: false, ended: true });
	await ws.error("jobs.output", { id: job!.id, from: -1 }, "bad_request");
	assert.deepEqual(await ws.call("jobs.stop", { id: job!.id }), { ok: true, status: "completed" });
	const slot = await ws.call("slot.open", { cwd: ws.t.workspace }) as Json;
	const at = ws.messages.length;
	const tracked = ws.t.core.module(JobsModule)!.trackSubagent(ws.t.core.slot(slot.slotId), ws.t.workspace, "合成作业", () => {});
	assert.ok(tracked);
	tracked.append("输出");
	tracked.finish({ status: "completed", exitCode: 0 });
	await ws.t.waitFor(() => ws.pushes(at, "job.finished").length === 1);
	const events = ws.pushes(at, "jobs.changed", "job.finished");
	assert.deepEqual(events.map(event => [event.event, event.status]), [["jobs.changed", "running"], ["jobs.changed", "completed"], ["job.finished", "completed"]]);
	assert.equal(new Set(events.map(event => event.id)).size, 1);
});

it("a patrol can call its report tool through the fake model", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	ws.t.core.sandboxProvider = () => ({ distro: "df-contract-patrol-tool", ready: async () => {}, online: () => false });
	const schedule = await ws.call("schedules.save", {
		name: "蝶君测试巡检", cwd: ws.t.core.paths.butterflyDir, prompt: "核对",
		trigger: { type: "once", at: Date.now() + 3_600_000 },
	}) as Json;
	ws.t.core.db.run("INSERT INTO schedule_runs(id,schedule_id,trigger_key,version,status,ended_at) VALUES('patrol-fixture',?,'fixture',1,'failed',?)",
		String(schedule.id), Date.now());
	ws.t.respond(fauxAssistantMessage([fauxToolCall("patrol_update_log", { note: "巡检工具已执行", status: "handled" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("巡检结束"));
	const from = ws.messages.length;
	const { runId } = fields(await ws.call("patrol.runNow"), ["runId"]);
	await ws.t.waitFor(() => ws.pushes(from, "patrol.finished").some(event => event.runId === runId));
	const [log] = await ws.call("patrol.log", { limit: 1 }) as Json[];
	assert.equal(log?.status, "handled");
	assert.equal(log?.note, "巡检工具已执行");
});

it("target execution activates goal status, update, report and wait tools", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	ws.t.core.settings.update({ approvalMode: "off" });
	const from = ws.messages.length;
	ws.t.respond(fauxAssistantMessage([
		fauxToolCall("goal_status", {}),
		fauxToolCall("goal_update", {}),
		fauxToolCall("goal_report", { status: "blocked", note: "合成测试待定" }),
		fauxToolCall("goal_wait", { kind: "user", questions: ["测试数据选哪一组？"] }),
	], { stopReason: "toolUse" }), fauxAssistantMessage("已记录等待"));
	const created = await ws.call("goals.create", { title: "合成目标", originText: "核对数据", messageId: "tools",
		scope: { cwd: ws.t.workspace }, spec: { objective: "核对测试数据" } }) as Json;
	const slot = await ws.t.waitFor(() => ws.t.core.sessionSlots().find(slot => slot.started));
	await ws.call("slot.attach", { slotId: slot.slotId });
	await ws.t.waitFor(() => ws.pushes(from, "goals.changed").some(event => event.id === created.id && ["waiting_user", "blocked"].includes(String(event.status))));
	const messages = fields((await ws.command(slot.slotId, "get_messages")).data, ["messages"]).messages as Json[];
	const results = messages.filter(message => message.role === "toolResult");
	for (const name of ["goal_status", "goal_update", "goal_report", "goal_wait"]) {
		const result = results.find(message => message.toolName === name);
		assert.ok(result, name);
		assert.ok(Array.isArray(result.content) && result.content.length > 0);
		assert.equal(typeof result.isError, "boolean");
	}
});
