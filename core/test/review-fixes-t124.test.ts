import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { SandboxShell } from "../src/agent/sandbox-shell.ts";
import { PythonKernel } from "../src/agent/python-kernel.ts";
import { ButterflyModule } from "../src/modules/butterfly.ts";
import { GoalsModule } from "../src/modules/goals.ts";
import { allowedTool } from "../src/modules/goals/acceptance.ts";
import { selfworkDeliverable } from "../src/modules/goals/selfwork.ts";
import { sandboxGoalTools, type Rule } from "../src/modules/autonomy/rules.ts";
import { blockedGoalTools } from "../scripts/autonomy/exercise.ts";
import { startTestCore } from "./harness.ts";

const TASK = "请先核对两份资料，再汇总，最后交付 report.md。";
const report = "已经核对两份资料，合计 7，差 1。";
const ruleDef = { name: "核对资料", source: "schedule", task: "核对沙箱内的记录", actions: ["read"] };
const bash = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command })]);
const python = (code: string) => fauxAssistantMessage([fauxToolCall("python", { code })]);
const done = () => fauxAssistantMessage([fauxToolCall("goal_report", { status: "done", note: report })]);
type Hit = { eventId: string; reason: string; costUsd: number };

async function fixture(test: TestContext) {
	const t = await startTestCore();
	test.after(() => t.cleanup());
	const goals = t.core.module(GoalsModule)!;
	goals.executor.stop();
	const local = (logical: string) => join(t.dir, "sandbox", logical.slice("/workspace".length));
	let online = false;
	t.core.sandboxProvider = () => ({ distro: "DF-T124-fake", ready: async () => {}, online: () => online });
	t.core.autonomy.sandboxFile = async path => local(path);
	t.core.module(ButterflyModule)!.local = local;
	t.core.settings.update({ patrolQuietEnabled: false });
	return {
		t, goals, local,
		setOnline(value: boolean) { online = value; },
		price(cap?: number) {
			const resolve = t.core.resolveModel;
			t.core.resolveModel = model => {
				const selected = resolve(model);
				return selected.provider === "faux" ? { ...selected, maxTokens: cap ?? selected.maxTokens,
					cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } : selected;
			};
		},
		async assignment() {
			const slot = await t.core.openSlot({ cwd: t.core.paths.butterflyDir, sandbox: true, client: t.client });
			const sessionFile = slot.session.sessionFile!;
			await t.send(slot.slotId, { type: "prompt", id: "t124-work", message: TASK });
			const tasks = await t.core.call("butterfly.chat.tasks", { sessionFile }) as { goalId: string; deliverables: string[] }[];
			assert.equal(tasks.length, 1);
			const goal = await t.waitFor(() => goals.scheduler.get(tasks[0]!.goalId));
			return { goal, task: tasks[0]!, sessionFile };
		},
		save(assess = false) {
			return t.core.call("autonomy.rules.save", { rule: { ...ruleDef, assess }, mode: assess ? "observe" : "auto" }) as Promise<Rule>;
		},
		fire(triggerKey: string) {
			return t.core.autonomy.scheduleFired({ scheduleId: "t124-test", triggerKey, at: Date.now(), createdBy: "user" });
		},
		async hit(rule: Rule, eventId: string) {
			await t.waitFor(() => t.core.db.get("SELECT 1 FROM autonomy_events WHERE id=? AND state='processed'", eventId));
			return (await t.core.call("autonomy.rules.hits", { id: rule.id }) as Hit[]).find(row => row.eventId === eventId)!;
		},
	};
}

it("T124 a persisted Butterfly handoff uses the sandbox shell and Python to create a real verified delivery", async test => {
	const s = await fixture(test), { t, goals } = s;
	const { task } = await s.assignment();
	const file = task.deliverables[0]!, directory = file.slice(0, file.lastIndexOf("/"));
	const command = "mkdir -p " + directory;
	const code = "from pathlib import Path\nPath(" + JSON.stringify(file) + ").write_text(" + JSON.stringify(report) + ", encoding='utf-8')";
	// Represent a goal persisted before T124 without modifying or migrating its grant.
	t.core.db.run("UPDATE goals SET scope=json_set(scope,'$.allowedTools',json('[\"read\",\"write\"]')) WHERE id=?", task.goalId);
	const calls: string[] = [];
	test.mock.method(SandboxShell.prototype, "run", async (actual: string, _signal: AbortSignal | undefined, receipt?: (code: number) => void) => {
		assert.equal(actual, command);
		mkdirSync(s.local(directory), { recursive: true });
		calls.push("bash"); receipt?.(0); return "";
	});
	test.mock.method(PythonKernel.prototype, "run", async (request: { code: string; cwd: string }) => {
		assert.equal(request.cwd, "/workspace");
		assert.equal(request.code, code);
		assert.ok(existsSync(s.local(directory)));
		writeFileSync(s.local(file), report, "utf8");
		calls.push("python");
		return { status: "completed", text: "已写入", images: [], paths: [] };
	});
	t.respond(bash(command), python(code), done(), fauxAssistantMessage("交付完成"));
	goals.executor.start();
	await t.waitFor(() => goals.scheduler.get(task.goalId)?.status === "completed", 12_000);
	await t.waitFor(() => t.core.autonomy.effects.get("chat-delivery:" + task.goalId)?.state === "completed");
	assert.deepEqual(calls, ["bash", "python"]);
	const artifact = await t.core.call("butterfly.chat.artifact", { goalId: task.goalId, name: "report.md" }) as { path: string };
	assert.equal(readFileSync(artifact.path, "utf8"), report);
});

