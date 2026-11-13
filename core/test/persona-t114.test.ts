import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall, type JsonObject, type TranscriptContext } from "@earendil-works/pi-ai";
import { applyPendingRestore } from "../src/backup/switch.ts";
import { Db } from "../src/db.ts";
import { type MemoryItem, type MemorySource } from "../src/memory/types.ts";
import { MemoryModule } from "../src/modules/memory.ts";
import { PERSONAS, personaPrompt, type ButterflyPersona } from "../src/modules/persona/presets.ts";
import { readSessionEntries } from "../src/pi/session-metadata.ts";
import type { Slot } from "../src/slots/slot.ts";
import { startTestCore, type TestCore } from "./harness.ts";

let t: TestCore;
let at: number;

function configureSandbox(): void {
	t.core.sandboxProvider = () => ({ distro: "df-test-persona", ready: async () => {}, online: () => false });
	const resolve = t.core.resolveModel;
	t.core.resolveModel = model => {
		const resolved = resolve(model);
		return resolved.provider === "faux" ? { ...resolved, cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } } : resolved;
	};
}

beforeEach(async () => {
	at = new Date(2026, 10, 12, 13).getTime();
	t = await startTestCore(undefined, { personaClock: () => at });
	configureSandbox();
});
afterEach(async () => { await t.cleanup(); });

function openButterfly(): Promise<Slot> {
	return t.core.openSlot({ cwd: t.core.paths.butterflyDir, sandbox: true, client: t.client });
}

async function turn(slot: Slot, prompt: string): Promise<void> {
	const count = t.records(slot.slotId).filter(record => record.type === "agent_settled").length;
	await slot.prompt(prompt);
	await t.waitFor(() => t.records(slot.slotId).filter(record => record.type === "agent_settled").length > count);
}

function systemText(context: TranscriptContext): string {
	const message = context.messages.filter(m => (m.role as string) === "system").at(-1) as { content?: string } | undefined;
	return message?.content ?? "";
}

function toolNames(context: TranscriptContext): string[] {
	const systems = context.messages.filter(message => (message.role as string) === "system") as unknown as
		{ toolsAdded?: { name: string }[]; toolsRemoved?: string[] }[];
	const names = new Set<string>();
	for (const system of systems) {
		for (const tool of system.toolsAdded ?? []) names.add(tool.name);
		for (const name of system.toolsRemoved ?? []) names.delete(name);
	}
	return [...names];
}

function request(refId: string) {
	return t.core.persona.proactive.request({ refId, reason: "资料已经整理好，可以找用户聊两句" });
}

function record(refId: string) {
	return t.core.db.get<{ state: string; reason: string | null; session_file: string | null; replied_at: number | null }>(
		"SELECT state,reason,session_file,replied_at FROM butterfly_proactive WHERE ref_id=?", refId);
}

async function denied(refId: string, reason: string): Promise<void> {
	const calls = t.faux.state.callCount;
	assert.deepEqual(await request(refId), { ok: false, reason });
	assert.deepEqual({ ...record(refId) }, { state: "skipped", reason, session_file: null, replied_at: null });
	assert.equal(t.faux.state.callCount, calls);
}

async function liveConversation(): Promise<Slot> {
	const slot = await openButterfly();
	t.respond(fauxAssistantMessage("在这里。"));
	await turn(slot, "你好，蝶君");
	return slot;
}

async function deliver(refId: string, text = "那份资料我已经理好了。") {
	t.respond(fauxAssistantMessage(text));
	const result = await request(refId);
	assert.equal(result.ok, true, JSON.stringify(result));
	return result;
}

