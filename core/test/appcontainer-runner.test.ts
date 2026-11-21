import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	appContainerSandboxEnv, appContainerWorkspacePath, provisionAppContainer, removeAppContainerProfile,
	appContainerProvisioned, refreshAppContainerTools,
	type AppContainerConfig,
} from "../src/sandbox/appcontainer.ts";
import { appContainerFileAccess } from "../src/sandbox/appcontainer-fs.ts";

const exec = promisify(execFile);

test("AppContainer resolves workspace paths without enabling Core-side file operations", () => {
	const config: AppContainerConfig = {
		dataDir: "C:\\DreamFlutter\\data",
		profileId: "0123456789abcdef0123456789abcdef",
		bridgePath: "C:\\DreamFlutter\\appcontainer-runner.exe",
		toolsSource: "C:\\DreamFlutter\\tools",
	};
	const workspace = appContainerWorkspacePath(config);
	const env = appContainerSandboxEnv(config);
	assert.equal(env.resolve("/workspace", "notes/a.txt"), win32.join(workspace, "notes", "a.txt"));
	assert.equal(env.resolve(win32.join(workspace, "notes"), "../a.txt"), win32.join(workspace, "a.txt"));
	for (const path of ["../outside.txt", "/workspace/../outside.txt", "C:\\elsewhere", "\\\\server\\share", "notes.txt:stream"]) {
		assert.throws(() => env.resolve("/workspace", path));
	}
	assert.throws(() => env.local(workspace), /容器内执行/);
});

function collect(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
	let stdout = "", stderr = "";
	child.stdout!.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
	child.stderr!.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	return once(child, "close").then(([code]) => ({ code, stdout, stderr }));
}

function reachable(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1");
		socket.once("connect", () => { socket.destroy(); resolve(); });
		socket.once("error", reject);
	});
}

const fixtureNode = process.env.DREAMFLUTTER_APPCONTAINER_TEST_NODE;

