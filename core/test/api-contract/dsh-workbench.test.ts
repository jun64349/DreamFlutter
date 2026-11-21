import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { HOST_SHELL_TOOL } from "../../src/agent/harness.ts";
import { ALLOW, APPROVAL_TITLE, DENY } from "../../src/pi/dialogs.ts";
import type { SlotInfo } from "../../src/slots/slot.ts";
import { startContractHarness, type ContractClient, type ContractHarness } from "./harness.ts";

function record(client: ContractClient, slotId: string, type: string, from = 0) {
	return client.waitForEvent("slot.record", event => event.slotId === slotId && (event.record as { type: string }).type === type, from)
		.then(event => event.record as Record<string, unknown>);
}

async function command(api: ContractClient, slotId: string, type: string, fields: Record<string, unknown> = {}) {
	const id = `${type}-${api.events.length}`;
	await api.call("slot.send", { slotId, record: { id, type, ...fields } });
	const event = await api.waitForEvent("slot.record", item => item.slotId === slotId && (item.record as { id?: string }).id === id);
	const reply = event.record as { success?: boolean; error?: string; data?: unknown };
	assert.equal(reply.success, true, reply.error);
	return reply.data;
}

test("DSH sends the owning slot its context after each request during a tool turn", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true, dshStandardWorkbench: true });
	await api.call("settings.update", { autoCompaction: false, approvalMode: "off" });
	await api.call("slot.open", { slotId: "active", cwd: api.workspace, agentMode: "standard" });
	await api.call("slot.open", { slotId: "other", cwd: api.workspace, agentMode: "minimal" });
	const file = join(api.workspace, "context-fixture.txt");
	await writeFile(file, "工具读取的样本。".repeat(180));
	let release!: () => void;
	const complete = new Promise<void>(resolve => { release = resolve; });
	api.respond(
		fauxAssistantMessage([fauxToolCall("read", { file_path: file })], { stopReason: "toolUse" }),
		async () => {
			await complete;
			return fauxAssistantMessage("这是工具后的回复。" + "回答".repeat(140));
		},
	);
	const from = api.events.length;
	type ContextUsage = { tokens: number; contextWindow: number; percent: number };
	try {
		await command(api, "active", "prompt", { message: "读取上下文样本" });
		const first = await record(api, "active", "df_context_usage_changed", from);
		const usage = first.contextUsage as ContextUsage;
		assert.ok(usage.tokens > 0 && usage.contextWindow > 0);
		assert.equal(usage.percent, usage.tokens / usage.contextWindow * 100);
		assert.equal((await record(api, "active", "tool_execution_end", from)).isError, false);
		const emitted = api.events.slice(from).flatMap(item => item.slotId === "active" && item.event === "slot.record"
			? [(item.record as { type: string }).type] : []);
		assert.ok(emitted.indexOf("df_context_usage_changed") < emitted.indexOf("tool_execution_start"));
		assert.ok(!emitted.includes("turn_end"));
	} finally {
		release();
	}
	await record(api, "active", "agent_settled", from);
	const updates = api.events.slice(from).filter(item => item.event === "slot.record" &&
		(item.record as { type: string }).type === "df_context_usage_changed");
	assert.deepEqual(updates.map(update => update.slotId), ["active", "active"]);
	const [first, second] = updates.map(update => (update.record as { contextUsage: ContextUsage }).contextUsage);
	assert.notEqual(second!.tokens, first!.tokens, JSON.stringify({ first, second }));
	const stats = await command(api, "active", "get_session_stats") as { contextUsage: ContextUsage };
	assert.deepEqual(stats.contextUsage, second);
	assert.deepEqual(await command(api, "active", "df_context_usage"), second);
});

test("DSH checks the configured limit before each tool follow-up and can continue afterward", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true, dshStandardWorkbench: true });
	const slotId = "step-budget";
	await api.call("settings.update", { maxTurnsPerRun: 2, approvalMode: "off", autoCompaction: false });
	await api.call("slot.open", { slotId, cwd: api.workspace, agentMode: "standard" });
	for (const name of ["first.txt", "second.txt"]) await writeFile(join(api.workspace, name), name);
	let modelRequests = 0;
	for (const path of ["first.txt", "second.txt"]) {
		api.respond(() => {
			modelRequests++;
			return fauxAssistantMessage([fauxToolCall("read", { file_path: path })], { stopReason: "toolUse" });
		});
	}
	let from = api.events.length;
	await command(api, slotId, "prompt", { message: "顺序读取两个文件" });
	assert.equal((await record(api, slotId, "agent_settled", from)).aborted, true);
	assert.equal(modelRequests, 2);
	const toolEnds = api.events.slice(from).filter(item => item.slotId === slotId && item.event === "slot.record" &&
		(item.record as { type: string }).type === "tool_execution_end");
	assert.equal(toolEnds.length, 2);
	assert.ok(toolEnds.every(item => (item.record as { isError: boolean }).isError === false));
	const notices = await api.call<{ id: string; kind: string; slotId: string }[]>("notices.list");
	const capped = notices.find(notice => notice.slotId === slotId);
	assert.equal(capped?.kind, "limit_turns");
	await api.call("notices.resolve", { id: capped!.id, action: "stop" });
	from = api.events.length;
	api.respond(fauxAssistantMessage("下一条正常完成"));
	await command(api, slotId, "prompt", { message: "再回复一句" });
	assert.equal((await record(api, slotId, "agent_settled", from)).aborted, false);
	assert.match(JSON.stringify(await command(api, slotId, "get_messages")), /下一条正常完成/);
});

test("DSH checks newly booked spending before the next request in a tool turn", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true, dshStandardWorkbench: true });
	const slotId = "step-spending";
	await api.call("settings.update", { dailyBudgetUsd: 0.01, approvalMode: "off", autoCompaction: false });
	await api.call("slot.open", { slotId, cwd: api.workspace, agentMode: "standard" });
	await writeFile(join(api.workspace, "sample.txt"), "隔离样本");
	const model = api.core.slot(slotId).session.model!;
	api.respond(() => {
		const ledger = api.core.ledger!;
		const charge = ledger.begin(model);
		const reply = fauxAssistantMessage([fauxToolCall("read", { file_path: "sample.txt" })], { stopReason: "toolUse" });
		const usage = { ...reply.usage, input: 1, output: 1, totalTokens: 2 };
		ledger.finish(charge, model, { ...reply, usage }, { actual: 0.02, currency: "USD" });
		return reply;
	});
	const from = api.events.length;
	await command(api, slotId, "prompt", { message: "读取样本" });
	assert.equal((await record(api, slotId, "tool_execution_end", from)).isError, false);
	assert.equal((await record(api, slotId, "agent_settled", from)).aborted, true);
	const notices = await api.call<{ kind: string; slotId: string }[]>("notices.list");
	assert.equal(notices.find(notice => notice.slotId === slotId)?.kind, "limit_budget");
	assert.equal(api.events.slice(from).filter(event => event.slotId === slotId &&
		(event.record as { type?: string } | undefined)?.type === "df_context_usage_changed").length, 1);
});

