import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { screenAssignments } from "./screen.ts";
import type { Profile, TrialCase } from "./exercise.ts";
import type { Transport } from "../../src/gateway/gateway.ts";
import { redact } from "../../src/security/redaction.ts";
import { cleanupStep, writeReport } from "./report.ts";

const allCases: readonly TrialCase[] = ["B2", "B3", "B4", "B5", "B6"];
const trialIdleWaitMs = 1_000;
const simulatedIdleMs = 15 * 60_000;

function trialClock() {
	let at = Date.now();
	return {
		now: () => at,
		async idle() {
			await delay(trialIdleWaitMs);
			at += simulatedIdleMs;
		},
	};
}

function publish(report: unknown, out?: number): void {
	if (out === undefined) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
	else writeReport(out, report);
}

function args(argv: string[]) {
	const mode = argv.shift() ?? "--dry";
	if (!["--screen", "--dry", "--live"].includes(mode)) {
		throw new Error("用法：--screen | --dry [--cases B4,B5] | --live --source <数据目录> --max-usd <批准额度> [--cases B4,B5] [--out <报告.json>]\nB4 单项复跑建议上限 0.15 美元。");
	}
	const flags = new Map<string, string>();
	while (argv.length) {
		const key = argv.shift()!, value = argv.shift();
		if (!["--source", "--max-usd", "--out", "--cases"].includes(key) || !value || value.startsWith("--") || flags.has(key))
			throw new Error("试跑参数无效：" + key);
		flags.set(key, value);
	}
	if (mode !== "--live" && (flags.has("--source") || flags.has("--max-usd"))) throw new Error("仅真实模式接受渠道和额度参数");
	const source = flags.get("--source"), totalUsd = Number(flags.get("--max-usd"));
	if (mode === "--live" && (!source || !Number.isFinite(totalUsd) || totalUsd <= 0))
		throw new Error("真实模式需要明确指定数据目录和已批准的整轮 USD 上限");
	const cases = flags.get("--cases")?.split(",") as TrialCase[] | undefined;
	if (cases && (mode === "--screen" || new Set(cases).size !== cases.length || cases.some(id => !allCases.includes(id))))
		throw new Error("场景编号必须从 B2–B6 选择且不得重复，仅试跑模式可用");
	if (cases?.includes("B6") && !cases.includes("B2")) throw new Error("B6 需要同轮 B2 的交付回执");
	return { mode, source, totalUsd, out: flags.get("--out"), cases: cases ?? allCases };
}

async function dry(selected: readonly TrialCase[]) {
	const { startTestCore } = await import("../../test/harness.ts");
	const { configureProfile, exercise } = await import("./exercise.ts");
	const clock = trialClock();
	let t = await startTestCore(undefined, { selfwork: { clock: clock.now }, personaClock: clock.now,
		gatewayTransport: () => { throw new Error("空跑禁止真实渠道请求"); } });
	let calls = 0, before = 0;
	const profile: Profile = {
		get core() { return t.core; }, get faux() { return t; }, get notices() { return t.notifier.sent; },
		local: path => join(t.dir, "sandbox", path.slice("/workspace".length)),
		idle: clock.idle,
		async restart() { calls += t.faux.state.callCount; t = await t.reopen(); configureProfile(profile); },
		startMeter: () => { before = calls + t.faux.state.callCount; },
		meter: () => ({ transportRequests: 0, fakeModelRequests: calls + t.faux.state.callCount - before, reservedOrEstimatedUsd: 0 }),
	};
	try {
		configureProfile(profile);
		const cases = await exercise(profile, selected);
		return { mode: "dry", physicalRequests: 0, realCostUsd: 0, sandbox: "模拟 WSL 路径与合成文件",
			trialIdleWaitMs, simulatedIdleMs, fixturePrices: t.core.resolveModel(t.faux.models[0]).cost, cases };
	} finally { await t.cleanup(); }
}

