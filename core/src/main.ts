import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backupBeforeUpgrade } from "./backup/backup.ts";
import { applyPendingRestore } from "./backup/switch.ts";
import { parseArgs } from "node:util";
import { buildCore } from "./app.ts";
import { acquireLock, newToken, readInfo, releaseLock, removeInfo, writeInfo } from "./instance.ts";
import { Logger } from "./log.ts";
import { WindowsNotifier } from "./notify.ts";
import { corePaths, defaultAgentDir, defaultDataDir, legacyAgentDir, legacyDataDir } from "./paths.ts";
import { resolve } from "node:path";
import { configurePiNetworking } from "./pi/http.ts";
import { startServer } from "./server.ts";
import { CORE_VERSION } from "./core.ts";
import { spawn } from "node:child_process";
import { atomicJson, configureResourcePaths, initializeLocations, storageLocations } from "./storage/locations.ts";
import { preparePendingMove, remapMovedDatabase, rollbackMove, validateMove, type MoveRecord } from "./storage/move.ts";
import { recoverUpdateStartup } from "./update/startup.ts";
import { buildInfo } from "./update/installation.ts";
import { StartupProgress } from "./startup.ts";

const { values: args } = parseArgs({
	options: {
		"data-dir": { type: "string" },
		"agent-dir": { type: "string" },
		"session-dir": { type: "string" },
		port: { type: "string" },
		"echo-log": { type: "boolean" },
		"startup-events": { type: "boolean" },
		"update-test-source": { type: "string" },
		"update-test-cert": { type: "string" },
	},
});

const paths = corePaths(args["data-dir"]);
mkdirSync(paths.dataDir, { recursive: true });
let log = new Logger(paths.logFile, args["echo-log"] === true);

const lock = acquireLock(paths);
if (!lock.ok) {
	const info = readInfo(paths);
	log.info(`another core is running (pid ${lock.pid}, port ${info?.port ?? "?"}); exiting`);
	process.stdout.write(JSON.stringify({ alreadyRunning: true, pid: lock.pid, port: info?.port }) + "\n");
	process.exit(3);
}

// Startup phases, logged once the core listens, so a slow start can be traced (V07-07).
const startedAt = performance.now();
let phaseAt = startedAt;
const phases: string[] = [];
const startup = new StartupProgress();
const startupFile = join(paths.dataDir, "core-startup.json");
startup.onChange(state => {
	const event = { event: "core.startup", ...state };
	try { atomicJson(startupFile, event); } catch (error) { log.warn("startup progress file unavailable", error); }
	if (args["startup-events"]) process.stdout.write(JSON.stringify(event) + "\n");
});
const clearStartup = (): void => { try { rmSync(startupFile, { force: true }); } catch (error) { log.warn("startup progress cleanup failed", error); } };
const phaseText: Record<string, string> = {
	"update check": "正在检查更新恢复……", "storage and restore": "正在准备数据……", "backup before upgrade": "正在检查备份……",
	"network": "正在准备连接……", "open data and modules": "正在准备后台服务……", "server": "正在连接窗口……",
	"start modules": "正在准备服务……", "check moved data": "正在验证数据位置……",
};
const phase = (name: string): void => {
	const now = performance.now();
	phases.push(`${name} ${Math.round(now - phaseAt)}ms`);
	phaseAt = now;
};
const begin = (name: string): void => startup.mark(name, phaseText[name] ?? "正在准备……");

process.on("uncaughtException", (error) => log.error("uncaught exception", error));
process.on("unhandledRejection", (error) => log.error("unhandled rejection", error));