test("DSH warns on consecutive no-progress reads and still allows a different check", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true, dshStandardWorkbench: true });
	const slotId = "repeat";
	await api.call("settings.update", { approvalMode: "off", autoCompaction: false });
	await api.call("slot.open", { slotId, cwd: api.workspace, agentMode: "standard" });
	await writeFile(join(api.workspace, "same.txt"), "初次内容");
	await writeFile(join(api.workspace, "next.txt"), "另一份证据");
	const read = (path: string) => fauxAssistantMessage([fauxToolCall("read", { file_path: path })], { stopReason: "toolUse" });
	const guidance = /The last three tool steps repeated the same read-only calls/;
	api.respond(
		read("same.txt"),
		async () => { await writeFile(join(api.workspace, "same.txt"), "外部更新的数据"); return read("same.txt"); },
		read("same.txt"),
		context => {
			assert.doesNotMatch(JSON.stringify(context.messages), guidance, "changed content resets the repetition count");
			return read("same.txt");
		},
		context => {
			assert.match(JSON.stringify(context.messages), guidance);
			return read("next.txt");
		},
		context => {
			assert.match(JSON.stringify(context.messages), /另一份证据/);
			return fauxAssistantMessage("已查到新证据");
		},
	);
	const from = api.events.length;
	await command(api, slotId, "prompt", { message: "核对两份样本" });
	assert.equal((await record(api, slotId, "agent_settled", from)).aborted, false);
	const history = await command(api, slotId, "get_messages");
	assert.match(JSON.stringify(history), /已查到新证据/);
	assert.doesNotMatch(JSON.stringify(history), guidance, "internal redirect is not a visible user message");
});

for (const mode of ["standard", "minimal", "subagent"] as const) {
	test(`Windows DSH ${mode} cancellation reaps the shell tree and the next prompt runs`, { skip: process.platform !== "win32", timeout: 45_000 }, async t => {
		const api = await startContractHarness(t, { dshWorkbench: true, dshStandardWorkbench: true });
		const slotId = `cancel-${mode}`;
		await api.call("settings.update", { approvalMode: "off", autoCompaction: false });
		await api.call("slot.open", { slotId, cwd: api.workspace, agentMode: mode === "minimal" ? mode : "standard" });
		const shellPidFile = join(api.workspace, "shell.pid");
		const childPidFile = join(api.workspace, "child.pid");
		const lateFile = join(api.workspace, "late.txt");
		await writeFile(join(api.workspace, "sleep.cjs"), [
			"const fs = require('node:fs');",
			"fs.writeFileSync('child.pid', String(process.pid));",
			"setTimeout(() => fs.writeFileSync('late.txt', 'late'), 20_000);",
		].join("\n"));
		const quote = (text: string) => "'" + text.replaceAll("'", "''") + "'";
		const shell = `Set-Content -LiteralPath './shell.pid' -Value $PID; & ${quote(process.execPath)} './sleep.cjs'`;
		if (mode === "subagent") {
			api.respond(fauxAssistantMessage([fauxToolCall("agent", { role: "general", description: "运行隔离样本", prompt: "运行工作区中的等待脚本" })], { stopReason: "toolUse" }));
		}
		api.respond(fauxAssistantMessage([fauxToolCall(HOST_SHELL_TOOL, mode === "minimal" ? { command: shell } : { description: "运行隔离样本", command: shell, timeoutMs: 90_000 })], { stopReason: "toolUse" }));
		let from = api.events.length;
		await command(api, slotId, "prompt", { message: "运行测试脚本" });
		const pids = await api.waitFor<number[]>(() => {
			if (!existsSync(shellPidFile) || !existsSync(childPidFile)) return undefined;
			const ids = [shellPidFile, childPidFile].map(path => Number(readFileSync(path, "utf8").trim()));
			return ids.every(pid => Number.isInteger(pid) && pid > 0) ? ids : undefined;
		}, 8_000, "real PowerShell and its Node child started");
		const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
		assert.ok(pids.every(alive));
		const startedAbort = performance.now();
		await command(api, slotId, "abort");
		assert.equal((await record(api, slotId, "agent_settled", from)).aborted, true);
		await api.waitFor(() => pids.every(pid => !alive(pid)), 3_000, "cancelled processes exited");
		const cancelMs = Math.round(performance.now() - startedAbort);
		t.diagnostic(`cancelled real process tree and settled in ${cancelMs} ms`);
		assert.ok(cancelMs < 8_000);
		assert.equal(existsSync(lateFile), false);
		api.respond(
			fauxAssistantMessage([fauxToolCall(HOST_SHELL_TOOL, { command: "Write-Output '本机工具已恢复'", ...(mode === "minimal" ? {} : { description: "核对后续命令" }) })], { stopReason: "toolUse" }),
			context => {
				assert.match(JSON.stringify(context.messages), /本机工具已恢复/);
				return fauxAssistantMessage("后续请求正常");
			},
		);
		from = api.events.length;
		await command(api, slotId, "prompt", { message: "运行下一条命令" });
		assert.equal((await record(api, slotId, "agent_settled", from)).aborted, false);
		assert.match(JSON.stringify(await command(api, slotId, "get_messages")), /后续请求正常/);
	});
}

