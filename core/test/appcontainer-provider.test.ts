import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readTool, writeTool } from "../src/agent/fs-tools.ts";
import { PythonKernel } from "../src/agent/python-kernel.ts";
import { HarnessState, resolveSandboxEnv } from "../src/agent/state.ts";
import { Core } from "../src/core.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths, defaultAgentDir } from "../src/paths.ts";
import { WindowsAppContainerSandbox } from "../src/sandbox/appcontainer-module.ts";
import { appContainerFileAccess } from "../src/sandbox/appcontainer-fs.ts";
import { retireNativeProfiles, retireGitWorkspace } from "../src/uninstall/windows.ts";
import { cleanInstallation, type UninstallDeps } from "../src/uninstall/cleanup.ts";
import { keepMarker, planUninstall, preservedReceipt } from "../src/uninstall/plan.ts";
import { gitWorkspaceRoot, LOCAL_NATIVE_FLAGS, nativePlacementsFile, ownsGitWorkspace, readNativePlacements, saveNativePlacements, type GitWorkspacePlacement } from "../src/sandbox/appcontainer-placements.ts";
import { createBackup } from "../src/backup/export.ts";
import { stageBackup } from "../src/backup/restore.ts";
import { Db } from "../src/db.ts";
import { collectGit } from "../src/git/process.ts";
import { bundledPython } from "../src/agent/toolchain.ts";
import { ButterflyModule } from "../src/modules/butterfly.ts";
import { TasksModule } from "../src/modules/tasks.ts";
import type { ChatManifest } from "../src/modules/goals/chat-workflow.ts";
import { StorageModule } from "../src/storage/storage.ts";
import { storageLocations } from "../src/storage/locations.ts";
import { moveResultFile, pendingMoveFile, preparePendingMove, remapMovedDatabase, rollbackMove, validateMove, type MoveHooks } from "../src/storage/move.ts";
import { appContainerProvisioned, appContainerSandboxEnv, provisionAppContainer, removeAppContainerProfile, type AppContainerConfig } from "../src/sandbox/appcontainer.ts";

const fixtureNode = process.env.DREAMFLUTTER_APPCONTAINER_TEST_NODE;
const fixturePackage = process.env.DREAMFLUTTER_APPCONTAINER_TEST_PACKAGE;
const exec = promisify(execFile);

async function builtRunner(temp: string): Promise<string> {
	const bridgePath = join(temp, "appcontainer-runner.exe");
	const powershell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const build = fileURLToPath(new URL("../../tools/appcontainer-runner/build.ps1", import.meta.url));
	await exec(powershell, ["-NoProfile", "-NonInteractive", "-File", build, "-OutputPath", bridgePath], { windowsHide: true });
	return bridgePath;
}

function packagedTools(): Exclude<AppContainerConfig["toolsSource"], string> {
	const python = bundledPython(join(fixturePackage!, "core", "python"));
	assert(python, "packaged Python required");
	const bin = join(fixturePackage!, "core", "bin");
	return { node: fixtureNode!, python: dirname(python), uv: join(bin, "uv.exe"), rg: join(bin, "rg.exe"), fd: join(bin, "fd.exe"), git: join(bin, "git") };
}

