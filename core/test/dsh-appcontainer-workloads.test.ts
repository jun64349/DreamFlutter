import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, posix, win32 } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { bundledPython } from "../src/agent/toolchain.ts";
import { JobRegistry, pwshTool } from "../src/agent/shell.ts";
import { resolveSandboxEnv, type HarnessState } from "../src/agent/state.ts";
import { collectGit } from "../src/git/process.ts";
import { GoalsModule } from "../src/modules/goals.ts";
import {
	appContainerSandboxEnv, appContainerWorkspacePath, provisionAppContainer, removeAppContainerProfile,
	type AppContainerConfig,
} from "../src/sandbox/appcontainer.ts";
import { expectRpcError, startContractHarness, type ContractHarness } from "./api-contract/harness.ts";

const fixturePackage = process.env.DREAMFLUTTER_APPCONTAINER_TEST_PACKAGE;
const evidenceDir = process.env.DREAMFLUTTER_APPCONTAINER_TEST_EVIDENCE;
const exec = promisify(execFile);
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/dsh/native-workloads/${name}`, import.meta.url));
const readFixture = (name: string) => readFile(fixture(name), "utf8");

type Task = { goalId: string; inputs: string[]; deliverables: string[] };
type Delivery = { name: string; path: string; size: number };

async function startNativeWindow(t: TestContext, directDriveRoot?: string, defaultPath = false) {
	const ws = await startContractHarness(t, { dshWorkbench: true });
	const packageRoot = fixturePackage!;
	const bin = join(packageRoot, "core", "bin");
	const python = bundledPython(join(packageRoot, "core", "python"));
	assert(python, "packaged Python must be available");
	const bridgePath = join(ws.dir, "appcontainer-runner.exe");
	const build = fileURLToPath(new URL("../../tools/appcontainer-runner/build.ps1", import.meta.url));
	await exec(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		["-NoProfile", "-NonInteractive", "-File", build, "-OutputPath", bridgePath], { windowsHide: true });
	const candidate = directDriveRoot && await realpath(directDriveRoot);
	if (candidate) assert.match(candidate, /^[a-z]:\\$/i, "the optional test location must be a real drive root");
	const dataDir = candidate || (defaultPath ? join(ws.dir, "dreamflutter-window-installation", "data", "sandbox", "native-windows") : ws.dir);
	if (!candidate) await mkdir(dataDir, { recursive: true });
	const config: AppContainerConfig = {
		dataDir, profileId: randomUUID().replaceAll("-", ""), bridgePath,
		toolsSource: { node: join(packageRoot, "runtime", "node.exe"), python: dirname(python), uv: join(bin, "uv.exe"),
			rg: join(bin, "rg.exe"), fd: join(bin, "fd.exe"), git: join(bin, "git") },
	};
	await provisionAppContainer(config);
	const workspaceDir = appContainerWorkspacePath(config);
	ws.core.sandboxProvider = () => ({ kind: "appcontainer", appContainer: config, distro: "fixture-native", workspaceDir,
		ready: async () => {}, online: () => false });
	const close = async () => {
		try { await ws.core.shutdown(); }
		finally {
			await removeAppContainerProfile(config);
			if (candidate) {
				const expected = dirname(workspaceDir);
				const physical = await realpath(expected);
				assert.equal(physical.toLowerCase(), expected.toLowerCase());
				assert.equal(dirname(physical).toLowerCase(), candidate.toLowerCase());
				assert.equal(basename(physical), `appcontainer-${config.profileId}`);
				await rm(physical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			}
		}
	};
	return { ws, config, workspaceDir, close };
}

async function queueTask(ws: ContractHarness, text: string, files: string[], inputs: string[] = []) {
	const goals = ws.core.module(GoalsModule)!;
	goals.executor.stop();
	const { slotId, sessionFile } = await ws.call<{ slotId: string; sessionFile: string }>("slot.open", {
		cwd: ws.core.paths.butterflyDir, sandbox: true,
	});
	const attachments = inputs.length ? (await ws.call<{ paths: string[] }>("butterfly.import", { paths: inputs })).paths : [];
	assert.equal(attachments.length, inputs.length);
	await ws.call("slot.send", { slotId, record: { id: "native-workload", type: "prompt", operationId: randomUUID(), message: text,
		chatInput: { text, attachments: attachments.map(path => ({ path, kind: "file" })) } } });
	const [task] = await ws.call<Task[]>("butterfly.chat.tasks", { sessionFile });
	assert.ok(task, `${text}: no Butterfly chat goal`);
	assert.deepEqual(task.deliverables.map(file => posix.basename(file)), files);
	return task;
}

async function acceptAndRetrieve(ws: ContractHarness, task: Task, evidenceFolder: string) {
	const goals = ws.core.module(GoalsModule)!;
	goals.executor.start();
	const diagnostic = () => {
		const goal = goals.scheduler.detail(task.goalId);
		return JSON.stringify({ status: goal.status, reason: goal.reason, checks: goals.scheduler.latestProgram(goal.id, goal.revision)?.checks,
			receipts: goals.scheduler.receipts(goal.id, goal.revision), runs: ws.core.db.all("SELECT status,substr(error,1,1000) AS error FROM runs"),
			lastTools: ws.events.filter(event => event.event === "slot.record" && (event.record as { type: string })?.type === "tool_execution_end").slice(-5) });
	};
	await ws.waitFor(() => ws.core.autonomy.effects.get(`chat-delivery:${task.goalId}`)?.state === "completed", 65_000)
		.catch(error => {
			const details = diagnostic();
			goals.scheduler.control(task.goalId, "cancel", "native-workload-test-timeout");
			assert.fail(`${String(error)}\n${details}`);
		});
	const listings = await ws.call<Delivery[]>("butterfly.outbox");
	const output = new Map<string, Buffer>();
	for (const logical of task.deliverables) {
		const name = posix.basename(logical);
		const artifact = await ws.call<Delivery>("butterfly.chat.artifact", { goalId: task.goalId, name });
		const listing = listings.find(file => file.name === `${task.goalId}/${name}`);
		assert.ok(listing, `outbox did not list ${name}`);
		const bytes = await readFile(artifact.path);
		assert.equal(artifact.size, bytes.length);
		assert.equal(listing.size, bytes.length);
		assert.deepEqual(await readFile(listing.path), bytes);
		output.set(name, bytes);
	}
	await expectRpcError(ws.call("butterfly.chat.artifact", { goalId: task.goalId, name: "../queue-report.md" }), "not_found");
	if (evidenceDir) {
		const folder = join(evidenceDir, evidenceFolder);
		await mkdir(folder, { recursive: true });
		for (const [name, content] of output) await writeFile(join(folder, name), content);
	}
	return output;
}

test("Butterfly reports on two source attachments and runs a queue simulation, then executes a Node plugin matrix", {
	skip: !fixturePackage || process.platform !== "win32", timeout: 240_000,
}, async t => {
	const { ws, config, workspaceDir, close } = await startNativeWindow(t);
	const toNativePath = (file: string) => appContainerSandboxEnv(config).resolve(workspaceDir, file);
	try {
		await t.test("research reads local evidence and delivers a real Python simulation", async () => {
			const inputs = ["queue-theory.md", "queue-operating-sample.csv"];
			const names = ["queue-report.md", "queue-results.csv", "queue-simulation.py", ...inputs];
			const task = await queueTask(ws, `请先核对两份排队资料，再运行模拟，最后交付 ${names.join("、")}。`, names, inputs.map(fixture));
			assert.equal(task.inputs.length, 2);
			const targetDir = posix.dirname(task.deliverables[0]!);
			const code = await readFixture("queue-simulation.py");
			const script = toNativePath(`${targetDir}/queue-simulation.py`);
			let modelContext = "";
			ws.faux.setResponses([context => {
				modelContext = JSON.stringify(context.messages);
				return fauxAssistantMessage(task.inputs.map(file_path => fauxToolCall("read", { file_path })), { stopReason: "toolUse" });
			}, context => {
				assert.match(JSON.stringify(context.messages), /Q-THEORY-1/);
				assert.match(JSON.stringify(context.messages), /Q-OPERATIONS-1/);
				return fauxAssistantMessage([fauxToolCall("write", { file_path: script, content: code })], { stopReason: "toolUse" });
			}, fauxAssistantMessage([fauxToolCall("python", { code: [
				"from pathlib import Path", `script = ${JSON.stringify(script)}`, "namespace = {'__name__': 'simulation'}",
				"exec(compile(Path(script).read_text(encoding='utf-8'), script, 'exec'), namespace)",
				`namespace['main'](${[...task.inputs, targetDir].map(file => `Path(${JSON.stringify(toNativePath(file))})`).join(", ")})`,
			].join("\n"), timeout: 45 })], { stopReason: "toolUse" }), context => {
				assert.match(JSON.stringify(context.messages.at(-1)), /Simulated 3 queue scenarios with 120000 retained samples each/);
				return fauxAssistantMessage([fauxToolCall("goal_report", { status: "done", note: "核对两份原始资料和三组理论值，模拟输出已写入交付目录。" })], { stopReason: "toolUse" });
			}, fauxAssistantMessage("已完成排队模拟和来源核对。")]);
			const output = await acceptAndRetrieve(ws, task, "research");
			assert.match(modelContext, /Windows AppContainer/);
			const report = output.get("queue-report.md")!.toString("utf8");
			for (const source of inputs) {
				const original = await readFile(fixture(source));
				assert.deepEqual(output.get(source), original);
				assert.ok(report.includes(createHash("sha256").update(original).digest("hex")), source);
			}
			assert.match(report, /本地合成材料/);
			assert.match(report, /10,000.*120,000/);
			const csv = output.get("queue-results.csv")!.toString("utf8").trim().split(/\r?\n/);
			assert.equal(csv.length, 4);
			assert.match(csv[0]!, /simulated_p95_min,relative_error$/);
			let previous = 0;
			for (const row of csv.slice(1)) {
				const [, arrival, service, , warmup, samples, theory, average, p95, error] = row.split(",").map(Number);
				assert.equal(warmup, 10000);
				assert.equal(samples, 120000);
				assert.ok(Math.abs(theory! - arrival! / service! / (service! - arrival!)) < 0.00001, row);
				assert.ok(error! >= 0 && error! < 0.12, row);
				assert.ok(previous < average! && average! < p95!, row);
				previous = average!;
			}
		});

		await t.test("compatibility executes Node modules across two plugin hosts and both enable states", async () => {
			const codeFiles = ["compat-check.cjs", "compat-plugin.cjs", "compat-plugin.mjs", "compat-manifest.json"];
			const names = ["compat-report.md", "compat-results.json", ...codeFiles];
			const task = await queueTask(ws, `请先构造合成温度插件，再实跑启停和宿主版本矩阵，最后交付 ${names.join("、")}。`, names);
			const targetDir = toNativePath(posix.dirname(task.deliverables[0]!));
			const scripts = await Promise.all(codeFiles.map(async file => fauxToolCall("write", { file_path: join(targetDir, file), content: await readFixture(file) })));
			const pwsh = (description: string, command: string) => fauxToolCall("pwsh", { description, command, workdir: targetDir, timeoutMs: 30_000 });
			ws.faux.setResponses([fauxAssistantMessage(scripts, { stopReason: "toolUse" }), fauxAssistantMessage([
				pwsh("运行插件兼容矩阵", "node .\\compat-check.cjs"),
				pwsh("核对 Node 参数传递", String.raw`node.exe -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- '-leading' '' 'arg with spaces' '中文"尾\'`),
				pwsh("核对 Python 退出码", String.raw`python -c 'import sys; print("python child"); sys.stderr.write("child stderr\n"); sys.exit(7)'`),
				pwsh("确认 Git 版本", "git --version"),
			], { stopReason: "toolUse" }), context => {
				const lastTools = context.messages.slice(-4);
				const messages = JSON.stringify(lastTools);
				assert.match(messages, /Verified 8 plugin cases under v/);
				const argvResult = lastTools.find(message => message.role === "toolResult" && JSON.stringify(message.content).includes("arg with spaces"));
				assert.equal(argvResult?.role, "toolResult");
				const argvText = argvResult.content[0];
				assert.equal(argvText?.type, "text");
				assert.equal(argvText.text.trim(), JSON.stringify(["-leading", "", "arg with spaces", '中文"尾\\']));
				assert.match(messages, /python child/);
				assert.match(messages, /child stderr/);
				assert.match(messages, /exit code: 7/i);
				assert.match(messages, /git version /);
				return fauxAssistantMessage([fauxToolCall("goal_report", { status: "done", note: "八项矩阵均产生执行回执并核对结果。" })], { stopReason: "toolUse" });
			}, fauxAssistantMessage("已交付受控插件的兼容矩阵。")]);
			const output = await acceptAndRetrieve(ws, task, "compatibility");
			const result = JSON.parse(output.get("compat-results.json")!.toString("utf8"));
			assert.equal(result.platform, "win32");
			const packageNode = await exec(join(fixturePackage!, "runtime", "node.exe"), ["--version"]);
			assert.equal(result.runtime, packageNode.stdout.trim());
			const expected = [
				{ hostApi: 1, enabled: false, invoked: false, result: "disabled" },
				{ hostApi: 1, enabled: true, invoked: false, result: "unsupported_api" },
				{ hostApi: 2, enabled: false, invoked: false, result: "disabled" },
				{ hostApi: 2, enabled: true, invoked: true, result: "20 °C" },
			];
			assert.deepEqual(result.rows, ["cjs", "mjs"].flatMap(format => expected.map(row => ({ format, ...row }))));
		});
	} finally { await close(); }
});

