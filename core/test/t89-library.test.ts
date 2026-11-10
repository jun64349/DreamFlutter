import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { McpClient } from "@earendil-works/pi-mcp";
import { writeArchive } from "../src/backup/archive.ts";
import { skillDownloadTarget, withSkillDownload } from "../src/modules/skill-download.ts";
import { loadSecurityMcpConfig } from "../src/security/mcp-config.ts";
import { secureMcpFactory } from "../src/security/mcp.ts";
import { startTestCore } from "./harness.ts";

const markdown = (name = "t89-sample") => `---\nname: ${name}\ndescription: A reusable procedure\n---\nRead [the guide](references/guide.md).\n`;


test("T89 a tool switch blocks an already connected transport before it sends or counts a call", async () => {
  const t = await startTestCore();
  try {
    const script = join(t.dir, "mcp.mjs"), calls = join(t.dir, "calls.txt");
    writeFileSync(script, `import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs'; const rl=createInterface({input:process.stdin}); rl.on('close',()=>process.exit()); rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return; if(m.method==='tools/call')appendFileSync(${JSON.stringify(calls)},'call\\n');const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'ok'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`);
    await t.core.call("mcp.save", { server: { name: "docs", transport: "stdio", command: process.execPath, args: [script], exposure: "direct" } });
    const entry = loadSecurityMcpConfig(t.agentDir, t.workspace, false).servers[0]!;
    const factory = secureMcpFactory(t.core.security.audit, undefined, undefined, { allowed: (e) => t.core.library.mcpAllowed(e), toolAllowed: (e, tool) => t.core.library.mcpToolAllowed(e, tool), used: (e, id) => t.core.library.used("mcp", t.core.library.mcpKey(e), `t89:${id}`) });
    const client = new McpClient({ name: "test", version: "1", requestTimeoutMs: 2000 });
    try {
      await client.connect(factory(entry, t.workspace, undefined)); await client.listTools(); await client.callTool("echo", {});
      await t.core.call("mcp.setToolEnabled", { name: "docs", source: entry.source, tool: "echo", enabled: false });
      await assert.rejects(client.callTool("echo", {}), /工具已停用/); assert.equal(readFileSync(calls, "utf8"), "call\n");
      await t.core.call("mcp.setToolEnabled", { name: "docs", source: entry.source, tool: "echo", enabled: true }); await client.callTool("echo", {});
      assert.equal(readFileSync(calls, "utf8"), "call\ncall\n");
      await assert.rejects(t.core.call("mcp.setToolEnabled", { name: "docs", source: join(t.workspace, ".pi", "mcp.json"), tool: "echo", enabled: false }), /项目/);
    } finally { await client.close(); }
  } finally { await t.cleanup(); }
});

test("T89 link import follows redirects, preserves references, stays pending, and cleans downloads", async () => {
  const t = await startTestCore(); let server: ReturnType<typeof createServer> | undefined;
  try {
    const zip = join(t.dir, "skill.zip");
    await writeArchive(zip, [], [{ name: "repo/t89-sample/SKILL.md", data: Buffer.from(markdown()) }, { name: "repo/t89-sample/references/guide.md", data: Buffer.from("reference") }]);
    server = createServer((req, res) => { if (req.url === "/redirect") { res.writeHead(302, { Location: "/skill.zip" }); res.end(); } else { res.end(readFileSync(zip)); } });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const result = await t.core.call("skills.importUrl", { url: `http://127.0.0.1:${port}/redirect` }) as { baseDir: string; enabled: boolean; trust: string };
    assert.equal(result.enabled, false); assert.equal(result.trust, "untrusted"); assert.equal(readFileSync(join(result.baseDir, "references", "guide.md"), "utf8"), "reference");
    assert.equal((await t.core.call("proposals.list", {}) as unknown[]).length, 1);
    assert.equal(skillDownloadTarget("https://github.com/a/b/tree/main/skills/demo").directory, "skills/demo");
    await assert.rejects(withSkillDownload("file:///C:/secret", () => {}), /网页链接/);
    let temporary = "";
    await assert.rejects(withSkillDownload("https://example.invalid/SKILL.md", (folder) => { temporary = folder; throw Error("consume failed"); }, async () => new Response(markdown()) as never), /consume failed/);
    assert.equal(existsSync(temporary), false);
    assert.equal(readdirSync(result.baseDir).includes("download.zip"), false);
  } finally { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); await t.cleanup(); }
});