test("Windows AppContainer provider retains old workspace while restoring an archive into a new profile", {
	skip: !fixtureNode || !fixturePackage || process.platform !== "win32",
	timeout: 180_000,
}, async () => {
	const temp = await mkdtemp(join(tmpdir(), "df-appcontainer-provider-"));
	const data = join(temp, "data");
	let core: Core | undefined;
	try {
		const bridgePath = await builtRunner(temp);
		core = new Core({ paths: corePaths(data), agentDir: defaultAgentDir(data), log: new Logger(), notifier: new RecordingNotifier() });
		const oldDiskDir = join(storageLocations(data).sandbox, "disk");
		const oldDisk = join(oldDiskDir, "ext4.vhdx");
		await mkdir(oldDiskDir, { recursive: true });
		await writeFile(oldDisk, "1.0 private disk fixture");
		const native = new WindowsAppContainerSandbox(core, {
			bridgePath, toolsSource: packagedTools(),
		});
		core.use(native);
		const tasks = new TasksModule(core);
		core.use(tasks);
		const butterfly = new ButterflyModule(core, tasks);
		core.use(butterfly);
		await core.start();
		assert.equal(native.status().state, "absent");
		assert.equal(native.status().legacyDisk, oldDisk);
		assert.equal(core.sandboxProvider?.(), undefined);
		await assert.rejects(core.call("sandbox.setOnline", { online: true }), { code: "conflict" });
		core.settings.update({ sandboxOnline: true });
		await native.prepare();
		const first = core.sandboxProvider?.();
		assert(first?.appContainer && first.workspaceDir);
		assert.equal(first.kind, "appcontainer");
		assert.equal(first.online(), false);
		const files = appContainerFileAccess(first.appContainer);
		const state = new HarnessState(first.workspaceDir, resolveSandboxEnv(first));
		const running = state.env.spawn("node", ["-e", "console.log('running'); setInterval(() => {}, 1000)"], state.cwd);
		const stopped = once(running, "close");
		running.stderr!.resume();
		await once(running.stdout!, "data");
		await core.call("sandbox.setOnline", { online: true });
		await stopped;
		assert.equal(first.online(), true);
		await core.call("sandbox.setOnline", { online: false });
		assert.equal(first.online(), false);
		await writeTool(state).execute("test", { file_path: "outbox/中文.txt", content: "归档校验\n" }, undefined, undefined, null as never);
		const read = await readTool(state).execute("test", { file_path: "outbox/中文.txt" }, undefined, undefined, null as never);
		assert.match(JSON.stringify(read), /归档校验/);
		assert.equal((await files.listFiles("outbox", 20))[0]?.name, "中文.txt");
		const delivery = (await butterfly.outbox())[0];
		assert(delivery?.path && !delivery.path.startsWith(first.workspaceDir));
		assert.equal(await readFile(delivery.path, "utf8"), "归档校验\n");

		const attachment = join(temp, "本次合成附件");
		await mkdir(attachment);
		await writeFile(join(attachment, "样本.txt"), "附件校验\n");
		const [imported] = await butterfly.importPaths([attachment]);
		assert.equal(imported, "/workspace/inbox/本次合成附件");
		const goalId = "g_0123456789abcdef";
		let manifest: ChatManifest | null = null;
		const input = { text: "合成任务", attachments: [{ path: imported!, kind: "folder" as const }], materials: ["合成文本"] };
		const prepared = await butterfly.prepareChatInputs(goalId, input, null, (value) => { manifest = value; }, () => {});
		assert.equal(prepared.length, 2);
		assert.equal((await files.read(prepared[0] + "/样本.txt")).data.toString(), "附件校验\n");
		assert.equal((await files.read(prepared[1]!)).data.toString(), "合成文本");
		assert.deepEqual(await butterfly.prepareChatInputs(goalId, input, manifest, () => assert.fail("re-published"), () => {}), prepared);
		await butterfly.discardChatInputs(goalId, manifest, true);
		assert.equal(await files.stat(prepared[0]!), null);
		assert.equal((await files.read(imported + "/样本.txt")).data.toString(), "附件校验\n");

		const kernel = new PythonKernel(first);
		try {
			const options = { folder: null, record: () => {} };
			const initial = await kernel.run({ code: "value = 41\nvalue", cwd: state.cwd, folder: null }, options, {});
			assert.equal(initial.status, "completed", initial.text);
			const follow = await kernel.run({ code: "value + 1", cwd: state.cwd, folder: null }, options, {});
			assert.equal(follow.status, "completed", follow.text);
			assert.match(follow.text, /42/);
		} finally { await kernel.close(); }

		const archive = join(temp, "workspace.tar.gz");
		assert.equal(await native.archiveWorkspace(archive), true);
		const pending = join(data, "sandbox", "pending-restore.tar.gz");
		await mkdir(dirname(pending), { recursive: true });
		await copyFile(archive, pending);
		assert.equal(await native.restorePending(), true);
		const restored = core.sandboxProvider?.();
		assert(restored?.appContainer && restored.workspaceDir);
		assert.notEqual(restored.workspaceDir, first.workspaceDir);
		assert.equal(native.status().retainedWorkspaceDir, first.workspaceDir);
		assert.equal((await appContainerFileAccess(restored.appContainer).read("outbox/中文.txt")).data.toString(), "归档校验\n");
		assert.equal(await readFile(join(first.workspaceDir, "outbox", "中文.txt"), "utf8"), "归档校验\n");
		await assert.rejects(readFile(pending), { code: "ENOENT" });
		await assert.rejects(files.read("outbox/中文.txt"), { code: "sandbox_absent" });
		const legacy = join(temp, "legacy-export");
		await mkdir(join(legacy, "workspace", "outbox"), { recursive: true });
		await mkdir(join(legacy, "home", "agent"), { recursive: true });
		await writeFile(join(legacy, "workspace", "outbox", "旧结果.txt"), "旧结果");
		await writeFile(join(legacy, "home", "agent", "notes.md"), "旧笔记");
		// V1.0 archives both Linux roots in one tarball. Use the same layout without a registered distro.
		const python = bundledPython(join(fixturePackage!, "core", "python"));
		assert.ok(python);
		await exec(python, ["-I", "-c", [
			"import sys, tarfile",
			"with tarfile.open(sys.argv[1], 'w:gz', format=tarfile.GNU_FORMAT) as tar:",
			"    for name in ('workspace', 'home/agent'): tar.add(name, arcname=name)",
		].join("\n"), pending], { cwd: legacy, windowsHide: true });
		assert.equal(await native.restorePending(), true);
		const migrated = core.sandboxProvider?.();
		assert(migrated?.appContainer);
		const importedFiles = appContainerFileAccess(migrated.appContainer);
		assert.equal((await importedFiles.read("outbox/旧结果.txt")).data.toString(), "旧结果");
		assert.equal((await importedFiles.read("home/notes.md")).data.toString(), "旧笔记");
		await core.shutdown();
		core = undefined;
		await retireNativeProfiles(storageLocations(data).sandbox, bridgePath);
		assert.equal(await appContainerProvisioned(restored.appContainer), false);
		assert.equal(await appContainerProvisioned(migrated.appContainer), false);
		assert.equal(await readFile(oldDisk, "utf8"), "1.0 private disk fixture");
	} finally {
		try {
			if (core?.sandboxProvider?.()) await core.call("sandbox.remove", {});
			await core?.shutdown();
		} finally { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
	}
});

test("storage.move migrates a real Windows workspace and revokes a rejected target profile on rollback", {
	skip: !fixtureNode || !fixturePackage || process.platform !== "win32",
	timeout: 240_000,
}, async () => {
	const temp = await mkdtemp(join(tmpdir(), "df-appcontainer-storage-move-"));
	const data = join(temp, "data");
	const target = join(temp, "relocated-workspace");
	const rejected = join(temp, "rejected-workspace");
	const activeCores: Core[] = [];
	const profiles: AppContainerConfig[] = [];
	try {
		const bridgePath = await builtRunner(temp);
		const toolsSource = packagedTools();
		const hooks: MoveHooks = { appContainerBridgePath: bridgePath, wsl: async () => assert.fail("native move reached WSL") };
		function createCore() {
			const core = new Core({ paths: corePaths(data), agentDir: defaultAgentDir(data), log: new Logger(), notifier: new RecordingNotifier() });
			activeCores.push(core);
			core.db.run("CREATE TABLE IF NOT EXISTS move_fixture (path TEXT NOT NULL)");
			core.declareBackup({ id: "move-fixture", title: "迁移测试样本", tables: ["move_fixture"], paths: { move_fixture: { path: "path" } } });
			const provider = new WindowsAppContainerSandbox(core, { bridgePath, toolsSource });
			core.use(provider);
			core.use(new StorageModule(core));
			return { core, provider };
		}
		function rememberProfile(core: Core) {
			const active = core.sandboxProvider?.();
			assert(active?.appContainer && active.workspaceDir);
			profiles.push(active.appContainer);
			return { config: active.appContainer, directory: active.workspaceDir, online: active.online() };
		}
		async function request(core: Core, destination: string) {
			const closed = new Promise<void>((resolve) => core.onShutdown(resolve));
			const reply = await core.call("storage.move", { kind: "sandbox", target: destination }) as { id: string; restartRequired: boolean };
			assert.equal(reply.restartRequired, true);
			await closed;
			const record = await preparePendingMove(data, hooks);
			assert(record?.nativeWorkspace?.archive);
			assert.equal(record.id, reply.id);
			return record;
		}

		const first = createCore();
		await first.core.start();
		await first.provider.prepare();
		await first.core.call("sandbox.setOnline", { online: true });
		const source = rememberProfile(first.core);
		const files = appContainerFileAccess(source.config);
		const artifact = "outbox/迁移校验.txt";
		await files.write(artifact, "保留工作区内容\r\n", null);
		await files.write("home/记录.txt", "保留原家目录", null);
		first.core.db.run("INSERT INTO move_fixture (path) VALUES (?)", join(source.directory, artifact));
		const legacyDisk = join(storageLocations(data).sandbox, "disk", "ext4.vhdx");
		await mkdir(dirname(legacyDisk), { recursive: true });
		await writeFile(legacyDisk, "synthetic legacy disk marker");

		const occupied = join(temp, "occupied");
		await mkdir(occupied);
		await writeFile(join(occupied, "sentinel.txt"), "leave this file alone");
		await assert.rejects(first.core.call("storage.move", { kind: "sandbox", target: occupied }), /目标目录已存在/);
		assert.equal(first.core.maintenance, undefined);
		await assert.rejects(readFile(pendingMoveFile(data)), { code: "ENOENT" });
		assert.equal(await readFile(join(occupied, "sentinel.txt"), "utf8"), "leave this file alone");

		const record = await request(first.core, target);
		const second = createCore();
		remapMovedDatabase(second.core, record);
		await second.core.start();
		assert.equal(second.core.sandboxProvider?.(), undefined);
		await validateMove(second.core, record, hooks);
		const moved = rememberProfile(second.core);
		assert.notEqual(moved.config.profileId, source.config.profileId);
		assert.equal(moved.online, true);
		assert.equal(storageLocations(data).sandbox, target);
		assert.equal((await appContainerFileAccess(moved.config).read(artifact)).data.toString(), "保留工作区内容\r\n");
		assert.equal((await appContainerFileAccess(moved.config).read("home/记录.txt")).data.toString(), "保留原家目录");
		assert.equal(second.core.db.get<{ path: string }>("SELECT path FROM move_fixture")?.path, join(moved.directory, artifact));
		assert.equal(await readFile(join(source.directory, artifact), "utf8"), "保留工作区内容\r\n");
		assert.equal(await readFile(legacyDisk, "utf8"), "synthetic legacy disk marker");
		assert.equal(JSON.parse(await readFile(moveResultFile(data), "utf8")).ok, true);
		await assert.rejects(readFile(pendingMoveFile(data)), { code: "ENOENT" });

		const toReject = await request(second.core, rejected);
		const candidate = createCore();
		remapMovedDatabase(candidate.core, toReject);
		await candidate.core.start();
		const rpc = candidate.core.call.bind(candidate.core);
		candidate.core.call = (method, params, client) => method === "sandbox.selfTest"
			? Promise.resolve({ items: [{ name: "test-rejection", passed: false }] })
			: rpc(method, params, client);
		await assert.rejects(validateMove(candidate.core, toReject, hooks), /新工作区读写自检失败/);
		const failed = rememberProfile(candidate.core);
		assert.notEqual(failed.config.profileId, moved.config.profileId);
		assert.equal((await appContainerFileAccess(failed.config).read(artifact)).data.toString(), "保留工作区内容\r\n");
		await candidate.core.shutdown();
		await rollbackMove(data, toReject, "模拟自检拒绝", hooks);
		assert.equal(storageLocations(data).sandbox, target);
		await assert.rejects(readFile(pendingMoveFile(data)), { code: "ENOENT" });
		await assert.rejects(readFile(join(rejected, ".dreamflutter-storage-owner")), { code: "ENOENT" });
		assert.equal(JSON.parse(await readFile(moveResultFile(data), "utf8")).ok, false);

		// The name can only be created again if rollback actually deleted the Windows registration.
		const probeDir = join(temp, "profile-reuse-check");
		const probeTools = join(temp, "probe-tools");
		await mkdir(probeDir);
		await mkdir(probeTools);
		await copyFile(fixtureNode!, join(probeTools, "node.exe"));
		const probe = { ...failed.config, dataDir: probeDir, toolsSource: probeTools };
		await provisionAppContainer(probe);
		profiles.push(probe);

		const recovered = createCore();
		await recovered.core.start();
		const restored = rememberProfile(recovered.core);
		assert.equal(restored.config.profileId, moved.config.profileId);
		assert.equal(restored.online, true);
		assert.equal((await appContainerFileAccess(restored.config).read(artifact)).data.toString(), "保留工作区内容\r\n");
		assert.equal(recovered.core.db.get<{ path: string }>("SELECT path FROM move_fixture")?.path, join(moved.directory, artifact));
	} finally {
		try {
			for (const core of activeCores) await core.shutdown();
			for (const config of profiles) if (await appContainerProvisioned(config)) await removeAppContainerProfile(config);
		} finally { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
	}
});

test("Git-compatible workspace is opt-in, portable by archive, and tracked through restart, move rollback and uninstall", {
	skip: !fixtureNode || !fixturePackage || process.platform !== "win32", timeout: 420_000,
}, async () => {
	const temp = await mkdtemp(join(tmpdir(), "df-appcontainer-git-option-"));
	const install = join(temp, "installation");
	const data = join(install, "data");
	const backup = join(temp, "git-workspace.dreambackup");
	const output = "outbox/本地样本.txt";
	const activeCores: Core[] = [];
	const external: GitWorkspacePlacement[] = [];
	let bridgePath: string | undefined;
	try {
		bridgePath = await builtRunner(temp);
		const toolsSource = packagedTools();
		const bundledGit = toolsSource.git;
		const noGit = join(temp, "missing-git-executable");
		await mkdir(noGit);
		const noWsl = async () => assert.fail("native Git workspace must not reach WSL");
		const hooks: MoveHooks = { appContainerBridgePath: bridgePath, wsl: noWsl };
		const legacy = { dataDir: join(temp, "legacy-data"), agentDir: join(temp, "legacy-pi") };
		const uninstall: UninstallDeps = { legacy, stopCore: async () => {}, registeredDisk: noWsl, wsl: noWsl,
			retireNativeProfiles: dir => retireNativeProfiles(dir, bridgePath!),
			retireGitWorkspace: (dir, entry) => retireGitWorkspace(dir, entry, bridgePath!),
		};
		const createCore = () => {
			const core = new Core({ paths: corePaths(data), agentDir: defaultAgentDir(data), log: new Logger(), notifier: new RecordingNotifier() });
			activeCores.push(core);
			core.db.run("CREATE TABLE IF NOT EXISTS native_fixture (path TEXT NOT NULL)");
			core.declareBackup({ id: "native-fixture", title: "迁移测试样本", tables: ["native_fixture"], paths: { native_fixture: { path: "path" } } });
			const provider = new WindowsAppContainerSandbox(core, { bridgePath, toolsSource });
			core.use(provider);
			core.use(new StorageModule(core));
			return { core, provider };
		};
		const first = createCore();
		await first.core.start();
		await first.provider.prepare();
		const original = first.core.sandboxProvider?.();
		assert(original?.appContainer && original.workspaceDir);
		const files = appContainerFileAccess(original.appContainer);
		await files.write(output, "用于迁移的文件\n", null);
		first.core.db.run("INSERT INTO native_fixture (path) VALUES (?)", join(original.workspaceDir, output));
		const enable = (workspaceDir = first.provider.status().gitCompatibility.alternativePath) =>
			first.core.call("sandbox.setGitCompatibility", { enabled: true, workspaceDir });
		assert.equal(first.provider.status().gitCompatibility.enabled, false);
		await assert.rejects(enable(join(temp, "unconfirmed")), { code: "conflict" });

		const collided = dirname(first.provider.status().gitCompatibility.alternativePath);
		assert.equal(dirname(collided), parse(data).root);
		await mkdir(collided);
		try {
			await writeFile(join(collided, "keep.txt"), "unrelated\n");
			await assert.rejects(enable(), /已存在/);
			assert.equal(await readFile(join(collided, "keep.txt"), "utf8"), "unrelated\n");
			assert.equal(readNativePlacements(data).entries.length, 0);
		} finally {
			assert.equal(await realpath(collided), collided);
			await rm(collided, { recursive: true, force: true });
		}

		const failed = dirname(first.provider.status().gitCompatibility.alternativePath);
		toolsSource.git = noGit;
		await assert.rejects(enable(), { code: "unavailable" });
		toolsSource.git = bundledGit;
		await assert.rejects(realpath(failed), { code: "ENOENT" });
		assert.equal(readNativePlacements(data).entries.length, 0);
		assert.equal(first.provider.status().workspaceDir, original.workspaceDir);
		assert.equal((await files.read(output)).data.toString(), "用于迁移的文件\n");

		const target = first.provider.status().gitCompatibility.alternativePath;
		await enable();
		const switched = first.core.sandboxProvider?.();
		assert(switched?.appContainer && switched.workspaceDir === target);
		assert.equal(first.provider.status().gitCompatibility.enabled, true);
		assert.equal(first.provider.status().retainedWorkspaceDir, original.workspaceDir);
		assert.equal(first.core.db.get<{ path: string }>("SELECT path FROM native_fixture")?.path, join(target, output));
		assert.equal(await readFile(join(original.workspaceDir, output), "utf8"), "用于迁移的文件\n");
		assert.equal(await appContainerProvisioned(original.appContainer), false);
		assert.equal((await appContainerFileAccess(switched.appContainer).read(output)).data.toString(), "用于迁移的文件\n");
		const git = async (config: AppContainerConfig, cwd: string, ...args: string[]) => {
			const result = await collectGit(appContainerSandboxEnv(config).spawn("git", args, cwd), undefined, 20_000, undefined, true);
			assert.equal(result.code, 0, result.stderr);
			return result.stdout.trim();
		};
		await git(switched.appContainer, "/workspace", "init", "--initial-branch=main", "repo-sample");
		await appContainerFileAccess(switched.appContainer).write("repo-sample/sample.txt", "Git 迁移样本", null);
		await git(switched.appContainer, "/workspace/repo-sample", "add", "--", "sample.txt");
		await git(switched.appContainer, "/workspace/repo-sample", "-c", "user.name=Local fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture");
		await git(switched.appContainer, "/workspace/repo-sample", "worktree", "add", "-b", "secondary", "../checkout-sample");
		const originalLink = await readFile(join(target, "checkout-sample", ".git"), "utf8");
		assert.match(originalLink, /appcontainer-[a-f0-9]{32}\/workspace\/repo-sample\/\.git\/worktrees\//i);
		const firstCatalog = readNativePlacements(data);
		external.push(...firstCatalog.entries);
		assert.equal(external.length, 1);
		assert.equal(ownsGitWorkspace(data, external[0]!), true);
		assert.equal(ownsGitWorkspace(join(temp, "copy"), external[0]!), false);

		const result = await createBackup({ paths: first.core.paths, agentDir: first.core.agentDir, sessionsDir: join(data, "sessions"), db: first.core.db.raw, appVersion: "1.1.0" }, {
			out: backup, kind: "manual", credentials: "none", includeMaterials: false, nativeWorkspaceDir: target,
			sandbox: dest => first.provider.archiveWorkspace(dest),
		});
		assert.equal(result.manifest.source.nativeWorkspaceDir, target);
		assert.equal(result.manifest.includes.sandbox, true);
		assert.equal(result.manifest.files.some(file => file.path.endsWith(nativePlacementsFile)), false);
		const fresh = { paths: corePaths(join(temp, "other-install")), agentDir: join(temp, "other-install", "pi"), sessionsDir: join(temp, "other-install", "sessions"), appVersion: "1.1.0" };
		const staged = await stageBackup(backup, fresh, { parts: first.core.backupParts });
		assert.equal(staged.sandbox, true);
		const stagedDb = new Db(join(staged.dir, "raw", "data", "appdata", "core.db"));
		try { assert.equal(stagedDb.get("SELECT key FROM app_flags WHERE key IN (?,?,?)", ...LOCAL_NATIVE_FLAGS), undefined); }
		finally { stagedDb.close(); }
		const localStage = await stageBackup(backup, { ...fresh, paths: first.core.paths }, { parts: first.core.backupParts });
		const localDb = new Db(join(localStage.dir, "raw", "data", "appdata", "core.db"));
		try { assert.equal(localDb.get<{ value: string }>("SELECT value FROM app_flags WHERE key=?", LOCAL_NATIVE_FLAGS[0])?.value, switched.appContainer.profileId); }
		finally { localDb.close(); }

		await first.core.shutdown();
		const restarted = createCore();
		await restarted.core.start();
		assert.equal(restarted.provider.status().workspaceDir, target);
		assert.equal(restarted.provider.status().gitCompatibility.enabled, true);
		const closed = new Promise<void>(resolve => restarted.core.onShutdown(resolve));
		const rejected = join(temp, "rejected-move");
		await restarted.core.call("storage.move", { kind: "sandbox", target: rejected });
		await closed;
		const record = await preparePendingMove(data, hooks);
		assert(record?.nativeWorkspace?.previousPath === target);
		const candidate = createCore();
		remapMovedDatabase(candidate.core, record);
		await candidate.core.start();
		const call = candidate.core.call.bind(candidate.core);
		candidate.core.call = (method, params, client) => method === "sandbox.selfTest"
			? Promise.resolve({ items: [{ passed: false }] }) : call(method, params, client);
		await assert.rejects(validateMove(candidate.core, record, hooks), /新工作区读写自检失败/);
		assert.equal(candidate.provider.status().gitCompatibility.enabled, false);
		await candidate.core.shutdown();
		await rollbackMove(data, record, "验证拒绝", hooks);
		assert.equal((await appContainerProvisioned(switched.appContainer)), true);
		await assert.rejects(realpath(rejected), { code: "ENOENT" });
		const recovered = createCore();
		await recovered.core.start();
		assert.equal(recovered.provider.status().workspaceDir, target);
		const standard = recovered.provider.status().gitCompatibility.alternativePath;
		await recovered.core.call("sandbox.setGitCompatibility", { enabled: false, workspaceDir: standard });
		assert.equal(recovered.provider.status().workspaceDir, standard);
		assert.equal(recovered.provider.status().gitCompatibility.enabled, false);
		assert.equal(await appContainerProvisioned(switched.appContainer), false);
		assert.equal(await readFile(join(target, output), "utf8"), "用于迁移的文件\n");
		assert.equal(await readFile(join(target, "checkout-sample", ".git"), "utf8"), originalLink);
		assert.ok((await readFile(join(standard, "checkout-sample", ".git"), "utf8")).includes(standard.replaceAll("\\", "/")));
		const beforeMovePath = recovered.provider.status().gitCompatibility.alternativePath;
		await recovered.core.call("sandbox.setGitCompatibility", { enabled: true, workspaceDir: beforeMovePath });
		const beforeMove = recovered.core.sandboxProvider?.();
		assert(beforeMove?.appContainer && beforeMove.workspaceDir === beforeMovePath);
		assert.equal(await git(beforeMove.appContainer, "/workspace/checkout-sample", "status", "--porcelain=v1", "--branch"), "## secondary");
		external.splice(0, external.length, ...readNativePlacements(data).entries);
		const moveFinished = new Promise<void>(resolve => recovered.core.onShutdown(resolve));
		const movedSandbox = join(temp, "moved-sandbox");
		await recovered.core.call("storage.move", { kind: "sandbox", target: movedSandbox });
		await moveFinished;
		const accepted = await preparePendingMove(data, hooks);
		assert(accepted?.nativeWorkspace?.previousPath === beforeMovePath);
		const moved = createCore();
		remapMovedDatabase(moved.core, accepted);
		await moved.core.start();
		await validateMove(moved.core, accepted, hooks);
		const movedStatus = moved.provider.status();
		assert.equal(movedStatus.gitCompatibility.enabled, false);
		assert(movedStatus.workspaceDir?.startsWith(join(movedSandbox, "native-windows") + "\\"));
		assert.equal(movedStatus.retainedWorkspaceDir, beforeMovePath);
		assert.equal(await appContainerProvisioned(beforeMove.appContainer), false);
		assert.equal(await readFile(join(beforeMovePath, output), "utf8"), "用于迁移的文件\n");
		const uninstallPath = movedStatus.gitCompatibility.alternativePath;
		await moved.core.call("sandbox.setGitCompatibility", { enabled: true, workspaceDir: uninstallPath });
		const active = moved.core.sandboxProvider?.();
		assert(active?.appContainer && active.workspaceDir === uninstallPath);
		assert.equal(await git(active.appContainer, "/workspace/checkout-sample", "status", "--porcelain=v1", "--branch"), "## secondary");
		const catalog = readNativePlacements(data);
		external.splice(0, external.length, ...catalog.entries);
		await moved.core.shutdown();

		const unrelated = { profileId: randomUUID().replaceAll("-", ""), standardDir: catalog.entries[0]!.standardDir };
		const unrelatedPath = gitWorkspaceRoot(unrelated);
		await mkdir(unrelatedPath);
		try {
			await writeFile(join(unrelatedPath, "outside.txt"), "not owned by this installation");
			saveNativePlacements(data, { ...catalog, entries: [...catalog.entries, unrelated] });
			assert.deepEqual(planUninstall(install, legacy).review, [{ path: unrelatedPath, reason: "native_workspace_ownership_unconfirmed" }]);
			assert.deepEqual(planUninstall(install, legacy).gitWorkspaces, catalog.entries);
		} finally {
			saveNativePlacements(data, catalog);
			assert.equal(await realpath(unrelatedPath), unrelatedPath);
			await rm(unrelatedPath, { recursive: true, force: true });
		}

		await writeFile(join(data, keepMarker), "1\n");
		const preserved = await cleanInstallation(install, uninstall);
		assert.equal(preserved.ok, true, JSON.stringify(preserved.remaining));
		assert.equal(await appContainerProvisioned(active.appContainer), false);
		for (const path of [target, beforeMovePath, uninstallPath]) assert.equal(await readFile(join(path, output), "utf8"), "用于迁移的文件\n");
		const saved = preserved.plan?.preserveTo;
		assert(saved);
		assert.deepEqual(JSON.parse(await readFile(join(saved, preservedReceipt), "utf8")).nativeWorkspaces, [target, beforeMovePath, uninstallPath]);
		await rename(saved, data);
		const removed = await cleanInstallation(install, uninstall);
		assert.equal(removed.ok, true, JSON.stringify(removed.remaining));
		for (const path of [target, beforeMovePath, uninstallPath]) await assert.rejects(realpath(dirname(path)), { code: "ENOENT" });
	} finally {
		try {
			for (const core of activeCores) await core.shutdown();
			if (bridgePath) await retireNativeProfiles(storageLocations(data).sandbox, bridgePath);
			if (bridgePath) for (const entry of external) if (ownsGitWorkspace(data, entry)) {
				await retireGitWorkspace(data, entry, bridgePath);
				const path = gitWorkspaceRoot(entry);
				assert.equal(await realpath(path), path);
				await rm(path, { recursive: true, force: true });
			}
		} finally { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
	}
});