test("Windows native bridge isolates files and loopback, then reaps the entire job on pipe close", {
	skip: !fixtureNode || process.platform !== "win32",
	timeout: 90_000,
}, async () => {
	const fixture = await mkdtemp(join(tmpdir(), "df-appcontainer-runner-"));
	const toolsSource = join(fixture, "package");
	const config: AppContainerConfig = {
		dataDir: fixture,
		profileId: randomUUID().replaceAll("-", ""),
		bridgePath: join(fixture, "appcontainer-runner.exe"),
		toolsSource,
		toolsVersion: "fixture-release-1",
	};
	const server = createServer((socket) => socket.end());
	let connections = 0;
	server.on("connection", () => { connections++; });
	let profileReady = false;
	let active: ChildProcess | undefined;
	const secretEnvName = "DREAMFLUTTER_APPCONTAINER_SYNTHETIC_SECRET";
	const priorSecret = process.env[secretEnvName];
	try {
		await mkdir(toolsSource);
		await copyFile(fixtureNode!, join(toolsSource, "node.exe"));
		await writeFile(join(toolsSource, "package-sample.txt"), "read only");
		const outside = join(fixture, "outside.txt");
		await writeFile(outside, "synthetic sibling");
		const powershell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		const build = fileURLToPath(new URL("../../tools/appcontainer-runner/build.ps1", import.meta.url));
		await exec(powershell, ["-NoProfile", "-NonInteractive", "-File", build, "-OutputPath", config.bridgePath], { windowsHide: true });
		await provisionAppContainer(config);
		profileReady = true;
		await provisionAppContainer(config);
		const env = appContainerSandboxEnv(config);
		const workspace = appContainerWorkspacePath(config);
		assert.throws(() => env.spawn("unknown", [], workspace));
		process.env[secretEnvName] = "synthetic environment secret";

		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		assert(address && typeof address === "object");
		await reachable(address.port);
		assert.equal(connections, 1);

		const check = `
			const assert = require('node:assert/strict');
			const fs = require('node:fs');
			const path = require('node:path');
			const [outside, port, quoted] = process.argv.slice(1);
			const denied = (error) => ['EACCES', 'EPERM'].includes(error.code);
			assert.equal(process.env.${secretEnvName}, undefined);
			assert.throws(() => fs.readFileSync(outside), denied);
			assert.throws(() => fs.openSync(outside, 'r+'), denied);
			const tool = path.join(path.dirname(process.execPath), 'package-sample.txt');
			assert.equal(fs.readFileSync(tool, 'utf8'), 'read only');
			assert.throws(() => fs.openSync(tool, 'r+'), denied);
			assert.equal(fs.readFileSync(0, 'utf8'), '');
			fs.writeFileSync('payload.txt', quoted);
			const socket = require('node:net').connect(Number(port), '127.0.0.1');
			socket.setTimeout(1500, () => socket.destroy());
			socket.on('connect', () => { process.exitCode = 7; socket.destroy(); });
			socket.on('error', (error) => { if (!['ETIMEDOUT','EACCES','EPERM'].includes(error.code)) throw error; });
			socket.on('close', () => console.log(JSON.stringify({ quoted })));
		`;
		const quoted = '中文 argument & "quote" trailing slash \\';
		active = env.spawn("node", ["-e", check, outside, String(address.port), quoted], "/workspace");
		const result = await collect(active);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), { quoted });
		assert.equal(await readFile(join(workspace, "payload.txt"), "utf8"), quoted);
		assert.equal(connections, 1);
		await reachable(address.port);
		assert.equal(connections, 2);
		const online = appContainerSandboxEnv({ ...config, allowNetwork: () => true });
		active = online.spawn("node", ["-e", check, outside, String(address.port), quoted], workspace);
		const onlineResult = await collect(active);
		assert.equal(onlineResult.code, 0, onlineResult.stderr);
		assert.equal(connections, 2);
		await reachable(address.port);
		assert.equal(connections, 3);
		if (process.env.DREAMFLUTTER_APPCONTAINER_TEST_INTERNET === "1") {
			const script = `
				const request = require('node:https').get('https://registry.npmjs.org/-/ping', { timeout: 5000 }, (response) => {
					let body = '';
					response.setEncoding('utf8').on('data', (part) => { body += part }).on('end', () => {
						if (response.statusCode !== 200 || body.trim() !== '{}') process.exitCode = 31;
					});
				});
				request.on('timeout', () => request.destroy());
				request.on('error', () => { process.exitCode = 32 });
			`;
			await exec(fixtureNode!, ["-e", script], { timeout: 8000 });
			active = env.spawn("node", ["-e", script], workspace);
			assert.equal((await collect(active)).code, 32, "offline child reached the public test endpoint");
			active = online.spawn("node", ["-e", script], workspace);
			const publicCheck = await collect(active);
			assert.equal(publicCheck.code, 0, publicCheck.stderr || "online child could not reach the public test endpoint");
		}
		active = env.spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Write-Output 'workspace shell'"], workspace);
		const shell = await collect(active);
		assert.equal(shell.code, 0, shell.stderr);
		assert.equal(shell.stdout.trim(), "workspace shell");

		const files = appContainerFileAccess(config);
		const target = "/workspace/图表/样本.bin";
		const bytes = Buffer.alloc(96 * 1024, 0xd3);
		assert.equal(await files.stat(target), null);
		const version = await files.write(target, bytes, null);
		assert.deepEqual(await files.read(target), { data: bytes, version });
		assert.equal((await files.stat("/workspace/图表"))?.isDirectory, true);
		await assert.rejects(files.write(target, "reject missing observation", null), { code: "FS_NOT_OBSERVED" });
		const updated = await files.write(target, "中文 payload\r\n", version);
		await assert.rejects(files.write(target, "reject stale write", version), { code: "FS_STALE_VERSION" });
		assert.deepEqual(await files.read(target), { data: Buffer.from("中文 payload\r\n"), version: updated });
		await assert.rejects(files.read(outside), /超出工作区/);
		await assert.rejects(files.read(target, AbortSignal.abort()), { code: "FS_CANCELLED" });

		const nested = `
			const child = require('node:child_process').spawn(process.execPath,
				['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
			child.once('spawn', () => console.log(process.pid + ' ' + child.pid));
			setInterval(() => {}, 1000);
		`;
		active = env.spawn("node", ["-e", nested], workspace);
		const stopped = collect(active);
		const [chunk] = await once(active.stdout!, "data");
		const ids = String(chunk).trim().split(" ").map(Number);
		assert.equal(ids.length, 2);
		for (const pid of ids) assert.doesNotThrow(() => process.kill(pid, 0));
		active.stdin!.end();
		assert.equal((await stopped).code, 1223);
		for (const pid of ids) {
			for (let retry = 0; retry < 20 && alive(pid); retry++) await delay(30);
			assert.equal(alive(pid), false, `job member ${pid} did not exit`);
		}

		await writeFile(join(toolsSource, "package-sample.txt"), "updated read-only file");
		await refreshAppContainerTools({ ...config, toolsVersion: "fixture-release-2" });
		active = env.spawn("node", ["-e", "const fs=require('node:fs'); const p=require('node:path').join(require('node:path').dirname(process.execPath),'package-sample.txt'); console.log(fs.readFileSync(p, 'utf8')); try { fs.openSync(p,'r+'); process.exitCode=3 } catch (error) { if (!['EACCES','EPERM'].includes(error.code)) throw error }"], workspace);
		const upgraded = await collect(active);
		assert.equal(upgraded.code, 0, upgraded.stderr);
		assert.equal(upgraded.stdout.trim(), "updated read-only file");
		assert.equal(await readFile(join(workspace, "payload.txt"), "utf8"), quoted);

		const otherDataDir = join(fixture, "copied-workspace");
		const clonedLayout = join(otherDataDir, `appcontainer-${config.profileId}`);
		await mkdir(clonedLayout, { recursive: true });
		await copyFile(join(fixture, `appcontainer-${config.profileId}`, "runner-v1.ready"), join(clonedLayout, "runner-v1.ready"));
		assert.equal(await appContainerProvisioned({ ...config, dataDir: otherDataDir }), false);
	} finally {
		if (priorSecret === undefined) delete process.env[secretEnvName];
		else process.env[secretEnvName] = priorSecret;
		if (active && active.exitCode === null && active.signalCode === null) {
			const closed = once(active, "close");
			active.kill();
			await closed;
		}
		if (server.listening) await new Promise<void>((done) => server.close(() => done()));
		try {
			if (profileReady) await removeAppContainerProfile(config);
		} finally {
			await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}
});

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}
