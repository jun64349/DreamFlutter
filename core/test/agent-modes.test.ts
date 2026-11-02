import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { compactionBudget, MINIMAL_PERSONA, PLAN_POLICY } from "../src/agent/dsh-text.ts";
import { dshCompactionSettings, MINIMAL_TOOLS, pruneBlocks, STANDARD_TOOLS } from "../src/agent/harness.ts";
import { formatRead, readWindow } from "../src/agent/fs-tools.ts";
import { formatGrep, globArgs, parseGrep } from "../src/agent/search-tools.ts";
import { encodeForPwsh } from "../src/agent/shell.ts";
import { isReadOnlyCommand } from "../src/ext/approval.ts";
import { PLAN_APPROVE } from "../src/agent/interaction-tools.ts";
import { dialogs, settledCount, startTestCore, type TestCore } from "./harness.ts";

type Seen = { systemPrompt?: string; tools: string[]; messages: Context["messages"] };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("") : "";
}

describe("agent modes (DeepSeek Harness on Pi)", () => {
	let t: TestCore;
	const seen: Seen[] = [];
	const capture = (answer: string | Parameters<typeof fauxAssistantMessage>[0], options?: Parameters<typeof fauxAssistantMessage>[1]) => (context: Context) => {
		// Pi 1.4 carries the system prompt and tool declarations in the transcript as system messages.
		const system = context.messages.filter((m) => (m.role as string) === "system") as unknown as { content: string; toolsAdded?: { name: string }[]; toolsRemoved?: string[] }[];
		const tools = new Set<string>();
		for (const s of system) {
			for (const tool of s.toolsAdded ?? []) tools.add(tool.name);
			for (const name of s.toolsRemoved ?? []) tools.delete(name);
		}
		seen.push({ systemPrompt: system.at(-1)?.content, tools: [...tools], messages: structuredClone(context.messages.filter((m) => (m.role as string) !== "system")) });
		return fauxAssistantMessage(answer, options);
	};

	beforeEach(async () => {
		t = await startTestCore();
		seen.length = 0;
	});
	afterEach(async () => {
		await t.cleanup();
	});

	async function open(slotId: string, agentMode?: "standard" | "minimal") {
		return (await t.core.call("slot.open", { slotId, cwd: t.workspace, agentMode }, t.client)) as { agentMode: string };
	}

	async function prompt(slotId: string, message: string) {
		const before = settledCount(t.records(slotId));
		await t.send(slotId, { id: `p-${Math.random()}`, type: "prompt", message });
		await t.waitFor(() => settledCount(t.records(slotId)) === before + 1);
	}

	it("standard mode shows dsh's prompt sections and tool catalog", async () => {
		writeFileSync(join(t.workspace, "AGENTS.md"), "用中文回答。");
		const info = await open("s1");
		assert.equal(info.agentMode, "standard");
		t.respond(capture("好"));
		await prompt("s1", "你好");
		const request = seen[0]!;
		assert.match(request.systemPrompt!, /^You are an AI agent powered by DeepSeek Harness\.\n\nYou are a coding agent powered by the faux-1 model\.\n\nNon-zero exits/);
		assert.doesNotMatch(request.systemPrompt!, /operating inside pi/);
		for (const tool of STANDARD_TOOLS) assert.ok(request.tools.includes(tool), `standard declares ${tool}`);
		assert.ok(request.tools.includes("memory_search"), "standard keeps DreamFlutter's memory tools");
		assert.ok(!request.tools.includes("bash"), "Pi's bash is replaced by pwsh");
		const texts = request.messages.map((m) => textOf(m.content));
		assert.equal(texts[0], "你好");
		assert.ok(texts.some((x) => x.includes("Instructions from: AGENTS.md\n\n用中文回答。")));
		assert.ok(texts.some((x) => x.includes("<available_skills>")));
		assert.ok(texts.some((x) => x.startsWith(`Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: ${JSON.stringify(t.workspace)}.`)));
		assert.ok(texts.some((x) => /^Time sampled while preparing turn 1, step 1: \d{4}-\d\d-\d\dT/.test(x)));

		// The next turn repeats none of them: each is sent only when it changed.
		t.respond(capture("好的"));
		await prompt("s1", "再见");
		const second = seen[1]!.messages.map((m) => textOf(m.content));
		const count = (needle: string) => second.filter((x) => x.includes(needle)).length;
		assert.equal(count("Instructions from: AGENTS.md"), 1);
		assert.equal(count("<available_skills>"), 1);
		assert.equal(count("Current runtime context."), 1);
		assert.equal(count("Time sampled while preparing"), 1, "time context refreshes at most every 10 minutes");
	});

	it("minimal mode is dsh's minimal preset: one sentence, three tools, only the working-directory context", async () => {
		const info = await open("s1", "minimal");
		assert.equal(info.agentMode, "minimal");
		t.respond(capture("好"));
		await prompt("s1", "你好");
		const request = seen[0]!;
		assert.equal(request.systemPrompt, MINIMAL_PERSONA);
		assert.deepEqual([...request.tools].sort(), [...MINIMAL_TOOLS].sort());
		const texts = request.messages.map((m) => textOf(m.content));
		assert.deepEqual(texts, ["你好", `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: ${JSON.stringify(t.workspace)}.`]);
	});

	it("a new session can switch mode; an existing session keeps the mode it was created in", async () => {
		await open("s1", "minimal");
		t.respond(capture("好"));
		await prompt("s1", "一");
		const file = t.core.slot("s1").info().sessionFile!;
		await t.send("s1", { id: "n", type: "new_session", agentMode: "standard" });
		await t.waitFor(() => t.records("s1").find((r) => r.id === "n"));
		assert.equal(t.core.slot("s1").info().agentMode, "standard");
		await t.core.closeSlot("s1");
		const reopened = (await t.core.call("slot.open", { slotId: "s2", cwd: t.workspace, sessionFile: file, agentMode: "standard" }, t.client)) as { agentMode: string };
		assert.equal(reopened.agentMode, "minimal");
	});

	it("never writes the user's Pi settings", async () => {
		const settingsFile = join(t.agentDir, "settings.json");
		writeFileSync(settingsFile, JSON.stringify({ compaction: { enabled: true } }));
		await open("s1");
		await t.send("s1", { id: "c", type: "set_auto_compaction", enabled: false });
		await t.waitFor(() => t.records("s1").find((r) => r.id === "c"));
		t.core.settings.update({ autoCompaction: false });
		assert.equal(readFileSync(settingsFile, "utf8"), JSON.stringify({ compaction: { enabled: true } }));
		await t.send("s1", { id: "st", type: "get_state" });
		const state = await t.waitFor(() => t.records("s1").find((r) => r.id === "st"));
		assert.equal((state.data as { autoCompactionEnabled: boolean }).autoCompactionEnabled, false);
	});

	it("edit needs a prior read, and the file must not change in between", async () => {
		t.core.settings.update({ approvalMode: "off" });
		const file = join(t.workspace, "a.txt");
		writeFileSync(file, "one\r\ntwo\r\n");
		await open("s1");
		const results: string[] = [];
		const collect = (context: Context) => {
			const last = context.messages.at(-1)!;
			results.push(textOf(last.content));
		};
		t.respond(
			fauxAssistantMessage([fauxToolCall("edit", { file_path: "a.txt", old_string: "two", new_string: "2" })], { stopReason: "toolUse" }),
			(context) => {
				collect(context);
				return fauxAssistantMessage([fauxToolCall("read", { file_path: "a.txt" })], { stopReason: "toolUse" });
			},
			(context) => {
				collect(context);
				return fauxAssistantMessage([fauxToolCall("edit", { file_path: "a.txt", old_string: "two", new_string: "2" })], { stopReason: "toolUse" });
			},
			(context) => {
				collect(context);
				writeFileSync(file, "changed elsewhere\n");
				return fauxAssistantMessage([fauxToolCall("edit", { file_path: "a.txt", old_string: "changed", new_string: "x" })], { stopReason: "toolUse" });
			},
			(context) => {
				collect(context);
				return fauxAssistantMessage("完成");
			},
		);
		await prompt("s1", "改一下");
		assert.equal(results[0], `cannot modify "${file}": file has not been read — read the file, then retry`);
		assert.equal(results[1], `<path>${file}</path>\n<type>file</type>\n<content>\n1: one\n2: two\n\n(End of file - total 2 lines)\n</content>`);
		assert.equal(results[2], `The file ${file} has been updated successfully.`);
		assert.equal(results[3], `cannot edit "${file}": file changed since it was read — re-read the file, then retry`);
		assert.equal(readFileSync(file, "utf8"), "changed elsewhere\n");
	});

	it("plan mode adds dsh's policy and narration; exit_plan_mode asks the user and leaves it", async () => {
		t.core.settings.update({ approvalMode: "off" });
		await open("s1");
		t.respond(capture("好"));
		await prompt("s1", "先聊两句");
		seen.length = 0;
		await t.send("s1", { id: "pm", type: "df_set_plan_mode", on: true });
		await t.waitFor(() => t.records("s1").find((r) => r.id === "pm"));
		assert.equal(t.core.slot("s1").info().planMode, true);
		t.respond(capture([fauxToolCall("exit_plan_mode", { plan: "# 计划\n\n1. 做事" })], { stopReason: "toolUse" }), capture("开始执行"));
		await t.send("s1", { id: "p", type: "prompt", message: "做个计划" });
		const dialog = await t.waitFor(() => dialogs(t.records("s1"))[0]);
		assert.match(String(dialog.title), /# 计划/);
		await t.send("s1", { type: "extension_ui_response", id: dialog.id, value: PLAN_APPROVE });
		await t.waitFor(() => settledCount(t.records("s1")) === 2);
		assert.ok(seen[0]!.systemPrompt!.includes(PLAN_POLICY));
		assert.ok(seen[0]!.messages.some((m) => textOf(m.content) === "The user switched this session to plan mode."));
		assert.match(textOf(seen[1]!.messages.at(-1)!.content), /^Plan approved — plan mode exited/);
		assert.equal(t.core.slot("s1").info().planMode, false);
		const states = t.records("s1").filter((r) => r.type === "df_agent_state");
		assert.equal(states.at(-1)!.planMode, false);
	});

	it("an unanswered question takes the recommended option when its time is up (extra test 12)", async () => {
		t.core.settings.update({ approvalMode: "off", askTimeoutSeconds: 1 });
		await open("s1");
		const question = { id: "q1", question: "用哪种格式？", options: [{ label: "Word" }, { label: "PDF (Recommended)" }] };
		t.respond(capture([fauxToolCall("ask_user_question", { questions: [question] })], { stopReason: "toolUse" }), capture("好的，用 PDF"));
		await t.send("s1", { id: "p", type: "prompt", message: "做个报告" });
		const dialog = await t.waitFor(() => dialogs(t.records("s1"))[0]);
		assert.equal(dialog.timeout, 1000, "the window can show a countdown");
		await t.waitFor(() => settledCount(t.records("s1")) === 1, 5000);
		const result = textOf(seen[1]!.messages.at(-1)!.content);
		assert.deepEqual(JSON.parse(result.split("\n")[0]!).answers, [{ id: "q1", selected: ["PDF (Recommended)"], timedOut: true }]);
		assert.match(result, /did not answer within 1 seconds/);
	});

	it("todo_write reports the list to the window", async () => {
		t.core.settings.update({ approvalMode: "changes" });
		await open("s1");
		t.respond(
			fauxAssistantMessage([fauxToolCall("todo_write", { todos: [{ content: "读代码", status: "in_progress" }, { content: "写测试", status: "pending" }] })], { stopReason: "toolUse" }),
			capture("好"),
		);
		await prompt("s1", "开始");
		assert.equal(dialogs(t.records("s1")).length, 0, "todo_write needs no approval");
		assert.equal(textOf(seen[0]!.messages.at(-1)!.content), "Updated todo list: 1 pending, 1 in progress, 0 completed.");
		const state = t.records("s1").filter((r) => r.type === "df_agent_state").at(-1)!;
		assert.deepEqual(state.todos, [
			{ content: "读代码", status: "in_progress" },
			{ content: "写测试", status: "pending" },
		]);
	});

	it("a skill loads through the skill tool in dsh's frame", async () => {
		const dir = join(t.agentDir, "skills", "greet");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), "---\nname: greet\ndescription: Say hello politely.\n---\n\nSay 你好.\n");
		await open("s1");
		t.respond(capture([fauxToolCall("skill", { name: "greet" })], { stopReason: "toolUse" }), capture("你好"));
		await prompt("s1", "打个招呼");
		assert.ok(seen[0]!.messages.some((m) => textOf(m.content).includes("- `greet`: Say hello politely.")));
		assert.equal(textOf(seen[1]!.messages.at(-1)!.content).split("\n")[0], '<skill_content name="greet">');
		assert.match(textOf(seen[1]!.messages.at(-1)!.content), /<skill_instructions>\nSay 你好\.\n<\/skill_instructions>/);
	});
});