test("DSH compaction honors focus and regenerates the latest checkpoint from original history", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true, dshStandardWorkbench: true });
	const slotId = "summary";
	const { sessionId } = await api.call<SlotInfo>("slot.open", { slotId, cwd: api.workspace, agentMode: "standard" });
	await api.call("memory.save", { content: "当前项目名：隐藏松鼠", scope: "global", pinned: true });
	api.respond(fauxAssistantMessage("原文回复已收到"));
	let from = api.events.length;
	await command(api, slotId, "prompt", { message: "原文铜钟 " + "保留足够长的原始历史。".repeat(400) });
	await record(api, slotId, "agent_settled", from);
	api.respond(context => {
		assert.match(JSON.stringify(context), /寻找铜钟/);
		assert.match(JSON.stringify(context.messages), /原文铜钟/);
		assert.doesNotMatch(JSON.stringify(context), /隐藏松鼠/);
		return fauxAssistantMessage("第一次摘要");
	});
	const first = await api.call<{ summary: string }>("context.compactNow", { slotId, focus: "寻找铜钟" });
	assert.equal(first.summary, "第一次摘要");
	const checkpoints = await api.call<{ entryId: string }[]>("context.checkpoints", { slotId });
	assert.equal(checkpoints.length, 1);
	const entryId = checkpoints[0]!.entryId;
	api.respond(fauxAssistantMessage("", { stopReason: "error", errorMessage: "合成生成失败" }));
	await assert.rejects(api.call("context.regenerate", { slotId, entryId, note: "请修正时间" }), /manual compaction/);
	assert.deepEqual(await api.call("context.checkpoints", { slotId }), checkpoints);
	api.respond(context => {
		const text = JSON.stringify(context.messages);
		assert.match(text, /请修正时间/);
		assert.match(text, /突出地点/);
		assert.match(text, /原文铜钟/);
		assert.doesNotMatch(text, /第一次摘要/);
		return fauxAssistantMessage("改正后的摘要");
	});
	const corrected = await api.call<{ summary: string; source: string }>("context.regenerate", { slotId, entryId, note: "请修正时间", focus: "突出地点" });
	assert.equal(corrected.summary, "改正后的摘要");
	assert.equal(corrected.source, "original");
	const current = await api.call<{ entryId: string }[]>("context.checkpoints", { slotId });
	assert.equal(current.length, 1);
	assert.match(JSON.stringify(await api.call("context.original", { slotId, entryId: current[0]!.entryId })), /原文铜钟/);
	api.respond(context => {
		assert.match(JSON.stringify(context.messages), /改正后的摘要/);
		assert.doesNotMatch(JSON.stringify(context.messages), /第一次摘要/);
		return fauxAssistantMessage("更正继续");
	});
	from = api.events.length;
	await command(api, slotId, "prompt", { message: "使用更正后的上下文" });
	await record(api, slotId, "agent_settled", from);
	const requests = await api.call<{ purpose: string; session_id: string | null; success: number }[]>("ledger.entries");
	assert.deepEqual(requests.filter(request => request.purpose === "compaction" && request.success === 1).map(request => request.session_id), [sessionId, sessionId]);
	await api.call("sessions.list");
	await api.call("ledger.importHistory");
	assert.equal((await api.call<unknown[]>("ledger.entries")).length, requests.length);
});

test("DSH uses the live per-session pressure threshold and honors disabling automatic compaction", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true });
	const slotId = "pressure";
	await api.call("settings.update", { autoCompaction: false });
	await api.call("slot.open", { slotId, cwd: api.workspace, agentMode: "minimal" });
	await api.call("context.setSession", { slotId, thresholdPercent: 20 });
	for (let i = 0; i < 3; i++) {
		const from = api.events.length;
		api.respond(fauxAssistantMessage("本轮回答" + "乙".repeat(600)));
		await command(api, slotId, "prompt", { message: `旧消息${i} ` + "甲".repeat(70_000) });
		await record(api, slotId, "agent_settled", from);
	}
	assert.deepEqual(await api.call("context.checkpoints", { slotId }), []);
	const info = await api.call<{ usage: { tokens: number }; thresholdTokens: number }>("context.info", { slotId });
	assert.ok(info.usage.tokens > info.thresholdTokens);
	await api.call("settings.update", { autoCompaction: true });
	api.respond(fauxAssistantMessage("阈值摘要"), context => {
		assert.match(JSON.stringify(context.messages), /阈值摘要/);
		assert.match(JSON.stringify(context.messages), /保留这条新消息/);
		return fauxAssistantMessage("压缩后回答");
	});
	const from = api.events.length;
	await command(api, slotId, "prompt", { message: "保留这条新消息" });
	await record(api, slotId, "agent_settled", from);
	assert.equal((await record(api, slotId, "compaction_start", from)).reason, "threshold");
	assert.equal((await record(api, slotId, "compaction_end", from)).reason, "threshold");
	const checkpoints = await api.call<{ summary: string }[]>("context.checkpoints", { slotId });
	assert.equal(checkpoints.at(-1)?.summary, "阈值摘要");
	await api.waitForEvent("context.available", event => event.slotId === slotId && event.reason === "threshold", from);
});

test("DSH writes one background candidate and uses it without a second summary request", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true });
	const slotId = "candidate";
	await api.call("slot.open", { slotId, cwd: api.workspace, agentMode: "minimal" });
	await api.call("context.setSession", { slotId, thresholdPercent: 20, background: true });
	for (let i = 0; i < 3; i++) {
		const from = api.events.length;
		api.respond(fauxAssistantMessage("正文回复"), ...(i === 2 ? [fauxAssistantMessage("复用这份摘要")] : []));
		await command(api, slotId, "prompt", { message: "候选前的正文" + "甲".repeat(36_000) });
		await record(api, slotId, "agent_settled", from);
	}
	const afterHistory = await api.call<{ usage: { tokens: number }; thresholdTokens: number; background: { on: boolean } }>("context.info", { slotId });
	assert.equal(afterHistory.background.on, true);
	assert.ok(afterHistory.usage.tokens >= afterHistory.thresholdTokens * 0.85 && afterHistory.usage.tokens < afterHistory.thresholdTokens, JSON.stringify(afterHistory));
	await api.waitFor(() => api.events.find(event => event.event === "context.compaction" && event.slotId === slotId && event.kind === "background"), 5000);
	assert.ok(api.events.some(event => event.event === "context.compaction" && event.slotId === slotId && event.outcome === "made"),
		JSON.stringify(api.events.filter(event => event.event === "context.compaction" && event.slotId === slotId)));
	assert.deepEqual(await api.call("context.checkpoints", { slotId }), []);
	let from = api.events.length;
	api.respond(fauxAssistantMessage("正文继续"));
	await command(api, slotId, "prompt", { message: "候选后的补充" + "乙".repeat(4_000) });
	await record(api, slotId, "agent_settled", from);
	const afterPressure = await api.call<{ usage: { tokens: number }; thresholdTokens: number }>("context.info", { slotId });
	assert.ok(afterPressure.usage.tokens >= afterPressure.thresholdTokens, JSON.stringify(afterPressure));
	from = api.events.length;
	api.respond(async context => {
		assert.ok(JSON.stringify(context.messages).includes("复用这份摘要"));
		await api.call("context.setSession", { slotId, background: false });
		return fauxAssistantMessage("使用候选后的答复");
	});
	await command(api, slotId, "prompt", { message: "请继续" });
	await record(api, slotId, "agent_settled", from);
	const changes = api.events.slice(from).filter(event => event.event === "context.compaction" && event.slotId === slotId);
	assert.ok(changes.some(event => event.kind === "background" && event.outcome === "used"),
		JSON.stringify({ afterPressure, changes: changes.map(event => ({ kind: event.kind, outcome: event.outcome, reason: String(event.reason).slice(0, 120) })) }));
	const requests = await api.call<{ purpose: string }[]>("ledger.entries");
	assert.equal(requests.filter(request => request.purpose === "compaction").length, 1);
	const checkpoints = await api.call<{ summary: string }[]>("context.checkpoints", { slotId });
	assert.equal(checkpoints.at(-1)?.summary, "复用这份摘要");
});