test("native PowerShell runs literal packaged tool commands and retains PowerShell syntax in a standard workspace", {
	skip: !fixturePackage || process.platform !== "win32", timeout: 100_000,
}, async t => {
	const { config, workspaceDir, close } = await startNativeWindow(t, undefined, true);
	try {
		const env = resolveSandboxEnv({ appContainer: config, distro: "fixture-native" });
		const jobs = new JobRegistry();
		const route: string[] = [];
		const state = { cwd: workspaceDir, env: { ...env, spawn: (bin: string, args: string[], cwd: string) => {
			route.push(bin);
			return env.spawn(bin, args, cwd);
		} } } as HarnessState;
		const shell = pwshTool(state, jobs);
		const run = async (command: string) => {
			const result = await shell.execute("test", { description: "Probe packaged tools", command, timeoutMs: 20_000 }, undefined, undefined, {} as never);
			return result.content.map(item => item.type === "text" ? item.text : "").join("\n").trim();
		};
		const argv = await run(String.raw`node.exe -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- '' 'a''b' '含$空 格|>' '尾\'`);
		assert.equal(argv, JSON.stringify(["", "a'b", "含$空 格|>", "尾\\"]));
		const python = await run(String.raw`python -c 'import sys;print("out");sys.stderr.write("err\n");sys.exit(7)'`);
		assert.match(python, /out/);
		assert.match(python, /err/);
		assert.deepEqual(route, ["node", "python"]);
		assert.match(python, /exit code: 7/i);
		assert.match(await run("git --version"), /^git version /);
		const ordinary = await run("$ExecutionContext.SessionState.LanguageMode; \"ordinary\" | ForEach-Object { $_.ToUpper() }; Write-Error 'expected error'; exit 7");
		assert.match(ordinary, /(?:Full|Constrained)Language/);
		assert.match(ordinary, /ORDINARY/);
		assert.match(ordinary, /expected error/);
		assert.match(ordinary, /exit code: 7/i);
		assert.deepEqual(route, ["node", "python", "git", "powershell"]);
		t.diagnostic(ordinary.match(/(?:Full|Constrained)Language/)![0]);
	} finally { await close(); }
});

