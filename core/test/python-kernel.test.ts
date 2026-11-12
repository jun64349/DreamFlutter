import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { crc32, deflateSync } from "node:zlib";
import { it, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { imageSize } from "../src/agent/fs-tools.ts";
import { PythonKernel } from "../src/agent/python-kernel.ts";
import { sandboxEnv } from "../src/agent/state.ts";
import { runWsl } from "../src/sandbox/sandbox.ts";
import { TasksModule } from "../src/modules/tasks.ts";
import { textOf } from "../src/runs.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

const SLOT = "t103";
const FAKE = "df-t103-fake";
const windows = { skip: process.platform !== "win32" };

const fakeWorker = String.raw
`
const rl = require("node:readline").createInterface({ input: process.stdin });
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const owner = process.argv[2];
const send = (kind, rest) => console.log(JSON.stringify({kind,...rest}));
const control = (kind, rest) => console.error(JSON.stringify({kind,owner,...rest}));
const cleaned = () => control("cleanup_done");
const done = (status = "completed") => send("done", {status});
const say = text => send("output", {text});
let booted = false;
let value;
let hold;
process.on("message", action => {
  if (action === "kill") process.exit(0);
  if (action === "interrupt" && hold === "soft") {
    hold = undefined;
    done("interrupted");
  }
});
rl.on("line", line => {
  if (!booted) {
    booted = true;
    control("kernel_group", {pid:process.pid, start:"123"});
    send("ready");
    return;
  }
  if (line === "interrupt") {
    if (hold === "soft") { hold = undefined; done("interrupted"); }
    return;
  }
  const {code} = JSON.parse(line);
  if (code === "x = 41") value = 41;
  if (code === "x + 1") {
    if (value === undefined) { say("Traceback\nNameError: x\n"); done("failed"); return; }
    say(String(value + 1) + "\n");
  }
  if (code === "soft" || code === "hard") { hold = code; return; }
  if (code === "crash") {
    say("cleanup started\n");
    setTimeout(() => { say("cleanup finished\n"); cleaned(); process.exit(0); }, 220);
    return;
  }
  if (code === "slow-close" || code === "hang-close") hold = code;
  if (code === "background") {
    say("后台进度一\n");
    setTimeout(() => { say("后台进度二\n"); done(); }, 1100);
    return;
  }
  if (["plot", "large", "many", "many-bytes"].includes(code)) {
    const data = fs.readFileSync(path.join(root, code === "large" ? "large.png" : code === "many-bytes" ? "noisy.png" : "small.png"));
    for (let i = 0; i < (code.startsWith("many") ? 11 : 1); i++) {
    const name = "python-" + require("node:crypto").randomBytes(12).toString("hex") + ".png";
    fs.writeFileSync(path.join(root, name), data);
    send("figure", {name, data:data.toString("base64"), mime:"image/png"});
    }
  }
  done();
});
rl.on("close", () => {
  process.send("closing");
  if (hold === "hang-close") { setInterval(() => {}, 1000); return; }
  const finish = () => { cleaned(); process.exit(0); };
  if (hold === "slow-close") setTimeout(finish, 500); else finish();
});
`;

function fakeSandbox(test: TestContext, root = process.cwd(), fallbackCode = 0) {
	const children = new Map<number, ChildProcess>();
	const launches: string[][] = [];
	const fallbacks: string[][] = [];
	let onClose!: () => void;
	const closing = new Promise<void>(resolve => { onClose = resolve; });
	let starts = 0;
	const spawn = childProcess.spawn;
	const hook = test.mock.method(childProcess, "spawn", (program: string, args: string[], options: SpawnOptions) => {
		if (program !== "wsl.exe" || args[1] !== FAKE) return spawn(program, args, options);
		if (args.includes("--cd")) {
			starts++;
			launches.push(args);
			const child = spawn(process.execPath, ["-e", fakeWorker, root, args.at(-1)!], { ...options, stdio: ["pipe", "pipe", "pipe", "ipc"] });
			const pid = child.pid!;
			children.set(pid, child);
			child.on("message", message => { if (message === "closing") onClose(); });
			child.once("close", () => children.delete(pid));
			return child;
		}
		fallbacks.push(args);
		return spawn(process.execPath, ["-e", `process.exit(${fallbackCode})`], options);
	});
	syncBuiltinESMExports();
	return {
		starts: () => starts,
		launches,
		fallbacks,
		closing,
		current: () => [...children.values()].at(-1)!,
		restore() {
			for (const child of children.values()) child.kill();
			hook.mock.restore();
			syncBuiltinESMExports();
		},
	};
}

function makePng(width: number, height: number, noisy = false): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const chunk = (tag: string, data: Buffer) => {
		const typed = Buffer.concat([Buffer.from(tag), data]);
		const size = Buffer.alloc(4);
		const checksum = Buffer.alloc(4);
		size.writeUInt32BE(data.length);
		checksum.writeUInt32BE(crc32(typed));
		return Buffer.concat([size, typed, checksum]);
	};
	const stride = 1 + width * 3, pixels = noisy ? randomBytes(stride * height) : Buffer.alloc(stride * height);
	for (let offset = 0; offset < pixels.length; offset += stride) pixels[offset] = 0;
	return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
		chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

type Block = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };
type Result = { content: Block[]; details: { imagePaths?: string[]; path?: string } };
type ToolArgs = Parameters<typeof fauxToolCall>[1];
const tool = (name: string, args: ToolArgs) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const reply = () => fauxAssistantMessage("收到");

