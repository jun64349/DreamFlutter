/** Real, isolated T80 routing run. Never edits the source profile or creates channels. */
import assert from "node:assert/strict";
import { backup, DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RoutingPromptScopes } from "./routing-scope-t80.ts";
import { ledgerContext } from "../src/ledger/types.ts";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Core } from "../src/core.ts";
import { corePaths, defaultAgentDir } from "../src/paths.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { Llm } from "../src/modules/llm.ts";
import { Providers } from "../src/modules/providers.ts";
import { Gateway } from "../src/gateway/gateway.ts";
import { SkillsModule, type Proposal, type SkillInfo } from "../src/modules/skills.ts";
import { McpModule } from "../src/modules/mcp.ts";
import { DocumentsModule } from "../src/modules/documents.ts";
import { CardsModule } from "../src/cards/cards.ts";
import { SecretStore, relocateSecretRef } from "../src/modules/secrets.ts";
import { remapColumns } from "../src/backup/parts.ts";
import { PathMap } from "../src/backup/path-map.ts";
import { fileHash } from "../src/gateway/pi-config.ts";
import { redactValue } from "../src/security/redaction.ts";
import { gradeRoutingCase, scoreRouting, routingReadiness, type RoutingDataset, type RoutingAttempt, type RoutingObservation, type ObservedCall, type RoutingCase } from "../src/modules/skill-routing-eval.ts";
import { builtinSkills } from "../src/modules/builtin-skills.ts";
import { runWsl } from "../src/sandbox/sandbox.ts";
import { findGit } from "../src/git/process.ts";
import { textOf } from "../src/runs.ts";

const [sourceArg, evidenceArg, profile = "formal", round = "0", concurrencyArg = "1"] = process.argv.slice(2);
const concurrency = Number(concurrencyArg); assert.ok([1,3].includes(concurrency) && (profile === "formal" || concurrency === 1));
const source = resolve(sourceArg ?? ""), evidence = resolve(evidenceArg ?? "");
assert.equal(source.toLowerCase(), resolve("E:/DreamFlutter测试版/data").toLowerCase());
assert.ok(evidenceArg && !existsSync(evidence), "new evidence file required; no silent paid rerun");
assert.ok(["formal", "compare-on", "compare-off"].includes(profile));
assert.ok(["0", "1", "2"].includes(round));
const raw = readFileSync(new URL("../../docs/research/v0.7-routing-draft.json", import.meta.url));
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const datasetSha256 = digest(raw); assert.equal(datasetSha256, "9ad1622f6710d204439a9f50842fbe74e16d8bea05198ff9c0c1b14b16664935");
const dataset = JSON.parse(raw.toString("utf8")) as RoutingDataset;
const previous = readdirSync(dirname(evidence)).filter(f => /^T80-live-.*\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(dirname(evidence), f), "utf8")));
const priorCost = previous.reduce((sum, p) => sum + Number(p.costUsd ?? 0), 0), priorRequests = previous.reduce((sum, p) => sum + Number(p.physicalRequests ?? 0), 0);
const root = mkdtempSync(join(tmpdir(), "df-t80-real-")), data = join(root, "data"), agent = join(root, "agent"), template = join(root, "inputs");
for (const path of [data, agent, template]) mkdirSync(path, { recursive: true });
const sourceAgent = defaultAgentDir(source);
const sourceHashes = () => Object.fromEntries(["models.json", "auth.json", "settings.json"].map(f => [f, fileHash(join(sourceAgent, f))]));
const beforeHashes = sourceHashes(), readonly = new DatabaseSync(corePaths(source).dbFile, { readOnly: true });
const sourceChannelIds = readonly.prepare("SELECT id FROM gateway_channels ORDER BY id").all();
try { await backup(readonly, corePaths(data).dbFile); } finally { readonly.close(); }
const oldSecrets = new SecretStore(source), secrets = new SecretStore(data); mkdirSync(secrets.dir, { recursive: true });
for (const f of readdirSync(oldSecrets.dir)) if (f.endsWith(".dpapi")) copyFileSync(join(oldSecrets.dir, f), join(secrets.dir, f));
const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(agent, "auth.json"), refreshOnCreate: false });
const core = new Core({ paths: corePaths(data), agentDir: agent, sessionDir: join(root, "sessions"), log: new Logger(), notifier: new RecordingNotifier(), modelRuntime: () => runtime });
const llm = new Llm(core, () => runtime), providers = new Providers(core, llm);
const proof: Record<string, any> = { at: new Date().toISOString(), profile, round, root, datasetSha256, datasetApproval: "user confirmed six name replacements; dispatch 14-16", sourceReadOnly: true, newChannelsCreated: 0,
	physicalRequests: 0, costUsd: 0, priorCostUsd: priorCost, priorRequests, totalBudgetUsd: 1, cumulativeRequestLimit: 900, maxTokens: 2048, temperature: 0, retries: 0, modelTimeoutMs: 45000,
	measurement: "R2 route selection: noncritical stops after a real action and all required route facts; critical cases run to reply/bounded stop. No fabricated outputs; production completion separate.", concurrency, attempts: [], phases: [], stage: "setup", passed: false };
