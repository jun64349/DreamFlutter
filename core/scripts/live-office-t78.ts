/** Bounded real-model acceptance through the formal package's Core/Pi sessions. Source account is read-only. */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
const [payloadArg, source, evidence, only, resumeArg] = process.argv.slice(2);
assert.ok(payloadArg && source && evidence, "usage: live-office-t78.ts <formal-payload> <existing-data> <new-evidence> [case]");
assert.ok(!existsSync(evidence), "Use a new evidence path; never repeat a counted live run silently");
const payload = resolve(payloadArg), repository = resolve(import.meta.dirname, "../.."), importer = (path: string) => import(pathToFileURL(join(payload, path)).href);
const { buildCore } = await importer("core/src/app.ts"), { Db } = await importer("core/src/db.ts"), { corePaths } = await importer("core/src/paths.ts");
const { Logger } = await importer("core/src/log.ts"), { RecordingNotifier } = await importer("core/src/notify.ts");
const { SecretStore, secretFileOf, relocateSecretRef } = await importer("core/src/modules/secrets.ts");
const { ALLOW, APPROVAL_TITLE } = await importer("core/src/pi/dialogs.ts"), { bundledPython } = await importer("core/src/agent/toolchain.ts");
const { streamSimple } = await importer("core/node_modules/@earendil-works/pi-ai/dist/compat.js");
const python = bundledPython(); assert.ok(python && resolve(python).startsWith(payload));
const root = resumeArg ? resolve(resumeArg) : mkdtempSync(join(resolve(repository, "dist"), "t78-live-")), data = join(root, "data");
if (resumeArg) { assert.equal(dirname(root), resolve(repository, "dist"));assert.match(basename(root), /^t78-live-/);assert.equal(only, "data"); } else mkdirSync(data);
const readonly = new DatabaseSync(corePaths(source).dbFile, { readOnly: true });
type Row = Record<string, string | number | null>;
const channel = readonly.prepare("SELECT * FROM gateway_channels WHERE platform='opencode-go' AND enabled=1 ORDER BY sort,created_at LIMIT 1").get() as Row;assert.ok(channel);
const key = readonly.prepare("SELECT * FROM gateway_keys WHERE channel_id=? AND enabled=1 ORDER BY sort,created_at LIMIT 1").get(channel.id) as Row;readonly.close();assert.ok(key);
const modelId = "mimo-v2.6-flash", model = (JSON.parse(String(channel.models)) as { id: string }[]).find((m) => m.id === modelId);assert.ok(model);
channel.models = JSON.stringify([{ ...model, maxTokens: 4096 }]);
if (!resumeArg) {
const fromSecrets = new SecretStore(source), toSecrets = new SecretStore(data), file = secretFileOf(String(key.secret));assert.ok(file);assert.equal(resolve(file).toLowerCase(), resolve(join(fromSecrets.dir, basename(file))).toLowerCase());
mkdirSync(toSecrets.dir, { recursive: true });copyFileSync(file, join(toSecrets.dir, basename(file)));key.secret = relocateSecretRef(String(key.secret), toSecrets.dir);
const db = new Db(corePaths(data).dbFile);
for (const [table, row] of [["gateway_channels", channel], ["gateway_keys", key]] as const) { const columns = Object.keys(row);db.raw.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map((c) => row[c]!)); }db.close();
}
let physicalRequests = 0, phaseStart = 0;
let baselineCost = 0, baselineRow = 0;
const priorCost = readdirSync(dirname(evidence)).filter((name) => /^T78-live.*\.json$/.test(name)).reduce((n, name) => { try { return n + Number(JSON.parse(readFileSync(join(dirname(evidence), name), "utf8")).costUsd ?? 0); } catch { return n; } }, 0);
const core = buildCore({ paths: corePaths(data), agentDir: join(root, "agent"), sessionDir: join(root, "sessions"), piMigration: { automatic: false }, log: new Logger(), notifier: new RecordingNotifier(), gatewayTransport: (model: any, context: any, options: any) => {
 const spent = Number(core.db.get("SELECT COALESCE(SUM(cost),0) total FROM gateway_requests")?.total ?? 0) - baselineCost;
 const reserve = Buffer.byteLength(JSON.stringify(context), "utf8") / 3 * Math.max(model.cost.input, .15) / 1e6 + 4096 * Math.max(model.cost.output, .6) / 1e6;
 if (physicalRequests >= 60 || physicalRequests - phaseStart >= 16 || priorCost + spent + reserve > .25) throw new Error("T78_REQUEST_OR_COST_BUDGET_STOP");
 physicalRequests++;return streamSimple(model, context, { ...options, maxRetries: 0, maxTokens: 4096, signal: AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(45000)]) });
} });
baselineCost = Number(core.db.get("SELECT COALESCE(SUM(cost),0) total FROM gateway_requests")?.total ?? 0);baselineRow = Number(core.db.get("SELECT COALESCE(MAX(rowid),0) n FROM gateway_requests")?.n ?? 0);
core.settings.update({ defaultModel: `df-${channel.id}/${modelId}`, defaultThinking: "off", autoTitle: false, autoCheckUpdates: false, memoryEnabled: false, memoryAutoExtract: false, memoryPaused: true, autoCompaction: false, backgroundCompaction: "off", approvalMode: "changes", maxTurnsPerRun: 16 });
const cases = [
 { id: "docx", skill: "office-docx", prompt: "使用 office-docx 技能，将 brief.md 做成排版清楚的 report.docx，保留 T78 中文周报、完成8项任务和甲3乙5的表格，包含真正的一级标题。用已随包的 Python 库，不要导出PDF。文件保存在当前目录。完成后核对产物并简短报告。" },
 { id: "xlsx", skill: "office-xlsx", prompt: "使用 office-xlsx 技能，将 sales.csv 转成 result.xlsx，明细保留编号001、002、003为字符串。另建名为汇总的工作表，按项目静态汇总数量，甲应为7、乙为5；表头清楚、冻结首行、可筛选。不要创建或重算公式。核对后简短报告。" },
 { id: "pptx", skill: "office-pptx", prompt: "使用 office-pptx 技能，由 brief.md 做 slides.pptx，严格两页，16:9，中文标题包含T78，至少一张可编辑原生表格，甲3乙5保持正确。文字不要越过页面。不导出PDF。核对后简短报告。" },
 { id: "pdf", skill: "office-pdf", prompt: "使用 office-pdf 技能处理 input.pdf：第2页拆成 second.pdf；把这份拆出的第2页接在原文件后，输出 merged.pdf，共3页；原文件全部文字提取成 extracted.txt。保留原件，核对页数和文字，不需要OCR或Office转换。" },
 { id: "data", skill: "data-analysis", prompt: "使用 data-analysis 技能分析 sales.csv，按项目汇总数量，输出 summary.csv（字段项目、数量；甲7、乙5），画中文标题和中文标签的柱状图 chart.png；再使用 office-docx 技能把同一张图嵌入 chart-report.docx。要给可复查结果和核对，勿在线安装库。" },
 { id: "unsupported", skill: "office-pdf", prompt: "使用 $office-pdf 和 $office-xlsx 技能：我想对扫描版PDF做OCR，并让Excel公式重新计算。请按首版实际能力直接说明这两件事能不能做，不要执行OCR、重算或创建文件，也不要安装工具绕过限制。" },
 { id: "sandbox-office", skill: "office-pdf", prompt: "使用 office-pdf 技能，根据 sandbox-no-office.json 中来自真实蝶君Linux脚本的回执，说明在蝶君把Word转PDF的结果。任务只允许蝶君，不能转移到工作台代办；不要安装转换器，给简短准确的结果。" },
].filter((c) => !only || only.split(",").includes(c.id));
assert.ok(cases.length);
const proof: Record<string, any> = { at: new Date().toISOString(), payload, root, resumed: !!resumeArg, sourceReadOnly: true, newChannels: 0, model: modelId, totalBudgetUsd: .25, priorCostUsd: priorCost, cases: [] };const save = () => { proof.physicalRequests = physicalRequests;proof.costUsd = Number(core.db.get("SELECT COALESCE(SUM(cost),0) total FROM gateway_requests")?.total ?? 0) - baselineCost;writeFileSync(evidence, JSON.stringify(proof, null, 2)); };save();
const records = new Map<string, any[]>(), approvals: string[] = [];
const client = core.addClient((message: any) => {
 if (message.event !== "slot.record") return;
 const list = records.get(message.slotId) ?? [];list.push(message.record);records.set(message.slotId, list);
 const r = message.record;
 if (r.type === "extension_ui_request" && r.method === "select" && String(r.title).includes(APPROVAL_TITLE)) { approvals.push(r.title);void core.call("slot.send", { slotId: message.slotId, record: { type: "extension_ui_response", id: r.id, value: ALLOW } }, client); }
});
try {
 await core.start();
 for (const item of cases) {
  phaseStart = physicalRequests;
  const cwd = join(root, `case-${item.id}`);
  if (!resumeArg) { mkdirSync(cwd);const setup = spawnSync(python, ["-I", "-B", join(repository, "scripts/t78-office-fixtures.py"), cwd], { windowsHide: true, encoding: "utf8" });assert.equal(setup.status, 0, setup.stderr); }
  if (item.id === "sandbox-office") {
   const script = readFileSync(join(payload, "core/assets/skills/office-pdf/scripts/convert_office.py"), "utf8");
   const response = spawnSync("wsl.exe", ["-d", "DreamFlutterSandbox", "-u", "agent", "--exec", "python3", "-B", "-c", script], { windowsHide: true, encoding: "utf8", env: { ...process.env, WSL_UTF8: "1" } });assert.equal(response.status, 2);const result = JSON.parse(response.stdout);assert.equal(result.code, "not_available");writeFileSync(join(cwd, "sandbox-no-office.json"), JSON.stringify(result));
  }
  const row: Record<string, any> = { id: item.id, cwd, pass: false };proof.cases.push(row);save();
  try {
   const sessionFile = resumeArg ? readdirSync(join(root, "sessions")).filter((name) => name.endsWith(".jsonl")).map((name) => join(root, "sessions", name)).find((file) => JSON.parse(readFileSync(file, "utf8").split("\n")[0]).cwd === cwd) : undefined;
   if (resumeArg) assert.ok(sessionFile);
   row.sessionFile = sessionFile;
   await core.call("slot.open", { slotId: item.id, cwd, sessionFile, agentMode: "standard" }, client);
   const message = resumeArg ? "继续上次的数据分析验收任务。此前只有测试请求数上限中断，summary.csv、chart.png 和 .dreamflutter/tmp/make_docx.py 都已存在；不要重新分析或修改图。再次加载 data-analysis、office-docx，用现有 pwsh 执行现成 make_docx.py 生成 chart-report.docx，重开检查汇总甲7乙5和同一张图已嵌入，简短报告。" : item.prompt;
   const started = Date.now();await core.call("slot.send", { slotId: item.id, record: { id: `t78-${item.id}`, type: "prompt", message } }, client);
   while (!(records.get(item.id) ?? []).some((r: any) => r.type === "agent_settled")) { if (Date.now() - started > 300_000) throw new Error("Case timeout");await new Promise((r) => setTimeout(r, 100)); }
   const events = records.get(item.id) ?? [], tools = events.filter((r: any) => r.type === "tool_execution_end");
   const inputs = new Map(events.filter((r: any) => r.type === "tool_execution_start").map((r: any) => [r.toolCallId, r.args]));
   row.tools = tools.map((r: any) => ({ name: r.toolName, args: inputs.get(r.toolCallId), isError: r.isError, result: r.result }));
   const last = events.filter((r: any) => r.type === "message_end" && r.message?.role === "assistant").at(-1)?.message;
   assert.ok(last && last.stopReason !== "error", last?.errorMessage);row.answer = last.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");row.elapsedMs = Date.now() - started;
   assert.ok(tools.some((r: any) => r.toolName === "skill" && (r.result?.details?.name === item.skill || JSON.stringify(r.result).includes(`"name":"${item.skill}"`))), `Expected real skill load: ${item.skill}`);
   if (item.id === "unsupported") { assert.ok(tools.some((r: any) => r.toolName === "skill" && r.result?.details?.name === "office-xlsx"));assert.match(row.answer, /不支持/);assert.match(row.answer, /OCR|识别/i);assert.match(row.answer, /重算|重新计算/);assert.ok(!row.tools.some((r: any) => ["pwsh","bash","write","edit"].includes(r.name))); }
   else if (item.id === "sandbox-office") { assert.match(row.answer, /没有可用的转换程序|没有.*Office|不支持/); }
   else { const checked = spawnSync(python, ["-I", "-B", join(repository, "scripts/t78-verify-products.py"), item.id, cwd], { encoding: "utf8", windowsHide: true });assert.equal(checked.status, 0, checked.stdout + checked.stderr);row.verification = JSON.parse(checked.stdout); }
   row.pass = true;
  } catch (error) { row.error = error instanceof Error ? error.message : String(error); }
  finally { await core.closeSlot(item.id);save();console.log(JSON.stringify({ case: row.id, pass: row.pass, error: row.error, physicalRequests, costUsd: proof.costUsd })); }
 }
 proof.pass = proof.cases.every((row: any) => row.pass);if (!proof.pass) process.exitCode = 1;
} catch (error) { proof.pass = false;proof.error = error instanceof Error ? error.message : String(error);process.exitCode = 1;
} finally { proof.approvals = approvals.length;proof.requests = core.db.all("SELECT ok,model,input,output,cost,error_kind FROM gateway_requests WHERE rowid>? ORDER BY rowid", baselineRow);save();await core.shutdown();console.log(JSON.stringify({ pass: proof.pass, cases: proof.cases.map((r: any) => ({ id: r.id, pass: r.pass, error: r.error })), requests: proof.requests.length, cost: proof.requests.reduce((n: number, r: any) => n + r.cost, 0), evidence })); }