async function coreTest(test: TestContext, callback: (t: TestCore) => Promise<void>) {
	const t = await startTestCore();
	const fake = fakeSandbox(test, t.workspace);
	t.core.settings.update({ approvalMode: "off" });
	t.core.sandboxProvider = () => ({ distro: FAKE, ready: async () => {}, online: () => false });
	const tasks = t.core.module(TasksModule)!;
	const record = tasks.recordArtifact.bind(tasks);
	test.mock.method(tasks, "recordArtifact", (taskId: string, path: string) => record(taskId, join(t.workspace, basename(path))));
	writeFileSync(join(t.workspace, "small.png"), makePng(25, 20));
	writeFileSync(join(t.workspace, "large.png"), makePng(3000, 240));
	try { await callback(t); }
	finally { try { await t.cleanup(); } finally { fake.restore(); } }
}

async function open(t: TestCore, sandbox = true) {
	await t.core.call("slot.open", { slotId: SLOT, cwd: sandbox ? t.core.paths.butterflyDir : t.workspace, sandbox }, t.client);
}
async function prompt(t: TestCore, message = "执行检查") {
	const before = settledCount(t.records(SLOT));
	await t.send(SLOT, { id: "prompt-" + before, type: "prompt", message });
	await t.waitFor(() => settledCount(t.records(SLOT)) > before, 12_000);
}
function results(t: TestCore, name: string): Result[] {
	return t.records(SLOT).filter(r => r.type === "tool_execution_end" && r.toolName === name).map(r => r.result as Result);
}
function savedResults(t: TestCore, name: string): Result[] {
	const file = t.core.slot(SLOT).info().sessionFile;
	assert.ok(file);
	return readFileSync(file, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line))
		.filter(e => e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === name).map(e => e.message);
}
function image(result: Result): Extract<Block, { type: "image" }> {
	const block = result.content.find(b => b.type === "image");
	assert.ok(block && block.type === "image");
	return block;
}

it("T103 01 uses the same Python globals across two calls in a session", windows, test => coreTest(test, async t => {
	t.respond(tool("python", { code: "x = 41" }), reply(), tool("python", { code: "x + 1" }), reply());
	await open(t);
	await prompt(t);
	await prompt(t, "读取变量");
	assert.match(textOf(results(t, "python")[0]!.content), /内核是新开的/);
	assert.equal(textOf(results(t, "python")[1]!.content).trim(), "42");
}));

