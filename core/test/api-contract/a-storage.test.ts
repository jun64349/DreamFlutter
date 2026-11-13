import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Sandbox, SELF_TEST_SCRIPT } from "../../src/sandbox/sandbox.ts";
import { Db } from "../../src/db.ts";
import { writeArchive } from "../../src/backup/archive.ts";
import { UpdateModule, type UpdateOptions } from "../../src/update/module.ts";
import { expectKeys, expectRpcError, startContractHarness, type ContractHarness } from "./harness.ts";

const ok = { ok: true };
const jobFields = ["id", "kind", "status", "step", "error", "result", "startedAt"];
const historyFields = ["path", "kind", "createdAt", "size", "exists", "auto"];

async function backupJob(api: ContractHarness, method: string, params: Record<string, unknown> = {}) {
	const from = api.events.length;
	const started = await api.call<{ id: string; status: string }>(method, params);
	expectKeys(started, jobFields);
	assert.equal(started.status, "running");
	const finished = await api.waitForEvent("backup.job", event => {
		const job = event.job as Record<string, unknown>;
		return job.id === started.id && job.status !== "running";
	}, from);
	const changes = api.events.slice(from).filter(e => e.event === "backup.job");
	for (const event of changes) {
		expectKeys(event, ["event", "job"]);
		expectKeys(event.job, jobFields);
		assert.equal(event.job.id, started.id);
	}
	assert.ok(changes.length >= 2);
	assert.equal(changes.filter(e => (e.job as Record<string, unknown>).status !== "running").length, 1);
	expectKeys(finished.job, jobFields);
	assert.equal(finished.job.status, "done", JSON.stringify(finished.job));
	assert.deepEqual(await api.call("backup.job"), finished.job);
	return finished.job;
}

test("backup archive, history, staging and restore RPCs operate entirely in the fixture directory", async t => {
	const api = await startContractHarness(t);
	assert.equal(await api.call("backup.job"), null);
	assert.equal(await api.call("backup.restoreResult"), null);
	assert.deepEqual(await api.call("backup.ackResult"), ok);
	assert.deepEqual(await api.call("backup.cancel"), ok);
	assert.deepEqual(await api.call("backup.history"), []);
	expectKeys(await api.call("backup.overview"),
		["busy", "estimate", "estimateText", "materialsCount", "materialsWarning", "sandbox", "sandboxDiskBytes", "backupsDir", "autoBytes", "freeBytes", "job", "history"]);
	await expectRpcError(api.call("backup.export"), "bad_request");
	await expectRpcError(api.call("backup.export", { path: api.dir, includeKeys: true, password: "short" }), "bad_request");
	await expectRpcError(api.call("backup.inspect"), "bad_request");
	await expectRpcError(api.call("backup.inspect", { path: join(api.dir, "missing.dfbackup") }), "bad_backup");
	await expectRpcError(api.call("backup.stage"), "bad_request");
	await expectRpcError(api.call("backup.apply"), "not_staged");
	await expectRpcError(api.call("backup.undo"), "not_found");
	await expectRpcError(api.call("backup.delete", { path: join(api.dir, "missing.dfbackup") }), "not_found");

	const path = join(api.dir, "contract.dfbackup");
	await backupJob(api, "backup.export", { path, includeSandbox: false, includeMaterials: false });
	assert.ok(existsSync(path));
	const history = await api.call<unknown[]>("backup.history");
	assert.equal(history.length, 1);
	expectKeys(history[0], historyFields);
	assert.equal(history[0].path, path);
	const preview = await api.call("backup.inspect", { path });
	expectKeys(preview, ["appVersion", "dbVersion", "kind", "createdAt", "host", "user", "credentials", "needsPassword", "sameUser", "counts", "includes", "size", "paths", "replaces", "warnings"]);
	await backupJob(api, "backup.stage", { path });
	assert.deepEqual(await api.call("backup.discardStaged"), ok);
	await expectRpcError(api.call("backup.apply"), "not_staged");
	assert.deepEqual(await api.call("backup.delete", { path }), []);
	assert.ok(existsSync(path), "removing a manual history entry leaves its file");
	await backupJob(api, "backup.stage", { path });
	const from = api.events.length;
	await backupJob(api, "backup.apply");
	const restarting = await api.waitForEvent("backup.restarting", undefined, from);
	expectKeys(restarting, ["event"]);
	assert.equal(api.events.slice(from).filter(e => e.event === "backup.restarting").length, 1);
});

