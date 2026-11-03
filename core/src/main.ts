import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { backupBeforeUpgrade } from "./backup/backup.ts";
import { applyPendingRestore } from "./backup/switch.ts";
import { parseArgs } from "node:util";
import { buildCore } from "./app.ts";
import { acquireLock, newToken, readInfo, releaseLock, removeInfo, writeInfo } from "./instance.ts";
import { Logger } from "./log.ts";
import { WindowsNotifier } from "./notify.ts";
import { corePaths, defaultAgentDir } from "./paths.ts";
import { configurePiNetworking } from "./pi/http.ts";
import { startServer } from "./server.ts";
import { CORE_VERSION } from "./core.ts";

const { values: args } = parseArgs({
	options: {
		"data-dir": { type: "string" },
		"agent-dir": { type: "string" },
		"session-dir": { type: "string" },
		port: { type: "string" },
		"echo-log": { type: "boolean" },
	},
});

const paths = corePaths(args["data-dir"]);
mkdirSync(paths.dataDir, { recursive: true });
const log = new Logger(paths.logFile, args["echo-log"] === true);

const lock = acquireLock(paths);
if (!lock.ok) {
	const info = readInfo(paths);
	log.info(`another core is running (pid ${lock.pid}, port ${info?.port ?? "?"}); exiting`);
	process.stdout.write(JSON.stringify({ alreadyRunning: true, pid: lock.pid, port: info?.port }) + "\n");
	process.exit(3);
}

process.on("uncaughtException", (error) => log.error("uncaught exception", error));
process.on("unhandledRejection", (error) => log.error("unhandled rejection", error));
process.env.PI_CODING_AGENT = "true";
const agentDir = args["agent-dir"] ?? defaultAgentDir();

// Before the database opens: finish a restore the last core prepared, then back up data about to be upgraded.
try {
	const restored = applyPendingRestore(paths, { log: (m) => log.info(m) });
	if (restored) log.info(`restore: ${restored.ok ? "switched to the backup's data" : `failed, old data kept: ${restored.error}`}`);
} catch (error) {
	log.error("restore: switch could not finish; it is retried on the next start", error);
	process.exit(4);
}
await backupBeforeUpgrade(paths, agentDir, args["session-dir"] ?? join(agentDir, "sessions"), log);

await configurePiNetworking(agentDir, log);

const core = buildCore({
	paths,
	agentDir,
	sessionDir: args["session-dir"],
	log,
	notifier: new WindowsNotifier(log),
});

const token = newToken();
const server = await startServer(core, { port: args.port ? Number(args.port) : 0, token });
await core.start();
writeInfo(paths, { pid: process.pid, port: server.port, token, version: CORE_VERSION, startedAt: Date.now() });
log.info(`core ${CORE_VERSION} listening on 127.0.0.1:${server.port} (pid ${process.pid})`);
process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, port: server.port }) + "\n");

let exiting = false;
async function exit(code: number): Promise<void> {
	if (exiting) return;
	exiting = true;
	log.info("shutting down");
	removeInfo(paths);
	await server.close();
	await core.shutdown();
	releaseLock(paths);
	process.exit(code);
}

core.onShutdown(() => {
	removeInfo(paths);
	releaseLock(paths);
	void server.close().then(() => process.exit(0));
});
process.on("SIGINT", () => void exit(0));
process.on("SIGTERM", () => void exit(0));
