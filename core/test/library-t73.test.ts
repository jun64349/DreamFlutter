import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { McpClient } from "@earendil-works/pi-mcp";
import { Db } from "../src/db.ts";
import { MIGRATIONS } from "../src/schema.ts";
import { validateSkill } from "../src/modules/skill-validation.ts";
import { locator, type EntryMetadata } from "../src/modules/library-registry.ts";
import { loadSecurityMcpConfig } from "../src/security/mcp-config.ts";
import { secureMcpFactory } from "../src/security/mcp.ts";
import type { Proposal, SkillInfo, TemplateInfo } from "../src/modules/skills.ts";
import { startTestCore, settledCount, dialogs, type TestCore } from "./harness.ts";

const markdown = (name = "sample-skill", body = "Follow these steps.") => `---\nname: ${name}\ndescription: Test a reusable procedure\n---\n${body}\n`;
async function run(t: TestCore, slot: string, name: string, input: Record<string, unknown>): Promise<void> {
	const before = settledCount(t.records(slot));
	t.respond(fauxAssistantMessage([fauxToolCall(name, input as never)], { stopReason: "toolUse" }), fauxAssistantMessage("done"));
	await t.send(slot, { type: "prompt", message: "Run the requested test" });
	await t.waitFor(() => settledCount(t.records(slot)) > before);
}
function fixture(t: TestCore, name = "synthetic"): { form: Record<string, unknown>; events: string } {
	const script = join(t.dir, `${name}.mjs`), events = join(t.dir, `${name}.events`);
	writeFileSync(script, `import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs';
const events=${JSON.stringify(events)}; appendFileSync(events,'start\\n');
const rl=createInterface({input:process.stdin}); rl.on('close',()=>{appendFileSync(events,'close\\n'); process.exit()});
rl.on('line',line=>{const m=JSON.parse(line); if(m.id===undefined)return;
appendFileSync(events,m.method+'\\n');
const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:
m.method==='tools/list'?{tools:[{name:'echo',description:'Echo',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:process.env.T73_PARENT??'isolated'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`);
	return { form: { name, transport: "stdio", command: process.execPath, args: [script], exposure: "direct" }, events };
}