test("DSH recovers from a provider context overflow with one official compaction", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true });
	const slotId = "overflow";
	await api.call("slot.open", { slotId, cwd: api.workspace, agentMode: "minimal" });
	api.respond(fauxAssistantMessage("第一轮回答"));
	let from = api.events.length;
	await command(api, slotId, "prompt", { message: "旧材料" + "需要保存的原文。".repeat(400) });
	await record(api, slotId, "agent_settled", from);
	api.respond(
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "This model's maximum context length is 8192 tokens." }),
		fauxAssistantMessage("压缩旧材料"),
		context => {
			const text = JSON.stringify(context.messages);
			assert.ok(text.includes("压缩旧材料"));
			assert.ok(text.includes("触发溢出的新问题"));
			return fauxAssistantMessage("恢复后的回答");
		},
	);
	from = api.events.length;
	await command(api, slotId, "prompt", { message: "触发溢出的新问题" });
	await record(api, slotId, "agent_settled", from);
	const starts = api.events.slice(from).filter(event => event.event === "slot.record" && event.slotId === slotId &&
		(event.record as { type: string; reason?: string }).type === "compaction_start");
	assert.equal(starts.length, 1);
	assert.equal((starts[0]!.record as { reason: string }).reason, "overflow");
	assert.equal((await record(api, slotId, "compaction_end", from)).willRetry, true);
	assert.match(JSON.stringify(await command(api, slotId, "get_messages")), /恢复后的回答/);
});

test("workbench WebSocket streams official DSH replies, handles stop and restores the native session after Core restart", { timeout: 45_000 }, async t => {
	let replacement: ContractHarness | undefined;
	t.after(() => replacement?.cleanup());
	const first = await startContractHarness(t, { dshWorkbench: true });
	const opened = await first.call<SlotInfo>("slot.open", { slotId: "first", cwd: first.workspace, agentMode: "minimal" });
	assert.ok(opened.sessionFile);
	assert.ok(opened.sessionId);
	assert.equal(opened.agentMode, "minimal");
	first.respond(fauxAssistantMessage("第一轮送达"));
	await first.call("slot.send", { slotId: "first", record: { id: "p1", type: "prompt", message: "纸蝶七号" } });
	await first.waitForEvent("slot.record", event => {
		const chunk = event.record as { type: string; assistantMessageEvent?: { type: string } };
		return event.slotId === "first" && chunk.type === "message_update" && chunk.assistantMessageEvent?.type === "text_delta";
	});
	assert.equal((await record(first, "first", "agent_settled")).aborted, false);
	await first.call("slot.close", { slotId: "first" });
	await first.close();
	await first.core.shutdown();
	const root = join(first.sessionDir, ".dsh");
	const logs = (await readdir(root, { recursive: true })).filter(file => file.endsWith(".jsonl"));
	assert.equal(logs.length, 1);
	const file = join(root, logs[0]!);
	const initialLog = await readFile(file, "utf8");
	assert.match(initialLog, /"user\/message"/);
	assert.match(initialLog, /"assistant\/message"/);

	const second = replacement = await startContractHarness(t, { dshWorkbench: true }, first.dir);
	const reopened = await second.call<SlotInfo>("slot.open", { slotId: "second", sessionFile: opened.sessionFile, cwd: first.workspace });
	assert.equal(reopened.sessionId, opened.sessionId);
	second.respond(context => {
		const visible = JSON.stringify(context.messages);
		assert.match(visible, /纸蝶七号/);
		assert.match(visible, /第一轮送达/);
		return fauxAssistantMessage("第二轮送达");
	});
	await second.call("slot.send", { slotId: "second", record: { id: "p2", type: "prompt", message: "继续" } });
	await record(second, "second", "agent_settled");
	const response = await second.call<{ ok: boolean }>("slot.send", { slotId: "second", record: { id: "history", type: "get_messages" } });
	assert.deepEqual(response, { ok: true });
	const history = await second.waitForEvent("slot.record", event => (event.record as { id?: string }).id === "history");
	assert.match(JSON.stringify(history.record), /第一轮送达.+第二轮送达/);

	const watcher = await second.connect();
	let modelStarted!: () => void;
	const started = new Promise<void>(resolve => { modelStarted = resolve; });
	second.respond(async (_context, options) => {
		modelStarted();
		await new Promise<void>(resolve => {
			const signal = options?.signal;
			if (signal?.aborted) resolve();
			else signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return fauxAssistantMessage("已取消", { stopReason: "aborted" });
	});
	const from = second.events.length;
	await second.call("slot.send", { slotId: "second", record: { id: "p3", type: "prompt", message: "请停在请求中" } });
	await started;
	const attach = await watcher.call<{ live: Record<string, unknown>[] }>("slot.attach", { slotId: "second" });
	assert.equal(attach.live[0]?.type, "agent_start");
	await watcher.call("slot.send", { slotId: "second", record: { id: "stop", type: "abort" } });
	assert.equal((await record(second, "second", "agent_settled", from)).aborted, true);
	await second.call("slot.close", { slotId: "second" });
	assert.ok((await readFile(file, "utf8")).startsWith(initialLog));
});

test("the DSH workbench uses the existing shell approval and rejects unregistered native tools", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true });
	await api.call("slot.open", { slotId: "tools", cwd: api.workspace, agentMode: "minimal" });
	const command = process.platform === "win32" ? "Set-Content -LiteralPath dsh-approved.txt -Value approved" : "printf approved > dsh-approved.txt";
	const target = join(api.workspace, "dsh-approved.txt");
	for (const answer of [DENY, ALLOW]) {
		const from = api.events.length;
		api.respond(fauxAssistantMessage([fauxToolCall(HOST_SHELL_TOOL, { description: "Write fixture", command })], { stopReason: "toolUse" }), fauxAssistantMessage("处理结束"));
		await api.call("slot.send", { slotId: "tools", record: { id: `prompt-${from}`, type: "prompt", message: "运行测试工具" } });
		const approval = await record(api, "tools", "extension_ui_request", from);
		assert.match(String(approval.title), new RegExp(APPROVAL_TITLE));
		assert.equal(existsSync(target), false);
		await api.call("confirm.answer", { id: approval.id, response: { value: answer } });
		await record(api, "tools", "agent_settled", from);
		assert.equal(existsSync(target), answer === ALLOW);
	}
	const from = api.events.length;
	api.respond(fauxAssistantMessage([fauxToolCall("run_code", { code: "test" })], { stopReason: "toolUse" }), fauxAssistantMessage("工具不可用"));
	await api.call("slot.send", { slotId: "tools", record: { id: "unknown", type: "prompt", message: "核对工具边界" } });
	const unknown = await record(api, "tools", "tool_execution_end", from);
	assert.equal(unknown.toolName, "run_code");
	assert.equal(unknown.isError, true);
	await record(api, "tools", "agent_settled", from);
});

