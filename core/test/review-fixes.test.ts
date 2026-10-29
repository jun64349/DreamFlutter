// Regressions for the findings of the v0.1.1 code review.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { acquireLock, releaseLock } from "../src/instance.ts";
import type { Memory } from "../src/modules/memory.ts";
import { redactBackup } from "../src/modules/providers.ts";
import { dueTimes, type Schedule, type ScheduleRun } from "../src/modules/scheduler.ts";
import type { SkillInfo } from "../src/modules/skills.ts";
import type { Notice, Task } from "../src/modules/tasks.ts";
import { corePaths } from "../src/paths.ts";
import { startTestCore, type TestCore } from "./harness.ts";

const MIN = 60_000;

describe("single-instance lock", () => {
	it("refuses a live holder, takes over a stale one, never leaves temp files", () => {
		const dir = mkdtempSync(join(tmpdir(), "df-lock-"));
		const paths = corePaths(dir);
		try {
			writeFileSync(paths.lockFile, String(process.ppid));
			assert.deepEqual(acquireLock(paths), { ok: false, pid: process.ppid });
			writeFileSync(paths.lockFile, "999999");
			assert.deepEqual(acquireLock(paths), { ok: true });
			assert.equal(readFileSync(paths.lockFile, "utf8"), String(process.pid));
			releaseLock(paths);
			assert.ok(!existsSync(paths.lockFile));
			assert.deepEqual(acquireLock(paths), { ok: true });
			releaseLock(paths);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("missed-time math", () => {
	it("finds the true latest occurrence after a very long gap", () => {
		const first = Date.UTC(2020, 0, 1);
		const at = Date.UTC(2026, 0, 1, 0, 30);
		const interval = dueTimes({ type: "interval", everyMs: MIN, anchor: first }, first, at);
		assert.equal(interval.latest, at);
		const cron = dueTimes({ type: "cron", cron: "* * * * *", timezone: "UTC" }, first, at);
		assert.equal(cron.latest, at);
	});
});

describe("credential backups", () => {
	it("keeps structure but removes plain-text keys", () => {
		const dir = mkdtempSync(join(tmpdir(), "df-bak-"));
		const file = join(dir, "auth.json.before-dreamflutter");
		writeFileSync(file, JSON.stringify({ openai: { type: "api_key", key: "sk-plain" }, x: { apiKey: "!cmd" }, y: { apiKey: "$ENV" } }));
		redactBackup(file);
		const text = readFileSync(file, "utf8");
		assert.doesNotMatch(text, /sk-plain/);
		assert.match(text, /!cmd/);
		assert.match(text, /\$ENV/);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("review fixes in the core", () => {
	let t: TestCore;

	beforeEach(async () => {
		t = await startTestCore();
	});

	afterEach(async () => {
		await t.cleanup();
	});

	it("rejects traversal in template names and edited proposal names", async () => {
		const outside = join(t.agentDir, "outside.md");
		writeFileSync(outside, "keep me");
		await assert.rejects(t.core.call("templates.remove", { name: "../outside" }), /模板名/);
		await assert.rejects(t.core.call("templates.save", { name: "ok", body: "x", previousName: "../outside" }), /模板名/);
		assert.ok(existsSync(outside));

		t.respond(
			fauxAssistantMessage([fauxToolCall("skill_propose", { name: "good-name", description: "d", body: "b" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		);
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
		await t.send("s1", { id: "p", type: "prompt", message: "存成技能" });
		const id = await t.waitFor(() => t.core.db.get<{ id: string }>("SELECT id FROM proposals WHERE status = 'pending'")?.id);
		await assert.rejects(t.core.call("proposals.accept", { id, edited: { name: "../../other" } }), /技能名/);
		assert.ok(!existsSync(join(t.agentDir, "..", "other")));
	});

	it("skill paths are judged after resolving '..'", async () => {
		mkdirSync(join(t.agentDir, "skills", "a"), { recursive: true });
		const project = join(t.workspace, "project");
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, "SKILL.md"), "secret");
		const sneaky = join(t.agentDir, "skills", "..", "..", "workspace", "project", "SKILL.md");
		await assert.rejects(t.core.call("skills.read", { filePath: sneaky }), /不是技能文件/);
		await assert.rejects(t.core.call("skills.remove", { filePath: sneaky }), /不是技能文件/);
		assert.ok(existsSync(project));
	});

	it("does not load project skills of an untrusted workspace", async () => {
		const skillDir = join(t.workspace, ".pi", "skills", "proj");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: proj\ndescription: project skill\n---\nx\n");
		writeFileSync(join(t.workspace, ".pi", "settings.json"), "{}");
		const before = (await t.core.call("skills.list", { cwd: t.workspace })) as SkillInfo[];
		assert.ok(!before.some((s) => s.name === "proj"), "untrusted project resources stay unloaded");
	});

	it("opens one runtime when the same session file is opened twice at once", async () => {
		t.respond(fauxAssistantMessage("hi"));
		const first = (await t.core.call("slot.open", { slotId: "a", cwd: t.workspace }, t.client)) as { sessionFile: string };
		await t.send("a", { id: "p", type: "prompt", message: "hello" });
		await t.waitFor(() => t.records("a").some((r) => r.type === "agent_settled"));
		await t.core.call("slot.close", { slotId: "a" });
		const [x, y] = (await Promise.all([
			t.core.call("slot.open", { slotId: "b", cwd: t.workspace, sessionFile: first.sessionFile }, t.client),
			t.core.call("slot.open", { slotId: "c", cwd: t.workspace, sessionFile: first.sessionFile }, t.client),
		])) as { slotId: string }[];
		assert.equal(x!.slotId, y!.slotId);
		assert.equal(t.core.slots.size, 1);
	});

	it("scheduled runs cannot write memory directly, only propose it", async () => {
		t.core.settings.update({ approvalMode: "off" });
		const s = (await t.core.call("schedules.save", { name: "m", prompt: "p", cwd: t.workspace, trigger: { type: "interval", everyMs: 10 * MIN }, allowedTools: [] })) as Schedule;
		t.respond(
			fauxAssistantMessage([fauxToolCall("memory_save", { content: "直接写入", explicit: true })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("memory_save", { content: "候选", explicit: false })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		);
		await t.core.call("schedules.tick", { now: s.nextRunAt });
		await t.waitFor(() => t.core.db.get<{ status: string }>("SELECT status FROM schedule_runs WHERE schedule_id = ?", s.id)?.status === "done");
		assert.equal(((await t.core.call("memory.list", {})) as Memory[]).length, 0);
		assert.equal(((await t.core.call("memory.list", { status: "candidate" })) as Memory[]).length, 1);
		const run = t.core.db.get<{ external_effects: number }>("SELECT external_effects FROM schedule_runs WHERE schedule_id = ?", s.id)!;
		assert.equal(run.external_effects, 0, "candidates are not external effects");
	});

	it("a retry and a new occurrence of one schedule never run at the same time", async () => {
		const s = (await t.core.call("schedules.save", { name: "o", prompt: "p", cwd: t.workspace, trigger: { type: "interval", everyMs: 10 * MIN } })) as Schedule;
		t.core.db.run(
			"INSERT INTO schedule_runs(id, schedule_id, trigger_key, version, scheduled_at, status, attempt, retry_at) VALUES('r1', ?, 'old', ?, ?, 'waiting', 2, ?)",
			s.id,
			s.version,
			s.nextRunAt! - 10 * MIN,
			s.nextRunAt!,
		);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		t.respond(async () => {
			await gate;
			return fauxAssistantMessage("一");
		}, fauxAssistantMessage("二"));
		await t.core.call("schedules.tick", { now: s.nextRunAt });
		const running = t.core.db.all<{ id: string }>("SELECT id FROM schedule_runs WHERE schedule_id = ? AND status = 'running'", s.id);
		assert.equal(running.length, 1);
		assert.equal([...t.core.slots.values()].filter((x) => x.unattended).length, 1);
		release();
		await t.waitFor(() => t.core.db.get("SELECT 1 FROM schedule_runs WHERE schedule_id = ? AND status = 'done'", s.id) !== undefined);
	});

	it("a scheduled run paused by a limit is no longer busy after the user stops it", async () => {
		t.core.settings.update({ approvalMode: "off", maxTurnsUnattended: 1 });
		const s = (await t.core.call("schedules.save", { name: "l", prompt: "p", cwd: t.workspace, trigger: { type: "interval", everyMs: 10 * MIN } })) as Schedule;
		const call = () => fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" });
		t.respond(call(), call(), call());
		await t.core.call("schedules.tick", { now: s.nextRunAt });
		await t.waitFor(() => t.core.db.get<{ status: string }>("SELECT status FROM schedule_runs WHERE schedule_id = ?", s.id)?.status === "needs_input");
		const [notice] = (await t.core.call("notices.list", {})) as Notice[];
		await t.core.call("notices.resolve", { id: notice!.id, action: "stop" });
		const { runs } = (await t.core.call("schedules.get", { id: s.id })) as { runs: ScheduleRun[] };
		assert.equal(runs[0]!.status, "interrupted");
		t.respond(fauxAssistantMessage("again"));
		await t.core.call("schedules.runNow", { id: s.id });
	});

	it("tasks interrupted during their first run are recovered", async () => {
		const task = ((await t.core.call("tasks.create", { cwd: t.workspace, goal: "g" })) as { task: Task }).task;
		t.core.db.run("UPDATE tasks SET status = 'running' WHERE id = ?", task.id);
		t = await t.reopen();
		assert.equal(((await t.core.call("tasks.get", { id: task.id })) as { task: Task }).task.status, "interrupted");
	});
});
