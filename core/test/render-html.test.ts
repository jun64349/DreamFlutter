import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { join, posix } from "node:path";
import { PassThrough } from "node:stream";
import { it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { imageSize } from "../src/agent/fs-tools.ts";
import { EdgeHtmlBrowser } from "../src/agent/render-html-browser.ts";
import type { BrowserPipe } from "../src/agent/render-html-cdp.ts";
import { CHROMIUM_MISSING, EDGE_MISSING, RENDER_TIMED_OUT, renderHtmlTool } from "../src/agent/render-html.ts";
import { HarnessState, type ExecEnv } from "../src/agent/state.ts";
import { textOf } from "../src/runs.ts";
import { SandboxHtmlBrowser } from "../src/sandbox/html-browser.ts";
import { runWsl } from "../src/sandbox/sandbox.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

const SLOT = "t104";
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPqkAAAAASUVORK5CYII=";
const windows = { skip: process.platform !== "win32" };
const realEdge = { skip: !await new EdgeHtmlBrowser().find() };
type ToolArgs = Parameters<typeof fauxToolCall>[1];
type Text = { type: "text"; text: string };
type Image = { type: "image"; mimeType: string; data: string };
type Result = { content: (Text | Image)[]; details: { imagePaths?: string[]; blocked?: string[] } };

async function setup(test: TestContext, html: string, textModel = false): Promise<TestCore> {
	const t = await startTestCore();
	test.after(async () => t.cleanup());
	t.core.settings.update({ approvalMode: "off", ...(textModel ? { defaultModel: "faux/faux-text" } : {}) });
	writeFileSync(join(t.workspace, "page.html"), html);
	await t.core.call("slot.open", { slotId: SLOT, cwd: t.workspace }, t.client);
	return t;
}

async function prompt(t: TestCore, args: ToolArgs = {}, response: (context: Context) => ReturnType<typeof fauxAssistantMessage> = () => fauxAssistantMessage("截图已处理")) {
	const before = settledCount(t.records(SLOT));
	t.respond(fauxAssistantMessage(fauxToolCall("render_html", { file_path: "page.html", ...args }), { stopReason: "toolUse" }), response);
	await t.send(SLOT, { id: "render-" + before, type: "prompt", message: "截一张图" });
	await t.waitFor(() => settledCount(t.records(SLOT)) > before, 24_000);
	const file = t.core.slot(SLOT).info().sessionFile;
	assert.ok(file);
	const entries = readFileSync(file, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
	const message = entries.findLast(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "render_html")?.message as Result | undefined;
	assert.ok(message);
	return message;
}

function image(result: Result): Image {
	const image = result.content.find(block => block.type === "image");
	assert.ok(image && image.mimeType === "image/png", textOf(result.content));
	return image;
}

function observeEdge(test: TestContext) {
	const launches: { profile: string; child: ChildProcess }[] = [];
	const original = childProcess.spawn;
	const hook = test.mock.method(childProcess, "spawn", (command: string, args: string[], options: SpawnOptions) => {
		const child = original(command, args, options);
		const profile = args.find(arg => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
		if (command.toLowerCase().endsWith("msedge.exe") && profile) launches.push({ profile, child });
		return child;
	});
	syncBuiltinESMExports();
	test.after(() => { hook.mock.restore(); syncBuiltinESMExports(); });
	return launches;
}

it("T104 01 captures local Chart.js and image with real Edge and records a PNG artifact", realEdge, async test => {
	const html = '<meta charset="utf-8"><img src="图标.svg"><canvas id="graph" width="420" height="200"></canvas>' +
		'<script src="chart.js"></script><script>new Chart(graph,{type:"bar",data:{labels:["一","二"],datasets:[{data:[3,5]}]},options:{responsive:false,animation:false}})</script>';
	const t = await setup(test, html);
	copyFileSync(new URL("../assets/render/chart.umd.js", import.meta.url), join(t.workspace, "chart.js"));
	writeFileSync(join(t.workspace, "图标.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="35"><rect width="60" height="35" fill="red"/></svg>');
	const result = await prompt(t);
	const preview = Buffer.from(image(result).data, "base64");
	assert.deepEqual(imageSize(preview, "image/png"), { width: 1280, height: 800 });
	const file = result.details.imagePaths?.[0];
	assert.ok(file && file.startsWith(join(t.core.paths.dataDir, "artifacts")));
	assert.deepEqual(readFileSync(file), preview);
	const taskId = t.core.slot(SLOT).taskId;
	assert.ok(taskId);
	const artifacts = await t.core.call("artifacts.list", { taskId }) as { path: string; exists: boolean }[];
	assert.ok(artifacts.some(artifact => artifact.path === file && artifact.exists));
	const authorized = t.core.db.all<{ object: string }>("SELECT object FROM security_audit WHERE kind='path' AND decision='allow'").map(row => row.object);
	assert.ok(authorized.some(file => file.endsWith("chart.js")));
	assert.ok(authorized.some(file => file.endsWith("图标.svg")));
	assert.ok(!result.details.blocked?.some(url => /chart|图标/.test(url)));
});

it("T104 02 blocks requests to external and loopback servers in real Edge and reports them", realEdge, async test => {
	let contacted = 0;
	const server = createServer((_request, reply) => { contacted++; reply.end("test only"); });
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	test.after(() => new Promise<void>(resolve => server.close(() => resolve())));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const local = "http://127.0.0.1:" + address.port + "/private-image.png";
	const remote = "https://example.invalid/not-local.png";
	const t = await setup(test, '<h1>Offline</h1><img src="' + local + '"><img src="' + remote + '">');
	const result = await prompt(t);
	image(result);
	assert.equal(contacted, 0);
	assert.ok(result.details.blocked?.includes(local));
	assert.ok(result.details.blocked?.includes(remote));
});

it("T104 03 refuses resources and junctions outside the authorized workspace", realEdge, async test => {
	const t = await setup(test, '<img src="../private.png"><img src="linked/private.png"><h1>Scoped</h1>');
	const outside = join(t.dir, "other");
	mkdirSync(outside);
	writeFileSync(join(outside, "private.png"), Buffer.from(PIXEL, "base64"));
	symlinkSync(outside, join(t.workspace, "linked"), "junction");
	const result = await prompt(t);
	image(result);
	assert.ok(result.details.blocked?.includes("/private.png"));
	assert.ok(result.details.blocked?.includes("linked/private.png"));
	assert.match(textOf(result.content), /linked\/private\.png（超出授权范围）/);
});

it("T104 04 real Edge closes a page with an infinite script at the wall-clock deadline", realEdge, async test => {
	const launches = observeEdge(test);
	const t = await setup(test, '<script>while(true){}</script>');
	const start = performance.now();
	const result = await prompt(t);
	assert.equal(textOf(result.content), RENDER_TIMED_OUT);
	const elapsed = performance.now() - start;
	assert.ok(elapsed >= 14_800 && elapsed < 20_000, String(elapsed));
	assert.equal(launches.length, 1);
	const { child, profile } = launches[0]!;
	assert.ok(child.exitCode !== null || child.signalCode !== null);
	const pid = child.pid;
	assert.ok(pid);
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	assert.equal(existsSync(profile), false);
	const processes = childProcess.execFileSync("powershell.exe", ["-NoProfile", "-Command",
		"(Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe'\" | Where-Object { $_.CommandLine -like ('*' + $env:DF_T104_TEST_PROFILE + '*') } | Measure-Object).Count"],
		{ encoding: "utf8", windowsHide: true, env: { ...process.env, DF_T104_TEST_PROFILE: profile } });
	assert.equal(processes.trim(), "0");
});

it("T104 05 uses distinct one-time browser profiles and removes them", realEdge, async test => {
	const launches = observeEdge(test);
	const t = await setup(test, "<h1>Temporary browser</h1>");
	image(await prompt(t));
	image(await prompt(t));
	assert.equal(launches.length, 2);
	assert.notEqual(launches[0]?.profile, launches[1]?.profile);
	assert.ok(launches.every(({ profile }) => !existsSync(profile)));
});

it("T104 06 reports missing Edge without launching a browser", windows, async test => {
	test.mock.method(EdgeHtmlBrowser.prototype, "find", async () => undefined);
	const launch = test.mock.method(EdgeHtmlBrowser.prototype, "launch", async () => { throw new Error("unexpected launch"); });
	const t = await setup(test, "<h1>No Edge</h1>");
	assert.equal(textOf((await prompt(t)).content), EDGE_MISSING);
	assert.equal(launch.mock.callCount(), 0);
});

function fakeBrowser() {
	const input = new PassThrough(), output = new PassThrough();
	const written: { method: string; params?: Record<string, unknown> }[] = [];
	let stopped = false;
	const emit = (message: object) => output.write(JSON.stringify(message) + "\0");
	input.on("data", (data: Buffer) => {
		for (const line of data.toString("utf8").split("\0").filter(Boolean)) {
			const message = JSON.parse(line);
			written.push(message);
			let result = {};
			if (message.method === "Target.createTarget") result = { targetId: "page" };
			if (message.method === "Target.attachToTarget") result = { sessionId: "test" };
			if (message.method === "Page.navigate") {
				result = { loaderId: "loaded" };
				emit({ sessionId: "test", method: "Fetch.requestPaused", params: { requestId: "main", resourceType: "Document", request: { url: message.params.url, method: "GET" } } });
			}
			if (message.method === "Fetch.fulfillRequest") emit({ sessionId: "test", method: "Page.lifecycleEvent", params: { name: "load", loaderId: "loaded" } });
			if (message.method === "Page.captureScreenshot") result = { data: PIXEL };
			emit({ id: message.id, result });
		}
	});
	const pipe: BrowserPipe = { input, output, async stop() { stopped = true; input.end(); output.end(); } };
	return { pipe, written, stopped: () => stopped };
}

it("T104 07 uses sandbox Chromium and reports it missing without an available dialog", windows, async test => {
	const t = await setup(test, "<h1>Sandbox browser</h1>");
	const env: ExecEnv = {
		kind: "sandbox", resolve: posix.resolve, local: path => join(t.workspace, posix.relative("/workspace", path)),
		spawn: () => { throw new Error("unexpected spawn"); },
	};
	const fake = fakeBrowser();
	const find = test.mock.method(SandboxHtmlBrowser.prototype, "find", async () => "/usr/bin/chromium-headless-shell");
	const launch = test.mock.method(SandboxHtmlBrowser.prototype, "launch", async () => fake.pipe);
	const host = test.mock.method(EdgeHtmlBrowser.prototype, "launch", async () => { throw new Error("host browser in sandbox"); });
	let booted = 0;
	const tool = renderHtmlTool({ on: () => () => {} } as unknown as ExtensionAPI, new HarnessState("/workspace", env), undefined,
		{ distro: "test-only", ready: async () => { booted++; } });
	const ctx = { sessionManager: { getSessionId: () => "test" } } as Parameters<typeof tool.execute>[4];
	const execute = () => tool.execute("tool", { file_path: "page.html" }, undefined, undefined, ctx) as Promise<Result>;
	image(await execute());
	assert.equal(booted, 1);
	assert.ok(fake.written.some(call => call.method === "Fetch.fulfillRequest" && typeof call.params?.body === "string"));
	assert.equal(fake.stopped(), true);
	find.mock.mockImplementation(async () => undefined);
	assert.equal(textOf((await execute()).content), CHROMIUM_MISSING);
	assert.equal(launch.mock.callCount(), 1);
	assert.equal(host.mock.callCount(), 0);
});

for (const decision of ["现在安装", "不安装", "跳过", undefined]) {
	it(`T104 07 requires explicit installation consent (${decision ?? "dismissed"})`, windows, async test => {
		const t = await setup(test, "<h1>蝶君截图</h1>");
		const env: ExecEnv = {
			kind: "sandbox", resolve: posix.resolve, local: path => join(t.workspace, posix.relative("/workspace", path)),
			spawn: () => { throw new Error("unexpected spawn"); },
		};
		const fake = fakeBrowser();
		let installed = false;
		let finishInstall!: () => void;
		const canFinish = new Promise<void>(resolve => { finishInstall = resolve; });
		const order: string[] = [];
		test.mock.method(SandboxHtmlBrowser.prototype, "find", async () => installed ? "/usr/bin/chromium-headless-shell" : undefined);
		const install = test.mock.method(SandboxHtmlBrowser.prototype, "install", async () => {
			order.push("install");
			await canFinish;
			installed = true;
		});
		const launch = test.mock.method(SandboxHtmlBrowser.prototype, "launch", async () => {
			order.push("launch");
			return fake.pipe;
		});
		const entries: Record<string, unknown>[] = [];
		const createTool = () => renderHtmlTool({
			on: () => () => {},
			appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
		} as unknown as ExtensionAPI, new HarnessState("/workspace", env), undefined, { distro: "test-only", ready: async () => {} });
		let sessionId = "sandbox-session";
		const select = test.mock.fn(async (title: string, labels: string[]) => {
			order.push("ask");
			assert.match(title, /截图要用的浏览器还没装（约 \d+ MB），现在装吗？$/);
			assert.deepEqual(labels, ["现在安装", "不安装", "跳过"]);
			assert.equal(install.mock.callCount(), 0);
			return decision;
		});
		const ctx = {
			hasUI: true, ui: { select },
			sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
		} as unknown as Parameters<ReturnType<typeof createTool>["execute"]>[4];
		const tool = createTool();
		const execute = (definition = tool) => definition.execute("tool", { file_path: "page.html" }, undefined, undefined, ctx) as Promise<Result>;
		const result = execute();
		if (decision === "现在安装") {
			try {
				await t.waitFor(() => install.mock.callCount() === 1);
				assert.deepEqual(order, ["ask", "install"]);
			} finally { finishInstall(); }
			image(await result);
			assert.deepEqual(order, ["ask", "install", "launch"]);
			assert.equal(fake.stopped(), true);
		} else {
			assert.equal(textOf((await result).content), CHROMIUM_MISSING);
			assert.equal(textOf((await execute()).content), CHROMIUM_MISSING);
			assert.equal(textOf((await execute(createTool())).content), CHROMIUM_MISSING);
			assert.equal(select.mock.callCount(), 1);
			assert.equal(install.mock.callCount(), 0);
			assert.equal(launch.mock.callCount(), 0);
			sessionId = "another-session";
			assert.equal(textOf((await execute(createTool())).content), CHROMIUM_MISSING);
			assert.equal(select.mock.callCount(), 2);
		}
	});
}

const browserImageDir = process.env.DF_T104_BUNDLED_IMAGE_DIR ?? fileURLToPath(new URL("../sandbox-image/", import.meta.url));
const bundledArchive = join(browserImageDir, "dreamflutter-sandbox.tar.gz");
const browserLockBytes = readFileSync(new URL("../sandbox-browser.lock.json", import.meta.url));
const browserLock = JSON.parse(browserLockBytes.toString("utf8"));

it("T104 09 identifies the pinned browser and existing Chinese font in the bundled image", { skip: !existsSync(bundledArchive) }, async () => {
	const info = JSON.parse(readFileSync(join(browserImageDir, "dreamflutter-sandbox.json"), "utf8"));
	const inventory = new Map(readFileSync(join(browserImageDir, "dreamflutter-sandbox.packages.txt"), "utf8").trim()
		.split(/\r?\n/).map(line => line.split("\t") as [string, string]));
	assert.deepEqual(info.browserLayer?.package, browserLock.browser);
	assert.deepEqual(info.browserLayer?.font, browserLock.font);
	assert.equal(info.browserLayer.lockSha256, createHash("sha256").update(browserLockBytes).digest("hex"));
	assert.equal(info.browserLayer.baseSha256, info.officeLayer.sha256);
	assert.equal(inventory.get(browserLock.browser.name), browserLock.browser.version);
	assert.equal(inventory.get(browserLock.font.name), browserLock.font.version);
	assert.equal(inventory.size, info.packages);
	assert.equal(statSync(bundledArchive).size, info.bytes);
	const hash = createHash("sha256");
	for await (const data of createReadStream(bundledArchive)) hash.update(data);
	assert.equal(hash.digest("hex"), info.sha256);
});

const verificationDistro = process.env.DF_T104_BUNDLED_DISTRO;
it("T104 09 renders Chinese from a clean import of the bundled WSL image", { skip: !verificationDistro }, async test => {
	assert.match(verificationDistro!, /^DF-T104-Verify-[a-f0-9]{32}$/);
	const wsl = (command: string, ...args: string[]) =>
		runWsl(["-d", verificationDistro!, "-u", "agent", "--cd", "/", "--exec", command, ...args], { timeoutMs: 20_000 });
	const t = await setup(test, '<!doctype html><meta charset="utf-8"><style>body{font:32px "WenQuanYi Micro Hei";color:#123456}</style>' +
		"<h1>蝶君截图验证</h1><p>文泉驿微米黑：中文标题与正文。</p>");
	const env: ExecEnv = {
		kind: "sandbox", resolve: posix.resolve, local: path => join(t.workspace, posix.relative("/workspace", path)),
		spawn: () => { throw new Error("unexpected spawn"); },
	};
	const install = test.mock.method(SandboxHtmlBrowser.prototype, "install", async () => { throw new Error("bundle must need no installation"); });
	const tool = renderHtmlTool({ on: () => () => {} } as unknown as ExtensionAPI, new HarnessState("/workspace", env), undefined,
		{ distro: verificationDistro!, ready: async () => {} });
	const ctx = { sessionManager: { getSessionId: () => "verify" } } as Parameters<typeof tool.execute>[4];
	const run = async () => {
		const started = performance.now();
		const png = Buffer.from(image(await tool.execute("tool", { file_path: "page.html" }, undefined, undefined, ctx) as Result).data, "base64");
		assert.deepEqual(imageSize(png, "image/png"), { width: 1280, height: 800 });
		return { png, ms: Math.round(performance.now() - started) };
	};
	const first = await run(), second = await run();
	assert.equal(install.mock.callCount(), 0);
	const version = await wsl("/usr/bin/dpkg-query", "-W", "-f=${Version}", browserLock.browser.name);
	assert.deepEqual([version.code, version.stdout.trim()], [0, browserLock.browser.version]);
	const font = await wsl("/usr/bin/fc-match", "-f", "%{family}", "WenQuanYi Micro Hei:lang=zh-cn");
	assert.equal(font.code, 0);
	assert.match(font.stdout, /WenQuanYi Micro Hei/);
	if (process.env.DF_T104_BUNDLED_PNG) writeFileSync(process.env.DF_T104_BUNDLED_PNG, first.png, { flag: "wx" });
	test.diagnostic(`Fresh WSL import: first ${first.ms} ms, second ${second.ms} ms, ${font.stdout.trim()}`);
});

it("T104 08 preserves the screenshot in JSONL and gives text-only models its path", realEdge, async test => {
	const t = await setup(test, "<h1>Text model</h1>", true);
	let seen: Result | undefined;
	const result = await prompt(t, {}, context => {
		seen = context.messages.findLast(message => message.role === "toolResult") as Result | undefined;
		return fauxAssistantMessage("已收到路径");
	});
	image(result);
	assert.ok(seen?.content.every(block => block.type === "text"));
	assert.ok(textOf(seen?.content).includes(result.details.imagePaths![0] + "（当前模型看不到图片）"));
});
