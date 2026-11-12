import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, it } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SandboxShell } from "../src/agent/sandbox-shell.ts";
import { createBackup } from "../src/backup/export.ts";
import { stageBackup } from "../src/backup/restore.ts";
import { Core } from "../src/core.ts";
import { Logger } from "../src/log.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

interface Job {
	id: string; session_file: string | null; slot_id: string; cwd: string; sandboxed: boolean;
	kind: string; label: string; command: string | null; service: boolean; status: string; exit_code: number | null;
	detail: string | null; started_at: number; ended_at: number | null; stopped_by: string | null;
	output_path: string | null; outputBytes: number;
}
interface JobOutput { text: string; next: number; truncated: boolean; ended: boolean }
const SLOT = "jobs-window";
const windows = { skip: process.platform !== "win32" };
let t: TestCore;
beforeEach(async () => {
	t = await startTestCore();
	t.core.settings.update({ approvalMode: "off" });
});
afterEach(async () => { await t.cleanup(); });

type ToolArgs = Parameters<typeof fauxToolCall>[1];
const tool = (name: string, params: ToolArgs) => fauxAssistantMessage(fauxToolCall(name, params), { stopReason: "toolUse" });
const shell = (command: string, extra: ToolArgs = {}) =>
	tool("pwsh", { description: "运行验收作业", command, run_in_background: true, ...extra });
const reply = () => fauxAssistantMessage("已收到");

async function openAndPrompt(options: { sandbox?: boolean; incognito?: boolean } = {}): Promise<void> {
	await t.core.call("slot.open", { slotId: SLOT, cwd: options.sandbox ? t.core.paths.butterflyDir : t.workspace, ...options }, t.client);
	await t.send(SLOT, { id: "jobs-prompt", type: "prompt", message: "开始测试作业" });
}
function list(params = {}): Promise<Job[]> { return t.core.call("jobs.list", params) as Promise<Job[]>; }
function output(id: string, from?: number): Promise<JobOutput> { return t.core.call("jobs.output", { id, from }) as Promise<JobOutput>; }
function stop(id: string) { return t.core.call("jobs.stop", { id }); }