test("startup migration announces the isolated legacy and destination folders before restart", async t => {
	const legacyRoot = mkdtempSync(join(tmpdir(), "t132a-legacy-"));
	const legacy = { dataDir: join(legacyRoot, "data"), agentDir: join(legacyRoot, "agent") };
	mkdirSync(legacy.dataDir);
	mkdirSync(legacy.agentDir);
	new Db(join(legacy.dataDir, "core.db")).close();
	const api = await startContractHarness(t, { legacyData: legacy });
	const migrating = await api.waitForEvent("backup.migrating");
	assert.deepEqual(migrating, { event: "backup.migrating", from: legacy.dataDir, to: api.core.paths.dataDir });
	const restarting = await api.waitForEvent("backup.restarting");
	assert.equal(api.events.filter(e => e.event === "backup.migrating").length, 1);
	assert.ok(api.events.indexOf(migrating) < api.events.indexOf(restarting));
});

const sandboxFields = ["state", "step", "progress", "error", "online", "diskBytes", "distro", "mirror", "bundled"];

test("sandbox methods use a fake WSL runner including unregister failure and reset", async t => {
	let available = false, registered = false, canRemove = false;
	const commands: string[][] = [];
	const api = await startContractHarness(t, { sandbox: { distro: "T132A-Fake", wsl: async (args, options) => {
		commands.push(args);
		if (args[0] === "--status") return { code: available ? 0 : 1, stdout: "", stderr: "" };
		if (args[0] === "--list") return { code: 0, stdout: registered ? "T132A-Fake\n" : "", stderr: "" };
		if (args[0] === "--unregister") {
			if (!canRemove) return { code: 1, stdout: "", stderr: "mock refusal" };
			registered = false;
		}
		if (args[0] === "--import-in-place") registered = true;
		return { code: 0, stdout: options?.input === SELF_TEST_SCRIPT ? "PASS workspace\n" : "BOOT_OK", stderr: "" };
	} } });
	const dir = api.core.module(Sandbox)!.dir;
	assert.ok(dir.startsWith(api.dir));
	const initial = await api.call("sandbox.status");
	expectKeys(initial, sandboxFields);
	assert.equal(initial.state, "no-wsl");
	const start = api.events.length;
	expectKeys(await api.call("sandbox.provision"), sandboxFields);
	await api.waitForEvent("sandbox.changed", event => (event.status as Record<string, unknown>).state === "no-wsl", start);
	const online = await api.call("sandbox.setOnline", { online: true });
	expectKeys(online, sandboxFields);
	assert.equal(online.online, true);
	await expectRpcError(api.call("sandbox.reset"), "internal");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "clean.vhdx"), "synthetic fixture");
	await expectRpcError(api.call("sandbox.remove"), "unavailable");
	assert.ok(existsSync(join(dir, "clean.vhdx")));
	available = true;
	canRemove = true;
	expectKeys(await api.call("sandbox.remove"), sandboxFields);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "clean.vhdx"), "synthetic fixture");
	const resetFrom = api.events.length;
	const reset = await api.call("sandbox.reset");
	expectKeys(reset, sandboxFields);
	assert.equal(reset.state, "ready");
	const resetEvent = await api.waitForEvent("sandbox.changed", event => (event.status as Record<string, unknown>).state === "ready", resetFrom);
	expectKeys(resetEvent, ["event", "status"]);
	expectKeys(resetEvent.status, sandboxFields);
	const checked = await api.call("sandbox.selfTest");
	expectKeys(checked, ["items"]);
	assert.ok(Array.isArray(checked.items) && checked.items.length);
	assert.deepEqual(checked.items, [{ name: "workspace", passed: true, detail: null }]);
	const removed = await api.call("sandbox.remove");
	expectKeys(removed, sandboxFields);
	assert.equal(removed.state, "absent");
	assert.equal(existsSync(dir), false);
	assert.equal(commands.filter(args => args[0] === "--unregister" && args[1] === "T132A-Fake").length, 4);
});