test("T73 migration 14 upgrades a v13 database without losing pending proposals", async () => {
	const t = await startTestCore();
	try {
		const file = join(t.dir, "v13.db"), old = new DatabaseSync(file);
		for (const sql of MIGRATIONS.slice(0, 13)) old.exec(sql);
		old.exec("PRAGMA user_version=13; INSERT INTO proposals(id,kind,title,payload,status,created_at) VALUES('old','skill','kept','{}','pending',1)"); old.close();
		const db = new Db(file);
		try { assert.ok(db.get("SELECT * FROM library_entries") === undefined); assert.equal(db.get<{ title: string }>("SELECT title FROM proposals WHERE id='old'")?.title, "kept"); assert.ok(Number((db.raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version) >= 14); } finally { db.close(); }
	} finally { await t.cleanup(); }
});

test("T73 skill checker accepts YAML, checks optional fields, references and executability without running", async () => {
	const t = await startTestCore();
	try {
		const dir = join(t.agentDir, "skills", "sample-skill"), file = join(dir, "SKILL.md"), marker = join(t.dir, "must-not-exist");
		mkdirSync(join(dir, "scripts"), { recursive: true });
		writeFileSync(join(dir, "scripts", "test.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'bad')`);
		writeFileSync(file, markdown("sample-skill", "Run scripts/test.mjs"));
		const result = validateSkill(readFileSync(file, "utf8"), { filePath: file });
		assert.equal(result.ok, true); assert.equal(result.scripts[0]?.executable, true); assert.equal(result.scriptTrial.status, "not-run"); assert.equal(existsSync(marker), false);
		assert.equal(validateSkill("---\nname: good\ndescription: >\n  Multiline description\nmetadata:\n  author: Example\n---\nBody").ok, true);
		assert.match(validateSkill(markdown("bad--name")).errors.join(), /name/);
		assert.match(validateSkill(markdown().replace("Test a reusable procedure", "")).errors.join(), /description/);
		assert.match(validateSkill(markdown().replace("---\nFollow", "metadata: nope\n---\nFollow")).errors.join(), /metadata/);
		assert.match(validateSkill(markdown("sample-skill", "[missing](references/none.md) [escape](../outside)"), { filePath: file }).errors.join(), /不存在/);
		writeFileSync(join(dir, "scripts", "unknown.xyz"), "unrecognized script");
		assert.match(validateSkill(readFileSync(file, "utf8"), { filePath: file }).errors.join(), /不可执行/);
		const trial = await t.core.call("skills.scriptTrial", { filePath: file }) as { status: string };
		assert.equal(trial.status, "not-ready"); assert.equal(existsSync(marker), false);
	} finally { await t.cleanup(); }
});

test("T73 community imports stay disabled until user review; modified scripts revoke trust", async () => {
	const t = await startTestCore();
	try {
		const folder = join(t.dir, "sample-skill"); mkdirSync(join(folder, "scripts"), { recursive: true });
		writeFileSync(join(folder, "SKILL.md"), markdown("sample-skill", "Use scripts/check.mjs")); writeFileSync(join(folder, "scripts", "check.mjs"), "console.log('ok')");
		const imported = await t.core.call("skills.import", { folder, sourceUrl: "https://example.invalid/skills" }) as SkillInfo;
		assert.equal(imported.enabled, false); assert.equal(imported.trust, "untrusted");
		await assert.rejects(t.core.call("skills.setEnabled", { filePath: imported.filePath, enabled: true }), /待确认/);
		const [proposal] = await t.core.call("proposals.list", {}) as Proposal[];
		await t.core.call("proposals.accept", { id: proposal!.id });
		let skill = ((await t.core.call("skills.list", { cwd: t.workspace })) as SkillInfo[]).find((entry) => entry.name === "sample-skill")!;
		assert.equal(skill!.sourceKind, "community"); assert.equal(skill!.enabled, true); assert.equal(skill!.usageCount, 0);
		writeFileSync(join(imported.baseDir, "scripts", "check.mjs"), "console.log('changed')");
		skill = ((await t.core.call("skills.list", { cwd: t.workspace })) as SkillInfo[]).find((entry) => entry.name === "sample-skill")!;
		assert.equal(skill!.trust, "untrusted"); assert.equal(skill!.enabled, false);
		await assert.rejects(t.core.call("skills.setEnabled", { filePath: imported.filePath, enabled: true }), /待确认/);
		assert.ok(t.core.security.audit.query({ kind: "library" }).some((event) => event.decision === "untrusted"));
	} finally { await t.cleanup(); }
});

test("T73 Agent registration cannot grant trust and actual skill loading alone produces usage", async () => {
	const t = await startTestCore();
	try {
		t.core.settings.update({ approvalMode: "all" });
		await t.core.call("slot.open", { slotId: "registration", cwd: t.workspace }, t.client);
		await run(t, "registration", "skill_register", { name: "sample-skill", description: "Test a reusable procedure", content: markdown(), trust: "trusted", enabled: true });
		assert.equal(dialogs(t.records("registration")).length, 0);
		const [proposal] = await t.core.call("proposals.list", {}) as Proposal[];
		assert.equal(proposal!.payload.sourceKind, "agent"); assert.equal(existsSync(join(t.agentDir, "skills", "sample-skill", "SKILL.md")), false);
		await t.core.call("proposals.accept", { id: proposal!.id });
		await t.core.call("slot.open", { slotId: "usage", cwd: t.workspace }, t.client);
		await run(t, "usage", "skill_test", { filePath: join(t.agentDir, "skills", "sample-skill", "SKILL.md") });
		let skill = ((await t.core.call("skills.list", { cwd: t.workspace })) as SkillInfo[]).find((entry) => entry.name === "sample-skill")!; assert.equal(skill!.usageCount, 0);
		t.core.settings.update({ approvalMode: "off" });
		await run(t, "usage", "skill", { name: "sample-skill" });
		skill = ((await t.core.call("skills.list", { cwd: t.workspace })) as SkillInfo[]).find((entry) => entry.name === "sample-skill")!; assert.equal(skill!.usageCount, 1); assert.ok(skill!.lastUsedAt);
		await t.core.call("skills.setEnabled", { filePath: skill!.filePath, enabled: false });
		await run(t, "usage", "skill", { name: "sample-skill" });
		skill = ((await t.core.call("skills.list", { cwd: t.workspace })) as SkillInfo[]).find((entry) => entry.name === "sample-skill")!; assert.equal(skill!.usageCount, 1, "already-open runtime cannot use a disabled skill");
		await t.core.call("skills.setEnabled", { filePath: skill!.filePath, enabled: true });
		const child = await t.core.openSubagentRuntime("usage", "t73-child", t.workspace, t.core.slot("usage").ui);
		try {
			await child.session.bindExtensions({ mode: "rpc", uiContext: t.core.slot("usage").ui.context() });
			t.respond(fauxAssistantMessage([fauxToolCall("skill", { name: "sample-skill" })], { stopReason: "toolUse" }), fauxAssistantMessage("child done"));
			await child.session.prompt("Load the skill");
			skill = ((await t.core.call("skills.list", { cwd: t.workspace })) as SkillInfo[]).find((entry) => entry.name === "sample-skill")!; assert.equal(skill!.usageCount, 2, "subagent loading uses the same real usage recorder");
		} finally { await child.dispose(); }
		t.respond(fauxAssistantMessage("direct command done"));
		await t.core.slot("usage").session.prompt("/skill:sample-skill");
		skill = ((await t.core.call("skills.list", { cwd: t.workspace })) as SkillInfo[]).find((entry) => entry.name === "sample-skill")!; assert.equal(skill!.usageCount, 3, "native skill commands also record a real load");
	} finally { await t.cleanup(); }
});

test("T73 templates have persistent switches and count expanded execution, not command previews", async () => {
	let t = await startTestCore();
	try {
		await t.core.call("templates.save", { name: "weekly", body: "Write a weekly report" });
		await t.core.call("templates.command", { name: "weekly" });
		let [entry] = await t.core.call("templates.list", {}) as TemplateInfo[]; assert.equal(entry!.usageCount, 0);
		await t.core.call("slot.open", { slotId: "template", cwd: t.workspace }, t.client);
		t.respond(fauxAssistantMessage("done")); await t.send("template", { type: "prompt", message: "/weekly" }); await t.waitFor(() => settledCount(t.records("template")) === 1);
		[entry] = await t.core.call("templates.list", {}) as TemplateInfo[]; assert.equal(entry!.usageCount, 1);
		await t.core.call("templates.setEnabled", { name: "weekly", enabled: false });
		await assert.rejects(t.core.call("templates.command", { name: "weekly" }), /停用/);
		let called = false; t.respond(() => { called = true; return fauxAssistantMessage("must not execute"); });
		await t.core.slot("template").session.prompt("/weekly");
		assert.equal(called, false, "an already-open session cannot expand a disabled /template");
		t = await t.reopen(); [entry] = await t.core.call("templates.list", {}) as TemplateInfo[]; assert.equal(entry!.enabled, false); assert.equal(entry!.usageCount, 1);
	} finally { await t.cleanup(); }
});

test("T73 MCP proposals require review; per-server test handshakes, lists and closes without usage", async () => {
	const t = await startTestCore();
	try {
		const a = fixture(t, "alpha"), b = fixture(t, "beta");
		const proposal = await t.core.call("mcp.register", { server: a.form, trust: "trusted", butterflyAllowed: true }) as { id: string; trust: string };
		assert.equal(proposal.trust, "untrusted"); assert.equal(existsSync(a.events), false);
		await assert.rejects(t.core.call("mcp.setEnabled", { name: "alpha", enabled: true }), /没有这个服务/);
		await t.core.call("proposals.accept", { id: proposal.id }); await t.core.call("mcp.save", { server: b.form });
		const report = await t.core.call("mcp.test", { name: "alpha", cwd: t.workspace }) as { ok: boolean; tools: string[]; durationMs: number };
		assert.equal(report.ok, true); assert.deepEqual(report.tools, ["echo"]); assert.ok(report.durationMs >= 0);
		assert.match(readFileSync(a.events, "utf8"), /initialize\ntools\/list\nclose/); assert.equal(existsSync(b.events), false, "testing alpha must not start beta");
		const list = await t.core.call("mcp.list", {}) as { servers: (EntryMetadata & { name: string })[] };
		assert.equal(list.servers.find((s) => s.name === "alpha")!.butterflyAllowed, false); assert.equal(list.servers[0]!.usageCount, 0);
		await t.core.call("mcp.setEnabled", { name: "alpha", enabled: false });
		assert.equal((await t.core.call("mcp.test", { name: "alpha", cwd: t.workspace }) as { ok: boolean }).ok, true, "user can test a trusted disabled service explicitly");
	} finally { await t.cleanup(); }
});

test("T73 MCP actual tools/call records usage; butterfly default deny and live revocation precede transport", async () => {
	const t = await startTestCore(); process.env.T73_PARENT = "must-not-inherit";
	try {
		const a = fixture(t); await t.core.call("mcp.save", { server: a.form });
		const entry = loadSecurityMcpConfig(t.agentDir, t.workspace, false).servers[0]!;
		assert.equal(t.core.library.mcpAllowed(entry, true), false);
		const factory = secureMcpFactory(t.core.security.audit, undefined, undefined, { allowed: (server) => t.core.library.mcpAllowed(server, true), used: (server, id) => t.core.library.used("mcp", t.core.library.mcpKey(server), `t73:${String(id)}`) });
		assert.throws(() => factory(entry, t.workspace, undefined), /蝶君/); assert.equal(existsSync(a.events), false);
		await t.core.call("mcp.setButterflyAllowed", { name: "synthetic", allowed: true });
		const client = new McpClient({ name: "test", version: "1", requestTimeoutMs: 2000 });
		try {
			await client.connect(factory(entry, t.workspace, undefined)); await client.listTools();
			const result = await client.callTool("echo", {}); assert.match(JSON.stringify(result), /isolated/); assert.doesNotMatch(JSON.stringify(result), /must-not-inherit/);
			await t.core.call("mcp.setButterflyAllowed", { name: "synthetic", allowed: false });
			await assert.rejects(client.callTool("echo", {}), /蝶君/);
			const [server] = (await t.core.call("mcp.list", {}) as { servers: EntryMetadata[] }).servers;
			assert.equal(server!.usageCount, 1); assert.ok(server!.lastUsedAt);
		} finally { await client.close(); }
		assert.ok(t.core.security.audit.query({ kind: "mcp" }).some((event) => event.decision === "deny"));
	} finally { delete process.env.T73_PARENT; await t.cleanup(); }
});

test("T73 MCP Agent tool creates an untrusted suggestion and failed tests return reason", async () => {
	const t = await startTestCore();
	try {
		await t.core.call("slot.open", { slotId: "mcp-agent", cwd: t.workspace }, t.client);
		await run(t, "mcp-agent", "mcp_register", { server: { name: "missing", transport: "stdio", command: "T73_MISSING_EXECUTABLE", exposure: "direct" } });
		const [proposal] = await t.core.call("proposals.list", {}) as Proposal[]; assert.equal(proposal!.kind, "mcp");
		assert.equal((await t.core.call("mcp.list", {}) as { servers: unknown[] }).servers.length, 0);
		await t.core.call("proposals.accept", { id: proposal!.id });
		const result = await t.core.call("mcp.test", { name: "missing", cwd: t.workspace }) as { ok: boolean; error?: string; durationMs: number };
		assert.equal(result.ok, false); assert.ok(result.error); assert.ok(result.durationMs >= 0);
		const meta = t.core.library.get("mcp", `${locator(join(t.agentDir, "mcp.json"))}#missing`); assert.equal(meta.usageCount, 0);
	} finally { await t.cleanup(); }
});

test("T73 unreviewed skill scripts are blocked at the actual host shell tool", async () => {
	const t = await startTestCore();
	try {
		const folder = join(t.dir, "sample-skill"), marker = join(t.dir, "must-not-run"); mkdirSync(join(folder, "scripts"), { recursive: true });
		writeFileSync(join(folder, "SKILL.md"), markdown("sample-skill", "Use scripts/check.mjs"));
		writeFileSync(join(folder, "scripts", "check.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'unsafe')`);
		const imported = await t.core.call("skills.import", { folder }) as SkillInfo;
		t.core.settings.update({ approvalMode: "off" });
		await t.core.call("slot.open", { slotId: "shell", cwd: t.workspace }, t.client);
		await run(t, "shell", "pwsh", { description: "Test untrusted script guard", command: `& '${process.execPath}' '${join(imported.baseDir, "scripts", "check.mjs")}'` });
		assert.equal(existsSync(marker), false);
		assert.ok(t.core.security.audit.query({ kind: "library" }).some((event) => event.decision === "deny"));
		await t.core.call("slot.open", { slotId: "minimal-shell", cwd: t.workspace, agentMode: "minimal" }, t.client);
		await run(t, "minimal-shell", "pwsh", { command: `& '${process.execPath}' '${join(imported.baseDir, "scripts", "check.mjs")}'` });
		assert.equal(existsSync(marker), false);
		assert.equal(t.core.security.audit.query({ kind: "library" }).filter((event) => event.decision === "deny").length, 2);
	} finally { await t.cleanup(); }
});

test("T73 MCP registration stages credentials without changing an active service's key", async () => {
	const t = await startTestCore();
	try {
		const base = { name: "private", transport: "http", url: "https://example.invalid/mcp" };
		await t.core.call("mcp.save", { server: { ...base, headers: { Authorization: { value: "Bearer T73_OLD_SYNTHETIC", secret: true } } } });
		const original = readFileSync(join(t.agentDir, "mcp.json"), "utf8");
		const proposal = await t.core.call("mcp.register", { server: { ...base, headers: { Authorization: { value: "Bearer T73_NEW_SYNTHETIC", secret: true } } } }) as { id: string };
		assert.equal(readFileSync(join(t.agentDir, "mcp.json"), "utf8"), original);
		const { SecretStore } = await import("../src/modules/secrets.ts");
		assert.equal(await new SecretStore(t.core.paths.dataDir).get("mcp-private-header-Authorization"), "Bearer T73_OLD_SYNTHETIC");
		const row = t.core.db.get<{ payload: string }>("SELECT payload FROM proposals WHERE id=?", proposal.id)!;
		assert.doesNotMatch(row.payload, /T73_NEW_SYNTHETIC/);
		await t.core.call("proposals.accept", { id: proposal.id });
		assert.doesNotMatch(readFileSync(join(t.agentDir, "mcp.json"), "utf8"), /T73_NEW_SYNTHETIC/);
		assert.equal((await t.core.call("mcp.list", {}) as { servers: EntryMetadata[] }).servers[0]!.trust, "trusted");
	} finally { await t.cleanup(); }
});

test("T73 paginated MCP tools are fully collected; protocol errors report failure and close", async () => {
	const t = await startTestCore();
	try {
		const a = fixture(t, "pages");
		const script = (a.form.args as string[])[0]!;
		writeFileSync(script, readFileSync(script, "utf8").replace("?{tools:[{name:'echo'", "?{...(m.params?.cursor?{}:{nextCursor:'page2'}),tools:[{name:m.params?.cursor?'second':'first'"));
		await t.core.call("mcp.save", { server: a.form });
		const result = await t.core.call("mcp.test", { name: "pages", cwd: t.workspace }) as { ok: boolean; tools: string[] };
		assert.equal(result.ok, true); assert.deepEqual(result.tools, ["first", "second"]);
		const bad = fixture(t, "protocol-error"), badScript = (bad.form.args as string[])[0]!;
		writeFileSync(badScript, readFileSync(badScript, "utf8").replace("{jsonrpc:'2.0',id:m.id,result}", "{jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'T73 handshake rejected'}}"));
		await t.core.call("mcp.save", { server: bad.form });
		const failure = await t.core.call("mcp.test", { name: "protocol-error", cwd: t.workspace }) as { ok: boolean; error: string; durationMs: number };
		assert.equal(failure.ok, false); assert.match(failure.error, /handshake rejected/); assert.ok(failure.durationMs < 10_000); assert.match(readFileSync(bad.events, "utf8"), /close/);
	} finally { await t.cleanup(); }
});
