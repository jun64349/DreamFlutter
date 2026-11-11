import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { AttentionItem, ActionReceipt } from "../src/modules/attention.ts";
import { GoalScheduler, GoalsModule } from "../src/modules/goals.ts";
import { JobsModule } from "../src/modules/jobs.ts";
import { PersistentShell, persistentPwshTool } from "../src/agent/shell.ts";
import { SandboxShell, sandboxBashTool } from "../src/agent/sandbox-shell.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

type Detail = ReturnType<GoalScheduler["detail"]>;
let t: TestCore;
beforeEach(async () => { t = await startTestCore(); t.core.settings.update({ approvalMode: "off" }); });
afterEach(async () => { await t.cleanup(); });
const goals = () => t.core.module(GoalsModule)!;
const get = (id: string) => goals().scheduler.detail(id);
const create = (extra: Record<string, unknown> = {}) => t.core.call("goals.create", {
	title: "核对报告", originText: "核对材料并交付报告", mandateRef: "user:t102", spec: { objective: "交付报告" },
	scope: { cwd: t.workspace }, ...extra,
}) as Promise<Detail>;
const until = (id: string, condition: (goal: Detail) => boolean) => t.waitFor(() => {
	const detail = get(id);
	return condition(detail) && detail;
}, 10_000).catch(error => {
	const { status, reason, resumeWhen, waits, checks } = get(id);
	throw new Error(`${error.message} ${JSON.stringify({ status, reason, resumeWhen, waits, checks, runs: t.core.db.all("SELECT status,error FROM runs") })}`, { cause: error });
});
const use = (tool: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: "toolUse" });
const done = () => fauxAssistantMessage("[目标已完成]\n已交付");
const verdict = (verdict = "done", wait?: object): FauxResponseFactory => context => {
	const raw = context.messages.at(-1)?.content;
	const { revision, evidence_version } = JSON.parse(typeof raw === "string" ? raw : raw?.map(part => "text" in part ? part.text : "").join("") ?? "");
	return fauxAssistantMessage(JSON.stringify({ verdict, revision, evidence_version, next: "", missing: [], questions: [], wait }));
};
const waitForSlot = () => t.waitFor(() => t.core.sessionSlots().find(slot => slot.started && !!slot.info().sessionFile));
const attention = async () => (await t.core.call("attention.list", {}) as { now: AttentionItem[] }).now;

it("T102 waits for an owned background test, allows chat, and resumes from its exit code", async () => {
	const command = "Start-Sleep -Milliseconds 3500; Write-Output 'finished'";
	t.respond(use("pwsh", { command, description: "执行验收脚本", run_in_background: true }), done(),
		fauxAssistantMessage("你可以继续聊天，测试还在跑"), done(), verdict());
	const goal = await create({ scope: { cwd: t.workspace, externalActions: [{ tool: "pwsh", command }] },
		spec: { objective: "核对测试", acceptance: [{ id: "test", text: "验收脚本通过", layer: "program", check: { kind: "tests_pass", args: { command } } }] } });
	const waiting = await until(goal.id, current => current.status === "waiting_dependency");
	assert.equal(waiting.completed, false);
	assert.equal(waiting.waits[0]?.kind, "compute");
	const job = t.core.db.get<{ goal_id: string; owner_run_id: string; status: string }>("SELECT * FROM jobs WHERE id=?", waiting.waits[0]!.ref)!;
	assert.equal(job.goal_id, goal.id);
	assert.ok(job.owner_run_id);
	assert.equal(job.status, "running");
	const slot = await waitForSlot();
	await t.send(slot.slotId, { id: "hello", type: "prompt", message: "等着的时候能聊天吗？" });
	await until(goal.id, current => current.budgetStatus.used.runs >= 2);
	const finished = await until(goal.id, current => current.completed);
	assert.equal(finished.checks[0]?.detail, "退出码 0");
	assert.equal(finished.waits.length, 0);
	assert.equal(t.core.db.get<{ count: number }>("SELECT count(*) count FROM goal_events WHERE kind='job.finished' AND goal_id=?", goal.id)?.count, 1);
	assert.ok(slot.session.messages.some(message => JSON.stringify(message).includes("你可以继续聊天")));
});