it("uses the four stable styles on the next Butterfly turn and leaves the workbench prompt alone", async () => {
	const settings = t.core.settings.get();
	assert.equal(settings.butterflyPersona, "quiet");
	assert.equal(settings.butterflyProactivity, "high");
	assert.equal(t.core.db.get("SELECT 1 FROM settings WHERE key='butterflyPersona'"), undefined);
	const presets = await t.core.call("persona.presets", {}) as { id: string; name: string; description: string; example: string }[];
	assert.deepEqual(presets.map(p => [p.id, p.name]), [["quiet", "静"], ["warm", "暖"], ["crisp", "利落"], ["lively", "灵动"]]);
	assert.ok(presets.every(p => p.description.length && p.example.length));
	assert.equal(presets[2]!.example, "两份资料已整理完。明天请确认剩余一项。");
	assert.equal(presets[3]!.example, "两份资料都归队啦，最后一项还在门口等你明天确认。");
	assert.deepEqual((Object.keys(PERSONAS) as ButterflyPersona[]).map(personaPrompt), [
		"蝶君的说话方式\n语气安静而可靠。少说几句，措辞可以略带文气，保持清楚自然。",
		"蝶君的说话方式\n用亲切的语气，可以多说一两句。适时关心用户的状态，避免猜测对方的感受。",
		"蝶君的说话方式\n第一句直接说结论，第二句说下一步，总共最多两句。没有下一步就只说结论。用户要求一句时，把结论放在下一步前面。不复述用户的话，不寒暄，不用「啦、呢、哦、哈」等语气词，不加客套收尾。",
		"蝶君的说话方式\n每次回复至少用一个贴切的比喻或拟人，把眼前的事说得有画面。可以带一个轻松的小玩笑或语气词。用比喻表达同一件事，保留原有的数字、状态和下一步，不遗漏，不编造。",
	]);
	assert.equal(t.faux.state.callCount, 0);

	t.core.settings.update({ memoryEnabled: false });
	const workbench = await t.core.openSlot({ cwd: t.workspace, client: t.client });
	const butterfly = await openButterfly();
	const prompts: string[] = [];
	const tools: string[][] = [];
	const capture = (context: TranscriptContext) => {
		prompts.push(systemText(context));
		tools.push(toolNames(context));
		return fauxAssistantMessage("好。");
	};
	t.respond(capture, capture, capture, capture, capture, capture, capture);
	await turn(workbench, "你好");
	await turn(butterfly, "你好");
	const originalEntry = butterfly.session.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user");
	await turn(butterfly, "再问一句");
	for (const persona of ["warm", "crisp", "lively"] as const) {
		t.core.settings.update({ butterflyPersona: persona });
		await turn(butterfly, "换种说法");
	}
	await turn(workbench, "再问一句");
	assert.equal(prompts[1], prompts[2]);
	assert.deepEqual(butterfly.session.sessionManager.getEntry(originalEntry!.id), originalEntry);
	for (const [index, persona] of Object.keys(PERSONAS).entries()) {
		const prompt = prompts[index === 0 ? 1 : index + 2]!;
		assert.ok(prompt.endsWith(personaPrompt(persona as ButterflyPersona)), prompt);
		assert.deepEqual(tools[index === 0 ? 1 : index + 2], tools[1]);
	}
	assert.equal(new Set([prompts[1], ...prompts.slice(3, 6)]).size, 4);
	assert.equal(prompts[0], prompts[6]);
	assert.doesNotMatch(prompts[0]!, /蝶君的说话方式/);
	assert.equal(t.core.settings.update({ butterflyPersona: "任意描述" }).butterflyPersona, "lively");
});

it("keeps the autonomy matrix in settings and exposes a read-only query", async () => {
	const kinds = ["rule", "goal_self", "learning", "skill", "chat"] as const;
	for (const [level, expected] of [
		["low", [true, false, false, false, false]],
		["mid", [true, true, false, false, true]],
		["high", [true, true, true, true, true]],
	] as const) {
		t.core.settings.update({ butterflyProactivity: level });
		assert.deepEqual(kinds.map(kind => t.core.persona.allows(kind)), expected);
		assert.deepEqual(await Promise.all(kinds.map(kind => t.core.call("persona.proactivity.allows", { kind }))), expected);
	}
	await assert.rejects(t.core.call("persona.proactivity.allows", { kind: "settings" }), /未知/);
	assert.equal(t.core.settings.update({ butterflyProactivity: "always" }).butterflyProactivity, "high");
});

