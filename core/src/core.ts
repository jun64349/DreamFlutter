import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionEvent, ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ConfirmationStore } from "./confirmations.ts";
import { Db, now } from "./db.ts";
import { AGENT_MODES, type AgentMode } from "./agent/harness.ts";
import { approvalExtension } from "./ext/approval.ts";
import type { Logger } from "./log.ts";
import type { Notifier } from "./notify.ts";
import type { CorePaths } from "./paths.ts";
import { dialogKind } from "./pi/dialogs.ts";
import { isProjectTrusted, type PiHostConfig } from "./pi/host.ts";
import { RunStore, type Run } from "./runs.ts";
import { SettingsStore } from "./settings.ts";
import { Slot, type SlotHooks, type SlotInfo } from "./slots/slot.ts";

export const CORE_VERSION = "0.1.1";

export interface CoreOptions {
	paths: CorePaths;
	agentDir: string;
	sessionDir?: string;
	log: Logger;
	notifier: Notifier;
	/** Test hook, see PiHostConfig.modelRuntime. */
	modelRuntime?: () => ModelRuntime;
	/** Test hook: the stream gateway channels call instead of the real API. */
	gatewayTransport?: import("./gateway/gateway.ts").Transport;
}

/** A connected window (or other client). */
export interface Client {
	readonly id: string;
	send(message: Record<string, unknown>): void;
	/** Slots whose record stream this client receives. */
	readonly attached: Set<string>;
}

export class RpcError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export type Params = Record<string, unknown>;
export type Handler = (params: Params, client: Client | undefined) => unknown | Promise<unknown>;
/** Plain HTTP route (cards, renderer assets); [path] is the decoded pathname. */
export type HttpHandler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, path: string) => void | Promise<void>;

export interface OpenSlotOptions {
	slotId?: string;
	cwd: string;
	sessionFile?: string;
	taskId?: string | null;
	unattended?: boolean;
	/** Temporary chat, kept only in memory. */
	incognito?: boolean;
	/** Client to attach before the runtime starts, so it sees the trust prompt. */
	client?: Client;
	/** Agent mode for a new session; default: the settings' agentMode. */
	agentMode?: AgentMode;
}

/** Feature modules plug in through these. */
export interface CoreModule {
	extensions?(slot: { slotId: string }): ExtensionFactory[];
	/** Its extensions change what the model sees (tools, context): left out of minimal-mode sessions. */
	readonly modelFacing?: boolean;
	onSlotEvent?(slot: Slot, event: AgentSessionEvent): void;
	onRunStarted?(slot: Slot, run: Run): void;
	onRunFinished?(slot: Slot, run: Run): void;
	/** Running state, dialogs, session file or name changed. */
	onSlotChanged?(slot: Slot): void;
	/** Task id for a run in a slot without one; the first module returning a value wins. */
	resolveTaskId?(slot: Slot): string | null | undefined;
	/** Decides a tool call in [slot] without asking; the first module returning a value wins. */
	toolPolicy?(slot: Slot, tool: string, input: Record<string, unknown>): "allow" | "deny" | undefined;
	onSlotClosed?(slot: Slot): void;
	start?(): void | Promise<void>;
	stop?(): void | Promise<void>;
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

/**
 * Composition root of the background service: session slots, connected
 * clients, persisted dialogs, run history and the method table the WebSocket
 * server dispatches into.
 */
export class Core {
	readonly db: Db;
	readonly log: Logger;
	readonly notifier: Notifier;
	readonly settings: SettingsStore;
	readonly confirmations: ConfirmationStore;
	readonly runs: RunStore;
	readonly paths: CorePaths;
	readonly agentDir: string;
	readonly sessionDir: string | undefined;
	readonly slots = new Map<string, Slot>();
	readonly clients = new Set<Client>();
	/** Runs a previous core process left unfinished. */
	readonly interruptedAtStartup: Run[];
	private readonly methods = new Map<string, Handler>();
	private readonly httpRoutes: { prefix: string; handler: HttpHandler }[] = [];
	/** Port of the local HTTP/WebSocket server (0 until it listens). */
	httpPort = 0;
	private readonly modules: CoreModule[] = [];
	/** Core-owned tools that never need approval (memory, desk bookkeeping...). */
	private readonly exemptTools = new Set<string>();
	private readonly hostConfig: PiHostConfig;
	/** Slots whose runtime is still starting (possibly waiting on the trust prompt). */
	private readonly opening = new Map<string, Slot>();
	/** Session files being opened (normalized path → the open in progress). */
	private readonly openingFiles = new Map<string, Promise<Slot>>();
	/** Slots closed while still starting. */
	private readonly cancelledOpens = new Set<string>();
	private reaper: NodeJS.Timeout | undefined;
	private stopped = false;
	private readonly shutdownListeners: (() => void)[] = [];