test("summarized DSH branches keep the chosen context after reopen", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true });
	const slotId = "summary-branch";
	const opened = await api.call<SlotInfo>("slot.open", { slotId, cwd: api.workspace, agentMode: "minimal" });
	const sample = join(api.workspace, "summary-read.txt");
	await writeFile(sample, "摘要要追踪的测试文件");
	for (const question of ["起点", "原分支测试材料"]) {
		const from = api.events.length;
		if (question === "起点") api.respond(fauxAssistantMessage("已处理" + question));
		else api.respond(fauxAssistantMessage([fauxToolCall("read", { file_path: sample })], { stopReason: "toolUse" }), fauxAssistantMessage("已处理" + question));
		await command(api, slotId, "prompt", { message: question });
		await record(api, slotId, "agent_settled", from);
	}
	const history = await command(api, slotId, "get_entries") as { entries: { id: string; message?: { role: string; content: unknown } }[] };
	const anchor = history.entries.find(entry => entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("已处理起点"));
	assert.ok(anchor);
	const backend = api.core.dshBackend!;
	const originalComplete = backend.complete.bind(backend);
	let dshSummaries = 0;
	backend.complete = (...args) => { dshSummaries++; return originalComplete(...args); };
	const stream = api.core.slot(slotId).session.agent.streamFunction;
	api.respond(context => {
		assert.match(JSON.stringify(context), /只概括结论/);
		return fauxAssistantMessage("分支摘要测试编号七五");
	});
	await command(api, slotId, "df_navigate_tree", { entryId: anchor.id, summarize: true, customInstructions: "只概括结论" });
	assert.equal(dshSummaries, 1);
	assert.equal(api.core.slot(slotId).session.agent.streamFunction, stream);
	const saved = api.core.slot(slotId).session.sessionManager.getBranch().find(entry => entry.type === "branch_summary");
	assert.ok(saved?.type === "branch_summary" && (saved.details as { readFiles: string[] }).readFiles.includes(sample));
	await api.call("slot.close", { slotId });
	await api.call("slot.open", { slotId, cwd: api.workspace, sessionFile: opened.sessionFile });
	api.respond(context => {
		const text = JSON.stringify(context.messages);
		assert.match(text, /分支摘要测试编号七五/);
		assert.match(text, /已处理起点/);
		assert.doesNotMatch(text, /原分支测试材料/);
		return fauxAssistantMessage("摘要已收到");
	});
	const from = api.events.length;
	await command(api, slotId, "prompt", { message: "从这里继续" });
	await record(api, slotId, "agent_settled", from);
	assert.match(JSON.stringify(await command(api, slotId, "get_messages")), /摘要已收到/);
});

test("cancelling an official branch summary leaves the selection and stream unchanged", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true });
	const slotId = "cancel-summary";
	await api.call("slot.open", { slotId, cwd: api.workspace, agentMode: "minimal" });
	const answers = ["早期答案", "后续答案"];
	for (const reply of answers) {
		const from = api.events.length;
		api.respond(fauxAssistantMessage(reply));
		await command(api, slotId, "prompt", { message: "问题对应 " + reply });
		await record(api, slotId, "agent_settled", from);
	}
	const session = api.core.slot(slotId).session;
	const manager = session.sessionManager;
	const leaf = manager.getLeafId();
	const stream = session.agent.streamFunction;
	const anchor = manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "assistant");
	assert.ok(anchor);
	let started!: () => void;
	const dispatched = new Promise<void>(resolve => { started = resolve; });
	api.respond(async (_context, options) => {
		started();
		await new Promise<void>(resolve => {
			if (options?.signal?.aborted) resolve();
			else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return fauxAssistantMessage("已取消的摘要", { stopReason: "aborted" });
	});
	const moving = command(api, slotId, "df_navigate_tree", { entryId: anchor.id, summarize: true });
	await dispatched;
	await command(api, slotId, "abort");
	assert.equal((await moving as { cancelled: boolean }).cancelled, true);
	assert.equal(manager.getLeafId(), leaf);
	assert.equal(session.agent.streamFunction, stream);
	assert.equal(manager.getEntries().some(entry => entry.type === "branch_summary"), false);
});

test("summaries before the first imported message remain ordered and pass durable replay", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true });
	const slot = await api.core.openSlot({ cwd: api.workspace, agentMode: "standard" });
	const projected = slot.session.sessionManager;
	const services = api.core.dshBackend!.sessions!;
	const selected = slot.session.model!;
	const id = slot.session.sessionId;
	const model = { provider: selected.provider, model: selected.id };
	const time = Date.now();
	const summaries = [{ text: "最早的分支摘要", time }, { text: "之后的分支摘要", time }];
	await services.refreshModels();
	const options = { id, cwd: api.workspace, model, modelRuntime: () => slot.session.modelRuntime, ledgerContext: () => ({}),
		setup(ctx: Context) { ctx.systemPrompt.section({ name: "fixture", order: 0, text: () => "系统头必须能持久恢复" }); },
		onStream() {}, onStatus() {}, onEvent() {},
	};
	const first = await services.open({ ...options, resume: false, branchSummaries: summaries });
	api.respond(context => {
		assert.match(JSON.stringify(context.messages), /最早的分支摘要.+之后的分支摘要/);
		return fauxAssistantMessage("摘要顺序正确");
	});
	first.send([{ type: "text", text: "继续两条摘要" }], false);
	await first.agent.whenIdle();
	assert.match(JSON.stringify(first.agent.session.deriveMessages()), /摘要顺序正确/);
	await first.dispose();
	const resumed = await services.open({ ...options, resume: true });
	try {
		assert.match(JSON.stringify(resumed.agent.session.deriveMessages()), /最早的分支摘要.+之后的分支摘要.+摘要顺序正确/);
		assert.equal(projected.getSessionId(), id);
	} finally { await resumed.dispose(); }
});