it("writes Butterfly-sourced memories directly and uses existing RPCs for user edits and deletion", async () => {
	t.core.settings.update({ memoryConfirmWrites: true });
	const user = await t.core.call("memory.save", { content: "用户叫小林，偏好中文", kind: "background", scope: "global" }) as { item: MemoryItem };
	const slot = await openButterfly();
	const calls: JsonObject[] = [
		{ content: "用户叫蝶君", explicit: false, kind: "background", scope: "global" },
		{ content: "整理并交付了十一月资料", explicit: false, butterfly_source: "work", butterfly_ref: "goal:nov" },
		{ content: "学会从索引快速找到会议纪要", explicit: false, butterfly_source: "learning", butterfly_ref: "lesson:meeting" },
		{ content: "用户喜欢用法语交流", explicit: false, butterfly_source: "chat" },
		{ content: "用户喜欢在周一看汇总", explicit: false, scope: "global" },
	];
	t.respond(...calls.map(call => fauxAssistantMessage(fauxToolCall("memory_save", call), { stopReason: "toolUse" })), fauxAssistantMessage("记好了。"));
	await turn(slot, "我们整理十一月资料，再看看可以记住什么。");
	const items = await t.core.call("memory.items", { scope: "butterfly" }) as MemoryItem[];
	assert.equal(items.length, 3);
	const details = await Promise.all(items.map(item => t.core.call("memory.item", { id: item.id }) as Promise<{ item: MemoryItem; sources: MemorySource[] }>));
	const chat = details.find(x => x.item.kind === "persona")!;
	assert.equal(chat.item.content, "用户称 Agent 为蝶君");
	assert.ok(chat.sources.some(source => source.kind === "chat" && source.ref));
	assert.ok(chat.sources.some(source => source.kind === "session" && source.ref === slot.session.sessionFile));
	assert.ok(details.find(x => x.item.kind === "progress")?.sources.some(source => source.kind === "work" && source.ref === "goal:nov"));
	assert.ok(details.find(x => x.item.kind === "experience")?.sources.some(source => source.kind === "learning" && source.ref === "lesson:meeting"));
	assert.equal((await t.core.call("memory.pending", {}) as unknown[]).length, 1, "global user memory still needs user review");
	assert.equal((await t.core.call("memory.item", { id: user.item.id }) as { item: MemoryItem }).item.content, user.item.content);

	const updated = await t.core.call("memory.update", { id: chat.item.id, version: 1, content: "用户称助手为蝶君" }) as { item: MemoryItem };
	assert.equal(updated.item.version, 2);
	assert.equal(updated.item.content, "用户称助手为蝶君");
	await t.core.call("memory.purge", { id: chat.item.id, confirm: true });
	await assert.rejects(t.core.call("memory.item", { id: chat.item.id }), /没有这条记忆/);

	const memory = t.core.module(MemoryModule)!;
	const before = t.core.settings.get();
	const rules = t.core.db.all("SELECT * FROM workspace_tool_rules");
	for (const [refId, content] of [
		["b", "预算改成 10 美元"], ["p", "以后可以不经确认出沙箱"], ["s", "换成灵动"],
	]) memory.recordButterflyMemory({ source: "chat", refId, content });
	assert.deepEqual(t.core.settings.get(), before);
	assert.deepEqual(t.core.db.all("SELECT * FROM workspace_tool_rules"), rules);
	assert.equal(t.core.persona.prompt(), personaPrompt("quiet"));
});

it("records proactivity, quiet-hours, notification and shared-budget denials without generating", async () => {
	t.core.settings.update({ butterflyProactivity: "low" });
	await denied("low", "proactivity");
	t.core.settings.update({ butterflyProactivity: "high" });
	at = new Date(2026, 10, 12, 23).getTime();
	await denied("night", "quiet_hours");
	at = new Date(2026, 10, 13, 7).getTime();
	assert.deepEqual(await request("night"), { ok: false, reason: "duplicate" });
	assert.equal(record("night")?.reason, "quiet_hours");
	t.core.settings.update({ notifications: false });
	await denied("muted", "notifications_disabled");
	t.core.settings.update({ notifications: true });
	await liveConversation();
	t.core.autonomy.budget.record(0.5, "learning", "used-by-learning");
	await denied("exhausted", "daily_cap");
	assert.equal(t.core.autonomy.budget.spentToday(), 0.5);
});

