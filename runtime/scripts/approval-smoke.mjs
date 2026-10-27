// Verifies extensions/dreamflutter-approval.ts over real RPC: in "all" mode a
// read tool call must raise a select dialog, and answering "拒绝" must block it.
//   node scripts/approval-smoke.mjs --model cc-switch-deep-seek/deepseek-flash

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(runtimeDir, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const extension = join(runtimeDir, "extensions/dreamflutter-approval.ts");
const modelArg = process.argv[process.argv.indexOf("--model") + 1];
const workspace = mkdtempSync(join(tmpdir(), "dreamflutter-approval-"));
writeFileSync(join(workspace, "hello.txt"), "secret\n");
const settingsFile = join(workspace, "settings.json");
writeFileSync(settingsFile, JSON.stringify({ approvalMode: "all" }));

const child = spawn(process.execPath, [cliPath, "--mode", "rpc", "--no-session", "--extension", extension], {
	cwd: workspace,
	env: { ...process.env, DREAMFLUTTER_SETTINGS_FILE: settingsFile },
	stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
let nextId = 1;
const pending = new Map();
const send = (cmd) =>
	new Promise((resolve) => {
		const id = `a-${nextId++}`;
		pending.set(id, resolve);
		child.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
	});

let dialog;
let toolEnd;
const settled = new Promise((resolve) => {
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let i;
		while ((i = buffer.indexOf("\n")) !== -1) {
			const record = JSON.parse(buffer.slice(0, i));
			buffer = buffer.slice(i + 1);
			if (record.type === "response" && pending.has(record.id)) pending.get(record.id)(record);
			else if (record.type === "extension_ui_request" && record.method === "select") {
				dialog = record;
				console.log(`[dialog] ${JSON.stringify(record.title)} options=${JSON.stringify(record.options)}`);
				child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, value: "拒绝" })}\n`);
			} else if (record.type === "tool_execution_end") toolEnd = record;
			else if (record.type === "agent_settled") resolve();
		}
	});
});

const slash = modelArg.indexOf("/");
await send({ type: "set_model", provider: modelArg.slice(0, slash), modelId: modelArg.slice(slash + 1) });
await send({ type: "prompt", message: "Use the read tool to read hello.txt. If it is blocked, just say BLOCKED." });
await settled;
child.stdin.end();

const blocked = toolEnd?.isError === true;
console.log(`[tool_end] isError=${toolEnd?.isError} text=${JSON.stringify(toolEnd?.result?.content?.[0]?.text ?? "")}`);
if (!dialog || !blocked) {
	console.error("approval smoke FAILED");
	process.exitCode = 1;
} else {
	console.log("approval smoke OK");
}