	constructor(options: CoreOptions) {
		this.paths = options.paths;
		this.log = options.log;
		this.notifier = options.notifier;
		this.agentDir = options.agentDir;
		this.sessionDir = options.sessionDir;
		mkdirSync(options.paths.dataDir, { recursive: true });
		this.db = new Db(options.paths.dbFile);
		this.settings = new SettingsStore(this.db);
		this.confirmations = new ConfirmationStore(this.db);
		this.runs = new RunStore(this.db);
		this.interruptedAtStartup = this.runs.interruptOrphans();
		const expired = this.confirmations.expireOrphans();
		if (this.interruptedAtStartup.length || expired) {
			this.log.info(`recovered: ${this.interruptedAtStartup.length} interrupted run(s), ${expired} expired dialog(s)`);
		}
		this.hostConfig = {
			agentDir: options.agentDir,
			sessionDir: options.sessionDir,
			modelRuntime: options.modelRuntime,
			trustDecisions: new Map(),
			extensions: (slot, mode) => [
				this.approval(slot.slotId),
				...this.modules.filter((m) => !(mode === "minimal" && m.modelFacing)).flatMap((m) => m.extensions?.(slot) ?? []),
			],
			newSessionMode: (slot) => this.slotOrOpening(slot.slotId)?.newSessionMode ?? this.settings.get().agentMode,
			autoCompaction: () => this.settings.get().autoCompaction,
			agentStateChanged: (slot, state) => this.slotOrOpening(slot.slotId)?.setAgentState(state),
			harnessControls: new Map(),
			manualCompactions: new Set(),
		};
		this.settings.onChange((settings, changed) => this.broadcast({ event: "settings.changed", settings, changed }));
		this.registerBaseMethods();
	}

	/** Whether [cwd]'s project resources (.pi/ skills, packages…) may be loaded. */
	isProjectTrusted(cwd: string): boolean {
		return isProjectTrusted(cwd, this.agentDir, this.hostConfig.trustDecisions);
	}

	exemptFromApproval(...tools: string[]): void {
		for (const tool of tools) this.exemptTools.add(tool);
	}

	use(module: CoreModule): void {
		this.modules.push(module);
	}

	/** The module of type [type], if one is in use. */
	module<T extends CoreModule>(type: abstract new (...args: never[]) => T): T | undefined {
		return this.modules.find((m): m is T => m instanceof type);
	}

	async start(): Promise<void> {
		for (const module of this.modules) await module.start?.();
		this.reaper = setInterval(() => void this.reapIdle(), 60_000);
		this.reaper.unref();
	}

	register(method: string, handler: Handler): void {
		if (this.methods.has(method)) throw new Error(`duplicate method ${method}`);
		this.methods.set(method, handler);
	}

	registerHttp(prefix: string, handler: HttpHandler): void {
		this.httpRoutes.push({ prefix, handler });
	}

	/** Routes a plain HTTP request; false when no module serves [path]. */
	async handleHttp(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, path: string): Promise<boolean> {
		const route = this.httpRoutes.find((r) => path.startsWith(r.prefix));
		if (!route) return false;
		await route.handler(req, res, path);
		return true;
	}

	async call(method: string, params: Params, client?: Client): Promise<unknown> {
		const handler = this.methods.get(method);
		if (!handler) throw new RpcError("unknown_method", `Unknown method: ${method}`);
		return handler(params ?? {}, client);
	}

	// ---- clients ---------------------------------------------------------------------

	addClient(send: (message: Record<string, unknown>) => void): Client {
		const client: Client = { id: randomUUID(), send, attached: new Set() };
		this.clients.add(client);
		return client;
	}

	removeClient(client: Client): void {
		this.clients.delete(client);
	}

	broadcast(message: Record<string, unknown>): void {
		for (const client of this.clients) client.send(message);
	}

	private watched(slotId: string): boolean {
		for (const client of this.clients) if (client.attached.has(slotId)) return true;
		return false;
	}

	onShutdown(listener: () => void): void {
		this.shutdownListeners.push(listener);
	}

	// ---- slots -----------------------------------------------------------------------

	findSlotByFile(sessionFile: string): Slot | undefined {
		for (const slot of this.slots.values()) if (samePath(slot.info().sessionFile, sessionFile)) return slot;
		return undefined;
	}

