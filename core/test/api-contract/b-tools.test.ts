import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SandboxShell } from "../../src/agent/sandbox-shell.ts";
import { PythonKernel } from "../../src/agent/python-kernel.ts";
import { SecurityScope } from "../../src/security/service.ts";
import { fields, startContractCore, type ContractCore, type Json } from "./b-harness.ts";

const common = `agent ask_user_question autonomy_draft_rule edit exit_plan_mode git_branch_create git_branches git_commit git_diff git_history
git_recover git_recovery_points git_revert git_stage git_status git_switch glob goal_propose goal_report goal_status goal_update goal_wait
grep job_output mcp_register mcp_test memory_forget memory_save memory_search memory_update read read_card read_document read_image render_html
session_search show_card skill skill_propose skill_register skill_route skill_script_trial skill_test todo_write tool_search web_fetch working_directory write`.split(/\s+/);
const workbench = [...common, "job_kill", "job_list", "pwsh"];
const butterfly = [...common.filter(name => name !== "read_document"),
	...`bash patrol_update_log python schedule_create schedule_list schedule_remove schedule_run_now schedule_state schedule_update watch_add watch_done`.split(" ")];

async function probe(ws: ContractCore, slotId: string, name: string, params: Parameters<typeof fauxToolCall>[1], expectedError?: boolean, message = `检查 ${name}`, childReply?: string) {
	const from = ws.messages.length;
	ws.t.respond(fauxAssistantMessage([fauxToolCall(name, params)], { stopReason: "toolUse" }),
		...(childReply ? [fauxAssistantMessage(childReply)] : []), fauxAssistantMessage("工具检查完成"));
	assert.equal((await ws.command(slotId, "prompt", { message })).success, true);
	await ws.t.waitFor(() => ws.pushes(from, "slot.record").some(event => event.slotId === slotId && (event.record as Json).type === "agent_settled"), 15_000)
		.catch(error => { throw new Error(`${name} did not settle: ${JSON.stringify(ws.pushes(from, "slot.record").map(event => (event.record as Json).type))}`, { cause: error }); });
	await ws.t.waitFor(() => ws.t.core.slot(slotId).session.isIdle);
	const records = ws.pushes(from, "slot.record").map(event => event.record as Json);
	const started = records.findIndex(record => record.type === "tool_execution_start" && record.toolName === name);
	const finished = records.findIndex(record => record.type === "tool_execution_end" && record.toolName === name);
	assert.ok(started >= 0 && finished > started, name);
	assert.equal(records.filter(record => record.type === "tool_execution_end" && record.toolName === name).length, 1);
	const record = fields(records[finished], ["type", "toolCallId", "toolName", "result", "isError"], ["durationMs"]);
	const result = fields(record.result, ["content"], ["details", "isError"]);
	assert.ok(Array.isArray(result.content) && result.content.length > 0, name);
	if (expectedError !== undefined) assert.equal(record.isError, expectedError, name);
	return result;
}

it("matches the registered Agent tools for standard workbench, Butterfly and minimal sessions", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	ws.t.core.settings.update({ approvalMode: "off" });
	ws.t.core.sandboxProvider = () => ({ distro: "df-contract-tools", ready: async () => {}, online: () => false });
	const basic = ["pwsh", "read_image", "working_directory"];
	for (const [options, expected] of [
		[{ cwd: ws.t.workspace }, workbench],
		[{ cwd: ws.t.core.paths.butterflyDir, sandbox: true }, butterfly],
		[{ cwd: ws.t.workspace, agentMode: "minimal" }, [...basic, "goal_propose", "goal_report", "goal_status", "goal_update", "goal_wait"]],
	] as const) {
		const { slotId } = await ws.call("slot.open", options) as { slotId: string };
		const session = ws.t.core.slot(slotId).session;
		assert.deepEqual(session.getAllTools().map(tool => tool.name).sort(), [...expected].sort());
		if ("agentMode" in options) assert.deepEqual(session.getActiveToolNames().sort(), basic);
	}
});

