import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Only Node's own modules load before the log exists (2026-11-19: a real uninstall timed
// out without leaving any log); the cleanup code is imported after the first line is written.
async function main(): Promise<number> {
	// The native hook supplies current/, never a caller-selected data directory.
	const current = resolve(import.meta.dirname, "../../..");
	const root = dirname(current);
	if (process.platform !== "win32" || current.toLowerCase() !== join(root, "current").toLowerCase() ||
		!existsSync(join(root, "Update.exe")) || !existsSync(join(current, "sq.version")) ||
		existsSync(join(root, ".portable"))) return 2;
	const manifest = readFileSync(join(current, "sq.version"), "utf8");
	if (!/<id>DreamFlutter<\/id>/i.test(manifest)) return 2;
	const temp = tmpdir();
	if (temp.toLowerCase().startsWith(root.toLowerCase() + "\\")) return 2;
	const logPath = join(mkdtempSync(join(temp, "dreamflutter-uninstall-")), "uninstall.jsonl");
	const log = (step: string, status: string, reason?: string) =>
		appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), step, status, reason }) + "\n", { mode: 0o600 });
	try {
		log("hook", "start");
		const { safePath } = await import("./plan.ts");
		const { isInside } = await import("../backup/path-map.ts");
		safePath(current); safePath(join(current, "sq.version")); safePath(temp);
		if (isInside(root, temp)) { log("hook", "remaining", "temp_inside_install"); return 2; }
		const { legacyAgentDir, legacyDataDir } = await import("../paths.ts");
		const { cleanInstallation } = await import("./cleanup.ts");
		const { windowsDependencies } = await import("./windows.ts");
		log("hook", "loaded");
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
