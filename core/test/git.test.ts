import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GitService, GIT_READ_TOOLS, GIT_WRITE_TOOLS, type RecoveryPoint } from "../src/git/service.ts";
import { collectGit, findGit, GitError, hostGitRunner, sandboxGitRunner } from "../src/git/process.ts";
import { gitTools } from "../src/git/tools.ts";
import { HarnessState, HOST_ENV } from "../src/agent/state.ts";
import { approvalExtension, isReadOnlyCall } from "../src/ext/approval.ts";

describe("T-74 Git service (real disposable repositories)", () => {
	let dir: string, service: GitService;
	const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd: dir, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
	const write = (name: string, content: string) => writeFileSync(join(dir, name), content);
	async function success(tool: string, input: Record<string, unknown> = {}) {
		const result = await service.execute(tool, input); assert.equal(result.ok, true, JSON.stringify(result)); return result;
	}
	async function error(tool: string, code: string, input: Record<string, unknown> = {}) {
		const result = await service.execute(tool, input); assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.code, code, JSON.stringify(result)); return result;
	}
	function commit(content: string) { write("hello.txt", content); git("add", "--", "hello.txt"); git("commit", "-m", content.trim()); return git("rev-parse", "HEAD"); }
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "df-t74-git-"));
		git("init", "-b", "main"); git("config", "user.name", "T74 fixture"); git("config", "user.email", "fixture@example.invalid"); git("config", "core.autocrlf", "false");
		service = new GitService(dir);
	});
	afterEach(() => { assert.ok(dir.startsWith(join(tmpdir(), "df-t74-git-"))); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

	it("handles unborn repositories, literal filenames, staged diff, deletion and real identity", async () => {
		assert.equal((await success("git_status")).head, null);
		assert.deepEqual((await success("git_history")).commits, []);
		await error("git_commit", "nothing_staged", { message: "empty" });
		await error("git_switch", "git_failed", { name: "missing" });
		write("hello.txt", "one\n"); write("中文 [a].txt", "你好\n");
		assert.equal((await success("git_status")).dirty, true);
		await success("git_stage", { paths: ["hello.txt", "中文 [a].txt"] });
		assert.match(String((await success("git_diff", { staged: true })).diff), /one/);
		await success("git_commit", { message: "first\n\nsecond paragraph" });
		assert.equal(git("log", "-1", "--format=%an <%ae>"), "T74 fixture <fixture@example.invalid>");
		const history = (await success("git_history", { limit: 1 })).commits as Record<string, unknown>[];
		assert.equal(history[0]!.subject, "first"); assert.equal(history[0]!.author, "T74 fixture");
		rmSync(join(dir, "hello.txt")); await success("git_stage", { paths: ["hello.txt"] });
		assert.match(String((await success("git_diff", { staged: true })).diff), /deleted file/);
		await success("git_commit", { message: "delete" });
		assert.equal((await success("git_status")).dirty, false);
	});

	it("addresses repository-relative paths from a nested cwd", async () => {
		commit("base\n"); mkdirSync(join(dir, "nested")); write("hello.txt", "edit\n");
		service = new GitService(join(dir, "nested"));
		await success("git_stage", { paths: ["hello.txt"] });
		assert.match(String((await success("git_diff", { staged: true, paths: ["hello.txt"] })).diff), /edit/);
	});

	it("refuses implicit stage-all, escaping paths, option injection and unsupported operations", async () => {
		commit("base\n");
		for (const input of [{}, { paths: [] }, { paths: ["../outside"] }, { paths: ["C:\\secret"] }, { paths: ["/etc/passwd"] }]) await error("git_stage", "invalid_input", input);
		for (const name of ["--detach", "@{-1}", "HEAD", "refs/heads/x", "a b"]) await error("git_branch_create", "invalid_input", { name });
		await error("git_history", "invalid_input", { limit: 1000 });
		await error("git_commit", "invalid_input", { message: "x", amend: true });
		await error("git_revert", "invalid_input", { commit: "--all" });
		await error("git_push", "unsupported_operation");
		write("-odd.txt", "literal\n"); await success("git_stage", { paths: ["-odd.txt"] });
		assert.match(git("diff", "--cached", "--name-only"), /-odd.txt/);
	});

	it("saves persistent recovery refs before switching and restores to a new branch", async () => {
		const original = commit("base\n");
		await success("git_branch_create", { name: "feature" });
		const switched = await success("git_switch", { name: "feature" });
		const point = switched.recoveryPoint as RecoveryPoint;
		assert.equal(git("rev-parse", `refs/dreamflutter/recovery/${point.id}`), original);
		commit("feature\n");
		service = new GitService(dir); // survives service restart
		assert.ok(((await success("git_recovery_points")).points as RecoveryPoint[]).some((p) => p.id === point.id));
		const recovered = await success("git_recover", { id: point.id });
		assert.match(String(recovered.branch), /^dreamflutter-recovered\//);
		assert.equal(readFileSync(join(dir, "hello.txt"), "utf8"), "base\n");
		assert.equal(git("show", "feature:hello.txt"), "feature");
		assert.equal(((await success("git_recovery_points")).points as RecoveryPoint[]).length, 2);
		await error("git_recover", "invalid_input", { id: "../../HEAD" });
	});

	it("refuses switching, reverting or recovering a dirty worktree without touching anything", async () => {
		const head = commit("base\n"); await success("git_branch_create", { name: "feature" });
		write("untracked.txt", "keep");
		for (const [tool, input] of [["git_switch", { name: "feature" }], ["git_revert", { commit: head }], ["git_recover", { id: "invalid" }]] as const) await error(tool, "uncommitted_changes", input);
		assert.equal(git("rev-parse", "HEAD"), head); assert.equal(readFileSync(join(dir, "untracked.txt"), "utf8"), "keep");
		assert.deepEqual((await success("git_recovery_points")).points, []);
	});

	it("reverts with a new commit, keeps history, and recovers the old tree", async () => {
		const base = commit("base\n"), change = commit("change\n");
		const reverted = await success("git_revert", { commit: change });
		assert.equal(readFileSync(join(dir, "hello.txt"), "utf8"), "base\n");
		assert.equal(git("rev-list", "--count", "HEAD"), "3");
		assert.equal(git("rev-parse", "HEAD^"), change); assert.equal(git("rev-parse", "HEAD^^"), base);
		const point = reverted.recoveryPoint as RecoveryPoint;
		await success("git_recover", { id: point.id });
		assert.equal(readFileSync(join(dir, "hello.txt"), "utf8"), "change\n");
		assert.equal(git("rev-list", "--count", "main"), "3");
	});

	it("reports revert conflicts and only explicitly aborts the matching tool-owned revert", async () => {
		commit("one\n"); const middle = commit("two\n"); const latest = commit("three\n");
		const result = await error("git_revert", "conflict", { commit: middle });
		const point = result.recoveryPoint as RecoveryPoint;
		assert.equal(point.commit, latest); assert.match(readFileSync(join(dir, "hello.txt"), "utf8"), /<<<<<<</);
		await error("git_switch", "conflict", { name: "main" });
		await error("git_stage", "conflict", { paths: ["hello.txt"] });
		await error("git_recover", "conflict", { id: point.id });
		await success("git_recover", { id: point.id, abortRevert: true });
		assert.equal(readFileSync(join(dir, "hello.txt"), "utf8"), "three\n");
		assert.equal(git("rev-parse", "main"), latest);
		await error("git_recover", "recovery_mismatch", { id: point.id, abortRevert: true });
	});

	it("detects an existing operation, refuses merges and a missing configured identity", async () => {
		const base = commit("base\n"); writeFileSync(join(dir, ".git", "MERGE_HEAD"), `${base}\n`);
		assert.equal((await success("git_status")).operation, "MERGE_HEAD");
		await error("git_commit", "operation_in_progress", { message: "unsafe" });
		rmSync(join(dir, ".git", "MERGE_HEAD"));
		git("config", "user.name", ""); git("config", "user.email", "");
		write("hello.txt", "modified\n"); await success("git_stage", { paths: ["hello.txt"] });
		await error("git_commit", "identity_missing", { message: "no author" });
		assert.equal(git("rev-parse", "HEAD"), base);
	});

	it("reports not_repository and not_installed without mutating the workspace", async () => {
		const outside = join(dir, "outside"); mkdirSync(outside);
		service = new GitService(outside, { ...hostGitRunner(), async run(cwd, args, signal) { return hostGitRunner().run(cwd, ["--git-dir", join(outside, ".git"), ...args], signal); } });
		await error("git_status", "not_repository");
		service = new GitService(dir, hostGitRunner({ bundledPath: null, env: { PATH: "" } }));
		await error("git_status", "not_installed");
	});

	it("preserves both commits when two sessions mutate the same repository", async () => {
		commit("base\n"); write("hello.txt", "update\n"); await success("git_stage", { paths: ["hello.txt"] });
		const results = await Promise.all([service.execute("git_commit", { message: "one" }), new GitService(dir).execute("git_commit", { message: "two" })]);
		assert.equal(results.filter((r) => r.ok).length, 1); assert.equal(results.find((r) => !r.ok)!.code, "nothing_staged");
		assert.equal(git("rev-list", "--count", "HEAD"), "2");
	});
	it("disables configured external diff and hooks, and never inherits an author override", async () => {
		commit("base\n");
		const marker = join(dir, "executed.txt").replaceAll("\\", "/");
		git("config", "diff.external", `echo executed > '${marker}'`);
		git("config", "core.fsmonitor", `echo executed > '${marker}'`);
		write("hello.txt", "changed\n");
		assert.match(String((await success("git_diff")).diff), /changed/);
		writeFileSync(join(dir, ".git", "hooks", "pre-commit"), `#!/bin/sh\nprintf executed > '${marker}'\nexit 1\n`);
		await success("git_stage", { paths: ["hello.txt"] });
		service = new GitService(dir, hostGitRunner({ env: { ...process.env, GIT_AUTHOR_NAME: "forged", GIT_AUTHOR_EMAIL: "forged@invalid", GIT_DIR: "/absent-t74" } }));
		await success("git_commit", { message: "user identity only" });
		assert.equal(git("log", "-1", "--format=%an"), "T74 fixture");
		await assert.rejects(import("node:fs/promises").then((fs) => fs.access(marker)), { code: "ENOENT" });
	});

	it("detects linked-worktree state and refuses merge-commit reverts", async () => {
		commit("base\n"); git("branch", "feature");
		git("switch", "feature"); write("feature.txt", "feature"); git("add", "feature.txt"); git("commit", "-m", "feature");
		git("switch", "main"); write("main.txt", "main"); git("add", "main.txt"); git("commit", "-m", "main");
		git("merge", "--no-edit", "feature");
		await error("git_revert", "merge_commit_unsupported", { commit: "HEAD" });
		const worktree = join(dir, "linked"); git("worktree", "add", worktree, "feature");
		service = new GitService(worktree);
		assert.equal((await success("git_status")).branch, "feature");
	});
});

describe("T-74 process and approval boundaries", () => {
	it("prioritizes bundled Git, falls back to PATH, and never searches cwd", async () => {
		const system = await findGit({ bundledPath: null });
		assert.equal(await findGit({ bundledPath: system, env: { PATH: "" } }), system);
		assert.equal(await findGit({ bundledPath: join(tmpdir(), "absent-t74.exe") }), system);
		await assert.rejects(findGit({ bundledPath: null, env: { PATH: "." } }), (e: unknown) => e instanceof GitError && e.code === "not_installed");
	});
	it("bounds output, supports cancellation, and times out child processes", async () => {
		const child = (script: string) => spawn(process.execPath, ["-e", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		await assert.rejects(collectGit(child("process.stdout.write('x'.repeat(5000))"), undefined, 5000, 100), { code: "output_limit" });
		await assert.rejects(collectGit(child("setInterval(()=>{},1000)"), undefined, 30), { code: "timeout" });
		const controller = new AbortController(); controller.abort();
		await assert.rejects(collectGit(child("setInterval(()=>{},1000)"), controller.signal), { code: "cancelled" });
	});
	it("routes sandbox commands through its agent environment after readiness, never host Git", async () => {
		const calls: { command: string; args: string[]; cwd: string }[] = []; let ready = false;
		const runner = sandboxGitRunner({ ...HOST_ENV, kind: "sandbox", spawn(command, args, cwd) {
			assert.equal(ready, true); calls.push({ command, args, cwd });
			return spawn(process.execPath, ["-e", "process.stdout.write('sandbox-git')"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} }, async () => { ready = true; });
		assert.equal((await runner.run("/workspace/repo", ["status"])).stdout, "sandbox-git");
		assert.equal(calls[0]!.command, "env"); assert.equal(calls[0]!.cwd, "/workspace/repo");
		assert.ok(calls[0]!.args.includes("git")); assert.equal(calls[0]!.args.at(-1), "status");
		await assert.rejects(sandboxGitRunner(HOST_ENV, async () => { throw new Error("not ready"); }).run("/workspace", ["status"]), /not ready/);
	});
	it("exposes only the declared operations and refuses sandbox execution before readiness", async () => {
		const tools = gitTools(new HarnessState(tmpdir()));
		assert.equal(tools.length, GIT_READ_TOOLS.length + GIT_WRITE_TOOLS.length);
		assert.ok(!tools.some((tool) => /push|reset|rebase|amend/.test(tool.name)));
		const state = new HarnessState("/workspace", { ...HOST_ENV, kind: "sandbox" });
		const result = await gitTools(state).find((tool) => tool.name === "git_status")!.execute("id", {}, undefined, undefined, {} as never);
		assert.equal(result.isError, true); assert.match(JSON.stringify(result), /沙箱尚未准备好/);
	});
	it("runs read tools directly, approves writes, fails closed without UI and honors overrides", async () => {
		for (const name of GIT_READ_TOOLS) assert.equal(isReadOnlyCall(name, {}), true);
		for (const name of GIT_WRITE_TOOLS) assert.equal(isReadOnlyCall(name, {}), false);
		let toolCall: (event: any, ctx: any) => Promise<any> = async () => {}, asked = 0;
		const bind = (override?: "allow" | "deny") => {
			approvalExtension({ mode: () => "all", workspaceAllowed: () => new Set(), allowInWorkspace() {}, override: () => override })({ on(event: string, handler: any) { if (event === "tool_call") toolCall = handler; } } as never);
		};
		const ctx = { cwd: tmpdir(), hasUI: true, ui: { async select() { asked++; return "拒绝"; } } };
		bind();
		for (const toolName of GIT_READ_TOOLS) assert.equal(await toolCall({ toolName, input: {} }, ctx), undefined);
		assert.equal(asked, 0);
		assert.equal((await toolCall({ toolName: "git_commit", input: { message: "x" } }, ctx)).block, true); assert.equal(asked, 1);
		assert.equal((await toolCall({ toolName: "git_stage", input: {} }, { ...ctx, hasUI: false })).block, true);
		bind("allow"); assert.equal(await toolCall({ toolName: "git_commit", input: {} }, ctx), undefined); assert.equal(asked, 1);
		bind("deny"); assert.equal((await toolCall({ toolName: "git_status", input: {} }, ctx)).block, true);
	});
});
