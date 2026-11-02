import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { bundledPython, prepareWorkspace, toolchainEnv, workspaceGuidance, WORKSPACE_DIR, WORKSPACE_NOTES } from "../src/agent/toolchain.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

/** The workbench's runtime environment (roadmap 3.6). */
describe("workspace environment", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "df-toolchain-test-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("puts the shipped tools and Python first on PATH and keeps uv from downloading another Python", () => {
		const tools = join(dir, "bin");
		const python = join(dir, "python");
		const home = join(python, "cpython-3.13.18-windows-x86_64-none");
		mkdirSync(tools, { recursive: true });
		mkdirSync(home, { recursive: true });
		writeFileSync(join(home, process.platform === "win32" ? "python.exe" : "python3"), "");
		if (process.platform !== "win32") {
			mkdirSync(join(home, "bin"));
			writeFileSync(join(home, "bin", "python3"), "");
		}
		const env = toolchainEnv({ Path: "C:\\Windows\\System32" }, tools, python);
		const sep = process.platform === "win32" ? ";" : ":";
		assert.equal(env.PATH, undefined, "keeps Windows' own spelling of Path");
		assert.ok(env.Path!.startsWith(`${tools}${sep}`));
		assert.ok(env.Path!.endsWith(`${sep}C:\\Windows\\System32`));
		assert.equal(env.UV_PYTHON, bundledPython(python));
		assert.equal(env.UV_PYTHON_DOWNLOADS, "never");
		assert.equal(env.PYTHONUTF8, "1");
		// Nothing shipped (a development checkout): the environment is left as it was, plus UTF-8.
		const plain = toolchainEnv({ Path: "C:\\x" }, join(dir, "none"), join(dir, "none"));
		assert.equal(plain.Path, "C:\\x");
		assert.equal(plain.UV_PYTHON, undefined);
	});

	it("gives each workspace a .dreamflutter folder git ignores, and reads its notes", () => {
		const first = prepareWorkspace(dir);
		assert.equal(first.dir, join(dir, WORKSPACE_DIR));
		assert.equal(first.notes, undefined);
		assert.match(readFileSync(join(dir, WORKSPACE_DIR, ".gitignore"), "utf8"), /^\*$/m);
		writeFileSync(join(dir, WORKSPACE_DIR, WORKSPACE_NOTES), "# 周报工具\n运行：python make.py\n");
		assert.equal(prepareWorkspace(dir).notes, "# 周报工具\n运行：python make.py");
		const git = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" });
		if (git.status === 0 || spawnSync("git", ["init", "-q"], { cwd: dir }).status === 0) {
			const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" });
			assert.equal(status.stdout.trim(), "", "git does not see the folder");
		}
		// A workspace that cannot be written is left alone.
		assert.doesNotThrow(() => prepareWorkspace(join(dir, "missing", "\0bad")));
	});

	it("tells the agent where its own files go, with the notes and the tools", () => {
		const text = workspaceGuidance("运行：python make.py", ["The app provides rg, fd, uv on PATH for your commands."]);
		assert.match(text, /^# Workspace environment/);
		assert.match(text, /rg, fd, uv on PATH/);
		assert.match(text, /\.dreamflutter\\venv/);
		assert.match(text, /uv venv \.dreamflutter\\venv/);
		assert.match(text, /## \.dreamflutter\\workspace\.md\n运行：python make\.py/);
		const long = workspaceGuidance("x".repeat(10_000), []);
		assert.match(long, /cut here; read the file for the rest/);
		assert.ok(long.length < 8_000);
	});
});

describe("workspace environment in a session", () => {
	let t: TestCore;
	beforeEach(async () => {
		t = await startTestCore();
	});
	afterEach(async () => {
		await t.cleanup();
	});

	it("puts the workspace notes into the system prompt of workbench sessions, fresh every run", async () => {
		const prompts: string[] = [];
		const capture = (context: Context) => {
			const system = context.messages.filter((m) => (m.role as string) === "system") as unknown as { content: string }[];
			prompts.push(system.at(-1)?.content ?? "");
			return fauxAssistantMessage("好");
		};
		await t.core.call("slot.open", { slotId: "w", cwd: t.workspace }, t.client);
		const send = async (message: string) => {
			const before = settledCount(t.records("w"));
			await t.send("w", { id: `p-${Math.random()}`, type: "prompt", message });
			await t.waitFor(() => settledCount(t.records("w")) === before + 1);
		};
		t.respond(capture);
		await send("你好");
		assert.match(prompts[0]!, /# Workspace environment/);
		assert.ok(existsSync(join(t.workspace, WORKSPACE_DIR, ".gitignore")), "the folder exists from the first run");
		writeFileSync(join(t.workspace, WORKSPACE_DIR, WORKSPACE_NOTES), "这个工作区放周报。");
		t.respond(capture);
		await send("再来");
		assert.match(prompts[1]!, /## \.dreamflutter\\workspace\.md\n这个工作区放周报。/);
	});

	it("leaves the minimal mode's prompt alone", async () => {
		const prompts: string[] = [];
		t.respond((context: Context) => {
			const system = context.messages.filter((m) => (m.role as string) === "system") as unknown as { content: string }[];
			prompts.push(system.at(-1)?.content ?? "");
			return fauxAssistantMessage("好");
		});
		await t.core.call("slot.open", { slotId: "m", cwd: t.workspace, agentMode: "minimal" }, t.client);
		await t.send("m", { id: "p1", type: "prompt", message: "你好" });
		await t.waitFor(() => settledCount(t.records("m")) === 1);
		assert.doesNotMatch(prompts[0]!, /Workspace environment/);
	});
});
