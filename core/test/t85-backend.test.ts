import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryModule } from "../src/modules/memory.ts";
import { SessionIndex } from "../src/modules/session-index.ts";
import { SkillsModule, type SkillInfo } from "../src/modules/skills.ts";
import { TasksModule } from "../src/modules/tasks.ts";
import { ButterflyModule, butterflyStatus } from "../src/modules/butterfly.ts";
import { locator } from "../src/modules/library-registry.ts";
import { RECYCLE_MS, type RecycleRow } from "../src/sessions/recycle.ts";
import { piSessionFolder } from "../src/backup/path-map.ts";
import { startTestCore, settledCount, type TestCore } from "./harness.ts";
import type { MemoryItem } from "../src/memory/types.ts";

function fixture(t: TestCore, name: string, options: { parent?: string; side?: boolean; cwd?: string; title?: string } = {}) {
	const path = join(t.sessionDir, name + ".jsonl");
	const id = name;
	writeFileSync(path, [
		{ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: options.cwd ?? t.workspace, ...(options.parent ? { parentSession: options.parent } : {}) },
		{ type: "message", id: `${name}-user`, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "需要找回的正文", timestamp: Date.now() } },
		{ type: "session_info", id: `${name}-title`, name: options.title ?? name },
		...(options.side ? [{ type: "custom", customType: "df.sideConversation", id: `${name}-side`, data: { sessionId: id, quote: "引用", quoteEntryId: null } }] : []),
	].map((e) => JSON.stringify(e)).join("\n") + "\n");
	return path;
}

