import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Db } from "../src/db.ts";
import { SettingsStore, purposeModel } from "../src/settings.ts";
import { Llm } from "../src/modules/llm.ts";
import { MemoryModule } from "../src/modules/memory.ts";
import { StartupProgress } from "../src/startup.ts";
import { excludedFromData } from "../src/backup/export.ts";
import { APPROVAL_TITLE, ALLOW, DENY } from "../src/pi/dialogs.ts";
import type { ActionReceipt, AttentionItem } from "../src/modules/attention.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

describe("T-83 settings migration", () => {
	it("preserves all legacy model purposes, migrates once and bridges old clients", () => {
		const db = new Db(":memory:");
		try {
			for (const [key,value] of Object.entries({ defaultModel: "p/chat", auxModel: "p/cheap", memoryModel: "p/memory", visionModel: "p/vision", backgroundCompactionModel: "aux" })) db.run("INSERT INTO settings(key,value) VALUES(?,?)", key, JSON.stringify(value));
			const s = new SettingsStore(db);
			assert.equal(s.get().smallTaskModel, "p/cheap");
			assert.equal(purposeModel(s.get(), "memory"), "p/memory");
			assert.equal(purposeModel(s.get(), "compaction"), "p/cheap");
			assert.equal(s.get().visionModel, "p/vision");
			assert.equal(s.get().defaultModel, "p/chat");
			assert.equal(s.get().firstSetupComplete, true, "existing users do not get a new wizard");
			s.update({ smallTaskModel: "new/small", largeTaskModel: "new/large", modelOverrides: {} });
			const reopened = new SettingsStore(db);
			assert.equal(purposeModel(reopened.get(), "compaction"), "new/large");
			assert.equal(purposeModel(reopened.get(), "memory"), "new/small");
			reopened.update({ auxModel: "old/client", memoryModel: "old/mem", backgroundCompactionModel: "session" });
			assert.equal(reopened.get().smallTaskModel, "old/client");
			assert.equal(purposeModel(reopened.get(), "memory"), "old/mem");
			assert.equal(purposeModel(reopened.get(), "compaction"), null);
		} finally { db.close(); }
	});
	it("new users have role defaults and only the three approved waiting times", () => {
		const db = new Db(":memory:");
		try {
			const s = new SettingsStore(db);
			assert.equal(s.get().firstSetupComplete, false);
			assert.equal(s.get().butterflyStartWaitSeconds, 60);
			for (const seconds of [10,0,60]) assert.equal(s.update({ butterflyStartWaitSeconds: seconds }).butterflyStartWaitSeconds, seconds);
			assert.equal(s.update({ butterflyStartWaitSeconds: 15 }).butterflyStartWaitSeconds, 60);
			assert.equal(s.update({ modelOverrides: { memory: 7 } }).modelOverrides.memory, undefined);
		} finally { db.close(); }
	});
});

