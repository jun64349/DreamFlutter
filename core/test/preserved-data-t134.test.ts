import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyPendingRestore } from "../src/backup/switch.ts";
import { Core } from "../src/core.ts";
import { Db } from "../src/db.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths, defaultAgentDir } from "../src/paths.ts";
import { Sandbox, type WslRunner } from "../src/sandbox/sandbox.ts";
import { configureResourcePaths, initializeLocations, storageLocations } from "../src/storage/locations.ts";
import { registerUninstall } from "../src/uninstall/index.ts";
import { preservedReceipt } from "../src/uninstall/plan.ts";

function fixture() {
	const temp = mkdtempSync(join(tmpdir(), "df-t134-"));
	const root = join(temp, "install");
	const current = join(root, "current");
	const data = join(root, "data");
	const retained = root + ".preserved-data";
	mkdirSync(join(current, "app"), { recursive: true });
	writeFileSync(join(current, "sq.version"), "<id>DreamFlutter</id>");
	writeFileSync(join(root, "Update.exe"), "");
	writeFileSync(join(current, "app", "dreamflutter_update.exe"), "");
	for (const dir of [data, retained]) {
		initializeLocations(dir);
		for (const path of Object.values(storageLocations(dir))) mkdirSync(path, { recursive: true });
		configureResourcePaths(dir, defaultAgentDir(dir));
	}
	const retainedDb = new Db(corePaths(retained).dbFile);
	retainedDb.run("INSERT INTO settings (key,value) VALUES (?,?)", "userName", JSON.stringify("测试恢复"));
	retainedDb.close();
	writeFileSync(join(retained, preservedReceipt), '{"version":1}');
	const paths = corePaths(data);
	const core = new Core({ paths, agentDir: defaultAgentDir(data), sessionDir: storageLocations(data).sessions,
		log: new Logger(paths.logFile), notifier: new RecordingNotifier() });
	registerUninstall(core, current);
	const client = core.addClient(() => {});
	return { temp, root, current, data, retained, paths, core, client };
}

test("queries retained data and restores a copy through the existing restart switch", async () => {
	const f = fixture();
	try {
		const info = await f.core.call("uninstall.preservedData", {}, f.client) as { candidates: Array<{ path: string; bytes: number; savedAt: number }> };
		assert.equal(info.candidates.length, 1);
		assert.equal(info.candidates[0]?.path, f.retained);
		assert.ok(info.candidates[0]!.bytes > 0 && info.candidates[0]!.savedAt > 0);
		const before = readFileSync(corePaths(f.retained).dbFile);
		assert.deepEqual(await f.core.call("uninstall.restorePreservedData", { path: f.retained }, f.client), { restarting: true });
		await f.core.shutdown();
		assert.equal(applyPendingRestore(f.paths)?.ok, true);
		assert.deepEqual(readFileSync(corePaths(f.retained).dbFile), before);
		const restored = new Db(corePaths(f.data).dbFile);
		try { assert.equal(restored.get<{ value: string }>("SELECT value FROM settings WHERE key='userName'")?.value, '"测试恢复"'); }
		finally { restored.close(); }
	} finally {
		await f.core.shutdown();
		rmSync(f.temp, { recursive: true, force: true });
	}
});

test("refuses a restore when the new installation already has data", async () => {
	const f = fixture();
	try {
		f.core.settings.update({ userName: "现有数据" });
		assert.deepEqual(await f.core.call("uninstall.preservedData", {}, f.client), { candidates: [] });
		await assert.rejects(f.core.call("uninstall.restorePreservedData", { path: f.retained }, f.client), { code: "conflict" });
		assert.equal(f.core.settings.get().userName, "现有数据");
	} finally {
		await f.core.shutdown();
		rmSync(f.temp, { recursive: true, force: true });
	}
});

test("sandbox.remove retains disk and reports an unsuccessful unregister", async () => {
	const f = fixture();
	const dir = join(f.data, "fake-sandbox");
	const disk = join(dir, "ext4.vhdx");
	mkdirSync(dir);
	writeFileSync(disk, "fake disk");
	const calls: string[][] = [];
	const wsl: WslRunner = async args => {
		calls.push(args);
		return { code: 8, stdout: "", stderr: "fixture unregister failure" };
	};
	try {
		const sandbox = new Sandbox(f.core, { dir, distro: "fixture-only", image: null, wsl });
		f.core.use(sandbox);
		await assert.rejects(f.core.call("sandbox.remove", {}, f.client), { code: "unavailable" });
		assert.deepEqual(calls, [["--unregister", "fixture-only"]]);
		assert.equal(readFileSync(disk, "utf8"), "fake disk");
		assert.match(readFileSync(f.paths.logFile, "utf8"), /fixture unregister failure/);
	} finally {
		await f.core.shutdown();
		rmSync(f.temp, { recursive: true, force: true });
	}
});
