import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { startAppContainerPython, type AppContainerConfig } from "./appcontainer.ts";

/** The child opens workspace paths under its restricted token. The host only
 * opens the archive path selected by the trusted backup/restore coordinator. */
async function transfer(config: AppContainerConfig, file: string, mode: "export" | "restore", sourceWorkspace?: string): Promise<void> {
	const code = readFileSync(new URL("../../assets/workspace-archive.py", import.meta.url), "utf8");
	const size = mode === "restore" ? (await stat(file)).size : 0;
	const child = startAppContainerPython(config, ["-I", "-c", code, mode, String(size), sourceWorkspace ?? ""], "/workspace");
	const closed = once(child, "close");
	let diagnostic = "";
	child.stderr!.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-2048); });
	try {
		if (mode === "restore") child.stdout!.resume();
		const io = mode === "export"
			? pipeline(child.stdout!, createWriteStream(file, { flags: "wx" }))
			: pipeline(createReadStream(file), child.stdin!, { end: false });
		const [[exitCode]] = await Promise.all([closed, io]);
		if (exitCode !== 0) throw new Error(`蝶君工作区归档失败 (${exitCode}) ${diagnostic.trim()}`);
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill();
		child.stdin!.destroy();
		await closed.catch(() => {});
	}
}

export function exportAppContainerArchive(config: AppContainerConfig, dest: string): Promise<void> {
	return transfer(config, dest, "export");
}

export function importAppContainerArchive(config: AppContainerConfig, source: string, sourceWorkspace?: string): Promise<void> {
	return transfer(config, source, "restore", sourceWorkspace);
}