test("sandbox.reset clears a previous provisioning error after successfully restoring the disk", async t => {
	let available = false, registered = false, importFails = true;
	const api = await startContractHarness(t, { sandbox: { distro: "T132A-Reset", wsl: async ([command]) => {
		if (command === "--status") return { code: available ? 0 : 1, stdout: "", stderr: "" };
		if (command === "--list") return { code: 0, stdout: registered ? "T132A-Reset" : "", stderr: "" };
		if (command === "--import-in-place") {
			if (importFails) return { code: 1, stdout: "", stderr: "fixture import failed" };
			registered = true;
		}
		return { code: 0, stdout: "", stderr: "" };
	} } });
	const at = api.events.length;
	await api.call("sandbox.provision");
	await api.waitForEvent("sandbox.changed", e => (e.status as { state: string; error: string | null }).state === "no-wsl"
		&& typeof (e.status as { error: unknown }).error === "string", at);
	available = true;
	const dir = api.core.module(Sandbox)!.dir;
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "clean.vhdx"), "synthetic fixture");
	await expectRpcError(api.call("sandbox.reset"), "internal");
	const failed = await api.call<{ state: string; error: string | null }>("sandbox.status");
	assert.equal(failed.state, "error");
	assert.ok(failed.error);
	importFails = false;
	const resetAt = api.events.length;
	const status = await api.call<{ state: string; error: string | null; step: string | null; progress: number | null }>("sandbox.reset");
	assert.deepEqual([status.state, status.error, status.step, status.progress], ["ready", null, null, null]);
	const event = await api.waitForEvent("sandbox.changed", undefined, resetAt);
	assert.deepEqual(event.status, status);
});

test("security audit and storage maintenance report exact wire fields", async t => {
	const api = await startContractHarness(t);
	const cwd = api.workspace, path = join(cwd, "fixture");
	assert.deepEqual(await api.call("security.exceptions", { cwd }), { paths: [] });
	await expectRpcError(api.call("security.addException", { cwd }), "internal");
	const change = api.events.length;
	assert.deepEqual(await api.call("security.addException", { cwd, path }), ok);
	assert.deepEqual(await api.call("security.exceptions", { cwd }), { paths: [path] });
	assert.deepEqual(await api.call("security.removeException", { cwd, path }), ok);
	assert.deepEqual(await api.call("security.exceptions", { cwd }), { paths: [] });
	const audit = await api.call<{ events: unknown[] }>("security.audit", { kind: "exception" });
	expectKeys(audit, ["events"]);
	assert.equal(audit.events.length, 1);
	expectKeys(audit.events[0], ["id", "time", "kind", "object", "decision", "reason", "policy", "requestId", "runId", "slotId"]);
	const output = await api.call("security.export");
	expectKeys(output, ["name", "text"]);
	assert.equal(output.name, "security-audit.jsonl");
	assert.match(String(output.text), /fixture/);
	assert.equal(api.events.slice(change).filter(e => e.event === "settings.changed").length, 2);
	const memory = ["databaseBytes", "space", "logicalBytes", "versions", "path"];
	const before = await api.call("storage.memory");
	expectKeys(before, memory);
	expectKeys(before.space, ["paused", "freeBytes", "minimumBytes", "reason"]);
	const locations = await api.call<{ rows: unknown[]; memory: unknown; artifacts: unknown[] }>("storage.locations");
	expectKeys(locations, ["rows", "artifacts", "memory", "lastMove", "note"]);
	assert.equal(locations.rows.length, 10);
	for (const row of locations.rows) expectKeys(row, ["id", "label", "path", "movable", "bytes", "layer"]);
	expectKeys(locations.memory, ["path", "moveKind", "logicalBytes", "versions"]);
	api.core.maintenance = "fixture";
	try {
		await expectRpcError(api.call("storage.compactMemory"), "busy");
		await expectRpcError(api.call("storage.move"), "busy");
	} finally { api.core.maintenance = undefined; }
	await expectRpcError(api.call("storage.move"), "bad_request");
	await api.call("settings.update", { memoryMinFreeBytes: Number.MAX_SAFE_INTEGER });
	await expectRpcError(api.call("storage.compactMemory"), "storage_paused");
	await api.call("settings.update", { memoryMinFreeBytes: 0 });
	expectKeys(await api.call("storage.compactMemory"), [...memory, "deleted", "backup"]);
	const at = api.events.length;
	expectKeys(await api.call("storage.move", { kind: "logs", target: join(api.dir, "moved-logs") }), ["id", "restarting", "restartRequired"]);
	assert.deepEqual(api.events.slice(at).filter(e => e.event === "storage.restarting"), [{ event: "storage.restarting" }]);
});