begin("update check");
try {
	if (await recoverUpdateStartup(paths) === "guardian-active") { clearStartup(); releaseLock(paths); process.exit(7); }
	if ((args["update-test-source"] || process.env.DREAMFLUTTER_UPDATE_TEST_SOURCE) && (buildInfo() as unknown as { failStartup?: boolean }).failStartup) { clearStartup(); releaseLock(paths); process.exit(42); }
} catch (error) { log.error("update recovery: startup held to preserve data", error); clearStartup(); releaseLock(paths); process.exit(8); }
phase("update check");
let migration: MoveRecord | undefined;
let startingCore: ReturnType<typeof buildCore> | undefined;
let startingServer: Awaited<ReturnType<typeof startServer>> | undefined;
try {
begin("storage and restore");
if (!args["agent-dir"] && !args["session-dir"]) initializeLocations(paths.dataDir);
migration = await preparePendingMove(paths.dataDir);
Object.assign(paths, corePaths(paths.dataDir));
for (const path of Object.values(storageLocations(paths.dataDir))) mkdirSync(path, { recursive: true });
log = new Logger(paths.logFile, args["echo-log"] === true);
process.env.PI_CODING_AGENT = "true";
const agentDir = args["agent-dir"] ?? defaultAgentDir(paths.dataDir);
const sessionDir = args["session-dir"] ?? storageLocations(paths.dataDir, agentDir).sessions;
mkdirSync(agentDir, { recursive: true });
configureResourcePaths(paths.dataDir, agentDir, sessionDir);
// Pi's own lookups (bin, themes, tools) follow the app's Pi folder, never ~/.pi/agent; children
// (the agent's shells) inherit it, so a `pi` they run stays inside DreamFlutter's data as well.
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.DREAMFLUTTER_CACHE = paths.cacheDir;

// Before the database opens: finish a restore the last core prepared, then back up data about to be upgraded.
try {
	const restored = applyPendingRestore(paths, { log: (m) => log.info(m) });
	if (restored) log.info(`restore: ${restored.ok ? "switched to the backup's data" : `failed, old data kept: ${restored.error}`}`);
} catch (error) {
	log.error("restore: switch could not finish; it is retried on the next start", error);
	if (migration) throw error;
	process.exit(4);
}
phase("storage and restore");
begin("backup before upgrade");
await backupBeforeUpgrade(paths, agentDir, sessionDir, log);
phase("backup before upgrade");

begin("network");
await configurePiNetworking(agentDir, log);
phase("network");

begin("open data and modules");
const core = buildCore({
	startup,
	updates: { testSource: args["update-test-source"] ?? process.env.DREAMFLUTTER_UPDATE_TEST_SOURCE, testThumbprints: (args["update-test-source"] || process.env.DREAMFLUTTER_UPDATE_TEST_SOURCE) ? (args["update-test-cert"] ?? process.env.DREAMFLUTTER_UPDATE_TEST_CERT ?? "").split(",").filter(Boolean) : [] },
	paths,
	agentDir,
	sessionDir,
	// v0.3.1 kept everything under %APPDATA% and ~/.pi/agent: the default data folder takes it over once.
	legacyData: resolve(paths.dataDir).toLowerCase() === resolve(defaultDataDir()).toLowerCase() && !args["agent-dir"] ? { dataDir: legacyDataDir(), agentDir: legacyAgentDir() } : undefined,
	log,
	notifier: new WindowsNotifier(log),
});
startingCore = core;
if (migration) remapMovedDatabase(core, migration);
phase("open data and modules");

const token = newToken();
begin("server");
const server = await startServer(core, { port: args.port ? Number(args.port) : 0, token });
startingServer = server;
phase("server");
begin("start modules");
await core.start();
phase("start modules");
if (migration) { begin("check moved data"); await validateMove(core, migration); phase("check moved data"); }
writeInfo(paths, { pid: process.pid, port: server.port, token, version: CORE_VERSION, startedAt: Date.now() });
log.info(`core ${CORE_VERSION} listening on 127.0.0.1:${server.port} (pid ${process.pid})`);
log.info(`startup ${Math.round(performance.now() - startedAt)}ms: ${phases.join(", ")}`);
startup.mark("ready", "准备好了", true);
process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, port: server.port }) + "\n");

let exiting = false;
async function exit(code: number): Promise<void> {
	if (exiting) return;
	exiting = true;
	const began = performance.now();
	log.info("shutting down");
	removeInfo(paths);
	clearStartup();
	await server.close();
	await core.shutdown();
	releaseLock(paths);
	log.info(`shutdown ${Math.round(performance.now() - began)}ms`);
	process.exit(code);
}

core.onShutdown(() => {
	removeInfo(paths);
	clearStartup();
	releaseLock(paths);
	void server.close().then(() => process.exit(0));
});
process.on("SIGINT", () => void exit(0));
process.on("SIGTERM", () => void exit(0));
} catch (error) {
	log.error("startup failed", error);
	await startingServer?.close();
	await startingCore?.shutdown();
	removeInfo(paths);
	clearStartup();
	if (migration) {
		if (migration.stage === "committed") {
			// Never roll back to a source already cleaned after successful validation.
			releaseLock(paths);
			process.exit(1);
		}
		try { await rollbackMove(paths.dataDir, migration, String(error)); }
		catch (rollbackError) {
			log.error("storage rollback could not finish; journal retained for next startup", rollbackError);
			releaseLock(paths);
			process.exit(1);
		}
		releaseLock(paths);
		// The same normal entrypoint verifies the old location, with a new lock.
		const child = spawn(process.execPath, process.argv.slice(1), { detached: true, windowsHide: true, stdio: "ignore", env: process.env });
		child.unref();
		process.exit(0);
	}
	releaseLock(paths);
	process.exit(1);
}