	/**
	 * Opens a session in a new slot, or returns the slot that already has
	 * [sessionFile] open (two runtimes on one file would corrupt it).
	 */
	async openSlot(options: OpenSlotOptions): Promise<Slot> {
		if (!options.sessionFile) return this.openNewSlot(options);
		const existing = this.findSlotByFile(options.sessionFile);
		if (existing) {
			options.client?.attached.add(existing.slotId);
			return existing;
		}
		// Another open of this file is under way: share it rather than start a second runtime.
		const key = normalizeCwd(options.sessionFile);
		const pending = this.openingFiles.get(key);
		if (pending) {
			const slot = await pending;
			options.client?.attached.add(slot.slotId);
			return slot;
		}
		if (!existsSync(options.sessionFile)) throw new RpcError("not_found", `会话文件不存在：${options.sessionFile}`);
		const opening = this.openNewSlot(options);
		this.openingFiles.set(key, opening);
		try {
			return await opening;
		} finally {
			this.openingFiles.delete(key);
		}
	}

	private async openNewSlot(options: OpenSlotOptions): Promise<Slot> {
		const slotId = options.slotId ?? randomUUID();
		if (this.slots.has(slotId) || this.opening.has(slotId)) throw new RpcError("conflict", `Slot ${slotId} already exists`);
		options.client?.attached.add(slotId);
		const target = { cwd: options.cwd, sessionFile: options.incognito ? undefined : options.sessionFile, inMemory: options.incognito === true, unattended: options.unattended === true };
		const slot = Slot.prepare(
			this.db,
			{ slotId, target, taskId: options.taskId, unattended: options.unattended, agentMode: options.agentMode ?? this.settings.get().agentMode },
			this.slotHooks(),
		);
		this.opening.set(slotId, slot);
		try {
			await slot.start(this.hostConfig, target);
			if (this.cancelledOpens.has(slotId)) {
				// Closed while it was starting (e.g. during the trust prompt): never publish it.
				await slot.dispose();
				throw new RpcError("cancelled", "会话在打开过程中被关闭了");
			}
			this.slots.set(slotId, slot);
			if (!options.sessionFile) await this.applyDefaultModel(slot);
			this.broadcast({ event: "slot.changed", info: slot.info() });
			return slot;
		} catch (error) {
			options.client?.attached.delete(slotId);
			throw error;
		} finally {
			this.opening.delete(slotId);
			if (!this.slots.has(slotId)) this.hostConfig.harnessControls?.delete(slotId);
			this.cancelledOpens.delete(slotId);
		}
	}

	/** New sessions start on the user's default model and thinking level. */
	async applyDefaultModel(slot: Slot): Promise<void> {
		const { defaultModel, defaultThinking } = this.settings.get();
		const session = slot.session;
		if (defaultModel) {
			const slash = defaultModel.indexOf("/");
			const model = session.modelRuntime
				.getAvailableSnapshot()
				.find((m) => m.provider === defaultModel.slice(0, slash) && m.id === defaultModel.slice(slash + 1));
			if (model) await session.setModel(model);
			else this.log.warn(`default model ${defaultModel} is not available`);
		}
		if (defaultThinking && session.getAvailableThinkingLevels().includes(defaultThinking as never)) {
			session.setThinkingLevel(defaultThinking as never);
		}
	}

	private slotOrOpening(slotId: string): Slot | undefined {
		return this.slots.get(slotId) ?? this.opening.get(slotId);
	}

	slot(slotId: unknown, options: { includeOpening?: boolean } = {}): Slot {
		const id = typeof slotId === "string" ? slotId : "";
		const slot = this.slots.get(id) ?? (options.includeOpening ? this.opening.get(id) : undefined);
		if (!slot) throw new RpcError("not_found", `No such session slot: ${String(slotId)}`);
		return slot;
	}

	private allSlots(): Slot[] {
		return [...this.slots.values(), ...this.opening.values()];
	}

	async closeSlot(slotId: string): Promise<void> {
		const starting = this.opening.get(slotId);
		if (starting && !this.slots.has(slotId)) {
			this.cancelledOpens.add(slotId);
			starting.ui.cancelAll();
			for (const client of this.clients) client.attached.delete(slotId);
			return;
		}
		const slot = this.slots.get(slotId);
		if (!slot) return;
		this.slots.delete(slotId);
		for (const client of this.clients) client.attached.delete(slotId);
		await slot.dispose();
		this.hostConfig.harnessControls?.delete(slotId);
		for (const module of this.modules) module.onSlotClosed?.(slot);
		this.broadcast({ event: "slot.closed", slotId });
	}