test("workbench editing resends on an official DSH fork and can return to the original branch", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true });
	const opened = await api.call<SlotInfo>("slot.open", { slotId: "branches", cwd: api.workspace, agentMode: "minimal" });
	for (const [prompt, reply] of [["共同的问题", "共同的回答"], ["原来的问题", "原来的回答"]]) {
		const from = api.events.length;
		api.respond(fauxAssistantMessage(reply!));
		await command(api, "branches", "prompt", { message: prompt });
		await record(api, "branches", "agent_settled", from);
	}
	const original = await command(api, "branches", "get_entries") as { entries: { id: string; message?: { role: string; content: unknown } }[] };
	const question = original.entries.find(entry => entry.message?.role === "user" && JSON.stringify(entry.message.content).includes("原来的问题"));
	const answer = original.entries.find(entry => entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("原来的回答"));
	assert.ok(question && answer);
	assert.deepEqual(await command(api, "branches", "df_navigate_tree", { entryId: question.id }), { cancelled: false, editorText: "原来的问题" });
	api.respond(context => {
		const content = JSON.stringify(context.messages);
		assert.match(content, /共同的回答/);
		assert.doesNotMatch(content, /原来的问题|原来的回答/);
		return fauxAssistantMessage("编辑后的回答");
	});
	let from = api.events.length;
	await command(api, "branches", "prompt", { message: "编辑后的问题" });
	await record(api, "branches", "agent_settled", from);
	assert.match(JSON.stringify(await command(api, "branches", "get_messages")), /编辑后的回答/);
	await command(api, "branches", "df_navigate_tree", { entryId: answer.id });
	api.respond(context => {
		const content = JSON.stringify(context.messages);
		assert.match(content, /原来的回答/);
		assert.doesNotMatch(content, /编辑后的问题|编辑后的回答/);
		return fauxAssistantMessage("返回原分支");
	});
	from = api.events.length;
	await command(api, "branches", "prompt", { message: "顺着原分支" });
	await record(api, "branches", "agent_settled", from);
	assert.match(JSON.stringify(await command(api, "branches", "get_messages")), /返回原分支/);
	await api.call("slot.close", { slotId: "branches" });
	const root = join(api.sessionDir, ".dsh");
	const logs = (await readdir(root, { recursive: true })).filter(file => file.endsWith(".jsonl"));
	assert.equal(logs.length, 2);
	const fork = await readFile(join(root, logs.find(file => !file.includes(opened.sessionId!))!), "utf8");
	assert.match(fork, /"session\/end-seed"/);
	assert.match(fork, /编辑后的回答/);
	assert.doesNotMatch(fork, /原来的问题|原来的回答/);
});

test("workbench attachments and manual compaction use native DSH storage and affect the next request", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true });
	await api.call("slot.open", { slotId: "compact", cwd: api.workspace, agentMode: "minimal" });
	const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==" };
	api.respond(context => {
		assert.ok(context.messages.some(message => message.role === "user" && typeof message.content !== "string" &&
			message.content.some(block => block.type === "image")));
		return fauxAssistantMessage("第一轮已收到图");
	});
	await command(api, "compact", "prompt", { message: "旧内容标记".repeat(150), images: [image] });
	await record(api, "compact", "agent_settled");
	const first = JSON.stringify(await command(api, "compact", "get_messages"));
	assert.match(first, /第一轮已收到图/);
	assert.match(first, /image\/png/);
	let from = api.events.length;
	api.respond(fauxAssistantMessage("第二轮要保留"));
	await command(api, "compact", "prompt", { message: "新内容标记" });
	await record(api, "compact", "agent_settled", from);
	api.respond(fauxAssistantMessage("压缩摘要保留的事实"));
	const result = await command(api, "compact", "compact");
	assert.match(JSON.stringify(result), /压缩摘要保留的事实/);
	api.respond(context => {
		const content = JSON.stringify(context.messages);
		assert.match(content, /压缩摘要保留的事实/);
		assert.match(content, /第二轮要保留/);
		assert.doesNotMatch(content, /旧内容标记/);
		return fauxAssistantMessage("确认用了摘要");
	});
	from = api.events.length;
	await command(api, "compact", "prompt", { message: "继续" });
	await record(api, "compact", "agent_settled", from);
	assert.match(JSON.stringify(await command(api, "compact", "get_messages")), /确认用了摘要/);
	await api.call("slot.close", { slotId: "compact" });
	const root = join(api.sessionDir, ".dsh");
	const logs = (await readdir(root, { recursive: true })).filter(file => file.endsWith(".jsonl"));
	const log = await readFile(join(root, logs[0]!), "utf8");
	assert.match(log, /"compaction\/summary"/);
	assert.match(log, /"attachmentId"/);
});

