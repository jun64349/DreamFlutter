import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BackupModule, type Job } from "../src/backup/backup.ts";
import { Archive } from "../src/backup/archive.ts";
import { open, seal, WrongPassword } from "../src/backup/crypto.ts";
import { PathMap, piSessionFolder } from "../src/backup/path-map.ts";
import { applyPendingRestore, Killed, recordFile, resultFile } from "../src/backup/switch.ts";
import { writeZip } from "../src/cards/zip.ts";
import { SecretStore } from "../src/modules/secrets.ts";
import { SessionIndex } from "../src/modules/session-index.ts";
import { MIGRATIONS } from "../src/schema.ts";
import { startTestCore, type TestCore } from "./harness.ts";

/** v0.3.1 backup, migration and restore (docs/v0.3.1-backup-design.md §九). */

const PASSWORD = "迁移密码123";

async function job(t: TestCore, started: Job): Promise<Job> {
	return t.waitFor(() => {
		const j = (t.messages.filter((m) => m.event === "backup.job").map((m) => m.job as Job).filter((j) => j.id === started.id).pop());
		return j && j.status !== "running" ? j : undefined;
	}, 120_000);
}

async function exportBackup(t: TestCore, params: Record<string, unknown>): Promise<Job> {
	return job(t, (await t.core.call("backup.export", params)) as Job);
}

/** A machine with something of everything (as far as unit tests reach: no WSL). */
async function populate(t: TestCore): Promise<{ sessionFile: string; material: string; keyId: string }> {
	const core = t.core;
	await core.call("memory.add", { content: "喜欢简短的回答", kind: "preference", scope: "workspace", cwd: t.workspace });
	await core.call("tasks.create", { cwd: t.workspace, goal: "整理周报" });
	await core.call("schedules.save", { name: "检查", prompt: "检查一下", cwd: t.workspace, trigger: { type: "interval", everyMs: 3_600_000 } });
	// A session in Pi's own layout: a folder named after the workspace.
	const folder = piSessionFolder(t.sessionDir, t.workspace);
	mkdirSync(folder, { recursive: true });
	const sessionFile = join(folder, "2026-11-03T00-00-00-000Z_test.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-11-03T00:00:00.000Z", cwd: t.workspace })}\n` +
			`${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-11-03T00:00:01.000Z", message: { role: "user", content: "你好" } })}\n`,
	);
	await core.module(SessionIndex)!.refresh();
	await t.waitFor(() => core.db.get("SELECT 1 AS ok FROM session_meta WHERE path = ?", sessionFile));
	// 蝶君's material, a file on this machine.
	const material = join(t.workspace, "数据.csv");
	writeFileSync(material, "a,b\n1,2\n");
	await core.call("materials.add", { cwd: core.paths.butterflyDir, kind: "file", path: material });
	// A card package and Pi's settings.
	mkdirSync(join(core.paths.dataDir, "cards", "c1"), { recursive: true });
	writeFileSync(join(core.paths.dataDir, "cards", "c1", "card.json"), '{"title":"卡"}');
	writeFileSync(join(t.agentDir, "settings.json"), JSON.stringify({ hideThinkingBlock: true }));
	writeFileSync(join(t.agentDir, "trust.json"), JSON.stringify({ [t.workspace]: true }));
	// A gateway channel with a DPAPI-encrypted key.
	const keyId = "k1";
	const ref = await new SecretStore(core.paths.dataDir).put(`gateway-${keyId}`, "sk-test-1234");
	core.db.run("INSERT INTO gateway_channels(id, name, kind, api, base_url, created_at) VALUES('c1', '测试渠道', 'custom', 'openai-completions', 'http://x.invalid', 0)");
	core.db.run("INSERT INTO gateway_keys(id, channel_id, secret, created_at) VALUES(?, 'c1', ?, 0)", keyId, ref);
	return { sessionFile, material, keyId };
}

/** Restores [file] into [t] (as the window does: stage, apply), then restarts it as main.ts would. */
async function restore(t: TestCore, file: string, params: Record<string, unknown> = {}): Promise<{ t: TestCore; staged: Record<string, unknown> }> {
	const staged = await job(t, (await t.core.call("backup.stage", { path: file, ...params })) as Job);
	assert.equal(staged.status, "done", staged.error ?? "");
	const applied = await job(t, (await t.core.call("backup.apply", {})) as Job);
	assert.equal(applied.status, "done", applied.error ?? "");
	assert.ok(existsSync(recordFile(t.core.paths)), "a switch record waits for the restart");
	await new Promise((r) => setTimeout(r, 1500)); // the core quits on its own
	const outcome = applyPendingRestore(t.core.paths);
	assert.equal(outcome?.ok, true, String(outcome?.error));
	const next = await startTestCore(t.dir);
	return { t: next, staged: staged.result as Record<string, unknown> };
}