it("T103 02 saves a Python figure in the tool result, original PNG and task artifacts", windows, test => coreTest(test, async t => {
	t.respond(tool("python", { code: "plot" }), reply());
	await open(t);
	await prompt(t);
	const result = savedResults(t, "python")[0]!;
	assert.equal(image(result).mimeType, "image/png");
	const path = result.details.imagePaths?.[0];
	assert.match(path ?? "", /^\/workspace\/outbox\/[^/]+\/python-.*\.png$/);
	const taskId = t.core.slot(SLOT).taskId;
	assert.ok(taskId);
	const artifacts = await t.core.call("artifacts.list", { taskId }) as { path: string; exists: boolean }[];
	assert.ok(artifacts.some(row => row.path === join(t.workspace, basename(path!)) && row.exists));
}));

async function kernelTest(test: TestContext, callback: (kernel: PythonKernel, fake: ReturnType<typeof fakeSandbox>) => Promise<void>, idleMs?: number) {
	const fake = fakeSandbox(test);
	const kernel = new PythonKernel({ distro: FAKE, ready: async () => {} }, idleMs, 190);
	try { await callback(kernel, fake); }
	finally { try { await kernel.close(); } finally { fake.restore(); } }
}
const noFiles = { folder: null, record: () => {} };
const run = (kernel: PythonKernel, code: string, timeout?: number) => kernel.run({ code, cwd: "/workspace", folder: null }, noFiles, { timeout });

it("T108 R-01 starts isolated Python only after sandbox readiness succeeds", windows, async test => {
	const fake = fakeSandbox(test);
	let allow = false;
	const order: number[] = [];
	const kernel = new PythonKernel({ distro: FAKE, ready: async () => {
		order.push(fake.starts());
		if (!allow) throw new Error("setup refused");
	} });
	try {
		const refused = await run(kernel, "x = 41");
		assert.deepEqual([refused.status, refused.text, fake.starts()], ["failed", "蝶君的沙箱还没准备好", 0]);
		allow = true;
		assert.equal((await run(kernel, "x = 41")).status, "completed");
		assert.deepEqual(order, [0, 0]);
		assert.ok(fake.launches[0]?.includes("-I"));
	} finally { try { await kernel.close(); } finally { fake.restore(); } }
});

it("T107 queued Python cancellation settles before its predecessor finishes", windows, test => kernelTest(test, async kernel => {
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const head = kernel.run({ code: "background", cwd: "/workspace", folder: null }, noFiles, {},
		text => { if (text.includes("后台进度一")) entered(); });
	await started;
	const cancel = new AbortController();
	const queued = kernel.run({ code: "x = 41", cwd: "/workspace", folder: null }, noFiles, { signal: cancel.signal });
	cancel.abort();
	try {
		assert.equal(await Promise.race([queued.then(result => result.status), delay(150, "still queued")]), "interrupted");
	} finally { await Promise.allSettled([head, queued]); }
	assert.equal((await head).status, "completed");
	assert.match((await run(kernel, "x + 1")).text, /NameError/);
}));

it("T108 R-02 publishes a stopped queued job while the head is still running", windows, test => coreTest(test, async t => {
	t.respond(tool("python", { code: "background", background: true }), tool("python", { code: "x = 41", background: true }), reply());
	await open(t);
	await prompt(t);
	const jobs = await t.core.call("jobs.list", { slotId: SLOT }) as { id: string; status: string; started_at: number }[];
	const [head, queued] = jobs.slice().reverse();
	assert.equal(head?.status, "running");
	assert.equal(queued?.status, "running");
	await t.core.call("jobs.stop", { id: queued!.id });
	assert.ok(t.messages.some(event => event.event === "job.finished" && event.id === queued!.id && event.status === "cancelled"));
	assert.ok(!t.messages.some(event => event.event === "job.finished" && event.id === head!.id));
}));