test("Git window routes return wire envelopes without committing", async t => {
	const api = await startContractHarness(t);
	for (const method of ["git.status", "git.diff", "git.prepareCommit", "git.commit"]) {
		const result = await api.call(method);
		expectKeys(result, ["ok", "code", "reason"]);
		assert.equal(result.code, "invalid_input");
	}
	const cwd = api.workspace;
	execFileSync("git", ["init", "--quiet", cwd]);
	writeFileSync(join(cwd, "fixture.txt"), "local temporary file");
	const status = await api.call("git.status", { cwd });
	expectKeys(status, ["ok", "available", "isRepository", "branch", "files", "conflicts", "dirty", "operation"], ["head", "root", "upstream", "ahead", "behind"]);
	assert.equal(status.isRepository, true);
	const diff = await api.call("git.diff", { cwd, paths: ["fixture.txt"] });
	expectKeys(diff, ["ok", "diff", "paths", "fingerprint", "head", "root"]);
	assert.equal(diff.ok, true);
	const preview = await api.call("git.prepareCommit", { cwd, paths: ["fixture.txt"] });
	expectKeys(preview, ["ok", "diff", "paths", "fingerprint", "head", "root", "suggestedMessage", "draftReason"]);
	const rejected = await api.call("git.commit", { cwd, paths: ["fixture.txt"], message: "Fixture", expectedFingerprint: "stale" });
	expectKeys(rejected, ["ok", "code", "reason"]);
	assert.deepEqual([rejected.ok, rejected.code], [false, "changed_since_prepare"]);
});

test("update checks and downloads use an in-memory transport and never install", async t => {
	const api = await startContractHarness(t);
	const module = api.core.module(UpdateModule)!;
	const { options } = module as unknown as { options: { fetch: typeof fetch } };
	const release = "99.0.0", platform = process.platform === "win32" ? "win" : process.platform;
	const packageName = "DreamFlutter-" + release + "-" + platform + "-" + process.arch + "-full.nupkg";
	const packageUrl = "https://github.com/jun64349/DreamFlutter/releases/download/v" + release + "/" + packageName;
	const payload = "synthetic update fixture";
	const digest = createHash("sha256").update(payload).digest("hex");
	const requests: string[] = [];
	options.fetch = async url => {
		requests.push(String(url));
		return String(url) === packageUrl ? new Response(payload) : Response.json({
			tag_name: "v" + release, body: "fixture", assets: [
				{ name: packageName, size: Buffer.byteLength(payload), browser_download_url: packageUrl, digest: "sha256:" + digest },
			],
		});
	};
	const statusKeys = ["state", "message", "checkedAt", "progress", "available", "downloaded", "signature", "application", "coreVersion",
		"piVersion", "nodeVersion", "platform", "arch", "canInstall", "canStartup", "autoCheckUpdates", "startOnLogin", "closeBehavior", "recovery"];
	expectKeys(await api.call("updates.status"), statusKeys);
	await expectRpcError(api.call("updates.download"), "internal");
	await expectRpcError(api.call("updates.install"), "internal");
	await expectRpcError(api.call("updates.uiReady"), "internal");
	await expectRpcError(api.call("updates.validateReady"), "waiting_window");
	(module as unknown as { readyUiPid: number }).readyUiPid = 12345;
	await expectRpcError(api.call("updates.validateReady"), "validation_failed");
	const at = api.events.length;
	const checked = await api.call("updates.check");
	expectKeys(checked, statusKeys);
	assert.equal(checked.state, "available");
	expectKeys(checked.available, ["version", "notes", "page", "size", "sha256"]);
	const downloaded = await api.call("updates.download");
	expectKeys(downloaded, statusKeys);
	assert.equal(downloaded.state, "downloaded");
	assert.equal(downloaded.canInstall, false);
	assert.deepEqual(await api.call("updates.cancel"), downloaded);
	assert.deepEqual(requests, ["https://api.github.com/repos/jun64349/DreamFlutter/releases/latest", packageUrl]);
	const pushed = api.events.slice(at).filter(e => e.event === "updates.changed");
	for (const event of pushed) { expectKeys(event, ["event", "status"]); expectKeys(event.status, statusKeys); }
	assert.deepEqual(pushed.map(e => (e.status as Record<string, unknown>).state), ["checking", "available", "downloading", "downloading", "downloaded"]);
	const diag = await api.call("updates.diagnostics");
	expectKeys(diag, ["path", "files"]);
	assert.ok(String(diag.path).startsWith(api.dir) && existsSync(String(diag.path)));
	expectKeys(await api.call("updates.licenses"), ["generated", "entries"]);
	expectKeys(await api.call("updates.licenseText", { id: "absent" }), ["text"]);
});