type Attention = {now: AttentionItem[]; later: AttentionItem[]; counts: {total:number}; pending: ActionReceipt[]};
describe("T-83 integration", () => {
	let t: TestCore;
	beforeEach(async () => { t = await startTestCore(); });
	afterEach(async () => { await t.cleanup(); });
	const list = async () => await t.core.call("attention.list", {}) as Attention;
	const propose = async (name = "t83-skill") => await t.core.call("skills.register", { name, description: "T83 test skill", content: `---\nname: ${name}\ndescription: T83 test skill\n---\n\nRead the task carefully.`, files: {"scripts/check.py": "print('test')\n"} }) as {id:string};

	it("projects owner queues, cancels within 5 seconds, executes once after the deadline", async ctx => {
		const p = await propose();
		const before = await list();
		assert.equal(before.later.find(i => i.id === `proposal:${p.id}`)?.data.proposalKind, "skill");
		ctx.mock.timers.enable({apis:["setTimeout","Date"]});
		try {
			const first = await t.core.call("attention.resolve", {id:`proposal:${p.id}`,action:"allow"}) as ActionReceipt;
			assert.equal(first.undoable, true); assert.equal(first.remainingMs, 5000);
			assert.ok(!(await list()).later.some(i => i.id === first.itemId));
			assert.equal(t.core.db.get<{status:string}>("SELECT status FROM proposals WHERE id=?", p.id)!.status, "pending");
			assert.ok(!existsSync(join(t.agentDir,"skills","t83-skill","SKILL.md")));
			await assert.rejects(t.core.call("attention.resolve", {id:first.itemId,action:"allow"}), /正在处理/);
			ctx.mock.timers.tick(4999);
			assert.equal((await t.core.call("attention.receipt",{id:first.id}) as ActionReceipt).remainingMs,1);
			const undone = await t.core.call("attention.undo",{id:first.id}) as ActionReceipt;
			assert.equal(undone.status,"cancelled"); assert.equal(undone.remainingMs,0);
			assert.ok((await list()).later.some(i => i.id === first.itemId));
			const second = await t.core.call("attention.resolve", {id:first.itemId,action:"allow"}) as ActionReceipt;
			ctx.mock.timers.tick(5000); await nextTurn();
			assert.equal((await t.core.call("attention.receipt",{id:second.id}) as ActionReceipt).status,"applied");
			assert.equal(t.core.db.get<{status:string}>("SELECT status FROM proposals WHERE id=?",p.id)!.status,"accepted");
			assert.ok(existsSync(join(t.agentDir,"skills","t83-skill","scripts","check.py")));
			await assert.rejects(t.core.call("attention.undo",{id:second.id}), /不能撤销/);
			assert.ok(t.messages.some(m => m.event === "attention.changed"));
			assert.ok(t.messages.some(m => m.event === "attention.action"));
		} finally { ctx.mock.timers.reset(); }
	});

	it("flushes a deferred confirmation on normal shutdown; never executes a cancelled one", async () => {
		const p = await propose("t83-flush"), other = await propose("t83-cancel");
		await t.core.call("attention.resolve",{id:`proposal:${p.id}`,action:"reject"});
		const cancelled = await t.core.call("attention.resolve",{id:`proposal:${other.id}`,action:"reject"}) as ActionReceipt;
		await t.core.call("attention.undo",{id:cancelled.id});
		t = await t.reopen();
		assert.equal(t.core.db.get<{status:string}>("SELECT status FROM proposals WHERE id=?",p.id)!.status,"rejected");
		assert.equal(t.core.db.get<{status:string}>("SELECT status FROM proposals WHERE id=?",other.id)!.status,"pending");
	});

	it("returns failed receipts for stale actions without calling the owner twice", async ctx => {
		const p = await propose();
		ctx.mock.timers.enable({apis:["setTimeout","Date"]});
		try {
			const receipt = await t.core.call("attention.resolve",{id:`proposal:${p.id}`,action:"allow"}) as ActionReceipt;
			await t.core.call("proposals.reject",{id:p.id});
			ctx.mock.timers.tick(5000); await nextTurn();
			const r = await t.core.call("attention.receipt",{id:receipt.id}) as ActionReceipt;
			assert.equal(r.status,"failed"); assert.equal(r.undoable,false);
			assert.ok(!existsSync(join(t.agentDir,"skills","t83-skill","SKILL.md")));
		} finally {ctx.mock.timers.reset();}
	});

	it("answers approvals and questions immediately, validates choices, and provides no undo", async () => {
		await t.core.call("slot.open", {slotId:"s",cwd:t.workspace},t.client);
		const ui = t.core.slot("s").ui.context();
		const answer = ui.select(APPROVAL_TITLE,[ALLOW,DENY]);
		const approval = (await list()).now.find(i => i.kind === "approval")!;
		assert.ok(approval.actions.includes("allow"));
		const r = await t.core.call("attention.resolve",{id:approval.id,action:"allow"}) as ActionReceipt;
		assert.equal(await answer,ALLOW); assert.equal(r.status,"applied"); assert.equal(r.undoable,false);
		await assert.rejects(t.core.call("attention.undo",{id:r.id}),/不能撤销/);
		const question = ui.select("选一个",["甲","乙"]);
		const item = (await list()).now.find(i => i.kind === "question")!;
		await assert.rejects(t.core.call("attention.resolve",{id:item.id,action:"answer",response:{value:"丙"}}),/有效回答/);
		await t.core.call("attention.resolve",{id:item.id,action:"answer",response:{value:"乙"}});
		assert.equal(await question,"乙");
	});

	it("limit and interrupted cards resolve immediately and counts are not capped at 100", async () => {
		for (let i=0;i<105;i++) t.core.db.run("INSERT INTO notices(id,kind,title,status,created_at) VALUES(?,'limit_turns','轮数到了','pending',?)",`n${i}`,Date.now()+i);
		assert.equal((await list()).now.filter(i => i.kind === "limit").length,105);
		const r = await t.core.call("attention.resolve",{id:"limit:n1",action:"end"}) as ActionReceipt;
		assert.equal(r.status,"applied"); assert.equal(r.undoable,false);
		assert.equal(t.core.db.get<{status:string}>("SELECT status FROM notices WHERE id='n1'")!.status,"stopped");
		const run = {id:"t83-orphan"};
		t.core.db.run("INSERT INTO runs(id,slot_id,cwd,status,started_at,prompt) VALUES(?,'orphan',?,'running',?,'中断测试')",run.id,t.workspace,Date.now());
		t.core.runs.interruptOrphans();
		assert.ok((await list()).now.some(i => i.id === `interrupted:${run.id}`));
		await t.core.call("attention.resolve",{id:`interrupted:${run.id}`,action:"end"});
		assert.ok(!(await list()).now.some(i => i.id === `interrupted:${run.id}`));
	});

	it("MCP trust is delayed too, then handed to its original owner", async ctx => {
		const p = await t.core.call("mcp.register",{server:{name:"t83-service",transport:"stdio",command:"T83_NONEXISTENT_EXECUTABLE",exposure:"direct"}}) as {id:string};
		ctx.mock.timers.enable({apis:["setTimeout","Date"]});
		try {
			const item = (await list()).later.find(i => i.id === `proposal:${p.id}`)!;
			assert.equal(item.data.proposalKind,"mcp");
			const r = await t.core.call("attention.resolve",{id:item.id,action:"allow"}) as ActionReceipt;
			assert.equal(t.core.db.get<{status:string}>("SELECT status FROM proposals WHERE id=?",p.id)!.status,"pending");
			ctx.mock.timers.tick(5000); await nextTurn();
			assert.equal((await t.core.call("attention.receipt",{id:r.id}) as ActionReceipt).status,"applied");
			const servers = await t.core.call("mcp.list",{}) as {servers:{name:string;trust:string}[]};
			assert.equal(servers.servers.find(s => s.name === "t83-service")!.trust,"trusted");
		} finally {ctx.mock.timers.reset();}
	});

	it("summarizes memory promotions with origin and cancels them without a memory write", async () => {
		const memory = t.core.module(MemoryModule)!;
		const result = memory.store.commit({actor:"main_agent",sessionRef:join(t.sessionDir,"source.jsonl"),ops:[{kind:"add",item:{content:"T83 用户的长期偏好",scope:"global",level:1,kind:"preference",confidence:"user_reported"}}]});
		assert.equal(result.pending.length,1);
		const item = (await list()).later.find(i => i.kind === "memory")!;
		assert.match(item.reason,/其他项目|确认/); assert.equal(item.origin.sessionFile,join(t.sessionDir,"source.jsonl"));
		const r = await t.core.call("attention.resolve",{id:item.id,action:"allow"}) as ActionReceipt;
		await t.core.call("attention.undo",{id:r.id});
		assert.equal(memory.store.getPending(result.pending[0]!.pendingId)!.status,"pending");
	});

	it("window presence gates the four notification classes and disappears on disconnect", async () => {
		const center = t.core.notifications, input = {title:"完成",body:"结果",target:{page:"chat",slotId:"s"}};
		await t.core.call("notifications.presence",{foreground:true,slotId:"s"},t.client);
		assert.equal(center.publish("workbench.done",input),false);
		assert.equal(center.publish("workbench.approval",input),false);
		assert.equal(center.publish("butterfly.done",input),true);
		assert.equal(center.publish("butterfly.waiting",input),true);
		await t.core.call("notifications.presence",{foreground:true,slotId:"other"},t.client);
		assert.equal(center.publish("workbench.approval",input),true);
		await t.core.call("notifications.presence",{foreground:false},t.client);
		assert.equal(center.publish("workbench.done",input),true);
		assert.ok(t.messages.filter(m => m.event === "notification").every(m => !!m.target));
		t.core.removeClient(t.client); assert.equal(center.foreground(),false);
		t.core.settings.update({notifications:false}); assert.equal(center.publish("butterfly.done",input),false);
	});

	it("pre-start butterfly questions share Core's single notification path and notices keep one legacy fallback", async () => {
		await t.core.call("slot.open",{slotId:"pre-start",cwd:t.workspace},t.client);
		const slot = t.core.slot("pre-start");
		// Exercise only routing, with no WSL import or command execution.
		Object.defineProperty(slot,"sandboxed",{value:true,configurable:true});
		try {
			const answer=slot.ui.context().input("蝶君等你补充信息","需要交付给谁？");
			assert.equal(t.messages.filter(m=>m.event==="notification" && m.kind==="butterfly.waiting").length,1);
			const pending=t.core.confirmations.list({status:"pending"})[0]!;
			await t.core.call("confirm.answer",{id:pending.id,response:{value:"给我"}}); assert.equal(await answer,"给我");
			const before=t.notifier.sent.length;
			t.core.broadcast({event:"notices.changed",notice:{id:"budget",slotId:slot.slotId,title:"今天的额度到了"}});
			assert.equal(t.notifier.sent.length,before,"notice owner retains its single legacy delivery");
		} finally { Reflect.deleteProperty(slot,"sandboxed"); }
	});

	it("startup events report actual phases and exit activity follows a real run", async () => {
		assert.equal(excludedFromData("core-startup.json"),true,"runtime startup state is never restored from backups");
		const progress = await t.core.call("core.startup",{}) as ReturnType<StartupProgress["snapshot"]>;
		assert.equal(progress.ready,true); assert.ok(progress.phases.some(p => p.name === "MemoryModule"));
		assert.ok(progress.phases.every(p => p.durationMs >= 0));
		t.core.startup.mark("test-phase","正在验证……");
		assert.ok(t.messages.some(m => m.event === "core.startup" && (m.current as {name:string}).name === "test-phase"));
		await t.core.call("slot.open",{slotId:"run",cwd:t.workspace},t.client);
		t.respond(async () => { await new Promise(resolve => setTimeout(resolve,150)); return fauxAssistantMessage("完成"); });
		await t.send("run",{type:"prompt",message:"测试活动"});
		await t.waitFor(() => t.core.slot("run").running);
		assert.equal((await t.core.call("core.activity",{}) as {count:number}).count,1);
		await t.waitFor(() => settledCount(t.records("run")) === 1);
		assert.equal((await t.core.call("core.activity",{}) as {count:number}).count,0);
	});

	it("the purpose model resolver uses small, large, advanced overrides and fallback", async () => {
		const llm = new Llm(t.core);
		await t.core.call("slot.open",{slotId:"models",cwd:t.workspace},t.client);
		const runtime = t.core.slot("models").session.modelRuntime;
		t.core.settings.update({smallTaskModel:"faux/faux-text",largeTaskModel:"faux/faux-1",modelOverrides:{memory:"faux/faux-1"}});
		assert.equal((await llm.modelFor("title",runtime))!.id,"faux-text");
		assert.equal((await llm.modelFor("memory",runtime))!.id,"faux-1");
		assert.equal((await llm.modelFor("analysis",runtime))!.id,"faux-1");
		t.core.settings.update({largeTaskModel:"missing/model"});
		assert.equal((await llm.modelFor("compaction",runtime,"faux/faux-text"))!.id,"faux-text");
	});

	it("manual compaction uses the large-task model and records the actual writer", async () => {
		await t.core.call("slot.open",{slotId:"summary",cwd:t.workspace},t.client);
		t.core.settings.update({largeTaskModel:"faux/faux-text",modelOverrides:{}});
		const writers: string[] = [];
		t.respond(fauxAssistantMessage("一"),fauxAssistantMessage("二"),(_c,_o,_s,model) => {writers.push(model.id); return fauxAssistantMessage("## Primary Request and Intent\n保留两件事");});
		await t.send("summary",{type:"prompt",message:"第一件事"});
		await t.waitFor(() => settledCount(t.records("summary")) === 1);
		await t.send("summary",{type:"prompt",message:"第二件事"});
		await t.waitFor(() => settledCount(t.records("summary")) === 2);
		await t.core.call("context.compactNow",{slotId:"summary"});
		assert.deepEqual(writers,["faux-text"]);
		assert.equal(t.core.slot("summary").session.model!.id,"faux-1","the conversation keeps its model");
		assert.equal(t.core.db.get<{model:string}>("SELECT model FROM context_compactions WHERE kind='manual' ORDER BY rowid DESC LIMIT 1")!.model,"faux/faux-text");
		assert.equal(t.core.ledger!.entries({limit:100}).find(e => e.purpose === "compaction")!.model,"faux-text");
	});

	it("first setup validates root/workspace, saves one batch, and is idempotent", async () => {
		const initial = await t.core.call("setup.status",{}) as {completed:boolean;dataRoot:string};
		assert.equal(initial.completed,false);
		await assert.rejects(t.core.call("setup.complete",{dataRoot:join(t.dir,"elsewhere")}),/data-dir/);
		await assert.rejects(t.core.call("setup.complete",{defaultWorkspace:join(t.dir,"missing")}),/工作区/);
		const root = await t.core.call("setup.validateDataRoot",{path:join(t.dir,"new-data")}) as {launchArgs:string[];freeBytes:number};
		assert.deepEqual(root.launchArgs,["--data-dir",join(t.dir,"new-data")]); assert.ok(root.freeBytes>0);
		const changes: unknown[] = []; const off = t.core.settings.onChange((s,keys) => changes.push(keys));
		await t.core.call("setup.complete",{dataRoot:t.core.paths.dataDir,userName:" 小林 ",defaultWorkspace:t.workspace,models:{conversation:"faux/faux-1",small:"faux/faux-text",large:"faux/faux-1"},sandbox:"later"});
		off(); assert.equal(changes.length,1);
		assert.equal(t.core.settings.get().userName,"小林"); assert.equal(t.core.settings.get().smallTaskModel,"faux/faux-text");
		assert.equal((await t.core.call("setup.complete",{userName:"不应覆盖"}) as {alreadyCompleted:boolean}).alreadyCompleted,true);
		assert.equal(t.core.settings.get().userName,"小林");
		await assert.rejects(t.core.call("setup.recommendModels",{channel:"missing"}),/找不到/);
		await assert.rejects(t.core.call("setup.testChannel",{channel:"missing"}),/找不到/);
	});

	it("wizard recommendations and connection testing reuse a configured channel", async () => {
		const channels = await t.core.call("gateway.channels",{}) as {id:string;provider:string}[];
		const channel = channels.find(c => c.provider === "faux")!;
		const models = await t.core.call("setup.recommendModels",{channel:channel.id}) as {conversation:string;small:string;large:string};
		assert.equal(models.conversation,"faux/faux-1"); assert.match(models.small,/^faux\//); assert.match(models.large,/^faux\//);
		t.respond(fauxAssistantMessage("OK"));
		const test = await t.core.call("setup.testChannel",{channel:channel.id}) as {ok:boolean;reply:string};
		assert.equal(test.ok,true); assert.equal(test.reply,"OK");
		await t.core.call("setup.complete",{channelId:channel.id});
		assert.equal(t.core.settings.get().defaultModel,models.conversation);
	});

	it("wizard saves a new channel and encrypted key in the same completion request", {skip:process.platform!=="win32"}, async () => {
		const result = await t.core.call("setup.complete",{userName:"测试",channel:{name:"T83 local configuration only",api:"openai-completions",baseUrl:"https://t83.invalid/v1",keys:[{secret:"T83_SYNTHETIC_KEY_NOT_REAL"}],models:[{id:"chat",cost:{input:3,output:5}},{id:"cheap",cost:{input:1,output:1}},{id:"deep",reasoning:true,contextWindow:200000}]},sandbox:"later"}) as {channelId:string;completed:boolean};
		assert.equal(result.completed,true);
		assert.equal(t.core.settings.get().smallTaskModel,`df-${result.channelId}/cheap`);
		assert.equal(t.core.settings.get().largeTaskModel,`df-${result.channelId}/deep`);
		const row = t.core.db.get<{secret:string}>("SELECT secret FROM gateway_keys WHERE channel_id=?",result.channelId)!;
		assert.ok(row.secret); assert.ok(!row.secret.includes("T83_SYNTHETIC_KEY_NOT_REAL"));
	});
});
