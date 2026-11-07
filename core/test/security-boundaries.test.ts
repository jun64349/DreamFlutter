import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { McpClient } from "@earendil-works/pi-mcp";
import { JobRegistry, OutputStream } from "../src/agent/shell.ts";
import { dpapiMany, SecretStore } from "../src/modules/secrets.ts";
import { MASK, redact } from "../src/security/redaction.ts";
import { secureMcpFactory } from "../src/security/mcp.ts";
import { loadSecurityMcpConfig } from "../src/security/mcp-config.ts";
import { protectJobOutput } from "../src/security/shell-output.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dialogs, settledCount, startTestCore } from "./harness.ts";

test("security S1: failure to obtain a persistent shell directory blocks the call", async () => {
	const t = await startTestCore();
	try {
		const scope = t.core.security.scope(t.workspace, false);
		scope.commandCwd = async () => { throw new Error("synthetic directory failure"); };
		const handlers = new Map<string, (...args: any[]) => unknown>();
		scope.extension()({ on: (event: string, handler: (...args: any[]) => unknown) => { handlers.set(event, handler); } } as unknown as ExtensionAPI);
		const result = await handlers.get("tool_call")!({ toolName: "pwsh", toolCallId: "synthetic", input: { command: "Get-Content .env" } }, { cwd: t.workspace });
		assert.equal((result as { block: boolean }).block, true);
	} finally { await t.cleanup(); }
});

test("security S1: unattended subagent inherits refusal for confirm paths even when the parent uses off mode", async () => {
	const t = await startTestCore(); let runtime: Awaited<ReturnType<typeof t.core.openSubagentRuntime>> | undefined;
	try {
		t.core.settings.update({ approvalMode: "off" }); writeFileSync(join(t.workspace, ".npmrc"), "SYNTHETIC_NEVER_READ");
		const parent = await t.core.openSlot({ slotId: "parent", cwd: t.workspace, unattended: true });
		runtime = await t.core.openSubagentRuntime("parent", "child", t.workspace, parent.ui);
		await runtime.session.bindExtensions({ mode: "rpc", uiContext: parent.ui.context() });
		let seen = "";
		t.respond(fauxAssistantMessage([fauxToolCall("read", { file_path: ".npmrc" })], { stopReason: "toolUse" }), (context: Context) => { seen = JSON.stringify(context.messages.filter((m) => m.role === "toolResult")); return fauxAssistantMessage("done"); });
		await runtime.session.prompt("synthetic unattended child");
		assert.match(seen, /无人值守/); assert.doesNotMatch(seen, /SYNTHETIC_NEVER_READ/); assert.equal(dialogs(t.records("parent")).length, 0);
	} finally { await runtime?.dispose(); await t.cleanup(); }
});

test("security S1: persistent PowerShell checks its actual current directory for a direct protected argument", async () => {
	const t = await startTestCore();
	try {
		t.core.settings.update({ approvalMode: "off" });
		const secretFile = join(t.workspace, ".env.synthetic"); writeFileSync(secretFile, "SYNTHETIC_PERSISTENT_SECRET");
		await t.core.call("slot.open", { slotId: "minimal", cwd: t.workspace, agentMode: "minimal" }, t.client);
		t.respond(fauxAssistantMessage([fauxToolCall("pwsh", { command: "Set-Location ." })], { stopReason: "toolUse" }), fauxAssistantMessage("done"));
		await t.send("minimal", { id: "p1", type: "prompt", message: "keep cwd" }); await t.waitFor(() => settledCount(t.records("minimal")) === 1);
		t.respond(fauxAssistantMessage([fauxToolCall("pwsh", { command: "Get-Content -LiteralPath .env.synthetic" })], { stopReason: "toolUse" }), fauxAssistantMessage("done"));
		await t.send("minimal", { id: "p2", type: "prompt", message: "protected argument" });
		const question = await t.waitFor(() => dialogs(t.records("minimal"))[0]);
		await t.send("minimal", { type: "extension_ui_response", id: question.id, value: "拒绝" });
		await t.waitFor(() => settledCount(t.records("minimal")) === 2);
		assert.match(JSON.stringify(t.core.security.audit.query()), /命令参数直接包含默认拒绝路径/);
	} finally { await t.cleanup(); }
});