test("update preparation requests window closure and stops at a synthetic backup failure", async t => {
	const api = await startContractHarness(t);
	const root = join(api.dir, "install");
	mkdirSync(root);
	const packageFile = join(root, "fixture.nupkg");
	await writeArchive(packageFile, [], [{ name: "lib/app/fixture.txt", data: Buffer.from("synthetic package") }]);
	const bytes = readFileSync(packageFile);
	const digest = createHash("sha256").update(bytes).digest("hex");
	const module = api.core.module(UpdateModule)! as unknown as {
		options: UpdateOptions; installed: NonNullable<UpdateOptions["install"]>; native: NonNullable<UpdateOptions["nativeCall"]>;
	};
	const before = await api.call<{ application: { version: string } }>("updates.status");
	const current = before.application.version;
	const platform = process.platform === "win32" ? "win" : process.platform;
	const makeRelease = (version: string) => ({
		tag_name: "v" + version, body: "fixture", assets: [{
			name: "DreamFlutter-" + version + "-" + platform + "-" + process.arch + "-full.nupkg",
			size: bytes.length, browser_download_url: "https://github.com/jun64349/DreamFlutter/releases/download/v" + version + "/fixture.nupkg",
			digest: "sha256:" + digest,
		}],
	});
	module.installed = { root, current: root, helper: join(root, "fake.exe") };
	module.native = async (_helper, args) => {
		assert.deepEqual(args, ["processes", root]);
		return String(process.pid);
	};
	module.options.fetch = async input => {
		const url = new URL(String(input));
		if (url.hostname === "github.com") return new Response(new Uint8Array(bytes));
		assert.equal(url.hostname, "api.github.com");
		return Response.json(makeRelease(url.pathname.includes("/tags/") ? current : "99.0.0"));
	};
	let backups = 0;
	module.options.backup = async () => { backups++; throw new Error("fixture stops before any install"); };
	module.options.launchGuard = () => { assert.fail("fixture must never launch an updater"); };
	await api.call("updates.check");
	await api.call("updates.download");
	await expectRpcError(api.call("updates.install", { windowPid: process.pid }), "internal");
	await expectRpcError(api.call("updates.install", { windowPid: 0 }), "internal");
	const at = api.events.length;
	const preparing = await api.call("updates.install", { windowPid: 0, approveUnsigned: true });
	assert.equal((preparing as { state: string }).state, "preparing");
	const close = await api.waitForEvent("updates.closeWindow", undefined, at);
	assert.deepEqual(close, { event: "updates.closeWindow" });
	const stopped = await api.waitForEvent("updates.changed", e => (e.status as { state: string }).state === "prepare_failed", at);
	assert.equal(backups, 1);
	assert.ok(api.events.indexOf(close) < api.events.indexOf(stopped));
	assert.equal(api.events.slice(at).filter(e => e.event === "updates.closeWindow").length, 1);
});
