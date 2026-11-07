import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { proxyEnvironment } from "../src/agent/system-proxy.ts";
import { bundledPython, TOOLS_DIR } from "../src/agent/toolchain.ts";

/** Real CLI clients, a loopback proxy fixture, isolated config/cache, no external server. */
it("uv, pip, npm and git actually use the inherited system proxy for HTTP requests", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "df-proxy-tools-"));
	const seen: string[] = [];
	const server = createServer((req, res) => {
		seen.push(req.url ?? "");
		res.writeHead(502, { "Content-Type": "text/plain" }); res.end("test proxy: no upstream connection\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const port = (server.address() as { port: number }).port;
		const base: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(proxy|^npm_config_|^pip_|^uv_|^git_config)/i.test(k)));
		Object.assign(base, { HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir, XDG_CONFIG_HOME: dir,
			GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_TERMINAL_PROMPT: "0",
			PIP_CONFIG_FILE: process.platform === "win32" ? "NUL" : "/dev/null", PIP_DISABLE_PIP_VERSION_CHECK: "1" });
		writeFileSync(join(dir, "gitconfig"), ""); writeFileSync(join(dir, "npmrc"), ""); writeFileSync(join(dir, "requirements.txt"), "df-proxy-fixture\n");
		const env = proxyEnvironment({ enabled: true, server: `127.0.0.1:${port}` }, base);
		const uv = join(TOOLS_DIR, process.platform === "win32" ? "uv.exe" : "uv");
		const python = bundledPython();
		const npm = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
		const tools = [
			{ name: "uv", exists: existsSync(uv), exe: uv, args: ["pip", "compile", join(dir, "requirements.txt"), "--index-url", "http://df-proxy-fixture.invalid/simple", "--no-config", "--no-cache", "--python-version", "3.13"] },
			{ name: "pip", exists: !!python && spawnSync(python, ["-m", "pip", "--version"], { env, windowsHide: true, timeout: 5000 }).status === 0, exe: python ?? "python", args: ["-m", "pip", "index", "versions", "df-proxy-fixture", "--index-url", "http://df-proxy-fixture.invalid/simple", "--trusted-host", "df-proxy-fixture.invalid", "--retries", "0", "--timeout", "2", "--no-cache-dir"] },
			{ name: "npm", exists: existsSync(npm), exe: process.execPath, args: [npm, "view", "df-proxy-fixture", "version", "--registry=http://df-proxy-fixture.invalid", `--cache=${join(dir, "npm-cache")}`, `--userconfig=${join(dir, "npmrc")}`, "--fetch-retries=0", "--fetch-timeout=2000"] },
			{ name: "git", exists: spawnSync("git", ["--version"], { env, windowsHide: true, timeout: 5000 }).status === 0, exe: "git", args: ["ls-remote", "http://df-proxy-fixture.invalid/repo"] },
		];
		for (const tool of tools) await t.test(tool.name, { skip: tool.exists ? false : "本地未安装该工具" }, async () => {
			const start = seen.length;
			await new Promise<void>((resolve, reject) => {
				const child = spawn(tool.exe, tool.args, { cwd: dir, env: { ...env, UV_HTTP_RETRIES: "0", UV_HTTP_TIMEOUT: "2" }, windowsHide: true, stdio: "ignore" });
				const timeout = setTimeout(() => { child.kill(); reject(new Error(`${tool.name} timeout`)); }, 15_000);
				child.on("error", (error) => { clearTimeout(timeout); reject(error); });
				child.on("exit", () => { clearTimeout(timeout); resolve(); });
			});
			assert.ok(seen.slice(start).some((url) => url.startsWith("http://df-proxy-fixture.invalid/")), `${tool.name} must reach only our proxy fixture`);
		});
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	}
});