it("a faux model exercises base workbench tools and streams ordered tool results", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	ws.t.core.settings.update({ approvalMode: "off" });
	await ws.call("webSearch.saveKey", { key: "fixture-web-search-key" });
	const { slotId } = await ws.call("slot.open", { cwd: ws.t.workspace }) as { slotId: string };
	const file = join(ws.t.workspace, "fixture.txt");
	writeFileSync(file, "合成内容");
	const probes = [
		["read", { file_path: file }, false],
		["write", { file_path: file, content: "修改后的合成内容" }, false],
		["edit", { file_path: file, old_string: "修改后的合成内容", new_string: "第二版" }, false],
		["working_directory", {}, false],
		["ask_user_question", { questions: [] }, undefined],
		["exit_plan_mode", { plan: "# 合成计划" }, true],
		["read_image", { file_path: file }, true],
		["read_document", { path: file }, false],
		["glob", { pattern: "*.txt" }, false],
		["grep", { pattern: "第二版", path: ws.t.workspace }, false],
		["pwsh", { command: "Write-Output 'fixture'", description: "输出合成内容", timeoutMs: 2_000 }, false],
		["job_list", {}, false],
		["job_output", { job_id: "missing" }, undefined],
		["job_kill", { job_id: "missing" }, undefined],
		["memory_search", { query: "合成" }, false],
		["memory_save", { content: "合成工具记忆", kind: "background" }, undefined],
		["memory_update", { id: "missing", content: "合成修订", explicit: true }, undefined],
		["memory_forget", { id: "missing", explicit: true }, undefined],
		["session_search", { query: "合成" }, false],
		["read_card", { card_id: "missing" }, undefined],
		["show_card", { title: "合成卡片", html: "<h1>合成</h1>" }, undefined],
		["skill", { name: "missing" }, undefined],
		["skill_route", { task: "整理合成文件", newTask: true }, undefined],
		["skill_register", { name: "contract-fixture", description: "测试技能", content: "---\nname: contract-fixture\ndescription: 测试技能\n---\n读取合成文件" }, undefined],
		["skill_propose", { name: "contract-draft", description: "测试草案", body: "读取合成文件" }, undefined],
		["skill_test", { filePath: join(ws.t.dir, "missing", "SKILL.md") }, undefined],
		["skill_script_trial", { filePath: join(ws.t.dir, "missing", "SKILL.md") }, undefined],
		["mcp_register", { server: { name: "fixture-only", transport: "stdio", command: "fixture-unused" } }, undefined],
		["mcp_test", { name: "missing" }, undefined],
		["render_html", { file_path: join(ws.t.dir, "missing.html") }, undefined],
		["web_fetch", { url: "file:///fixture-invalid" }, undefined],
		["web_search", { query: "合成网页" }, false],
		["git_status", {}, undefined],
		["git_diff", {}, undefined],
		["git_history", {}, undefined],
		["git_branches", {}, undefined],
		["git_recovery_points", {}, undefined],
		["git_stage", { paths: ["fixture.txt"] }, undefined],
		["git_commit", { message: "合成仓库不存在" }, undefined],
		["git_branch_create", { name: "fixture" }, undefined],
		["git_switch", { name: "fixture" }, undefined],
		["git_revert", { commit: "0000000" }, undefined],
		["git_recover", { id: "missing" }, undefined],
		["todo_write", { todos: [] }, false],
		["tool_search", { query: "read" }, undefined],
		["agent", { description: "合成子任务", prompt: "仅回答已完成", role: "general" }, undefined],
	] as const;
	for (const [name, params, expectedError] of probes) {
		await probe(ws, slotId, name, params, expectedError, undefined, name === "agent" ? "子任务完成" : undefined);
	}
});

it("a faux Butterfly model creates, updates, runs and removes a reminder", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	ws.t.core.settings.update({ approvalMode: "off" });
	ws.t.core.sandboxProvider = () => ({ distro: "df-contract-tools", ready: async () => {}, online: () => false });
	const { slotId } = await ws.call("slot.open", { cwd: ws.t.core.paths.butterflyDir, sandbox: true }) as { slotId: string };
	const created = await probe(ws, slotId, "schedule_create", { name: "测试提醒", kind: "reminder", trigger: "interval", every_minutes: 60 });
	const detail = fields(created.details, ["scheduleId", "action", "line"]);
	assert.equal(detail.action, "created");
	const id = String(detail.scheduleId);
	const listed = fields((await probe(ws, slotId, "schedule_list", { status: "active" })).details, ["items"]);
	assert.equal((listed.items as Json[])[0]?.id, id);
	assert.equal(((await probe(ws, slotId, "schedule_update", { id, version: 1, name: "已修改" })).details as Json).action, "updated");
	assert.equal(((await probe(ws, slotId, "schedule_run_now", { id })).details as Json).action, "ran");
	assert.equal(((await probe(ws, slotId, "schedule_remove", { id, version: 2 })).details as Json).action, "removed");
	await probe(ws, slotId, "schedule_state", { state: { example: true } });
});

