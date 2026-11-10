import assert from "node:assert/strict";
import fs, { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MemoryModule } from "../src/modules/memory.ts";
import { SessionIndex, type SessionRow } from "../src/modules/session-index.ts";
import type { SlotInfo } from "../src/slots/slot.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

describe("T-07 side sessions / F-01 first-send transaction", () => {
	let t: TestCore;
	beforeEach(async () => { t = await startTestCore(); });
	afterEach(async () => { mock.restoreAll(); syncBuiltinESMExports(); await t.cleanup(); });
	const files = () => readdirSync(t.sessionDir).filter((f) => f.endsWith(".jsonl"));
	async function open(id: string, extra: Record<string, unknown> = {}) {
		return await t.core.call("slot.open", { slotId: id, cwd: t.workspace, ...extra }, t.client) as SlotInfo;
	}
	async function send(id: string, message: string, requestId = message) {
		t.respond(fauxAssistantMessage("回答 " + message));
		const n = settledCount(t.records(id));
		await t.send(id, { id: requestId, type: "prompt", message });
		await t.waitFor(() => settledCount(t.records(id)) === n + 1);
	}
	async function parent() { const p = await open("parent"); await send("parent", "父历史"); return p; }
	function pauseBind(slotId: string) {
		const slot = t.core.slot(slotId) as any;
		const bind = slot.bind.bind(slot);
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const ready = new Promise<void>((r) => { entered = r; });
		mock.method(slot, "bind", async (...args: unknown[]) => { await bind(...args); entered(); await gate; });
		return { release, ready };
	}
	it("opening alone writes nothing; first send preserves identity and copied history, excludes memory/search/tasks and inherited usage", async () => {
		const p = await parent();
		const before = readFileSync(p.sessionFile!, "utf8");
		const side = await open("side", { forkOf: p.sessionFile, sideQuote: "父历史", quoteEntryId: "quote-id" });
		assert.equal(side.sessionType, "side"); assert.equal(side.willPersist, true);
		assert.equal(side.sessionFile, null); assert.equal(files().length, 1);
		const slot = t.core.slot("side");
		const tools = slot.session.getActiveToolNames();
		assert.ok(!tools.some((name) => name.startsWith("memory_")));
		t.core.settings.update({ memoryAutoExtract: true });
		let seen = "";
		let calls = 0;
		t.respond((ctx) => { calls++; seen = JSON.stringify(ctx.messages); return fauxAssistantMessage("侧边答案"); });
		await t.send("side", { id: "first", type: "prompt", message: "独有侧边问题" });
		await t.waitFor(() => settledCount(t.records("side")) === 1);
		assert.match(seen, /父历史/); assert.equal(calls, 1);
		assert.equal(slot.info().sessionId, side.sessionId); assert.equal(slot.info().slotId, side.slotId);
		assert.ok(existsSync(slot.info().sessionFile!)); assert.equal(files().length, 2);
		assert.equal(readFileSync(p.sessionFile!, "utf8"), before);
		await t.send("side", { id: "first", type: "prompt", message: "独有侧边问题" });
		assert.equal(calls, 1, "successful request replay does not send twice");
		const list = await t.core.call("sessions.list", { cwd: t.workspace }) as SessionRow[];
		assert.deepEqual(list.map((r) => r.path), [p.sessionFile]);
		const children = await t.core.call("sessions.children", { parentSession: p.sessionFile, cwd: t.workspace }) as SessionRow[];
		assert.deepEqual(await t.core.call("sessions.children", {parentSession:p.sessionFile,cwd:join(t.dir,"other-workspace")}), []);
		assert.equal(children.length, 1); assert.equal(children[0]!.quote, "父历史"); assert.equal(children[0]!.quoteEntryId, "quote-id");
		assert.deepEqual(await t.core.call("sessions.search", { query: "独有侧边" }), []);
		assert.equal(t.core.db.get<{n:number}>("SELECT COUNT(*) AS n FROM usage_records WHERE path = ?", slot.info().sessionFile!)!.n, 1);
		assert.equal(slot.taskId, null);
		assert.deepEqual(await t.core.call("memory.tasks", { sessionId: side.sessionId }), []);
		assert.deepEqual(await t.core.call("memory.snapshots", { sessionId: side.sessionId }), []);
		assert.equal(await t.core.call("memory.extractNow", { slotId: "side" }), null);
		for (const method of ["memory.newTask", "memory.continueTask", "memory.refresh", "memory.setSessionMode"]) {
			await assert.rejects(t.core.call(method, { sessionId: side.sessionId, mode: "normal" }), /侧边/);
		}
		const path = slot.info().sessionFile!;
		await t.core.closeSlot("side");
		await t.core.closeSlot("parent");
		rmSync(p.sessionFile!);
		t = await t.reopen();
		const reopened = await open("again", { sessionFile: path });
		assert.equal(reopened.sessionType, "side"); assert.equal(reopened.sessionId, side.sessionId);
		assert.match(JSON.stringify(t.core.slot("again").session.messages), /父历史/);
		await send("again", "重开仍隔离");
		assert.equal(t.core.slot("again").taskId, null);
		await t.core.module(SessionIndex)!.refresh();
		assert.equal(t.core.module(SessionIndex)!.get(path)!.parentMissing, true);
	});
	it("close without sending leaves no side file, incognito descendants never persist", async () => {
		const p = await parent();
		await open("unused", { forkOf: p.sessionFile }); await t.core.closeSlot("unused");
		assert.equal(files().length, 1);
		await open("private", { incognito: true }); await send("private", "隐私历史");
		const side = await open("side", { parentSlotId: "private", sideQuote: "隐私" });
		assert.equal(side.incognito, true); assert.equal(side.willPersist, false);
		await send("side", "隐私追问"); assert.equal(files().length, 1);
	});
	it("reopen failure rolls back file/index/runtime and a retry sends exactly once", async () => {
		const p = await parent(); const side = await open("side", { forkOf: p.sessionFile });
		const slot = t.core.slot("side"); const original = slot.session;
		const bind = mock.method(slot as any, "bind", async () => { throw new Error("injected bind failure"); });
		await t.send("side", { id: "first", type: "prompt", message: "重试输入" });
		assert.equal((await t.waitFor(() => t.records("side").find((r) => r.id === "first")))!.success, false);
		assert.equal(slot.session, original); assert.equal(slot.info().sessionId, side.sessionId);
		assert.equal(files().length, 1); assert.equal(t.core.pendingSessionFiles.size, 0);
		await t.core.module(SessionIndex)!.refresh();
		assert.equal(t.core.db.get<{n:number}>("SELECT COUNT(*) AS n FROM session_meta")!.n, 1);
		assert.ok(!JSON.stringify(slot.session.messages).includes("重试输入"));
		bind.mock.restore(); await send("side", "重试输入", "first"); assert.equal(files().length, 2);
	});
	it("snapshot collision reports failure without destroying an existing file", async () => {
		const p = await parent(); await open("side", { forkOf: p.sessionFile });
		const manager = t.core.slot("side").session.sessionManager;
		const path = join(t.sessionDir, manager.getHeader()!.timestamp.replace(/[:.]/g, "-") + "_" + manager.getSessionId() + ".jsonl");
		writeFileSync(path, "existing");
		await t.send("side", { id: "first", type: "prompt", message: "不得发出" });
		assert.equal((await t.waitFor(() => t.records("side").find((r) => r.id === "first")))!.success, false);
		assert.equal(readFileSync(path, "utf8"), "existing"); assert.equal(t.core.slot("side").info().sessionFile, null);
		rmSync(path);
	});
	it("concurrent sends cannot publish an index or send twice during replacement", async () => {
		const p = await parent(); await open("side", { forkOf: p.sessionFile }); const gate = pauseBind("side");
		t.respond(fauxAssistantMessage("only once"));
		const first = t.send("side", { id: "one", type: "prompt", message: "first" }); await gate.ready;
		await t.send("side", { id: "two", type: "prompt", message: "second" });
		assert.equal((await t.waitFor(() => t.records("side").find((r) => r.id === "two")))!.success, false);
		await t.core.module(SessionIndex)!.refresh();
		assert.equal(t.core.db.get<{n:number}>("SELECT COUNT(*) AS n FROM session_meta")!.n, 1);
		gate.release(); await first; await t.waitFor(() => settledCount(t.records("side")) === 1);
		assert.equal(files().length, 2);
		assert.ok(!t.core.slot("side").session.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("second")));
	});
	it("partial snapshot write is cleaned up and the original input can be retried", async () => {
		const p = await parent(); await open("side", { forkOf: p.sessionFile });
		const original = fs.writeFileSync;
		const write = mock.method(fs, "writeFileSync", ((file: any, data: any, options: any) => {
			if (typeof file === "number") { original(file, "partial snapshot"); throw new Error("injected disk full"); }
			return original(file, data, options);
		}) as typeof fs.writeFileSync);
		syncBuiltinESMExports();
		await t.send("side", { id: "disk", type: "prompt", message: "磁盘故障后重试" });
		assert.equal((await t.waitFor(() => t.records("side").find((r) => r.id === "disk")))!.success, false);
		assert.equal(files().length, 1); assert.equal(t.core.slot("side").info().sessionFile, null);
		write.mock.restore(); syncBuiltinESMExports();
		await send("side", "磁盘故障后重试", "disk"); assert.equal(files().length, 2);
	});
	it("C6 guards event, tool, task, extraction and weekly inputs, including a stale queued extraction", async () => {
		const p = await parent(); const memory = t.core.module(MemoryModule)!;
		const extract = mock.method(memory.work, "queueExtraction");
		const recalled = mock.method(memory.work, "checkRecalled");
		const refute = mock.method(memory.work, "refuteByTool");
		const prepare = mock.method(memory.work, "queueMaterials");
		const calibration = mock.method((memory as any).calibration, "afterCall");
		t.core.settings.update({ memoryAutoExtract: true });
		const side = await open("side", { forkOf: p.sessionFile });
		t.respond(fauxAssistantMessage("我已经记住了，以后都会按这个偏好来。"));
		await t.send("side", { id: "memory", type: "prompt", message: "独有侧边记忆不得入库" });
		await t.waitFor(() => settledCount(t.records("side")) === 1);
		const slot = t.core.slot("side");
		memory.onSlotEvent(slot, { type: "tool_execution_start", toolCallId: "tool", toolName: "pwsh", args: {command:"echo ok"} } as never);
		memory.onSlotEvent(slot, { type: "tool_execution_end", toolCallId: "tool", toolName: "pwsh", isError:false, result:{content:[{type:"text",text:"ok"}]} } as never);
		for (const spy of [extract,recalled,refute,prepare,calibration]) assert.equal(spy.mock.callCount(), 0);
		assert.equal(await t.core.call("memory.unsaved", {sessionId:side.sessionId}), null);
		assert.deepEqual(await t.core.call("memory.items", {}), []);
		assert.equal(t.messages.some((m) => m.event === "memory.task" && m.sessionId === side.sessionId), false);
		const task = await t.core.call("tasks.create", {cwd:t.workspace,goal:"normal"}) as {task:{id:string}};
		await assert.rejects(t.core.call("tasks.bind", {slotId:"side",taskId:task.task.id}), /侧边/);
		const queued = memory.work.queueExtraction({sessionId:side.sessionId!,sessionFile:slot.info().sessionFile!,cwd:t.workspace});
		await memory.work.drain();
		assert.equal(memory.work.jobs.get(queued.id)!.status, "skipped");
		assert.equal(memory.work.jobs.get(queued.id)!.costUsd, 0);
		assert.equal(t.core.db.get("SELECT * FROM memory_extraction WHERE session_id = ?", side.sessionId!), undefined);
		// Weekly review consumes memory_items, never raw sessions. With no extracted items it has no input.
		const weekly = memory.work.jobs.enqueue({kind:"tidy_l1",scopeKey:"global",payload:{level:1,period:"week"},priority:10});
		await memory.work.drain();
		assert.equal(memory.work.jobs.get(weekly.id)!.status, "skipped");
		assert.deepEqual(await t.core.call("memory.items", {}), []);
	});
	it("side compaction remains available and charges only its own calls; ordinary clone is not a side", async () => {
		const p = await parent();
		const m = t.core.slot("parent").session.sessionManager;
		const usage = {input:100,output:10,cacheRead:0,cacheWrite:0,totalTokens:110,cost:{input:1,output:0.1,cacheRead:0,cacheWrite:0,total:1.1}};
		m.appendUsage("background", "faux", "faux-1", usage);
		m.appendCompaction("父摘要", m.getBranch().find((e) => e.type === "message")!.id, 1000, undefined, false, usage);
		await open("side", {forkOf:p.sessionFile}); await send("side", "侧边自己的调用");
		t.respond(fauxAssistantMessage("## Primary Request and Intent\n- 侧边压缩摘要"));
		await t.send("side", {id:"compact",type:"compact"});
		assert.equal((await t.waitFor(() => t.records("side").find((r) => r.id === "compact")))!.success, true);
		const slot = t.core.slot("side");
		await t.core.module(SessionIndex)!.refresh();
		const rows = t.core.db.all<{entry_id:string,cost:number}>("SELECT entry_id, cost FROM usage_records WHERE path = ?",slot.info().sessionFile!);
		await t.send("side", {id:"stats",type:"get_session_stats"});
		const stats = (await t.waitFor(()=>t.records("side").find((r)=>r.id==="stats")))!.data as {cost:number};
		assert.equal(stats.cost,0);
		assert.equal(rows.length,2); assert.equal(rows.reduce((sum,r)=>sum+r.cost,0),0,"parent's charged calls were not counted again");
		assert.equal(slot.session.sessionManager.getEntries().filter((e)=>e.type==="compaction").length,2);
		await t.send("side",{id:"clone",type:"clone"});
		assert.equal((await t.waitFor(()=>t.records("side").find((r)=>r.id==="clone")))!.success,true);
		assert.equal(slot.info().sessionType,"ordinary");
		await t.core.module(SessionIndex)!.refresh();
		assert.equal(t.core.db.get<{n:number}>("SELECT COUNT(*) AS n FROM usage_records WHERE path = ?",slot.info().sessionFile!)!.n,0);
		assert.ok(t.core.module(SessionIndex)!.list().some((r)=>r.path===slot.info().sessionFile));
	});

	for (const shutdown of [false, true]) it(shutdown ? "shutdown during replacement joins rollback" : "close during replacement joins rollback", async () => {
		const p = await parent(); await open("side", { forkOf: p.sessionFile }); const gate = pauseBind("side");
		const sending = t.send("side", { id: "one", type: "prompt", message: "never" }); await gate.ready;
		const closing = t.core.closeSlot("side");
		const stopping = shutdown ? t.core.shutdown() : Promise.resolve();
		if (shutdown) await t.waitFor(() => !t.core.slots.has("side"));
		gate.release(); await Promise.all([sending, closing, stopping]); assert.equal(files().length, 1);
	});
	it("T85 deleting a parent during the side's first send joins its transaction and leaves no published side behind", async () => {
		const p = await parent(); await open("side", { forkOf: p.sessionFile }); const gate = pauseBind("side");
		const sending = t.send("side", { id: "concurrent-delete", type: "prompt", message: "must join deletion" }); await gate.ready;
		const deleting = t.core.call("sessions.delete", { path: p.sessionFile });
		await t.waitFor(() => !t.core.slots.has("side")); gate.release();
		await sending; const deleted = await deleting as { batchId: string };
		assert.equal(files().length, 0); assert.equal((await t.core.call("sessions.list", {}) as unknown[]).length, 0);
		await t.core.call("sessions.restore", { batchId: deleted.batchId }); assert.equal(files().length, 1);
	});
	it("mode and sandbox come from the parent, and reused client request IDs after reattach are new sends", async () => {
		t.core.settings.update({ agentMode: "minimal" });
		const p = await parent();
		t.core.settings.update({ agentMode: "standard" });
		const side = await open("side", {forkOf:p.sessionFile,sandbox:true});
		assert.equal(side.agentMode,"minimal"); assert.equal(side.sandbox,false);
		await send("side","same input","same-id");
		await t.core.call("slot.attach",{slotId:"side"},t.client);
		await send("side","same input","same-id");
		assert.equal(t.core.slot("side").session.messages.filter((m)=>m.role==="user"&&JSON.stringify(m.content).includes("same input")).length,2);
	});
	it("close requested after model dispatch keeps the complete saved conversation", async () => {
		const p = await parent(); const side = await open("side", {forkOf:p.sessionFile});
		let calls=0; let closing: Promise<void> | undefined;
		t.respond(()=>{calls++; closing=t.core.closeSlot("side"); return fauxAssistantMessage("dispatched");});
		await t.send("side",{id:"closing",type:"prompt",message:"dispatched question"});
		await t.waitFor(()=>closing);
		await closing;
		assert.equal(calls,1); assert.equal(files().length,2);
		const path=files().find((f)=>f.includes(side.sessionId!))!;
		assert.match(readFileSync(join(t.sessionDir,path),"utf8"),/dispatched question/);
	});

	it("ordinary forks stay listed, inherit no usage, and survive parent deletion while side children cascade", async () => {
		const p = await parent(); const source = t.core.slot("parent").session.sessionManager;
		const fork = SessionManager.forkFrom(p.sessionFile!, t.workspace, t.sessionDir);
		// Old unmarked forks also need accurate inherited accounting.
		const ordinary = await open("ordinary", { sessionFile: fork.getSessionFile() });
		await send("ordinary", "分叉自己的问题");
		await open("side", { forkOf: p.sessionFile }); await send("side", "侧边自己的问题");
		const sidePath = t.core.slot("side").info().sessionFile!;
		await t.core.module(SessionIndex)!.refresh();
		assert.equal(t.core.db.get<{n:number}>("SELECT COUNT(*) AS n FROM usage_records WHERE path = ?", ordinary.sessionFile!)!.n, 1);
		assert.equal((await t.core.call("sessions.children", { parentSession: p.sessionFile }) as unknown[]).length, 2);
		const preview = await t.core.call("sessions.deletePreview", { path: p.sessionFile }) as {sideCount:number}; assert.equal(preview.sideCount, 1);
		const deleted = await t.core.call("sessions.delete", { path: p.sessionFile }) as {sideCount:number}; assert.equal(deleted.sideCount, 1);
		assert.equal(t.core.db.get("SELECT path FROM session_meta WHERE path = ?",sidePath),undefined);
		assert.equal(t.core.db.get("SELECT path FROM usage_records WHERE path = ?",sidePath),undefined);
		assert.equal(existsSync(sidePath), false); assert.equal(existsSync(p.sessionFile!), false); assert.equal(existsSync(ordinary.sessionFile!), true);
		assert.equal(t.core.module(SessionIndex)!.get(ordinary.sessionFile!)!.parentMissing, true);
		assert.equal(source.getSessionId(), p.sessionId);
	});
});
