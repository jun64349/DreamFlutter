import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Schedule, ScheduleRun } from "../src/modules/scheduler.ts";
import { SANDBOX_ENTRY } from "../src/pi/host.ts";
import { MIGRATIONS } from "../src/schema.ts";
import { startTestCore, type TestCore } from "./harness.ts";

const trigger = { type: "interval", everyMs: 60 * 60_000 };
let t: TestCore;
beforeEach(async () => { t = await startTestCore(); });
afterEach(async () => { await t.cleanup(); });

function sandbox(ready = async () => {}) {
	t.core.sandboxProvider = () => ({ distro: "df-t95-test", ready, online: () => false });
}

it("runs a fresh schedule created by 蝶君 in its sandbox, with its conversation and notification", async () => {
	sandbox();
	const home = t.core.paths.butterflyDir;
	const source = await t.core.openSlot({ slotId: "source", sandbox: true, cwd: home, client: t.client });
	assert.ok(source.session.getAllTools().some(tool => tool.name === "schedule_create"));
	t.respond(fauxAssistantMessage([fauxToolCall("schedule_create", { name: "早报", prompt: "简报", trigger: "interval", every_minutes: 60 })], { stopReason: "toolUse" }), fauxAssistantMessage("已安排"));
	await t.send(source.slotId, { id: "create", type: "prompt", message: "每小时简报" });
	await t.waitFor(() => t.records(source.slotId).some(record => record.type === "agent_settled"));
	const [schedule] = await t.core.call("schedules.list", {}) as Schedule[];
	assert.equal(schedule?.owner, "butterfly");
	await t.core.call("schedules.setStatus", { id: schedule.id, status: "active" });
	let launched: { sandboxed: boolean; cwd: string } | undefined;
	t.respond(() => {
		launched = t.core.sessionSlots().find(slot => slot.unattended);
		return fauxAssistantMessage("简报已完成");
	});
	const run = await t.core.call("schedules.runNow", { id: schedule.id }) as ScheduleRun;
	const delivery = await t.waitFor(() => t.messages.find(message => message.event === "schedules.delivered" && message.runId === run.id));
	assert.equal(launched?.sandboxed, true);
	assert.equal(launched?.cwd, home);
	assert.match(String(delivery.title), /^蝶君/);
	const sessions = await t.core.call("sessions.list", { cwd: home }) as { path: string }[];
	const done = await t.core.call("schedules.get", { id: schedule.id }) as Schedule & { runs: ScheduleRun[] };
	assert.ok(sessions.some(session => session.path === done.runs[0]?.sessionFile));
	assert.equal(t.core.db.get<{ cwd: string }>("SELECT cwd FROM tasks WHERE schedule_id = ?", schedule.id)?.cwd, home);
});

it("infers a bound sandbox session's owner from the saved file and keeps its conversation", async () => {
	sandbox();
	const bound = await t.core.openSlot({ cwd: t.workspace, sandbox: true, client: t.client });
	t.respond(fauxAssistantMessage("上一次的结果"));
	await t.send(bound.slotId, { id: "seed", type: "prompt", message: "记录结果" });
	await t.waitFor(() => t.records(bound.slotId).some(record => record.type === "agent_settled"));
	const file = bound.info().sessionFile!;
	await t.core.closeSlot(bound.slotId);
	const schedule = await t.core.call("schedules.save", { name: "继续", prompt: "接着做", cwd: t.workspace, trigger, sessionMode: "bound", sessionFile: file }) as Schedule;
	assert.equal(schedule.owner, "butterfly");
	t.respond(context => {
		assert.match(JSON.stringify(context.messages), /上一次的结果/);
		return fauxAssistantMessage("这一次的结果");
	});
	const started = await t.core.call("schedules.runNow", { id: schedule.id }) as ScheduleRun;
	assert.equal(started.sessionFile, file);
	await t.waitFor(() => t.core.db.get("SELECT 1 FROM schedule_runs WHERE id = ? AND status = 'done'", started.id));
});

it("does not register schedule_create in a workbench conversation", async () => {
	const slot = await t.core.openSlot({ cwd: t.workspace });
	assert.ok(!slot.session.getAllTools().some(tool => tool.name === "schedule_create"));
});

it("fails before opening a session when the butterfly sandbox cannot be prepared", async () => {
	const schedule = await t.core.call("schedules.save", { name: "检查", prompt: "检查一下", cwd: t.core.paths.butterflyDir, trigger }) as Schedule;
	assert.equal(schedule.owner, "butterfly");
	sandbox(async () => { throw new Error("not ready"); });
	const run = await t.core.call("schedules.runNow", { id: schedule.id }) as ScheduleRun;
	assert.equal(run.status, "failed");
	assert.equal(run.error, "蝶君的沙箱还没准备好");
	assert.equal(run.sessionFile, null);
	assert.equal(t.core.sessionSlots().length, 0);
	assert.equal(t.core.db.get("SELECT 1 FROM tasks WHERE schedule_id = ?", schedule.id), undefined);
});

it("migrates legacy rows by butterfly home or the bound session marker", async () => {
	const { dbFile, butterflyDir } = t.core.paths;
	const manager = SessionManager.create(t.workspace, t.sessionDir);
	manager.appendCustomEntry(SANDBOX_ENTRY, { sandbox: true });
	manager.appendMessage(fauxAssistantMessage("保存这段会话"));
	const file = manager.getSessionFile()!;
	const empty = join(t.sessionDir, "empty.jsonl");
	writeFileSync(empty, "");
	await t.core.shutdown();
	unlinkSync(dbFile);
	const legacy = new DatabaseSync(dbFile);
	try {
		for (const migration of MIGRATIONS.slice(0, 16)) legacy.exec(migration);
		legacy.exec("PRAGMA user_version = 16");
		const insert = legacy.prepare(`INSERT INTO schedules(id, name, prompt, cwd, kind, trigger, missed_policy, session_mode, session_file, status, created_by, created_at, updated_at)
			VALUES(?, '旧任务', '检查', ?, 'task', ?, 'skip', ?, ?, 'paused', 'agent', 1, 1)`);
		for (const [id, cwd, sessionMode, sessionFile] of [
			["home", butterflyDir, "fresh", null],
			["child", join(butterflyDir, "子目录"), "fresh", null],
			["bound", t.workspace, "bound", file],
			["empty", t.workspace, "bound", empty],
			["workbench", `${butterflyDir}-other`, "fresh", null],
		] as const) insert.run(id, cwd, JSON.stringify(trigger), sessionMode, sessionFile);
	} finally { legacy.close(); }
	t = await startTestCore(t.dir);
	const owners = t.core.db.all<{ id: string; owner: string }>("SELECT id, owner FROM schedules ORDER BY id");
	assert.deepEqual(owners.map(row => [row.id, row.owner]), [["bound", "butterfly"], ["child", "butterfly"], ["empty", "workbench"], ["home", "butterfly"], ["workbench", "workbench"]]);
	assert.equal(readFileSync(empty, "utf8"), "", "owner migration reads session metadata without rewriting the file");
});