test("a Pi workbench history is read-only and continues in a new DSH session", { timeout: 45_000 }, async t => {
	let replacement: ContractHarness | undefined;
	t.after(() => replacement?.cleanup());
	const previous = await startContractHarness(t, { dshWorkbench: false });
	const opened = await previous.call<SlotInfo>("slot.open", { slotId: "legacy", cwd: previous.workspace, agentMode: "minimal" });
	assert.ok(opened.sessionFile);
	previous.respond(fauxAssistantMessage("旧后台回答"));
	await command(previous, "legacy", "prompt", { message: "旧后台问题" });
	await record(previous, "legacy", "agent_settled");
	await previous.call("slot.close", { slotId: "legacy" });
	await previous.close();
	await previous.core.shutdown();
	const prefix = (await readFile(opened.sessionFile, "utf8")).trimEnd();
	await writeFile(opened.sessionFile, prefix);
	assert.doesNotMatch(prefix, /df\.dshSession/);

	const current = replacement = await startContractHarness(t, { dshWorkbench: true }, previous.dir);
	const original = await current.call<SlotInfo>("slot.open", { slotId: "original", cwd: current.workspace, sessionFile: opened.sessionFile });
	assert.equal(original.readOnly, true);
	assert.match(JSON.stringify(await command(current, "original", "get_messages")), /旧后台问题/);
	await assert.rejects(command(current, "original", "prompt", { message: "不能发送" }), /旧会话只读/);
	const continued = await current.call<SlotInfo>("sessions.continue", { sourceSlotId: "original", slotId: "migrated" });
	assert.notEqual(continued.sessionId, opened.sessionId);
	assert.notEqual(continued.sessionFile, opened.sessionFile);
	current.respond(context => {
		const text = JSON.stringify(context.messages);
		assert.match(text, /旧后台问题/);
		assert.match(text, /旧后台回答/);
		return fauxAssistantMessage("迁移后的回答");
	});
	await command(current, "migrated", "prompt", { message: "继续先前对话" });
	await record(current, "migrated", "agent_settled");
	await current.call("slot.close", { slotId: "migrated" });
	assert.ok(continued.sessionFile);
	await current.call("slot.open", { slotId: "migrated", cwd: current.workspace, sessionFile: continued.sessionFile });
	const from = current.events.length;
	current.respond(context => {
		assert.match(JSON.stringify(context.messages), /旧后台回答.+迁移后的回答/);
		return fauxAssistantMessage("重开后的回答");
	});
	await command(current, "migrated", "prompt", { message: "重开后继续" });
	await record(current, "migrated", "agent_settled", from);
	assert.match(JSON.stringify(await command(current, "migrated", "get_messages")), /重开后的回答/);
	await current.call("slot.close", { slotId: "migrated" });
	assert.equal(await readFile(opened.sessionFile, "utf8"), prefix);
	const root = join(previous.sessionDir, ".dsh");
	const logs = (await readdir(root, { recursive: true })).filter(file => file.endsWith(".jsonl"));
	assert.equal(logs.length, 1);
	assert.match(await readFile(join(root, logs[0]!), "utf8"), /旧后台回答[\s\S]+迁移后的回答/);
});

test("continuing the selected legacy branch keeps its images, compacted context and completed tool results", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true });
	const old = join(api.sessionDir, "complex-legacy.jsonl");
	const time = Date.now();
	const timestamp = new Date(time).toISOString();
	const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==" };
	const tool = fauxToolCall("dsh_old_tool", { name: "legacy" });
	const recalled = fauxToolCall("memory_search", { query: "旧私有查询" });
	const text = (value: string) => ({ type: "text", text: value });
	const user = (content: unknown) => ({ role: "user", content, timestamp: time });
	const entry = (id: string, parentId: string | null, type: string, fields: Record<string, unknown>) => ({ type, id, parentId, timestamp, ...fields });
	const contents = [
		{ type: "session", version: 3, id: "legacy-complex-session", timestamp, cwd: api.workspace },
		entry("early", null, "message", { message: user([text("压缩前原文")]) }),
		entry("early-reply", "early", "message", { message: fauxAssistantMessage("压缩前回答") }),
		entry("private", "early-reply", "custom_message", { customType: "df.memory", content: "私有旧快照", display: false }),
		entry("kept", "private", "message", { message: user([text("选中分支附件"), image]) }),
		entry("called", "kept", "message", { message: fauxAssistantMessage([tool, recalled], { stopReason: "toolUse" }) }),
		entry("returned", "called", "message", { message: { role: "toolResult", content: [text("旧工具结果")], toolCallId: tool.id, toolName: tool.name, timestamp: time, isError: false } }),
		entry("recall-result", "returned", "message", { message: { role: "toolResult", content: [text("旧记忆查询结果")], toolCallId: recalled.id, toolName: recalled.name, timestamp: time, isError: false } }),
		entry("python", "recall-result", "custom_message", { customType: "df.python_result", content: [text("旧后台图表"), image], display: true }),
		entry("answer", "python", "message", { message: fauxAssistantMessage("选中分支回答") }),
		entry("compact", "answer", "compaction", { tokensBefore: 100, firstKeptEntryId: "private", summary: "选中分支的压缩摘要" }),
		entry("sibling", "early", "message", { message: user([text("其他分支私有内容")]) }),
	];
	const original = contents.map(entry => JSON.stringify(entry)).join("\n");
	await writeFile(old, original);
	await api.call("slot.open", { slotId: "read-only", cwd: api.workspace, sessionFile: old });
	await command(api, "read-only", "df_navigate_tree", { entryId: "compact" });
	const continued = await api.call<SlotInfo>("sessions.continue", { sourceSlotId: "read-only", slotId: "continued" });
	assert.ok(continued.sessionFile);
	const projected = await readFile(continued.sessionFile, "utf8");
	assert.match(projected, /"sourceSessionId":"legacy-complex-session","sourceEntryId":"compact"/);
	assert.doesNotMatch(projected, /其他分支私有内容|私有旧快照|旧私有查询|旧记忆查询结果/);
	assert.match(projected, /旧后台图表/);
	let dispatched = false;
	api.respond(context => {
		dispatched = true;
		const visible = JSON.stringify(context.messages);
		assert.match(visible, /选中分支的压缩摘要/);
		assert.match(visible, /选中分支附件/);
		assert.match(visible, /旧工具结果/);
		assert.match(visible, /旧后台图表/);
		assert.match(visible, /"type":"image"/);
		assert.doesNotMatch(visible, /私有旧快照|其他分支私有内容|压缩前原文|旧私有查询|旧记忆查询结果/);
		return fauxAssistantMessage("安全续聊");
	});
	const from = api.events.length;
	await command(api, "continued", "prompt", { message: "请接着说明" });
	await record(api, "continued", "agent_settled", from);
	assert.equal(dispatched, true);
	assert.match(JSON.stringify(await command(api, "continued", "get_messages")), /安全续聊/);
	assert.equal(api.events.slice(from).some(event => event.slotId === "continued" && (event.record as { type: string } | undefined)?.type === "tool_execution_start"), false);
	await api.call("slot.close", { slotId: "read-only" });
	await api.call("slot.close", { slotId: "continued" });
	const backup = await api.call<{ id: string }>("backup.export", { path: join(api.dir, "continued.dfbackup"), includeSandbox: false, includeMaterials: false });
	const exported = await api.waitForEvent("backup.job", event => {
		const job = event.job as { id: string; status: string };
		return job.id === backup.id && job.status !== "running";
	});
	const job = exported.job as { status: string; error?: string; result?: { manifest?: { sessions?: number; files?: { path: string }[] } } };
	assert.equal(job.status, "done", job.error);
	assert.ok(job.result?.manifest?.files?.some(file => file.path.includes("data/dsh/")));
	await api.call("slot.open", { slotId: "continued", cwd: api.workspace, sessionFile: continued.sessionFile });
	await command(api, "continued", "df_navigate_tree", { entryId: "early-reply" });
	const fromEarly = api.events.length;
	api.respond(context => {
		const visible = JSON.stringify(context.messages);
		assert.match(visible, /压缩前原文.+压缩前回答/);
		assert.doesNotMatch(visible, /安全续聊|选中分支的压缩摘要|私有旧快照|其他分支私有内容/);
		return fauxAssistantMessage("压缩前另起分支");
	});
	await command(api, "continued", "prompt", { message: "从早期回答再继续" });
	await record(api, "continued", "agent_settled", fromEarly);
	assert.match(JSON.stringify(await command(api, "continued", "get_messages")), /压缩前另起分支/);
	assert.equal(await readFile(old, "utf8"), original);
});