it("T102 lists services without blocking acceptance", async () => {
	const command = "Start-Sleep -Seconds 40";
	t.respond(use("pwsh", { command, description: "启动常驻夹具", run_in_background: true, service: true }), done(), verdict());
	const goal = await create({ scope: { cwd: t.workspace, externalActions: [{ tool: "pwsh", command }] } });
	const finished = await until(goal.id, current => current.completed);
	assert.equal(finished.services.length, 1);
	assert.equal(finished.waits.length, 0);
	await t.core.call("jobs.stop", { id: finished.services[0]!.id });
});

it("T102 holds a child agent until its tracked job ends", async () => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	t.respond(use("agent", { description: "核对夹具", prompt: "只查看报告信息" }), async () => {
		await gate; return fauxAssistantMessage("子任务结束");
	}, done(), verdict());
	const goal = await create({ scope: { cwd: t.workspace, allowedTools: ["agent", "read"] }, budget: { maxParallel: 3 } });
	try {
		const active = await until(goal.id, current => current.waits.some(wait => wait.kind === "compute"));
		assert.equal(active.completed, false);
		assert.equal(t.core.db.get("SELECT 1 FROM goal_reviews WHERE goal_id=?", goal.id), undefined);
		release();
		await until(goal.id, current => current.completed);
		const child = t.core.db.get<{ status: string }>("SELECT status FROM jobs WHERE goal_id=? AND kind='subagent'", goal.id);
		assert.equal(child?.status, "completed");
		assert.ok(goals().scheduler.ledger.entries(goal.id, 10).some(entry => entry.kind === "subagent"));
	} finally { release(); }
});

it("T102 subscribes after review, ignores unrelated events, and blocks on expiry", async () => {
	t.respond(done(), verdict("wait", { kind: "external", event: "external.event", ref: "mail", label: "客户邮件" }), done(), verdict());
	const goal = await create();
	const waiting = await until(goal.id, current => current.status === "waiting_dependency");
	assert.equal(waiting.waits[0]?.label, "客户邮件");
	assert.ok(waiting.waits[0]!.deadline! - Date.now() > 6 * 24 * 60 * 60_000);
	await t.core.call("goals.signal", { id: goal.id, ref: "other", eventId: "not-mail" });
	assert.equal(get(goal.id).status, "waiting_dependency");
	await t.core.call("goals.signal", { id: goal.id, ref: "mail", eventId: "mail-arrived" });
	await until(goal.id, current => current.completed);
	t.respond(use("goal_wait", { kind: "external", event: "external.event", ref: "invoice", label: "发票到达", deadline: Date.now() - 1 }), fauxAssistantMessage("已登记"));
	const overdue = await create();
	const blocked = await until(overdue.id, current => current.status === "blocked");
	assert.match(blocked.resumeWhen ?? "", /等待超时：发票到达/);
});

it("T102 puts collected user questions into the existing attention queue", async () => {
	t.respond(use("goal_wait", { kind: "user", questions: ["要哪一组数据？", "用哪种格式？"] }), fauxAssistantMessage("我等你确认"),
		done(), verdict());
	const goal = await create();
	await until(goal.id, current => current.status === "waiting_user");
	const item = await t.waitFor(() => t.core.confirmations.list({ status: "pending" }).find(item => item.title.includes("要哪一组数据")));
	const projected = (await attention()).find(row => row.target.itemId === item.id);
	assert.equal(projected?.kind, "question");
	assert.match(item.title, /用哪种格式/);
	await t.core.call("attention.resolve", { id: projected!.id, action: "answer", response: { value: "第二组，CSV" } });
	await until(goal.id, current => current.completed);
	const slot = await waitForSlot();
	assert.ok(slot.session.messages.some(message => JSON.stringify(message).includes("第二组，CSV")));
});

it("T102 recovery preserves a running compute wait and pauses when T101 marks it lost", async () => {
	goals().executor.stop();
	const goal = await create();
	const insert = (id: string) => t.core.db.run(`INSERT INTO jobs(id,slot_id,cwd,sandboxed,kind,label,status,started_at,goal_id,goal_revision)
		VALUES(?,'fixture',?,0,'pwsh','验收夹具','running',?,?,1)`, id, t.workspace, Date.now(), goal.id);
	insert("restart-job");
	goals().scheduler.jobChanged("restart-job");
	assert.equal(get(goal.id).status, "waiting_dependency");
	goals().scheduler.recover();
	assert.equal(get(goal.id).status, "waiting_dependency");
	t.core.module(JobsModule)!.start();
	assert.equal(get(goal.id).status, "paused");
	assert.equal(get(goal.id).reason, "restart_check");
	assert.match(get(goal.id).resumeWhen ?? "", /后台重启时这个作业已经不在了/);
});