it("T124 host paths stay fenced and B2 diagnostics retain the blocked tool and reason", async test => {
	const s = await fixture(test), { t, goals } = s;
	const { goal } = await s.assignment();
	const sentinel = join(t.workspace, "sentinel.txt");
	writeFileSync(sentinel, "原件");
	for (const path of [sentinel, "/mnt/c/df-t124-sentinel.txt", "\\\\wsl$\\OtherDistro\\workspace\\probe.txt"]) {
		assert.equal(t.core.autonomy.checkGoal(goal, "write", path).ok, false);
		assert.equal(await allowedTool(t.core, goal, "write", { file_path: path }), false);
	}
	assert.equal(await allowedTool(t.core, goal, "pwsh", { command: "Write-Output 'host'" }), false);
	assert.equal(await allowedTool(t.core, goal, "read_document", { path: sentinel }), false);
	assert.equal(await allowedTool(t.core, goal, "mcp__host__write", {}), false);
	assert.equal(await allowedTool(t.core, goal, "job_output", { job_id: "unrelated" }), false);
	assert.equal(await allowedTool(t.core, goal, "working_directory", { cd: "/mnt/c" }), false);
	t.respond(fauxAssistantMessage([fauxToolCall("write", { file_path: sentinel, content: "不得执行" })]));
	goals.executor.start();
	await t.waitFor(() => goals.scheduler.get(goal.id)?.reason === "needs_permission", 10_000);
	const blocked = await t.waitFor(() => blockedGoalTools(t.core, goal.id).find(row => row.tool === "write"), 10_000);
	assert.match(blocked.reason, /授权/);
	assert.equal(readFileSync(sentinel, "utf8"), "原件");
});

it("T124 the network switch and old workbench and manually narrowed goal tool scopes still apply", async test => {
	const s = await fixture(test), { t, goals } = s;
	const { goal } = await s.assignment();
	for (const tool of ["bash", "python", "git_status", "todo_write", "working_directory", "agent"]) {
		assert.equal(await allowedTool(t.core, goal, tool, {}), true, tool);
	}
	assert.ok(sandboxGoalTools().includes("render_html"));
	assert.equal(await allowedTool(t.core, goal, "render_html", { file_path: "/mnt/c/page.html" }), false);
	for (const tool of ["web_fetch", "web_search"]) assert.equal(await allowedTool(t.core, goal, tool, {}), false);
	s.setOnline(true);
	for (const tool of ["web_fetch", "web_search"]) assert.equal(await allowedTool(t.core, goal, tool, {}), true);
	assert.equal(await allowedTool(t.core, goal, "agent", { worktree: true }), false);
	const bench = goals.scheduler.create({ title: "工作台目标", originText: "核对资料", mandateRef: "user:t124-workbench",
		scope: { cwd: t.workspace, allowedTools: ["read", "pwsh"], externalActions: [{ tool: "pwsh", command: "Write-Output ok" }] } });
	assert.equal(await allowedTool(t.core, bench, "bash", { command: "mkdir fixture" }), false);
	assert.equal(await allowedTool(t.core, bench, "python", { code: "1+1" }), false);
	assert.equal(await allowedTool(t.core, bench, "pwsh", { command: "Write-Output ok" }), true);
	assert.equal(await allowedTool(t.core, bench, "pwsh", { command: "Write-Output other" }), false);
	const restricted = { ...goal, mandateRef: "user:manual", scope: { ...goal.scope, allowedTools: ["read"] } };
	assert.equal(await allowedTool(t.core, restricted, "python", { code: "1+1" }), false);
});

