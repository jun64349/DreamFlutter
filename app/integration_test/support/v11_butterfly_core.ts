import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const packageRoot = resolve(process.argv[2]!);
const fromPackage = (name: string) => import(pathToFileURL(join(packageRoot, "core", name)).href);
const [{ buildCore }, { corePaths }, { startServer }, { Logger }, { RecordingNotifier }, piAi, { ModelRuntime }] = await Promise.all([
	fromPackage("src/app.ts"), fromPackage("src/paths.ts"), fromPackage("src/server.ts"), fromPackage("src/log.ts"), fromPackage("src/notify.ts"),
	fromPackage("node_modules/@earendil-works/pi-ai/dist/index.js"), fromPackage("node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
]);

const root = await mkdtemp(join(tmpdir(), "df-v11-window-butterfly-"));
const workspace = join(root, "workbench");
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
for (const dir of [workspace, agentDir, sessionDir]) await mkdir(dir);
const faux = piAi.createFauxCore({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 8192 }] });
const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
runtime.registerProvider("faux", {
	name: "Local fixture", baseUrl: "http://faux.invalid", apiKey: "synthetic", api: faux.api, streamSimple: faux.streamSimple,
	models: [{ id: "faux-1", name: "Local fixture", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false, contextWindow: 200_000, maxTokens: 8192 }],
});
const core = buildCore({ paths: corePaths(join(root, "data")), agentDir, sessionDir, dshWorkbench: true, log: new Logger(),
	notifier: new RecordingNotifier(), piMigration: { automatic: false }, modelRuntime: () => runtime,
	gatewayTransport: () => { throw new Error("Windows window fixture prohibits remote model requests"); },
});
core.settings.update({ defaultModel: "faux/faux-1", autoTitle: false, memoryAutoExtract: false, autoCheckUpdates: false });
let server: { port: number; close(): Promise<void> } | undefined;
let closing: Promise<void> | undefined;
function close(): Promise<void> {
	return closing ??= (async () => {
		try {
			await server?.close();
			if (core.sandboxProvider?.()) await core.call("sandbox.remove", {});
		} finally {
			await core.shutdown();
			const actual = await realpath(root);
			assert.equal(actual.toLowerCase(), root.toLowerCase());
			assert.equal(dirname(actual).toLowerCase(), resolve(tmpdir()).toLowerCase());
			assert(basename(actual).startsWith("df-v11-window-butterfly-"));
			await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	})();
}

try {
	await core.start();
	await core.call("sandbox.provision", {});
	const deadline = Date.now() + 90_000;
	let status;
	do {
		status = await core.call("sandbox.status", {});
		if (status.state === "ready") break;
		if (status.state === "error") throw new Error(status.error);
		await wait(100);
	} while (Date.now() < deadline);
	assert.equal(status.state, "ready");
	assert.equal(status.kind, "appcontainer");
	const token = randomBytes(32).toString("hex");
	server = await startServer(core, { port: 0, token });
	let kind = "idle";
	let target = "";
	const artifactRequests: unknown[] = [];
	const call = core.call.bind(core);
	core.call = (method: string, params: Record<string, unknown>, client: unknown) => {
		if (method === "butterfly.chat.artifact") artifactRequests.push(params.name);
		return call(method, params, client);
	};
	core.register("test.inspect", () => ({ kind, target, artifactRequests, goals: core.db.all("SELECT id,status FROM goals"),
		receipts: core.db.all("SELECT status,substr(error,1,300) AS error FROM runs") }));
	core.register("test.job", (params: { kind: string }) => {
		kind = params.kind;
		assert(kind === "research" || kind === "compatibility");
		const filename = kind === "research" ? "window-queue.md" : "window-compat.md";
		faux.setResponses([(context: { messages: unknown[] }) => {
			const logical = JSON.stringify(context.messages).match(new RegExp(`/workspace/outbox/g_[a-f0-9]{16}/${filename}`))?.[0];
			assert(logical, "DSH target is missing the promised deliverable path");
			target = join(status.workspaceDir, logical.slice("/workspace/".length));
			if (kind === "research") {
				const code = ["from pathlib import Path", `output = Path(${JSON.stringify(target)})`,
					"output.parent.mkdir(parents=True, exist_ok=True)", "values = [17, 25]", "mean = sum(values) / len(values)",
					String.raw`output.write_text(f'# 队列样本\n\n两份合成样本的均值为 {mean:.1f}。\n', encoding='utf-8')`, "print(f'sample mean = {mean:.1f}')"].join("\n");
				return piAi.fauxAssistantMessage([piAi.fauxToolCall("python", { code, timeout: 30 })], { stopReason: "toolUse" });
			}
			const code = "const fs=require('node:fs'),p=require('node:path');const out=process.argv[1];fs.mkdirSync(p.dirname(out),{recursive:true});" +
				"fs.writeFileSync(out,'# 兼容检查\\n\\n实际随包 Node ' + process.version + '\\n');console.log('native node ' + process.version);";
			const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
			return piAi.fauxAssistantMessage([piAi.fauxToolCall("pwsh", { description: "执行随包 Node 版本检查",
				command: `node -e ${quote(code)} ${quote(target)}`, timeoutMs: 15_000 })], { stopReason: "toolUse" });
		}, (context: { messages: unknown[] }) => {
			assert.match(JSON.stringify(context.messages.at(-1)), kind === "research" ? /sample mean = 21\.0/ : /native node v24/);
			return piAi.fauxAssistantMessage([piAi.fauxToolCall("goal_report", { status: "done", note: "已核对本机工具输出与交付文件。" })], { stopReason: "toolUse" });
		}, piAi.fauxAssistantMessage("结果已生成。")]);
		return {};
	});
	core.register("test.shutdown", () => { setTimeout(() => void close().then(() => process.exit(0)), 50); return {}; });
	process.stdin.resume();
	process.stdin.on("end", () => void close().then(() => process.exit(0)));
	process.stdout.write(JSON.stringify({ port: server.port, token, workspace, other: workspace, home: core.paths.butterflyDir,
		sessions: sessionDir, root, workspaceDir: status.workspaceDir }) + "\n");
} catch (error) {
	await close();
	throw error;
}