describe("T85 backend contracts", () => {
	let t: TestCore;
	beforeEach(async () => { t = await startTestCore(); });
	afterEach(async () => { await t.cleanup(); });
	it("searches titles, messages, artifact names and visible memory with grouped targets", async () => {
		fixture(t, "report", { title: "销售报告" });
		fixture(t, "elsewhere", { title: "销售报告", cwd: join(t.dir, "other") });
		await t.core.call("memory.save", { content: "销售报告每周四发", kind: "background" });
		const file = join(t.workspace, "销售报告.csv"); writeFileSync(file, "x");
		const task = t.core.module(TasksModule)!.create({ cwd: t.workspace, goal: "报告", source: "chat" });
		t.core.db.run("INSERT INTO artifacts(id,cwd,cwd_key,task_id,path,created_at,updated_at) VALUES('artifact',?,?,?,?,?,?)", t.workspace, t.workspace.toLowerCase(), task.id, file, Date.now(), Date.now());
		const result = await t.core.call("search.all", { query: "销售", cwd: t.workspace }) as { conversations: any[]; files: any[]; memories: any[] };
		assert.equal(result.conversations.length, 1); assert.equal(result.files.length, 1); assert.equal(result.memories.length, 1);
		assert.equal(result.conversations[0].target.page, "conversation"); assert.equal(result.files[0].target.path, file); assert.ok(result.memories[0].target.itemId);
		assert.equal((await t.core.call("search.all", { query: "找回", cwd: t.workspace }) as any).conversations.length, 1);
		assert.deepEqual(await t.core.call("search.all", { query: "  " }), { conversations: [], files: [], memories: [] });
	});
	it("links a committed memory correction to its final reply, keeps before/after and undoes its batch", async () => {
		await t.core.call("slot.open", { slotId: "chat", cwd: t.workspace }, t.client);
		const saved = await t.core.call("memory.save", { content: "周报每周三发", kind: "background", scope: "workspace", cwd: t.workspace }) as { item: MemoryItem };
		t.respond(fauxAssistantMessage([fauxToolCall("memory_update", { id: saved.item.id, content: "周报每周四发", explicit: true })], { stopReason: "toolUse" }), fauxAssistantMessage("已更新记忆"));
		await t.send("chat", { id: "fix", type: "prompt", message: "这条不对，我周报每周四发" });
		await t.waitFor(() => settledCount(t.records("chat")) === 1);
		const sessionId = t.core.slot("chat").session.sessionId;
		const receipts = await t.core.call("memory.corrections", { sessionId }) as any[];
		assert.equal(receipts.length, 1); assert.ok(receipts[0].entryId); assert.ok(receipts[0].runId);
		assert.equal(receipts[0].changes[0].before.content, "周报每周三发"); assert.equal(receipts[0].changes[0].after.content, "周报每周四发");
		assert.equal((await t.core.call("memory.corrections", { sessionId, entryId: receipts[0].entryId }) as any[]).length, 1);
		await t.core.call("memory.undoBatch", { batchId: receipts[0].batchId });
		assert.equal(t.core.module(MemoryModule)!.store.get(saved.item.id)!.content, "周报每周三发");
		assert.equal((await t.core.call("memory.corrections", { sessionId }) as any[])[0].changes[0].undoable, false);
	});
	it("records each boundary decision, exposes it in memory history, rejects stale undo and restores the previous task", async () => {
		const m = t.core.module(MemoryModule)!;
		const input = { sessionId: "boundaries", prompt: "帮我修登录", set: m.scopesFor(t.workspace), unattended: false, recent: "", cwd: t.workspace };
		const first = await m.boundary(input);
		await m.boundary({ ...input, prompt: "再看看" });
		const changed = await m.boundary({ ...input, prompt: "换个话题，写份周报" });
		const decisions = await t.core.call("memory.boundaries", { sessionId: input.sessionId }) as any[];
		assert.equal(decisions.length, 3); assert.equal(decisions[0].changed, true); assert.equal(decisions[1].changed, false);
		await assert.rejects(t.core.call("memory.undoBoundary", { id: decisions[1].id }), /新的任务判断/);
		const log = await t.core.call("memory.log", { sessionId: input.sessionId }) as any;
		assert.equal(log.boundaries.length, 3);
		await t.core.call("memory.undoBoundary", { id: decisions[0].id });
		assert.equal(m.tasks.current(input.sessionId)!.id, first.task.id); assert.equal(m.tasks.get(changed.task.id)!.status, "ended");
		await assert.rejects(t.core.call("memory.undoBoundary", { id: decisions[0].id }), /已经撤销/);
	});
	it("keeps a pending correction tied to the same reply when T83 later accepts it", async () => {
		await t.core.call("slot.open", { slotId: "pending-fix", cwd: t.workspace }, t.client);
		const saved = await t.core.call("memory.save", { content: "周报每周三发", kind: "background" }) as { item: MemoryItem };
		t.respond(fauxAssistantMessage([fauxToolCall("memory_update", { id: saved.item.id, content: "周报每周四发", explicit: true })], { stopReason: "toolUse" }), fauxAssistantMessage("已提出修改，等你确认"));
		await t.core.slot("pending-fix").prompt("这条不对，周报每周四发"); await t.waitFor(() => settledCount(t.records("pending-fix")) === 1);
		const sessionId = t.core.slot("pending-fix").session.sessionId;
		let receipts = await t.core.call("memory.corrections", { sessionId }) as any[];
		assert.equal(receipts[0].status, "pending"); assert.equal(receipts[0].batchId, null); const entryId = receipts[0].entryId;
		const pending = t.core.module(MemoryModule)!.store.pending()[0]!;
		await t.core.call("memory.acceptPending", { id: pending.id });
		receipts = await t.core.call("memory.corrections", { sessionId }) as any[];
		assert.equal(receipts[0].entryId, entryId); assert.equal(receipts[0].status, "applied"); assert.equal(receipts[0].changes[0].after.content, "周报每周四发");
	});
	it("resolves reviewed memory on keep and exposes the reviewer and stale indicator", async () => {
		const m = t.core.module(MemoryModule)!;
		const result = m.store.commit({ actor: "user", ops: [{ kind: "add", item: { content: "用户喜欢简短回答", kind: "background", scope: "global", level: 1, status: "review", confidence: "user_explicit" } }] });
		const id = result.applied[0]!.itemId;
		const before = await t.core.call("memory.item", { id }) as any;
		assert.equal(before.item.possiblyOutdated, true); assert.equal(before.item.review.owner, "memory_agent");
		t.core.settings.update({ memoryAutoExtract: true });
		m.work.jobs.enqueue({ kind: "review", scopeKey: "global", payload: { level: 1, period: "week", light: true, flagged: [id] }, priority: 100 });
		t.respond(fauxAssistantMessage([fauxToolCall("memory_propose_ops", { ops: [{ action: "keep", id, version: m.store.get(id)!.version, reason: "仍然有效" }] })], { stopReason: "toolUse" }), fauxAssistantMessage("已核对"));
		await m.work.drain();
		assert.equal(m.store.get(id)!.status, "active", JSON.stringify(m.work.jobs.list())); assert.ok(m.store.get(id)!.lastVerifiedAt);
	});
	it("lists legacy templates as skills, keeps native slash execution and routes controls to the existing registry", async () => {
		await t.core.call("templates.save", { name: "周报", description: "整理周报", body: "汇总 {{主题}}", params: [{ name: "主题", default: "本周" }] });
		const entry = (await t.core.call("skills.list", { cwd: t.workspace }) as SkillInfo[]).find((s) => s.kind === "template")!;
		assert.equal(entry.command, "/周报"); assert.equal(entry.params![0]!.name, "主题");
		assert.match(await t.core.call("skills.read", { filePath: entry.filePath }) as string, /汇总/);
		await t.core.call("slot.open", { slotId: "template", cwd: t.workspace }, t.client);
		t.respond(fauxAssistantMessage("完成")); await t.core.slot("template").prompt("/周报 本月");
		assert.equal(t.core.library.get("template", locator(entry.filePath)).usageCount, 1);
		await t.core.call("skills.setEnabled", { filePath: entry.filePath, enabled: false });
		assert.equal((await t.core.call("skills.list", { cwd: t.workspace }) as SkillInfo[]).find((s) => s.filePath === entry.filePath)!.enabled, false);
		await t.core.call("skills.remove", { filePath: entry.filePath }); assert.equal(existsSync(entry.filePath), false);
	});
	it("keeps a session-derived skill as a proposal and schedules the saved conversation using the existing scheduler", async () => {
		await t.core.call("slot.open", { slotId: "reuse", cwd: t.workspace }, t.client);
		t.respond(fauxAssistantMessage("先读资料，再汇总成周报")); await t.core.slot("reuse").prompt("汇总周报");
		await t.waitFor(() => settledCount(t.records("reuse")) === 1);
		t.respond(fauxAssistantMessage(JSON.stringify({ name: "weekly-report", description: "生成周报", body: "读取资料，再总结和检查" })));
		const proposal = await t.core.call("skills.draftFromSession", { slotId: "reuse" }) as any;
		assert.equal(proposal.status, "pending"); assert.equal(existsSync(join(t.agentDir, "skills", "weekly-report", "SKILL.md")), false);
		assert.ok((await t.core.call("attention.list", {}) as any).later.some((i: any) => i.target.itemId === proposal.id));
		const schedule = await t.core.call("schedules.fromSession", { slotId: "reuse", trigger: { type: "interval", everyMs: 3600000 } }) as any;
		assert.equal(schedule.sessionFile, t.core.slot("reuse").info().sessionFile); assert.equal(schedule.prompt, "汇总周报");
	});
	it("counts parent/child real loads separately even with the same prefix and call id, but deduplicates repeated delivery", () => {
		const path = join(t.dir, "SKILL.md"); writeFileSync(path, "test");
		const factory = t.core.library.extension(false, () => ({ skills: [{ name: "x", filePath: path }], prompts: [] }), () => "same-parent-run");
		const setup = () => { const callbacks = new Map<string, Function>(); factory({ on: (name: string, fn: Function) => callbacks.set(name, fn) } as unknown as ExtensionAPI); return callbacks.get("tool_result")!; };
		const parent = setup(), child = setup();
		const event = { toolName: "skill", toolCallId: "shared-id", details: { path }, input: {}, isError: false };
		parent(event, { cwd: t.workspace }); parent(event, { cwd: t.workspace }); child(event, { cwd: t.workspace });
		assert.equal(t.core.library.get("skill", locator(path)).usageCount, 2);
	});
	it("maps all old butterfly states to the four task states and delivers summary/files/cost/time", async () => {
		assert.deepEqual(["waiting", "running", "needs_input", "interrupted", "done", "no_change", "failed"].map((s) => butterflyStatus(s as any)), ["in_progress", "in_progress", "waiting", "waiting", "completed", "completed", "failed"]);
		const task = t.core.module(TasksModule)!.create({ cwd: t.core.paths.butterflyDir, goal: "交付", source: "chat" });
		t.core.db.run("UPDATE tasks SET status='done',result='完成了',cost=0.12,duration_ms=1500 WHERE id=?", task.id);
		const view = await t.core.call("butterfly.task", { id: task.id }) as any;
		assert.equal(view.status, "completed"); assert.deepEqual(view.delivery, { summary: "完成了", files: [], cost: 0.12, durationMs: 1500 });
		assert.equal((await t.core.call("butterfly.tasks", {}) as any[]).length, 1);
	});
	it("restates before starting, honors finite waits and routes missing information through T83 questions", async () => {
		await t.core.call("slot.open", { slotId: "butterfly", cwd: t.core.paths.butterflyDir }, t.client);
		const slot = t.core.slot("butterfly"); Object.defineProperty(slot, "sandboxed", { value: true });
		const sent: string[] = []; slot.prompt = async (s) => { sent.push(s); };
		t.core.settings.update({ butterflyStartWaitSeconds: 10 });
		t.respond(fauxAssistantMessage(JSON.stringify({ restatement: "我会整理周报", plan: "先读取，再汇总", missing: [] })));
		const intent = await t.core.call("butterfly.prepare", { slotId: slot.slotId, goal: "整理周报" }) as any;
		assert.equal(sent.length, 0); assert.ok(intent.start_at >= intent.created_at + 9900);
		t.core.db.run("UPDATE butterfly_intents SET start_at=? WHERE id=?", Date.now() - 1, intent.id);
		await t.core.call("butterfly.tick", {}); assert.equal(sent.length, 1); assert.match(sent[0]!, /先读取，再汇总/);
		t.respond(fauxAssistantMessage(JSON.stringify({ restatement: "我会发到指定位置", plan: "整理后发送", missing: ["要发到哪里？"] })));
		const missing = await t.core.call("butterfly.prepare", { slotId: slot.slotId, goal: "整理后发过去" }) as any;
		assert.equal(missing.state, "needs_input"); assert.equal(missing.start_at, null);
		assert.ok((await t.core.call("attention.list", {}) as any).now.some((i: any) => i.kind === "question"));
		await t.core.call("butterfly.cancel", { id: missing.id }); assert.equal(slot.ui.pendingCount, 0);
	});
	it("honors the default minute and indefinite waits, starts once through attention and keeps a revised task's identity", async () => {
		await t.core.call("slot.open", { slotId: "waits", cwd: t.core.paths.butterflyDir }, t.client);
		const slot = t.core.slot("waits"); Object.defineProperty(slot, "sandboxed", { value: true });
		let starts = 0; slot.prompt = async () => { starts++; };
		const plan = () => fauxAssistantMessage(JSON.stringify({ restatement: "我会汇总文件", plan: "读取后汇总", missing: [] }));
		t.core.settings.update({ butterflyStartWaitSeconds: 60 }); t.respond(plan());
		const minute = await t.core.call("butterfly.prepare", { slotId: slot.slotId, goal: "汇总文件" }) as any;
		assert.ok(minute.start_at - minute.created_at >= 59900); await t.core.call("butterfly.tick", {}); assert.equal(starts, 0);
		t.core.settings.update({ butterflyStartWaitSeconds: 0 }); t.respond(plan());
		const forever = await t.core.call("butterfly.prepare", { slotId: slot.slotId, goal: "改成汇总本周文件" }) as any;
		assert.equal(forever.task_id, minute.task_id); assert.equal(forever.start_at, null);
		await t.core.call("butterfly.tick", {}); assert.equal(starts, 0);
		const pending = (await t.core.call("attention.list", {}) as any).now.find((i: any) => i.data.method === "confirm"); assert.ok(pending);
		await t.core.call("attention.resolve", { id: pending.id, action: "allow" });
		await t.waitFor(() => starts === 1); await t.core.call("butterfly.tick", {}); assert.equal(starts, 1);
		assert.equal((await t.core.call("butterfly.tasks", {}) as unknown[]).length, 1);
	});
	it("publishes butterfly waiting notifications through T83 when clarification is needed", async () => {
		await t.core.call("slot.open", { slotId: "notice", cwd: t.core.paths.butterflyDir }, t.client);
		Object.defineProperty(t.core.slot("notice"), "sandboxed", { value: true });
		t.respond(fauxAssistantMessage(JSON.stringify({ restatement: "我会整理资料", plan: "读完后整理", missing: ["资料放在哪里？"] })));
		await t.core.call("butterfly.prepare", { slotId: "notice", goal: "帮我整理资料" });
		const notifications = t.messages.filter((m) => m.event === "notification" && m.kind === "butterfly.waiting");
		assert.equal(notifications.length, 1); assert.equal((notifications[0]!.target as any).slotId, "notice");
	});
	it("accepts clarification through the owner API, then starts manually without an additional task", async () => {
		await t.core.call("slot.open", { slotId: "answer", cwd: t.core.paths.butterflyDir }, t.client);
		const slot = t.core.slot("answer"); Object.defineProperty(slot, "sandboxed", { value: true });
		let starts = 0; slot.prompt = async () => { starts++; };
		t.respond(fauxAssistantMessage(JSON.stringify({ restatement: "我要读取资料", plan: "读完总结", missing: ["资料位置？"] })));
		const first = await t.core.call("butterfly.prepare", { slotId: slot.slotId, goal: "总结资料" }) as any;
		t.respond(fauxAssistantMessage(JSON.stringify({ restatement: "我会总结 inbox", plan: "读取 inbox 后总结", missing: [] })));
		const answered = await t.core.call("butterfly.answer", { id: first.id, answer: "在 inbox 里" }) as any;
		assert.equal(answered.task_id, first.task_id); assert.equal(slot.ui.pendingCount, 0);
		await t.core.call("butterfly.start", { id: answered.id }); assert.equal(starts, 1);
		await assert.rejects(t.core.call("butterfly.start", { id: answered.id }), /不能开工/);
	});
	it("attributes outbox deliveries to their task directory when butterfly tasks overlap", async () => {
		const task = t.core.module(TasksModule)!.create({ cwd: t.core.paths.butterflyDir, goal: "deliver", source: "chat" });
		t.core.db.run("INSERT INTO butterfly_intents(id,slot_id,task_id,goal,restatement,plan,state,created_at) VALUES('delivery','unused',?,'deliver','deliver','deliver','started',?)", task.id, Date.now());
		const mine = join(t.dir, "mine.txt"), other = join(t.dir, "other.txt"); writeFileSync(mine, "mine"); writeFileSync(other, "other");
		const butterfly = t.core.module(ButterflyModule)!;
		butterfly.outbox = async () => [{ name: `${task.id}/report.txt`, path: mine, size: 4, modifiedAt: Date.now() }, { name: "other-task/report.txt", path: other, size: 5, modifiedAt: Date.now() }];
		butterfly.onRunFinished({ sandboxed: true } as never, { taskId: task.id, id: "delivery-run", startedAt: Date.now() } as never);
		await t.waitFor(() => t.core.module(TasksModule)!.listArtifacts({ taskId: task.id }).length === 1);
		assert.equal(t.core.module(TasksModule)!.listArtifacts({ taskId: task.id })[0]!.path, mine);
	});
});

