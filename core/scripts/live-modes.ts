/**
 * Live check of the agent modes against the user's real model (DeepSeek):
 * runs one small task per mode in a temp workspace and prints what happened.
 *   node --disable-warning=ExperimentalWarning scripts/live-modes.ts [mode...] [--task=<name>]
 * Uses ~/.pi/agent for models and keys; data and sessions go to a temp dir.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildCore } from "../src/app.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths } from "../src/paths.ts";

const TASKS: Record<string, { setup: (dir: string) => void; prompt: string; check: (dir: string) => boolean }> = {
	edit: {
		setup: (dir) => writeFileSync(join(dir, "calc.py"), "def add(a, b):\n    return a - b\n\nprint(add(2, 3))\n"),
		prompt: "calc.py 里的 add 函数有 bug，修好它，然后运行一下确认输出是 5。",
		check: (dir) => readFileSync(join(dir, "calc.py"), "utf8").includes("a + b"),
	},
	twoturn: {
		setup: (dir) => writeFileSync(join(dir, "notes.txt"), "苹果 3\n香蕉 5\n橙子 2\n"),
		prompt: "notes.txt 里一共有多少个水果？",
		check: () => true,
	},
};

const args = process.argv.slice(2);
const modes = args.filter((a) => a === "standard" || a === "minimal");
const taskName = args.find((a) => a.startsWith("--task="))?.slice(7) ?? "edit";
const task = TASKS[taskName]!;
const dir = mkdtempSync(join(tmpdir(), "df-live-"));
const agentDir = join(homedir(), ".pi", "agent");
const core = buildCore({ paths: corePaths(join(dir, "data")), agentDir, sessionDir: join(dir, "sessions"), log: new Logger(undefined, false), notifier: new RecordingNotifier() });
const defaultModel = process.env.DF_MODEL ?? "cc-switch-deep-seek/deepseek-flash";
core.settings.update({ defaultModel, defaultThinking: "high", autoTitle: false, memoryAutoExtract: false, approvalMode: "off" });
await core.start();

for (const mode of modes.length ? modes : ["minimal", "standard"]) {
	const workspace = join(dir, `ws-${mode}`);
	mkdirSync(workspace, { recursive: true });
	task.setup(workspace);
	const records: Record<string, unknown>[] = [];
	const client = core.addClient((m) => {
		if (m.event === "slot.record") records.push(m.record as Record<string, unknown>);
	});
	const started = Date.now();
	await core.call("slot.open", { slotId: mode, cwd: workspace, agentMode: mode }, client);
	const prompts = taskName === "twoturn" ? [task.prompt, "那香蕉占几成？只回答百分比。"] : [task.prompt];
	for (const prompt of prompts) {
		const before = records.filter((r) => r.type === "agent_settled").length;
		await core.call("slot.send", { slotId: mode, record: { id: "p", type: "prompt", message: prompt } }, client);
		const deadline = Date.now() + 10 * 60_000;
		while (records.filter((r) => r.type === "agent_settled").length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
	}
	if (args.includes("--compact")) {
		await core.call("slot.send", { slotId: mode, record: { id: "c", type: "compact", customInstructions: "保留文件内容" } }, client);
		const deadline = Date.now() + 5 * 60_000;
		let response: Record<string, unknown> | undefined;
		while (!(response = records.find((r) => r.id === "c")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
		console.log("压缩：", JSON.stringify(response).slice(0, 1500));
	}
	const run = core.runs.list({ limit: 1 })[0];
	const tools = records.filter((r) => r.type === "tool_execution_end").map((r) => `${r.toolName}${r.isError ? "(错)" : ""}`);
	const errors = records.filter((r) => r.type === "auto_retry_start" || (r.type === "message_end" && (r.message as { stopReason?: string })?.stopReason === "error"));
	const last = [...records].reverse().find((r) => r.type === "message_end" && (r.message as { role?: string }).role === "assistant") as { message: { content: { type: string; text?: string }[]; usage?: { input: number; output: number; cacheRead: number } } } | undefined;
	console.log(`\n=== ${mode} · ${taskName} · ${((Date.now() - started) / 1000).toFixed(1)}s · ${run?.status} · 通过=${task.check(workspace)}`);
	console.log(`工具: ${tools.join(", ") || "(无)"}`);
	console.log(`重试/错误: ${errors.length}  ${errors.map((e) => JSON.stringify(e).slice(0, 300)).join("\n")}`);
	console.log(`token: 输入 ${run?.tokens ?? "?"}  花费 ${run?.cost ?? "?"}  最后一条 usage ${JSON.stringify(last?.message.usage ?? {})}`);
	console.log(`回答: ${(last?.message.content.filter((c) => c.type === "text").map((c) => c.text).join("") ?? "").slice(0, 400)}`);
	await core.closeSlot(mode);
}
await core.shutdown();
console.log(`\n数据目录：${dir}`);
