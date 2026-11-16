import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { startContractHarness } from "../../test/api-contract/harness.ts";
import { GoalsModule } from "../../src/modules/goals.ts";
import { JobsModule } from "../../src/modules/jobs.ts";
import { VoiceModule } from "../../src/modules/voice/index.ts";
import type { VoiceProvider } from "../../src/modules/voice/provider.ts";
import { MemoryModule } from "../../src/modules/memory.ts";
import { recordPreserved } from './preserved.ts';

type Entry = { method: string; params?: Record<string, unknown>; scenario?: string; saveAs?: string; before?: Entry[]; error?: boolean };
const here = dirname(fileURLToPath(import.meta.url));
const destination = resolve(here, "../../../app/test/fixtures/api");

// Only test-owned paths are substituted. Credentials are removed by field name;
// arbitrary absolute Windows paths are redacted as a final defence.
export function sanitize(value: unknown, paths: string[]): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const path of paths.sort((a, b) => b.length - a.length)) {
      text = text.split(path).join("<fixture>").split(path.replaceAll("\\", "/")).join("<fixture>");
    }
    return text.replace(/(?<![A-Za-z])[A-Za-z]:[\\/][^\s"<>]*/g, "<local-path>");
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, paths));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(apiKey|secret|token|authorization|encryptedKey)$/i.test(key) && typeof item === "string" ? "<redacted>" : sanitize(item, paths)]));
  return value;
}