it("a faux Butterfly model adds and completes a watch item and proposes a rule", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	ws.t.core.settings.update({ approvalMode: "off" });
	ws.t.core.sandboxProvider = () => ({ distro: "df-contract-tools", ready: async () => {}, online: () => false });
	const { slotId } = await ws.call("slot.open", { cwd: ws.t.core.paths.butterflyDir, sandbox: true }) as { slotId: string };
	const start = ws.messages.length;
	const added = await probe(ws, slotId, "watch_add", { text: "观察测试事项" });
	fields(added.details, ["line", "id"]);
	const [watch] = await ws.call("watch.list") as Json[];
	await probe(ws, slotId, "watch_done", { id: String(watch?.id) });
	const ruleAt = ws.messages.length;
	ws.t.respond(fauxAssistantMessage([fauxToolCall("autonomy_draft_rule", {
		name: "合成规则", task: "记录", source: "conversation", scope: { kind: "sandbox" },
	})]), fauxAssistantMessage("已起草"));
	await ws.t.core.slot(slotId).prompt("请起草一条规则");
	const pushed = await ws.t.waitFor(() => ws.pushes(ruleAt, "confirm.changed")[0]);
	const confirmation = pushed.confirmation as Json;
	assert.equal(confirmation.status, "pending");
	assert.deepEqual(await ws.call("confirm.answer", { id: confirmation.id, response: { confirmed: false } }), { ok: true });
	assert.equal(ws.pushes(ruleAt, "confirm.changed").length, 2);
	assert.equal(ws.pushes(start, "watch.changed").length, 2);
	await ws.t.waitFor(() => ws.pushes(ruleAt, "slot.record").some(event => (event.record as Json).type === "agent_settled"));
	const proposalAt = ws.messages.length;
	ws.t.core.settings.update({ autonomySources: { conversation: false, schedule: false, folder: false } });
	await probe(ws, slotId, "goal_propose", {
		title: "交趋势报告", boundary: "资料文件夹", spec: {
			objective: "交付趋势报告", deliverables: ["report.md"], acceptance: [{ id: "read", text: "数据范围正确", layer: "model" }],
		},
	}, false, "只用资料文件夹里的数据，先核对来源，再分析趋势，最后交一份报告。");
	assert.deepEqual(ws.pushes(proposalAt, "goal.proposals.changed"), [{ event: "goal.proposals.changed" }]);
});

it("a faux Butterfly model receives Bash and Python tool results from isolated executors", async test => {
	const ws = await startContractCore();
	test.after(ws.cleanup);
	ws.t.core.settings.update({ approvalMode: "off" });
	ws.t.core.sandboxProvider = () => ({ distro: "df-contract-tools", ready: async () => {}, online: () => false });
	test.mock.method(SecurityScope.prototype, "shellNeedsApproval", async () => false);
	const bash = test.mock.method(SandboxShell.prototype, "run", async (...[, , receipt]: Parameters<SandboxShell["run"]>) => {
		receipt?.(0);
		return "fixture";
	});
	const python = test.mock.method(PythonKernel.prototype, "run", async () => ({
		status: "completed" as const, text: "fixture", images: [], paths: [],
	}));
	const shellSlot = await ws.call("slot.open", { cwd: ws.t.core.paths.butterflyDir, sandbox: true }) as { slotId: string };
	await probe(ws, shellSlot.slotId, "bash", { command: "printf fixture", description: "输出合成内容" }, false, "你好");
	assert.equal(bash.mock.callCount(), 1);
	await ws.call("slot.close", { slotId: shellSlot.slotId });
	const pythonSlot = await ws.call("slot.open", { cwd: ws.t.core.paths.butterflyDir, sandbox: true }) as { slotId: string };
	const result = await probe(ws, pythonSlot.slotId, "python", { code: "print('fixture')" }, false, "你好");
	assert.equal(python.mock.callCount(), 1);
	assert.deepEqual(result.details, { status: "completed", imagePaths: [] });
});
