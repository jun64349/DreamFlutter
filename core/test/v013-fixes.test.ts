// v0.13 real-task verification (docs/releases/v0.13-真实任务验证回执.md): three product
// problems found with the real model, each with a test that fails without its fix.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SchedulerModule, type Schedule, type ScheduleRun } from "../src/modules/scheduler.ts";
import { startTestCore, settledCount } from "./harness.ts";

test("v0.13 a conversation opened before a skill was approved can load it afterwards", async () => {
	const t = await startTestCore();
	const server = createServer((_req, res) => res.end("---\nname: df-v013-stamp\ndescription: 核对算式并盖章\n---\n# 梦蝶核对章\n回复最后写【梦蝶核对 V013】\n"));
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	try {
		t.core.settings.update({ approvalMode: "off" });
		// The window keeps a blank new conversation open: it exists before the approval.
		await t.core.call("slot.open", { slotId: "open-before", cwd: t.workspace }, t.client);
		await t.core.call("skills.importUrl", { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/SKILL.md` });
		const [proposal] = (await t.core.call("proposals.list", { status: "pending" })) as { id: string }[];
		await t.core.call("proposals.accept", { id: proposal!.id });
		const before = settledCount(t.records("open-before"));
		t.respond(fauxAssistantMessage([fauxToolCall("skill", { name: "df-v013-stamp" } as never)], { stopReason: "toolUse" }), fauxAssistantMessage("done"));
		await t.send("open-before", { type: "prompt", message: "盖核对章" });
		await t.waitFor(() => settledCount(t.records("open-before")) > before);
		const end = t.records("open-before").filter((r) => r.type === "tool_execution_end" && r.toolName === "skill").at(-1) as { isError: boolean; result: { content: { text: string }[] } };
		assert.equal(end.isError, false, end.result.content[0]?.text);
		assert.match(end.result.content[0]!.text, /梦蝶核对 V013/);
		// Disabling it again still takes effect in the same open conversation.
		const skill = ((await t.core.call("skills.list", { cwd: t.workspace })) as { name: string; filePath: string }[]).find((s) => s.name === "df-v013-stamp")!;
		await t.core.call("skills.setEnabled", { filePath: skill.filePath, enabled: false });
		const again = settledCount(t.records("open-before"));
		t.respond(fauxAssistantMessage([fauxToolCall("skill", { name: "df-v013-stamp" } as never)], { stopReason: "toolUse" }), fauxAssistantMessage("done"));
		await t.send("open-before", { type: "prompt", message: "再盖一次" });
		await t.waitFor(() => settledCount(t.records("open-before")) > again);
		const refused = t.records("open-before").filter((r) => r.type === "tool_execution_end" && r.toolName === "skill").at(-1) as { isError: boolean };
		assert.equal(refused.isError, true);
	} finally {
		server.close();
		await t.cleanup();
	}
});

test("v0.13 蝶君's own schedules are not told they are read-only; host schedules still are", async () => {
	const t = await startTestCore();
	try {
		const scheduler = t.core.module(SchedulerModule)! as unknown as {
			claim(s: Schedule, at: number | null, o?: object): ScheduleRun; active: Map<string, string>;
			toolPolicy(slot: unknown, tool: string, input?: Record<string, unknown>): string | undefined;
			composePrompt(s: Schedule, r: ScheduleRun): string;
		};
		const trigger = { type: "interval", everyMs: 3_600_000 };
		// The 时令 page leaves cwd out for 「蝶君去做」: the schedule belongs to 蝶君.
		const own = (await t.core.call("schedules.save", { name: "蝶君写文件", kind: "task", prompt: "写一个文件", trigger })) as Schedule;
		const host = (await t.core.call("schedules.save", { name: "工作台写文件", kind: "task", prompt: "写一个文件", cwd: t.workspace, trigger })) as Schedule;
		assert.equal(own.owner, "butterfly");
		const ownRun = scheduler.claim(own, Date.now(), { manual: true }), hostRun = scheduler.claim(host, Date.now(), { manual: true });
		scheduler.active.set("own", ownRun.id); scheduler.active.set("host", hostRun.id);
		// The sandbox session itself allows every tool (core approval override); only the prompt
		// used to tell the model it was read-only, so it never tried.
		assert.equal(scheduler.toolPolicy({ slotId: "host", sandboxed: false }, "write", { file_path: "a.txt", content: "x" }), "deny");
		assert.doesNotMatch(scheduler.composePrompt(own, ownRun), /只读|只放行/);
		assert.match(scheduler.composePrompt(host, hostRun), /只放行只读工具/);
	} finally {
		await t.cleanup();
	}
});

test("v0.13 a scheduled run whose tools were refused is not reported as done", async () => {
	const t = await startTestCore();
	try {
		const s = (await t.core.call("schedules.save", { name: "写文件", kind: "task", prompt: "写 x.txt", cwd: t.workspace, trigger: { type: "interval", everyMs: 600_000 } })) as Schedule;
		t.respond(fauxAssistantMessage([fauxToolCall("write", { file_path: "x.txt", content: "hi" })], { stopReason: "toolUse" }), fauxAssistantMessage("已经写好了"));
		await t.core.call("schedules.tick", { now: s.nextRunAt! });
		const run = await t.waitFor(() => t.core.db.get<{ status: string; error: string | null; task_id: string | null; attempt: number; retry_at: number | null }>(
			"SELECT status, error, task_id, attempt, retry_at FROM schedule_runs WHERE schedule_id = ? AND status NOT IN ('running', 'waiting', 'needs_input')", s.id));
		assert.equal(run.status, "failed", "a refused write is objective evidence it was not done");
		assert.match(run.error ?? "", /没有放行：write/);
		assert.equal(run.retry_at, null, "the same permissions would refuse a retry");
		assert.equal(t.core.db.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", run.task_id)?.status, "failed");
	} finally {
		await t.cleanup();
	}
});
