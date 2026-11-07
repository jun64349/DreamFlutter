import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { readTool, writeTool, editTool, readImageTool } from "../src/agent/fs-tools.ts";
import { grepTool, globTool, ripgrepPath } from "../src/agent/search-tools.ts";
import { HarnessState } from "../src/agent/state.ts";
import { SecurityAudit, RETENTION_MS } from "../src/security/audit.ts";
import { Db } from "../src/db.ts";
import { Logger } from "../src/log.ts";
import { MASK, rememberSecret } from "../src/security/redaction.ts";
import { minimalMcpEnv, resolveMcpValue, secureMcpFactory } from "../src/security/mcp.ts";
import { dialogs, settledCount, startTestCore, type TestCore } from "./harness.ts";

function syntheticRoots(t: TestCore) {
	const roots = { home: join(t.dir, "home"), localAppData: join(t.dir, "local"), appData: join(t.dir, "roaming"), secrets: join(t.dir, "private") };
	for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true });
	Object.assign(t.core.security.roots, roots);
	return roots;
}
const execute = (tool: ReturnType<typeof readTool>, params: unknown) => tool.execute("test", params, undefined, undefined, {} as never);

test("security S1/S3: every file tool denies protected paths, recursive search filters before opening, masked reads cannot write back", async () => {
	const t = await startTestCore();
	try {
		syntheticRoots(t);
		const env = join(t.workspace, ".env"), config = join(t.workspace, ".npmrc"), safe = join(t.workspace, "safe.txt"), masked = join(t.workspace, "masked.txt");
		writeFileSync(env, "SYNTHETIC_PROTECTED_HIT"); writeFileSync(config, "SYNTHETIC_CONFIRM_HIT"); writeFileSync(safe, "ordinary hit");
		const secret = "synthetic-t63-integration-credential-92938"; rememberSecret(secret);
		writeFileSync(masked, `ordinary hit ${secret}\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PEM_BODY\n-----END PRIVATE KEY-----`);
		const state = new HarnessState(t.workspace); state.security = t.core.security.scope(t.workspace, true, () => ({ runId: "synthetic-run" }));
		for (const mode of ["off", "changes", "all"]) {
			t.core.settings.update({ approvalMode: mode });
			await assert.rejects(execute(readTool(state), { file_path: env }), /安全策略/);
			await assert.rejects(execute(writeTool(state), { file_path: env, content: "replacement" }), /安全策略/);
			await assert.rejects(execute(editTool(state), { file_path: env, old_string: "a", new_string: "b" }), /安全策略/);
			await assert.rejects(execute(readImageTool(state, () => ({ ok: true, model: "faux" })), { file_path: env + ".png" }), /安全策略/);
		}
		await assert.rejects(execute(readTool(state), { file_path: config }), /无人值守/);
		const grep = await execute(grepTool(state, ripgrepPath(t.agentDir)), { pattern: "hit|SYNTHETIC", path: t.workspace });
		assert.doesNotMatch(JSON.stringify(grep), /PROTECTED_HIT|CONFIRM_HIT|PEM_BODY/);
		assert.match(JSON.stringify(grep), /ordinary hit/);
		const glob = await execute(globTool(state, ripgrepPath(t.agentDir)), { pattern: "*" });
		assert.doesNotMatch(JSON.stringify(glob), /\.env|\.npmrc/);
		const read = await execute(readTool(state), { file_path: masked, offset: 2 });
		assert.doesNotMatch(JSON.stringify(read), /synthetic-t63|PEM_BODY/);
		await assert.rejects(execute(writeTool(state), { file_path: masked, content: "unmasked replacement" }), /遮盖/);
		await assert.rejects(execute(writeTool(state), { file_path: "new.txt", content: MASK }), /占位符/);
		await t.core.call("security.addException", { cwd: t.workspace, path: env });
		assert.match(JSON.stringify(await execute(readTool(state), { file_path: env })), /PROTECTED_HIT/);
		const exception = (await t.core.call("security.exceptions", { cwd: t.workspace })) as { paths: string[] };
		await t.core.call("security.removeException", { cwd: t.workspace, path: exception.paths[0] });
		await assert.rejects(execute(readTool(state), { file_path: env }), /安全策略/);
		assert.equal(readFileSync(masked, "utf8").includes(secret), true);
		const audit = JSON.stringify(await t.core.call("security.audit", {})); assert.match(audit, /synthetic-run/); assert.ok(!audit.includes(secret));
	} finally { await t.cleanup(); }
});

