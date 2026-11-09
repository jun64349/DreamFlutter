/** Manual, bounded OpenCode Go verification. Copies one existing channel unchanged into temp data; never creates a channel or changes source config. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { buildCore } from "../src/app.ts";
import { Db } from "../src/db.ts";
import { corePaths } from "../src/paths.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { relocateSecretRef, SecretStore, secretFileOf } from "../src/modules/secrets.ts";
import { ALLOW } from "../src/pi/dialogs.ts";

const [source, evidence] = process.argv.slice(2);
assert.ok(source && evidence, "usage: node test/git-live.ts <existing-data-dir> <new-evidence-json>");
assert.ok(!existsSync(evidence), "do not overwrite a counted live run");
const root = mkdtempSync(join(tmpdir(), "df-t74-live-")), data = join(root, "data"), workspace = join(root, "workspace");
mkdirSync(workspace);
const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgSign=false", ...args], { cwd: workspace, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
git("init", "-b", "main"); git("config", "core.autocrlf", "false"); git("config", "user.name", "T74 isolated fixture"); git("config", "user.email", "fixture@example.invalid");
writeFileSync(join(workspace, "hello.txt"), "base\n"); git("add", "hello.txt"); git("commit", "-m", "baseline");
writeFileSync(join(workspace, "hello.txt"), "T74 changed\n");
const baseline = git("rev-parse", "HEAD");
const read = new DatabaseSync(corePaths(source).dbFile, { readOnly: true });
type Row = Record<string, string | number | null>;
const channel = read.prepare("SELECT * FROM gateway_channels WHERE platform='opencode-go' AND enabled=1 ORDER BY sort,created_at LIMIT 1").get() as Row;
assert.ok(channel);
const key = read.prepare("SELECT * FROM gateway_keys WHERE channel_id=? AND enabled=1 ORDER BY sort,created_at LIMIT 1").get(channel.id) as Row;
read.close(); assert.ok(key);
const modelId = "mimo-v2.6-flash";
const model = (JSON.parse(String(channel.models)) as { id: string }[]).find((m) => m.id === modelId); assert.ok(model);
channel.models = JSON.stringify([{ ...model, maxTokens: 2048 }]);
const sourceSecrets = new SecretStore(source), targetSecrets = new SecretStore(data);
const sourceFile = secretFileOf(String(key.secret)); assert.ok(sourceFile);
assert.equal(resolve(sourceFile).toLowerCase(), resolve(join(sourceSecrets.dir, basename(sourceFile))).toLowerCase());
mkdirSync(targetSecrets.dir, { recursive: true }); copyFileSync(sourceFile, join(targetSecrets.dir, basename(sourceFile)));
key.secret = relocateSecretRef(String(key.secret), targetSecrets.dir);
const db = new Db(corePaths(data).dbFile);
for (const [table, row] of [["gateway_channels", channel], ["gateway_keys", key]] as const) {
	const cols = Object.keys(row); db.raw.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`).run(...cols.map((c) => row[c]!));
}
db.close();
const core = buildCore({ paths: corePaths(data), agentDir: join(root, "agent"), sessionDir: join(root, "sessions"), piMigration: { automatic: false }, log: new Logger(), notifier: new RecordingNotifier() });
core.settings.update({ defaultModel: `df-${channel.id}/${modelId}`, defaultThinking: "off", autoTitle: false, memoryAutoExtract: false, memoryPaused: true, approvalMode: "changes", maxTurnsPerRun: 18 });
const proof: Record<string, any> = { at: new Date().toISOString(), sourceReadOnly: true, isolatedRoot: root, model: modelId, newChannels: 0, approvals: [], tools: [], baseline, stages: [] };
const save = () => writeFileSync(evidence, JSON.stringify(proof, null, 2));
save();
const records: Record<string, unknown>[] = [];
const client = core.addClient((message) => {
	if (message.event !== "slot.record") return;
	const record = message.record as Record<string, any>; records.push(record);
	if (record.type === "tool_execution_end") { proof.tools.push({ name: record.toolName, isError: record.isError, result: record.result }); save(); }
	if (record.type === "extension_ui_request" && record.method === "select") {
		proof.approvals.push(record.title); save();
		void core.call("slot.send", { slotId: "git-live", record: { type: "extension_ui_response", id: record.id, value: ALLOW } }, client);
	}
});
async function prompt(message: string) {
	const before = records.filter((r) => r.type === "agent_settled").length;
	await core.call("slot.send", { slotId: "git-live", record: { id: `p-${Date.now()}`, type: "prompt", message } }, client);
	const started = Date.now();
	while (records.filter((r) => r.type === "agent_settled").length === before) {
		if (Date.now() - started > 120_000) throw new Error("live prompt timed out");
		await new Promise((r) => setTimeout(r, 100));
	}
	const last = records.filter((r) => r.type === "message_end" && (r.message as any)?.role === "assistant").at(-1)?.message as any;
	proof.stages.push({ elapsedMs: Date.now() - started, stopReason: last?.stopReason, answer: last?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") }); save();
	assert.ok(last && last.stopReason !== "error", last?.errorMessage ?? "no reply");
}
try {
	await core.start(); await core.call("slot.open", { slotId: "git-live", cwd: workspace }, client);
	await prompt("这是隔离的 Git 工具验证仓库。只用 git_* 工具：先检查状态、改动和历史，然后仅暂存 hello.txt，以你写的简短中文信息提交。接着新建 t74-live 分支并切换过去，列出恢复点。不要用 shell/文件写工具，不推送，不更改 Git 配置。身份已由测试夹具配置。完成后简短报告。");
	const change = git("rev-parse", "HEAD"); assert.notEqual(change, baseline); assert.equal(git("branch", "--show-current"), "t74-live");
	await prompt(`继续只用 git_* 工具：回退刚才的提交 ${change}，使用新建 revert 提交；列出恢复点，找这次 revert 自动保存的恢复点并恢复到新分支，再检查状态。不要修改历史、推送或用 shell。`);
	assert.equal(readFileSync(join(workspace, "hello.txt"), "utf8").replaceAll("\r\n", "\n"), "T74 changed\n"); assert.match(git("branch", "--show-current"), /^dreamflutter-recovered\//);
	assert.equal(git("rev-list", "--count", "t74-live"), "3");
	const names = proof.tools.map((row: any) => row.name);
	for (const name of ["git_status", "git_diff", "git_history", "git_stage", "git_commit", "git_branch_create", "git_switch", "git_revert", "git_recover"]) assert.ok(names.includes(name), `missing ${name}`);
	assert.ok(names.every((name: string) => name.startsWith("git_")));
	assert.ok(proof.approvals.length >= 6);
	proof.pass = true; proof.finalHead = git("rev-parse", "HEAD");
} catch (error) { proof.pass = false; proof.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
	proof.requests = core.db.all("SELECT ok,model,input,output,cost,error_kind FROM gateway_requests ORDER BY id");
	save(); await core.shutdown(); console.log(JSON.stringify({ pass: proof.pass, tools: proof.tools.map((r: any) => r.name), approvals: proof.approvals.length, error: proof.error, evidence }));
}