it("T108 Q-01 restores job history with unavailable output even if a local cache file has the same name", async () => {
	const id = "restore-job";
	const cache = join(t.core.paths.cacheDir, "jobs");
	mkdirSync(cache, { recursive: true });
	const log = join(cache, id + ".log");
	writeFileSync(log, "original output");
	t.core.db.run(`INSERT INTO jobs(id,slot_id,cwd,sandboxed,kind,label,status,exit_code,started_at,ended_at,output_path)
		VALUES(?,'slot',?,0,'pwsh','缓存夹具','completed',0,1,2,?)`, id, t.workspace, log);
	assert.equal((await output(id)).text, "original output");
	const out = join(t.dir, "job.dfbackup");
	await createBackup({ paths: t.core.paths, agentDir: t.agentDir, sessionsDir: t.sessionDir,
		db: t.core.db.raw, appVersion: "0.9.0" }, { out, kind: "manual", credentials: "none", includeMaterials: false });
	const stage = await stageBackup(out, { paths: t.core.paths, agentDir: t.agentDir, sessionsDir: t.sessionDir,
		appVersion: "0.9.0" }, { parts: t.core.backupParts });
	const appdata = join(stage.dir, "raw", "data", "appdata");
	assert.equal(existsSync(join(appdata, "cache", "jobs", id + ".log")), false);
	const restored = new Core({ paths: { ...t.core.paths, dbFile: join(appdata, "core.db") },
		agentDir: t.agentDir, sessionDir: t.sessionDir, log: new Logger(), notifier: t.notifier });
	try {
		const jobs = await restored.call("jobs.list", {}) as Job[];
		assert.equal(jobs.find(row => row.id === id)?.exit_code, 0);
		assert.deepEqual(await restored.call("jobs.output", { id }),
			{ text: "", next: 0, truncated: false, ended: true, available: false });
	} finally { await restored.shutdown(); }
});
async function started(): Promise<string> {
	const event = await t.waitFor(() => t.messages.find(event => event.event === "jobs.changed" && event.status === "running"), 15_000);
	return String(event.id);
}
async function finished(id: string): Promise<Job> {
	await t.waitFor(() => t.messages.find(event => event.event === "job.finished" && event.id === id), 15_000);
	return (await list()).find(row => row.id === id)!;
}
function toolText(name: string): string | undefined {
	const record = t.records(SLOT).find(record => record.type === "tool_execution_end" && record.toolName === name);
	return (record?.result as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text;
}
async function waitForFileOutput(id: string, text: string): Promise<void> {
	await t.waitFor(() => {
		const file = t.core.db.get<{ output_path: string | null }>("SELECT output_path FROM jobs WHERE id=?", id)?.output_path;
		return file ? readFileSync(file, "utf8").includes(text) : false;
	}, 15_000);
}

it("T101 01 lists a real managed PowerShell process and emits its start, finish and exit code", windows, async () => {
	t.respond(shell("Start-Sleep -Milliseconds 400; Write-Output 'job-finished'; exit 7"), reply(), reply());
	await openAndPrompt();
	const id = await started();
	const [initial] = await list({ slotId: SLOT });
	assert.equal(initial?.id, id);
	assert.equal(initial.kind, "pwsh");
	assert.equal(initial.label, "运行验收作业");
	assert.equal(initial.cwd, t.workspace);
	assert.ok(initial.session_file);
	assert.equal((await list({ sessionFile: initial.session_file.toUpperCase() }))[0]?.id, id);
	assert.deepEqual(await list({ slotId: "other-slot" }), []);
	const ended = await finished(id);
	assert.equal(ended.status, "failed");
	assert.equal(ended.exit_code, 7);
	assert.ok(ended.ended_at! >= ended.started_at);
	assert.deepEqual((await list({ status: "failed" })).map(row => row.id), [id]);
	assert.match((await output(id)).text, /job-finished/);
	const changes = t.messages.filter(event => event.event === "jobs.changed" && event.id === id);
	assert.deepEqual(changes.map(event => event.status), ["running", "failed"]);
	assert.equal(changes.at(-1)?.sessionFile, ended.session_file);
});

it("T101 02 reads UTF-8 increments for the window without advancing model job_output", windows, async () => {
	let release!: () => void;
	const hold = new Promise<void>(resolve => { release = resolve; });
	t.respond(shell("Write-Output '第一段'; while (-not (Test-Path -LiteralPath 'next-part')) { Start-Sleep -Milliseconds 30 }; Write-Output '第二段'; Start-Sleep -Seconds 30"),
		async () => {
			await hold;
			const [row] = await list({ slotId: SLOT });
			return tool("job_output", { job_id: row!.id });
		}, reply(), reply());
	try {
		await openAndPrompt();
		const id = await started();
		await waitForFileOutput(id, "第一段");
		const first = await output(id);
		assert.match(first.text, /^第一段\r?\n$/);
		assert.equal(first.next, Buffer.byteLength(first.text));
		assert.equal(first.ended, false);
		assert.equal((await output(id, first.next)).text, "");
		release();
		const modelText = await t.waitFor(() => toolText("job_output"), 10_000);
		assert.equal(modelText, first.text + "[status: running]");
		writeFileSync(join(t.workspace, "next-part"), "");
		await waitForFileOutput(id, "第二段");
		const second = await output(id, first.next);
		assert.match(second.text, /^第二段\r?\n$/);
		assert.equal(second.next, first.next + Buffer.byteLength(second.text));
		await stop(id);
	} finally { release(); }
});

it("T101 03 stops a PowerShell job for the user and delivers the model's completion notice", windows, async () => {
	t.respond(shell("Start-Sleep -Seconds 30"), reply(), reply());
	await openAndPrompt();
	const id = await started();
	await t.waitFor(() => settledCount(t.records(SLOT)) >= 1);
	assert.deepEqual(await stop(id), { ok: true, status: "cancelled" });
	const row = await finished(id);
	assert.equal(row.stopped_by, "user");
	assert.equal(row.detail, "用户停止了这个作业");
	await t.waitFor(() => t.records(SLOT).find(record => JSON.stringify(record).includes("用户停止了这个作业")));
	assert.equal((await output(id)).ended, true);
});

it("T101 04 recovers orphaned jobs as lost and reads their saved output across a UTF-8 page boundary", async () => {
	const id = randomUUID();
	const path = join(t.core.paths.cacheDir, "jobs", id + ".log");
	mkdirSync(dirname(path), { recursive: true });
	const first = "a".repeat(64 * 1024 - 1);
	writeFileSync(path, first + "结束");
	t.core.db.run("INSERT INTO jobs(id,slot_id,cwd,sandboxed,kind,label,service,status,started_at,output_path) VALUES(?,?,?,0,'pwsh','模拟中断作业',0,'running',?,?)",
		id, SLOT, t.workspace, Date.now() - 5000, path);
	t = await t.reopen();
	const [lost] = await list({ status: "lost" });
	assert.equal(lost?.id, id);
	assert.equal(lost.detail, "后台重启时这个作业已经不在了");
	assert.equal(lost.outputBytes, Buffer.byteLength(first + "结束"));
	const part = await output(id);
	assert.deepEqual(part, { text: first, next: first.length, truncated: true, ended: true });
	assert.deepEqual(await output(id, part.next), { text: "结束", next: lost.outputBytes, truncated: false, ended: true });
});

it("T101 05 lists a subagent, exposes its completed text and can stop it without stopping its parent", async () => {
	const file = join(t.workspace, "subagent-example.txt");
	writeFileSync(file, "test");
	let blocked = false;
	t.respond(tool("agent", { role: "explore", description: "查一项资料", prompt: "读测试文件" }),
		fauxAssistantMessage([fauxText("已经查到第一段"), fauxToolCall("read", { path: file })], { stopReason: "toolUse" }),
		(_context, options) => new Promise((_resolve, reject) => {
			assert.ok(options?.signal);
			blocked = true;
			options.signal.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
		}), fauxAssistantMessage("主对话继续"));
	await openAndPrompt();
	const id = await started();
	await t.waitFor(() => blocked);
	const [row] = await list({ slotId: SLOT, status: "running" });
	assert.equal(row?.kind, "subagent");
	assert.equal(row.label, "查一项资料");
	assert.equal(row.command, null);
	assert.match((await output(id)).text, /已经查到第一段/);
	await stop(id);
	assert.equal((await finished(id)).stopped_by, "user");
	await t.waitFor(() => settledCount(t.records(SLOT)) === 1);
	assert.match(toolText("agent")!, /user stopped the subagent/i);
	assert.equal(t.faux.state.callCount, 4);
});

it("T101 06 removes provider keys and explicitly named short credentials from persisted commands", windows, async () => {
	const key = "sk-t101syntheticOnly0123456789";
	const short = "t101-local-test-token";
	t.respond(shell(`$env:DF_TEST_API_KEY='${short}'; $x='${key}'; Start-Sleep -Milliseconds 500`), reply(), reply());
	await openAndPrompt();
	const id = await started();
	const command = t.core.db.get<{ command: string }>("SELECT command FROM jobs WHERE id=?", id)!.command;
	assert.ok(!command.includes(key));
	assert.ok(!command.includes(short));
	assert.match(command, /已遮盖/);
	assert.match(command, /Start-Sleep/);
	await finished(id);
});

it("T101 07 saves the explicitly declared service flag and defaults ordinary work to false", windows, async () => {
	t.respond(shell("Start-Sleep -Seconds 30", { description: "模拟开发服务", service: true }),
		shell("Start-Sleep -Seconds 30", { description: "一次性任务" }), reply(), reply(), reply());
	await openAndPrompt();
	await t.waitFor(() => t.messages.filter(event => event.event === "jobs.changed" && event.status === "running").length === 2, 15_000);
	const rows = await list();
	assert.equal(rows.find(row => row.label === "模拟开发服务")?.service, true);
	assert.equal(rows.find(row => row.label === "一次性任务")?.service, false);
	for (const row of rows) await stop(row.id);
});

it("T101 08 retains the model job_list, job_output and job_kill strings and attributes a model stop", windows, async () => {
	const command = "Start-Sleep -Seconds 30";
	t.respond(shell(command), tool("job_list", {}), async () => tool("job_output", { job_id: await started() }),
		async () => tool("job_kill", { job_id: await started(), reason: "test end" }), reply());
	await openAndPrompt();
	const id = await started();
	const row = await finished(id);
	await t.waitFor(() => settledCount(t.records(SLOT)) === 1);
	assert.equal(toolText("job_list"), id + " [pwsh] running — " + command);
	assert.equal(toolText("job_output"), "(no new output)\n[status: running]");
	assert.equal(toolText("job_kill"), "requested cancellation of job " + id);
	assert.equal(row.status, "cancelled");
	assert.equal(row.stopped_by, "model");
	assert.equal(row.detail, "test end");
});

it("T101 09 registers managed Bash in the butterfly sandbox and stops it through the control pipe", windows, async test => {
	t.core.sandboxProvider = () => ({ distro: "df-t101-fake", ready: async () => {}, online: () => false });
	test.mock.method(SandboxShell.prototype, "run", async () => "/workspace/t101");
	const realSpawn = childProcess.spawn;
	let wslArgs: string[] = [];
	const mocked = test.mock.method(childProcess, "spawn", (file: string, args: string[], options: childProcess.SpawnOptions) => {
		if (file !== "wsl.exe") return realSpawn(file, args, options);
		wslArgs = args;
		return realSpawn(process.execPath, ["-e", "console.log('模拟 Bash 输出');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], options);
	});
	syncBuiltinESMExports();
	try {
		t.respond(tool("bash", { command: "printf 'job\\n'", description: "检查沙箱", run_in_background: true, service: true }), reply(), reply());
		await openAndPrompt({ sandbox: true });
		const id = await started();
		await waitForFileOutput(id, "模拟 Bash 输出");
		const [row] = await list({ slotId: SLOT });
		assert.equal(row?.kind, "bash");
		assert.equal(row.sandboxed, true);
		assert.equal(row.service, true);
		assert.equal(row.cwd, "/workspace/t101");
		assert.deepEqual(wslArgs.slice(0, 8), ["-d", "df-t101-fake", "-u", "agent", "--cd", "/workspace/t101", "--exec", "bash"]);
		await stop(id);
		assert.equal((await finished(id)).stopped_by, "user");
	} finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

it("T101 10 stops a live job at shutdown and leaves its cancelled outcome and output in the database", windows, async () => {
	t.respond(shell("Write-Output '仍可查'; Start-Sleep -Seconds 30"), reply());
	await openAndPrompt();
	const id = await started();
	await waitForFileOutput(id, "仍可查");
	await t.core.shutdown();
	const db = new DatabaseSync(t.core.paths.dbFile, { readOnly: true });
	try {
		const row = db.prepare("SELECT status,stopped_by,output_path FROM jobs WHERE id=?").get(id);
		assert.equal(row?.status, "cancelled");
		assert.equal(row.stopped_by, "shutdown");
		assert.match(readFileSync(String(row.output_path), "utf8"), /仍可查/);
	} finally { db.close(); }
});

it("T101 11 shows incognito jobs only for the life of the slot and does not persist their metadata or output", windows, async () => {
	t.respond(shell("Write-Output '无痕输出'; Start-Sleep -Seconds 30"), reply(), reply());
	await openAndPrompt({ incognito: true });
	const id = await started();
	await t.waitFor(() => t.records(SLOT).some(record => record.type === "agent_settled"));
	const deadline = Date.now() + 5000;
	while (!(await output(id)).text.includes("无痕输出") && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.match((await output(id)).text, /无痕输出/);
	assert.equal((await list({ slotId: SLOT }))[0]?.output_path, null);
	assert.equal(t.core.db.get("SELECT 1 FROM jobs WHERE id=?", id), undefined);
	await stop(id);
	await t.core.closeSlot(SLOT);
	assert.deepEqual(await list({ slotId: SLOT }), []);
});
