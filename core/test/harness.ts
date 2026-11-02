import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, type FauxResponseStep } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildCore } from "../src/app.ts";
import type { Client, Core } from "../src/core.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths } from "../src/paths.ts";
import type { Transport } from "../src/gateway/gateway.ts";
import type { SandboxOptions } from "../src/sandbox/sandbox.ts";

export interface TestCore {
	core: Core;
	dir: string;
	workspace: string;
	agentDir: string;
	sessionDir: string;
	notifier: RecordingNotifier;
	faux: ReturnType<typeof createFauxCore>;
	client: Client;
	messages: Record<string, unknown>[];
	/** Records the client received for a slot. */
	records(slotId: string): Record<string, unknown>[];
	respond(...steps: FauxResponseStep[]): void;
	waitFor<T>(probe: () => T | undefined | false, timeoutMs?: number): Promise<T>;
	send(slotId: string, record: Record<string, unknown>): Promise<void>;
	reopen(): Promise<TestCore>;
	cleanup(): Promise<void>;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Fresh core on temp dirs, with a scripted faux model as the only model. */
export async function startTestCore(existingDir?: string, options: { gatewayTransport?: Transport; sandbox?: SandboxOptions } = {}): Promise<TestCore> {
	const dir = existingDir ?? mkdtempSync(join(tmpdir(), "df-core-"));
	const workspace = join(dir, "workspace");
	const agentDir = join(dir, "agent");
	const sessionDir = join(dir, "sessions");
	for (const d of [workspace, agentDir, sessionDir]) mkdirSync(d, { recursive: true });

	const faux = createFauxCore({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 8_192 }, { id: "faux-text", contextWindow: 200_000, maxTokens: 8_192 }] });
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerProvider("faux", {
		name: "Faux",
		baseUrl: "http://faux.invalid",
		apiKey: "test-key",
		api: faux.api as never,
		streamSimple: faux.streamSimple as never,
		models: [
			{ id: "faux-1", name: "Faux 1", input: ["text", "image"], cost: ZERO_COST, reasoning: false, contextWindow: 200_000, maxTokens: 8_192 },
			{ id: "faux-text", name: "Faux Text", input: ["text"], cost: ZERO_COST, reasoning: false, contextWindow: 200_000, maxTokens: 8_192 },
		],
	});

	const notifier = new RecordingNotifier();
	const core = buildCore({
		paths: corePaths(join(dir, "data")),
		agentDir,
		sessionDir,
		log: new Logger(undefined, process.env.DF_TEST_LOG === "1"),
		notifier,
		modelRuntime: () => modelRuntime,
		gatewayTransport: options.gatewayTransport,
		sandbox: options.sandbox,
	});
	core.settings.update({ defaultModel: "faux/faux-1", autoTitle: false, memoryAutoExtract: false });
	await core.start();
	const messages: Record<string, unknown>[] = [];
	const client = core.addClient((message) => messages.push(message));

	const waitFor = async <T>(probe: () => T | undefined | false, timeoutMs = 5_000): Promise<T> => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const value = probe();
			if (value !== undefined && value !== false) return value as T;
			if (Date.now() > deadline) throw new Error("waitFor timed out");
			await new Promise((r) => setTimeout(r, 10));
		}
	};

	const test: TestCore = {
		core,
		dir,
		workspace,
		agentDir,
		sessionDir,
		notifier,
		faux,
		client,
		messages,
		records: (slotId) => messages.filter((m) => m.event === "slot.record" && m.slotId === slotId).map((m) => m.record as Record<string, unknown>),
		respond: (...steps) => faux.appendResponses(steps),
		waitFor,
		send: (slotId, record) => core.call("slot.send", { slotId, record }, client) as Promise<void>,
		reopen: async () => {
			await core.shutdown();
			return startTestCore(dir, options);
		},
		cleanup: async () => {
			await core.shutdown();
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		},
	};
	return test;
}

export function settledCount(records: Record<string, unknown>[]): number {
	return records.filter((r) => r.type === "agent_settled").length;
}

export function dialogs(records: Record<string, unknown>[]): Record<string, unknown>[] {
	return records.filter((r) => r.type === "extension_ui_request" && (r.method === "select" || r.method === "confirm" || r.method === "input" || r.method === "editor"));
}