it("T108 R-03 waits for supervisor cleanup before settling a crashed kernel", windows, test => kernelTest(test, async (kernel, fake) => {
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const crashed = kernel.run({ code: "crash", cwd: "/workspace", folder: null }, noFiles, {}, text => {
		if (text.includes("cleanup started")) entered();
	});
	await started;
	const supervisor = fake.launches[0]?.find(arg => arg.includes("os.waitid"));
	assert.match(supervisor ?? "", /os\.killpg\(worker\.pid, signal\.SIGKILL\)/);
	assert.equal(await Promise.race([crashed.then(() => "settled"), delay(60, "cleaning")]), "cleaning");
	assert.match((await crashed).text, /cleanup finished[\s\S]*内核意外关闭/);
	assert.equal(fake.fallbacks.length, 0);
}));

it("T111 uses the recorded group for fallback when the supervisor dies without cleanup", windows, test => kernelTest(test, async (kernel, fake) => {
	await run(kernel, "x = 41");
	const worker = fake.current();
	worker.kill();
	await new Promise<void>(resolve => worker.once("close", resolve));
	assert.match((await run(kernel, "x + 1")).text, /NameError/);
	assert.deepEqual(fake.fallbacks.map(args => args.slice(-3)), [[fake.launches[0]?.at(-1), String(worker.pid), "123"]]);
}));

it("T111 falls back after five seconds and logs a failed cleanup without hanging", windows, async test => {
	const fake = fakeSandbox(test, process.cwd(), 1);
	const errors: string[] = [];
	const kernel = new PythonKernel({ distro: FAKE, ready: async () => {} }, undefined, undefined, message => errors.push(message));
	try {
		await run(kernel, "hang-close");
		const start = performance.now();
		const closed = kernel.close();
		assert.equal(await Promise.race([closed.then(() => "closed"), delay(7200, "hung", { ref: false })]), "closed");
		assert.ok(performance.now() - start >= 4950);
		assert.equal(fake.fallbacks.length, 1);
		assert.match(errors.join("\n"), /清理失败.*停用/);
	} finally { fake.current()?.kill(); try { await kernel.close(); } finally { fake.restore(); } }
});

it("T111 waits for in-flight idle cleanup before starting another kernel", windows, test => kernelTest(test, async (kernel, fake) => {
	await run(kernel, "slow-close");
	await fake.closing;
	const next = run(kernel, "x = 41");
	assert.equal(await Promise.race([next.then(() => "started"), delay(140, "cleaning")]), "cleaning");
	assert.equal(fake.starts(), 1);
	assert.equal((await next).status, "completed");
	assert.equal(fake.starts(), 2);
}, 30));

it("T111 session shutdown shares in-flight idle cleanup", windows, test => kernelTest(test, async (kernel, fake) => {
	await run(kernel, "slow-close");
	await fake.closing;
	const closed = kernel.close();
	assert.equal(await Promise.race([closed.then(() => "closed"), delay(100, "cleaning")]), "cleaning");
	await closed;
	assert.equal(fake.fallbacks.length, 0);
}, 30));

