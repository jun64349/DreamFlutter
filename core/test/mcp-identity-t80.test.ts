import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { buildCore } from "../src/app.ts";
import { Db } from "../src/db.ts";
import { MIGRATIONS } from "../src/schema.ts";
import { LibraryRegistry, locator, mcpFingerprint } from "../src/modules/library-registry.ts";
import { mcpIdentity, parseMcpIdentity } from "../src/security/mcp-identity.ts";
import { loadSecurityMcpConfig } from "../src/security/mcp-config.ts";
import { PathMap } from "../src/backup/path-map.ts";
import { remapColumns } from "../src/backup/parts.ts";
import { corePaths, defaultAgentDir } from "../src/paths.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { storageLocations } from "../src/storage/locations.ts";
import { preparePendingMove, remapMovedDatabase, requestMove, validateMove } from "../src/storage/move.ts";
import { applyPendingRestore } from "../src/backup/switch.ts";
import type { Job } from "../src/backup/backup.ts";
import { startTestCore, type TestCore } from "./harness.ts";

const form = (name = "CodeHost") => ({ name, transport: "http", url: "http://127.0.0.1:1/fixture", exposure: "direct" });
const entry = (source: string, name = "CodeHost") => ({ source, name, config: { url: "http://127.0.0.1:1/fixture", exposure: "direct" } as never });
async function job(t: TestCore, initial: unknown): Promise<Job> { const id = (initial as Job).id; return t.waitFor(() => { const next = t.messages.filter((event) => event.event === "backup.job").map((event) => event.job as Job).filter((value) => value.id === id).at(-1); return next && next.status !== "running" ? next : undefined; }, 120000); }

test("T80 migration 15 and path mapping preserve MCP service case and every policy/usage field", async () => {
	const t = await startTestCore(); let db: Db | undefined;
	try {
		const oldAgent = join(t.dir, "old#agent"), nextAgent = join(t.dir, "new#agent"); mkdirSync(nextAgent);
		const oldSource = join(oldAgent, "mcp.json"), nextSource = join(nextAgent, "mcp.json"); writeFileSync(nextSource, JSON.stringify({ mcpServers: { CodeHost: entry(nextSource).config } }));
		const path = join(t.dir, "v14.db"), legacy = new DatabaseSync(path); for (const sql of MIGRATIONS.slice(0, 14)) legacy.exec(sql); legacy.exec("PRAGMA user_version=14");
		const oldKey = `${locator(oldSource)}#codehost`, fingerprint = mcpFingerprint(entry(nextSource).config);
		legacy.prepare("INSERT INTO library_entries(kind,locator,source_kind,source_url,trusted,enabled,butterfly_allowed,fingerprint,usage_count,last_used_at) VALUES('mcp',?,'community','https://example.invalid/origin',0,0,0,?,7,123)").run(oldKey, fingerprint);
		legacy.prepare("INSERT INTO library_usage VALUES('old-real-event','mcp',?,123)").run(oldKey); legacy.close(); db = new Db(path);
		remapColumns(db, t.core.backupParts, { map: new PathMap([{ from: oldAgent, to: nextAgent }]), secretRef: (ref) => ref }, true);
		const registry = new LibraryRegistry(db, t.core.security.audit, undefined, nextSource); assert.equal(registry.mcpAllowed(entry(nextSource)), false);
		const key = mcpIdentity(nextSource, "CodeHost"), row = db.get<any>("SELECT * FROM library_entries WHERE kind='mcp' AND locator=?", key)!;
		assert.equal(row.source_kind, "community"); assert.equal(row.source_url, "https://example.invalid/origin"); assert.equal(row.fingerprint, fingerprint);
		assert.deepEqual([row.trusted, row.enabled, row.butterfly_allowed, row.usage_count, row.last_used_at], [0, 0, 0, 7, 123]);
		assert.equal(db.get<any>("SELECT locator FROM library_usage WHERE event_id='old-real-event'")!.locator, key);
		assert.equal(parseMcpIdentity(key)!.name, "CodeHost"); assert.equal(db.all("SELECT * FROM library_entries WHERE kind='mcp'").length, 1);
	} finally { db?.close(); await t.cleanup(); }
});