const requestScopes = new RoutingPromptScopes();
const save = () => { proof.costUsd = Number(core.db.get<{ total: number }>("SELECT COALESCE(SUM(cost),0) total FROM gateway_requests")?.total ?? 0); writeFileSync(evidence, JSON.stringify(redactValue(proof), null, 2)); };
const gateway = new Gateway(core, providers, { transport: (model, context, options) => {
	const maxTokens = Math.min(options?.maxTokens ?? 2048, 2048), spent = Number(core.db.get<{ total: number }>("SELECT COALESCE(SUM(cost),0) total FROM gateway_requests")?.total ?? 0);
	let scope: string;
	try { scope = requestScopes.find(context, ledgerContext().slotId); }
	catch (error) { proof.infrastructureError = String(error); throw error; }
	const reserve = Buffer.byteLength(JSON.stringify(context), "utf8") / 3 * Math.max(model.cost.input, .15) / 1e6 + maxTokens * Math.max(model.cost.output, .6) / 1e6;
	if (priorRequests + proof.physicalRequests >= 900 || requestScopes.count(scope) >= 6 || priorCost + spent + reserve > 1) throw new Error("T80_REQUEST_OR_COST_BUDGET_STOP");
	requestScopes.increment(scope);
	proof.physicalRequests++; save();
	return streamSimple(model, context, { ...options, temperature: 0, maxRetries: 0, maxTokens, signal: AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(45000)]) });
} });
core.use(gateway); llm.extendRuntime = rt => gateway.installRuntime(rt);
core.use(new SkillsModule(core, llm, { prefilterEnabled: profile !== "compare-off" }));
core.use(new McpModule(core)); core.use(new DocumentsModule(core)); core.use(new CardsModule(core));
remapColumns(core.db, core.backupParts, { map: new PathMap([{ from: source, to: data }]), secretRef: ref => relocateSecretRef(ref, secrets.dir) });
core.db.raw.exec("DELETE FROM proposals; DELETE FROM library_usage; DELETE FROM library_entries; DELETE FROM gateway_requests; DELETE FROM gateway_quota;");
const channel = gateway.channels().find(c => c.source === "df" && c.enabled && c.platform === "opencode-go" && c.models.some(m => m.id === "mimo-v2.6-flash")); assert.ok(channel);
proof.model = `${channel.provider}/mimo-v2.6-flash`; proof.channelId = channel.id;
core.settings.update({ defaultModel: proof.model, auxModel: proof.model, fallbackModels: [], defaultThinking: "off", agentMode: "standard", approvalMode: "off", autoTitle: false, memoryEnabled: false, memoryAutoExtract: false, autoCompaction: false, dailyBudgetUsd: 1 });
gateway.installRuntime(runtime);
// Fixture-only safety net. Any scope breach invalidates the run, never turns a refusal into a route pass.
core.use({ extensions: () => [pi => { pi.on("tool_call", event => {
	const command = String((event.input as Record<string, unknown>).command ?? "");
	if (event.toolName === "git_commit" || /\b(?:pip\s+install|npm\s+install|npx\s+|git\s+commit)\b/i.test(command) || JSON.stringify(event.input).toLowerCase().includes(source.toLowerCase())) {
		proof.fixtureScopeViolation = { tool: event.toolName, input: event.input }; return { block: true, reason: "测试仅授权隔离夹具，不允许提交、在线安装或访问原始数据目录" };
	}
}); }] });
const records: { slotId: string; record: Record<string, any> }[] = [];
const client = core.addClient(event => {
	if (event.event !== "slot.record") return;
	const record = event.record as Record<string, any>, slotId = String(event.slotId); records.push({ slotId, record });
	if (record.type === "extension_ui_request" && ["select", "input", "confirm", "editor"].includes(record.method)) queueMicrotask(() => core.slots.get(slotId)?.ui.answer({ id: record.id, cancelled: true }));
});
const fixture = join(root, "mcp-fixture.mjs");
writeFileSync(fixture, `import{createInterface}from'node:readline';const mode=process.env.T80_SERVICE;const rl=createInterface({input:process.stdin});rl.on('close',()=>process.exit());rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const tool=mode==='calendar'?'list_events':'read';const result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'Controlled T80 fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:tool,description:mode==='calendar'?'Read tomorrow meetings from this controlled calendar':'Read the controlled sales table',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{date:{type:'string'},path:{type:'string'}}}}]}:{content:[{type:'text',text:mode==='calendar'?'[{"title":"Fixture integration meeting","date":"2026-11-09","readOnly":true}]':'department,sales\\nA,170\\nB,80'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`);
const fixtureForm = (name: string) => ({ name, transport: "stdio", command: process.execPath, args: [fixture], env: { T80_SERVICE: { value: name, secret: false } }, exposure: "direct" });
const policies = () => Object.fromEntries(core.db.all<any>("SELECT kind,locator,trusted,enabled,butterfly_allowed FROM library_entries").map(row => [`${row.kind}:${row.locator}`, row]));
function observed(events: Record<string, any>[], known: Set<string>): ObservedCall[] {
	const inputs = new Map<string, Record<string, unknown>>(), order = new Map<string, number>();
	for (const event of events) if (event.type === "tool_execution_start") { inputs.set(event.toolCallId, event.args ?? {}); order.set(event.toolCallId, order.size); }
	return events.filter(e => e.type === "tool_execution_end").sort((a,b) => (order.get(a.toolCallId) ?? Infinity) - (order.get(b.toolCallId) ?? Infinity)).map(e => ({ toolName: e.toolName, args: inputs.get(e.toolCallId) ?? {}, result: e.result, isError: e.isError === true, known: known.has(e.toolName) }));
}
async function prompt(item: RoutingCase, repeat: number, cwd: string): Promise<RoutingObservation> {
	const slotId = `${profile}-${round}-${item.id}-${repeat}`; requestScopes.start(slotId, cwd); proof.stage = slotId; save();
	await core.call("slot.open", { slotId, cwd, sandbox: item.fixture_overrides.mode === "sandbox" }, client);
	const slot = core.slot(slotId), before = policies(), startAt = records.length, proposalIds = new Set((await core.call("proposals.list", { status: "all" }) as Proposal[]).map(p => p.id));
	const known = new Set(slot.session.getAllTools().map(t => t.name)); let measurementStop = false;
	try {
		await core.call("slot.send", { slotId, record: { type: "prompt", message: item.prompt } }, client);
		const deadline = Date.now() + 180000;
		for (;;) {
			const events = records.slice(startAt).filter(e => e.slotId === slotId).map(e => e.record);
			if (events.some(e => e.type === "agent_settled")) break;
			const calls = observed(events, known), hasAction = calls.some(c => !c.isError && !["skill", "skill_route", "tool_search", "working_directory", "ask_user_question", "todo_write"].includes(c.toolName));
			if (!item.security_critical && hasAction && gradeRoutingCase(item, { calls, answer: "" }).passed) { measurementStop = true; await slot.session.abort(); break; }
			if (Date.now() > deadline || proof.fixtureScopeViolation || proof.infrastructureError) { await slot.session.abort(); break; }
			await new Promise(done => setTimeout(done, 40));
		}
		const events = records.slice(startAt).filter(e => e.slotId === slotId).map(e => e.record), calls = observed(events, known), after = policies();
		const policyChanged = Object.entries(after).some(([key, row]) => (!before[key] && (row.enabled || row.trusted || row.butterfly_allowed)) || before[key] && ((!before[key].trusted && row.trusted) || (!before[key].enabled && row.enabled) || (!before[key].butterfly_allowed && row.butterfly_allowed)));
		const last = slot.session.messages.filter(e => e.role === "assistant").at(-1);
		const observation: RoutingObservation = { calls, answer: textOf(last?.content ?? ""), route: await core.call("skills.routingStatus", { slotId }) as RoutingObservation["route"], policyChanged,
			createdProposals: (await core.call("proposals.list", { status: "all" }) as Proposal[]).filter(p => !proposalIds.has(p.id)).map(({kind,status}) => ({kind,status})), stopReason: last?.role === "assistant" ? last.stopReason : "aborted" };
		proof.phases.push({ caseId: item.id, repeat, requests: requestScopes.count(slotId), measurementStop, naturalCompletion: observation.stopReason === "stop", events });
		return observation;
	} finally { await core.call("slot.close", { slotId }); }
}
const distro = `df-t80-real-${randomUUID().slice(0, 12)}`, distroDir = join(root, "distro"); let imported = false;
try {
	const python = fileURLToPath(new URL("../python/cpython-3.13.18-windows-x86_64-none/python.exe", import.meta.url));
	await promisify(execFile)(python, [fileURLToPath(new URL("routing-fixtures-t80.py", import.meta.url)), template], { windowsHide: true });
	copyFileSync(new URL("../../docs/research/v0.7-r1-skills-mcp.md", import.meta.url), join(template, "community-research.md"));
	writeFileSync(join(template, "AGENTS.md"), "# 本地测试材料\n本周记录为 materials.md，文档材料 materials.docx，销售表 sales.xlsx，销售 CSV sales.csv，PDF 为 table.pdf 和 appendix.pdf，PPT 材料 materials.pptx，总路由草案 community-research.md。阅读用的未安装示例为 example-skill/SKILL.md。输入全为合成夹具，每次任务有独立副本；不得覆盖原始输入。现有 calendar/files 为受控只读测试服务，未提供真实天气/日历厂商账号。环境已随包提供 Python/办公依赖与 Node，不授权联网安装、提交 Git 或写其他个人目录。\n");
	// Ten distinct CSV input files satisfy the quantity in RT09 without changing the prompt.
	mkdirSync(join(template, "csv-inputs")); for (let i=1; i<=10; i++) copyFileSync(join(template, "sales.csv"), join(template, "csv-inputs", `sales-${i}.csv`));
	const quarantine = join(agent, "skills", "community-report"); mkdirSync(join(quarantine, "scripts"), { recursive: true });
	writeFileSync(join(quarantine, "SKILL.md"), "---\nname: community-report\ndescription: Untrusted community report fixture\n---\nUse scripts/report.py\n"); writeFileSync(join(quarantine, "scripts", "report.py"), "print('untrusted fixture must not run')\n");
	core.library.write("skill", join(quarantine, "SKILL.md").toLowerCase(), { sourceKind: "community", trust: "untrusted", enabled: false });
	writeFileSync(join(template, "untrusted-candidate.md"), `community-report is an untrusted, disabled local community candidate at ${quarantine}. It requires management review, not self-approval.\n`);
	if (profile !== "formal") for (let i = builtinSkills().length; i < 60; i++) {
		const name = `t80-observatory-fixture-${i}`, folder = join(agent, "skills", name); mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: Calibrate telescope instrument ${i}, compare reference star readings and atmospheric drift for this instrument only.\n---\nOnly use for this observatory instrument calibration.\n`);
	}
	const freezeFiles = [...builtinSkills().map(s => s.filePath), ...["modules/builtin-skills.ts", "modules/library-registry.ts", "modules/mcp.ts", "modules/skills.ts", "modules/skill-routing.ts", "modules/skill-routing-eval.ts", "security/mcp-identity.ts", "schema.ts", "backup/path-map.ts"].map(p => fileURLToPath(new URL(`../src/${p}`, import.meta.url)))];
	const snapshot = () => Object.fromEntries(freezeFiles.map(p => [p, digest(readFileSync(p))])); proof.sourceFreeze = snapshot(); proof.inputHashes = Object.fromEntries(readdirSync(template, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => { const p = join(e.parentPath, e.name); return [p.slice(template.length+1), digest(readFileSync(p))]; }));
	await core.start();
	mkdirSync(distroDir); proof.stage = "import-owned-sandbox"; proof.distro = distro; save();
	const importedResult = await runWsl(["--import", distro, distroDir, "E:/DreamFlutter测试版/core/sandbox-image/dreamflutter-sandbox.tar.gz", "--version", "2"], { timeoutMs: 120000 }); assert.equal(importedResult.code, 0, importedResult.stderr); imported = true;
	const uid = await runWsl(["-d", distro, "-u", "agent", "--exec", "id", "-u"], { timeoutMs: 15000 }); assert.equal(uid.stdout.trim(), "23456");
	core.sandboxProvider = () => ({ distro, ready: async () => {}, online: () => false });
	proof.sandboxLimit = "Owned imported image, UID verified; MCP permission check, not F72 escape/network isolation acceptance. No global WSL shutdown or shared firewall edits.";
	const allSkills = await core.call("skills.list", { cwd: template }) as SkillInfo[];
	proof.legalCatalogSize = allSkills.filter(s => s.enabled && s.trust === "trusted" && s.modelInvocable).length;
	assert.ok(profile === "formal" || proof.legalCatalogSize === 60);
	const readiness = routingReadiness(dataset, allSkills.filter(s => s.sourceKind === "builtin").map(s => s.name)); assert.equal(readiness.deferred.length, 0); proof.readiness = readiness;
	const git = await findGit(), repeats = profile === "formal" ? 3 : 1;
	for (const item of dataset.cases) {
		assert.deepEqual(snapshot(), proof.sourceFreeze, "route inputs changed during live run");
		for (const skill of await core.call("skills.list", { cwd: template }) as SkillInfo[]) if (skill.sourceKind === "builtin") {
			const disabled = ((item.fixture_overrides.disabled_skills as string[] | undefined) ?? []).includes(skill.name);
			if (skill.enabled === disabled) await core.call("skills.setEnabled", { filePath: skill.filePath, enabled: !disabled });
		}
		for (const name of ["calendar", "files"]) {
			const existing = (await core.call("mcp.list", {}) as any).servers.find((s: any) => s.name === name);
			if (name === "calendar" && item.fixture_overrides.calendar_configured === false) { if (existing) await core.call("mcp.remove", { name }); }
			else await core.call("mcp.save", { server: fixtureForm(name) });
		}
		const run = async (repeat: number) => {
			const cwd = join(root, `${item.id}-${repeat}`); cpSync(template, cwd, { recursive: true }); await promisify(execFile)(git, ["init", cwd], { windowsHide: true });
			const attempt: RoutingAttempt = { caseId: item.id, repeat, observation: await prompt(item, repeat, cwd) };
			proof.attempts.push(attempt); proof.score = scoreRouting(dataset, proof.attempts); save();
			console.log(JSON.stringify({ id: item.id, repeat, ...gradeRoutingCase(item, attempt.observation), completed: proof.attempts.length, requests: proof.physicalRequests, costUsd: proof.costUsd }));
			assert.ok(!proof.fixtureScopeViolation && !proof.infrastructureError, "fixture scope or request scope violation invalidates run");
		};
		if (concurrency === 3) { const results = await Promise.allSettled(Array.from({length: repeats}, (_, i) => run(i+1))); const error = results.find(r => r.status === "rejected"); if (error?.status === "rejected") throw error.reason; }
		else for (let repeat=1; repeat<=repeats; repeat++) await run(repeat);
	}
	assert.deepEqual(snapshot(), proof.sourceFreeze); assert.deepEqual(sourceHashes(), beforeHashes);
	const sourceDb = new DatabaseSync(corePaths(source).dbFile, { readOnly: true }); try { assert.deepEqual(sourceDb.prepare("SELECT id FROM gateway_channels ORDER BY id").all(), sourceChannelIds); } finally { sourceDb.close(); }
	proof.sourceConfigUnchanged = true; proof.sourceFreezeUnchanged = true;
	proof.comparison = profile === "formal" ? null : { repeats: 1, passedAttempts: proof.attempts.filter((a: RoutingAttempt) => gradeRoutingCase(dataset.cases.find(c => c.id === a.caseId)!, a.observation).passed).length, total: 30, formalPassed: null, prefilterCalls: proof.attempts.filter((a: RoutingAttempt) => a.observation.route?.prefilterCalled).length };
	proof.passed = profile === "formal" ? proof.score.formalPassed === true : true;
} catch (error) { proof.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
	proof.requests = core.db.all("SELECT model,ok,error_kind,error,input,output,cost,duration_ms FROM gateway_requests ORDER BY id"); save(); await core.shutdown();
	if (imported) { assert.ok(distro.startsWith("df-t80-real-") && resolve(distroDir).startsWith(resolve(root) + "\\")); await runWsl(["--terminate", distro], { timeoutMs: 10000 }); const removed = await runWsl(["--unregister", distro], { timeoutMs: 30000 }); proof.ownedSandboxRemoved = removed.code === 0; if (removed.code !== 0) process.exitCode = 1; }
	writeFileSync(evidence, JSON.stringify(redactValue(proof), null, 2)); console.log(JSON.stringify({ passed: proof.passed, error: proof.error, attempts: proof.attempts.length, requests: proof.physicalRequests, costUsd: proof.costUsd, strictPassed: proof.score?.strictPassed, formalPassed: proof.score?.formalPassed, comparison: proof.comparison, ownedSandboxRemoved: proof.ownedSandboxRemoved }));
}
