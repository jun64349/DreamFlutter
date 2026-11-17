// 0.13.1 install verification: a fresh 0.13 install writes platform default memories, built-in skill
// registrations and window/update files on its first start, so it never counted as fresh and a reinstall
// never offered the preserved data. Those first-start writes are recognised; anything the person did is not.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCore } from "../src/app.ts";
import { Core } from "../src/core.ts";
import { Db } from "../src/db.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths, defaultAgentDir } from "../src/paths.ts";
import { configureResourcePaths, initializeLocations, storageLocations } from "../src/storage/locations.ts";
import { registerUninstall } from "../src/uninstall/index.ts";
import { preservedReceipt } from "../src/uninstall/plan.ts";

async function firstStart(change?: (core: ReturnType<typeof buildCore>) => Promise<void> | void, retainedUpdates?: { phase: string; run?: boolean }) {
	const temp = mkdtempSync(join(tmpdir(), "df-v0131-fresh-"));
	const root = join(temp, "install"), current = join(root, "current"), data = join(root, "data"), retained = root + ".preserved-data";
	mkdirSync(join(current, "app"), { recursive: true });
	writeFileSync(join(current, "sq.version"), "<id>DreamFlutter</id>");
	writeFileSync(join(root, "Update.exe"), "");
	writeFileSync(join(current, "app", "dreamflutter_update.exe"), "");
	for (const dir of [data, retained]) {
		initializeLocations(dir);
		for (const path of Object.values(storageLocations(dir))) mkdirSync(path, { recursive: true });
		configureResourcePaths(dir, defaultAgentDir(dir));
	}
	const kept = new Db(corePaths(retained).dbFile);
	kept.run("INSERT INTO settings (key,value) VALUES (?,?)", "userName", JSON.stringify("保留的数据"));
	kept.close();
	writeFileSync(join(retained, preservedReceipt), '{"version":1}');
	if (retainedUpdates) {
		mkdirSync(join(retained, "updates", "history"), { recursive: true });
		writeFileSync(join(retained, "updates", "journal.json"), JSON.stringify({ id: "u1", phase: retainedUpdates.phase }));
		writeFileSync(join(retained, "updates", "check-cache.json"), "{}");
		writeFileSync(join(retained, "updates", "history", "u1.log"), "done");
		mkdirSync(join(retained, "updates", "runs", ...(retainedUpdates.run ? ["u1"] : [])), { recursive: true });
	}
	// What the installed app does on its first start, before the person touches anything.
	const first = buildCore({ paths: corePaths(data), agentDir: defaultAgentDir(data), sessionDir: storageLocations(data).sessions,
		piMigration: { automatic: false }, platformMemory: true, log: new Logger(), notifier: new RecordingNotifier() });
	await first.start?.();
	await new Promise((done) => setTimeout(done, 300));
	mkdirSync(join(data, "window"), { recursive: true });
	writeFileSync(join(data, "window", "prefs.json"), '{"flutter.textScale":1}');
	mkdirSync(join(data, "updates"), { recursive: true });
	writeFileSync(join(data, "updates", "check-cache.json"), '{"checkedAt":1}');
	await change?.(first);
	await first.shutdown();
	const paths = corePaths(data);
	const core = new Core({ paths, agentDir: defaultAgentDir(data), sessionDir: storageLocations(data).sessions, log: new Logger(paths.logFile), notifier: new RecordingNotifier() });
	registerUninstall(core, current);
	const client = core.addClient(() => {});
	const memories = core.db.get<{ n: number }>("SELECT count(*) n FROM memory_items")!.n;
	return { temp, retained, core, client, memories };
}

test("v0.13.1 a just-installed app (platform memories, built-in skills, window prefs) still offers the preserved data", async () => {
	const f = await firstStart();
	try {
		assert.ok(f.memories > 0, "the first start wrote the platform default memories");
		const info = await f.core.call("uninstall.preservedData", {}, f.client) as { candidates: { path: string }[] };
		assert.deepEqual(info.candidates.map((c) => c.path), [f.retained]);
	} finally { await f.core.shutdown(); rmSync(f.temp, { recursive: true, force: true }); }
});

test("v0.13.1 once the person changed something, the install is no longer fresh", async () => {
	for (const change of [
		(core: ReturnType<typeof buildCore>) => { core.db.run("UPDATE memory_items SET content='我改过的', version=version+1 WHERE rowid=(SELECT min(rowid) FROM memory_items)"); },
		(core: ReturnType<typeof buildCore>) => { core.settings.update({ userName: "新用户" }); },
	]) {
		const f = await firstStart(change);
		try {
			assert.deepEqual(await f.core.call("uninstall.preservedData", {}, f.client), { candidates: [] });
			await assert.rejects(f.core.call("uninstall.restorePreservedData", { path: f.retained }, f.client), { code: "conflict" });
		} finally { await f.core.shutdown(); rmSync(f.temp, { recursive: true, force: true }); }
	}
});

test("v0.13.1 data kept after an in-app update can be restored; an unfinished update still cannot", async () => {
	const done = await firstStart(undefined, { phase: "accepted" });
	try { assert.deepEqual(await done.core.call("uninstall.restorePreservedData", { path: done.retained }, done.client), { restarting: true }); }
	finally { await done.core.shutdown(); rmSync(done.temp, { recursive: true, force: true }); }
	for (const open of [{ phase: "applying" }, { phase: "accepted", run: true }]) {
		const f = await firstStart(undefined, open);
		try { await assert.rejects(f.core.call("uninstall.restorePreservedData", { path: f.retained }, f.client), { code: "bad_config" }); }
		finally { await f.core.shutdown(); rmSync(f.temp, { recursive: true, force: true }); }
	}
});
