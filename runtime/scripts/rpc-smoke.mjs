// RPC smoke test: talks to `pi --mode rpc` over raw JSONL exactly the way the
// Dart client will (LF framing, id correlation, no readline), and records every
// stdout record into fixtures/ so the Dart parser can be tested against real data.
//
// Usage:
//   node scripts/rpc-smoke.mjs              # state/model/command queries only (no LLM call)
//   node scripts/rpc-smoke.mjs --prompt     # also runs one small prompt with a tool call
//   node scripts/rpc-smoke.mjs --prompt --scenario thinking   # thinking + bash tool
//   node scripts/rpc-smoke.mjs --prompt --scenario abort      # abort mid-stream
// Add --model <provider/id> to pick the model explicitly.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(runtimeDir, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const fixturesDir = join(runtimeDir, "fixtures");
const withPrompt = process.argv.includes("--prompt");
const modelIndex = process.argv.indexOf("--model"); // e.g. --model cc-switch-deep-seek/deepseek-flash
const modelArg = modelIndex === -1 ? undefined : process.argv[modelIndex + 1];
const scenarioIndex = process.argv.indexOf("--scenario");
const scenario = scenarioIndex === -1 ? "read" : process.argv[scenarioIndex + 1];
const scenarios = {
	read: { message: "Use the read tool to read hello.txt, then reply with exactly its content and nothing else." },
	thinking: {
		thinkingLevel: "high",
		message: "Think briefly, then use the bash tool to run `ls` in the current directory and tell me how many entries there are.",
	},
	abort: { message: "Write a 600-word essay about the sea.", abortAfterTextDeltas: 5 },
};
const plan = scenarios[scenario];
if (!plan) throw new Error(`unknown scenario: ${scenario}`);
const workspace = mkdtempSync(join(tmpdir(), "dreamflutter-smoke-"));
writeFileSync(join(workspace, "hello.txt"), "hello from dreamflutter\n");

const child = spawn(process.execPath, [cliPath, "--mode", "rpc", "--no-session"], {
	cwd: workspace,
	stdio: ["pipe", "pipe", "pipe"],
});

const records = [];
const pending = new Map();
const eventListeners = new Set();
let nextId = 1;
let buffer = Buffer.alloc(0);

child.stdout.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	let newline;
	while ((newline = buffer.indexOf(0x0a)) !== -1) {
		let line = buffer.subarray(0, newline).toString("utf8");
		buffer = buffer.subarray(newline + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (!line.trim()) continue;
		const record = JSON.parse(line);
		records.push(record);
		if (record.type === "response" && record.id && pending.has(record.id)) {
			pending.get(record.id)(record);
			pending.delete(record.id);
		} else {
			for (const listener of eventListeners) listener(record);
		}
	}
});
child.stderr.on("data", (chunk) => process.stderr.write(`[pi stderr] ${chunk}`));
child.on("exit", (code, signal) => console.log(`[pi exited] code=${code} signal=${signal}`));

function send(command, timeoutMs = 30_000) {
	const id = `req-${nextId++}`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout waiting for ${command.type}`)), timeoutMs);
		pending.set(id, (response) => {
			clearTimeout(timer);
			resolve(response);
		});
		child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
	});
}

function waitForEvent(type, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
		const listener = (record) => {
			if (record.type !== type) return;
			clearTimeout(timer);
			eventListeners.delete(listener);
			resolve(record);
		};
		eventListeners.add(listener);
	});
}

function summarize(response) {
	const status = response.success ? "ok " : "ERR";
	const detail = response.success ? JSON.stringify(response.data ?? null).slice(0, 160) : response.error;
	console.log(`${status} ${response.command.padEnd(30)} ${detail}`);
}

try {
	for (const type of [
		"get_state",
		"get_available_models",
		"get_available_thinking_levels",
		"get_commands",
		"get_session_stats",
		"get_messages",
	]) {
		summarize(await send({ type }));
	}

	if (withPrompt) {
		if (modelArg) {
			const slash = modelArg.indexOf("/");
			summarize(await send({ type: "set_model", provider: modelArg.slice(0, slash), modelId: modelArg.slice(slash + 1) }));
		}
		eventListeners.add((record) => {
			if (record.type === "message_update" && record.assistantMessageEvent?.type === "text_delta") {
				process.stdout.write(record.assistantMessageEvent.delta);
			} else if (record.type === "tool_execution_start") {
				console.log(`\n[tool start] ${record.toolName} ${JSON.stringify(record.args ?? {})}`);
			} else if (record.type === "tool_execution_end") {
				console.log(`[tool end] ${record.toolName} isError=${record.isError}`);
			}
		});
		if (plan.thinkingLevel) summarize(await send({ type: "set_thinking_level", level: plan.thinkingLevel }));
		if (plan.abortAfterTextDeltas) {
			let deltas = 0;
			eventListeners.add((record) => {
				if (record.type !== "message_update" || record.assistantMessageEvent?.type !== "text_delta") return;
				if (++deltas === plan.abortAfterTextDeltas) send({ type: "abort" }).then(summarize);
			});
		}
		const settled = waitForEvent("agent_settled", 180_000);
		summarize(await send({ type: "prompt", message: plan.message }));
		await settled;
		console.log("\n[agent_settled]");
		summarize(await send({ type: "get_session_stats" }));
	}
} catch (error) {
	console.error(`[smoke failed] ${error.message}`);
	process.exitCode = 1;
} finally {
	child.stdin.end();
	await new Promise((resolve) => child.once("exit", resolve));
	mkdirSync(fixturesDir, { recursive: true });
	const name = !withPrompt ? "queries" : scenario === "read" ? "prompt" : scenario;
	const file = join(fixturesDir, `rpc-session-${name}.jsonl`);
	writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
	const types = {};
	for (const r of records) {
		const key = r.type === "response" ? `response:${r.command}` : r.type;
		types[key] = (types[key] ?? 0) + 1;
	}
	console.log(`[recorded ${records.length} records → ${file}]`);
	console.log(types);
}