async function live(source: string, totalUsd: number, selected: readonly TrialCase[], checkpoint?: (report: object) => void) {
	const [
		{ ModelRuntime }, { buildCore }, { Gateway }, { sandboxEnv }, { Logger }, { RecordingNotifier }, { corePaths },
		{ configurePiNetworking }, { bundledImage }, { runWsl }, { copyOpenCodeGoChannel, LIVE_MODEL }, { LiveBudget, priced },
		{ configureProfile, exercise },
	] = await Promise.all([
		import("@earendil-works/pi-coding-agent"), import("../../src/app.ts"), import("../../src/gateway/gateway.ts"),
		import("../../src/agent/state.ts"), import("../../src/log.ts"), import("../../src/notify.ts"), import("../../src/paths.ts"),
		import("../../src/pi/http.ts"), import("../../src/sandbox/image.ts"), import("../../src/sandbox/sandbox.ts"),
		import("../longtask/channel-config.ts"), import("../longtask/live-budget.ts"), import("./exercise.ts"),
	]);
	const distro = "DF-T118-" + randomUUID().replaceAll("-", "");
	const root = mkdtempSync(join(resolve(tmpdir()), "df-t118-live-"));
	const paths = corePaths(join(root, "data"));
	const agentDir = join(root, "agent"), sessionDir = join(root, "sessions"), disk = join(root, "wsl");
	const stopBeforeUsd = totalUsd - Math.min(0.05, totalUsd / 10);
	const budget = new LiveBudget(stopBeforeUsd);
	const clock = trialClock();
	let core: ReturnType<typeof buildCore> | undefined, importAttempted = false;
	const notifier = new RecordingNotifier();
	const cleanup = { distro, root, pending: true, coreStopped: false, distroRemoved: false, dataRemoved: false, errors: {} as Record<string, string> };
	const base = { mode: "live", model: LIVE_MODEL, maxUsd: totalUsd, stopBeforeUsd, trialIdleWaitMs, simulatedIdleMs, cleanup };
	let report: typeof base & { cases: Awaited<ReturnType<typeof exercise>>; channel?: string; prices?: unknown; setupError?: string } =
		{ ...base, cases: [] };
	const wsl = async (flags: string[], timeoutMs: number) => {
		const result = await runWsl(flags, { timeoutMs });
		if (result.code !== 0) throw new Error("临时 WSL 操作失败：" + flags[0] + "（" + (result.code ?? "超时") + "）");
	};
	try {
		const image = bundledImage();
		if (!image) throw new Error("未找到随包 WSL 镜像，未发送请求");
		for (const folder of [agentDir, sessionDir, disk]) mkdirSync(folder);
		importAttempted = true;
		await wsl(["--import", distro, disk, image, "--version", "2"], 120_000);
		await wsl(["-d", distro, "-u", "agent", "--cd", "/", "--exec", "/usr/bin/mkdir", "-p", "/workspace/inbox", "/workspace/outbox"], 25_000);
		const provider = "df-" + copyOpenCodeGoChannel(source, paths.dataDir);
		const model = provider + "/" + LIVE_MODEL;
		budget.configure(provider, LIVE_MODEL);
		const transport: Transport = (candidate, context, options) => {
			if (candidate.provider !== provider || candidate.id !== LIVE_MODEL || new URL(candidate.baseUrl).origin !== "https://opencode.ai")
				throw new Error("真实试跑只允许指定的 OpenCode Go 模型和域名");
			const { cost } = candidate;
			// Reserve and settle conservatively at the higher of model-group or published peak rates.
			return budget.transport({ ...candidate, cost: { ...cost, input: Math.max(cost.input, 0.30),
				output: Math.max(cost.output, 1.20), cacheRead: Math.max(cost.cacheRead, 0.006) } }, context, options);
		};
		const boot = async () => {
			const log = new Logger();
			const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
			const stream = runtime.streamSimple.bind(runtime);
			runtime.streamSimple = (requested, ...rest) => {
				if (requested.provider !== provider || requested.id !== LIVE_MODEL) throw new Error("真实试跑禁止切换到其他模型");
				return stream(requested, ...rest);
			};
			budget.observeGateway(runtime);
			await configurePiNetworking(agentDir, log);
			core = buildCore({ paths, agentDir, sessionDir, log, notifier, modelRuntime: () => runtime,
				piMigration: { automatic: false }, gatewayTransport: transport, sandbox: { distro },
				selfwork: { clock: clock.now }, personaClock: clock.now });
			core.sandboxProvider = () => ({ distro, ready: async () => {}, online: () => false });
			core.settings.update({ defaultModel: model, goalReviewModel: model, butterflyProactivity: "low",
				sandboxOnline: false, approvalMode: "off", autoTitle: false, memoryAutoExtract: false, goalProposalEnabled: false });
			await core.start();
			core.module(Gateway)!.installRuntime(runtime);
			const available = (await runtime.getAvailable()).find(item => item.provider === provider && item.id === LIVE_MODEL);
			if (!available || !priced(core.resolveModel(available))) throw new Error("指定渠道模型不可用或没有可核对报价，未发送请求");
			return core.resolveModel(available).cost;
		};
		const prices = await boot();
		console.error("临时 WSL 和隔离后台已就绪：" + distro);
		const profile: Profile = {
			get core() { return core!; }, notices: notifier.sent,
			live: true,
			local: path => sandboxEnv(distro).local(path),
			idle: clock.idle,
			async restart() { await core!.shutdown(); await boot(); configureProfile(profile); },
			startMeter: () => budget.begin(),
			stopReason: () => budget.stopped(),
			progress: text => console.error(text),
			meter: () => {
				const snapshot = budget.snapshot();
				return { transportRequests: snapshot.requests, reservedOrEstimatedUsd: snapshot.budgetUsd,
					pending: snapshot.pending, missingFinalUsage: snapshot.incomplete,
					transportReceipts: snapshot.receipts };
			},
		};
		configureProfile(profile);
		const cases = await exercise(profile, selected);
		report = { ...base, channel: provider, prices, cases };
	} catch (error) {
		const message = redact(error instanceof Error ? error.message : String(error), true);
		report.setupError = message;
	} finally {
		try { checkpoint?.(report); }
		finally {
			cleanup.coreStopped = await cleanupStep(cleanup.errors, "coreShutdown", async () => { await core?.shutdown(); });
			// An interrupted import can register its name before reporting failure.
			cleanup.distroRemoved = await cleanupStep(cleanup.errors, "wslUnregister", async () => {
				if (!importAttempted) return;
				const listing = await runWsl(["--list", "--quiet"], { timeoutMs: 20_000 });
				if (listing.code !== 0) throw new Error("无法核对临时 WSL 的登记");
				if (listing.stdout.split(/\r?\n/).some(line => line.trim() === distro)) await wsl(["--unregister", distro], 45_000);
			});
			if (cleanup.distroRemoved && cleanup.coreStopped) {
				cleanup.dataRemoved = await cleanupStep(cleanup.errors, "dataRemoval", () => {
					rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
					if (existsSync(root)) throw new Error("隔离目录仍存在");
				});
			} else {
				cleanup.errors.dataRemoval = "后台关闭或临时 WSL 注销未确认，已保留隔离目录";
			}
			cleanup.pending = false;
		}
	}
	return report;
}

const options = args(process.argv.slice(2));
let out: number | undefined;
try {
	if (options.out) {
		mkdirSync(dirname(resolve(options.out)), { recursive: true });
		out = openSync(options.out, "wx");
	}
	const screen = screenAssignments();
	if (options.mode === "--screen") {
		publish({ mode: "screen", screen }, out);
	} else {
		const screening = { total: screen.total, correct: screen.correct, falseAccept: screen.falseAccept, missed: screen.missed, wrongRoute: screen.wrongRoute };
		const report = options.mode === "--live" ? await live(options.source!, options.totalUsd, options.cases,
			out === undefined ? undefined : checkpoint => publish({ screen: screening, ...checkpoint }, out)) : await dry(options.cases);
		publish({ screen: screening, ...report }, out);
		if (report.cases.some(item => !item.passed) || report.cases.length !== options.cases.length ||
			("cleanup" in report && report.cleanup && (!report.cleanup.distroRemoved || !report.cleanup.dataRemoved))) process.exitCode = 1;
	}
} finally {
	if (out !== undefined) closeSync(out);
}
