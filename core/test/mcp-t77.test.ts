import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startTestCore } from "./harness.ts";

test("T77 newer-only MCP reports peer protocol incompatibility and closes without business calls", async () => {
	const t = await startTestCore();
	try {
		const script = join(t.dir, "newer-only.mjs"), log = join(t.dir, "newer-only.log");
		writeFileSync(script, `import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';
const log=value=>appendFileSync(${JSON.stringify(log)},value+'\\n');const rl=createInterface({input:process.stdin});
rl.on('close',()=>{log('close');process.exit()});rl.on('line',line=>{const m=JSON.parse(line);log(m.method);if(m.id===undefined)return;
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:process.env.API_KEY?'2026-07-28-'+process.env.API_KEY:'2026-07-28',capabilities:{tools:{}},serverInfo:{name:'newer-only',version:'1'}}})+'\\n')});`);
		await t.core.call("mcp.save", { server: { name: "newer-only", transport: "stdio", command: process.execPath, args: [script], exposure: "direct" } });
		const result = await t.core.call("mcp.test", { name: "newer-only", cwd: t.workspace }) as { ok: boolean; state: string; errorCode: string; protocolVersion: string; error: string };
		assert.equal(result.ok, false);
		assert.equal(result.errorCode, "protocol_incompatible");
		assert.equal(result.protocolVersion, "2026-07-28");
		assert.match(result.error, /协议不兼容.*2026-07-28.*2025-11-25/);
		const events = readFileSync(log, "utf8");
		assert.match(events, /initialize/); assert.match(events, /close/);
		assert.doesNotMatch(events, /tools\/list|tools\/call/);
		const secret = "t77-private-protocol-value";
		await t.core.call("mcp.save", { server: { name: "newer-private", transport: "stdio", command: process.execPath, args: [script], env: { API_KEY: { value: secret, secret: true } }, exposure: "direct" } });
		const privateResult = await t.core.call("mcp.test", { name: "newer-private", cwd: t.workspace });
		assert.ok(!JSON.stringify(privateResult).includes(secret), "even an invalid peer protocol cannot echo a known credential into the report");
	} finally { await t.cleanup(); }
});

test("T77 an initialize response missing protocolVersion cannot be reported connected", async () => {
	const t = await startTestCore();
	try {
		const script = join(t.dir, "invalid-initialize.mjs");
		writeFileSync(script, `import{createInterface}from'node:readline';const rl=createInterface({input:process.stdin});rl.on('close',()=>process.exit());rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{capabilities:{},serverInfo:{name:'invalid',version:'1'}}})+'\\n')});`);
		await t.core.call("mcp.save", { server: { name: "invalid-initialize", transport: "stdio", command: process.execPath, args: [script], exposure: "direct" } });
		const result = await t.core.call("mcp.test", { name: "invalid-initialize", cwd: t.workspace }) as { ok: boolean; state: string; error: string };
		assert.equal(result.ok, false); assert.equal(result.state, "failed"); assert.match(result.error, /protocolVersion|协议/);
	} finally { await t.cleanup(); }
});