const t111Distro = process.env.DF_T111_WSL_DISTRO;
it("T111 real WSL cleans the worker and children after the supervisor is killed", { skip: !t111Distro }, async () => {
	assert.match(t111Distro!, /^DF-T111-[a-f0-9]{32}$/);
	const sandbox = { distro: t111Distro!, ready: async () => {} };
	const kernel = new PythonKernel(sandbox), sibling = new PythonKernel(sandbox);
	const command = (...args: string[]) => runWsl(["-d", t111Distro!, "-u", "agent", "--exec", ...args], { timeoutMs: 5000 });
	try {
		assert.equal((await run(sibling, "x = 41")).status, "completed");
		let identity: number[] | undefined;
		const result = kernel.run({ code: "import os, subprocess, time\na = subprocess.Popen(['/usr/bin/sleep', '45'], env={})\nb = subprocess.Popen(['/usr/bin/sleep', '45'], start_new_session=True)\nprint(f'owners {os.getppid()} {os.getpid()} {a.pid} {b.pid}')\ntime.sleep(45)", cwd: "/workspace", folder: null },
			noFiles, { timeout: 15 }, text => { const match = /owners (\d+) (\d+) (\d+) (\d+)/.exec(text); if (match) identity = match.slice(1).map(Number); });
		for (let attempt = 0; attempt < 100 && !identity; attempt++) await delay(50);
		assert.ok(identity);
		const [supervisor, ...pids] = identity;
		assert.equal((await command("/usr/bin/kill", "-KILL", String(supervisor))).code, 0);
		assert.equal((await Promise.race([result, delay(7000, undefined, { ref: false })]))?.status, "failed");
		for (const pid of pids) {
			const check = await command("/usr/bin/test", "-d", `/proc/${pid}`);
			assert.equal(check.code, 1, `process ${pid} was not reaped`);
		}
		assert.match((await run(sibling, "x + 1")).text, /42/);
	} finally { await kernel.close(); await sibling.close(); }
});

const realDistro = process.env.DF_T108_WSL_DISTRO;
const realWsl = { skip: !realDistro };
it("T108 R-03 real WSL reaps a child and a detached child when the kernel dies", realWsl, async () => {
	assert.match(realDistro!, /^DF-T108-[a-f0-9]{32}$/);
	const kernel = new PythonKernel({ distro: realDistro!, ready: async () => {} });
	try {
		const start = performance.now();
		const result = await run(kernel, "import os, signal, subprocess\nquiet = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\na = subprocess.Popen(['/usr/bin/sleep', '45'], **quiet)\nb = subprocess.Popen(['/usr/bin/sleep', '45'], start_new_session=True, **quiet)\nprint(f'children {a.pid} {b.pid}')\nos.kill(os.getpid(), signal.SIGKILL)", 8);
		assert.equal(result.status, "failed");
		assert.ok(performance.now() - start < 12_000, "the worker settled without waiting for the children's own timers");
		const pids = /children (\d+) (\d+)/.exec(result.text)?.slice(1);
		assert.equal(pids?.length, 2, result.text);
		for (const pid of pids!) {
			const check = await runWsl(["-d", realDistro!, "-u", "agent", "--exec", "/usr/bin/test", "-d", "/proc/" + pid]);
			assert.equal(check.code, 1);
		}
		assert.match((await run(kernel, "40 + 2")).text, /42/);
	} finally { await kernel.close(); }
});

it("T108 R-06 real WSL scales a large canvas before writing its PNG", realWsl, async () => {
	assert.match(realDistro!, /^DF-T108-[a-f0-9]{32}$/);
	const kernel = new PythonKernel({ distro: realDistro!, ready: async () => {} });
	try {
		const folder = "/workspace/t108-preview";
		const result = await kernel.run({ cwd: "/workspace", folder,
			code: "import matplotlib.pyplot as plt\nfig, ax = plt.subplots(figsize=(60, 50), dpi=100)\nax.plot([1, 2], [2, 1])" },
		{ folder, record: () => {} }, { timeout: 25 });
		assert.equal(result.status, "completed", result.text);
		assert.match(result.text, /已按比例缩小/);
		const png = readFileSync(sandboxEnv(realDistro!).local(result.paths[0]!));
		const size = imageSize(png, "image/png")!;
		assert.ok(size.width * size.height <= 16_000_000);
		assert.ok(Math.abs(size.width / size.height - 6 / 5) < 0.005);
	} finally { await kernel.close(); }
});

