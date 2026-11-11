import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildCore } from "../../src/app.ts";
import type { Core } from "../../src/core.ts";
import { Gateway } from "../../src/gateway/gateway.ts";
import { sandboxEnv } from "../../src/agent/state.ts";
import { Logger } from "../../src/log.ts";
import type { GoalScheduler } from "../../src/modules/goals.ts";
import { RecordingNotifier } from "../../src/notify.ts";
import { corePaths } from "../../src/paths.ts";
import { configurePiNetworking } from "../../src/pi/http.ts";
import { bundledImage } from "../../src/sandbox/image.ts";
import { runWsl } from "../../src/sandbox/sandbox.ts";
import { redact } from "../../src/security/redaction.ts";
import { evaluate, type Check, type Evidence } from "./checks.ts";
import type { Case } from "./cases.ts";
import type { RunRow } from "./dry.ts";
import { generateFixture, sha256 } from "./fixtures/generate.ts";
import { LiveBudget, priced } from "./live-budget.ts";
import { backgroundJob, jobEvidence, L5_QUESTION, sessionTrace, toolFacts } from "./live-evidence.ts";

type Goal = ReturnType<GoalScheduler["detail"]>;
type ModelChannel = { channel: string; models: string[] };
type Publish = (model: string, rows: readonly RunRow[]) => void;
const JOB_COMMAND = "& './long-job.ps1'";
const BASIC_TOOLS = ["read", "write", "edit", "glob", "grep", "todo"];
const DONE = new Set(["completed", "failed", "cancelled", "blocked", "paused", "waiting_user"]);
const failure = (error: unknown) => redact(error instanceof Error ? error.message : String(error), true).slice(0, 300);

async function wsl(args: string[], timeoutMs = 20_000) {
	const result = await runWsl(args, { timeoutMs });
	if (result.code !== 0) throw new Error(`临时 WSL 操作失败（${args[0]}，退出码 ${result.code ?? "超时"}）`);
	return result.stdout;
}

function unrun(item: Case, reason: string): RunRow {
	return { id: item.id, title: item.title, partition: item.sandbox ? "butterfly" : "workbench",
		passed: false, goalStatus: "未运行", runs: 0, costUsd: 0, budgetUsd: 0, requests: 0, elapsedMs: 0,
		reason, checks: [{ id: "run", title: "运行真实目标", passed: false, detail: reason }] };
}

function pickModel(copied: ModelChannel[]) {
	for (const candidate of copied) {
		const id = candidate.models.find(model => model === "deepseek-v4.1-flash")
			?? candidate.models.find(model => /deepseek.*flash/i.test(model));
		if (id) return { provider: `df-${candidate.channel}`, id };
	}
	throw new Error("已配置的 OpenCode Go 渠道没有 DeepSeek Flash，未发请求");
}