it("T102 routes a queued correction into the same goal and task", async () => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	t.respond(async () => { await gate; return fauxAssistantMessage("第一轮结束"); },
		use("goal_update", { scope: { allowedTools: ["read"] }, spec: { constraints: [{ text: "只读", kind: "must" }] } }),
		done(), verdict());
	const goal = await create();
	try {
		const slot = await waitForSlot();
		await until(goal.id, current => current.status === "running" && current.budgetStatus.used.runs === 1);
		const task = get(goal.id).currentTaskId;
		await t.send(slot.slotId, { id: "read-only", type: "prompt", message: "刚才那个改成只读", streamingBehavior: "steer" });
		assert.equal(get(goal.id).revision, 1);
		release();
		const finished = await until(goal.id, current => current.completed);
		assert.equal(finished.revision, 2);
		assert.deepEqual(finished.scope.allowedTools, ["read"]);
		assert.equal(finished.currentTaskId, task);
		assert.equal(t.core.db.get<{ count: number }>("SELECT count(*) count FROM goals")?.count, 1);
		assert.equal(t.core.db.get<{ count: number }>("SELECT count(*) count FROM tasks WHERE goal_id=?", goal.id)?.count, 1);
	} finally { release(); }
});

it("T102 starts pending user input ahead of an unclaimed continuation", async () => {
	const slot = await t.core.openSlot({ cwd: t.workspace, client: t.client });
	t.respond(fauxAssistantMessage("你好"), done(), verdict());
	await t.send(slot.slotId, { id: "initial", type: "prompt", message: "你好" });
	await t.waitFor(() => settledCount(t.records(slot.slotId)) === 1);
	const taskId = slot.taskId;
	const goal = await create({ slotId: slot.slotId });
	const pending = goals().scheduler.pendingIntents().find(intent => intent.goal_id === goal.id);
	assert.ok(pending);
	await t.send(slot.slotId, { id: "priority", type: "prompt", message: "现在先按这句话处理" });
	const finished = await until(goal.id, current => current.completed);
	assert.ok(finished.recentEvents.some(event => event.kind === "user.input"));
	assert.equal(finished.currentTaskId, taskId);
	assert.equal(t.core.db.get<{ status: string }>("SELECT status FROM goal_intents WHERE id=?", pending.id)?.status, "dropped");
	assert.match(t.core.db.get<{ prompt: string }>("SELECT prompt FROM runs ORDER BY rowid DESC LIMIT 1")?.prompt ?? "", /现在先按这句话处理/);
	const event = finished.recentEvents.find(event => event.kind === "run.finished");
	assert.ok(event);
	goals().scheduler.post(goal.id, "run.finished", event.dedupeKey, event.payload);
	await t.waitFor(() => t.notifier.sent.some(note => note.title === "目标已完成"));
	assert.equal(t.notifier.sent.filter(note => note.title === "目标已完成").length, 1);
});

it("T102 immediate insertion waits for the tool result before aborting", async () => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	t.core.use({ extensions: () => [pi => { pi.on("tool_result", async event => { if (event.toolName === "goal_status") await gate; }); }] });
	t.respond(use("goal_status", {}), done(), verdict());
	const goal = await create();
	try {
		const slot = await waitForSlot();
		const running = await until(goal.id, current => current.stillRunning.some(item => item.kind === "run" && "tools" in item && Array.isArray(item.tools) && item.tools.length > 0));
		t.client.attached.add(slot.slotId);
		const abort = slot.session.abort.bind(slot.session);
		let aborts = 0;
		slot.session.abort = () => { aborts++; return abort(); };
		await t.send(slot.slotId, { id: "immediate", type: "steer", message: "现在先处理这句" });
		assert.equal(aborts, 0);
		assert.equal(t.core.runs.get(running.stillRunning[0]!.id)?.status, "running");
		release();
		await until(goal.id, current => current.completed);
		assert.equal(aborts, 1);
		assert.equal(t.core.runs.get(running.stillRunning[0]!.id)?.status, "aborted");
		const records = t.records(slot.slotId);
		assert.ok(records.findIndex(row => row.type === "tool_execution_end" && row.toolName === "goal_status")
			< records.findIndex(row => row.type === "agent_settled"));
		assert.equal(t.core.db.get<{ n: number }>("SELECT count(*) n FROM goal_events WHERE goal_id=? AND kind='user.input'", goal.id)?.n, 1);
	} finally { release(); }
});