test("T80 case-only double services stay separate, visibly conflicted and untrusted with no usage merge", async () => {
	const t = await startTestCore();
	try {
		const source = join(t.agentDir, "mcp.json"); writeFileSync(source, JSON.stringify({ mcpServers: { CodeHost: entry(source).config, codehost: entry(source).config } }));
		for (const name of ["CodeHost", "codehost"]) { const key = mcpIdentity(source, name); t.core.library.write("mcp", key, { sourceKind: "agent", trust: "trusted", enabled: true, butterflyAllowed: true }, mcpFingerprint(entry(source).config)); t.core.library.used("mcp", key, `event-${name}`); }
		for (const name of ["CodeHost", "codehost"]) { assert.equal(t.core.library.mcpAllowed(entry(source, name)), false); const meta = t.core.library.get("mcp", mcpIdentity(source, name)); assert.equal(meta.trust, "untrusted"); assert.equal(meta.enabled, false); assert.equal(meta.butterflyAllowed, false); assert.match(meta.identityConflict!, /冲突/); assert.equal(meta.usageCount, 1); }
		assert.equal(t.core.db.all("SELECT * FROM library_entries WHERE kind='mcp'").length, 2); assert.equal(t.core.db.all("SELECT DISTINCT locator FROM library_usage WHERE kind='mcp'").length, 2);
		await t.core.call("mcp.save", { server: form("RenamedHost"), previousName: "CodeHost" });
		await t.core.call("mcp.save", { server: form("codehost") });
		assert.equal(t.core.library.mcpAllowed(loadSecurityMcpConfig(t.agentDir, t.workspace, false).servers.find((value) => value.name === "codehost")!), true, "explicit review after resolving a conflict can restore trust, without merging the tombstone's history");
	} finally { await t.cleanup(); }
});

test("T80 missing managed rows fail closed, including pre-marker proposals, while direct legacy user config remains usable", async () => {
	const t = await startTestCore();
	try {
		await t.core.call("mcp.save", { server: form("ManagedUser") }); const source = join(t.agentDir, "mcp.json");
		t.core.db.run("DELETE FROM library_entries WHERE kind='mcp'"); const managed = loadSecurityMcpConfig(t.agentDir, t.workspace, false).servers[0]!;
		assert.equal(t.core.library.mcpAllowed(managed), false); assert.equal(t.core.library.mcpTrusted(managed), false);
		const proposal = await t.core.call("mcp.register", { server: form("AgentOld") }) as { id: string }; await t.core.call("proposals.accept", { id: proposal.id });
		const config = JSON.parse(readFileSync(source, "utf8")); delete config.mcpServers.AgentOld.dfLibrary; config.mcpServers.LegacyUser = entry(source).config; writeFileSync(source, JSON.stringify(config)); t.core.db.run("DELETE FROM library_entries WHERE kind='mcp'");
		const values = loadSecurityMcpConfig(t.agentDir, t.workspace, false).servers;
		assert.equal(t.core.library.mcpAllowed(values.find((value) => value.name === "AgentOld")!), false);
		assert.equal(t.core.library.mcpAllowed(values.find((value) => value.name === "LegacyUser")!), true);
		assert.equal(t.core.library.mcpAllowed(values.find((value) => value.name === "LegacyUser")!, true), false);
		assert.equal(t.core.library.mcpAllowed(entry(join(t.dir, "virtual-extension.ts"), "UnknownRuntime")), false, "runtime registrations without a real legacy config are not implicitly trusted");
	} finally { await t.cleanup(); }
});

