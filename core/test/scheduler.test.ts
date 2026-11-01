import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { nextOccurrence, validateTrigger, type Schedule, type ScheduleRun } from "../src/modules/scheduler.ts";
import type { Task } from "../src/modules/tasks.ts";
import { startTestCore, type TestCore } from "./harness.ts";

const MIN = 60_000;

function capture(into: string[], reply: string): FauxResponseFactory {
	return (context) => {
		into.push(JSON.stringify(context.messages));
		return fauxAssistantMessage(reply);
	};
}

describe("triggers", () => {
	it("interval times are aligned to the anchor; cron follows its timezone", () => {
		const anchor = Date.UTC(2026, 0, 1, 0, 0);
		assert.equal(nextOccurrence({ type: "interval", everyMs: 10 * MIN, anchor }, anchor + 25 * MIN), anchor + 30 * MIN);
		assert.equal(nextOccurrence({ type: "interval", everyMs: 10 * MIN, anchor }, anchor - 1), anchor);
		// 09:00 in Shanghai is 01:00 UTC, every day - not "every 24 hours from now".
		const next = nextOccurrence({ type: "cron", cron: "0 9 * * *", timezone: "Asia/Shanghai" }, Date.UTC(2026, 9, 29, 2, 0));
		assert.equal(new Date(next!).toISOString(), "2026-10-30T01:00:00.000Z");
		assert.equal(nextOccurrence({ type: "once", at: 100 }, 100), null);
		assert.match(validateTrigger({ type: "cron", cron: "bad" })!, /日历规则不正确/);
		assert.match(validateTrigger({ type: "cron", cron: "* * * * *" }, { minIntervalMs: 10 * MIN })!, /至少间隔/);
	});
});