describe("T85 application recycle bin", () => {
	let t: TestCore;
	beforeEach(async () => { t = await startTestCore(); });
	afterEach(async () => { await t.cleanup(); });
	it("recycles side descendants together, preserves independent forks, restores flags, and keeps Pi discovery/search/extraction/plans out", async () => {
		const parent = fixture(t, "parent"), side = fixture(t, "side", { parent, side: true }), nested = fixture(t, "nested", { parent: side, side: true }), fork = fixture(t, "fork", { parent });
		await t.core.call("sessions.list", {});
		await t.core.call("sessions.setPinned", { path: parent, pinned: true }); await t.core.call("sessions.setArchived", { path: parent, archived: true });
		const removed = await t.core.call("sessions.delete", { path: parent }) as any;
		assert.equal(removed.sideCount, 2); assert.equal(removed.deleted.length, 3); assert.ok(existsSync(fork));
		assert.equal(existsSync(parent), false); assert.equal(existsSync(side), false); assert.equal(existsSync(nested), false);
		const rows = t.core.module(SessionIndex)!.recycle.list(); assert.equal(rows.length, 3);
		assert.equal((await SessionManager.listAll(t.sessionDir)).length, 1);
		assert.equal((await t.core.call("sessions.search", { query: "找回" }) as any[]).length, 1);
		await assert.rejects(t.core.call("slot.open", { sessionFile: rows[0]!.stored_path, cwd: t.workspace }), /回收站/);
		await assert.rejects(t.core.call("schedules.save", { name: "bad", prompt: "bad", cwd: t.workspace, sessionMode: "bound", sessionFile: parent, trigger: { type: "interval", everyMs: 3600000 } }), /回收站/);
		assert.throws(() => t.core.module(MemoryModule)!.work.queueExtraction({ sessionFile: rows[0]!.stored_path, sessionId: "side", cwd: t.workspace }), /回收站/);
		t = await t.reopen();
		assert.equal((await t.core.call("sessions.recycleBin", {}) as any[]).length, 3);
		await t.core.call("sessions.restore", { batchId: removed.batchId });
		assert.ok(existsSync(parent) && existsSync(side) && existsSync(nested));
		const archived = await t.core.call("sessions.list", { archived: "only" }) as any[];
		assert.equal(archived[0].pinned, true); assert.equal((await t.core.call("sessions.children", { parentSession: parent }) as any[]).length, 2);
	});
	it("rejects restore conflicts and missing files without overwriting or losing recovery records", async () => {
		const path = fixture(t, "conflict"); const deleted = await t.core.call("sessions.delete", { path }) as any;
		writeFileSync(path, "other user's file");
		await assert.rejects(t.core.call("sessions.restore", { batchId: deleted.batchId }), /已有文件/);
		assert.equal(readFileSync(path, "utf8"), "other user's file"); unlinkSync(path);
		const row = t.core.module(SessionIndex)!.recycle.list()[0]!; unlinkSync(row.stored_path);
		await assert.rejects(t.core.call("sessions.restore", { batchId: deleted.batchId }), /缺失/);
		assert.equal(t.core.module(SessionIndex)!.recycle.list().length, 1);
	});
	it("expires precisely at 30 days, cleans on restart and preserves the independent cost ledger", async () => {
		const path = fixture(t, "expired");
		t.core.db.run("INSERT INTO request_ledger(id,requested_at,state,provider,model,purpose,amount_source,price_version,origin,amount,currency) VALUES('kept-cost',?,'completed','faux','faux-1','chat','price_estimate','test','test',0.12,'USD')", Date.now());
		const memory = await t.core.call("memory.save", { content: "项目使用 TypeScript", kind: "background", scope: "workspace", cwd: t.workspace }) as { item: MemoryItem };
		const result = await t.core.call("sessions.delete", { path }) as any;
		const index = t.core.module(SessionIndex)!; const row = index.recycle.list()[0]!;
		assert.equal(row.expires_at - row.deleted_at, RECYCLE_MS);
		assert.deepEqual(index.recycle.purgeExpired(row.expires_at - 1), { purged: [] });
		t.core.db.run("UPDATE session_recycle SET expires_at=? WHERE batch_id=?", Date.now() - 1, result.batchId);
		t = await t.reopen(); assert.equal(t.core.module(SessionIndex)!.recycle.list().length, 0); assert.equal(existsSync(row.stored_path), false);
		assert.equal(t.core.db.get<{ amount: number }>("SELECT amount FROM request_ledger WHERE id='kept-cost'")!.amount, 0.12);
		assert.ok(t.core.module(MemoryModule)!.store.get(memory.item.id));
	});
	it("rolls forward a partially linked delete and a partially restored batch after restart", async () => {
		const path = fixture(t, "crash"), side = fixture(t, "crash-side", { parent: path, side: true });
		const deleted = await t.core.call("sessions.delete", { path }) as any;
		let rows = t.core.module(SessionIndex)!.recycle.list();
		linkSync(rows[0]!.stored_path, rows[0]!.original_path); // crash after exclusive link, before unlink
		t.core.db.run("UPDATE session_recycle SET phase='deleting' WHERE batch_id=?", deleted.batchId);
		t = await t.reopen(); rows = t.core.module(SessionIndex)!.recycle.list(); assert.equal(existsSync(rows[0]!.original_path), false);
		linkSync(rows[0]!.stored_path, rows[0]!.original_path); unlinkSync(rows[0]!.stored_path);
		t.core.db.run("UPDATE session_recycle SET phase='restoring' WHERE batch_id=?", deleted.batchId);
		t = await t.reopen(); assert.ok(existsSync(path) && existsSync(side)); assert.equal(t.core.module(SessionIndex)!.recycle.list().length, 0);
	});
	it("rejects a junction into an external directory and preserves both user files and the recoverable journal", async () => {
		const path = fixture(t, "escape"), external = join(t.dir, "external"); mkdirSync(external);
		const sentinel = join(external, "user.txt"); writeFileSync(sentinel, "keep");
		symlinkSync(external, join(t.sessionDir, ".recycle"), process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(t.core.call("sessions.delete", { path }), /链接/);
		assert.equal(readFileSync(sentinel, "utf8"), "keep"); assert.ok(existsSync(path));
		assert.equal(t.core.module(SessionIndex)!.recycle.list().length, 1);
	});
	it("keeps conversation cards attached until final cleanup", async () => {
		const path = fixture(t, "card-parent");
		t.core.db.run("INSERT INTO cards(id,title,cwd,session_file,origin,digest,created_at,updated_at) VALUES('recycle-card','card',?,?,'agent','test',?,?)", t.workspace, path, Date.now(), Date.now());
		const deleted = await t.core.call("sessions.delete", { path }) as any;
		assert.ok(t.core.db.get("SELECT 1 FROM cards WHERE id='recycle-card'"));
		await t.core.call("sessions.restore", { batchId: deleted.batchId }); assert.ok(t.core.db.get("SELECT 1 FROM cards WHERE id='recycle-card'"));
		await t.core.call("sessions.delete", { path });
		const row = t.core.module(SessionIndex)!.recycle.list()[0]!;
		t.core.module(SessionIndex)!.recycle.purgeExpired(row.expires_at); await Promise.resolve();
		assert.equal(t.core.db.get("SELECT 1 FROM cards WHERE id='recycle-card'"), undefined);
	});
});
