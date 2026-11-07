import assert from "node:assert/strict";
import {afterEach,beforeEach,describe,it} from "node:test";
import {fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai";
import {MemoryModule} from "../src/modules/memory.ts";
import {ContextModule} from "../src/modules/context.ts";
import {settledCount,startTestCore,type TestCore} from "./harness.ts";

describe("T-09 backend contracts",()=>{
 let t:TestCore, m:MemoryModule;
 beforeEach(async()=>{t=await startTestCore();m=t.core.module(MemoryModule)!;await t.core.call("slot.open",{slotId:"s",cwd:t.workspace},t.client);});
 afterEach(async()=>{await t.cleanup();});
 async function prompt(message="继续当前任务"){const n=settledCount(t.records("s"));await t.send("s",{id:Math.random().toString(),type:"prompt",message});await t.waitFor(()=>settledCount(t.records("s"))>n);}
 async function save(content:string){return (await t.core.call("memory.save",{content,scope:"workspace",cwd:t.workspace}) as any).item;}
 it("refreshes explicit main-agent corrections in every loaded snapshot, but not inferred edits",async()=>{
  const item=await save("用户的测试项目代号是青鹭742");
  t.respond(fauxAssistantMessage("收到"));await prompt("项目代号");
  const sid=t.core.slot("s").session.sessionId;
  const snapshot=m.latestSnapshot(sid)!;
  m.store.commit({actor:"main_agent",explicit:false,ops:[{kind:"edit",id:item.id,patch:{content:"用户的测试项目代号是蓝鹭123"}}]});
  assert.deepEqual(m.corrected(snapshot),[]);
  m.store.commit({actor:"main_agent",explicit:true,ops:[{kind:"edit",id:item.id,patch:{content:"用户的测试项目代号是白鹭853"}}]});
  let context="";t.respond(ctx=>{context=JSON.stringify(ctx.messages);return fauxAssistantMessage("收到");});await prompt();
  assert.match(context,/白鹭853/);assert.doesNotMatch(m.latestSnapshot(sid)!.content,/青鹭742/);
 });
 it("gates new global writes, edits and forget-then-add; only the user can accept",async()=>{
  const item=await save("用户的测试颜色是淡青色");
  const a=m.store.commit({actor:"main_agent",explicit:true,ops:[{kind:"edit",id:item.id,patch:{scope:"global",workspaceId:null}}]});
  assert.equal(a.pending[0]?.why,"promote_global");
  m.store.commit({actor:"main_agent",explicit:true,ops:[{kind:"status",id:item.id,status:"forgotten"}]});
  const b=m.store.commit({actor:"main_agent",explicit:true,ops:[{kind:"add",item:{content:item.content,kind:"preference",level:2,scope:"global",confidence:"user_explicit"}}]});
  assert.equal(b.pending[0]?.why,"promote_global");assert.equal(b.applied.length,0);
  const accepted:any=await t.core.call("memory.acceptPending",{id:b.pending[0]!.pendingId});assert.equal(accepted.currentTask,"next_task");
  assert.equal(m.store.get(accepted.applied[0].itemId)?.scope,"global");
 });
 it("prepares one persisted user message once even with concurrent replay; a second message is distinct",async()=>{
  await save("用户喜欢简短回复");t.respond(fauxAssistantMessage("收到"));await prompt("换个话题，准备周报");
  const slot=t.core.slot("s"),sid=slot.session.sessionId;
  const count=m.tasks.list(sid).length, snapshots=m.snapshotsFor(sid).length;
  await Promise.all([m.prepareMessage(slot),m.prepareMessage(slot),m.prepareMessage(slot)]);
  assert.equal(m.tasks.list(sid).length,count);assert.equal(m.snapshotsFor(sid).length,snapshots);
  t.respond(fauxAssistantMessage("收到"));await prompt("换个话题，准备周报");
  assert.equal(m.tasks.list(sid).length,count+1);
 });
 it("readonly permits snapshots but rejects writes and never queues extraction or pending items",async()=>{
  await save("用户喜欢简短回复");const sid=t.core.slot("s").session.sessionId;
  m.setSessionMode(sid,"readonly");t.core.settings.update({memoryAutoExtract:true,memoryPaused:true});
  t.respond(fauxAssistantMessage([fauxToolCall("memory_save",{content:"用户喜欢蓝色封面",kind:"preference",explicit:true})],{stopReason:"toolUse"}),fauxAssistantMessage("未保存"));
  await prompt("请记住用户喜欢蓝色封面");
  assert.ok(m.latestSnapshot(sid));assert.equal(m.store.list().length,1);assert.equal(m.store.pending().length,0);
  assert.equal(m.work.jobs.list().filter(j=>j.kind==="extract").length,0);
 });
 it("low frequency accumulates durable bounds and queues once at a boundary and close",async()=>{
  t.core.settings.update({memoryAutoExtract:true,memoryWriteFrequency:"low",memoryPaused:true});
  t.respond(fauxAssistantMessage("收到"),fauxAssistantMessage("收到"),fauxAssistantMessage("收到"));
  await prompt("用户本周决定测试服务只用本机运行");await prompt("继续同一个任务，周报用中文写");
  assert.equal(m.work.jobs.list().filter(j=>j.kind==="extract").length,0);
  assert.equal(t.core.db.all("SELECT * FROM memory_deferred_extractions").length,1);
  await prompt("换个话题，准备周报");assert.equal(m.work.jobs.list().filter(j=>j.kind==="extract").length,1);
  await t.core.closeSlot("s");assert.equal(m.work.jobs.list().filter(j=>j.kind==="extract").length,2);
  assert.equal(t.core.db.all("SELECT * FROM memory_deferred_extractions").length,0);
 });
 it("recovers deferred extraction after restart and rejects the removed high frequency",async()=>{
  const slot=t.core.slot("s");t.respond(fauxAssistantMessage("收到"));await prompt("用户本周决定测试服务只用本机运行");
  const entry=slot.session.sessionManager.getBranch().filter(e=>e.type==="message").at(-1)!;
  t.core.db.run("INSERT INTO memory_deferred_extractions VALUES(?,?,?,?)",slot.session.sessionId,slot.session.sessionFile!,slot.cwd,entry.id);
  t.core.settings.update({memoryWriteFrequency:"low",memoryPaused:true});
  t=await t.reopen();m=t.core.module(MemoryModule)!;t.core.settings.update({memoryAutoExtract:true});m.flushDeferred();
  assert.equal(m.work.jobs.list().filter(j=>j.kind==="extract").length,1);assert.equal(t.core.db.all("SELECT * FROM memory_deferred_extractions").length,0);
  t.core.settings.update({memoryWriteFrequency:"high"});assert.equal(t.core.settings.get().memoryWriteFrequency,"low");
 });
 it("anchors unsaved claims and clears only the saved run's hint",async()=>{
  t.respond(fauxAssistantMessage("我已经记住了，下次会按这个来。"));await prompt("请记住用户喜欢蓝色封面");
  const sid=t.core.slot("s").session.sessionId;
  const claim:any=await t.core.call("memory.unsaved",{sessionId:sid});assert.ok(claim.replyEntryId);assert.deepEqual(claim.pendingIds,[]);
  await t.core.call("memory.save",{content:"用户喜欢蓝色封面",unsavedRef:{sessionId:sid,runId:"older"}});assert.ok(await t.core.call("memory.unsaved",{sessionId:sid}));
  await t.core.call("memory.save",{content:"用户喜欢蓝色封面",unsavedRef:{sessionId:sid,runId:claim.runId}});assert.equal(await t.core.call("memory.unsaved",{sessionId:sid}),null);
  assert.ok(t.messages.some(e=>e.event==="memory.unsaved"&&e.cleared===true));
 });
 it("paginates same-timestamp log rows without duplicates and keeps purge receipts body-free",async()=>{
  m.clock=()=>1234567890000;
  const a=await save("这是将彻底删除的私人文本9462");await save("另一个工作区内的记忆内容");await save("第三个工作区内的记忆内容");
  const out:any=await t.core.call("memory.purge",{id:a.id,confirm:true});assert.deepEqual(out.sessions,[]);
  const seen:string[]=[];let cursor:string|null=null;let pages=0;
  do {const page:any=await t.core.call("memory.log",{limit:1,scope:"workspace",cwd:t.workspace,...(cursor?{cursor}:{})});
   assert.doesNotMatch(JSON.stringify(page),/9462/);assert.equal(page.days.length,1);seen.push(page.days[0].entries[0].opId);cursor=page.cursor;pages++;assert.ok(pages<5);
  }while(cursor);
  assert.equal(seen.length,3);assert.equal(new Set(seen).size,3);
  const all:any=await t.core.call("memory.log",{});const purge=all.days.flatMap((d:any)=>d.entries).find((e:any)=>e.kind==="purge");assert.equal(purge.after,null);assert.equal(purge.undoable,false);assert.equal(purge.level,2);
 });
 it("excludes corrected versions and paraphrased refuted numbers before compaction",async()=>{
  const a=await save("用户的测试服务监听端口是7319");await t.core.call("memory.update",{id:a.id,content:"用户的测试服务监听端口是8453"});
  const instruction=m.compactionExclusions(t.workspace);assert.match(instruction,/7319/);assert.match(instruction,/绝不能作为当前事实/);
  assert.equal(m.revivedIn("服务端口：7319",m.scopesFor(t.workspace))[0]?.id,a.id);
  const sid=t.core.slot("s").session.sessionId;m.setSessionMode(sid,"off");
  assert.equal(m.compactionExclusions(t.workspace,sid),"");
 });
 it("keeps compaction run summaries without adding them to request-ledger statistics",async()=>{
  const slot=t.core.slot("s"),context=t.core.module(ContextModule)!;
  const usage={input:10,output:5,cacheRead:0,cacheWrite:0,totalTokens:15,cost:{input:0.1,output:0.2,cacheRead:0,cacheWrite:0,total:0.3}};
  const hooks=t.core.compactionHooks!({slotId:"s"} as never)!;
  t.respond(()=>{assert.ok(slot.currentRun);context.onSlotEvent(slot,{type:"compaction_end",reason:"manual",result:{usage,tokensBefore:100},aborted:false} as never);return fauxAssistantMessage("收到");});await prompt();
  assert.equal(t.core.runs.list()[0]?.cost,0.3);
  hooks.background!.charge(usage,slot.session.model as never);
  const rows=t.core.runs.list();assert.equal(rows.length,2);assert.equal(rows.find(r=>r.kind==="background_compaction")?.cost,0.3);assert.equal(t.core.runs.costSince(0),0,"run summaries do not create request charges; actual candidates are recorded by the public runtime");
 });
 it("rejects regeneration for an absent or stale checkpoint",async()=>{
  await assert.rejects(t.core.call("context.regenerate",{slotId:"s",entryId:"old"}),/最新/);
 });
 it("brief automatic extraction rejects inferred preferences and progress; manual extraction stays standard",async()=>{
  t.core.settings.update({memoryAutoExtract:true,memoryDetail:"brief"});
  let instructions="";
  t.respond(fauxAssistantMessage("收到"),ctx=>{instructions=JSON.stringify(ctx.messages);return fauxAssistantMessage([fauxToolCall("memory_propose_ops",{ops:[
   {action:"add",kind:"preference",content:"用户偏好紫色",said:false,reason:"推断"},
   {action:"add",kind:"progress",content:"用户完成了演示稿",said:true,reason:"明确进展"},
   {action:"add",kind:"decision",content:"用户确认周报使用中文",said:true,reason:"明确决定"}
  ]})],{stopReason:"toolUse"});},fauxAssistantMessage("整理完成"));
  await prompt("用户确认周报使用中文，这次完成了演示稿");
  await t.waitFor(()=>m.work.jobs.list().some(j=>j.kind==="extract"&&j.status==="done"));
  assert.match(instructions,/简要提取/);assert.deepEqual(m.store.list().map(i=>i.content),["用户确认周报使用中文"]);
  t.core.settings.update({memoryAutoExtract:false});t.respond(fauxAssistantMessage("收到"));await prompt("用户刚刚完成了独立的演示视频并决定明天检查");
  let manual="";t.respond(ctx=>{manual=JSON.stringify(ctx.messages);return fauxAssistantMessage("没有新增记忆");});
  const job:any=await t.core.call("memory.extractNow",{slotId:"s"});await t.waitFor(()=>m.work.jobs.get(job.id)?.status==="done");
  assert.doesNotMatch(manual,/本次简要提取/);
 });
 it("a duplicate global-save request still produces a confirmation and anchored pending IDs",async()=>{
  const item=await save("用户的测试项目代号是白鹭853");
  t.respond(fauxAssistantMessage([fauxToolCall("memory_save",{content:item.content,scope:"global",explicit:true})],{stopReason:"toolUse"}),fauxAssistantMessage("我记住了。"));
  await prompt("把该项目代号改成全局记忆");
  assert.equal(m.store.get(item.id)?.scope,"workspace");
  const pending=m.store.pending();assert.equal(pending[0]?.why,"promote_global");
  const hint:any=await t.core.call("memory.unsaved",{sessionId:t.core.slot("s").session.sessionId});assert.equal(hint.pending,true);assert.deepEqual(hint.pendingIds,[pending[0]!.id]);
 });
 it("restore, undo, undoBatch and pending acceptance report when snapshots can use the change",async()=>{
  const item=await save("用户的周报采用中文");t.respond(fauxAssistantMessage("收到"));await prompt("周报语言");
  const edit:any=await t.core.call("memory.update",{id:item.id,content:"用户的周报采用中文和英文"});
  assert.equal((await t.core.call("memory.undo",{opId:edit.applied[0].opId}) as any).currentTask,"next_call");
  const restored:any=await t.core.call("memory.restore",{id:item.id,version:2});assert.equal(restored.currentTask,"next_call");
  assert.equal((await t.core.call("memory.undoBatch",{batchId:restored.batchId}) as any).currentTask,"next_call");
  const pending=m.store.commit({actor:"main_agent",explicit:true,ops:[{kind:"edit",id:item.id,patch:{scope:"global",workspaceId:null}}]}).pending[0]!;
  assert.equal((await t.core.call("memory.acceptPending",{id:pending.pendingId}) as any).currentTask,"next_call");
 });

});