test("security S1: confirmation is once only, workspace allowance persists, default deny offers no dialog", async () => {
	const t = await startTestCore();
	try {
		syntheticRoots(t); t.core.settings.update({ approvalMode: "off" });
		writeFileSync(join(t.workspace, ".npmrc"), "synthetic-npm"); writeFileSync(join(t.workspace, ".env"), "synthetic-env");
		await t.core.call("slot.open", { slotId: "security", cwd: t.workspace }, t.client);
		t.respond(fauxAssistantMessage([fauxToolCall("read", { file_path: ".npmrc" })], { stopReason: "toolUse" }), fauxAssistantMessage("done"));
		await t.send("security", { id: "p1", type: "prompt", message: "read config" });
		const first = await t.waitFor(() => dialogs(t.records("security"))[0]);
		await t.send("security", { type: "extension_ui_response", id: first.id, value: "本次允许" });
		await t.waitFor(() => settledCount(t.records("security")) === 1);
		t.respond(fauxAssistantMessage([fauxToolCall("read", { file_path: ".npmrc" })], { stopReason: "toolUse" }), fauxAssistantMessage("done"));
		await t.send("security", { id: "p2", type: "prompt", message: "read again" });
		const second = await t.waitFor(() => dialogs(t.records("security"))[1]);
		await t.send("security", { type: "extension_ui_response", id: second.id, value: "始终允许此路径" });
		await t.waitFor(() => settledCount(t.records("security")) === 2);
		t.respond(fauxAssistantMessage([fauxToolCall("read", { file_path: ".env" })], { stopReason: "toolUse" }), fauxAssistantMessage("done"));
		await t.send("security", { id: "p3", type: "prompt", message: "read env" });
		await t.waitFor(() => settledCount(t.records("security")) === 3);
		assert.equal(dialogs(t.records("security")).length, 2);
		assert.equal(((await t.core.call("security.exceptions", { cwd: t.workspace })) as { paths: string[] }).paths.length, 1);
	} finally { await t.cleanup(); }
});

test("security S1/S2: sensitive shell needs approval in off mode; unknown commands need approval only outside off", async () => {
	const t = await startTestCore();
	try {
		syntheticRoots(t); t.core.settings.update({ approvalMode: "off" });
		await t.core.call("slot.open", { slotId: "security", cwd: t.workspace }, t.client);
		t.respond(fauxAssistantMessage([fauxToolCall("pwsh", { command: "Write-Output '.env'", description: "synthetic path" })], { stopReason: "toolUse" }), fauxAssistantMessage("done"));
		await t.send("security", { id: "p1", type: "prompt", message: "check shell" });
		const first = await t.waitFor(() => dialogs(t.records("security"))[0]);
		await t.send("security", { type: "extension_ui_response", id: first.id, value: "拒绝" });
		await t.waitFor(() => settledCount(t.records("security")) === 1);
		let seen = "";
		t.respond(fauxAssistantMessage([fauxToolCall("pwsh", { command: "Write-Output 'synthetic harmless'", description: "synthetic", timeoutMs: 3000 })], { stopReason: "toolUse" }), (context: Context) => { seen = JSON.stringify(context.messages); return fauxAssistantMessage("done"); });
		await t.send("security", { id: "p2", type: "prompt", message: "off allows" }); await t.waitFor(() => settledCount(t.records("security")) === 2);
		assert.equal(dialogs(t.records("security")).length, 1); assert.match(seen, /synthetic harmless/);
		t.core.settings.update({ approvalMode: "changes" });
		t.respond(fauxAssistantMessage([fauxToolCall("pwsh", { command: "Write-Output 'synthetic harmless'", description: "synthetic", timeoutMs: 3000 })], { stopReason: "toolUse" }), fauxAssistantMessage("done"));
		await t.send("security", { id: "p3", type: "prompt", message: "changes confirms" });
		const second = await t.waitFor(() => dialogs(t.records("security"))[1]);
		await t.send("security", { type: "extension_ui_response", id: second.id, value: "允许" });
		await t.waitFor(() => settledCount(t.records("security")) === 3);
		assert.equal(dialogs(t.records("security")).length, 2, "the same command must not prompt twice");
	} finally { await t.cleanup(); }
});

