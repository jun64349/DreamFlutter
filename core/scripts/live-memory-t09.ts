/** T-09: run from an archived dev.6 core; never against the user's data.
 * node scripts/live-memory-v05.ts <source-data> <evidence-dir> <phase>
 * Phases: memory, boundaries, compaction, compaction-retry, followup,
 * boundary-fixed (only after applying the documented 60 -> 256 fix).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildCore } from "../src/app.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths } from "../src/paths.ts";
import { configurePiNetworking } from "../src/pi/http.ts";
import { MemoryModule } from "../src/modules/memory.ts";
import { estimateTokens } from "../src/memory/text.ts";

const [source, evidence, phase = "memory"] = process.argv.slice(2);
assert.ok(source && evidence);
mkdirSync(evidence, { recursive: true });
const stamp = `${phase}-${Date.now()}`;
const dir = mkdtempSync(join(tmpdir(), "df-t09-data-"));
const paths = corePaths(join(dir, "data"));
const copied = JSON.parse(execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./copy-channels.ts", import.meta.url)), source, paths.dataDir], { encoding: "utf8" }));
const channel = copied.find((c: any) => c.models.includes("deepseek-v4.1-flash"));
assert.ok(channel, "existing DeepSeek channel required");
const modelKey = `df-${channel.channel}/deepseek-v4.1-flash`;
const agentDir = join(dir, "agent");
mkdirSync(agentDir);
const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
const log = new Logger(paths.logFile, false);
await configurePiNetworking(agentDir, log);
const core = buildCore({ paths, agentDir, sessionDir: join(dir, "sessions"), log, notifier: new RecordingNotifier(), modelRuntime: () => runtime });
// Test-only metadata, not a new channel or a production setting change.
const row = core.db.get<any>("SELECT models FROM gateway_channels WHERE id = ?", channel.channel)!;
const models = JSON.parse(row.models).filter((m: any) => m.id === "deepseek-v4.1-flash");
models[0].contextWindow = phase.startsWith("compaction") ? 48000 : 1000000;
models[0].maxTokens = 4096;
core.db.run("UPDATE gateway_channels SET models = ? WHERE id = ?", JSON.stringify(models), channel.channel);
core.settings.update({ defaultModel: modelKey, auxModel: modelKey, memoryModel: modelKey, defaultThinking: "low", autoTitle: false, memoryAutoExtract: false, autoCompaction: phase.startsWith("compaction"), backgroundCompaction: "off", backgroundCompactionLeadPercent: 85, memoryDailyBudgetUsd: 0.10, dailyBudgetUsd: 0.10, approvalMode: "ask" });
const priorUsd = readdirSync(evidence).filter(f => f.endsWith("-calls.json")).reduce((sum, f) => sum + JSON.parse(readFileSync(join(evidence, f), "utf8")).reduce((s: number, c: any) => s + (c.usage?.cost?.total ?? 0), 0), 0);
const calls: any[] = [];
const checks: any[] = [];
let pending = 0;
let currentLabel = "setup";
const emit = (type: string, data: any) => {
 const record = { at: new Date().toISOString(), type, ...data };
 appendFileSync(join(evidence, `${stamp}.jsonl`), JSON.stringify(record) + "\n");
 if (["setup", "finish", "fatal", "check", "normal-metrics", "background-metrics", "dropped-metrics", "context-stats", "duplicate-result", "threshold-observation"].includes(type)) console.log(JSON.stringify(record));
};
const saveCalls = () => writeFileSync(join(evidence, `${stamp}-calls.json`), JSON.stringify(calls, null, 2));
const originalStream = runtime.streamSimple.bind(runtime);
runtime.streamSimple = ((model: any, context: any, options: any = {}) => {
 const spent = priorUsd + calls.reduce((s, c) => s + (c.usage?.cost?.total ?? 0), 0);
 // Reserve by UTF-8 bytes (conservative input upper bound) plus maximum output.
 const reserve = Buffer.byteLength(JSON.stringify(context), "utf8") * 0.15 / 1e6 + 4096 * 0.6 / 1e6;
 if (spent + pending + reserve > 0.10 || calls.length >= 100) throw new Error("T09_BUDGET_STOP");
 pending += reserve;
 const call: any = { id: calls.length + 1, label: currentLabel, model: `${model.provider}/${model.id}`, at: Date.now(), messages: context.messages, systemPrompt: context.systemPrompt, estimate: context.messages.reduce((n: number, m: any) => n + estimateTokens(text(m.content)), 0), toolNames: context.tools?.map((t: any) => t.name) };
 calls.push(call); emit("request", call);
 const stream = originalStream(model, context, { ...options, maxTokens: Math.min(options.maxTokens ?? 4096, 4096) });
 void stream.result().then((answer: any) => {
   pending -= reserve; Object.assign(call, { usage: structuredClone(answer.usage), answer: text(answer.content), stopReason: answer.stopReason, error: answer.errorMessage, ms: Date.now() - call.at });
   emit("response", { id: call.id, label: call.label, usage: call.usage, answer: call.answer, stopReason: call.stopReason, error: call.error, ms: call.ms }); saveCalls();
 }, (error: any) => { pending -= reserve; call.error = String(error); saveCalls(); });
 return stream;
}) as typeof runtime.streamSimple;
function text(content: any): string { return typeof content === "string" ? content : Array.isArray(content) ? content.map(c => c.text ?? (c.type === "toolCall" ? c.name + JSON.stringify(c.arguments) : "")).join("\n") : ""; }
const events: any[] = [];
const client = core.addClient(m => events.push(m));
const records = (slot: string) => events.filter(m => m.event === "slot.record" && m.slotId === slot).map(m => m.record);
async function wait(probe: () => any, timeout = 120000) { const start = Date.now(); while (!probe()) { if (Date.now() - start > timeout) throw new Error(`timeout: ${currentLabel}`); await new Promise(r => setTimeout(r, 50)); } }
async function open(slot: string, workspace = "a", incognito = false) { const cwd = join(dir, workspace); mkdirSync(cwd, { recursive: true }); await core.call("slot.open", { slotId: slot, cwd, incognito }, client); return cwd; }
const session = (slot: string) => core.slots.get(slot)!.session;
async function prompt(slot: string, message: string, label: string, requestId?: string) {
 currentLabel = label;
 const count = records(slot).filter(r => r.type === "agent_settled").length;
 const begin = calls.length;
 await core.call("slot.send", { slotId: slot, record: { id: requestId ?? `${label}-${Date.now()}`, type: "prompt", message } }, client);
 await wait(() => records(slot).filter(r => r.type === "agent_settled").length > count);
 const answer = records(slot).filter(r => r.type === "message_end" && r.message?.role === "assistant").at(-1)?.message;
 emit("turn", { label, slot, message, answer: text(answer?.content), tools: records(slot).filter(r => r.type === "tool_execution_end").map(r => ({ name: r.toolName, error: r.isError })), callIds: calls.slice(begin).map(c => c.id) });
 return { answer: text(answer?.content), calls: calls.slice(begin), stop: answer?.stopReason };
}
async function check(id: string, fn: () => any) { try { const detail = await fn(); checks.push({ id, pass: true, detail }); emit("check", checks.at(-1)); } catch (e) { checks.push({ id, pass: false, error: String(e) }); emit("check", checks.at(-1)); } }
const memory = core.module(MemoryModule)!;
const snap = (slot: string) => memory.latestSnapshot(session(slot).sessionId);
const snapshots = (slot: string) => memory.snapshotsFor(session(slot).sessionId);
const tasks = (slot: string) => memory.tasks.list(session(slot).sessionId);
const jobRows = () => core.db.all<any>("SELECT * FROM memory_jobs");
async function save(content: string, extra: any = {}) { return (await core.call("memory.save", { content, kind: "preference", ...extra }) as any).item; }
const failTool = (slot: string) => records(slot).filter(r => r.type === "tool_execution_end").at(-1);

try {
 await core.start();
 emit("setup", { phase, dir, modelKey, price: models[0].cost, contextWindow: models[0].contextWindow, maxTokens: 4096, priorUsd });
 if (phase === "memory") {
  const a = await open("a");
  await check("M1-explicit-save", async () => {
   const out = await prompt("a", "请记住：在本工作区，用户的测试项目代号是青鹭742。以后本工作区提到项目代号就用它。请实际保存，简短回复。", "explicit-save");
   const item = memory.store.list().find(m => m.content.includes("青鹭742")); assert.ok(item); assert.equal(item.scope, "workspace");
   return { item, answer: out.answer };
  });
  await check("M2-new-session-and-stable-snapshot", async () => {
   await open("a2"); const first = await prompt("a2", "本工作区的测试项目代号是什么？只回答代号。", "new-session");
   assert.match(first.answer, /青鹭742/); const n = snapshots("a2").length;
   await prompt("a2", "就这个代号，确认一次即可。", "same-task-2");
   await prompt("a2", "仍是同一个问题，回复收到即可。", "same-task-3");
   assert.equal(snapshots("a2").length, n); return { snapshots: n, first: first.answer };
  });
  await check("M4-correction", async () => {
   const out = await prompt("a", "纠正刚才的记忆：本工作区项目代号不是青鹭742，改为白鹭853。请更新原条目，不保留旧代号为当前事实。", "correct");
   const active = memory.store.list(); assert.ok(active.some(m => m.content.includes("白鹭853"))); assert.ok(!active.some(m => m.content.includes("青鹭742")));
   const read = await prompt("a2", "当前代号是什么？只回答当前值。", "read-correction"); assert.match(read.answer, /白鹭853/);
   assert.doesNotMatch(snap("a2")?.content ?? "", /青鹭742/); return { answer: out.answer, read: read.answer, snapshot: snap("a2") };
  });
  await check("M5-promote-confirmation", async () => {
   const out = await prompt("a", "把刚才本工作区项目代号白鹭853的记忆改成全局，让其他工作区也能读到。请调用更新记忆工具提出这个变更。", "promote-global");
   const pending = await core.call("memory.pending", {}) as any[];
   assert.ok(pending.some(p => p.why === "promote_global")); assert.ok(!memory.store.list().some(m => m.content.includes("白鹭853") && m.scope === "global"));
   emit("pending-before-accept", { pending });
   await core.call("memory.acceptPending", { id: pending[0].id });
   assert.ok(memory.store.list().some(m => m.content.includes("白鹭853") && m.scope === "global")); return { answer: out.answer, pending };
  });
 }
 if (phase.startsWith("compaction")) {
  const compactions = (slot: string) => core.db.all<any>("SELECT * FROM context_compactions WHERE session_id=? ORDER BY at,rowid", session(slot).sessionId);
  const constraints = "约束清单：不要使用 Docker；只能本机处理；测试尚未运行，不能说通过；最终只交付 Markdown 文件。旧部署端口7001已被否定，当前确认端口是8453。";
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `Dataset row ${i}: neutral placeholder content about rivers and meadows, containing no user preference or instruction.`).join("\n");
  const brief = "仅回复收到，不用任何工具，不总结材料。";
  const summaryChecks = (summary: string) => ({ noDocker: /Docker/i.test(summary) && /不要|不使用|不用|不得|不允许|不能|禁止|not|no /i.test(summary), local: /本机|local/i.test(summary), untested: /未.*(运行|测试)|测试.*未|not.*(run|test)|untested/i.test(summary), markdown: /Markdown/i.test(summary), currentPort: /8453/.test(summary) });
  async function fillToCandidate(slot: string) {
   await prompt(slot, constraints + brief, `${slot}-constraints`);
   await core.call("context.setSession", { slotId: slot, thresholdPercent: 50, background: true });
   for (let i = 0; i < 18; i++) {
    const info = await core.call("context.info", { slotId: slot }) as any;
    emit("threshold-observation", { slot, info });
    const gap = info.thresholdTokens * .90 - (info.usage?.tokens ?? 0);
    const n = Math.max(12, Math.min(190, Math.floor(gap / 30)));
    await prompt(slot, brief + "\n" + filler(n), `${slot}-fill-${i}`);
    if (compactions(slot).some(r => r.outcome === "made" || r.outcome === "failed" || r.reason === "no_cut")) break;
    // Wait for an actual candidate once the 85% gate has been crossed.
    const after = await core.call("context.info", { slotId: slot }) as any;
    if ((after.usage?.tokens ?? 0) >= after.thresholdTokens * .85 && (after.usage?.tokens ?? 0) < after.thresholdTokens) {
     await wait(() => compactions(slot).some(r => ["made", "failed", "dropped"].includes(r.outcome))); break;
    }
   }
   assert.ok(compactions(slot).some(r => r.outcome === "made"), JSON.stringify(compactions(slot)));
  }
  async function crossThreshold(slot: string) {
   for (let i = 0; i < 6 && !compactions(slot).some(r => r.outcome === "used" || r.outcome === "done"); i++) {
    const info = await core.call("context.info", { slotId: slot }) as any;
    const gap = info.thresholdTokens + 1500 - (info.usage?.tokens ?? 0);
    await prompt(slot, brief + "\n" + filler(Math.max(20, Math.min(180, Math.ceil(gap / 30)))), `${slot}-cross-${i}`);
   }
   await wait(() => compactions(slot).some(r => r.outcome === "used" || r.outcome === "done"));
  }
  if (phase === "compaction") await check("C1-normal-compaction", async () => {
   await open("normal");
   const old = await save("用户测试项目的旧部署端口是7001", { kind: "background" });
   await prompt("normal", constraints + brief, "normal-constraints");
   await core.call("memory.setStatus", { id: old.id, status: "refuted" });
   await prompt("normal", brief + "\n" + filler(160), "normal-material");
   currentLabel = "normal-summary"; const started = Date.now();
   await core.call("slot.send", { slotId: "normal", record: { id: "compact-normal", type: "compact" } }, client);
   await wait(() => records("normal").some(r => r.id === "compact-normal"));
   const response = records("normal").find(r => r.id === "compact-normal"); assert.equal(response.success, true);
   const checkpoints = await core.call("context.checkpoints", { slotId: "normal" }) as any[];
   const summary = checkpoints.at(-1).summary; const retained = summaryChecks(summary);
   emit("normal-metrics", { wallMs: Date.now() - started, records: compactions("normal"), retained, retentionRate: Object.values(retained).filter(Boolean).length / 5, summary });
   assert.ok(Object.values(retained).every(Boolean));
   const out = await prompt("normal", "根据当前检查点和记忆，回答：允许Docker吗、测试是否已通过、当前端口？不调用工具，简短回答。", "after-normal");
   assert.match(out.answer, /8453/); assert.doesNotMatch(out.answer, /端口[是为：: ]*7001|测试已通过/);
   assert.doesNotMatch(snap("normal")?.content ?? "", /7001/); return { answer: out.answer, records: compactions("normal"), retained };
  });
  await check("C2-background-used", async () => {
   await open("bg"); await fillToCandidate("bg");
   const before = calls.length; await crossThreshold("bg");
   const rows = compactions("bg"); const used = rows.find(r => r.outcome === "used"); assert.ok(used, JSON.stringify(rows));
   const checkpoints = await core.call("context.checkpoints", { slotId: "bg" }) as any[];
   const retained = summaryChecks(checkpoints.at(-1).summary);
   const usage = session("bg").sessionManager.getEntries().filter((e: any) => e.type === "usage" && e.kind === "background_compaction");
   emit("background-metrics", { rows, retained, retentionRate: Object.values(retained).filter(Boolean).length / 5, usage, callsAfterCandidate: calls.slice(before).map(c => ({ id: c.id, label: c.label })) });
   assert.ok(usage.length); assert.ok(Object.values(retained).every(Boolean)); return { rows, retained, usage };
  });
  await check("C3-background-unused-billed", async () => {
   await open("drop"); await fillToCandidate("drop");
   // Existing plan-mode protocol changes the system instructions; candidate must be dropped.
   await core.call("slot.send", { slotId: "drop", record: { id: "plan-drop", type: "df_set_plan_mode", on: true } }, client);
   await crossThreshold("drop");
   const rows = compactions("drop"); const usage = session("drop").sessionManager.getEntries().filter((e: any) => e.type === "usage" && e.kind === "background_compaction");
   emit("dropped-metrics", { rows, usage });
   assert.ok(rows.some(r => r.outcome === "dropped")); assert.ok(rows.some(r => r.outcome === "made" && r.cost > 0)); assert.ok(usage.length); return { rows, usage };
  });
  await check("F7-three-ledgers", async () => {
   await wait(() => pending === 0);
   const gateway = core.db.get<any>("SELECT COALESCE(SUM(cost),0) AS cost FROM gateway_requests").cost;
   const runs = core.db.get<any>("SELECT COALESCE(SUM(cost),0) AS cost FROM runs").cost;
   const usage = [...core.slots.values()].reduce((sum,slot) => sum+slot.session.getSessionStats().cost,0);
   assert.ok(Math.abs(gateway-runs)<1e-9,JSON.stringify({gateway,runs,usage}));
   assert.ok(Math.abs(gateway-usage)<1e-9,JSON.stringify({gateway,runs,usage}));
   return {gateway,runs,usage};
  });
  emit("context-stats", { stats: await core.call("context.stats", {}) });
 }
 if (phase === "promotion-only") {
  const cwd=await open("promote");const workspaceId=memory.workspaces.ensure(cwd).id;
  const item=await save("用户在本工作区的测试项目代号是白鹭853",{scope:"workspace",workspaceId});
  await check("F2-final-global-confirmation",async()=>{
   const out=await prompt("promote","把本工作区项目代号白鹭853的记忆改成全局，让其他工作区也能读到。请用记忆工具提出这个变更。","promote-final");
   const pending=memory.store.pending().find(p=>p.why==="promote_global");assert.ok(pending);
   assert.equal(memory.store.get(item.id)?.scope,"workspace");assert.ok(!memory.store.list().some(m=>m.scope==="global"&&m.content.includes("853")));
   await core.call("memory.acceptPending",{id:pending.id});assert.ok(memory.store.list().some(m=>m.scope==="global"&&m.content.includes("853")));
   return {answer:out.answer,pending};
  });
 }
 if (phase === "revival") {
  await check("R4-refuted-fact-not-revived", async () => {
   const port = await save("用户的测试服务监听端口是7319", { kind: "background" });
   await open("revival"); await prompt("revival", "我的测试服务监听端口是多少？只回答完整事实句，不使用工具。", "revival-original");
   await core.call("memory.setStatus", { id: port.id, status: "refuted" });
   await prompt("revival", "只回复收到，不使用工具。", "revival-before-compact");
   currentLabel = "revival-summary"; await core.call("slot.send", { slotId: "revival", record: { id: "revival-compact", type: "compact" } }, client);
   await wait(() => records("revival").some(r => r.id === "revival-compact"));
   const checkpoints = await core.call("context.checkpoints", { slotId: "revival" }) as any[];
   const summary = checkpoints.at(-1)?.summary ?? "";
   assert.ok(!summary.includes("7319") || /推翻|纠正|失效|无效|不再|refut|invalid|obsolete|incorrect|no longer/i.test(summary), summary);
   const out = await prompt("revival", "从当前有效信息看，我的测试服务监听端口是多少？不知道就说不知道，不使用工具。", "revival-after-compact");
   emit("revival-observation", { answer: out.answer, checkpoints, snapshot: snap("revival"), warnings: events.filter(e => e.event === "memory.warning") });
   // Mentioning an old value explicitly as invalid is not resurrection.
   assert.ok(!out.answer.includes("7319") || (/不知道|无法确定/.test(out.answer) && /不作数|失效|被否定|不再有效/.test(out.answer)));
   return { answer: out.answer, checkpoints, note: "Response validity and stale-checkpoint invalidation must be reviewed separately." };
  });
 }
 if (phase === "boundary-fixed") {
  const cwd = await open("fixed"); await save("用户希望回复简短");
  core.settings.update({ memoryAutoExtract: true });
  let now = Date.now(); memory.clock = () => now;
  const input = { sessionId: session("fixed").sessionId, set: memory.scopesFor(cwd), unattended: false, recent: "用户：登录页按钮没反应。助手：先确认点击处理函数有没有执行。", cwd };
  await memory.boundary({ ...input, prompt: "我在调试登录页按钮没有反应的问题，先列一句排查方向，不使用工具。" });
  await check("F3-fixed-next-day", async () => {
   now += 86400000; currentLabel = "fixed-continue";
   const result = await memory.boundary({ ...input, prompt: "继续昨天登录页按钮没有反应的问题，还没修好。先回一句排查建议，不使用工具。" });
   assert.equal(result.fresh, false); assert.equal(result.task.status, "active"); return result;
  });
  await check("F3-fixed-topic-suspends", async () => {
   now += 3 * 3600000; currentLabel = "fixed-topic";
   const result = await memory.boundary({ ...input, prompt: "我下周要到成都出差三天，帮我列出衣物、电子设备、证件、交通方面的准备清单，先给三点简短建议，不使用工具。" });
   assert.equal(result.fresh, true); assert.equal(result.task.reason, "guessed"); assert.equal(tasks("fixed").filter(t=>t.status==="suspended").length, 1);
   return { result, tasks: tasks("fixed") };
  });
 }
} catch (error) { emit("fatal", { error: String(error) }); process.exitCode = 1; }
finally {
 const tables = ["runs", "memory_items", "memory_versions", "memory_ops", "memory_batches", "memory_snapshots", "memory_jobs", "memory_materials", "memory_task_views", "memory_pending", "memory_suppressions", "context_compactions", "usage_records", "gateway_requests"];
 writeFileSync(join(evidence, `${stamp}-database.json`), JSON.stringify(Object.fromEntries(tables.map(t => [t, core.db.all(`SELECT * FROM ${t}`)])), null, 2));
 await core.shutdown();
 saveCalls();
 writeFileSync(join(evidence, `${stamp}-events.json`), JSON.stringify(events, null, 2));
 writeFileSync(join(evidence, `${stamp}-checks.json`), JSON.stringify(checks, null, 2));
 emit("finish", { checks: checks.map(c => ({ id: c.id, pass: c.pass })), costUsd: calls.reduce((s, c) => s + (c.usage?.cost?.total ?? 0), 0), callCount: calls.length, dir });
 if (checks.some(c => !c.pass)) process.exitCode = 1;
}