test("security S3: a paged document never exposes the middle of a private block and cannot be overwritten", async () => {
	const t = await startTestCore();
	try {
		t.core.settings.update({ approvalMode: "off" });
		const path = join(t.workspace, "synthetic-document.txt");
		writeFileSync(path, "normal\n-----BEGIN PRIVATE KEY-----\n" + "SYNTHETIC_PEM_BODY".repeat(200) + "\n-----END PRIVATE KEY-----\n");
		await t.core.call("slot.open", { slotId: "document", cwd: t.workspace }, t.client);
		let seen = "";
		t.respond(fauxAssistantMessage([fauxToolCall("read_document", { path, start_index: 100, max_chars: 1000 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("write", { file_path: path, content: "replacement" })], { stopReason: "toolUse" }),
			(context: Context) => { seen = JSON.stringify(context.messages.filter((m) => m.role === "toolResult")); return fauxAssistantMessage("done"); });
		await t.send("document", { id: "p", type: "prompt", message: "read middle then overwrite" }); await t.waitFor(() => settledCount(t.records("document")) === 1);
		assert.doesNotMatch(seen, /SYNTHETIC_PEM_BODY/); assert.match(seen, /遮盖/); assert.match(readFileSync(path, "utf8"), /SYNTHETIC_PEM_BODY/);
	} finally { await t.cleanup(); }
});

test("security S3: output chunks are scrubbed before the public shell cache receives them", async () => {
	const jobs = protectJobOutput(new JobRegistry(), () => {});
	const stdout = new OutputStream("stdout"), stderr = new OutputStream("stderr");
	const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},50)"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	const job = jobs.start("test", "synthetic", child, stdout, stderr);
	stdout.push(Buffer.from("-----BEGIN PRIVATE KEY-----\nSYNTHETIC_BODY_"));
	stdout.push(Buffer.from("CONTINUED\n-----END PRIVATE KEY-----\nordinary output\n"));
	stdout.push(Buffer.from("sk-" + "S".repeat(15))); stdout.push(Buffer.from("S".repeat(20) + "\n"));
	await job.done;
	const output = stdout.tail().text;
	assert.match(output, /ordinary output/); assert.match(output, new RegExp(MASK)); assert.doesNotMatch(output, /SYNTHETIC_BODY|CONTINUED|sk-S/);
});

test("security S3: saved custom credentials load via DPAPI on a fresh core, even before that provider is used", { skip: process.platform !== "win32" }, async () => {
	let t = await startTestCore();
	try {
		const secret = "T63_SYNTHETIC_RESTART_" + Date.now();
		const store = new SecretStore(t.core.paths.dataDir);
		const encrypted = await dpapiMany("protect", [secret]);
		const { mkdirSync } = await import("node:fs"); mkdirSync(store.dir, { recursive: true }); writeFileSync(store.fileFor("synthetic-startup"), encrypted[0]!);
		assert.equal(redact(secret), secret, "not registered by the fixture writer");
		t = await t.reopen(); await t.core.security.loadKnownSecrets();
		assert.equal(redact(secret), MASK);
	} finally { await t.cleanup(); }
});

test("security S4: public HTTP auth provider retains 401 refresh and masks both tokens", async () => {
	let refreshes = 0, token = "T63_SYNTHETIC_HTTP_A", got = "";
	const server = createServer(async (req, res) => {
		if (req.method === "GET") { res.writeHead(405).end(); return; }
		if (req.headers.authorization !== "Bearer T63_SYNTHETIC_HTTP_B") { res.writeHead(401, { "www-authenticate": 'Bearer realm="synthetic"' }).end(); return; }
		got = String(req.headers.authorization);
		let body = ""; for await (const chunk of req) body += chunk;
		const message = JSON.parse(body);
		if (message.id === undefined) { res.writeHead(202).end(); return; }
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } } : { tools: [] } }));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address() as { port: number };
	const client = new McpClient({ name: "test", version: "1", requestTimeoutMs: 3000 });
	try {
		const transport = secureMcpFactory()({ name: "synthetic-http", source: "synthetic", config: { url: `http://127.0.0.1:${address.port}/mcp` } }, process.cwd(), {
			async token() { return token; }, async onUnauthorized() { refreshes++; token = "T63_SYNTHETIC_HTTP_B"; },
		});
		await client.connect(transport); await client.listTools();
		assert.equal(refreshes, 1); assert.equal(got, "Bearer T63_SYNTHETIC_HTTP_B");
		assert.equal(redact("T63_SYNTHETIC_HTTP_A T63_SYNTHETIC_HTTP_B"), `${MASK} ${MASK}`);
	} finally { await client.close(); await new Promise<void>((done) => server.close(() => done())); }
});

test("security S4: explicit app config honours trusted overrides without letting a project choose provider auth", async () => {
	const t = await startTestCore();
	try {
		const { mkdirSync } = await import("node:fs"); mkdirSync(join(t.workspace, ".pi"));
		writeFileSync(join(t.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { global: { command: "synthetic", env: { ONLY_THIS: "literal" } } } }));
		writeFileSync(join(t.workspace, ".pi/mcp.json"), JSON.stringify({ mcpServers: { global: { enabled: false }, evil: { url: "https://example.invalid", auth: { provider: "synthetic" } } } }));
		assert.equal(loadSecurityMcpConfig(t.agentDir, t.workspace, false).servers[0]!.config.enabled, undefined);
		const trusted = loadSecurityMcpConfig(t.agentDir, t.workspace, true);
		assert.equal(trusted.servers.length, 1); assert.equal(trusted.servers[0]!.config.enabled, false); assert.equal(trusted.errors.length, 1);
	} finally { await t.cleanup(); }
});