describe("scheduler", () => {
	let t: TestCore;

	beforeEach(async () => {
		t = await startTestCore();
		t.core.settings.update({ approvalMode: "changes" });
	});

	afterEach(async () => {
		await t.cleanup();
	});

	const save = async (params: Record<string, unknown>) =>
		(await t.core.call("schedules.save", { name: "检查", prompt: "检查一下", cwd: t.workspace, ...params })) as Schedule;
	const get = async (id: string) => (await t.core.call("schedules.get", { id })) as Schedule & { runs: (ScheduleRun & { deliveries: { status: string; channel: string }[] })[] };
	const tick = (now: number) => t.core.call("schedules.tick", { now });
	const doneRuns = (id: string) =>
		t.core.db.all<{ status: string }>("SELECT status FROM schedule_runs WHERE schedule_id = ? AND status NOT IN ('running', 'waiting', 'needs_input')", id).length;

	it("runs an interval schedule in an unattended session, records the run, task and delivery", async () => {
		const s = await save({ trigger: { type: "interval", everyMs: 10 * MIN }, kind: "report" });
		assert.ok(s.nextRunAt! > Date.now());
		t.respond(fauxAssistantMessage("报告：一切正常"));
		await tick(s.nextRunAt!);
		await t.waitFor(() => doneRuns(s.id) === 1);
		const after = await get(s.id);
		const [run] = after.runs;
		assert.equal(run!.status, "done");
		assert.equal(run!.result, "报告：一切正常");
		assert.equal(run!.scheduledAt, s.nextRunAt);
		assert.equal(run!.catchUp, false);
		assert.equal(after.nextRunAt, s.nextRunAt! + 10 * MIN);
		assert.deepEqual(run!.deliveries.map((d) => [d.channel, d.status]), [["window", "delivered"]]);
		const task = ((await t.core.call("tasks.list", { source: "schedule" })) as Task[])[0]!;
		assert.equal(task.status, "done");
		assert.equal(task.title, "定时：检查");
		// The unattended slot is closed after the run.
		assert.equal([...t.core.slots.values()].filter((x) => x.unattended).length, 0);
	});

	it("claims each trigger once; edits void triggers of the old version", async () => {
		const s = await save({ trigger: { type: "interval", everyMs: 10 * MIN } });
		t.respond(fauxAssistantMessage("一"), fauxAssistantMessage("二"));
		await Promise.all([tick(s.nextRunAt!), tick(s.nextRunAt!)]);
		await t.waitFor(() => doneRuns(s.id) === 1);
		await tick(s.nextRunAt!);
		assert.equal((await get(s.id)).runs.length, 1);

		// A key from version 1 is not reused after an edit.
		const edited = await save({ id: s.id, prompt: "检查两遍" });
		assert.equal(edited.version, 2);
		const keys = t.core.db.all<{ trigger_key: string }>("SELECT trigger_key FROM schedule_runs").map((r) => r.trigger_key);
		assert.ok(keys.every((k) => k.includes(":v1:")));
	});

	it("missed times: one catch-up for monitors, skip for reports set to skip, one-offs always catch up", async () => {
		const monitor = await save({ name: "监控", trigger: { type: "interval", everyMs: 10 * MIN }, kind: "monitor" });
		t.respond(fauxAssistantMessage("有变化：价格涨了"));
		await tick(monitor.nextRunAt! + 65 * MIN);
		await t.waitFor(() => doneRuns(monitor.id) === 1);
		const [run] = (await get(monitor.id)).runs;
		assert.equal(run!.catchUp, true);
		assert.match(run!.note!, /错过了 7 次/);
		assert.equal(run!.scheduledAt, monitor.nextRunAt! + 60 * MIN, "the most recent missed time");

		const report = await save({ name: "日报", trigger: { type: "interval", everyMs: 10 * MIN }, kind: "report", missedPolicy: "skip" });
		await tick(report.nextRunAt! + 30 * MIN);
		const reportRuns = (await get(report.id)).runs;
		assert.deepEqual(reportRuns.map((r) => r.status), ["skipped"]);

		const once = await save({ name: "提醒", trigger: { type: "once", at: Date.now() + MIN } });
		t.respond(fauxAssistantMessage("提醒你开会"));
		await tick(Date.now() + 3 * 60 * MIN);
		await t.waitFor(() => doneRuns(once.id) === 1);
		const onceAfter = await get(once.id);
		assert.equal(onceAfter.status, "finished");
		assert.equal(onceAfter.runs[0]!.scheduledAt, once.trigger.at);
		assert.equal(onceAfter.runs[0]!.catchUp, true);
	});

	it("does not overlap runs of one schedule: a trigger during a run waits for it", async () => {
		const s = await save({ trigger: { type: "interval", everyMs: 10 * MIN } });
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		t.respond(async () => {
			await gate;
			return fauxAssistantMessage("第一次");
		}, fauxAssistantMessage("补做"));
		await tick(s.nextRunAt!);
		await tick(s.nextRunAt! + 10 * MIN);
		assert.equal((await get(s.id)).runs.length, 1, "the second trigger did not start a parallel run");
		assert.ok(t.core.db.get<{ pending_at: number }>("SELECT pending_at FROM schedules WHERE id = ?", s.id)!.pending_at);
		release();
		await t.waitFor(() => doneRuns(s.id) === 2);
		const runs = (await get(s.id)).runs;
		assert.equal(runs[0]!.catchUp, true);
		assert.match(runs[0]!.note!, /结束后补做/);
	});

	it("retries failures without external effects, but not after a tool changed something", async () => {
		const s = await save({ trigger: { type: "interval", everyMs: 10 * MIN } });
		t.respond(fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad request: model refused" }), fauxAssistantMessage("第二次成功"));
		await tick(s.nextRunAt!);
		await t.waitFor(() => t.core.db.get<{ status: string }>("SELECT status FROM schedule_runs WHERE schedule_id = ?", s.id)?.status === "waiting");
		const waiting = (await get(s.id)).runs[0]!;
		assert.equal(waiting.attempt, 2);
		assert.ok(waiting.retryAt);
		await tick(waiting.retryAt!);
		await t.waitFor(() => doneRuns(s.id) === 1);
		assert.equal((await get(s.id)).runs[0]!.status, "done");

		const risky = await save({ name: "写文件", trigger: { type: "interval", everyMs: 10 * MIN }, allowedTools: ["write"] });
		t.respond(
			fauxAssistantMessage([fauxToolCall("write", { file_path: "x.txt", content: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
		);
		await tick(risky.nextRunAt!);
		await t.waitFor(() => doneRuns(risky.id) === 1);
		const failed = (await get(risky.id)).runs[0]!;
		assert.equal(failed.status, "failed");
		assert.equal(failed.externalEffects, true);
		assert.match(failed.note!, /没有自动重试/);
	});

	it("only allowed tools run, without dialogs", async () => {
		const s = await save({ trigger: { type: "interval", everyMs: 10 * MIN } });
		t.respond(fauxAssistantMessage([fauxToolCall("pwsh", { description: "Write a file", command: "Set-Content x.txt hi" })], { stopReason: "toolUse" }), fauxAssistantMessage("没能运行命令"));
		await tick(s.nextRunAt!);
		await t.waitFor(() => doneRuns(s.id) === 1);
		assert.equal(t.core.confirmations.list({}).length, 0, "no approval dialog in an unattended run");
		const steps = t.core.runs.steps(t.core.runs.list({ limit: 1 })[0]!.id);
		assert.equal(steps.find((x) => x.name === "pwsh")?.status, "error");
	});

	it("monitors keep state between runs and stay quiet when nothing changed", async () => {
		const s = await save({ trigger: { type: "interval", everyMs: 10 * MIN }, kind: "monitor" });
		const seen: string[] = [];
		t.respond(
			fauxAssistantMessage([fauxToolCall("schedule_state", { state: { price: 100 } })], { stopReason: "toolUse" }),
			fauxAssistantMessage("价格是 100"),
			capture(seen, "无变化\n价格仍是 100"),
		);
		await tick(s.nextRunAt!);
		await t.waitFor(() => doneRuns(s.id) === 1);
		assert.deepEqual((await get(s.id)).state, { price: 100 });
		await tick(s.nextRunAt! + 10 * MIN);
		await t.waitFor(() => doneRuns(s.id) === 2);
		assert.match(seen[0]!, /price/);
		const [latest] = (await get(s.id)).runs;
		assert.equal(latest!.status, "no_change");
		assert.equal(latest!.deliveries.length, 0, "no notification when nothing changed");
	});

	it("manual runs do not move the schedule", async () => {
		const s = await save({ trigger: { type: "interval", everyMs: 60 * MIN } });
		t.respond(fauxAssistantMessage("手动结果"));
		await t.core.call("schedules.runNow", { id: s.id });
		await t.waitFor(() => doneRuns(s.id) === 1);
		const after = await get(s.id);
		assert.equal(after.runs[0]!.manual, true);
		assert.equal(after.nextRunAt, s.nextRunAt);
	});

	it("a bound schedule keeps running in the session it was given", async () => {
		const first = await save({ trigger: { type: "interval", everyMs: 60 * MIN } });
		t.respond(fauxAssistantMessage("第一次：价格 100"));
		await t.core.call("schedules.runNow", { id: first.id });
		await t.waitFor(() => doneRuns(first.id) === 1);
		const sessionFile = (await get(first.id)).runs[0]!.sessionFile!;
		assert.ok(sessionFile);

		await assert.rejects(save({ name: "接着", trigger: { type: "interval", everyMs: 60 * MIN }, sessionMode: "bound" }), /需要指定会话/);
		const bound = await save({ name: "接着", trigger: { type: "interval", everyMs: 60 * MIN }, sessionMode: "bound", sessionFile });
		assert.equal(bound.sessionMode, "bound");
		const seen: string[] = [];
		t.respond(capture(seen, "第二次：价格 101"));
		await t.core.call("schedules.runNow", { id: bound.id });
		await t.waitFor(() => doneRuns(bound.id) === 1);
		const [run] = (await get(bound.id)).runs;
		assert.equal(run!.status, "done");
		assert.equal(run!.sessionFile?.toLowerCase(), sessionFile.toLowerCase());
		assert.match(seen[0]!, /第一次：价格 100/, "the second run sees the first run's reply");
	});

	it("schedules proposed by the agent wait for approval and respect the minimum interval", async () => {
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
		t.respond(
			fauxAssistantMessage([fauxToolCall("schedule_create", { name: "太频繁", prompt: "看看", trigger: "interval", every_minutes: 2 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("schedule_create", { name: "每天天气", prompt: "查天气", trigger: "cron", cron: "0 8 * * *", kind: "report" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("已提交"),
		);
		await t.send("s1", { id: "p", type: "prompt", message: "每天早上告诉我天气" });
		await t.waitFor(() => t.records("s1").some((r) => r.type === "agent_settled"));
		const all = (await t.core.call("schedules.list", {})) as Schedule[];
		assert.deepEqual(all.map((x) => [x.name, x.status]), [["每天天气", "pending_approval"]]);
		assert.equal(all[0]!.nextRunAt, null);
		const inbox = (await t.core.call("inbox.list", {})) as { kind: string }[];
		assert.ok(inbox.some((i) => i.kind === "schedule"));
		const approved = (await t.core.call("schedules.setStatus", { id: all[0]!.id, status: "active" })) as Schedule;
		assert.ok(approved.nextRunAt);
	});

	it("runs left running by a crashed core come back interrupted", async () => {
		const s = await save({ trigger: { type: "interval", everyMs: 10 * MIN } });
		t.core.db.run("INSERT INTO schedule_runs(id, schedule_id, trigger_key, version, status) VALUES('x', ?, 'k', 1, 'running')", s.id);
		t = await t.reopen();
		assert.equal((await get(s.id)).runs[0]!.status, "interrupted");
	});
});
