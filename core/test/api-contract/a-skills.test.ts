import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expectKeys, expectRpcError, startContractHarness } from "./harness.ts";

const ok = { ok: true };
const metadata = ["sourceKind", "sourceUrl", "trust", "butterflyAllowed", "enabled", "lastUsedAt", "usageCount", "identityConflict"];
const skillFields = ["name", "description", "filePath", "baseDir", "scope", "enabled", "modelInvocable"];
const proposalFields = ["id", "kind", "title", "payload", "status", "sourceSession", "cwd", "createdAt", "resolvedAt"];
const skill = (name: string) => ({ name, description: "A synthetic test skill.", content: "---\nname: " + name + "\ndescription: A synthetic test skill.\n---\n\n# Fixture\n" });

test("skills, proposal review and imports use temporary files and a loopback download", async t => {
	const api = await startContractHarness(t);
	const cwd = api.workspace;
	for (const method of ["skills.copyBuiltin", "skills.draftFromSession", "skills.import", "skills.importUrl", "skills.list", "skills.read", "skills.register", "skills.remove", "skills.routingStatus", "skills.scriptTrial", "skills.setEnabled", "skills.test", "proposals.accept", "proposals.reject"])
		await expectRpcError(api.call(method), "bad_request");

	const from = api.events.length;
	const proposal = await api.call<{ id: string }>("skills.register", skill("wire-skill"));
	expectKeys(proposal, proposalFields);
	assert.deepEqual(await api.call("proposals.list"), [proposal]);
	await expectRpcError(api.call("skills.test", { proposalId: "missing" }), "not_found");
	await expectRpcError(api.call("skills.scriptTrial", { proposalId: "missing" }), "not_found");
	const check = await api.call("skills.test", { proposalId: proposal.id });
	expectKeys(check, ["ok", "durationMs", "errors", "warnings", "references", "scripts", "scriptTrial"]);
	assert.equal(check.ok, true);
	expectKeys(check.scriptTrial, ["status", "runtime", "reason"]);
	const trial = await api.call("skills.scriptTrial", { proposalId: proposal.id });
	expectKeys(trial, ["ok", "status", "runtime", "reason"], ["artifacts"]);
	assert.equal(trial.ok, false);
	const accepted = await api.call<{ path: string }>("proposals.accept", { id: proposal.id });
	expectKeys(accepted, ["path"]);
	await expectRpcError(api.call("proposals.accept", { id: proposal.id }), "gone");
	assert.equal(await api.call("skills.read", { filePath: accepted.path }), skill("wire-skill").content);
	assert.deepEqual(await api.call("skills.setEnabled", { filePath: accepted.path, enabled: false }), ok);
	assert.deepEqual(await api.call("skills.remove", { filePath: accepted.path }), ok);
	const rejected = await api.call<{ id: string }>("skills.register", skill("wire-rejected"));
	assert.deepEqual(await api.call("proposals.reject", { id: rejected.id }), ok);
	assert.deepEqual(await api.call("proposals.list"), []);
	const changeEvents = api.events.slice(from).filter(e => e.event === "skills.changed" || e.event === "proposals.changed");
	for (const event of changeEvents) expectKeys(event, ["event"]);
	assert.deepEqual(changeEvents.map(event => event.event), [
		"proposals.changed", "skills.changed", "proposals.changed", "skills.changed",
		"skills.changed", "skills.changed", "proposals.changed", "proposals.changed",
	]);

	const local = join(api.dir, "wire-import");
	mkdirSync(local);
	writeFileSync(join(local, "SKILL.md"), skill("wire-import").content);
	expectKeys(await api.call("skills.import", { folder: local }), skillFields, [...metadata, "nameDiagnostics"]);
	const source = createServer((req, res) => {
		if (req.url === "/SKILL.md") res.end(skill("wire-download").content);
		else res.writeHead(404).end();
	});
	source.listen(0, "127.0.0.1");
	await once(source, "listening");
	t.after(() => { source.closeAllConnections(); return new Promise<void>(resolve => source.close(() => resolve())); });
	const url = "http://127.0.0.1:" + (source.address() as AddressInfo).port;
	expectKeys(await api.call("skills.importUrl", { url: url + "/SKILL.md" }), skillFields, [...metadata, "nameDiagnostics"]);
	await expectRpcError(api.call("skills.importUrl", { url: url + "/missing" }), "download");
	api.core.maintenance = "fixture";
	try { await expectRpcError(api.call("skills.importUrl", { url }), "busy"); }
	finally { api.core.maintenance = undefined; }

	const items = await api.call<{ filePath: string; name: string; readOnly?: boolean }[]>("skills.list", { cwd });
	const builtin = items.find(item => item.readOnly);
	assert.ok(builtin);
	const copied = await api.call("skills.copyBuiltin", { filePath: builtin.filePath, name: "wire-copy" });
	expectKeys(copied, ["path", "name"]);
	assert.equal(copied.name, "wire-copy");
	await expectRpcError(api.call("skills.copyBuiltin", { filePath: builtin.filePath, name: "wire-copy" }), "conflict");
	await expectRpcError(api.call("skills.remove", { filePath: builtin.filePath }), "read_only");
	await api.call("slot.open", { slotId: "skills-fixture", cwd });
	assert.equal(await api.call("skills.routingStatus", { slotId: "skills-fixture" }), null);
	await expectRpcError(api.call("skills.draftFromSession", { slotId: "skills-fixture" }), "bad_request");
	const draftFrom = api.events.length;
	api.respond(fauxAssistantMessage("The fixture is ready."));
	await api.call("slot.send", { slotId: "skills-fixture", record: { type: "prompt", message: "Summarize the fixture" } });
	await api.waitForEvent("slot.record", e => (e.record as { type?: string }).type === "agent_settled", draftFrom);
	api.respond(fauxAssistantMessage('{"name":"wire-session","description":"Fixture","body":"Check the fixture."}'));
	expectKeys(await api.call("skills.draftFromSession", { slotId: "skills-fixture" }), proposalFields);
	assert.equal(api.events.slice(draftFrom).filter(e => e.event === "proposals.changed").length, 1);
});