it("T102 goal_report records a signal and program evidence still gates completion", async () => {
	t.respond(use("goal_report", { status: "done" }), fauxAssistantMessage("报告已提交"));
	const goal = await create({ budget: { maxRuns: 1 }, spec: { objective: "交付报告", acceptance: [
		{ id: "file", text: "产物存在", layer: "program", check: { kind: "file_exists", args: { path: "absent.md" } } },
	] } });
	const limited = await until(goal.id, current => current.reason === "budget_runs");
	assert.equal(limited.completed, false);
	assert.equal(limited.missing[0]?.id, "file");
	assert.ok(limited.recentEvents.some(event => event.kind === "goal.reported"), JSON.stringify((await waitForSlot()).session.messages.slice(-4)));
	assert.equal(goals().scheduler.ledger.entries(goal.id, 10).some(entry => entry.kind === "review"), false);
});

it("T102 butterfly replies normally with an optional goal proposal and accepts edits", async () => {
	t.core.sandboxProvider = () => ({ distro: "df-goal-test", ready: async () => {}, online: () => false });
	const slot = await t.core.openSlot({ cwd: t.core.paths.butterflyDir, sandbox: true, client: t.client });
	const brief = "只用资料文件夹里的数据，先核对来源，再分析趋势，最后交一份报告。";
	t.respond(fauxAssistantMessage("你好，今天想聊什么？"));
	await t.send(slot.slotId, { id: "greeting", type: "prompt", message: "你好" });
	await t.waitFor(() => settledCount(t.records(slot.slotId)) === 1);
	assert.equal((await attention()).some(item => item.kind === "goal_proposal"), false);
	t.respond(use("goal_propose", { title: "交趋势报告", boundary: "资料文件夹", spec: {
		objective: "交付趋势报告", deliverables: ["report.md"], acceptance: [{ id: "read", text: "数据范围正确", layer: "model" }],
	} }), fauxAssistantMessage("我先核对资料，然后开始分析。"));
	await t.send(slot.slotId, { id: "brief", type: "prompt", message: brief });
	await t.waitFor(() => settledCount(t.records(slot.slotId)) === 2);
	assert.ok(slot.session.messages.some(message => JSON.stringify(message).includes("我先核对资料")));
	const item = (await attention()).find(item => item.kind === "goal_proposal");
	assert.ok(item, JSON.stringify(slot.session.messages.slice(-4)));
	assert.deepEqual(item.actions, ["accept", "edit", "reject"]);
	assert.equal(t.core.db.get("SELECT 1 FROM goals"), undefined);
	goals().executor.stop();
	const receipt = await t.core.call("attention.resolve", { id: item.id, action: "edit", response: { draft: { title: "改过的报告目标" } } }) as ActionReceipt;
	assert.equal(receipt.status, "applied");
	const goal = receipt.result as Detail;
	assert.equal(goal.title, "改过的报告目标");
	assert.equal(goal.originText, brief);
	assert.equal(goal.sessionFile, slot.info().sessionFile);
	assert.equal((await attention()).some(item => item.kind === "goal_proposal"), false);
});

it("T102 keeps proposal tools out of workbench chat and disabled butterfly chat", async () => {
	t.core.sandboxProvider = () => ({ distro: "df-goal-test", ready: async () => {}, online: () => false });
	const workbench = await t.core.openSlot({ cwd: t.workspace, client: t.client });
	const butterfly = await t.core.openSlot({ cwd: t.core.paths.butterflyDir, sandbox: true, client: t.client });
	const brief = "只用资料文件夹里的数据，先核对来源，再分析趋势，最后交一份报告。";
	const call = use("goal_propose", { title: "趋势报告", boundary: "资料文件夹", spec: {
		objective: "交付趋势报告", deliverables: ["report.md"], acceptance: [{ id: "report", text: "报告有效", layer: "model" }],
	} });
	t.respond(call, fauxAssistantMessage("工作台正在回复"), call, fauxAssistantMessage("蝶君正在回复"));
	await t.send(workbench.slotId, { id: "workbench", type: "prompt", message: brief });
	await t.waitFor(() => settledCount(t.records(workbench.slotId)) === 1);
	t.core.settings.update({ goalProposalEnabled: false });
	await t.send(butterfly.slotId, { id: "disabled", type: "prompt", message: brief });
	await t.waitFor(() => settledCount(t.records(butterfly.slotId)) === 1);
	assert.equal((await attention()).some(item => item.kind === "goal_proposal"), false);
	assert.equal(t.core.db.get("SELECT 1 FROM goals"), undefined);
	assert.ok(workbench.session.messages.some(message => JSON.stringify(message).includes("Tool goal_propose not found")));
	assert.ok(butterfly.session.messages.some(message => JSON.stringify(message).includes("Tool goal_propose not found")));
	assert.ok(butterfly.session.messages.some(message => JSON.stringify(message).includes("蝶君正在回复")));
});