describe("dsh formats", () => {
	it("read windows number lines and report the end of file", () => {
		const window = readWindow("a\nb\nc\n", 2, 1, "x");
		assert.deepEqual(window.lines, [{ number: 2, text: "b" }]);
		assert.equal(formatRead("x", 2, window.lines, window.totalLines, false), "<path>x</path>\n<type>file</type>\n<content>\n2: b\n\n(Showing lines 2-2 of 3. Use offset=3 to continue.)\n</content>");
		assert.throws(() => readWindow("a\n", 5, 10, "x"), /offset 5 is out of range for "x" \(1 lines\)/);
	});

	it("grep groups matches by file; glob prunes simple directory prefixes", () => {
		const stdout = [
			JSON.stringify({ type: "begin", data: { path: { text: "a.ts" } } }),
			JSON.stringify({ type: "match", data: { path: { text: "a.ts" }, line_number: 3, lines: { text: "const x = 1;\n" } } }),
			JSON.stringify({ type: "match", data: { path: { text: "b.ts" }, line_number: 7, lines: { text: "x()\r\n" } } }),
		].join("\n");
		const matches = parseGrep(stdout, (p) => `/w/${p}`);
		assert.equal(formatGrep(matches), "Found 2 matches\n\n/w/a.ts\nLine 3: const x = 1;\n\n/w/b.ts\nLine 7: x()");
		assert.equal(formatGrep([]), "No matches found");
		assert.deepEqual(globArgs("src/lib/*.ts", undefined).slice(0, 4), ["--files", "--glob=!**", "--glob={src,lib}/", "--glob=src/lib/*.ts"]);
		assert.equal(globArgs("src/**/*.ts", undefined)[1], "--glob=src/**/*.ts", "a ** segment is not pruned");
	});

	it("prunes oversized tool results to head and tail", () => {
		const long = "a".repeat(5000) + "b".repeat(5000);
		const [block] = pruneBlocks([{ type: "text", text: long }]);
		assert.equal(block!.text, `${"a".repeat(4096)}\n\n[... tool result middle pruned ...]\n\n${"b".repeat(1024)}`);
		const short = [{ type: "text", text: "ok" }];
		assert.equal(pruneBlocks(short), short);
	});

	it("compacts at dsh's threshold", () => {
		assert.deepEqual(compactionBudget(1_048_576, 256_000), { threshold: 727_040, retain: 126_812 });
		const settings = dshCompactionSettings({ contextWindow: 1_048_576, maxTokens: 393_216 }, true);
		assert.equal(1_048_576 - settings.reserveTokens, 589_824);
	});

	it("sends persistent-shell commands as ASCII", () => {
		const encoded = encodeForPwsh("Write-Output '中文'");
		assert.match(encoded, /^[\x20-\x7e]+$/);
		const base64 = /FromBase64String\('([^']+)'\)/.exec(encoded)![1]!;
		assert.equal(Buffer.from(base64, "base64").toString("utf8"), "Write-Output '中文'");
	});

	it("classifies read-only shell commands", () => {
		for (const command of ["Get-ChildItem", "git status", "git log --oneline -5 | Select-Object -First 3", "Get-Content a.txt | Select-String foo", "node --version", "ls; pwd"]) {
			assert.equal(isReadOnlyCommand(command), true, command);
		}
		for (const command of ["Remove-Item x", "git commit -m x", "echo hi > a.txt", "Get-Content a | Set-Content b", "Invoke-WebRequest x", "& ./run.ps1", "$(rm x)", "npm install"]) {
			assert.equal(isReadOnlyCommand(command), false, command);
		}
	});
});

