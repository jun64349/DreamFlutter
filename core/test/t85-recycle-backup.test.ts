import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createBackup } from "../src/backup/export.ts";
import { stageBackup } from "../src/backup/restore.ts";
import { applyPendingRestore, writeSwitchRecord } from "../src/backup/switch.ts";
import { piSessionFolder } from "../src/backup/path-map.ts";
import { SessionIndex } from "../src/modules/session-index.ts";
import { MIGRATIONS } from "../src/schema.ts";
import { startTestCore, type TestCore } from "./harness.ts";

const cores: TestCore[] = [];
afterEach(async () => { for (const t of cores.splice(0).reverse()) await t.cleanup(); });
async function start() { const t = await startTestCore(); cores.push(t); return t; }
function session(t: TestCore, name: string, parent?: string) {
	const dir = piSessionFolder(t.sessionDir, t.workspace); mkdirSync(dir, { recursive: true });
	const path = join(dir, name + ".jsonl");
	writeFileSync(path, [
		{ type: "session", version: 3, id: name, cwd: t.workspace, timestamp: new Date().toISOString(), ...(parent ? { parentSession: parent } : {}) },
		{ type: "message", id: `${name}-u`, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "保留内容" } },
		...(parent ? [{ type: "custom", id: `${name}-side`, customType: "df.sideConversation", data: { sessionId: name, quote: "引用", quoteEntryId: null } }] : []),
	].map((e) => JSON.stringify(e)).join("\n") + "\n");
	return path;
}

it("T85 backs up live recycle content, restores across workspace paths without reviving it or extending deadlines, then restores its whole side batch", async () => {
	const source = await start(), target = await start();
	const parent = session(source, "parent"), child = session(source, "child", parent);
	await source.core.call("sessions.list", {}); await source.core.call("sessions.setPinned", { path: parent, pinned: true });
	const deleted = await source.core.call("sessions.delete", { path: parent }) as { batchId: string; expiresAt: number };
	const out = join(source.dir, "recycle.dfbackup");
	const backup = await createBackup({ paths: source.core.paths, agentDir: source.agentDir, sessionsDir: source.sessionDir, db: source.core.db.raw, appVersion: "0.7.0" }, { out, kind: "manual", credentials: "none", includeMaterials: false });
	assert.equal(backup.manifest.includes.sessions, 2);
	assert.ok(backup.manifest.files.filter((f) => f.path.includes(".recycle")).length === 2);
	const staged = await stageBackup(out, { paths: target.core.paths, agentDir: target.agentDir, sessionsDir: target.sessionDir, appVersion: "0.7.0" }, { parts: target.core.backupParts, workspaces: [{ from: source.workspace, to: target.workspace }] });
	writeSwitchRecord(target.core.paths, target.agentDir, staged, {});
	await target.core.shutdown(); assert.equal(applyPendingRestore(target.core.paths)?.ok, true);
	const next = await startTestCore(target.dir); cores.splice(cores.indexOf(target), 1, next);
	const rows = next.core.module(SessionIndex)!.recycle.list(); assert.equal(rows.length, 2);
	assert.ok(rows.every((r) => r.expires_at === deleted.expiresAt && r.phase === "stored" && existsSync(r.stored_path)));
	const parentPath = join(piSessionFolder(next.sessionDir, next.workspace), basename(parent));
	const childPath = join(piSessionFolder(next.sessionDir, next.workspace), basename(child));
	assert.ok(rows.some((r) => r.original_path === parentPath));
	assert.equal((await next.core.call("sessions.list", {}) as unknown[]).length, 0);
	await next.core.call("sessions.restore", { batchId: deleted.batchId });
	assert.ok(existsSync(parentPath) && existsSync(childPath));
	const header = JSON.parse(readFileSync(childPath, "utf8").split("\n")[0]!);
	assert.equal(header.parentSession, parentPath); assert.equal(header.cwd, next.workspace);
	assert.equal((await next.core.call("sessions.list", {}) as { pinned: boolean }[])[0]!.pinned, true);
});

it("T85 still upgrades and restores a schema-15 backup with no recycle metadata", async () => {
	const source = await start(), target = await start(); const legacy = session(source, "legacy");
	await source.core.shutdown();
	const db = new DatabaseSync(join(source.dir, "schema-15.db"));
	const out = join(source.dir, "legacy.dfbackup");
	try {
		for (const migration of MIGRATIONS.slice(0, 15)) db.exec(migration);
		db.exec("PRAGMA user_version = 15");
		db.prepare("INSERT INTO session_meta(path, cwd, session_id) VALUES(?, ?, 'legacy')").run(legacy, source.workspace);
		await createBackup({ paths: source.core.paths, agentDir: source.agentDir, sessionsDir: source.sessionDir, db, appVersion: "0.7.0" }, { out, kind: "manual", credentials: "none", includeMaterials: false });
	} finally { db.close(); }
	const staged = await stageBackup(out, { paths: target.core.paths, agentDir: target.agentDir, sessionsDir: target.sessionDir, appVersion: "0.7.0" }, { parts: target.core.backupParts });
	assert.equal(staged.manifest.dbVersion, 15); assert.equal(staged.sessions, 1);
	writeSwitchRecord(target.core.paths, target.agentDir, staged, {}); await target.core.shutdown(); assert.equal(applyPendingRestore(target.core.paths)?.ok, true);
	const next = await startTestCore(target.dir); cores.splice(cores.indexOf(target), 1, next);
	assert.equal(next.core.module(SessionIndex)!.recycle.list().length, 0); assert.equal((await next.core.call("sessions.list", {}) as unknown[]).length, 1);
});