test("private DSH conversations and their side conversations keep text and images in memory", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true });
	const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==" };
	const parent = await api.call<SlotInfo>("slot.open", { slotId: "private", cwd: api.workspace, incognito: true });
	assert.equal(parent.sessionFile, null);
	api.respond(context => {
		assert.match(JSON.stringify(context.messages), /"type":"image"/);
		return fauxAssistantMessage("无痕回答");
	});
	await command(api, "private", "prompt", { message: "无痕原文", images: [image] });
	await record(api, "private", "agent_settled");
	assert.ok(api.core.slot("private").hasDshHistory());
	assert.equal(api.core.slot("private").nativeSession, undefined);
	const side = await api.call<SlotInfo>("slot.open", { slotId: "private-side", cwd: api.workspace, parentSlotId: "private", sideQuote: "无痕回答" });
	assert.equal(side.willPersist, false);
	api.respond(context => {
		assert.match(JSON.stringify(context.messages), /无痕原文.+"type":"image".+无痕回答/);
		return fauxAssistantMessage("无痕侧边回答");
	});
	await command(api, "private-side", "prompt", { message: "无痕侧边问题" });
	await record(api, "private-side", "agent_settled");
	assert.ok(api.core.slot("private-side").hasDshHistory());
	assert.match(JSON.stringify(await command(api, "private-side", "get_messages")), /无痕侧边回答/);
	await api.call("slot.close", { slotId: "private-side" });
	await api.call("slot.close", { slotId: "private" });
	const files = await readdir(api.sessionDir, { recursive: true, withFileTypes: true });
	assert.deepEqual(files.filter(file => file.isFile()).map(file => file.name), []);
	assert.deepEqual(api.core.db.all("SELECT id FROM runs WHERE slot_id IN ('private', 'private-side')"), []);
});

test("a side conversation from a saved parent persists as DSH only after its first prompt", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true });
	const parent = await api.call<SlotInfo>("slot.open", { slotId: "saved", cwd: api.workspace });
	api.respond(fauxAssistantMessage("主会话回答"));
	await command(api, "saved", "prompt", { message: "主会话问题" });
	await record(api, "saved", "agent_settled");
	assert.ok(parent.sessionFile);
	const before = await readFile(parent.sessionFile);
	const side = await api.call<SlotInfo>("slot.open", { slotId: "saved-side", cwd: api.workspace, forkOf: parent.sessionFile });
	assert.equal(side.sessionFile, null);
	assert.equal(side.willPersist, true);
	api.respond(context => {
		assert.match(JSON.stringify(context.messages), /主会话问题.+主会话回答/);
		return fauxAssistantMessage("侧边会话回答");
	});
	await command(api, "saved-side", "prompt", { message: "侧边会话问题" });
	await record(api, "saved-side", "agent_settled");
	assert.ok(api.core.slot("saved-side").nativeSession);
	const savedSide = api.core.slot("saved-side").info();
	assert.ok(savedSide.sessionFile);
	assert.match(await readFile(savedSide.sessionFile, "utf8"), /侧边会话回答/);
	assert.deepEqual(await readFile(parent.sessionFile), before);
});

test("standard DSH workbench prepares memory for its first claimed message and keeps file approvals", { timeout: 45_000 }, async t => {
	const api = await startContractHarness(t, { dshWorkbench: true, dshStandardWorkbench: true });
	const nativeSection = "Cordis plugin's independent prompt section";
	await api.core.cordis.plugin({
		name: "workbench-test-prompt",
		inject: ["systemPrompt"],
		apply(ctx: Context) {
			ctx.systemPrompt.section({ name: "workbench-test-prompt", order: 50, text: nativeSection, interpolate: false });
		},
	});
	const text = "工作区演示代号是青纸蝶七号";
	await api.call("memory.save", { content: text, scope: "workspace", cwd: api.workspace, kind: "background", level: 3 });
	const opened = await api.call<SlotInfo>("slot.open", { slotId: "standard", cwd: api.workspace, agentMode: "standard" });
	assert.equal(opened.agentMode, "standard");
	const file = join(api.workspace, "dsh-standard.txt");
	let firstRequest = "";
	api.respond(context => {
		firstRequest = JSON.stringify(context.messages);
		return fauxAssistantMessage([fauxToolCall("write", { file_path: file, content: "标准工作台产物" })], { stopReason: "toolUse" });
	}, fauxAssistantMessage("已写好"));
	await command(api, "standard", "prompt", { message: "确认工作区演示代号，写入标准工作台产物" });
	const approval = await record(api, "standard", "extension_ui_request");
	assert.match(firstRequest, new RegExp(text));
	assert.ok(firstRequest.includes(nativeSection));
	assert.equal(existsSync(file), false);
	await api.call("confirm.answer", { id: approval.id, response: { value: ALLOW } });
	await record(api, "standard", "agent_settled");
	assert.equal(await readFile(file, "utf8"), "标准工作台产物");
	const snapshots = await api.call<unknown[]>("memory.snapshots", { sessionId: opened.sessionId });
	assert.equal(snapshots.length, 1);
	await api.call("slot.close", { slotId: "standard" });
	const logs = (await readdir(join(api.sessionDir, ".dsh"), { recursive: true })).filter(file => file.endsWith(".jsonl"));
	assert.equal(logs.length, 1);
});