test("packaged MinGit initializes and reads a repository in the selected native workspace", {
	skip: !fixturePackage || process.platform !== "win32" || process.env.DREAMFLUTTER_APPCONTAINER_TEST_REQUIRE_NATIVE_GIT !== "1",
	timeout: 90_000,
}, async t => {
	const directDriveRoot = process.env.DREAMFLUTTER_APPCONTAINER_TEST_DRIVE_ROOT;
	const { ws, config, workspaceDir, close } = await startNativeWindow(t, directDriveRoot);
	try {
		const hostDirectory = join(ws.dir, "host-git-control");
		await mkdir(hostDirectory);
		const hostGit = join(fixturePackage!, "core", "bin", "git", "cmd", "git.exe");
		const args = ["init", "--initial-branch=main", "repo"];
		await exec(hostGit, args, { cwd: hostDirectory, windowsHide: true });
		assert.match(await readFile(join(hostDirectory, "repo", ".git", "HEAD"), "utf8"), /refs\/heads\/main/);
		const native = appContainerSandboxEnv(config);
		const run = (args: string[], cwd = workspaceDir) => collectGit(native.spawn("git", args, cwd), undefined, undefined, undefined, true);
		const version = await run(["--version"]);
		assert.equal(version.code, 0, version.stderr);
		assert.match(version.stdout, /^git version /);
		const init = await run(args);
		assert.equal(init.code, 0, `${version.stdout.trim()}: ${init.stderr}`);
		const repo = join(workspaceDir, "repo");
		const git = async (args: string[], cwd = repo) => {
			const result = await run(args, cwd);
			assert.equal(result.code, 0, `${args.join(" ")}\n${result.stderr}`);
			return result.stdout.trim();
		};
		assert.match(await git(["status", "--porcelain=v1", "--branch"]), /^## No commits yet on main/);
		await writeFile(join(repo, "sample.txt"), "synthetic repository sample\n");
		await git(["add", "--", "sample.txt"]);
		await git(["-c", "user.name=Local fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Sample commit"]);
		await git(["branch", "secondary"]);
		assert.equal(win32.normalize(await git(["rev-parse", "--show-toplevel"])).toLowerCase(), repo.toLowerCase());
		await git(["worktree", "add", "../checkout", "secondary"]);
		assert.match(await git(["status", "--porcelain=v1", "--branch"], join(workspaceDir, "checkout")), /^## secondary$/);
		t.diagnostic(`MinGit init, status, add, commit, branch, worktree passed at ${config.dataDir}`);
	} finally { await close(); }
});