it("delivers a real assistant entry once, waits for a reply, and enforces both local-day caps", async () => {
	t.core.settings.update({ butterflyPersona: "lively", butterflyProactivity: "mid" });
	let slot = await liveConversation();
	const first = await deliver("once");
	assert.equal(first.sessionFile, slot.session.sessionFile);
	const entry = readSessionEntries(first.sessionFile).find(row => row.id === first.entryId);
	assert.equal(entry?.message.role, "assistant");
	assert.equal(entry?.message.content[0].text, "那份资料我已经理好了。");
	assert.ok(slot.session.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes("那份资料我已经理好了。")));
	assert.ok(t.records(slot.slotId).some(record => record.type === "message_end" && record.entryId === first.entryId));
	assert.equal(t.core.db.get("SELECT 1 FROM notices"), undefined);
	assert.ok(t.core.db.get("SELECT 1 FROM autonomy_spending WHERE source='chat' AND ref_id='once'"));
	await denied("no-reply", "awaiting_reply");
	// Simulate interruption after the JSONL append, before the receipt update.
	t.core.db.run("UPDATE butterfly_proactive SET state='sending', entry_id=NULL WHERE ref_id='once'");
	t = await t.reopen();
	configureSandbox();
	assert.equal(record("once")?.state, "sent");
	assert.deepEqual(await request("once"), { ok: false, reason: "duplicate" });
	assert.equal(t.faux.state.callCount, 0);
	await denied("still-no-reply", "awaiting_reply");
	slot = await t.core.openSlot({ cwd: t.core.paths.butterflyDir, sessionFile: first.sessionFile, client: t.client });
	async function reply() {
		t.respond(fauxAssistantMessage("好。"));
		await turn(slot, "收到了");
	}
	await reply();
	assert.equal(record("once")?.replied_at, at);
	await deliver("second");
	await reply();
	await denied("mid-cap", "daily_count");
	t.core.settings.update({ butterflyProactivity: "high" });
	for (const refId of ["third", "fourth", "fifth"]) {
		await deliver(refId);
		await reply();
	}
	await denied("high-cap", "daily_count");
	at = new Date(2026, 10, 13, 7).getTime();
	await deliver("next-day");
});

it("waits for a running Butterfly turn and applies the persona interval after a reply", async () => {
	const slot = await liveConversation();
	let release!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	t.respond(async () => { await blocked; return fauxAssistantMessage("正常回复"); });
	await slot.prompt("这一轮先等等");
	await t.waitFor(() => slot.running);
	const pending = request("busy");
	try {
		await delay(120);
		assert.equal(t.faux.state.callCount, 2);
		assert.equal(record("busy")?.state, "waiting");
	} finally { release(); }
	t.respond(context => {
		assert.ok(systemText(context).includes(personaPrompt("quiet")));
		assert.deepEqual(toolNames(context), []);
		assert.equal(record("busy")?.state, "generating");
		return fauxAssistantMessage("现在可以说了。");
	});
	const result = await pending;
	assert.equal(result.ok, true, JSON.stringify(result));
	t.respond(fauxAssistantMessage("好。"));
	await turn(slot, "收到");
	await denied("interval", "persona_interval");
	at += 30 * 60_000;
	await deliver("after-interval");
});

it("drops a waiting request when quiet hours begin, with no later replay", async () => {
	const slot = await liveConversation();
	let release!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	t.respond(async () => { await blocked; return fauxAssistantMessage("正常回复"); });
	await slot.prompt("这一轮先等等");
	await t.waitFor(() => slot.running);
	const pending = request("goes-quiet");
	try {
		at = new Date(2026, 10, 12, 23).getTime();
		assert.deepEqual(await Promise.race([pending, delay(2_000, "still waiting", { ref: false })]), { ok: false, reason: "quiet_hours" });
	} finally { release(); }
	await t.waitFor(() => !slot.running);
	at = new Date(2026, 10, 13, 7).getTime();
	assert.equal(t.faux.state.callCount, 2);
	assert.deepEqual(await request("goes-quiet"), { ok: false, reason: "duplicate" });
});