describe("review fixes (stage 3a)", () => {
	let t: TestCore;
	const seen: Context["messages"][] = [];
	beforeEach(async () => {
		t = await startTestCore();
		seen.length = 0;
	});
	afterEach(async () => {
		await t.cleanup();
	});
	const record = (answer: string) => (context: Context) => {
		seen.push(structuredClone(context.messages.filter((m) => (m.role as string) !== "system")));
		return fauxAssistantMessage(answer);
	};
	async function prompt(message: string) {
		const before = settledCount(t.records("s1"));
		await t.send("s1", { id: `p-${Math.random()}`, type: "prompt", message });
		await t.waitFor(() => settledCount(t.records("s1")) === before + 1);
	}

	it("does not treat disguised writes as read-only commands", () => {
		for (const command of [
			"Remove-Item -v victim.txt",
			"Write-Output (Remove-Item victim.txt)",
			"git branch -D important",
			"git remote add evil x",
			"Get-ChildItem | ForEach-Object { Remove-Item $_ }",
			"rg --pre ./run.cmd foo",
			"Get-ChildItem -OutVariable x",
		]) {
			assert.equal(isReadOnlyCommand(command), false, command);
		}
		assert.equal(isReadOnlyCommand("git branch -a"), true);
		assert.equal(isReadOnlyCommand("git remote -v"), true);
	});

	it("v0.2 review: a lone & and git options that start programs need approval", () => {
		for (const command of [
			"echo ok & Remove-Item victim.txt",
			"Get-ChildItem &",
			"git grep --open-files-in-pager=calc.exe foo",
			"git grep --op=calc.exe foo",
			"git grep -Ocalc.exe foo",
			"git grep -nO foo",
			"git diff --ext-diff",
			"git log -p --ext",
			"'x' Remove-Item victim.txt",
			'"a" | Set-Content b.txt',
		]) {
			assert.equal(isReadOnlyCommand(command), false, command);
		}
		for (const command of [
			"git status && git log --oneline -3",
			"git grep -n foo",
			"git diff --stat",
			"git log --no-ext-diff -n 5",
			// A lone string between outputs, as models like to print (seen with deepseek-v4.1-flash in plan mode).
			'Get-ChildItem -Force | Select-Object Mode,Length,Name; "---"; Test-Path .\\plan-demo.txt',
		]) {
			assert.equal(isReadOnlyCommand(command), true, command);
		}
	});

	it("parallel edits of one file both land", async () => {
		t.core.settings.update({ approvalMode: "off" });
		const file = join(t.workspace, "two.txt");
		writeFileSync(file, "alpha\nbeta\n");
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
		t.respond(
			fauxAssistantMessage([fauxToolCall("read", { file_path: "two.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxToolCall("edit", { file_path: "two.txt", old_string: "alpha", new_string: "ALPHA" }), fauxToolCall("edit", { file_path: "two.txt", old_string: "beta", new_string: "BETA" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("好"),
		);
		await prompt("改两处");
		assert.equal(readFileSync(file, "utf8"), "ALPHA\nBETA\n");
	});

	it("workspace instructions are sent again only when they change", async () => {
		writeFileSync(join(t.workspace, "AGENTS.md"), "一");
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
		t.respond(record("1"));
		await prompt("第一轮");
		writeFileSync(join(t.workspace, "AGENTS.md"), "二");
		await t.send("s1", { id: "r", type: "df_reload" });
		await t.waitFor(() => t.records("s1").find((r) => r.id === "r"));
		t.respond(record("2"), record("3"));
		await prompt("第二轮");
		await prompt("第三轮");
		const count = (messages: Context["messages"]) => messages.filter((m) => textOf(m.content).includes("Instructions from: AGENTS.md")).length;
		assert.equal(count(seen[1]!), 2, "the replacement baseline follows the first");
		assert.equal(count(seen[2]!), 2, "an unchanged file is not sent a third time");
		assert.ok(seen[1]!.some((m) => textOf(m.content).startsWith("<system-reminder>\nThis complete workspace instruction baseline replaces")));
	});

	it("a manual compaction summarizes even a short session, in dsh's checkpoint frame", async () => {
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
		t.respond(fauxAssistantMessage("一"), fauxAssistantMessage("二"));
		await prompt("第一个问题");
		await prompt("第二个问题");
		let instruction = "";
		t.respond((context) => {
			instruction = textOf(context.messages.at(-1)!.content);
			return fauxAssistantMessage("## Primary Request and Intent\n- 两个问题");
		});
		await t.send("s1", { id: "c", type: "compact", customInstructions: "保留问题" });
		const response = await t.waitFor(() => t.records("s1").find((r) => r.id === "c"));
		assert.equal(response.success, true, JSON.stringify(response));
		assert.match(instruction, /^You are now acting as a compaction engine/);
		assert.match(instruction, /focus on: 保留问题$/);
		t.respond(record("三"));
		await prompt("继续");
		assert.ok(seen[0]!.some((m) => textOf(m.content).includes("<compacted-summary>## Primary Request and Intent\n- 两个问题</compacted-summary>")));
	});
});

describe("background job output", () => {
	it("keeps a large stream bounded, spills it whole, and a notice only consumes what it shows", async () => {
		const { spawn } = await import("node:child_process");
		const { JobRegistry, OutputStream } = await import("../src/agent/shell.ts");
		const big = new OutputStream("stdout");
		for (let i = 0; i < 40; i++) big.push(Buffer.from("x".repeat(64 * 1024)));
		const tail = big.tail();
		assert.equal(tail.truncated, true);
		assert.equal(Buffer.byteLength(tail.text), 64_000);
		assert.equal(readFileSync(big.spillPath!, "utf8").length, 40 * 64 * 1024);
		assert.equal(big.from(0).lossy, true);

		const jobs = new JobRegistry();
		const notices: string[] = [];
		jobs.onSettled = (_job, notice) => notices.push(notice);
		const child = spawn(process.execPath, ["-e", "process.stdout.write('y'.repeat(5000))"], { stdio: ["ignore", "pipe", "pipe"] });
		const out = new OutputStream("stdout");
		const err = new OutputStream("stderr");
		child.stdout!.on("data", (c: Buffer) => out.push(c));
		child.stderr!.on("data", (c: Buffer) => err.push(c));
		const job = jobs.start("pwsh", "big output", child, out, err);
		await job.done;
		assert.match(notices[0]!, /finished \[status: completed\]\. Read its output with job_output\.$/);
		assert.equal(jobs.read(job), "y".repeat(5000));
	});
});