it("T102 persistent pwsh supplies structured exit codes with identical text", { skip: process.platform !== "win32" }, async () => {
	const shell = new PersistentShell(() => t.workspace);
	const tool = persistentPwshTool(shell);
	try {
		const success = await tool.execute("ok", { command: "Write-Output 'hello t102'" }, undefined, undefined, {} as never);
		assert.deepEqual(success.content, [{ type: "text", text: "hello t102" }]);
		assert.equal((success.details as { exitCode: number }).exitCode, 0);
		const failure = await tool.execute("nonzero", { command: "cmd.exe /d /c exit 7" }, undefined, undefined, {} as never);
		assert.deepEqual(failure.content, [{ type: "text", text: "[exit code: 7]" }]);
		assert.equal((failure.details as { exitCode: number }).exitCode, 7);
	} finally { shell.reset(); }
});

it("T102 foreground bash preserves its text and supplies its protocol exit code", async test => {
	const spawn = childProcess.spawn;
	const fixture = String.raw`
		let calls = 0;
		require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
			const nonce = /__DF_SANDBOX_START_([^_]+)__/.exec(line)?.[1];
			if (!nonce) return;
			const ok = ++calls === 1;
			process.stdout.write('__DF_SANDBOX_START_' + nonce + '__\n' + (ok ? 'hello t102' : '') + '\n'
				+ '__DF_SANDBOX_CWD_' + nonce + ':L3dvcmtzcGFjZQ==\n' + '__DF_SANDBOX_END_' + nonce + ':' + (ok ? 0 : 7) + '\n');
		});
	`;
	const mocked = test.mock.method(childProcess, "spawn", (file: string, args: string[], options: childProcess.SpawnOptions) =>
		file === "wsl.exe" ? spawn(process.execPath, ["-e", fixture], options) : spawn(file, args, options));
	syncBuiltinESMExports();
	const shell = new SandboxShell("df-t102-fixture", async () => {});
	const tool = sandboxBashTool(shell);
	try {
		const ok = await tool.execute("success", { command: "printf hello" }, undefined, undefined, {} as never);
		assert.deepEqual(ok.content, [{ type: "text", text: "hello t102" }]);
		assert.equal((ok.details as { exitCode: number }).exitCode, 0);
		const failure = await tool.execute("failure", { command: "false" }, undefined, undefined, {} as never);
		assert.deepEqual(failure.content, [{ type: "text", text: "[exit code: 7]" }]);
		assert.equal((failure.details as { exitCode: number }).exitCode, 7);
	} finally {
		shell.reset();
		mocked.mock.restore();
		syncBuiltinESMExports();
	}
});

it("T102 stopping a goal discards its queued follow-up", async () => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	t.respond(async () => { await gate; return fauxAssistantMessage("迟到的答复"); }, fauxAssistantMessage("不应开新一轮"));
	const goal = await create();
	try {
		const slot = await waitForSlot();
		await t.waitFor(() => t.faux.state.callCount === 1);
		await t.send(slot.slotId, { id: "queued-before-stop", type: "prompt", message: "请处理排队中的输入" });
		await t.waitFor(() => slot.session.pendingMessageCount > 0);
		await t.core.call("goals.control", { id: goal.id, action: "stop_run" });
		release();
		await until(goal.id, current => current.status === "paused" && !current.stillRunning.length);
		await new Promise(resolve => setTimeout(resolve, 500));
		assert.equal(t.faux.state.callCount, 1);
		assert.equal(slot.session.pendingMessageCount, 0);
	} finally { release(); }
});