describe("backup", () => {
	const cores: TestCore[] = [];
	const start = async () => {
		const t = await startTestCore();
		cores.push(t);
		return t;
	};
	afterEach(async () => {
		for (const t of cores.splice(0).reverse()) await t.cleanup().catch(() => {});
	});

	it("every database table is claimed by a module's backup part", async () => {
		const t = await start();
		assert.deepEqual(t.core.module(BackupModule)!.unclaimedTables(), []);
	});

	it("maps paths at folder boundaries, case-insensitively, longest rule first", () => {
		const map = new PathMap([
			{ from: "C:\\Users\\old", to: "D:\\Users\\new" },
			{ from: "C:\\Users\\old\\proj", to: "E:\\proj" },
		]);
		assert.equal(map.map("c:\\users\\OLD\\proj\\a.txt"), "E:\\proj\\a.txt");
		assert.equal(map.map("C:\\Users\\old\\doc"), "D:\\Users\\new\\doc");
		assert.equal(map.map("C:\\Users\\older\\doc"), "C:\\Users\\older\\doc");
		assert.equal(map.mapKey("c:\\users\\old\\x"), "d:\\users\\new\\x");
		assert.deepEqual(map.mapJson({ files: ["C:\\Users\\old\\a"], n: 1 }), { files: ["D:\\Users\\new\\a"], n: 1 });
	});

	it("seals keys with the migration password; a wrong one fails", async () => {
		const box = await seal(Buffer.from("秘密"), PASSWORD);
		assert.equal((await open(box, PASSWORD)).toString(), "秘密");
		await assert.rejects(open(box, "wrong"), WrongPassword);
		await assert.rejects(open({ ...box, N: 2 ** 30 }, PASSWORD), /范围/);
	});

	it("round-trips everything to another machine, moving every path, and undoes the restore", { timeout: 300_000 }, async () => {
		const a = await start();
		const { sessionFile } = await populate(a);
		const out = join(a.dir, "out", "我的备份");
		const exported = await exportBackup(a, {
			path: out,
			includeKeys: true,
			password: PASSWORD,
			prefs: { workspace: a.workspace, recentWorkspaces: [a.workspace], themeMode: "dark" },
		});
		assert.equal(exported.status, "done", exported.error ?? "");
		const file = `${out}.dfbackup`;
		assert.ok(existsSync(file) && !existsSync(`${file}.partial`));
		assert.ok(((await a.core.call("backup.history", {})) as { path: string }[]).some((h) => h.path === file));

		// Machine B: other folders throughout (another user name, another drive layout).
		let b = await start();
		await b.core.call("memory.add", { content: "B 原来的记忆", kind: "preference", scope: "global" });
		const preview = (await b.core.call("backup.inspect", { path: file })) as { needsPassword: boolean; paths: { from: string; to: string; kind: string; exists: boolean }[]; counts: Record<string, number> };
		assert.equal(preview.needsPassword, true);
		const ws = preview.paths.find((p) => p.kind === "workspace" && p.from === a.workspace);
		assert.ok(ws, "the workspace is in the path map");

		const failed = await job(b, (await b.core.call("backup.stage", { path: file, password: "错的" })) as Job);
		assert.equal(failed.status, "failed");
		assert.match(failed.error!, /迁移密码不对/);

		const restored = await restore(b, file, { password: PASSWORD, workspaces: [{ from: a.workspace, to: b.workspace }] });
		cores.push(restored.t);
		b = restored.t;
		const db = b.core.db;
		// Counts and relations.
		assert.equal(db.all("SELECT * FROM memories").length, 1, "the backup replaced B's memories");
		assert.equal(db.get<{ cwd: string }>("SELECT cwd FROM memories")!.cwd, b.workspace);
		assert.equal(db.get<{ cwd: string; cwd_key: string }>("SELECT cwd, cwd_key FROM tasks")!.cwd, b.workspace);
		assert.equal(db.get<{ cwd_key: string }>("SELECT cwd_key FROM tasks")!.cwd_key, b.workspace.toLowerCase());
		assert.equal(db.get<{ status: string }>("SELECT status FROM schedules")!.status, "paused", "restored schedules wait for the user");
		// The session moved to the folder named after B's workspace, its header too.
		const moved = join(piSessionFolder(b.sessionDir, b.workspace), "2026-11-03T00-00-00-000Z_test.jsonl");
		assert.ok(existsSync(moved), "session in its new folder");
		assert.equal(JSON.parse(readFileSync(moved, "utf8").split("\n")[0]!).cwd, b.workspace);
		assert.ok(db.get("SELECT 1 AS ok FROM session_meta WHERE path = ?", moved), "the index points at it");
		assert.notEqual(moved, sessionFile);
		// The material's original is not on B: the copy from the package took its place.
		const material = db.get<{ path: string }>("SELECT path FROM materials")!.path;
		assert.ok(material.startsWith(b.core.paths.butterflyDir), material);
		assert.equal(readFileSync(material, "utf8"), "a,b\n1,2\n");
		// Files, Pi settings with paths, keys sealed for this user.
		assert.equal(readFileSync(join(b.core.paths.dataDir, "cards", "c1", "card.json"), "utf8"), '{"title":"卡"}');
		assert.deepEqual(JSON.parse(readFileSync(join(b.agentDir, "trust.json"), "utf8")), { [b.workspace]: true });
		const ref = db.get<{ secret: string }>("SELECT secret FROM gateway_keys")!.secret;
		assert.ok(ref.includes(b.core.paths.dataDir.replaceAll("\\", "/")), "the key reference points at B's secrets");
		assert.equal(await new SecretStore(b.core.paths.dataDir).get("gateway-k1"), "sk-test-1234");
		// The result for the window: preferences moved to B's folders, nothing missing.
		const result = (await b.core.call("backup.restoreResult", {})) as { ok: boolean; prefs: { workspace: string }; missingKeys: string[]; undoBackup: string };
		assert.equal(result.ok, true);
		assert.equal(result.prefs.workspace, b.workspace);
		assert.deepEqual(result.missingKeys, []);
		assert.ok(existsSync(result.undoBackup), "B's data was backed up before the switch");

		// Undo: back to B's own data.
		const undo = await job(b, (await b.core.call("backup.undo", {})) as Job);
		assert.equal(undo.status, "done", undo.error ?? "");
		await new Promise((r) => setTimeout(r, 1500));
		assert.equal(applyPendingRestore(b.core.paths)?.ok, true);
		b = await startTestCore(b.dir);
		cores.push(b);
		assert.deepEqual(b.core.db.all<{ content: string }>("SELECT content FROM memories").map((m) => m.content), ["B 原来的记忆"]);
	});

	it("without keys, lists the channels to fill in again", { timeout: 120_000 }, async () => {
		const a = await start();
		await populate(a);
		const out = join(a.dir, "plain.dfbackup");
		assert.equal((await exportBackup(a, { path: out })).status, "done");
		const box = await Archive.open(out);
		assert.ok(!box.entries.has("secrets.enc") && ![...box.entries.keys()].some((n) => n.includes("secrets/")), "no key in the package");
		box.close();
		const b = await start();
		const staged = await job(b, (await b.core.call("backup.stage", { path: out })) as Job);
		assert.equal(staged.status, "done", staged.error ?? "");
		assert.deepEqual((staged.result as { missingKeys: string[] }).missingKeys, ["模型渠道「测试渠道」"]);
		await b.core.call("backup.discardStaged", {});
	});

	it("refuses packages that are newer, broken or malicious, leaving the data alone", { timeout: 120_000 }, async () => {
		const a = await start();
		await a.core.call("memory.add", { content: "原样", kind: "preference", scope: "global" });
		const bad = async (name: string, entries: { name: string; data: Buffer }[]) => {
			const path = join(a.dir, name);
			writeFileSync(path, writeZip(entries));
			return path;
		};
		const manifest = (over: Record<string, unknown> = {}) =>
			Buffer.from(JSON.stringify({ format: "dreamflutter-backup", formatVersion: 1, appVersion: "0.3.0", dbVersion: MIGRATIONS.length, files: [], ...over }));
		const cases: [string, string, RegExp][] = [
			["escape", await bad("escape.dfbackup", [{ name: "manifest.json", data: manifest() }, { name: "../evil.txt", data: Buffer.from("x") }]), /不安全的路径/],
			["drive", await bad("drive.dfbackup", [{ name: "manifest.json", data: manifest() }, { name: "C:/evil.txt", data: Buffer.from("x") }]), /不安全的路径/],
			["dup", await bad("dup.dfbackup", [{ name: "manifest.json", data: manifest() }, { name: "data/a", data: Buffer.from("x") }, { name: "data/A", data: Buffer.from("y") }]), /重复/],
			["newer", await bad("newer.dfbackup", [{ name: "manifest.json", data: manifest({ appVersion: "9.0.0" }) }]), /更新的版本/],
			["old", await bad("old.dfbackup", [{ name: "manifest.json", data: manifest({ dbVersion: 7, appVersion: "0.2.0" }) }]), /v0\.3\.0/],
			["extra", await bad("extra.dfbackup", [{ name: "manifest.json", data: manifest() }, { name: "data/x", data: Buffer.from("x") }]), /清单之外/],
			["junk", await bad("junk.dfbackup", [{ name: "readme.txt", data: Buffer.from("x") }]), /DreamFlutter/],
		];
		for (const [label, path, error] of cases) {
			await assert.rejects(a.core.call("backup.inspect", { path }), error, label);
		}
		writeFileSync(join(a.dir, "notzip.dfbackup"), "not a zip");
		await assert.rejects(a.core.call("backup.inspect", { path: join(a.dir, "notzip.dfbackup") }), /不是有效的备份包/);

		// A real package with one file changed: staging fails on the checksum.
		const good = join(a.dir, "good.dfbackup");
		assert.equal((await exportBackup(a, { path: good })).status, "done");
		const box = await Archive.open(good);
		const entries: { name: string; data: Buffer }[] = [];
		for (const name of box.entries.keys()) entries.push({ name, data: await box.readBuffer(name).catch(() => Buffer.alloc(0)) });
		box.close();
		const target = entries.find((e) => e.name.startsWith("data/appdata/cards") || e.name === "data/appdata/core.db")!;
		if (target.name !== "data/appdata/core.db") target.data = Buffer.from(target.data.toString().replace(/./, "X"));
		else target.data[100] ^= 0xff;
		writeFileSync(join(a.dir, "tampered.dfbackup"), writeZip(entries));
		const staged = await job(a, (await a.core.call("backup.stage", { path: join(a.dir, "tampered.dfbackup") })) as Job);
		assert.equal(staged.status, "failed");
		assert.match(staged.error!, /校验值不对/);
		assert.ok(!existsSync(join(a.core.paths.dataDir, "restore-staging")), "nothing staged is left");
		assert.equal(a.core.db.all("SELECT * FROM memories").length, 1, "the live data is untouched");
	});

	it("refuses to export while a task runs, and leaves no package when cancelled", { timeout: 60_000 }, async () => {
		const a = await start();
		const original = a.core.busySlots.bind(a.core);
		a.core.busySlots = () => [{ info: () => ({ sessionName: "忙" }), cwd: a.workspace }] as never;
		const blocked = await exportBackup(a, { path: join(a.dir, "busy.dfbackup") });
		assert.equal(blocked.status, "failed");
		assert.match(blocked.error!, /正在运行/);
		a.core.busySlots = original;
		const started = (await a.core.call("backup.export", { path: join(a.dir, "cancel.dfbackup") })) as Job;
		await a.core.call("backup.cancel", {});
		const done = await job(a, started);
		assert.equal(done.status, "cancelled");
		assert.deepEqual(readdirSync(a.dir).filter((n) => n.startsWith("cancel")), [], "no package, no .partial");
		assert.equal(a.core.maintenance, undefined, "runs may start again");
	});

	it("a switch killed halfway completes on the next start; one that fails keeps the old data", { timeout: 300_000 }, async () => {
		const a = await start();
		await a.core.call("memory.add", { content: "来自备份", kind: "preference", scope: "global" });
		const file = join(a.dir, "a.dfbackup");
		assert.equal((await exportBackup(a, { path: file })).status, "done");

		const stageAndApply = async (t: TestCore) => {
			assert.equal((await job(t, (await t.core.call("backup.stage", { path: file })) as Job)).status, "done");
			assert.equal((await job(t, (await t.core.call("backup.apply", {})) as Job)).status, "done");
			await new Promise((r) => setTimeout(r, 1500));
		};
		const memories = (t: TestCore) => t.core.db.all<{ content: string }>("SELECT content FROM memories").map((m) => m.content);

		// Killed after two moves: the next start rolls back and switches again.
		let b = await start();
		await b.core.call("memory.add", { content: "B 自己的", kind: "preference", scope: "global" });
		await stageAndApply(b);
		assert.throws(() => applyPendingRestore(b.core.paths, { killAfter: 2 }), Killed);
		assert.equal(applyPendingRestore(b.core.paths)?.ok, true);
		b = await startTestCore(b.dir);
		cores.push(b);
		assert.deepEqual(memories(b), ["来自备份"]);

		// Fails after three moves: everything goes back, and the result says why.
		let c = await start();
		await c.core.call("memory.add", { content: "C 自己的", kind: "preference", scope: "global" });
		await stageAndApply(c);
		const outcome = applyPendingRestore(c.core.paths, { failAfter: 3 });
		assert.equal(outcome?.ok, false);
		assert.ok(!existsSync(recordFile(c.core.paths)));
		assert.equal(JSON.parse(readFileSync(resultFile(c.core.paths), "utf8")).ok, false);
		c = await startTestCore(c.dir);
		cores.push(c);
		assert.deepEqual(memories(c), ["C 自己的"]);
	});
});