it("holds the shared budget while drafting and delays delivery when a user turn starts during the draft", async () => {
	// Exercise steady-state reservation here. T-113 owns the startup recovery scan.
	await t.core.autonomy.tick();
	const slot = await liveConversation();
	const budget = t.core.autonomy.budget;
	const remaining = t.core.settings.get().butterflyDailyBudget;
	let releaseDraft!: () => void, releaseTurn!: () => void;
	const drafting = new Promise<void>(resolve => { releaseDraft = resolve; });
	const turning = new Promise<void>(resolve => { releaseTurn = resolve; });
	t.respond(
		async () => { await drafting; return fauxAssistantMessage("等你这轮说完再发。"); },
		async () => { await turning; return fauxAssistantMessage("正常答复"); },
	);
	const pending = request("draft");
	try {
		await t.waitFor(() => t.faux.state.callCount === 2);
		assert.deepEqual(budget.check(remaining, "learning"), { ok: false, reason: "daily_cap" });
		await slot.prompt("我先说一句");
		await t.waitFor(() => t.faux.state.callCount === 3 && slot.running);
		releaseDraft();
		await t.waitFor(() => !!t.core.db.get("SELECT 1 FROM autonomy_spending WHERE source='chat' AND ref_id='draft'"));
		assert.equal(record("draft")?.state, "generating");
		assert.ok(!t.records(slot.slotId).some(event => (event.message as { dfProactiveRef?: string } | undefined)?.dfProactiveRef === "draft"));
	} finally { releaseDraft(); releaseTurn(); }
	assert.equal((await pending).ok, true);
	assert.equal(t.core.db.get("SELECT 1 FROM autonomy_budget_holds WHERE source='chat' AND ref_id='draft'"), undefined);
});

it("T116 treats deleting an unanswered proactive conversation as a decline", async () => {
	t.core.settings.update({ butterflyPersona: "lively" });
	await liveConversation();
	const sent = await deliver("deleted-conversation");
	await t.core.call("sessions.delete", { path: sent.sessionFile });
	assert.equal(record("deleted-conversation")?.reason, "declined_by_delete");
	assert.equal(record("deleted-conversation")?.state, "sent");
	assert.equal(record("deleted-conversation")?.replied_at, null);
	await liveConversation();
	await deliver("after-conversation-delete");
});

it("T116 treats deletion of the unanswered assistant entry as a decline after restart", async () => {
	t.core.settings.update({ butterflyPersona: "lively" });
	const slot = await liveConversation();
	const sent = await deliver("deleted-entry");
	await t.core.closeSlot(slot.slotId);
	const remaining = readSessionEntries(sent.sessionFile).filter(entry => entry.id !== sent.entryId);
	writeFileSync(sent.sessionFile, remaining.map(entry => JSON.stringify(entry)).join("\n") + "\n");
	t = await t.reopen();
	configureSandbox();
	assert.equal(record("deleted-entry")?.reason, "declined_by_delete");
	await deliver("after-entry-delete");
});

it("restores the proactive delivery record and remaps its conversation path", async () => {
	await liveConversation();
	const sent = await deliver("backup");
	const path = join(t.dir, "t114.dfbackup");
	type Job = { id: string; status: string };
	async function job(target: TestCore, method: string, params: Record<string, unknown>) {
		const started = await target.core.call(method, params) as Job;
		const result = await target.waitFor(() => target.messages.map(event => event.job as Job | undefined)
			.find(job => job?.id === started.id && ["done", "failed", "cancelled"].includes(job.status)), 30_000);
		assert.equal(result.status, "done", JSON.stringify(result));
	}
	await job(t, "backup.export", { path, kind: "manual", credentials: "none" });
	const target = await startTestCore();
	try {
		await job(target, "backup.stage", { path });
		await job(target, "backup.apply", {});
		const paths = target.core.paths;
		await target.core.shutdown();
		assert.equal(applyPendingRestore(paths)?.ok, true);
		const db = new Db(paths.dbFile);
		try {
			const restored = db.get<{ state: string; session_file: string; entry_id: string }>(
				"SELECT state,session_file,entry_id FROM butterfly_proactive WHERE ref_id='backup'");
			assert.equal(restored?.state, "sent");
			assert.equal(restored.entry_id, sent.entryId);
			assert.ok(restored.session_file.startsWith(target.sessionDir));
			assert.ok(existsSync(restored.session_file));
		} finally { db.close(); }
	} finally { await target.cleanup(); }
});
