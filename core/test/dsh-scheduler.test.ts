import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Schedule, ScheduleRun } from "../src/modules/scheduler.ts";
import { settledCount, startTestCore } from "./harness.ts";

test("scheduled workbench runs use DSH, save monitor state, resume a bound session and stop on denied tools", async () => {
	const fixture = await startTestCore(undefined, { dshWorkbench: true });
	try {
		const call = (method: string, params: Record<string, unknown>) => fixture.core.call(method, params, fixture.client);
		const save = (options: Record<string, unknown> = {}) => call("schedules.save", {
			name: "DSH 检查", prompt: "核对合成价格", cwd: fixture.workspace, kind: "monitor",
			trigger: { type: "interval", everyMs: 600_000 }, ...options,
		}) as Promise<Schedule>;
		const run = async (id: string) => {
			await call("schedules.runNow", { id });
			return fixture.waitFor(() => fixture.core.db.get<{ status: string }>(
				"SELECT status FROM schedule_runs WHERE schedule_id=? AND status IN ('done','no_change','failed')", id)?.status);
		};
		const detail = (id: string) => call("schedules.get", { id }) as Promise<Schedule & { runs: ScheduleRun[] }>;
		const first = await save();
		fixture.respond(
			fauxAssistantMessage([fauxToolCall("save_monitor_state", { state: { price: 100 } })], { stopReason: "toolUse" }),
			fauxAssistantMessage("第一次：合成价格 100"),
		);
		assert.equal(await run(first.id), "done");
		const finished = await detail(first.id);
		assert.deepEqual(finished.state, { price: 100 });
		const sessionFile = finished.runs[0]?.sessionFile;
		assert.ok(sessionFile);
		assert.ok((await readFile(sessionFile, "utf8")).includes('"customType":"df.dshSession"'));

		const bound = await save({ name: "继续检查", sessionMode: "bound", sessionFile });
		let restored = "";
		fixture.respond(context => {
			restored = JSON.stringify(context.messages);
			return fauxAssistantMessage("无变化\n合成价格仍是 100");
		});
		assert.equal(await run(bound.id), "no_change", JSON.stringify((await detail(bound.id)).runs[0]));
		assert.match(restored, /第一次：合成价格 100/);
		assert.equal((await detail(bound.id)).runs[0]!.sessionFile, sessionFile);

		const denied = await save({ name: "拒绝越权写入", kind: "task", allowedTools: [] });
		const path = join(fixture.workspace, "must-not-be-created.txt");
		fixture.respond(
			fauxAssistantMessage([fauxToolCall("write", { file_path: path, content: "禁止写入" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("模型声称完成"),
		);
		assert.equal(await run(denied.id), "failed");
		const rejected = (await detail(denied.id)).runs[0]!;
		assert.equal(rejected.attempt, 1);
		assert.match(rejected.error ?? "", /需要的工具没有放行：write/);
		assert.equal(existsSync(path), false);

		await call("slot.open", { slotId: "ordinary-workbench", cwd: fixture.workspace, agentMode: "minimal" });
		fixture.respond(fauxAssistantMessage("普通工作台内容"));
		await fixture.send("ordinary-workbench", { id: "ordinary", type: "prompt", message: "普通对话" });
		await fixture.waitFor(() => settledCount(fixture.records("ordinary-workbench")) === 1);
		const ordinary = fixture.core.slots.get("ordinary-workbench")!;
		assert.ok(ordinary.hasDshHistory());
		const ordinaryFile = ordinary.info().sessionFile;
		assert.ok(ordinaryFile);
		const overlaid = await save({ sessionMode: "bound", sessionFile: ordinaryFile });
		let taskInput = "";
		fixture.respond(context => {
			taskInput = JSON.stringify(context.messages);
			return fauxAssistantMessage([fauxToolCall("save_monitor_state", { state: { price: 105 } })], { stopReason: "toolUse" });
		}, fauxAssistantMessage("任务完成"));
		assert.equal(await run(overlaid.id), "done");
		assert.match(taskInput, /普通工作台内容/);
		assert.match(taskInput, /save_monitor_state/);
		assert.deepEqual((await detail(overlaid.id)).state, { price: 105 });

		await fixture.waitFor(() => !ordinary.running);
		const priorTurns = settledCount(fixture.records("ordinary-workbench"));
		let ordinaryInput = "";
		fixture.respond(context => {
			const declarations = context.messages.filter(message => message.role === "system").flatMap(message => message.toolsAdded ?? []);
			ordinaryInput = JSON.stringify(declarations.map(tool => tool.name));
			return fauxAssistantMessage("恢复普通工作台");
		});
		await fixture.send("ordinary-workbench", { id: "after-task", type: "prompt", message: "继续普通对话" });
		await fixture.waitFor(() => settledCount(fixture.records("ordinary-workbench")) === priorTurns + 1);
		assert.match(ordinaryInput, /working_directory/);
		assert.doesNotMatch(ordinaryInput, /save_monitor_state/);
	} finally {
		await fixture.cleanup();
	}
});
