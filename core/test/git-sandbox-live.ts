/** Manual existing-sandbox smoke test. No imports, settings changes, root commands or network changes. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { HarnessState } from "../src/agent/state.ts";
import { collectGit, sandboxGitEnvironment, sandboxGitRunner } from "../src/git/process.ts";
import { gitTools } from "../src/git/tools.ts";

const [evidence, distro = "DreamFlutterSandbox"] = process.argv.slice(2); assert.ok(evidence);
const cwd = `/workspace/.dreamflutter/t74-git-${randomUUID()}`, env = sandboxGitEnvironment(distro);
const proof: Record<string, any> = { at: new Date().toISOString(), distro, cwd, tools: [] };
const save = () => writeFileSync(evidence, JSON.stringify(proof, null, 2));
const native = (command: string, args: string[]) => collectGit(env.spawn(command, args, "/workspace"), undefined, 30_000);
let prepared = false;
const ready = async () => {
	if (prepared) return;
	const id = await native("id", ["-u"]), name = await native("id", ["-un"]);
	assert.equal(id.code, 0); assert.notEqual(id.stdout.trim(), "0"); assert.equal(name.stdout.trim(), "agent", "run only as sandbox agent");
	proof.agentUid = id.stdout.trim(); prepared = true;
};
const runner = sandboxGitRunner(env, ready), state = new HarnessState(cwd, env), tools = gitTools(state, { ready, distro });
async function git(...args: string[]) { const result = await runner.run(cwd, args); assert.equal(result.code, 0, result.stderr); return result.stdout.trim(); }
async function tool(name: string, input: Record<string, unknown> = {}) {
	const result = await tools.find((t) => t.name === name)!.execute("sandbox", input, undefined, undefined, {} as never);
	const details = result.details as Record<string, any>; proof.tools.push({ name, ...details }); save(); assert.equal(result.isError, false, JSON.stringify(details)); return details;
}
try {
	await ready();
	let result = await native("python3", ["-c", "import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.mkdir(parents=True); (p/'hello.txt').write_text('sandbox base\\n')", cwd]); assert.equal(result.code, 0, result.stderr);
	await git("init", "-b", "main"); await git("config", "user.name", "T74 sandbox fixture"); await git("config", "user.email", "fixture@example.invalid");
	await tool("git_status"); await tool("git_stage", { paths: ["hello.txt"] }); await tool("git_commit", { message: "sandbox baseline" });
	result = await native("python3", ["-c", "import pathlib,sys; (pathlib.Path(sys.argv[1])/'hello.txt').write_text('sandbox changed\\n')", cwd]); assert.equal(result.code, 0, result.stderr);
	await tool("git_diff"); await tool("git_stage", { paths: ["hello.txt"] }); const changed = await tool("git_commit", { message: `sandbox change $(touch ${cwd}/injected.txt)\n\nmessage with spaces and 'quotes'` });
	assert.deepEqual(changed.files, [], "commit message must remain literal argv, never a shell command");
	await tool("git_branch_create", { name: "feature" }); await tool("git_switch", { name: "feature" });
	const reverted = await tool("git_revert", { commit: changed.head });
	await tool("git_recovery_points"); await tool("git_recover", { id: reverted.recoveryPoint.id });
	assert.equal(await git("show", "HEAD:hello.txt"), "sandbox changed"); assert.equal(await git("rev-list", "--count", "feature"), "3");
	await tool("git_history"); proof.pass = true;
} catch (error) { proof.pass = false; proof.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
	const result = await native("python3", ["-c", "import pathlib,shutil,sys; p=pathlib.Path(sys.argv[1]).resolve(); assert p.parent==pathlib.Path('/workspace/.dreamflutter') and p.name.startswith('t74-git-'); shutil.rmtree(p) if p.exists() else None", cwd]);
	proof.cleaned = result.code === 0; save(); console.log(JSON.stringify({ pass: proof.pass, cleaned: proof.cleaned, error: proof.error, tools: proof.tools.length }));
}
