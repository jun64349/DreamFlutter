import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { crc32, deflateSync } from "node:zlib";
import { it, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { imageSize } from "../src/agent/fs-tools.ts";
import { PythonKernel } from "../src/agent/python-kernel.ts";
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
const send = (kind, rest) => console.log(JSON.stringify({kind,...rest}));
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
    send("ready", {pid:process.pid, start:"123"});
    return;
  }
  const {code} = JSON.parse(line);
  if (code === "x = 41") value = 41;
  if (code === "x + 1") {
    if (value === undefined) { say("Traceback\nNameError: x\n"); done("failed"); return; }
    say(String(value + 1) + "\n");
  }
  if (code === "soft" || code === "hard") { hold = code; return; }
  if (code === "background") {
    say("后台进度一\n");
    setTimeout(() => { say("后台进度二\n"); done(); }, 1100);
    return;
  }
  if (code === "plot" || code === "large") {
    const data = fs.readFileSync(path.join(root, code === "large" ? "large.png" : "small.png"));
    const name = "python-" + require("node:crypto").randomBytes(12).toString("hex") + ".png";
    fs.writeFileSync(path.join(root, name), data);
    send("figure", {name, data:data.toString("base64"), mime:"image/png"});
  }
  done();
});
rl.on("close", () => process.exit(0));
`;

function fakeSandbox(test: TestContext, root = process.cwd()) {
	const children = new Map<number, ChildProcess>();
	let starts = 0;
	const spawn = childProcess.spawn;
	const hook = test.mock.method(childProcess, "spawn", (program: string, args: string[], options: SpawnOptions) => {
		if (program !== "wsl.exe" || args[1] !== FAKE) return spawn(program, args, options);
		if (args.includes("--cd")) {
			starts++;
			const child = spawn(process.execPath, ["-e", fakeWorker, root], { ...options, stdio: ["pipe", "pipe", "pipe", "ipc"] });
			const pid = child.pid!;
			children.set(pid, child);
			child.once("close", () => children.delete(pid));
			return child;
		}
		const worker = children.get(Number(args.at(-3)));
		if (worker?.connected) worker.send(args.at(-1)!, () => {});
		return spawn(process.execPath, ["-e", ""], options);
	});
	syncBuiltinESMExports();
	return {
		starts: () => starts,
		restore() {
			for (const child of children.values()) child.kill();
			hook.mock.restore();
			syncBuiltinESMExports();
		},
	};
}

function makePng(width: number, height: number): Buffer {
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
	return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.alloc((1 + width * 3) * height, 0))), chunk("IEND", Buffer.alloc(0))]);
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
