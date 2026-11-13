import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { cleanInstallation, quarantine, type UninstallDeps } from "../src/uninstall/cleanup.ts";
import { keepMarker, planUninstall, type LegacyPaths } from "../src/uninstall/plan.ts";
import { MOVED_MARKER } from "../src/backup/backup.ts";
import { windowsDependencies } from "../src/uninstall/windows.ts";

const own = "fixture-sandbox-custom";
const foreign = "fixture-sandbox-custom-other";
const secret = "fixture-secret-never-logged";

function put(path: string, content = "") {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function fixture(t: TestContext, moved = true) {
	const temp = mkdtempSync(join(tmpdir(), "df-t131-"));
	t.after(() => rm(temp, { recursive: true, force: true }));
	const root = join(temp, "install"), data = join(root, "data");
	const external = join(temp, "moved");
	const sandbox = moved ? join(external, "sandbox") : join(data, "sandbox");
	const disk = join(sandbox, "disk", "ext4.vhdx");
	const legacy: LegacyPaths = { dataDir: join(temp, "roaming/DreamFlutter"), agentDir: join(temp, "pi/agent") };
	const otherDisk = join(temp, "unrelated/ext4.vhdx");
	const logRoot = join(temp, "logs");
	mkdirSync(logRoot);
	const registration = new Map([[own, disk], [foreign, otherDisk]]);
	const calls: string[] = [];
	const running = new Set(registration.keys());
	put(join(data, "configuration.json"), secret);
	put(join(sandbox, "distro.txt"), own);
	put(disk, "fake VHDX");
	put(join(sandbox, "clean.vhdx"), "fake clean copy");
	put(otherDisk);
	if (moved) {
		put(join(data, "storage-locations.json"), JSON.stringify({ version: 1, paths: {
			sandbox, database: join(external, "db"), logs: join(external, "logs"), sessions: join(external, "sessions"),
		} }));
		put(join(external, "db/core.db"), secret);
		put(join(external, "db/other.txt"), "unrelated");
		put(join(external, "logs/core.log"), secret);
		put(join(external, "sessions/session.jsonl"), "{}");
	}
	const deps: UninstallDeps = {
		legacy, logRoot, retryDelayMs: 1,
		async stopCore() { calls.push("core.stop"); },
		async registeredDisk(name) { return registration.get(name); },
		async wsl(args) {
			calls.push(args.join(" "));
			if (args[0] === "--terminate") running.delete(args[1]!);
			if (args[0] === "--unregister") {
				assert.equal(running.has(args[1]!), false);
				registration.delete(args[1]!);
			}
			return { code: 0, stdout: "", stderr: secret };
		},
	};
	return { temp, root, data, external, sandbox, disk, legacy, otherDisk, deps, registration, calls };
}

test("uninstall preview is read-only and matches cleanup, including relocated data", async t => {
	const f = fixture(t);
	const preview = planUninstall(f.root, f.legacy);
	assert.deepEqual(f.calls, []);
	for (const target of preview.remove) assert.ok(existsSync(target.path), target.path);
	const removed: string[] = [];
	const result = await cleanInstallation(f.root, {
		...f.deps,
		async remove(path, tree) { removed.push(path); await rm(path, { recursive: tree, force: true }); },
	});
	assert.equal(result.ok, true);
	assert.deepEqual(result.plan, preview);
	assert.deepEqual(new Set(removed), new Set(preview.remove.map(target => target.path)));
	assert.deepEqual(f.calls, ["core.stop", "--terminate " + own, "--unregister " + own]);
	assert.equal(f.registration.has(own), false);
	assert.equal(f.registration.has(foreign), true);
	assert.ok(existsSync(f.otherDisk));
	assert.ok(existsSync(join(f.external, "db/other.txt")));
	for (const target of preview.remove) assert.equal(existsSync(target.path), false, target.path);
	const log = readFileSync(result.logPath, "utf8");
	assert.doesNotMatch(log, new RegExp(secret));
	assert.match(log, /sandbox.unregister/);
	assert.match(log, /"step":"complete","status":"ok"/);
});

test("a keep marker moves data out of Velopack's root and still unregisters the sandbox", async t => {
	const f = fixture(t, false);
	put(join(f.data, keepMarker), "1\n");
	const plan = planUninstall(f.root, f.legacy);
	assert.equal(plan.preserveTo, f.root + ".preserved-data");
	const result = await cleanInstallation(f.root, f.deps);
	assert.equal(result.ok, true);
	// Simulate Velopack removing the complete app folder.
	await rm(f.root, { recursive: true });
	assert.equal(readFileSync(join(plan.preserveTo!, "configuration.json"), "utf8"), secret);
	assert.equal(existsSync(join(plan.preserveTo!, keepMarker)), false);
	assert.equal(existsSync(join(plan.preserveTo!, "sandbox")), false);
	assert.deepEqual(f.calls, ["core.stop", "--terminate " + own, "--unregister " + own]);
});

test("an occupied VHDX is retried, left in place, and reported without raw failures", async t => {
	const f = fixture(t, false);
	let attempts = 0;
	const result = await cleanInstallation(f.root, {
		...f.deps,
		async remove(path, tree) {
			if (path === f.disk) { attempts++; throw new Error(secret); }
			await rm(path, { recursive: tree, force: true });
		},
	});
	assert.equal(attempts, 3);
	assert.equal(result.ok, false);
	assert.ok(result.remaining.includes(f.disk));
	assert.ok(existsSync(f.disk));
	assert.ok(existsSync(f.data));
	assert.doesNotMatch(readFileSync(result.logPath, "utf8"), new RegExp(secret));
});

test("failed unregister and mismatched registrations never trigger disk deletion", async t => {
	for (const mismatch of [false, true]) {
		const f = fixture(t);
		if (mismatch) f.registration.set(own, f.otherDisk);
		const result = await cleanInstallation(f.root, {
			...f.deps,
			async wsl(args, options) {
				if (args[0] === "--unregister") return { code: 1, stdout: secret, stderr: secret };
				return f.deps.wsl(args, options);
			},
		});
		assert.equal(result.ok, false);
		assert.ok(existsSync(f.disk));
		assert.ok(existsSync(f.otherDisk));
		assert.doesNotMatch(readFileSync(result.logPath, "utf8"), new RegExp(secret));
		if (mismatch) assert.deepEqual(f.calls, ["core.stop"]);
	}
});

test("missing distro record, linked paths and root targets cannot lead to guessed deletion", async t => {
	const f = fixture(t);
	await rm(join(f.sandbox, "distro.txt"));
	const plan = planUninstall(f.root, f.legacy);
	assert.equal(plan.distro, undefined);
	assert.equal(plan.review[0]?.reason, "distro_ownership_unconfirmed");
	const result = await cleanInstallation(f.root, f.deps);
	assert.equal(result.ok, false);
	assert.deepEqual(f.calls, ["core.stop"]);
	assert.ok(existsSync(f.disk));
	const link = join(f.temp, "linked");
	symlinkSync(dirname(f.otherDisk), link, process.platform === "win32" ? "junction" : "dir");
	put(join(f.data, "storage-locations.json"), JSON.stringify({ version: 1, paths: { sandbox: link } }));
	assert.throws(() => planUninstall(f.root, f.legacy), /linked_path/);
	put(join(f.data, "storage-locations.json"), JSON.stringify({ version: 1, paths: { sandbox: dirname(f.root) } }));
	assert.throws(() => planUninstall(f.root, f.legacy), /overlapping_sandbox_path/);
});

test("legacy cleanup needs matching migration markers and only removes referenced shared Pi sessions", async t => {
	const f = fixture(t);
	const df = join(f.legacy.agentDir, "sessions/project/df.jsonl");
	const other = join(f.legacy.agentDir, "sessions/project/another.jsonl");
	put(df, "{}");
	put(other, "{}");
	put(join(f.legacy.agentDir, "auth.json"), secret);
	mkdirSync(f.legacy.dataDir, { recursive: true });
	const db = new DatabaseSync(join(f.legacy.dataDir, "core.db"));
	db.exec("CREATE TABLE runs(session_file TEXT)");
	db.prepare("INSERT INTO runs VALUES (?)").run(df);
	db.close();
	put(join(f.data, "migration.json"), JSON.stringify({ state: "done", from: f.legacy }));
	put(join(f.legacy.dataDir, MOVED_MARKER), "moved\n" + join(f.temp, "different-install", "data") + "\n");
	assert.equal(planUninstall(f.root, f.legacy).remove.some(target => target.kind.startsWith("legacy")), false);
	put(join(f.legacy.dataDir, MOVED_MARKER), "moved\n" + f.data + "\n");
	const result = await cleanInstallation(f.root, f.deps);
	assert.equal(result.ok, true);
	assert.equal(existsSync(f.legacy.dataDir), false);
	assert.equal(existsSync(df), false);
	assert.ok(existsSync(other));
	assert.ok(existsSync(join(f.legacy.agentDir, "auth.json")));
});

test("bulk quarantine under the install root survives the package directory removal", async t => {
	const f = fixture(t, false);
	const dir = quarantine(f.data, true, f.root)!;
	assert.equal(existsSync(f.data), false);
	await rm(f.root, { recursive: true });
	assert.ok(existsSync(join(dir.path, "configuration.json")));
});

test("the Windows bulk worker deletes quarantined trees without following a junction", {
	skip: process.platform !== "win32",
}, async t => {
	const f = fixture(t, false);
	const log = join(f.temp, "logs", "worker.jsonl");
	const { deps, finish } = windowsDependencies(f.root, f.legacy, log, true);
	symlinkSync(dirname(f.otherDisk), join(f.data, "junction"), "junction");
	assert.equal(await deps.remove!(f.data, true), "scheduled");
	await rm(f.root, { recursive: true });
	await finish();
	const entries = readFileSync(log, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
	assert.deepEqual(entries.map(entry => entry.status), ["scheduled", "ok"]);
	assert.equal(existsSync(entries[0].path), false);
	assert.ok(existsSync(f.otherDisk));
});

test("packaging selects the registered hook and includes its runtime without changing the main executable", () => {
	const read = (path: string) => readFileSync(new URL("../../" + path, import.meta.url), "utf8");
	const pkg = read("scripts/package-windows.ps1");
	const native = read("app/windows/runner/update_bridge.cpp");
	assert.match(pkg, /foreach \(\$item in "src", "assets", "package.json", "package-lock.json"\)/);
	assert.match(pkg, /'runtime\/node.exe', 'app\/velopack_libc.dll', 'core\/src\/uninstall\/hook.ts'/);
	assert.match(pkg, /--mainExe 'app\/dreamflutter.exe'/);
	assert.match(native, /\.SetAutoApplyOnStartup\(false\)\s*\.OnBeforeUninstall\(BeforeDreamFlutterUninstall\)\.Run\(\)/);
	assert.match(native, /WaitForSingleObject\(process.hProcess, 25000\)/);
	assert.match(read("core/src/uninstall/hook.ts"), /windowsDependencies/);
});