test("T80 actual backup/stage/apply preserves revoked mixed-case MCP after relocation, including history", async () => {
	let source = await startTestCore(), target = await startTestCore();
	try {
		const proposed = await source.core.call("mcp.register", { server: form(), sourceUrl: "https://example.invalid/service" }) as { id: string }; await source.core.call("proposals.accept", { id: proposed.id });
		const key = source.core.library.mcpKey({ source: join(source.agentDir, "mcp.json"), name: "CodeHost" }); source.core.library.used("mcp", key, "confirmed-business-event");
		source.core.library.write("mcp", key, { trust: "untrusted", enabled: false, butterflyAllowed: false }); const before = source.core.db.get<any>("SELECT * FROM library_entries WHERE locator=?", key)!;
		const file = join(source.dir, "t80.dfbackup"); const exported = await job(source, await source.core.call("backup.export", { path: file, password: "T80-fixture-password" })); assert.equal(exported.status, "done", exported.error ?? "");
		const staged = await job(target, await target.core.call("backup.stage", { path: file, password: "T80-fixture-password" })); assert.equal(staged.status, "done", staged.error ?? "");
		const applied = await job(target, await target.core.call("backup.apply", {})); assert.equal(applied.status, "done", applied.error ?? ""); await new Promise((done) => setTimeout(done, 1500));
		const outcome = applyPendingRestore(target.core.paths); assert.equal(outcome?.ok, true, String(outcome?.error)); target = await startTestCore(target.dir);
		const servers = (await target.core.call("mcp.list", {}) as { servers: any[] }).servers, restored = servers.find((value) => value.name === "CodeHost")!;
		assert.equal(restored.trust, "untrusted"); assert.equal(restored.enabled, false); assert.equal(restored.sourceKind, "community"); assert.equal(restored.usageCount, 1);
		const nextKey = target.core.library.mcpKey({ source: join(target.agentDir, "mcp.json"), name: "CodeHost" }); const after = target.core.db.get<any>("SELECT * FROM library_entries WHERE locator=?", nextKey)!;
		for (const field of ["source_kind", "source_url", "trusted", "enabled", "butterfly_allowed", "fingerprint", "usage_count", "last_used_at"]) assert.equal(after[field], before[field], field);
		assert.equal(target.core.db.get<any>("SELECT locator FROM library_usage WHERE event_id='confirmed-business-event'")!.locator, nextKey);
	} finally { await source.cleanup(); await target.cleanup(); }
});

test("T80 actual configuration move preserves trusted grants and explicit disabled policy without changing service names", async () => {
	const t = await startTestCore(), data = join(t.dir, "move-data"); mkdirSync(data); const cores: ReturnType<typeof buildCore>[] = [];
	const construct = () => { const core = buildCore({ paths: corePaths(data), agentDir: defaultAgentDir(data), sessionDir: storageLocations(data).sessions, log: new Logger(), notifier: new RecordingNotifier() }); cores.push(core); return core; };
	try {
		const original = construct(); await original.call("mcp.save", { server: form() }); await original.call("mcp.save", { server: form("DisabledHost") });
		const firstKey = original.library.mcpKey({ source: join(original.agentDir, "mcp.json"), name: "CodeHost" }); original.library.write("mcp", firstKey, { butterflyAllowed: true }); original.library.used("mcp", firstKey, "move-history"); await original.call("mcp.setEnabled", { name: "DisabledHost", enabled: false });
		const target = join(t.dir, "moved-configuration"); requestMove(data, "configuration", target, original.agentDir, original.sessionDir, original.paths.dbFile, "df-t80-unused"); await original.shutdown();
		const record = await preparePendingMove(data); assert.ok(record); assert.ok(existsSync(join(target, "mcp.json")));
		const next = construct(); remapMovedDatabase(next, record); await next.start(); await validateMove(next, record);
		const servers = (await next.call("mcp.list", {}) as { servers: any[] }).servers;
		const enabled = servers.find((value) => value.name === "CodeHost")!, disabled = servers.find((value) => value.name === "DisabledHost")!;
		assert.equal(enabled.trust, "trusted"); assert.equal(enabled.enabled, true); assert.equal(enabled.butterflyAllowed, true); assert.equal(enabled.usageCount, 1); assert.equal(disabled.enabled, false);
		assert.equal(next.db.get<any>("SELECT locator FROM library_usage WHERE event_id='move-history'")!.locator, mcpIdentity(join(target, "mcp.json"), "CodeHost"));
	} finally { for (const core of cores) await core.shutdown(); await t.cleanup(); }
});
