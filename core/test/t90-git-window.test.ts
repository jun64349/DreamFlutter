import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { GitService, type GitSelection } from "../src/git/service.ts";
import { GitError, type GitRunner } from "../src/git/process.ts";
import { startTestCore, type TestCore } from "./harness.ts";

const gitAt = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
function init(cwd: string) { gitAt(cwd, "init", "-b", "main"); gitAt(cwd, "config", "user.name", "T90 configured author"); gitAt(cwd, "config", "user.email", "t90@example.invalid"); gitAt(cwd, "config", "core.autocrlf", "false"); }

describe("T-90 GitService selected commits (disposable repositories)", () => {
	let cwd: string, service: GitService;
	const write = (path: string, value: string | Buffer) => writeFileSync(join(cwd, path), value);
	const git = (...args: string[]) => gitAt(cwd, ...args);
	async function prepare(paths: string[]) { const result = await service.prepareCommit(paths); assert.equal(result.ok, true, JSON.stringify(result)); return result as unknown as { ok: true } & GitSelection; }
	beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "df-t90-git-")); init(cwd); service = new GitService(cwd); });
	afterEach(() => { assert.ok(cwd.startsWith(join(tmpdir(), "df-t90-git-"))); rmSync(cwd, { recursive: true, force: true, maxRetries: 5 }); });
	it("prepares without staging; first commit contains only selected files and retains other staged content", async () => {
		write("chosen.txt", "chosen\n"); write("other.txt", "other\n"); git("add", "other.txt");
		const index = git("ls-files", "--stage");
		const prepared = await prepare(["chosen.txt"]);
		assert.equal(prepared.head, null); assert.match(prepared.diff, /chosen/); assert.equal(git("ls-files", "--stage"), index);
		const result = await service.commitSelected(prepared.paths, "first selected", { head: prepared.head, fingerprint: prepared.fingerprint });
		assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(git("show", "--pretty=", "--name-only", "HEAD"), "chosen.txt");
		assert.equal(git("diff", "--cached", "--name-only"), "other.txt");
		assert.equal(git("log", "-1", "--format=%an <%ae>"), "T90 configured author <t90@example.invalid>");
	});
	it("commits a selected modification and deletion without another staged or unstaged file", async () => {
		for (const path of ["chosen.txt", "deleted.txt", "other.txt"]) write(path, "base\n"); git("add", "."); git("commit", "-m", "base");
		write("chosen.txt", "chosen change\n"); rmSync(join(cwd,"deleted.txt")); write("other.txt", "staged other\n"); git("add", "other.txt"); write("other.txt", "unstaged other\n");
		const staged = git("show", ":other.txt");
		const prepared = await prepare(["chosen.txt", "deleted.txt"]);
		const result = await service.commitSelected(prepared.paths,"only chosen",{head:prepared.head,fingerprint:prepared.fingerprint});
		assert.equal(result.ok,true,JSON.stringify(result)); assert.deepEqual(git("show","--pretty=","--name-only","HEAD").split("\n"),["chosen.txt","deleted.txt"]);
		assert.equal(git("show",":other.txt"),staged); assert.equal(readFileSync(join(cwd,"other.txt"),"utf8"),"unstaged other\n"); assert.equal(git("show","HEAD:other.txt"),"base");
	});
	it("checks exact selected binary content and HEAD again before staging", async () => {
		write("image.bin",Buffer.from([0,1,2])); git("add","."); git("commit","-m","base"); write("image.bin",Buffer.from([0,3,2]));
		const prepared = await prepare(["image.bin"]); assert.match(prepared.diff,/二进制/);
		const index = git("ls-files","--stage"), head = git("rev-parse","HEAD"); write("image.bin",Buffer.from([0,4,2]));
		const stale = await service.commitSelected(prepared.paths,"stale",{head:prepared.head,fingerprint:prepared.fingerprint});
		assert.equal(stale.code,"changed_since_prepare"); assert.equal(git("ls-files","--stage"),index); assert.equal(git("rev-parse","HEAD"),head);
		const moved = await service.commitSelected(prepared.paths,"stale head",{head:"0000000000000000000000000000000000000000"}); assert.equal(moved.code,"changed_since_prepare");
	});
	it("handles literal names from nested cwd and includes both sides of a rename", async () => {
		write("before.txt","base\n"); git("add","."); git("commit","-m","base"); git("mv","before.txt","中文 [x].txt");
		mkdirSync(join(cwd,"nested")); service = new GitService(join(cwd,"nested")); const prepared = await prepare(["中文 [x].txt"]);
		assert.deepEqual(prepared.paths,["before.txt","中文 [x].txt"]); const result=await service.commitSelected(prepared.paths,"rename"); assert.equal(result.ok,true,JSON.stringify(result));
		assert.equal(git("-c","core.quotePath=false","ls-tree","--name-only","HEAD"),"中文 [x].txt");
	});
	it("refuses escapes, stage-all, unchanged files, blank messages, missing identity and conflicts", async () => {
		write("chosen.txt","base\n"); git("add","."); git("commit","-m","base"); write("chosen.txt","change\n");
		for (const path of [".","../outside","/outside","missing.txt"]) assert.equal((await service.prepareCommit([path])).ok,false,path);
		assert.equal((await service.commitSelected(["chosen.txt"]," ")).code,"invalid_input");
		git("config","user.name",""); git("config","user.email","");
		const result=await service.commitSelected(["chosen.txt"],"no identity"); assert.equal(result.code,"identity_missing"); assert.equal(git("diff","--cached","--name-only"),"");
	});
	it("returns explicit missing-Git and non-repository reasons", async () => {
		const runner: GitRunner = {run:async()=>{throw new GitError("not_installed","未安装Git");},exists:async()=>[]};
		assert.equal((await new GitService(cwd,runner).prepareCommit(["x"])).code,"not_installed");
		const other=join(cwd,"plain"); mkdirSync(other); // Nested directories still belong to this repo; use an actual non-repo.
		const plain=mkdtempSync(join(tmpdir(),"df-t90-plain-"));
		try { const result=await new GitService(plain).execute("git_status"); assert.equal(result.code,"not_repository"); assert.match(String(result.reason),/不是Git仓库/); } finally { rmSync(plain,{recursive:true,force:true}); }
	});
	it("supports already-staged deletions and refuses conflicted repositories before staging",async()=>{
		write("gone.txt","base\n");write("conflict.txt","base\n");git("add",".");git("commit","-m","base");
		git("rm","gone.txt");const prepared=await prepare(["gone.txt"]);
		const result=await service.commitSelected(prepared.paths,"delete staged",{head:prepared.head,fingerprint:prepared.fingerprint});assert.equal(result.ok,true,JSON.stringify(result));
		git("checkout","-b","other");write("conflict.txt","other\n");git("add",".");git("commit","-m","other");git("checkout","main");write("conflict.txt","main\n");git("add",".");git("commit","-m","main");
		assert.throws(()=>git("merge","other"));const index=git("ls-files","--stage");
		assert.equal((await service.prepareCommit(["conflict.txt"])).code,"conflict");assert.equal((await service.commitSelected(["conflict.txt"],"must refuse")).code,"conflict");assert.equal(git("ls-files","--stage"),index);
	});
});