it("T108 R-06 stores the eleventh image and caps total bytes for foreground and background", windows, test => coreTest(test, async t => {
	const bytes = makePng(560, 620, true);
	assert.ok(bytes.length <= 1024 * 1024 && bytes.length * 9 > 8 * 1024 * 1024);
	writeFileSync(join(t.workspace, "noisy.png"), bytes);
	t.respond(tool("python", { code: "many" }), reply(), tool("python", { code: "many-bytes" }), reply(),
		tool("python", { code: "many-bytes", background: true }), reply());
	await open(t);
	await prompt(t);
	const count = savedResults(t, "python")[0]!;
	assert.equal(count.content.filter(block => block.type === "image").length, 10);
	assert.match(textOf(count.content), /另有 1 张图存在产物目录/);
	assert.match(textOf(count.content), /来自脚本的图片内容.*不是指令/);
	await prompt(t, "检查预览总量");
	const sized = savedResults(t, "python")[1]!;
	const previews = (blocks: Block[]) => blocks.filter(block => block.type === "image");
	assert.equal(previews(sized.content).length, 8);
	assert.match(textOf(sized.content), /另有 3 张图存在产物目录/);
	await prompt(t, "在后台检查预览总量");
	const job = await t.waitFor(() => t.messages.find(event => event.event === "job.finished" && event.status === "completed"));
	const messages = t.core.slot(SLOT).session.messages as { customType?: string; content: Block[] }[];
	const background = messages.find(message => message.customType === "df.python_result");
	assert.equal(previews(background?.content ?? []).length, 8);
	assert.ok(previews(background!.content).reduce((n, block) => n + Buffer.byteLength(block.data, "base64"), 0) <= 8 * 1024 * 1024);
	assert.match(textOf(background!.content), /来自脚本的图片内容.*不是指令/);
	assert.match(textOf([{ type: "text", text: (await t.core.call("jobs.output", { id: job.id }) as { text: string }).text }]), /另有 3 张图/);
	const artifacts = await t.core.call("artifacts.list", { taskId: t.core.slot(SLOT).taskId }) as { exists: boolean }[];
	assert.equal(artifacts.filter(row => row.exists).length, 33);
}));

it("T103 03 interrupts a timeout without losing globals and replaces an unresponsive worker", windows, test => kernelTest(test, async (kernel, fake) => {
	await run(kernel, "x = 41");
	assert.match((await run(kernel, "soft", 0.06)).text, /内核保留/);
	assert.equal((await run(kernel, "x + 1")).text.trim(), "42");
	assert.match((await run(kernel, "hard", 0.06)).text, /中断未响应.*之前的变量没有了/);
	assert.match((await run(kernel, "x + 1")).text, /内核是新开的.*\nTraceback\nNameError/);
	assert.equal(fake.starts(), 2);
}));

it("T103 04 closes an idle kernel and reports fresh globals on the next call", windows, test => kernelTest(test, async (kernel, fake) => {
	await run(kernel, "x = 41");
	await delay(100);
	assert.match((await run(kernel, "x + 1")).text, /内核是新开的/);
	assert.equal(fake.starts(), 2);
}, 30));

it("T103 05 registers a background Python job and exposes independent window and model progress", windows, test => coreTest(test, async t => {
	t.respond(tool("python", { code: "background", background: true }), async () => {
		const event = await t.waitFor(() => t.messages.find(m => m.event === "jobs.changed" && m.status === "running"));
		const id = String(event.id);
		await t.waitFor(() => {
			const row = t.core.db.get<{ output_path: string | null }>("SELECT output_path FROM jobs WHERE id=?", id);
			return row?.output_path ? readFileSync(row.output_path, "utf8").includes("后台进度一") : false;
		});
		return tool("job_output", { job_id: id });
	}, reply(), reply());
	await open(t);
	await prompt(t);
	const id = await t.waitFor(() => t.messages.find(m => m.event === "job.finished" && m.status === "completed")?.id);
	const [job] = await t.core.call("jobs.list", { slotId: SLOT }) as { id: string; kind: string; status: string }[];
	assert.deepEqual([job?.id, job?.kind, job?.status], [id, "python", "completed"]);
	assert.deepEqual(t.messages.filter(m => m.event === "jobs.changed" && m.id === id).map(m => m.status), ["running", "completed"]);
	const output = await t.core.call("jobs.output", { id }) as { text: string };
	assert.match(output.text, /后台进度一\n后台进度二/);
	assert.match(textOf(results(t, "job_output")[0]!.content), /后台进度一/);
}));

