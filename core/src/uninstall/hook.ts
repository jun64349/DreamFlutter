import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { legacyAgentDir, legacyDataDir } from "../paths.ts";
import { cleanInstallation } from "./cleanup.ts";
import { windowsDependencies } from "./windows.ts";
import { safePath } from "./plan.ts";
import { isInside } from "../backup/path-map.ts";

async function main(): Promise<number> {
	// The native hook supplies current/, never a caller-selected data directory.
	const current = resolve(import.meta.dirname, "../../..");
	const root = dirname(current);
	if (process.platform !== "win32" || current.toLowerCase() !== join(root, "current").toLowerCase() ||
		!existsSync(join(root, "Update.exe")) || !existsSync(join(current, "sq.version")) ||
		existsSync(join(root, ".portable"))) return 2;
	safePath(current);
	const manifestPath = join(current, "sq.version");
	safePath(manifestPath);
	const manifest = readFileSync(manifestPath, "utf8");
	if (!/<id>DreamFlutter<\/id>/i.test(manifest)) return 2;
	const temp = tmpdir();
	safePath(temp);
	if (isInside(root, temp)) return 2;
	const logPath = join(mkdtempSync(join(temp, "dreamflutter-uninstall-")), "uninstall.jsonl");
	const log = (step: string, status: string, reason?: string) =>
		appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), step, status, reason }) + "\n", { mode: 0o600 });
	try {
		log("hook", "start");
		const { deps, finish } = windowsDependencies(root, { dataDir: legacyDataDir(), agentDir: legacyAgentDir() }, logPath);
		const result = await cleanInstallation(root, deps, logPath);
		await finish();
		log("hook", result.ok ? "ok" : "remaining");
		return result.ok ? 0 : 1;
	} catch {
		log("hook", "remaining", "cleanup_interrupted");
		return 1;
	}
}

process.exitCode = await main().catch(() => 1);