test("templates compile and draft through the fake model", async t => {
	const api = await startContractHarness(t);
	for (const method of ["templates.save", "templates.remove", "templates.draft"]) await expectRpcError(api.call(method), "bad_request");
	await expectRpcError(api.call("templates.setEnabled", { name: "absent" }), "not_found");
	await expectRpcError(api.call("templates.command", { name: "absent" }), "not_found");
	const from = api.events.length;
	const name = "wire-template";
	const fields = ["name", "description", "body", "params", "filePath"];
	const saved = await api.call("templates.save", { name, body: "Check {{target}}." });
	expectKeys(saved, fields, metadata);
	const items = await api.call<Record<string, unknown>[]>("templates.list");
	const item = items.find(row => row.name === name);
	expectKeys(item, fields, metadata);
	assert.deepEqual(await api.call("templates.command", { name, values: { target: "fixture" } }), { command: '/wire-template "fixture"' });
	assert.deepEqual(await api.call("templates.setEnabled", { name, enabled: false }), ok);
	await expectRpcError(api.call("templates.command", { name }), "untrusted");
	assert.deepEqual(await api.call("templates.remove", { name }), ok);
	api.respond(fauxAssistantMessage('{"name":"wire-draft","description":"fixture","body":"draft body"}'));
	assert.deepEqual(await api.call("templates.draft", { text: "Draft a fixture" }),
		{ name: "wire-draft", description: "fixture", body: "draft body" });
	assert.deepEqual(api.events.slice(from).filter(e => e.event === "templates.changed"),
		[{ event: "templates.changed" }, { event: "templates.changed" }, { event: "templates.changed" }]);
});