it("T103 06 advertises Python only in a Butterfly session", windows, test => coreTest(test, async t => {
	await open(t, false);
	assert.ok(!t.core.slot(SLOT).session.getActiveToolNames().includes("python"));
	await t.core.call("slot.open", { slotId: "butterfly", cwd: t.core.paths.butterflyDir, sandbox: true }, t.client);
	assert.ok(t.core.slot("butterfly").session.getActiveToolNames().includes("python"));
}));

it("T103 07 projects tool images as text for the model and keeps them in session JSONL", windows, test => coreTest(test, async t => {
	t.core.settings.update({ defaultModel: "faux/faux-text" });
	let seen: Result | undefined;
	t.respond(tool("python", { code: "plot" }), (context: Context) => {
		seen = context.messages.findLast(m => m.role === "toolResult") as Result | undefined;
		return reply();
	});
	await open(t);
	await prompt(t);
	const actual = savedResults(t, "python")[0]!;
	image(actual);
	assert.ok(seen);
	assert.ok(seen.content.every(block => block.type === "text"));
	assert.ok(textOf(seen.content).includes("已生成图片：" + actual.details.imagePaths![0] + "（当前模型看不到图片）"));
}));

it("T103 08 downscales a large tool image while preserving its original PNG", windows, test => coreTest(test, async t => {
	t.respond(tool("python", { code: "large" }), reply());
	await open(t);
	await prompt(t);
	const result = savedResults(t, "python")[0]!;
	const preview = image(result);
	const original = join(t.workspace, basename(result.details.imagePaths![0]!));
	assert.ok(existsSync(original));
	assert.equal(imageSize(readFileSync(original), "image/png")?.width, 3000);
	assert.ok((imageSize(Buffer.from(preview.data, "base64"), preview.mimeType)?.width ?? Infinity) <= 1536);
}));

it("T103 09 returns a subagent image in the parent's tool result", windows, test => coreTest(test, async t => {
	const route = (context: Context) => {
		const messages = context.messages.filter(m => (m.role as string) !== "system");
		const last = messages.at(-1);
		const isChild = messages.some(m => m.role === "user" && textOf(m.content).includes("## Task"));
		if (last?.role === "toolResult") return reply();
		return isChild ? tool("read_image", { file_path: "small.png" })
			: tool("agent", { role: "explore", description: "查看图片", prompt: "读取 small.png" });
	};
	t.respond(route, route, route, route);
	await open(t, false);
	await prompt(t);
	const returned = savedResults(t, "agent")[0]!;
	assert.equal(image(returned).mimeType, "image/png");
	assert.equal(returned.details.imagePaths?.[0], join(t.workspace, "small.png"));
}));

it("T103 10 keeps read_image available to text-only sessions and saves the original tool image", windows, test => coreTest(test, async t => {
	t.core.settings.update({ defaultModel: "faux/faux-text" });
	let seen: Result | undefined;
	t.respond(tool("read_image", { file_path: "small.png" }), (context: Context) => {
		seen = context.messages.findLast(m => m.role === "toolResult") as Result | undefined;
		return reply();
	});
	await open(t, false);
	await prompt(t);
	image(savedResults(t, "read_image")[0]!);
	assert.match(textOf(seen?.content), /small\.png（当前模型看不到图片）/);
}));