test("security S5: audit expires at 90 days and logger/export redact synthetic credentials", () => {
	const db = new Db(":memory:"); let now = Date.now();
	try {
		const audit = new SecurityAudit(db, () => now);
		audit.record("path", "old", "deny", "old"); now += RETENTION_MS + 1;
		const secret = "synthetic-audit-secret-394849"; rememberSecret(secret);
		audit.record("mcp", secret, "start", "Authorization: Bearer synthetic-auth");
		assert.equal(audit.query().length, 1); assert.doesNotMatch(audit.export(), /synthetic-audit|synthetic-auth|old/);
		const env = minimalMcpEnv({ Path: "synthetic-path", SystemRoot: "C:/Windows", USER_TOKEN: secret, NODE_OPTIONS: "secret", HTTPS_PROXY: "secret" });
		assert.deepEqual(env, { Path: "synthetic-path", SystemRoot: "C:/Windows" });
		assert.equal(resolveMcpValue("$$EXAMPLE"), "$EXAMPLE");
	} finally { db.close(); }
});

test("security S4: status and conversations isolate MCP environment and redact notifications before Pi logs", async () => {
	const t = await startTestCore();
	const sentinel = "T63_SYNTHETIC_PARENT_SENTINEL"; process.env[sentinel] = "must-not-inherit";
	try {
		const fixture = join(t.dir, "mcp-synthetic.mjs");
		writeFileSync(fixture, `import { createInterface } from 'node:readline';
const rl = createInterface({input:process.stdin});
rl.on('line', line => { const m=JSON.parse(line); if(m.id===undefined)return;
let result = m.method==='initialize' ? {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}} : m.method==='tools/list' ? {tools:[{name:'env',description:'synthetic env',inputSchema:{type:'object',properties:{}}}]} : {content:[{type:'text',text:JSON.stringify({inherited:process.env.${sentinel} ?? null,explicit:process.env.T63_MODE})}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/message',params:{level:'info',data:'Authorization: Bearer SYNTHETIC_LOG_TOKEN'}})+'\\n'); });`);
		writeFileSync(join(t.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { synthetic: { command: process.execPath, args: [fixture], env: { T63_MODE: "explicit-only" }, exposure: "direct" } } }));
		const status = await t.core.call("mcp.status", { cwd: t.workspace }) as { servers: { state: string; tools: string[] }[] };
		assert.equal(status.servers[0]?.state, "connected"); assert.deepEqual(status.servers[0]?.tools, ["env"]);
		t.core.settings.update({ approvalMode: "off" });
		await t.core.call("slot.open", { slotId: "security", cwd: t.workspace }, t.client);
		let seen = "";
		t.respond(fauxAssistantMessage([fauxToolCall("mcp__synthetic__env", {})], { stopReason: "toolUse" }), (context: Context) => { seen = JSON.stringify(context.messages.filter((m) => m.role === "toolResult")); return fauxAssistantMessage("done"); });
		await t.send("security", { id: "p", type: "prompt", message: "synthetic MCP" }); await t.waitFor(() => settledCount(t.records("security")) === 1);
		assert.match(seen, /explicit-only/); assert.doesNotMatch(seen, /must-not-inherit/);
		const log = join(t.agentDir, "mcp.log"); assert.ok(existsSync(log)); assert.doesNotMatch(readFileSync(log, "utf8"), /SYNTHETIC_LOG_TOKEN/);
		const loggerFile = join(t.dir, "security-test.log"); const logger = new Logger(loggerFile); logger.info("Authorization: Bearer SYNTHETIC_LOG_TOKEN"); assert.doesNotMatch(readFileSync(loggerFile, "utf8"), /SYNTHETIC_LOG_TOKEN/);
	} finally { delete process.env[sentinel]; await t.cleanup(); }
});
