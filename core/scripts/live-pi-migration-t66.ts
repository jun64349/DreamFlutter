/** T-66: read-only source, isolated snapshot, CLI listing and exactly one short model request. */
import assert from "node:assert/strict";
import { backup, DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { buildCore } from "../src/app.ts";
import { corePaths, defaultAgentDir } from "../src/paths.ts";
import { storageLocations } from "../src/storage/locations.ts";
import { PathMap } from "../src/backup/path-map.ts";
import { remapColumns } from "../src/backup/parts.ts";
import { SecretStore, relocateSecretRef, isSecretReference, secretFileOf } from "../src/modules/secrets.ts";
import { PiMigration } from "../src/gateway/pi-migration.ts";
import { Gateway } from "../src/gateway/gateway.ts";
import { fileHash, readPiJson } from "../src/gateway/pi-config.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { redact, redactValue } from "../src/security/redaction.ts";

const source = resolve(process.argv[2] ?? ""), evidence = process.argv[3];
assert.equal(source.toLowerCase(), resolve("E:/DreamFlutter测试版/data").toLowerCase(), "only the explicitly authorized source may be copied");
assert.ok(evidence, "evidence file required");
const root = mkdtempSync(join(tmpdir(), "df-t66-real-copy-")), data = join(root, "data"), agentDir = join(data, "pi"), sessionsDir = join(agentDir, "sessions");
function phase(stage: string): void { writeFileSync(`${evidence}.phase.json`, JSON.stringify({ at: new Date().toISOString(), root, stage })); console.log(stage); }
function copyTree(from: string, to: string): void {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		assert.equal(entry.isSymbolicLink(), false, "the isolated copy does not follow directory links");
		const sourceFile = join(from, entry.name), targetFile = join(to, entry.name);
		if (entry.isDirectory()) copyTree(sourceFile, targetFile); else copyFileSync(sourceFile, targetFile);
	}
}
for (const path of [data, agentDir, sessionsDir]) mkdirSync(path, { recursive: true });
const sourcePaths = corePaths(source), sourceAgent = defaultAgentDir(source), locations = storageLocations(source);
const hashesBefore = Object.fromEntries(["models.json", "auth.json", "settings.json"].map((name) => [name, fileHash(join(sourceAgent, name))]));
const sourceDb = new DatabaseSync(sourcePaths.dbFile, { readOnly: true });
phase("copying_consistent_database");
try { await backup(sourceDb, corePaths(data).dbFile); } finally { sourceDb.close(); }
// No caches, backups, WebView profiles, WSL images or running-process files are copied.
for (const name of ["models.json", "auth.json", "settings.json", "models-store.json"]) if (existsSync(join(sourceAgent, name))) copyFileSync(join(sourceAgent, name), join(agentDir, name));
phase("copying_sessions");
if (existsSync(locations.sessions)) copyTree(locations.sessions, sessionsDir);
const oldSecrets = new SecretStore(source), newSecrets = new SecretStore(data);
if (existsSync(oldSecrets.dir)) copyTree(oldSecrets.dir, newSecrets.dir);
phase("copying_encrypted_credentials_complete");
const map = new PathMap([{ from: source, to: data }, { from: sourceAgent, to: agentDir }, { from: locations.sessions, to: sessionsDir }, { from: oldSecrets.dir, to: newSecrets.dir }]);
function moveConfig(value: any): any {
	if (typeof value === "string") {
		if (isSecretReference(value)) return relocateSecretRef(value, newSecrets.dir);
		if (value.startsWith("!")) throw new Error("副本中存在非 SecretStore 的命令凭据，真实 CLI 验证暂停，避免执行用户命令。");
		return map.map(value);
	}
	if (Array.isArray(value)) return value.map(moveConfig);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, moveConfig(item)]));
	return value;
}
for (const name of ["models.json", "auth.json", "settings.json"]) if (existsSync(join(agentDir, name))) writeFileSync(join(agentDir, name), JSON.stringify(moveConfig(readPiJson(join(agentDir, name))), null, 2));
const core = buildCore({ paths: corePaths(data), agentDir, sessionDir: sessionsDir, log: new Logger(), notifier: new RecordingNotifier() });
const gateway = core.module(Gateway)!, migration = core.module(PiMigration)!;
const result: Record<string, any> = { at: new Date().toISOString(), isolatedRoot: root, source, sourceReadOnly: true };
function sessionFiles(dir: string): string[] { return existsSync(dir) ? readdirSync(dir).flatMap((name) => { const file = join(dir, name); return statSync(file).isDirectory() ? sessionFiles(file) : name.endsWith(".jsonl") ? [file] : []; }) : []; }
try {
	core.db.transaction(() => { remapColumns(core.db, core.backupParts, { map, secretRef: (ref) => relocateSecretRef(ref, newSecrets.dir) }); });
	core.settings.reloadFromDb();
	const before = { channels: gateway.channels().filter((c) => c.source === "df").length, groups: gateway.groups(), settings: core.settings.get() };
	core.settings.update({ autoTitle: false, memoryEnabled: false, memoryAutoExtract: false, memoryPaused: true });
	await migration.start();
	phase("isolated_migration_complete");
	const status = migration.status(); assert.equal(status.status, "done", status.error);
	const after = core.settings.get();
	for (const key of ["defaultModel", "auxModel", "visionModel", "memoryModel"] as const) if (before.settings[key]) assert.equal(after[key], core.resolveModelRef(before.settings[key]!));
	for (const ref of before.settings.fallbackModels) assert.ok(after.fallbackModels.includes(core.resolveModelRef(ref)));
	for (const [ref, window] of Object.entries(before.settings.modelContextWindows)) assert.equal(after.modelContextWindows[core.resolveModelRef(ref)], window);
	result.migration = { status: status.status, mappings: status.mappings, results: status.results, unresolved: status.unresolved, beforeChannels: before.channels, afterChannels: gateway.channels().filter((c) => c.source === "df").length, referencesChecked: true };
	const modelRuntime = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json"), authPath: join(agentDir, "auth.json"), refreshOnCreate: false });
	assert.equal(modelRuntime.getError(), undefined);
	const history = { files: 0, mapped: 0, unchanged: 0, unresolved: [] as string[] };
	for (const file of sessionFiles(sessionsDir)) {
		const selected = SessionManager.open(file, sessionsDir).buildSessionContext().model;
		if (!selected) continue; history.files++;
		const old = `${selected.provider}/${selected.modelId}`, next = core.resolveModelRef(old), slash = next.indexOf("/");
		if (next !== old) history.mapped++; else history.unchanged++;
		if (!modelRuntime.getModel(next.slice(0, slash), next.slice(slash + 1)) && next.slice(0, slash) !== "dreamflutter") history.unresolved.push(old);
	}
	result.history = history;
	phase("historical_references_checked");
	const safeReferences = (value: any): void => {
		if (typeof value === "string" && value.startsWith("!")) { const file = secretFileOf(value); assert.ok(file, "CLI must not execute arbitrary source commands"); const rel = relative(root, resolve(file)); assert.ok(rel !== ".." && !rel.startsWith(`..${sep}`), "all decrypted files must be inside the temporary copy"); }
		else if (Array.isArray(value)) value.forEach(safeReferences);
		else if (value && typeof value === "object") Object.values(value).forEach(safeReferences);
	};
	safeReferences(readPiJson(join(agentDir, "models.json")));
	const cli = spawnSync(process.execPath, ["node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", "--list-models", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session"], { cwd: process.cwd(), env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, encoding: "utf8", timeout: 45000, windowsHide: true });
	result.cli = { exit: cli.status, listedLines: cli.stdout?.trim().split(/\r?\n/).length ?? 0, error: cli.status === 0 ? null : "Pi CLI 未完成列模型" }; assert.equal(cli.status, 0, "Pi CLI failed; pause before real model call");
	phase("bundled_cli_list_complete");
	const channel = gateway.channels().find((c) => c.source === "df" && c.enabled && c.platform === "opencode-go" && c.models.some((m) => m.id === "mimo-v2.6-flash")) ?? gateway.channels().find((c) => c.source === "df" && c.enabled && c.keys.some((k) => k.enabled));
	assert.ok(channel, "no enabled copied channel available");
	const selected = channel.models.find((m) => m.id === "mimo-v2.6-flash") ?? channel.models[0]!;
	assert.match(cli.stdout, new RegExp(channel.provider));
	gateway.installRuntime(modelRuntime);
	const model = modelRuntime.getModel(channel.provider, selected.id)!; assert.ok(model);
	const last = core.db.get<{ id: number }>("SELECT COALESCE(MAX(id),0) id FROM gateway_requests")!.id;
	const started = Date.now();
	phase("single_real_model_request_started");
	const message = await modelRuntime.completeSimple(model, { messages: [{ role: "user", content: "只回复 OK，不使用工具。", timestamp: Date.now() }] }, { maxTokens: 1024, reasoning: "off", signal: AbortSignal.timeout(90000) });
	const requests = core.db.all("SELECT model,ok,input,output,cache_read,cache_write,cost,duration_ms FROM gateway_requests WHERE id>? ORDER BY id", last);
	result.realCall = { provider: channel.provider, model: selected.id, durationMs: Date.now() - started, stopReason: message.stopReason, usage: message.usage, text: message.content.filter((c) => c.type === "text").map((c) => c.text).join(""), requests };
	assert.equal(requests.length, 1, "exactly one paid model request is authorized"); assert.equal(message.stopReason, "stop", "the single model call did not finish normally");
	const hashesAfter = Object.fromEntries(["models.json", "auth.json", "settings.json"].map((name) => [name, fileHash(join(sourceAgent, name))]));
	assert.deepEqual(hashesAfter, hashesBefore, "the source configuration changed during verification"); result.sourceConfigUnchanged = true;
} catch (error) { result.error = redact(error instanceof Error ? error.message : "验证失败", true); process.exitCode = 1; }
finally { await core.shutdown(); writeFileSync(evidence!, JSON.stringify(redactValue(result), null, 2)); console.log(JSON.stringify(redactValue(result))); }