for (const source of ["rule", "selfwork"] as const) {
	it("T124 " + source + " can invoke sandbox tools, but a zero budget prevents the next operation", async test => {
		const s = await fixture(test), { t, goals } = s;
		s.price();
		let id: string;
		if (source === "rule") {
			await s.save();
			const eventId = s.fire("auto");
			id = (await t.waitFor(() => t.core.db.get<{ id: string }>(
				"SELECT g.id FROM goals g JOIN autonomy_mandates m ON g.mandate_ref='rule:autonomy-'||m.id||'@1' WHERE m.event_id=?", eventId))).id;
		} else {
			const plan = { title: "学习核对", instruction: "核对两份记录", external: false, share: false };
			t.core.db.run("INSERT INTO selfwork_runs(id,source,state,plan,started_at,day) VALUES('t124-plan','learning','planning',?,?,'fixture')",
				JSON.stringify(plan), Date.now());
			id = goals.scheduler.launchSelfwork({ refId: "t124-plan", source: "learning", title: plan.title, instruction: plan.instruction,
				mandateRef: "idle-learning:t124-plan", cwd: t.core.paths.butterflyDir, sandbox: true, deliverable: selfworkDeliverable("t124-plan") });
		}
		const target = await t.waitFor(() => goals.scheduler.get(id));
		assert.equal(t.core.autonomy.checkGoal(target, "bash").ok, true);
		assert.equal(t.core.autonomy.checkGoal(target, "python").ok, true);
		assert.equal(t.core.autonomy.checkGoal(target, "notify").ok, false);
		let shellCalls = 0, pythonCalls = 0;
		test.mock.method(SandboxShell.prototype, "run", async (_command: string, _signal: AbortSignal | undefined, receipt?: (code: number) => void) => {
			shellCalls++;
			receipt?.(0);
			t.core.settings.update({ butterflyDailyBudget: 0 });
			return "sandbox fixture";
		});
		test.mock.method(PythonKernel.prototype, "run", async () => {
			pythonCalls++; return { status: "completed", text: "", images: [], paths: [] };
		});
		t.respond(withUsage([fauxToolCall("bash", { command: "printf 'sandbox fixture'" }),
			fauxToolCall("python", { code: "print('blocked')" })], 35));
		goals.executor.start();
		await t.waitFor(() => goals.scheduler.get(id)?.status === "paused", 10_000);
		assert.equal(shellCalls, 1, goals.scheduler.get(id)?.resumeWhen ?? "");
		assert.equal(pythonCalls, 0);
		assert.match(goals.scheduler.get(id)?.resumeWhen ?? "", /额度已设为 0/);
	});
}

function withUsage(text: Parameters<typeof fauxAssistantMessage>[0], output: number, stopReason?: "length" | "stop") {
	const message = fauxAssistantMessage(text, { stopReason });
	return { ...message, usage: { input: 20, output, cacheRead: 0, cacheWrite: 0, totalTokens: 20 + output,
		cost: { input: 0.00002, output: output * 0.000002, cacheRead: 0, cacheWrite: 0, total: 0.00002 + output * 0.000002 } } };
}

it("T124 observation allows a 500-token response, matches the short JSON and charges the shared budget", async test => {
	const s = await fixture(test), { t } = s;
	s.price();
	const rule = await s.save(true);
	t.respond((context, options) => {
		assert.equal(options?.maxTokens, 2048);
		assert.match(getCurrentSystemPrompt(context.messages), /\{"match":true\}/);
		// Faux counts one token per four characters, including the non-visible thinking block.
		return fauxAssistantMessage([{ type: "thinking", thinking: "x".repeat(1985) }, { type: "text", text: '{"match":true}' }]);
	});
	const hit = await s.hit(rule, s.fire("long-match"));
	assert.match(hit.reason, /本来会接/);
	assert.ok(hit.costUsd > 0);
	assert.equal(t.core.autonomy.budget.spentToday(), hit.costUsd);
	assert.equal(t.core.db.get<{ output: number }>("SELECT output FROM request_ledger WHERE purpose='auxiliary'")?.output, 500);
	assert.equal(t.core.db.get("SELECT 1 FROM goals"), undefined);
});

it("T124 observation clamps to the model limit and persists redacted previews for truncation and malformed output", async test => {
	const s = await fixture(test), { t } = s;
	s.price(700);
	const rule = await s.save(true);
	const privateValue = "T124-synthetic-secret-marker";
	t.respond((_context, options) => {
		assert.equal(options?.maxTokens, 700);
		return withUsage('{"match":true}', 700, "length");
	}, withUsage("开头 api_key=" + privateValue + " " + "余".repeat(300), 25));
	const truncated = await s.hit(rule, s.fire("truncated"));
	const malformed = await s.hit(rule, s.fire("malformed"));
	assert.equal(truncated.reason, '评估回复截断：{"match":true}');
	assert.match(malformed.reason, /^评估回复格式不对：开头 api_key=〔已遮盖：疑似密钥〕/);
	assert.ok(Array.from(malformed.reason.split("：").slice(1).join("：")).length <= 160);
	assert.doesNotMatch(malformed.reason, /T124-synthetic-secret-marker/);
	assert.ok(truncated.costUsd > 0 && malformed.costUsd > 0);
	assert.ok(Math.abs(t.core.autonomy.budget.spentToday() - truncated.costUsd - malformed.costUsd) < 1e-9);
	assert.equal(t.core.db.get("SELECT 1 FROM goals"), undefined);
});
