import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { GoalsModule, type GoalScheduler } from "../src/modules/goals.ts";
import type { Schedule, ScheduleRun } from "../src/modules/scheduler.ts";
import { appContainerFileAccess } from "../src/sandbox/appcontainer-fs.ts";
import { appContainerWorkspacePath, provisionAppContainer, removeAppContainerProfile, type AppContainerConfig } from "../src/sandbox/appcontainer.ts";
import { settledCount, startTestCore } from "./harness.ts";

const fixturePackage = process.env.DREAMFLUTTER_APPCONTAINER_TEST_PACKAGE;

test("ready Windows AppContainer runs existing Butterfly goals and schedules through DSH", {
	skip: process.platform !== "win32" || !fixturePackage,
	timeout: 120_000,
}, async t => {
	const fixture = await startTestCore(undefined, { dshWorkbench: true, personaClock: () => new Date(2026, 10, 20, 13).getTime() });
	const toolsSource = join(fixture.dir, "appcontainer-tools");
	const config: AppContainerConfig = {
		dataDir: fixture.dir, profileId: randomUUID().replaceAll("-", ""),
		bridgePath: join(fixturePackage!, "core", "bin", "appcontainer-runner.exe"), toolsSource,
	};
	let provisioned = false;
	try {
		await mkdir(toolsSource);
		await copyFile(join(fixturePackage!, "runtime", "node.exe"), join(toolsSource, "node.exe"));
		await provisionAppContainer(config);
		provisioned = true;
		const workspaceDir = appContainerWorkspacePath(config);
		let online = false;
		fixture.core.sandboxProvider = () => ({ kind: "appcontainer", appContainer: config, distro: "fixture-native", workspaceDir,
			ready: async () => {}, online: () => online });
		const files = appContainerFileAccess(config);
		await files.makeDirectory("outbox");
		const call = (method: string, params: Record<string, unknown>) => fixture.core.call(method, params, fixture.client);
		const deliverable = "/workspace/outbox/native-goal.txt";
		const outside = join(fixture.dir, "must-not-exist.txt");
		let goalContext = "";
		fixture.respond(context => {
			goalContext = JSON.stringify(context.messages);
			return fauxAssistantMessage([
				fauxToolCall("write", { file_path: join(workspaceDir, "outbox", "native-goal.txt"), content: "目标在容器内交付" }),
				fauxToolCall("write", { file_path: outside, content: "超范围" }),
			], { stopReason: "toolUse" });
		}, fauxAssistantMessage("[目标已完成]\n文件已交付"), context => {
			const last = context.messages.at(-1)?.content;
			const text = typeof last === "string" ? last : last?.map(block => "text" in block ? block.text : "").join("") ?? "";
			const { revision, evidence_version } = JSON.parse(text);
			return fauxAssistantMessage(JSON.stringify({ verdict: "done", revision, evidence_version, missing: [], next: "", questions: [] }));
		});
		const goal = await call("goals.create", { title: "容器目标", originText: "生成合成文件", mandateRef: "user:native-test",
			spec: { objective: "生成合成文件", deliverables: [deliverable] }, scope: {
				partition: "butterfly", sandbox: true, cwd: fixture.core.paths.butterflyDir,
				allowedTools: ["write"], allowedPaths: ["/workspace/outbox"],
			},
		}) as ReturnType<GoalScheduler["detail"]>;
		const goals = fixture.core.module(GoalsModule)!.scheduler;
		const diagnostic = () => {
			const detail = goals.detail(goal.id);
			return JSON.stringify({ status: detail.status, reason: detail.reason, resumeWhen: detail.resumeWhen,
				checks: goals.latestProgram(goal.id, goal.revision)?.checks, receipts: goals.receipts(goal.id, goal.revision),
				runs: fixture.core.db.all("SELECT status,error FROM runs"), sawDshPrompt: goalContext.includes("Windows AppContainer") });
		};
		const finished = await fixture.waitFor(() => {
			const detail = goals.detail(goal.id);
			return (detail.completed || ["draft", "failed", "paused", "waiting_user"].includes(detail.status)) && detail;
		}, 12_000).catch(() => assert.fail(diagnostic()));
		assert.equal(finished.status, "completed", diagnostic());
		assert.match(goalContext, /Windows AppContainer/);
		assert.match(goalContext, /goal_status/);
		assert.equal((await files.read(deliverable)).data.toString("utf8"), "目标在容器内交付");
		assert.equal(existsSync(outside), false);
		assert.equal(goals.latestProgram(goal.id, goal.revision)?.checks.find(item => item.id === "delivery-file:0")?.status, "passed");
		const taskFile = fixture.core.db.get<{ session_file: string }>("SELECT session_file FROM tasks WHERE goal_id=?", goal.id)?.session_file;
		assert.ok(taskFile && (await readFile(taskFile, "utf8")).includes('"customType":"df.dshSession"'));

		const creator = "create-native-schedule";
		await call("slot.open", { slotId: creator, cwd: fixture.core.paths.butterflyDir, sandbox: true });
		fixture.respond(fauxAssistantMessage([fauxToolCall("schedule_create", {
			name: "容器状态", prompt: "保存一个合成状态", trigger: "interval", every_minutes: 10, kind: "monitor",
		})], { stopReason: "toolUse" }), fauxAssistantMessage("已建立日程"));
		await fixture.send(creator, { id: "create", type: "prompt", message: "添加状态日程" });
		await fixture.waitFor(() => settledCount(fixture.records(creator)) === 1);
		const conversationFile = fixture.core.slot(creator).info().sessionFile;
		assert.ok(conversationFile && (await readFile(conversationFile, "utf8")).includes('"customType":"df.dshSession"'),
			"the interactive Butterfly conversation used the bundled DSH");
		const schedule = (await call("schedules.list", {}) as Schedule[]).find(item => item.owner === "butterfly" && item.name === "容器状态");
		assert.ok(schedule);
		fixture.respond(fauxAssistantMessage([fauxToolCall("schedule_state", { state: { native: true } })], { stopReason: "toolUse" }), fauxAssistantMessage("状态保存完成"));
		await call("schedules.runNow", { id: schedule.id });
		await fixture.waitFor(() => fixture.core.db.get<{ status: string }>("SELECT status FROM schedule_runs WHERE schedule_id=?", schedule.id)?.status === "done");
		const completed = await call("schedules.get", { id: schedule.id }) as Schedule & { runs: ScheduleRun[] };
		assert.deepEqual(completed.state, { native: true });
		const scheduleFile = completed.runs[0]?.sessionFile;
		assert.ok(scheduleFile && (await readFile(scheduleFile, "utf8")).includes('"customType":"df.dshSession"'));
		fixture.core.db.run("INSERT INTO schedule_runs(id,schedule_id,trigger_key,version,status,ended_at) VALUES(?,?,?,1,'failed',?)",
			"native-patrol-input", schedule.id, "manual:native-patrol", Date.now());
		fixture.respond(fauxAssistantMessage([fauxToolCall("patrol_update_log", { status: "handled", note: "核对了失败记录" })],
			{ stopReason: "toolUse" }), fauxAssistantMessage("巡检结束"));
		const patrol = await call("patrol.runNow", {}) as { runId: string };
		const result = await fixture.waitFor(() => {
			const row = fixture.core.db.get<{ status: string; session_file: string; error: string | null }>("SELECT status,session_file,error FROM patrol_runs WHERE id=?", patrol.runId);
			return !!row?.status && row.status !== "running" && row;
		});
		assert.equal(result.status, "handled", result.error ?? undefined);
		assert.ok(result.session_file && (await readFile(result.session_file, "utf8")).includes('"customType":"df.dshSession"'));
		if (process.env.DREAMFLUTTER_LIVE_PUBLIC_DOCS === "1") await t.test("online research reads a public course page through Butterfly", async () => {
			online = true;
			fixture.core.settings.update({ webFetchBackend: "local" });
			const url = "https://ocw.mit.edu/courses/2-854-introduction-to-manufacturing-systems-fall-2016/resources/mit2_854f16_mm1queue/";
			let returned = "";
			fixture.respond(fauxAssistantMessage([fauxToolCall("web_fetch", { url })], { stopReason: "toolUse" }), input => {
				returned = JSON.stringify(input.messages.findLast(message => message.role === "toolResult")?.content);
				return fauxAssistantMessage("资料读取结束");
			});
			await fixture.send(creator, { id: "research", type: "prompt", message: "从 MIT 公开课找出排队模型的资料。" });
			await fixture.waitFor(() => settledCount(fixture.records(creator)) === 2, 75_000);
			assert.match(returned, /HTTP 200/);
			assert.match(returned, /M M 1 Queue|M\/M\/1 Queue/i);
		});
		await t.test("a proactive reply is delivered once and is in the reopened DSH conversation", async () => {
			const slot = fixture.core.slot(creator)!;
			const sessionFile = slot.info().sessionFile!;
			const resolveModel = fixture.core.resolveModel;
			fixture.core.resolveModel = value => {
				const resolved = resolveModel(value);
				return resolved.provider === "faux" ? { ...resolved, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } : resolved;
			};
			fixture.respond(fauxAssistantMessage("主动发来的研究编号是 Z-137。"));
			const proactive = await fixture.core.persona.proactive.request({ reason: "说明刚整理的报告编号", refId: "native-proactive" });
			assert.equal(proactive.ok, true, JSON.stringify(proactive));
			assert.equal(fixture.records(creator).filter(record => record.type === "message_end" && JSON.stringify(record).includes("主动发来的研究编号")).length, 1);
			await call("slot.close", { slotId: creator });
			await call("slot.open", { slotId: creator, cwd: fixture.core.paths.butterflyDir, sandbox: true, sessionFile });
			let found = 0;
			fixture.respond(input => {
				found = input.messages.filter(message => message.role === "assistant" && JSON.stringify(message.content).includes("Z-137")).length;
				return fauxAssistantMessage("记下了。");
			});
			const settled = settledCount(fixture.records(creator));
			await fixture.send(creator, { id: "reply-to-proactive", type: "prompt", message: "我收到了，刚才的编号是什么？" });
			await fixture.waitFor(() => settledCount(fixture.records(creator)) > settled);
			assert.equal(found, 1);
		});
	} finally {
		try {
			await fixture.core.shutdown();
			if (provisioned) await removeAppContainerProfile(config);
		} finally { await fixture.cleanup(); }
	}
});