describe("T-90 window RPC and small-task draft", () => {
	let t: TestCore;
	beforeEach(async()=>{t=await startTestCore();init(t.workspace);writeFileSync(join(t.workspace,"report.md"),"report\n");});
	afterEach(async()=>{await t.cleanup();});
	it("routes through real RPC, uses the small-task model, and commits once without approval cards or push", async()=>{
		t.core.settings.update({smallTaskModel:"faux/faux-text",approvalMode:"all"});
		const used:string[]=[]; t.respond((_context,_options,_signal,model)=>{used.push(model.id);return fauxAssistantMessage("整理实验报告");});
		const status=await t.core.call("git.status",{cwd:t.workspace}) as Record<string,unknown>; assert.equal(status.isRepository,true); assert.equal(status.available,true);
		const prepared=await t.core.call("git.prepareCommit",{cwd:t.workspace,paths:["report.md"]}) as GitSelection & {suggestedMessage:string};
		assert.deepEqual(used,["faux-text"]); assert.equal(prepared.suggestedMessage,"整理实验报告"); assert.match(prepared.diff,/report/);
		const result=await t.core.call("git.commit",{cwd:t.workspace,paths:prepared.paths,message:"用户编辑的说明",expectedHead:prepared.head,expectedFingerprint:prepared.fingerprint}) as Record<string,unknown>;
		assert.equal(result.ok,true,JSON.stringify(result)); assert.equal(gitAt(t.workspace,"log","-1","--format=%s"),"用户编辑的说明");
		assert.deepEqual(await t.core.call("confirm.list",{}),[]); assert.equal(t.messages.some(m=>m.event==="slot.record" && (m.record as Record<string,unknown>)?.type==="extension_ui_request"),false);
		await assert.rejects(t.core.call("git.push",{cwd:t.workspace}));
	});
	it("unavailable small model leaves an editable empty draft without blocking manual commit",async()=>{
		t.core.settings.update({smallTaskModel:"missing/model"});
		const prepared=await t.core.call("git.prepareCommit",{cwd:t.workspace,paths:["report.md"]}) as GitSelection & {suggestedMessage:string;draftReason:string};
		assert.equal(prepared.suggestedMessage,"");assert.match(prepared.draftReason,/小任务模型/);
		assert.equal((await t.core.call("git.commit",{cwd:t.workspace,paths:prepared.paths,message:"手写说明",expectedHead:prepared.head,expectedFingerprint:prepared.fingerprint}) as Record<string,unknown>).ok,true);
	});
	it("commits only checked files while atomically checking the original preview fingerprint",async()=>{
		writeFileSync(join(t.workspace,"unchecked.md"),"leave this file\n");
		const preview=await t.core.call("git.prepareCommit",{cwd:t.workspace,paths:["report.md","unchecked.md"]}) as GitSelection;
		const result=await t.core.call("git.commit",{cwd:t.workspace,paths:["report.md"],message:"checked only",expectedHead:preview.head,expectedFingerprint:preview.fingerprint,expectedPaths:preview.paths}) as Record<string,unknown>;
		assert.equal(result.ok,true,JSON.stringify(result));assert.equal(gitAt(t.workspace,"show","--pretty=","--name-only","HEAD"),"report.md");assert.equal(gitAt(t.workspace,"status","--porcelain"),"?? unchecked.md");
	});
	it("does not accept unpreviewed paths or bypass a stale preview after deselection",async()=>{
		writeFileSync(join(t.workspace,"unchecked.md"),"leave\n");writeFileSync(join(t.workspace,"outside.md"),"outside\n");
		const preview=await t.core.call("git.prepareCommit",{cwd:t.workspace,paths:["report.md","unchecked.md"]}) as GitSelection;
		const params={cwd:t.workspace,message:"must refuse",expectedHead:preview.head,expectedFingerprint:preview.fingerprint,expectedPaths:preview.paths};
		assert.equal((await t.core.call("git.commit",{cwd:t.workspace,message:"missing selection"}) as Record<string,unknown>).code,"invalid_input");
		assert.equal((await t.core.call("git.commit",{...params,paths:[]}) as Record<string,unknown>).code,"invalid_input");
		assert.equal((await t.core.call("git.commit",{...params,paths:["outside.md"]}) as Record<string,unknown>).code,"invalid_selection");
		writeFileSync(join(t.workspace,"report.md"),"changed after preview\n");assert.equal((await t.core.call("git.commit",{...params,paths:["report.md"]}) as Record<string,unknown>).code,"changed_since_prepare");assert.equal(gitAt(t.workspace,"diff","--cached","--name-only"),"");
	});
	it("returns the selected diff and rejects a changed preparation through RPC",async()=>{
		const diff=await t.core.call("git.diff",{cwd:t.workspace,paths:["report.md"]}) as GitSelection; assert.match(diff.diff,/report/);
		const prepared=await t.core.call("git.prepareCommit",{cwd:t.workspace,paths:["report.md"]}) as GitSelection;
		writeFileSync(join(t.workspace,"report.md"),"later changes\n");
		const result=await t.core.call("git.commit",{cwd:t.workspace,paths:prepared.paths,message:"stale",expectedHead:prepared.head,expectedFingerprint:prepared.fingerprint}) as Record<string,unknown>;
		assert.equal(result.code,"changed_since_prepare"); assert.match(String(result.reason),/已变化/);
	});
});
