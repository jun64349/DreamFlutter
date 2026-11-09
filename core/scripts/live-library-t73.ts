/** T-73: existing OpenCode Go channel, isolated snapshot, bounded real Agent registration. */
import assert from "node:assert/strict";
import { backup, DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Core } from "../src/core.ts";
import { corePaths, defaultAgentDir } from "../src/paths.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { Llm } from "../src/modules/llm.ts";
import { Providers } from "../src/modules/providers.ts";
import { Gateway } from "../src/gateway/gateway.ts";
import { SkillsModule, type Proposal } from "../src/modules/skills.ts";
import { McpModule } from "../src/modules/mcp.ts";
import { SecretStore, relocateSecretRef } from "../src/modules/secrets.ts";
import { remapColumns } from "../src/backup/parts.ts";
import { PathMap } from "../src/backup/path-map.ts";
import { fileHash } from "../src/gateway/pi-config.ts";
import { redact, redactValue } from "../src/security/redaction.ts";

const source = resolve(process.argv[2] ?? ""), evidence = process.argv[3];
assert.equal(source.toLowerCase(), resolve("E:/DreamFlutter测试版/data").toLowerCase());
assert.ok(evidence, "evidence JSON path required");
assert.equal(existsSync(evidence), false, "use a new evidence file; never silently repeat a paid run");
const root = mkdtempSync(join(tmpdir(), "df-t73-live-")), data = join(root, "data"), agent = join(root, "agent"), workspace = join(root, "workspace");
for (const path of [data, agent, workspace]) mkdirSync(path, { recursive: true });
const sourceAgent = defaultAgentDir(source);
const hashes = () => Object.fromEntries(["models.json", "auth.json", "settings.json"].map((file) => [file, fileHash(join(sourceAgent, file))]));
const before = hashes();
const readonly = new DatabaseSync(corePaths(source).dbFile, { readOnly: true });
try { await backup(readonly, corePaths(data).dbFile); } finally { readonly.close(); }
const oldSecrets = new SecretStore(source), secrets = new SecretStore(data); mkdirSync(secrets.dir, { recursive: true });
for (const file of existsSync(oldSecrets.dir) ? readdirSync(oldSecrets.dir) : []) if (file.endsWith(".dpapi")) copyFileSync(join(oldSecrets.dir, file), join(secrets.dir, file));
const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(agent, "auth.json"), refreshOnCreate: false });
const core = new Core({ paths: corePaths(data), agentDir: agent, sessionDir: join(root, "sessions"), log: new Logger(), notifier: new RecordingNotifier(), modelRuntime: () => runtime });
const llm = new Llm(core, () => runtime), providers = new Providers(core, llm);
const proof: Record<string, unknown> = { at: new Date().toISOString(), root, sourceReadOnly: true, newChannelsCreated: 0, physicalRequests: 0, requestLimit: 4, maxTokensPerRequest: 768, passed: false };
const gateway = new Gateway(core, providers, { transport: (model, context, options) => {
	const calls = Number(proof.physicalRequests); if (calls >= 4) throw new Error("T73 request budget exhausted");
	proof.physicalRequests = calls + 1; save();
	return streamSimple(model, context, { ...options, maxRetries: 0, maxTokens: 768, signal: AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(90_000)]) });
} });
core.use(gateway); core.use(new SkillsModule(core, llm)); core.use(new McpModule(core));
function save(): void { writeFileSync(evidence!, JSON.stringify(redactValue(proof), null, 2)); }
try {
	remapColumns(core.db, core.backupParts, { map: new PathMap([{ from: source, to: data }]), secretRef: (ref) => relocateSecretRef(ref, secrets.dir) });
	core.db.raw.exec("DELETE FROM proposals; DELETE FROM library_usage; DELETE FROM library_entries; DELETE FROM gateway_requests; DELETE FROM gateway_quota;");
	const channel = gateway.channels().find((entry) => entry.source === "df" && entry.enabled && entry.platform === "opencode-go" && entry.models.some((m) => m.id === "mimo-v2.6-flash"));
	assert.ok(channel, "existing OpenCode Go mimo-v2.6-flash channel required");
	proof.channel = { id: channel.id, name: channel.name, model: "mimo-v2.6-flash" };
	const originalChannels = core.db.all("SELECT id FROM gateway_channels ORDER BY id");
	core.settings.update({ defaultModel: `${channel.provider}/mimo-v2.6-flash`, fallbackModels: [], defaultThinking: "off", agentMode: "standard", approvalMode: "all", autoTitle: false, memoryEnabled: false, memoryAutoExtract: false, autoCompaction: false, dailyBudgetUsd: 0.05 });
	gateway.installRuntime(runtime); await core.start();
	const records: Record<string, unknown>[] = [];
	const client = core.addClient((event) => { if (event.event === "slot.record") records.push(event.record as Record<string, unknown>); });
	await core.call("slot.open", { slotId: "t73-live", cwd: workspace }, client);
	core.slot("t73-live").session.setActiveToolsByName(["skill_register", "mcp_register"]);
	save();
	await core.call("slot.send", { slotId: "t73-live", record: { type: "prompt", message: '这是授权的最小登记验证。请实际调用 skill_register 和 mcp_register 各一次，尽量在同一轮并行调用。技能名 t73-live-skill，description 为“整理验证用笔记”，scope=user，content 为完整 SKILL.md：---\\nname: t73-live-skill\\ndescription: 整理验证用笔记\\n---\\n整理笔记并检查结果。注意把反斜线 n 换成真正换行。MCP name=t73-live-mcp，transport=http，url=https://example.invalid/mcp。两条都只能提交给用户确认，不要信任或启用，不要实际连接服务。最后简短说明等待用户确认。' } }, client);
	const deadline = Date.now() + 120_000;
	while (!records.some((record) => record.type === "agent_settled")) { if (Date.now() > deadline) throw new Error("T73 live prompt timed out"); await new Promise((done) => setTimeout(done, 50)); }
	const proposals = await core.call("proposals.list", {}) as Proposal[];
	assert.ok(proposals.some((p) => p.kind === "skill" && p.payload.name === "t73-live-skill"));
	assert.ok(proposals.some((p) => p.kind === "mcp" && p.payload.name === "t73-live-mcp"));
	assert.ok(proposals.every((p) => p.status === "pending"));
	assert.equal(existsSync(join(agent, "skills", "t73-live-skill", "SKILL.md")), false);
	assert.equal((await core.call("mcp.list", {}) as { servers: unknown[] }).servers.length, 0);
	assert.deepEqual(core.db.all("SELECT id FROM gateway_channels ORDER BY id"), originalChannels);
	assert.deepEqual(hashes(), before);
	proof.passed = true;
	proof.sourceConfigUnchanged = true;
	proof.proposals = proposals.map((p) => ({ kind: p.kind, name: p.payload.name, status: p.status, sourceKind: p.payload.sourceKind }));
	proof.tools = records.filter((r) => r.type === "tool_execution_end").map((r) => ({ name: r.toolName, error: r.isError }));
	proof.requests = core.db.all("SELECT model,ok,input,output,cost,duration_ms FROM gateway_requests ORDER BY id");
} catch (error) { proof.error = redact(error instanceof Error ? error.message : "live validation failed", true); process.exitCode = 1; }
finally { await core.shutdown(); save(); console.log(JSON.stringify(redactValue(proof))); }
