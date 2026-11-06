/** T-11 F-02: backend replay of live-1793979791338/C01, using isolated data.
 * node --disable-warning=ExperimentalWarning scripts/live-regenerate-t11.ts <source-data> <evidence-dir>
 * Copies encrypted channels only; never reads or changes the user's conversations.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildCore } from "../src/app.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths } from "../src/paths.ts";
import { configurePiNetworking } from "../src/pi/http.ts";
import { SessionIndex } from "../src/modules/session-index.ts";

const [source, evidence] = process.argv.slice(2);
assert.ok(source && evidence, "source-data and evidence-dir are required");
mkdirSync(evidence, { recursive: true });
const stamp = `f02-${Date.now()}`, dir = mkdtempSync(join(tmpdir(), "df-t11-f02-"));
const paths = corePaths(join(dir, "data")), agentDir = join(dir, "agent"), workspace = join(dir, "workspace");
mkdirSync(agentDir); mkdirSync(workspace);
const copied = JSON.parse(execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./copy-channels.ts", import.meta.url)), source, paths.dataDir], { encoding: "utf8" }));
const channel = copied.find((c: any) => c.models.includes("deepseek-v4.1-flash"));
assert.ok(channel, "configured DeepSeek channel required");
const model = `df-${channel.channel}/deepseek-v4.1-flash`;
const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
const log = new Logger(paths.logFile, false);
await configurePiNetworking(agentDir, log);
const core = buildCore({ paths, agentDir, sessionDir: join(dir, "sessions"), log, notifier: new RecordingNotifier(), modelRuntime: () => runtime });
const row = core.db.get<{ models: string }>("SELECT models FROM gateway_channels WHERE id=?", channel.channel)!;
const models = JSON.parse(row.models).filter((m: any) => m.id === "deepseek-v4.1-flash");
models[0].contextWindow = 48000; models[0].maxTokens = 4096;
core.db.run("UPDATE gateway_channels SET models=? WHERE id=?", JSON.stringify(models), channel.channel);
core.settings.update({ defaultModel: model, auxModel: model, memoryModel: model, defaultThinking: "low", autoTitle: false, memoryAutoExtract: false, autoCompaction: false, backgroundCompaction: "off", memoryDailyBudgetUsd: 0.10, dailyBudgetUsd: 0.05, approvalMode: "ask" });
const calls: any[] = [], events: any[] = [], checks: any[] = [];
let label = "setup", reserved = 0;
const priorUsd = readdirSync(evidence).filter(f => f.endsWith("-calls.json")).reduce((sum, f) => sum + JSON.parse(readFileSync(join(evidence, f), "utf8")).reduce((s: number, c: any) => s + (c.usage?.cost?.total ?? 0), 0), 0);
const save = (name: string, value: unknown) => writeFileSync(join(evidence, `${stamp}-${name}.json`), JSON.stringify(value, null, 2));
const emit = (type: string, data: unknown) => {
	const entry = { at: new Date().toISOString(), type, data };
	appendFileSync(join(evidence, `${stamp}.jsonl`), JSON.stringify(entry) + "\n");
	if (["setup", "check", "finish", "fatal"].includes(type)) console.log(JSON.stringify(entry));
};
const original = runtime.streamSimple.bind(runtime);
runtime.streamSimple = ((m: any, context: any, options: any = {}) => {
	const spent = priorUsd + calls.reduce((sum, c) => sum + (c.usage?.cost?.total ?? 0), 0);
	const reserve = Buffer.byteLength(JSON.stringify(context), "utf8") * 0.15 / 1e6 + 4096 * 0.6 / 1e6;
	if (spent + reserved + reserve > 0.05 || calls.length >= 12) throw new Error("T11_F02_BUDGET_STOP");
	reserved += reserve;
	const call: any = { id: calls.length + 1, label, at: Date.now(), model: `${m.provider}/${m.id}`, messages: context.messages, systemPrompt: context.systemPrompt };
	calls.push(call); save("calls", calls);
	const stream = original(m, context, { ...options, maxTokens: Math.min(options.maxTokens ?? 4096, 4096) });
	void stream.result().then((answer: any) => {
		reserved -= reserve;
		Object.assign(call, { usage: structuredClone(answer.usage), answer: answer.content, stop: answer.stopReason, error: answer.errorMessage, ms: Date.now() - call.at });
		save("calls", calls); emit("response", call);
	}, (error: unknown) => { reserved -= reserve; call.error = String(error); save("calls", calls); });
	return stream;
}) as typeof runtime.streamSimple;
const client = core.addClient(event => events.push(event));
const records = () => events.filter(e => e.event === "slot.record" && e.slotId === "s").map(e => e.record);
const slot = () => core.slot("s"), manager = () => slot().session.sessionManager;
async function wait(probe: () => boolean) {
	const deadline = Date.now() + 150000;
	while (!probe()) { if (Date.now() > deadline) throw new Error(`timeout: ${label}`); await new Promise(r => setTimeout(r, 50)); }
}
async function prompt(message: string, step: string) {
	label = step;
	const count = records().filter(r => r.type === "agent_settled").length;
	await core.call("slot.send", { slotId: "s", record: { id: step, type: "prompt", message } }, client);
	await wait(() => records().filter(r => r.type === "agent_settled").length > count);
	const last = records().filter(r => r.type === "message_end" && r.message?.role === "assistant").at(-1)?.message;
	assert.equal(last?.stopReason, "stop");
	return last.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") as string;
}
const check = (id: string, detail: unknown) => { checks.push({ id, pass: true, detail }); emit("check", checks.at(-1)); save("checks", checks); };
const sum = (table: string) => core.db.get<{ total: number }>(`SELECT COALESCE(SUM(cost),0) total FROM ${table}`)!.total;
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
try {
	await core.start();
	emit("setup", { dir, model, price: models[0].cost, priorUsd, budgetUsd: 0.05, scenario: "live-1793979791338/C01" });
	await core.call("slot.open", { slotId: "s", cwd: workspace }, client);
	const oldMemory = await core.call("memory.save", { content: "用户测试项目旧部署端口是7319", scope: "workspace", cwd: workspace }) as any;
	await prompt("约束：禁止Docker，只能本机；测试尚未运行，不能声称通过；最终交付Markdown。旧端口7319已经否定，当前端口8453。仅答收到，不用工具。", "compression-constraints");
	await core.call("memory.setStatus", { id: oldMemory.item.id, status: "refuted" });
	const filler = Array.from({ length: 170 }, (_, i) => `Dataset row ${i}: neutral placeholder about rivers and meadows, no preference or instruction.`).join("\n");
	await prompt(`只答收到，不用工具。\n${filler}`, "compression-material");
	label = "normal-compact";
	await core.call("context.compactNow", { slotId: "s" });
	const old = manager().getLeafEntry()!; assert.equal(old.type, "compaction");
	const priorFile = readFileSync(slot().info().sessionFile!, "utf8");
	const before = { calls: calls.length, runs: sum("runs"), session: slot().session.getSessionStats().cost, gateway: sum("gateway_requests") };
	label = "immediate-regenerate";
	const result = await core.call("context.regenerate", { slotId: "s", entryId: old.id }) as any;
	const fresh = manager().getLeafEntry()!;
	assert.equal(result.source, "original"); assert.equal(fresh.type, "compaction");
	assert.notEqual(fresh.id, old.id); assert.equal(fresh.parentId, old.parentId);
	assert.deepEqual(manager().getEntry(old.id), old);
	assert.ok(readFileSync(slot().info().sessionFile!, "utf8").startsWith(priorFile));
	assert.equal(calls.length - before.calls, 1);
	assert.equal(manager().getEntries().filter(e => e.type === "message" && e.message.role === "user").length, 2, "no intervening/fake user messages");
	const points = await core.call("context.checkpoints", { slotId: "s" }) as any[];
	assert.deepEqual(points.map(p => p.entryId), [fresh.id]);
	assert.match(points[0].summary, /8453/);
	if (points[0].summary.includes("7319")) assert.match(points[0].summary, /失效|否定|推翻|废弃|旧端口|invalid|refut/);
	check("immediate-regenerate", { source: result.source, old, fresh, points, info: await core.call("context.info", { slotId: "s" }), estimatedTokensAfter: result.estimatedTokensAfter });
	await wait(() => calls.at(-1)?.usage !== undefined);
	const cost = calls.at(-1).usage.cost.total;
	const delta = { runs: sum("runs") - before.runs, session: slot().session.getSessionStats().cost - before.session, gateway: sum("gateway_requests") - before.gateway };
	for (const value of Object.values(delta)) near(value, cost);
	await core.module(SessionIndex)!.refresh();
	near(sum("usage_records"), slot().session.getSessionStats().cost);
	check("billed-once", { calls: 1, cost, delta, sessionIndex: sum("usage_records") });
	const answer = await prompt("仅回答当前端口、是否允许Docker、测试是否已通过。不要调用工具。", "after-regenerate");
	assert.match(answer, /8453/); assert.doesNotMatch(answer, /端口7319/);
	assert.match(answer, /不允许|禁止|不能|不可以/); assert.match(answer, /未运行|尚未|未通过|不能.*通过/);
	check("constraints-after-regenerate", { answer });
} catch (error) {
	checks.push({ id: label, pass: false, error: String(error) }); emit("fatal", { error: String(error) }); process.exitCode = 1;
} finally {
	if (slot) {
		const active = core.slots.get("s");
		if (active?.started) save("session", { file: active.info().sessionFile, entries: active.session.sessionManager.getEntries(), leafId: active.session.sessionManager.getLeafId() });
	}
	save("database", Object.fromEntries(["runs", "context_compactions", "usage_records", "gateway_requests"].map(table => [table, core.db.all(`SELECT * FROM ${table}`)])));
	await core.shutdown(); save("calls", calls); save("events", events); save("checks", checks);
	emit("finish", { checks: checks.map(c => ({ id: c.id, pass: c.pass })), callCount: calls.length, costUsd: calls.reduce((sum, c) => sum + (c.usage?.cost?.total ?? 0), 0), dir });
}