test("record isolated UI wire fixtures", async t => {
  const h = await startContractHarness(t);
  await h.core.module(GoalsModule)!.executor.stop();
  const vars: Record<string, unknown> = { workspace: h.workspace, now: Date.now(), future: Date.now() + 86400000 };
  const providers = (h.core.module(VoiceModule)! as unknown as {providers:Map<string,VoiceProvider>}).providers;
  providers.set('local',{async open(input){return {async chunk(){input.emit({kind:'partial',text:'123'});},async end(){input.emit({kind:'final',text:'123'});},cancel(){}};}});
  vars.pcm=Buffer.alloc(4800).toString('base64');
  h.core.db.run('INSERT INTO selfwork_goals VALUES(?,?,?,1,?,?,NULL)','ui-long','跟进温湿度传感器资料','整理公开资料，每周汇总一次',Date.now(),Date.now());
  h.core.db.run("INSERT INTO selfwork_runs(id,source,long_goal_id,long_goal_revision,state,topic,started_at,day,ended_at) VALUES('ui-run','goal','ui-long',1,'completed','整理了三篇公开资料',?,'2026-11-13',?)",Date.now(),Date.now());
  h.core.db.run("INSERT INTO selfwork_skills VALUES('ui-skill','整理参考文献',1,NULL,NULL)");
  h.core.db.run("INSERT INTO selfwork_skill_versions VALUES('ui-skill',1,'ui-run','把参考文献整理成统一格式',?,?)",'---\nname: 整理参考文献\ndescription: 把参考文献整理成统一格式\n---\n整理用户提供的参考文献。',Date.now());
  const memory=h.core.module(MemoryModule)!.recordButterflyMemory({source:'learning',refId:'idle-learning:ui-run',content:'阅读温湿度资料时，需要核对量程和精度。'});
  vars.selfMemory=memory.applied[0];
  vars.monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  vars.monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).getTime();
  const slot = await h.call<Record<string, unknown>>("slot.open", { cwd: h.workspace });
  vars.slot = slot;
  h.core.slot(String(slot.slotId)).setAgentState({ planMode: false, todos: [
    { content: "读三款的规格书", status: "completed" }, { content: "抓京东、淘宝的价格", status: "completed" },
    { content: "整理成对比表", status: "in_progress" }, { content: "写推荐结论", status: "pending" }, { content: "交付 report.md", status: "pending" },
  ] });
  // An empty freshly opened slot has not persisted its session yet.
  writeFileSync(String(slot.sessionFile), JSON.stringify({ type: "session", version: 3, id: "ui-fixture", timestamp: new Date().toISOString(), cwd: h.workspace }) + "\n");
  const job = h.core.module(JobsModule)!.trackSubagent(h.core.slot(String(slot.slotId)), h.workspace, "核对文献", () => { job?.finish({ status: "cancelled", exitCode: null }); });
  if (!job) throw new Error("fixture job was not created");
  job.append("已核对 12 篇文献\n");
  vars.job = (await h.call<Record<string, unknown>[]>("jobs.list", { slotId: slot.slotId }))[0];
  const choice = h.core.slot(String(slot.slotId)).ui.context().select("Agent 需要你补充信息：\n\n海外那款要算进对比吗？", ["算进去 — 运费按 60 元估", "先不算（推荐）", "换一款国内的 — 我来挑", "自己回答…", "跳过这个问题"], { timeout: 120000 });
  vars.question = h.core.confirmations.list({ status: "pending" })[0];
  const ruleDraft = {name: "整理新纪要", source: "conversation", filter: {}, task: "只读原件，整理要点", scope: {kind: "sandbox"}, actions: ["read"], delivery: "/workspace/outbox", assess: false};
  for (const id of ['ui-rule', 'ui-rule-reject']) {
    h.core.db.run('INSERT INTO autonomy_confirmations(id,kind,payload) VALUES(?,?,?)', id, 'rule', JSON.stringify(ruleDraft));
    h.core.confirmations.opened({slotId: 'autonomy', cwd: h.core.paths.butterflyDir}, {type: 'extension_ui_request', id, method: 'confirm', title: '确认蝶君起草的主动规则', message: '整理新纪要\n只读原件，整理要点\n保存为观察模式'});
  }
  for (const id of ['ui-proposal', 'ui-proposal-accept']) h.core.db.run(`INSERT INTO goal_proposals(id,session_file,message_id,origin_text,draft,created_at,status)
    VALUES(?,?,?,'整理实验记录',?,?,'pending')`, id, String(slot.sessionFile), id, JSON.stringify({title: "整理实验记录", spec: {objective: "整理实验记录"}, scope: {cwd: h.workspace, partition: "workbench", sandbox: false}}), Date.now());
  function expand(value: unknown): any {
    if (typeof value === "string" && value.startsWith("$")) {
      return value.slice(1).split(".").reduce<any>((obj, key) => obj?.[key], vars);
    }
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
    return value;
  }
  const paths = [h.dir, process.cwd(), process.env.USERPROFILE ?? "<unused>"];
  const write = (name: string, value: unknown) => {
    if (!/^[a-zA-Z0-9._/-]+$/.test(name) || name.includes("..")) throw new Error("Invalid fixture name");
    const file = resolve(destination, `${name}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(sanitize(value, paths.filter(Boolean)), null, 2) + "\n");
  };
  async function record(entry: Entry) {
    for (const before of entry.before ?? []) await record(before);
    let result: unknown;
    try { result = await h.call(entry.method, expand(entry.params ?? {})); if(entry.error) throw new Error('Expected RPC error'); }
    catch(e) { if (!entry.error || !e || typeof e !== 'object' || !('code' in e)) throw e; result = {code:e.code,message:(e as Error).message,data:'data' in e ? e.data : null}; }
    if (entry.saveAs) vars[entry.saveAs] = result;
    write(entry.method + (entry.scenario ? `.${entry.scenario}` : ""), result);
  }
  try {
    for (const entry of JSON.parse(readFileSync(resolve(here, "methods.json"), "utf8")) as Entry[]) await record(entry);
    h.core.db.run("UPDATE goals SET status='paused',reason='budget_cost',resume_when='预算不足',stop_intent=NULL WHERE id=?", (vars.goal as any).id);
    h.core.db.run("INSERT INTO goal_approvals(id,goal_id,revision,kind,status,payload,created_at) VALUES('ui-review',?,1,'acceptance','pending','{}',?)", (vars.acceptedGoal as any).id, Date.now());
    const custom = h.core.slot(String(slot.slotId)).ui.context().input("Agent 需要你补充信息：\n\n海外那款要算进对比吗？");
    vars.custom = h.core.confirmations.list({ status: "pending" })[0];
    await record({method:'attention.list',scenario:'groups'});
    await record({method:'attention.prioritized',scenario:'groups'});
    await record({method: "confirm.list", scenario: "custom", params: {limit: 100}});
    await record({method: "confirm.answer", scenario: "custom", params: {id: "$custom.id", response: {value: "运费按 80 元算"}}});
    await custom;
    job.finish({ status: "completed", exitCode: 0 });
    await choice;
    await h.waitForEvent("job.finished");
    for (const name of new Set(h.events.map(event => event.event))) write(`events/${name}`, h.events.filter(event => event.event === name));
    console.log(`Recorded wire fixtures in app/test/fixtures/api (${h.events.length} pushes)`);
    await recordPreserved(h.dir,write);
  } finally { await h.cleanup(); }
});