	/** Disposes idle slots nobody is watching. */
	async reapIdle(at = now()): Promise<void> {
		const limit = this.settings.get().idleSessionMinutes * 60_000;
		for (const slot of [...this.slots.values()]) {
			if (slot.running || slot.ui.pendingCount > 0 || this.watched(slot.slotId)) continue;
			if (at - slot.lastActivity < limit) continue;
			this.log.info(`reaping idle slot ${slot.slotId}`);
			await this.closeSlot(slot.slotId);
		}
	}

	private slotHooks(): SlotHooks {
		return {
			record: (slotId, record) => {
				const message = { event: "slot.record", slotId, record };
				for (const client of this.clients) if (client.attached.has(slotId)) client.send(message);
			},
			changed: (slot) => {
				if (this.slots.has(slot.slotId)) this.broadcast({ event: "slot.changed", info: slot.info() });
				for (const module of this.modules) module.onSlotChanged?.(slot);
			},
			dialogOpened: (slot, request) => {
				this.confirmations.opened({ slotId: slot.slotId, sessionFile: slot.info().sessionFile ?? undefined, cwd: slot.cwd }, request);
				this.broadcast({ event: "confirm.changed", confirmation: this.confirmations.get(request.id) });
				if (!this.watched(slot.slotId) && this.settings.get().notifications) {
					const kind = dialogKind(request.title);
					const title = kind === "approval" ? "Agent 需要你批准一个操作" : kind === "trust" ? "需要确认是否信任工作区" : "Agent 需要你补充信息";
					this.notifier.notify(title, slot.info().sessionName ?? slot.cwd);
				}
			},
			dialogClosed: (_slot, id, outcome, response) => {
				this.confirmations.closed(id, outcome, response);
				this.broadcast({ event: "confirm.changed", confirmation: this.confirmations.get(id) });
			},
			event: (slot, event) => {
				for (const module of this.modules) module.onSlotEvent?.(slot, event);
			},
			sessionCreated: (slot) => this.applyDefaultModel(slot),
			resolveTaskId: (slot) => {
				for (const module of this.modules) {
					const id = module.resolveTaskId?.(slot);
					if (id !== undefined) return id;
				}
				return null;
			},
			runStarted: (slot, run) => {
				for (const module of this.modules) module.onRunStarted?.(slot, run);
			},
			runFinished: (slot, run) => {
				this.broadcast({ event: "run.finished", run });
				for (const module of this.modules) module.onRunFinished?.(slot, run);
				if (!this.watched(slot.slotId) && this.settings.get().notifications && run.status !== "aborted") {
					const name = slot.info().sessionName ?? run.prompt ?? "任务";
					this.notifier.notify(run.status === "failed" ? "任务失败" : "任务已完成", `${name}${run.error ? `：${run.error}` : ""}`);
				}
			},
		};
	}

	// ---- approval policy -------------------------------------------------------------

	private approval(slotId: string): ExtensionFactory {
		return approvalExtension({
			// Modules decide first (a scheduled run restricts even core-exempt tools).
			override: (tool, input) => {
				const slot = this.slots.get(slotId) ?? this.opening.get(slotId);
				if (!slot) return undefined;
				for (const module of this.modules) {
					const decision = module.toolPolicy?.(slot, tool, input);
					if (decision) return decision;
				}
				return undefined;
			},
			mode: () => this.settings.get().approvalMode,
			exempt: (tool) => this.exemptTools.has(tool),
			workspaceAllowed: (cwd) => new Set(this.db.all<{ tool: string }>("SELECT tool FROM workspace_tool_rules WHERE cwd = ?", normalizeCwd(cwd)).map((r) => r.tool)),
			allowInWorkspace: (cwd, tool) => {
				this.db.run("INSERT OR IGNORE INTO workspace_tool_rules(cwd, tool, created_at) VALUES(?, ?, ?)", normalizeCwd(cwd), tool, now());
			},
		});
	}

	// ---- methods ---------------------------------------------------------------------

