/**
 * 0.13 real-task verification: the production Core with the user's OpenCode Go
 * channel (copied, keys still DPAPI-encrypted), a temporary WSL sandbox from the
 * bundled image, and an isolated data dir, workspace and sessions. Every model
 * request passes one budget gate (reserve at the higher of configured or peak
 * rates, stop before the reserve would pass the approved round cap).
 *
 *   node --disable-warning=ExperimentalWarning scripts/v013-live-core.ts --source <app data dir> --max-usd 0.50
 *
 * Prints one JSON line {port, token, workspace, other, sessions, root, distro, provider, model}
 * once ready; `test.shutdown` (or stdin closing) stops the Core, unregisters the
 * distro and removes the isolated folder, then writes the final receipt to stderr.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { buildCore } from "../src/app.ts";
import { Gateway, type Transport } from "../src/gateway/gateway.ts";
import { sandboxEnv } from "../src/agent/state.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths } from "../src/paths.ts";
import { storageLocations } from "../src/storage/locations.ts";
import { configurePiNetworking } from "../src/pi/http.ts";
import { bundledImage } from "../src/sandbox/image.ts";
import { runWsl } from "../src/sandbox/sandbox.ts";
import { startServer } from "../src/server.ts";
import { estimate } from "../src/ledger/rules.ts";
import { redact } from "../src/security/redaction.ts";
import { copyOpenCodeGoChannel, LIVE_MODEL } from "./longtask/channel-config.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const source = flag("--source"), maxUsd = Number(flag("--max-usd"));
if (!source || !Number.isFinite(maxUsd) || maxUsd <= 0) { console.error("需要 --source <数据目录> 和 --max-usd <批准上限>"); process.exit(2); }
const stopBeforeUsd = maxUsd - Math.min(0.05, maxUsd / 10);
const PEAK = { input: 0.30, output: 1.20, cacheRead: 0.006 };
const MAX_OUTPUT = 8192, INPUT_OVERHEAD = 16_384;

// ---- budget gate -------------------------------------------------------------
type Receipt = { at: number; provider: string; model: string; status: string; reservedUsd: number; chargedUsd?: number; usage?: unknown; error?: string };
const receipts: Receipt[] = [];
let usedUsd = 0, heldUsd = 0, fatal: string | undefined;
const rate = (model: Model<string>) => ({ input: Math.max(model.cost?.input ?? 0, PEAK.input), output: Math.max(model.cost?.output ?? 0, PEAK.output),
	cacheRead: Math.max(model.cost?.cacheRead ?? 0, PEAK.cacheRead), cacheWrite: model.cost?.cacheWrite ?? 0 });
const transport: Transport = (model, context, options) => {
	if (new URL(model.baseUrl).origin !== "https://opencode.ai") throw new Error("真实验证只允许 OpenCode Go 域名");
	if (fatal) throw new Error(fatal);
	const rates = rate(model);
	const input = Math.min(model.contextWindow || 1_000_000, Buffer.byteLength(JSON.stringify(context)) + INPUT_OVERHEAD);
	const output = Math.min(options?.maxTokens ?? MAX_OUTPUT, model.maxTokens || MAX_OUTPUT, MAX_OUTPUT);
	const reserved = (input * Math.max(rates.input, rates.cacheRead, rates.cacheWrite) + output * rates.output) / 1e6;
	const receipt: Receipt = { at: Date.now(), provider: model.provider, model: model.id, status: "pending", reservedUsd: reserved };
	receipts.push(receipt);
	if (usedUsd + heldUsd + reserved > stopBeforeUsd) {
		receipt.status = "denied";
		fatal = `下一请求的预留会让整轮超过 $${stopBeforeUsd.toFixed(2)} 提前拦截线`;
		throw new Error(fatal);
	}
	heldUsd += reserved;
	const settle = (charged: number) => { heldUsd -= reserved; usedUsd += charged; receipt.chargedUsd = charged; };
	const response = streamSimple({ ...model, cost: rates } as Model<string>, context, { ...options, maxTokens: output });
	void response.result().then(message => {
		receipt.status = message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "ok";
		if (message.errorMessage) receipt.error = redact(message.errorMessage, true).slice(0, 300);
		const usage = message.usage;
		receipt.usage = usage && { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total: usage.totalTokens };
		const has = usage && (usage.input || usage.output);
		settle(has ? estimate({ ...model, cost: rates } as Model<string>, usage) : receipt.status === "error" ? 0 : reserved);
	}, (error: unknown) => { receipt.status = "error"; receipt.error = redact(String(error), true).slice(0, 300); settle(0); });
	return response;
};

// ---- isolated environment ----------------------------------------------------
const distro = "DF-V013-" + randomUUID().replaceAll("-", "").slice(0, 16);
const root = mkdtempSync(join(resolve(tmpdir()), "df-v013-live-"));
const paths = corePaths(join(root, "data"));
const agentDir = join(root, "agent"), sessionDir = join(root, "sessions"), disk = join(root, "wsl");
const workspace = join(root, "workspace"), other = join(root, "other-project");
for (const dir of [agentDir, sessionDir, disk, workspace, other, join(workspace, "samples")]) mkdirSync(dir, { recursive: true });
// Work samples with a known answer: the window checks the report against these numbers.
writeFileSync(join(workspace, "samples", "north.csv"), "month,orders,revenue\n2026-08,120,15340.50\n2026-09,135,17210.25\n2026-10,128,16485.75\n");
writeFileSync(join(workspace, "samples", "south.csv"), "month,orders,revenue\n2026-08,98,12020.00\n2026-09,110,13990.40\n2026-10,141,18120.60\n");
writeFileSync(join(workspace, "README.md"), "# 销售样本\n\nsamples/ 下是两个区域三个月的订单与收入。\n");
writeFileSync(join(other, "README.md"), "# 另一个项目\n");

const wsl = async (flags: string[], timeoutMs: number) => {
	const result = await runWsl(flags, { timeoutMs });
	if (result.code !== 0) throw new Error("临时 WSL 操作失败：" + flags.slice(0, 2).join(" ") + "（" + (result.code ?? "超时") + "）" + result.stderr);
	return result.stdout;
};
const image = bundledImage();
if (!image) throw new Error("未找到随包 WSL 镜像，未发送请求");
let imported = false;
const notifier = new RecordingNotifier();
let core: ReturnType<typeof buildCore> | undefined;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let provider = "", model = "";

async function cleanup(code: number) {
	const result: Record<string, unknown> = { distro, root };
	try { await server?.close(); } catch (e) { result.serverClose = String(e); }
	try { await core?.shutdown(); result.coreStopped = true; } catch (e) { result.coreStopped = String(e); }
	if (imported) {
		try {
			const list = await runWsl(["--list", "--quiet"], { timeoutMs: 20_000 });
			if (list.stdout.split(/\r?\n/).some(line => line.trim() === distro)) await wsl(["--unregister", distro], 60_000);
			result.distroRemoved = true;
		} catch (e) { result.distroRemoved = String(e); }
	}
	if (result.coreStopped === true && (!imported || result.distroRemoved === true)) {
		try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); result.dataRemoved = !existsSync(root); } catch (e) { result.dataRemoved = String(e); }
	}
	console.error("V013_CLEANUP " + JSON.stringify(result));
	process.exit(code);
}

try {
	imported = true;
	await wsl(["--import", distro, disk, image, "--version", "2"], 180_000);
	await wsl(["-d", distro, "-u", "agent", "--cd", "/", "--exec", "/usr/bin/mkdir", "-p", "/workspace/inbox", "/workspace/outbox"], 30_000);
	// A sandbox input with a known answer for 蝶君's task.
	const local = sandboxEnv(distro).local.bind(sandboxEnv(distro));
	writeFileSync(local("/workspace/inbox/visits.csv"), "day,visitors\nMon,312\nTue,287\nWed,355\nThu,301\nFri,410\n");

	// The sandbox page counts a distro as ready only with its clean snapshot beside it; the
	// temporary distro has no snapshot (reset is not exercised), so leave an empty marker.
	const sandboxDir = storageLocations(paths.dataDir).sandbox;
	mkdirSync(sandboxDir, { recursive: true });
	writeFileSync(join(sandboxDir, "clean.vhdx"), "");
	provider = "df-" + copyOpenCodeGoChannel(source, paths.dataDir);
	model = provider + "/" + LIVE_MODEL;
	const log = new Logger();
	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const stream = runtime.streamSimple.bind(runtime);
	runtime.streamSimple = (requested, ...rest) => {
		if (!requested.provider.startsWith("df-")) throw new Error("真实验证只允许渠道模型");
		return stream(requested, ...rest);
	};
	await configurePiNetworking(agentDir, log);
	core = buildCore({ paths, agentDir, sessionDir, log, notifier, modelRuntime: () => runtime,
		piMigration: { automatic: false }, gatewayTransport: transport, sandbox: { distro } });
	core.sandboxProvider = () => ({ distro, ready: async () => {}, online: () => false });
	core.settings.update({ defaultModel: model, smallTaskModel: model, goalReviewModel: model, butterflyProactivity: "low",
		sandboxOnline: false, approvalMode: "off", autoTitle: false, memoryAutoExtract: false, goalProposalEnabled: false });
	await core.start();
	core.module(Gateway)!.installRuntime(runtime);
	const available = (await runtime.getAvailable()).find(item => item.provider === provider && item.id === LIVE_MODEL);
	if (!available) throw new Error("指定渠道模型不可用，未发送请求");

	const c = core;
	c.register("test.inspect", () => ({
		budget: { maxUsd, stopBeforeUsd, usedUsd, heldUsd, fatal, requests: receipts.length, receipts },
		notices: notifier.sent,
		receipts: c.db.all("SELECT category, state, object_ref FROM notification_receipts ORDER BY rowid"),
	}));
	c.register("test.read", (p) => { const path = String(p.path); return { exists: existsSync(path), content: existsSync(path) ? readFileSync(path, "utf8") : null }; });
	c.register("test.sandboxRead", (p) => { const path = local(String(p.path)); return { exists: existsSync(path), content: existsSync(path) ? readFileSync(path, "utf8") : null }; });
	c.register("test.sandboxList", async (p) => ({ out: await wsl(["-d", distro, "-u", "agent", "--cd", "/", "--exec", "/usr/bin/find", String(p.path ?? "/workspace"), "-maxdepth", "4"], 30_000) }));
	c.register("test.shutdown", () => { setTimeout(() => void cleanup(0), 50); return { ok: true }; });

	// A test skill served over a local link, imported from the 技能 page.
	const skill = "---\nname: df-v013-stamp\ndescription: 核对一道算式并盖上梦蝶核对章。用户要求“盖核对章”或使用 df-v013-stamp 时使用。\n---\n# 梦蝶核对章\n\n1. 自己验算用户给的算式，说出对或错。\n2. 回复最后单独一行写：`【梦蝶核对 V013】`\n";
	const download = createServer((_req, res) => { res.setHeader("Content-Type", "text/markdown; charset=utf-8"); res.end(skill); });
	await new Promise<void>(done => download.listen(0, "127.0.0.1", done));
	const skillUrl = `http://127.0.0.1:${(download.address() as { port: number }).port}/SKILL.md`;
	c.register("test.skillUrl", () => ({ url: skillUrl }));
	const token = "v013-" + randomUUID();
	server = await startServer(c, { port: 0, token });
	process.stdin.resume(); process.stdin.on("end", () => void cleanup(0)); process.on("SIGTERM", () => void cleanup(0));
	process.stdout.write(JSON.stringify({ port: server.port, token, workspace, other, sessions: sessionDir, root, distro, provider, model,
		sandboxHome: c.paths.butterflyDir }) + "\n");
} catch (error) {
	console.error("V013_SETUP_ERROR " + redact(error instanceof Error ? error.message : String(error), true));
	await cleanup(1);
}