export async function runLiveRound(items: readonly Case[], source: string, publish: Publish) {
	const root = mkdtempSync(join(resolve(tmpdir()), "df-t105-live-"));
	const paths = corePaths(join(root, "data")), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
	const distro = "DF-T105-" + randomUUID().replaceAll("-", "");
	const budget = new LiveBudget(), rows: RunRow[] = [];
	let modelName = "opencode-go", qualified = "";
	let core: Core | undefined, imported = false, sandboxError: string | undefined;
	const boot = async () => {
		const log = new Logger(paths.logFile, false);
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
		await configurePiNetworking(agentDir, log);
		core = buildCore({ paths, agentDir, sessionDir, log, notifier: new RecordingNotifier(), modelRuntime: () => runtime,
			piMigration: { automatic: false }, gatewayTransport: budget.transport, sandbox: { distro } });
		// Real WSL tools use the disposable import. Its setup does not rewrite shared WSL firewall rules.
		core.sandboxProvider = () => imported ? { distro, ready: async () => {}, online: () => false } : undefined;
		core.settings.update({ defaultModel: qualified, goalReviewModel: qualified, approvalMode: "off", sandboxOnline: false,
			autoTitle: false, memoryAutoExtract: false, notifications: false, goalProposalEnabled: false });
		await core.start();
		core.module(Gateway)!.installRuntime(runtime);
		return runtime;
	};
	const current = (id: string) => core!.call("goals.get", { id }) as Promise<Goal>;
	try {
		mkdirSync(agentDir);
		mkdirSync(sessionDir);
		const copied = JSON.parse(execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning",
			fileURLToPath(new URL("../copy-channels.ts", import.meta.url)), resolve(source), paths.dataDir, "opencode-go"],
			{ encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })) as ModelChannel[];
		const model = pickModel(copied);
		modelName = model.id;
		qualified = `${model.provider}/${model.id}`;
		budget.configure(model.provider, model.id);
		const runtime = await boot();
		const available = (await runtime.getAvailable()).find(candidate => candidate.provider === model.provider && candidate.id === model.id);
		if (!available || !priced(core!.resolveModel(available))) throw new Error("OpenCode Go 模型不可用或缺少可核对的价格，未发请求");
		publish(modelName, rows);
		if (items.some(item => item.sandbox)) {
			try {
				const image = bundledImage();
				if (!image) throw new Error("随包 WSL 镜像缺失");
				const disk = join(root, "wsl");
				mkdirSync(disk);
				await wsl(["--import", distro, disk, image, "--version", "2"], 120_000);
				imported = true;
			} catch (error) { sandboxError = failure(error); }
		}
		for (const item of items) {
			const blocked = budget.stopped() ?? (item.sandbox ? sandboxError : undefined);
			if (blocked) { rows.push(unrun(item, blocked)); publish(modelName, rows); continue; }
			budget.begin();
			const start = performance.now();
			const rowid = core!.db.get<{ n: number }>("SELECT COALESCE(MAX(rowid),0) n FROM request_ledger")!.n;
			let id: string | undefined, detail: Goal | undefined, sentAt: number | undefined;
			let phase: (NonNullable<Evidence["restart"]> & { previousCalls: Set<string> }) | undefined;
			let reason = "", checks: Check[] = [];
			console.log(`${item.id} 正在执行，目标额度 $${budget.remaining().toFixed(6)}`);
			try {
				const fixture = join(root, item.id);
				const answers = generateFixture(item.id, fixture);
				const remote = `/workspace/t105/${item.id}`;
				const cwd = item.sandbox ? core!.paths.butterflyDir : fixture;
				const workspace = item.sandbox ? sandboxEnv(distro).local(remote) : fixture;
				if (item.sandbox) {
					await wsl(["-d", distro, "-u", "agent", "--cd", "/", "--exec", "/usr/bin/mkdir", "-p", remote]);
					for (const name of readdirSync(fixture)) {
						if (item.id === "L7" && name === "phase-two.txt") continue;
						copyFileSync(join(fixture, name), join(workspace, name));
					}
				}
				const located = (path: string) => item.sandbox ? remote + "/" + path : path;
				const instructions = [item.prompt,
					item.sandbox ? `本项所有素材和产物都在 ${remote}。工具中使用从该目录开始的绝对路径。` : "",
					item.id === "L5" ? `pwsh 的 command 必须精确使用 ${JSON.stringify(JOB_COMMAND)}，run_in_background=true，service=false。完成前不要写最终汇报。直到作业完成事件为止保持目标等待。` : "",
					item.id === "L7" ? "阶段二素材在验收后台恢复后才放入。阶段一写完检查点后保持不动，第二阶段只处理新增素材。" : "",
				].filter(Boolean).join("\n");
				detail = await core!.call("goals.create", {
					title: item.title, originText: instructions, mandateRef: "user:t105-live:" + item.id,
					scope: { cwd, partition: item.sandbox ? "butterfly" : "workbench", sandbox: item.sandbox,
						allowedPaths: [item.sandbox ? remote : cwd],
						allowedTools: [...BASIC_TOOLS, ...(item.sandbox ? ["python"] : []),
							...(["L2", "L4"].includes(item.id) ? ["render_html"] : []), ...(item.id === "L5" ? ["pwsh"] : [])],
						externalActions: item.id === "L5" ? [{ tool: "pwsh", command: JOB_COMMAND }] : [],
					},
					spec: { objective: instructions, acceptance: item.files.map(path => ({ id: path, text: "核验 " + located(path), layer: "program",
						check: { kind: "file_exists", args: { path: located(path) } } })) },
					budget: { maxCostUsd: budget.remaining(), maxParallel: 1, maxRuns: 8, maxActiveMs: 10 * 60_000 },
				}) as Goal;
				id = detail.id;
				const deadline = Date.now() + (item.id === "L5" ? 415_000 : item.id === "L7" ? 140_000 : 85_000);
				while (Date.now() < deadline) {
					detail = await current(id);
					if (item.id === "L5" && !sentAt) {
						const job = backgroundJob(core!, id);
						if (job?.status === "running" && detail.status === "waiting_dependency" && Date.now() - job.started_at >= 1500) {
							const client = core!.addClient(() => {});
							client.attached.add(job.slot_id);
							sentAt = Date.now();
							await core!.call("slot.send", { slotId: job.slot_id, record: { id: "t105-insertion", type: "prompt", message: L5_QUESTION } }, client);
						}
					}
					if (item.id === "L7" && !phase && existsSync(join(workspace, "output", "checkpoint.txt"))) {
						const checkpoint = join(workspace, "output", "checkpoint.txt");
						await core!.call("goals.control", { id, action: "pause" });
						const before = await current(id);
						const checkpointSha = sha256(checkpoint), checkpointMtime = lstatSync(checkpoint).mtimeMs;
						const previousCalls = new Set(toolFacts(sessionTrace(core!, id)).map(tool => tool.id));
						await core!.shutdown();
						core = undefined;
						await boot();
						const after = await current(id);
						phase = { before: before.status, after: after.status, resumed: false, checkpointSha, checkpointMtime, rewrites: 0, previousCalls };
						if (before.status === "paused" && after.status === "paused") {
							copyFileSync(join(fixture, "phase-two.txt"), join(workspace, "phase-two.txt"));
							await core!.call("goals.control", { id, action: "resume" });
							phase.resumed = (await current(id)).status !== "paused";
							continue;
						}
						reason = "重启后没有保持暂停";
						break;
					}
					if (DONE.has(detail.status) || budget.stopped()) break;
					await delay(300);
				}
				detail = await current(id);
				reason ||= budget.snapshot().denied ?? budget.stopped() ?? detail.reason ?? (Date.now() >= deadline ? "单项目标观察超时" : detail.status);
				if (!DONE.has(detail.status)) {
					await core!.call("goals.control", { id, action: "stop_run" });
					await core!.call("goals.control", { id, action: "pause" });
				}
				const trace = sessionTrace(core!, id), tools = toolFacts(trace);
				if (phase) phase.rewrites = tools.filter(tool => !phase!.previousCalls.has(tool.id) && tool.ok &&
					["write", "edit"].includes(tool.name) && String(tool.args.file_path ?? tool.args.path).replaceAll("\\", "/").endsWith("output/checkpoint.txt")).length;
				const evidence: Evidence = { status: detail.status, missing: detail.missing.map(check => check.id), tools,
					job: item.id === "L5" ? jobEvidence(core!, id, trace, sentAt) : undefined, restart: phase };
				checks = evaluate(item, workspace, answers, evidence);
				if (item.id !== "L6") checks.push({ id: "goal", title: "目标通过验收", passed: detail.completed, detail: `目标状态 ${detail.status}。` });
				const deniedTools = tools.filter(tool => !tool.ok && ["render_html", "python", "pwsh"].includes(tool.name));
				if (deniedTools.length) reason += "；工具未成功：" + [...new Set(deniedTools.map(tool => tool.name))].join("、");
			} catch (error) {
				reason = failure(error);
				checks = [{ id: "run", title: "运行真实目标", passed: false, detail: reason }];
			}
			if (id && core) {
				const remainingJob = backgroundJob(core, id);
				if (remainingJob?.status === "running") await core.call("jobs.stop", { id: remainingJob.id }).catch(() => {});
				const last = await current(id);
				if (!DONE.has(last.status)) {
					await core.call("goals.control", { id, action: "stop_run" }).catch(() => {});
					await core.call("goals.control", { id, action: "pause" }).catch(() => {});
				}
			}
			const account = budget.snapshot();
			const requests = core?.db.all<{ amount: number | null; currency: string | null; amount_source: string }>(
				"SELECT amount,currency,amount_source FROM request_ledger WHERE rowid>?", rowid) ?? [];
			const known = requests.length === account.requests && requests.every(request => request.currency === "USD" && request.amount !== null
				&& ["provider_actual", "plan_occupancy"].includes(request.amount_source));
			const runs = id && core ? core.db.get<{ n: number }>(
				"SELECT count(*) n FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.goal_id=?", id)?.n ?? 0 : 0;
			rows.push({ id: item.id, title: item.title, partition: item.sandbox ? "butterfly" : "workbench",
				passed: checks.length > 0 && checks.every(check => check.passed), runs,
				costUsd: known ? requests.reduce((sum, request) => sum + request.amount!, 0) : null,
				budgetUsd: account.budgetUsd, requests: account.requests, elapsedMs: Math.round(performance.now() - start),
				goalStatus: detail?.status ?? "未运行", reason: reason + (account.incomplete ? `；${account.incomplete} 次请求无最终用量，预算保留预留金额` : ""), checks });
			publish(modelName, rows);
			console.log(`${item.id} ${rows.at(-1)!.goalStatus}，${account.requests} 请求，预算计入 $${account.budgetUsd.toFixed(6)}`);
		}
	} catch (error) {
		for (const item of items.slice(rows.length)) rows.push(unrun(item, failure(error)));
		publish(modelName, rows);
	} finally {
		try { await core?.shutdown(); }
		finally {
			if (imported) await wsl(["--unregister", distro], 45_000);
			rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		}
	}
	return rows;
}