	private registerBaseMethods(): void {
		this.register("core.hello", () => ({
			version: CORE_VERSION,
			piVersion: piVersion(),
			pid: process.pid,
			port: this.httpPort,
			dataDir: this.paths.dataDir,
			agentDir: this.agentDir,
			slots: [...this.slots.values()].map((s) => s.info()),
			settings: this.settings.get(),
			interruptedRuns: this.runs.unacknowledgedInterrupted(),
			pendingConfirmations: this.confirmations.list({ status: "pending" }),
		}));
		this.register("core.shutdown", () => {
			setTimeout(() => void this.shutdown(), 50);
			return { ok: true };
		});

		this.register("core.notify", (params) => {
			this.notifier.notify(requireStr(params.title, "title"), str(params.body) ?? "");
			return { ok: true };
		});

		this.register("settings.get", () => this.settings.get());
		this.register("settings.update", (params) => this.settings.update(params));

		this.register("slot.open", async (params, client) => {
			const slot = await this.openSlot({
				slotId: str(params.slotId),
				cwd: requireStr(params.cwd, "cwd"),
				sessionFile: str(params.sessionFile),
				incognito: params.incognito === true,
				agentMode: AGENT_MODES.includes(params.agentMode as AgentMode) ? (params.agentMode as AgentMode) : undefined,
				client,
			});
			return slot.info();
		});
		this.register("slot.list", () => [...this.slots.values()].map((s) => s.info()));
		this.register("slot.attach", (params, client) => {
			const slot = this.slot(params.slotId);
			client?.attached.add(slot.slotId);
			return { info: slot.info(), replay: slot.ui.replay(), live: slot.liveSnapshot() };
		});
		this.register("slot.detach", (params, client) => {
			if (typeof params.slotId === "string") client?.attached.delete(params.slotId);
			return { ok: true };
		});
		this.register("slot.send", (params) => {
			const slot = this.slot(params.slotId, { includeOpening: true });
			const record = params.record as { type?: unknown } | undefined;
			if (!record || typeof record.type !== "string") throw new RpcError("bad_request", "record.type is required");
			void slot.handle(record as { type: string });
			return { ok: true };
		});
		this.register("slot.close", async (params) => {
			await this.closeSlot(requireStr(params.slotId, "slotId"));
			return { ok: true };
		});

		this.register("confirm.list", (params) => this.confirmations.list({ status: params.status as never, limit: num(params.limit) }));
		this.register("confirm.answer", (params) => {
			const id = requireStr(params.id, "id");
			for (const slot of this.allSlots()) {
				if (slot.ui.has(id)) {
					slot.ui.answer({ ...(params.response as object), id });
					return { ok: true };
				}
			}
			throw new RpcError("gone", "这个确认已经失效（对应的任务已经结束或后台重启过）");
		});

		this.register("runs.list", (params) =>
			this.runs.list({ sessionFile: str(params.sessionFile), taskId: str(params.taskId), status: params.status as never, limit: num(params.limit) }),
		);
		this.register("runs.get", (params) => this.runs.get(requireStr(params.id, "id")) ?? null);
		this.register("runs.steps", (params) => this.runs.steps(requireStr(params.runId, "runId")));
		this.register("runs.acknowledge", (params) => {
			this.runs.acknowledge(requireStr(params.id, "id"));
			return { ok: true };
		});
		this.register("workspace.toolRules", (params) =>
			this.db.all<{ tool: string; created_at: number }>("SELECT tool, created_at FROM workspace_tool_rules WHERE cwd = ?", normalizeCwd(requireStr(params.cwd, "cwd"))),
		);
		this.register("workspace.removeToolRule", (params) => {
			this.db.run("DELETE FROM workspace_tool_rules WHERE cwd = ? AND tool = ?", normalizeCwd(requireStr(params.cwd, "cwd")), requireStr(params.tool, "tool"));
			return { ok: true };
		});
	}

	async shutdown(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.reaper) clearInterval(this.reaper);
		for (const module of [...this.modules].reverse()) {
			try {
				await module.stop?.();
			} catch (error) {
				this.log.warn("module stop failed", error);
			}
		}
		for (const slot of this.opening.values()) slot.ui.cancelAll();
		for (const slotId of [...this.slots.keys()]) await this.closeSlot(slotId);
		this.db.close();
		for (const listener of this.shutdownListeners) listener();
	}
}

let cachedPiVersion: string | null | undefined;

/** Version of the Pi package the core embeds. */
export function piVersion(): string | null {
	if (cachedPiVersion !== undefined) return cachedPiVersion;
	try {
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		cachedPiVersion = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")).version ?? null;
	} catch {
		cachedPiVersion = null;
	}
	return cachedPiVersion ?? null;
}

export function normalizeCwd(cwd: string): string {
	return resolve(cwd).toLowerCase();
}

export function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function requireStr(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new RpcError("bad_request", `${name} is required`);
	return value;
}

export function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export type { SlotInfo };
