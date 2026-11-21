import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "../../../core/node_modules/@earendil-works/pi-ai/dist/index.js";
import { startServer } from "../../../core/src/server.ts";
import { startTestCore } from "../../../core/test/harness.ts";

// Each launch has a fresh DSH and the same test-owned data and conversation files.
const fixture = await startTestCore(process.argv[2], { dshWorkbench: true });
const { core, workspace, sessionDir, dir } = fixture;
mkdirSync(core.paths.butterflyDir, { recursive: true });
const token = randomBytes(32).toString("hex");
const server = await startServer(core, { port: 0, token });
let context = "";
core.register("test.inspect", () => ({ context }));
core.register("test.reply", () => {
	fixture.respond(input => {
		context = JSON.stringify(input);
		return fauxAssistantMessage("窗口验证回执");
	});
	return {};
});
let closing = false;
async function close() {
	if (closing) return;
	closing = true;
	await server.close();
	await core.shutdown();
	process.exit(0);
}
core.register("test.shutdown", () => { setTimeout(() => void close(), 50); return {}; });
process.stdin.resume();
process.stdin.on("end", () => void close());
process.on("SIGTERM", () => void close());
process.stdout.write(JSON.stringify({ port: server.port, token, workspace, other: workspace, home: core.paths.butterflyDir,
	sessions: sessionDir, root: dir, persistent: true }) + "\n");