test("MCP settings validate proposals and connect to a local stdio fixture", async t => {
	const api = await startContractHarness(t);
	const cwd = api.workspace;
	const script = join(api.dir, "mcp-fixture.mjs");
	writeFileSync(script, `
		import { createInterface } from "node:readline";
		const input = createInterface({ input: process.stdin });
		input.on("line", line => {
			const message = JSON.parse(line);
			if (message.id === undefined) return;
			const result = message.method === "initialize"
				? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
				: { tools: [{ name: "mock", description: "Fixture", inputSchema: { type: "object" } }] };
			console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
	`);
	const server = { name: "wire-mcp", transport: "stdio", command: process.execPath, args: [script], enabled: false };
	for (const method of ["mcp.acceptProposal", "mcp.test", "mcp.remove", "mcp.save", "mcp.setEnabled", "mcp.setToolEnabled", "mcp.setButterflyAllowed", "mcp.status"])
		await expectRpcError(api.call(method), "bad_request");
	const before = api.events.length;
	const pending = await api.call<{ id: string; status: string }>("mcp.register", { server, cwd });
	expectKeys(pending, ["id", "status", "enabled", "trust"]);
	assert.equal(pending.status, "pending");
	const accepted = await api.call("mcp.acceptProposal", { id: pending.id });
	expectKeys(accepted, ["path", "name"]);
	await expectRpcError(api.call("mcp.acceptProposal", { id: pending.id }), "gone");
	const list = await api.call<{ file: string; servers: unknown[] }>("mcp.list", { cwd });
	expectKeys(list, ["file", "servers"]);
	expectKeys(list.servers[0], ["name", "transport", "enabled", "scope", "source", "command", "args", "env", "headers", "tools"], [...metadata, "cwd", "description", "exposure", "timeout"]);
	await expectRpcError(api.call("mcp.test", { name: "missing", cwd }), "not_found");
	const report = await api.call("mcp.test", { name: server.name, cwd });
	expectKeys(report, ["name", "state", "ok", "durationMs", "tools", "errors", "toolStates"], [...metadata, "scope", "source", "exposure", "protocolVersion", "reason", "transport", "restartRequired", "args", "command", "env", "headers"]);
	assert.deepEqual([report.state, report.ok, report.tools], ["connected", true, ["mock"]]);
	expectKeys(await api.call("mcp.status", { cwd }), ["servers", "errors"]);
	await expectRpcError(api.call("mcp.setButterflyAllowed", { name: "missing" }), "not_found");
	await expectRpcError(api.call("mcp.setEnabled", { name: server.name, source: join(cwd, "project.json") }), "read_only");
	await expectRpcError(api.call("mcp.remove", { name: server.name, source: join(cwd, "project.json") }), "read_only");
	assert.deepEqual(await api.call("mcp.save", { server }), ok);
	assert.deepEqual(await api.call("mcp.setButterflyAllowed", { name: server.name, allowed: true }), ok);
	assert.deepEqual(await api.call("mcp.setEnabled", { name: server.name, enabled: false }), ok);
	assert.deepEqual(await api.call("mcp.setToolEnabled", { name: server.name, tool: "mock", enabled: false }), ok);
	assert.deepEqual(await api.call("mcp.remove", { name: server.name }), ok);
	const events = api.events.slice(before);
	assert.ok(events.some(e => e.event === "library.changed"));
	for (const e of events.filter(e => e.event === "library.changed")) expectKeys(e, ["event"]);
	for (const e of events.filter(e => ["mcp.changed", "proposals.changed"].includes(e.event))) expectKeys(e, ["event"]);
	assert.deepEqual(events.filter(e => ["mcp.changed", "proposals.changed"].includes(e.event)).map(e => e.event),
		["proposals.changed", "mcp.changed", "proposals.changed", "mcp.changed", "mcp.changed", "mcp.changed", "mcp.changed", "mcp.changed"]);
});
