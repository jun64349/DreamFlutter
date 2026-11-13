import type { CompactionHooks } from "./agent/background-compaction.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, type AgentSessionEvent, type AgentSessionRuntime, type ExtensionFactory, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { BackupPart } from "./backup/parts.ts";
import { ConfirmationStore } from "./confirmations.ts";
import { Db, now } from "./db.ts";
import { assertSessionAvailable } from "./sessions/recycle.ts";
import { AGENT_MODES, type AgentMode } from "./agent/harness.ts";
import { approvalExtension } from "./ext/approval.ts";
import type { Logger } from "./log.ts";
import { NotificationCenter, type Notifier } from "./notify.ts";
import { StartupProgress } from "./startup.ts";
import type { CorePaths } from "./paths.ts";
import { dialogKind } from "./pi/dialogs.ts";
import { createSessionRuntime, isProjectTrusted, recordedSandbox, STANDARD_EXTRA_TOOLS, type PiHostConfig } from "./pi/host.ts";
import { isSideFile } from "./pi/session-metadata.ts";
import { RunStore, type Run } from "./runs.ts";
import { SettingsStore } from "./settings.ts";
import { SecurityService } from "./security/service.ts";
import { LibraryRegistry } from "./modules/library-registry.ts";
import { Slot, type SlotHooks, type SlotInfo } from "./slots/slot.ts";
import type { WebTools } from "./web/types.ts";
import { currentToolEnvironment, withToolEnvironment, type ToolEnvironmentProvider } from "./agent/tool-environment.ts";
import type { Ledger } from "./ledger/ledger.ts";
import { GoalsModule } from "./modules/goals.ts";
import { ButterflyModule } from "./modules/butterfly.ts";
import { chatPrompt, structuredChatInput } from "./modules/goals/chat-task.ts";
import { AUTONOMY_DRAFT_TOOL, AutonomyModule } from "./modules/autonomy/index.ts";
import { PersonaModule } from "./modules/persona/index.ts";
import { SelfworkModule, type SelfworkOptions } from "./modules/selfwork/index.ts";
import { JobsModule } from "./modules/jobs.ts";
import { PatrolModule, type PatrolClock } from "./modules/patrol.ts";
import { PythonFilesModule } from "./agent/python-files.ts";
import { withSubagentImages } from "./agent/process-images.ts";
import { SubagentsModule } from "./modules/subagents.ts";
import { RenderHtmlFilesModule } from "./agent/render-html-files.ts";

// The host allowlist admits these names; the patrol extension registers them only in the sandbox.
STANDARD_EXTRA_TOOLS.push("patrol_update_log", "watch_add", "watch_done");

export const CORE_VERSION = "0.8.3";

// Only legacy workbench schedule runs register this internal state tool.
STANDARD_EXTRA_TOOLS.push("save_monitor_state");

export interface CoreOptions {
	startup?: StartupProgress;
	updates?: import("./update/module.ts").UpdateOptions;
	piMigration?: import("./gateway/pi-migration.ts").PiMigrationOptions;
	/** Test-only transport/limits for the independent official web tools. */
	webSearch?: import("./web/deepseek.ts").DeepSeekWebOptions;
	paths: CorePaths;
	agentDir: string;
	sessionDir?: string;
	log: Logger;
	notifier: Notifier;
	/** Test hook, see PiHostConfig.modelRuntime. */
	modelRuntime?: () => ModelRuntime;
	/** Test hook: the stream gateway channels call instead of the real API. */
	gatewayTransport?: import("./gateway/gateway.ts").Transport;
	/** Test hook: the sandbox's distro name, folder and wsl.exe runner. */
	sandbox?: import("./sandbox/sandbox.ts").SandboxOptions;
	/** Test hook for the independent patrol timer. */
	patrolClock?: PatrolClock;
	/** Test hook for proactive chat's local-day and quiet-hour checks. */
	personaClock?: () => number;
	/** Test hooks for autonomous work and its sandbox trial. */
	selfwork?: SelfworkOptions;
	/** v0.3.1's data folders, to move into this one on its first start (main.ts gives them only for the default data folder). */
	legacyData?: import("./backup/backup.ts").LegacyData;
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
	/** A 蝶君 session: tools run in the WSL sandbox, without approval. */
	sandbox?: boolean;
	/** Start a side conversation from this file; persist on first send unless incognito. */
	forkOf?: string;
	parentSlotId?: string;
	sideQuote?: string;
	quoteEntryId?: string;
}

/** Feature modules plug in through these. */
export interface CoreModule {
	extensions?(slot: { slotId: string; sideConversation?: boolean }): ExtensionFactory[];
	/** Its extensions change what the model sees (tools, context): left out of minimal-mode sessions. */
	readonly modelFacing?: boolean;
	/** Its extensions also load into subagents (model routing, document reading); others belong to one conversation. */
	readonly forSubagents?: boolean;
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
	readonly notifications: NotificationCenter;
	readonly startup: StartupProgress;
	private readonly externalStartup: boolean;
	readonly settings: SettingsStore;
	readonly autonomy: AutonomyModule;
	readonly persona: PersonaModule;
	readonly security: SecurityService;
	readonly library: LibraryRegistry;
	readonly confirmations: ConfirmationStore;
	readonly runs: RunStore;
	private readonly patrol: PatrolModule;
	readonly paths: CorePaths;
	readonly agentDir: string;
	readonly sessionDir: string | undefined;
	readonly slots = new Map<string, Slot>();
	/** First-send files are invisible to indexing/opening until the send is accepted. */
	readonly pendingSessionFiles = new Set<string>();
	readonly deletingSessionFiles = new Set<string>();
	private readonly closingSlots = new Map<string, { slot: Slot; done: Promise<void> }>();

	isSlotClosing(slotId: string): boolean { return this.closingSlots.has(slotId); }

	/** Includes starts still waiting for extension binding or trust. */
	sessionSlots(): Slot[] { return this.allSlots(); }
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
	/** Independent Search/Fetch adapter, supplied by the web-search module. */
	webTools?: WebTools;
	ledger?: Ledger;
	/** Captured by tool shells at session creation; no harness or search policy changes. */
	toolEnvironment?: ToolEnvironmentProvider;
	/** Set by the context module: its part in each session's compactions (roadmap 5.12). */
	compactionHooks: ((slot: { slotId: string }) => CompactionHooks | undefined) | undefined;
	/** Gateway supplies effective model metadata without rewriting Pi's source files. */
	resolveModel: (model: Model<Api>) => Model<Api> = (model) => model;
	/** Historical model recovery uses the model entry's time, never the session file's creation time. */
	restoreSessionModel?: (ref: string, runtime: ModelRuntime, recordedAt?: number) => Model<Api> | undefined;
	modelWindow: (model: Model<Api>) => number | null = (model) => model.contextWindow || null;
	/** Slots whose runtime is still starting (possibly waiting on the trust prompt). */
	private readonly opening = new Map<string, Slot>();
	/** Session files being opened (normalized path → the open in progress). */
	private readonly openingFiles = new Map<string, Promise<Slot>>();
	/** Slots closed while still starting. */
	private readonly cancelledOpens = new Set<string>();
	private reaper: NodeJS.Timeout | undefined;
	private stopped = false;
	/** Each module's share of the database, for backups (backup/parts.ts). */
	readonly backupParts: BackupPart[] = [];
	/** Set while a backup copies the data: no new runs start (schedules wait, prompts are refused). */
	maintenance: string | undefined;
	/** Update-only admission/validation hooks, installed by the independent update module. */
	beforeRpc?: (method: string) => void;
	beforeOpenSlot?: () => void;
	beforeModuleStart?: () => void;
	private readonly shutdownListeners: (() => void)[] = [];
	private readonly shutdownPreparations: (() => Promise<void>)[] = [];
	private readonly broadcastListeners = new Set<(message: Record<string, unknown>) => void>();

	constructor(options: CoreOptions) {
		this.paths = options.paths;
		this.log = options.log;
		this.notifier = options.notifier;
		this.notifications = new NotificationCenter(this);
		this.startup = options.startup ?? new StartupProgress();
		this.externalStartup = !!options.startup;
		this.startup.onChange(state => this.broadcast({ event: "core.startup", ...state }));
		this.agentDir = options.agentDir;
		this.sessionDir = options.sessionDir;
		mkdirSync(options.paths.dataDir, { recursive: true });
		this.db = new Db(options.paths.dbFile);
		this.settings = new SettingsStore(this.db);
		this.security = new SecurityService(this);
		this.library = new LibraryRegistry(this.db, this.security.audit, () => this.broadcast({ event: "library.changed" }), join(this.agentDir, "mcp.json"));
		this.confirmations = new ConfirmationStore(this.db);
		this.runs = new RunStore(this.db);
		this.interruptedAtStartup = this.runs.interruptOrphans();
		const expired = this.confirmations.expireOrphans();
		if (this.interruptedAtStartup.length || expired) {
			this.log.info(`recovered: ${this.interruptedAtStartup.length} interrupted run(s), ${expired} expired dialog(s)`);
		}
		this.hostConfig = {
			ledger: () => this.ledger,
			ledgerContext: (slot) => ({ purpose: "conversation", slotId: slot.slotId, runId: this.slotOrOpening(slot.slotId)?.currentRun?.id, workspace: this.slotOrOpening(slot.slotId)?.info().cwd }),
			restoreSessionModel: (ref, runtime, recordedAt) => this.restoreSessionModel?.(ref, runtime, recordedAt),
			webTools: () => this.webTools,
			toolEnvironment: () => this.toolEnvironment,
			security: this.security,
			library: this.library,
			securityContext: (slot) => ({ slotId: slot.slotId, runId: this.slotOrOpening(slot.slotId)?.currentRun?.id }),
			pendingSessionFiles: this.pendingSessionFiles,
			agentDir: options.agentDir,
			sessionDir: options.sessionDir,
			modelRuntime: options.modelRuntime,
			trustDecisions: new Map(),
			extensions: (slot, mode) => [
				this.approval(slot.slotId),
				...this.modules.filter((m) => !(mode === "minimal" && m.modelFacing)).flatMap((m) => {
					const extensions = m.extensions?.(slot) ?? [];
					return m instanceof SubagentsModule ? extensions.map(withSubagentImages) : extensions;
				}),
			],
			newSessionMode: (slot) => this.slotOrOpening(slot.slotId)?.newSessionMode ?? this.settings.get().agentMode,
			autoCompaction: () => this.settings.get().autoCompaction,
			butterflyStyle: () => this.persona.prompt(),
			askTimeoutMs: () => this.settings.get().askTimeoutSeconds * 1000,
			sandbox: () => this.sandboxProvider?.(),
			agentStateChanged: (slot, state) => this.slotOrOpening(slot.slotId)?.setAgentState(state),
			harnessControls: new Map(),
			manualCompactions: new Set(),
			compaction: (slot) => this.compactionHooks?.(slot),
		};
		this.settings.onChange((settings, changed) => this.broadcast({ event: "settings.changed", settings, changed }));
		this.declareBackup({
			id: "core",
			title: "设置、运行记录、确认记录",
			tables: ["settings", "confirmations", "runs", "run_steps", "workspace_tool_rules", "app_flags"],
			paths: {
				settings: { value: "json" },
				confirmations: { session_file: "path", cwd: "path" },
				runs: { session_file: "path", cwd: "path", files: "json" },
				workspace_tool_rules: { cwd: "key" },
			},
		});
		this.registerBaseMethods();
		if (!STANDARD_EXTRA_TOOLS.includes(AUTONOMY_DRAFT_TOOL)) STANDARD_EXTRA_TOOLS.push(AUTONOMY_DRAFT_TOOL);
		this.autonomy = new AutonomyModule(this, options.modelRuntime);
		this.persona = new PersonaModule(this, options.personaClock);
		this.use(this.persona);
		this.use(new GoalsModule(this));
		this.use(this.autonomy);
		this.use(new SelfworkModule(this, options.modelRuntime, options.selfwork));
		this.patrol = new PatrolModule(this, options.patrolClock);
		this.use(this.patrol);
		this.use(new JobsModule(this));
		this.use(new PythonFilesModule(this));
		this.use(new RenderHtmlFilesModule(this));
	}

	/** Whether [cwd]'s project resources (.pi/ skills, packages…) may be loaded. */
	isProjectTrusted(cwd: string): boolean {
		return isProjectTrusted(cwd, this.agentDir, this.hostConfig.trustDecisions);
	}

	/**
	 * A Pi runtime for a subagent working for [parentSlotId]: in memory,
	 * standard mode, the parent's approval rules (including a schedule's
	 * restrictions), and only the modules marked forSubagents. Its dialogs go
	 * through [ui] (the parent's, so they appear in the parent conversation).
	 */
	openSubagentRuntime(parentSlotId: string, childId: string, cwd: string, ui: Slot["ui"], sandbox = false): Promise<AgentSessionRuntime> {
		const goals = this.module(GoalsModule)?.executor;
		const config: PiHostConfig = {
			...this.hostConfig,
			ledgerContext: () => ({ purpose: "subagent", slotId: childId, runId: this.slotOrOpening(parentSlotId)?.currentRun?.id, workspace: cwd }),
			securityContext: () => ({ slotId: childId, runId: this.slotOrOpening(parentSlotId)?.currentRun?.id }),
			extensions: () => [
				this.approval(parentSlotId),
				...(goals?.ownsSlot(parentSlotId) ? goals.extensions(parentSlotId, true) : []),
				...this.modules.filter((m) => m.forSubagents).flatMap((m) => m.extensions?.({ slotId: parentSlotId, sideConversation: this.slots.get(parentSlotId)?.isSideConversation }) ?? []),
			],
			newSessionMode: () => "standard",
			agentStateChanged: undefined,
			harnessControls: undefined,
		};
		return createSessionRuntime(config, { slotId: childId }, ui, { cwd, inMemory: true, sandbox, unattended: this.slotOrOpening(parentSlotId)?.unattended })
			.then(runtime => { goals?.attachChild(parentSlotId, runtime.session); return runtime; });
	}

	/** Set by the sandbox module once 蝶君's sandbox is set up. */
	sandboxProvider: (() => { distro: string; ready: () => Promise<void>; online: () => boolean } | undefined) | undefined;

	declareBackup(part: BackupPart): void {
		this.backupParts.push(part);
	}

	/** Sessions with a run in progress (a backup waits for them). */
	busySlots(): Slot[] {
		return this.allSlots().filter((slot) => slot.running);
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
		// Timed so a slow start can be traced to its module (V07-07).
		const slow: string[] = [];
		for (const module of this.modules) {
			this.beforeModuleStart?.();
			const label = module.constructor.name === "MemoryModule" ? "正在准备记忆……" : module.constructor.name === "Sandbox" ? "正在检查蝶君……" : "正在准备后台服务……";
			this.startup.mark(module.constructor.name, label);
			const at = performance.now();
			await module.start?.();
			const ms = performance.now() - at;
			if (ms >= 50) slow.push(`${module.constructor.name} ${Math.round(ms)}ms`);
			this.beforeModuleStart?.();
		}
		if (slow.length) this.log.info(`startup: slow modules: ${slow.join(", ")}`);
		this.reaper = setInterval(() => void this.reapIdle(), 60_000);
		this.reaper.unref();
		if (!this.externalStartup) this.startup.mark("ready", "准备好了", true);
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
		this.beforeRpc?.(method);
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
		this.notifications.remove(client);
	}

	broadcast(message: Record<string, unknown>): void {
		for (const client of this.clients) client.send(message);
		for (const listener of this.broadcastListeners) listener(message);
	}
	onBroadcast(listener: (message: Record<string, unknown>) => void): () => void {
		this.broadcastListeners.add(listener); return () => this.broadcastListeners.delete(listener);
	}
	beforeShutdown(listener: () => Promise<void>): void { this.shutdownPreparations.push(listener); }

	private watched(slotId: string): boolean {
		for (const client of this.clients) if (client.attached.has(slotId)) return true;
		return false;
	}

	onShutdown(listener: () => void): void {
		this.shutdownListeners.push(listener);
	}

	// ---- slots -----------------------------------------------------------------------

	findSlotByFile(sessionFile: string): Slot | undefined {
		for (const slot of [...this.slots.values(), ...[...this.closingSlots.values()].map((c) => c.slot)]) if (samePath(slot.info().sessionFile, sessionFile)) return slot;
		return undefined;
	}

	/** All task entry points share the same side-session exclusion. */
	assertTaskSession(sessionFile: string): void {
		assertSessionAvailable(this, sessionFile);
		if (this.findSlotByFile(sessionFile)?.isSideConversation || (existsSync(sessionFile) && isSideFile(sessionFile))) throw new RpcError("bad_request", "侧边对话不能绑定任务或定时计划");
	}

	/**
	 * Opens a session in a new slot, or returns the slot that already has
	 * [sessionFile] open (two runtimes on one file would corrupt it).
	 */
	async openSlot(options: OpenSlotOptions): Promise<Slot> {
		this.beforeOpenSlot?.();
		if (this.toolEnvironment && (currentToolEnvironment()?.provider !== this.toolEnvironment || currentToolEnvironment()?.workspace !== options.cwd))
			return withToolEnvironment({ provider: this.toolEnvironment, workspace: options.cwd }, () => this.openSlot(options));
		if (this.stopped) throw new RpcError("unavailable", "后台正在退出");
		if (options.slotId && this.isSlotClosing(options.slotId)) throw new RpcError("conflict", "会话正在关闭，请稍后重试");
		if (options.taskId && options.sessionFile) this.assertTaskSession(options.sessionFile);
		if (options.sessionFile && this.deletingSessionFiles.has(normalizeCwd(options.sessionFile))) throw new RpcError("conflict", "会话正在删除");
		if (options.sessionFile) assertSessionAvailable(this, options.sessionFile);
		if (options.sessionFile && this.pendingSessionFiles.has(normalizeCwd(options.sessionFile))) throw new RpcError("conflict", "会话正在保存，请稍后重试");
		if (!options.sessionFile) return this.openNewSlot(options);
		const existing = this.findSlotByFile(options.sessionFile);
		if (existing) {
			if (this.isSlotClosing(existing.slotId)) throw new RpcError("conflict", "会话正在关闭，请稍后重试");
			existing.resetPromptRequests(options.client?.id);
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
		if (this.slots.has(slotId) || this.opening.has(slotId) || this.isSlotClosing(slotId)) throw new RpcError("conflict", `Slot ${slotId} already exists or is closing`);
		options.client?.attached.add(slotId);
		const parentSlot = options.parentSlotId ? this.slot(options.parentSlotId) : undefined;
		const parentFile = parentSlot?.info().sessionFile ?? options.forkOf;
		if (parentFile) assertSessionAvailable(this, parentFile);
		const isSide = !!(options.forkOf || options.parentSlotId);
		if (isSide && options.taskId) throw new RpcError("bad_request", "侧边对话不能绑定任务");
		if (isSide && !parentFile && !parentSlot?.incognito) throw new RpcError("bad_request", "主会话尚未保存");
		if (isSide && options.sessionFile) throw new RpcError("bad_request", "不能同时创建和打开侧边对话");
		if (isSide && parentSlot && !samePath(parentSlot.cwd, options.cwd)) throw new RpcError("bad_request", "侧边对话必须在同一工作区");
		if (isSide && !parentSlot && (!parentFile || !existsSync(parentFile))) throw new RpcError("not_found", "主会话文件不存在");
		if (parentFile && this.deletingSessionFiles.has(normalizeCwd(parentFile))) throw new RpcError("conflict", "主会话正在删除");
		if (parentFile && this.pendingSessionFiles.has(normalizeCwd(parentFile))) throw new RpcError("conflict", "主会话正在保存");
		const parentManager = parentSlot?.session.sessionManager ?? (isSide ? SessionManager.open(parentFile!, this.sessionDir) : undefined);
		if (parentManager && !samePath(parentManager.getCwd(), options.cwd)) throw new RpcError("bad_request", "侧边对话必须在同一工作区");
		const target = {
			cwd: options.cwd,
			sessionFile: options.incognito ? undefined : options.sessionFile,
			inMemory: parentSlot?.incognito === true || options.incognito === true,
			unattended: options.unattended === true,
			sandbox: parentManager ? recordedSandbox(parentManager) : options.sandbox === true,
			// Read only for an in-memory session: nothing is ever written back to the source.
			forkOf: isSide ? parentFile : undefined,
			forkEntries: parentManager ? structuredClone(parentManager.getBranch()) : undefined,
			side: isSide ? { quote: options.sideQuote ?? "", quoteEntryId: options.quoteEntryId ?? null } : undefined,
		};
		if (target.forkOf && !(target.forkOf.endsWith(".jsonl") && existsSync(target.forkOf))) throw new RpcError("not_found", `会话文件不存在：${target.forkOf}`);
		const slot = Slot.prepare(
			this.db,
			{ slotId, target, taskId: options.taskId, unattended: options.unattended, agentMode: options.agentMode ?? this.settings.get().agentMode },
			this.slotHooks(),
		);
		this.opening.set(slotId, slot);
		try {
			const config = this.patrol.owns(slotId) ? { ...this.hostConfig, sessionDir: this.patrol.sessionDir } : this.hostConfig;
			await slot.start(config, target);
			if (this.cancelledOpens.has(slotId)) {
				// Closed while it was starting (e.g. during the trust prompt): never publish it.
				await slot.dispose();
				throw new RpcError("cancelled", "会话在打开过程中被关闭了");
			}
			this.slots.set(slotId, slot);
			if (!options.sessionFile && (!isSide || !slot.session.model)) await this.applyDefaultModel(slot);
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
			if (model) await session.setModel(this.resolveModel(model));
			else this.log.warn(`default model ${defaultModel} is not available`);
		}
		// Pi clamps a level the model lacks to the nearest one it has (deepseek-v4.1-flash cannot turn thinking off).
		// Pi's default recommendation is medium, clamped to the model's supported levels.
		session.setThinkingLevel((defaultThinking ?? "medium") as never);
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
		return [...new Set([...this.slots.values(), ...this.opening.values(), ...[...this.closingSlots.values()].map((c) => c.slot)])];
	}

	async closeSlot(slotId: string): Promise<void> {
		const closing = this.closingSlots.get(slotId);
		if (closing) return closing.done;
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
		// Register ownership before dispose can emit callbacks or yield.
		const operation = Promise.resolve().then(async () => {
			await slot.dispose();
			this.hostConfig.harnessControls?.delete(slotId);
			for (const module of this.modules) module.onSlotClosed?.(slot);
			this.broadcast({ event: "slot.closed", slotId });
		});
		this.closingSlots.set(slotId, { slot, done: operation });
		try { await operation; }
		finally { this.closingSlots.delete(slotId); }
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
			resolveModel: (model) => this.resolveModel(model),
			modelWindow: (model) => this.modelWindow(model),
			record: (slotId, record) => {
				const message = { event: "slot.record", slotId, record };
				for (const client of this.clients) if (client.attached.has(slotId)) client.send(message);
			},
			changed: (slot) => {
				if (this.slots.has(slot.slotId)) this.broadcast({ event: "slot.changed", info: slot.info() });
				for (const module of this.modules) module.onSlotChanged?.(slot);
			},
			dialogOpened: (slot, request) => {
				if (this.patrol.owns(slot.slotId)) {
					queueMicrotask(() => slot.ui.cancelAll());
					return;
				}
				this.confirmations.opened({ slotId: slot.slotId, sessionFile: slot.info().sessionFile ?? undefined, cwd: slot.cwd }, request);
				this.broadcast({ event: "confirm.changed", confirmation: this.confirmations.get(request.id) });
				const kind = dialogKind(request.title);
				// Dialog owners (including T-85 pre-start intents) share this single notification path.
				if (slot.sandboxed || kind === "approval" || kind === "trust") this.notifications.publish(slot.sandboxed ? "butterfly.waiting" : "workbench.approval", {
					title: slot.sandboxed ? "蝶君有件事等你决定" : "工作台需要你批准", body: slot.info().sessionName ?? slot.cwd,
					key: `confirmation:${request.id}`, object: slot.info().sessionName ?? (slot.sandboxed ? "蝶君对话" : "工作台"),
					situation: "等你决定", impact: "这项操作需要你的决定才能继续", action: "查看并处理",
					target: { page: "attention", slotId: slot.slotId, sessionFile: slot.info().sessionFile, itemId: request.id, runId: slot.currentRun?.id },
				});
			},
			dialogClosed: (slot, id, outcome, response) => {
				if (this.patrol.owns(slot.slotId)) return;
				this.confirmations.closed(id, outcome, response);
				this.broadcast({ event: "confirm.changed", confirmation: this.confirmations.get(id) });
			},
			event: (slot, event) => {
				if (this.patrol.owns(slot.slotId)) {
					this.patrol.onSlotEvent(slot, event);
					return;
				}
				for (const module of this.modules) module.onSlotEvent?.(slot, event);
			},
			sessionCreated: (slot) => this.applyDefaultModel(slot),
			fileTaken: (slot, file) => {
				if (this.pendingSessionFiles.has(normalizeCwd(file)) || this.deletingSessionFiles.has(normalizeCwd(file))) return true;
				const owner = this.findSlotByFile(file);
				return (owner !== undefined && owner !== slot) || this.openingFiles.has(normalizeCwd(file));
			},
			resolveTaskId: (slot) => {
				for (const module of this.modules) {
					const id = module.resolveTaskId?.(slot);
					if (id !== undefined) return id;
				}
				return null;
			},
			runStarted: (slot, run) => {
				if (this.patrol.owns(slot.slotId)) return;
				for (const module of this.modules) module.onRunStarted?.(slot, run);
			},
			runFinished: (slot, run) => {
				if (this.patrol.owns(slot.slotId)) {
					this.patrol.onRunFinished(slot, run);
					return;
				}
				this.broadcast({ event: "run.finished", run });
				for (const module of this.modules) module.onRunFinished?.(slot, run);
				if (run.status === "done" && !this.module(GoalsModule)?.executor.ownsSlot(slot.slotId)
					&& !this.db.get("SELECT id FROM notices WHERE slot_id=? AND status='pending'", slot.slotId)) this.notifications.publish(slot.sandboxed ? "butterfly.done" : "workbench.done", {
					title: slot.sandboxed ? "蝶君做完了" : "工作台回复完了", body: slot.info().sessionName ?? run.prompt ?? "任务",
					key: `run:${run.id}:done`, objectRef: run.id, object: slot.info().sessionName ?? (slot.sandboxed ? "蝶君对话" : "工作台"),
					situation: "已完成", impact: "本轮回复可查看", action: "打开对话",
					target: { page: slot.sandboxed ? "butterfly" : "chat", slotId: slot.slotId, sessionFile: run.sessionFile, taskId: run.taskId, runId: run.id },
				});
			},
		};
	}

	// ---- approval policy -------------------------------------------------------------

	private approval(slotId: string): ExtensionFactory {
		return approvalExtension({
			audit: (tool, decision, reason, requestId) => this.security.audit.record("approval", tool, decision, reason, { slotId, runId: this.slotOrOpening(slotId)?.currentRun?.id, requestId }),
			// Modules decide first (a scheduled run restricts even core-exempt tools).
			override: (tool, input) => {
				const slot = this.slots.get(slotId) ?? this.opening.get(slotId);
				if (!slot) return undefined;
				// 蝶君 works in its sandbox with full rights there: nothing to approve.
				if (slot.sandboxed) return "allow";
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
			butterflyHome: this.paths.butterflyDir,
			agentDir: this.agentDir,
			sessionDir: this.sessionDir ?? join(this.agentDir, "sessions"),
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
			const title = requireStr(params.title, "title"), body = str(params.body) ?? "";
			void this.notifications.send({ key: `manual:${randomUUID()}`, category: "reminder", object: title, situation: "提醒",
				impact: body, action: "打开 DreamFlutter", target: { page: "attention" } }, { legacy: { title, body } })
				.catch(error => this.log.warn("无法发送手动通知", error));
			return { ok: true };
		});

		this.register("settings.get", () => this.settings.get());
		this.register("core.startup", () => this.startup.snapshot());
		this.register("core.activity", () => { const running = this.sessionSlots().filter(s => s.running || s.info().compacting || this.opening.has(s.slotId)).map(s => s.info()); return { running, count: running.length }; });
		this.register("notifications.presence", (p, client) => {
			if (!client || typeof p.foreground !== "boolean") throw new RpcError("bad_request", "需要窗口连接和前台状态");
			this.notifications.setPresence(client, { foreground: p.foreground, slotId: str(p.slotId) ?? null });
			return { ok: true };
		});
		this.register("settings.update", (params) => this.settings.update(params));

		this.register("slot.open", async (params, client) => {
			const slot = await this.openSlot({
				slotId: str(params.slotId),
				cwd: requireStr(params.cwd, "cwd"),
				sessionFile: str(params.sessionFile),
				incognito: params.incognito === true,
				agentMode: AGENT_MODES.includes(params.agentMode as AgentMode) ? (params.agentMode as AgentMode) : undefined,
				sandbox: params.sandbox === true,
				forkOf: str(params.forkOf),
				parentSlotId: str(params.parentSlotId),
				sideQuote: str(params.sideQuote),
				quoteEntryId: str(params.quoteEntryId),
				client,
			});
			return slot.info();
		});
		this.register("slot.list", () => [...this.slots.values()].map((s) => s.info()));
		this.register("slot.attach", (params, client) => {
			const slot = this.slot(params.slotId);
			slot.resetPromptRequests(client?.id);
			client?.attached.add(slot.slotId);
			return { info: slot.info(), replay: slot.ui.replay(), live: slot.liveSnapshot() };
		});
		this.register("slot.detach", (params, client) => {
			if (typeof params.slotId === "string") client?.attached.delete(params.slotId);
			return { ok: true };
		});
		this.register("slot.send", async (params, client) => {
			const slot = this.slot(params.slotId, { includeOpening: true });
			const input = params.record as Params | undefined;
			if (!input || typeof input.type !== "string") throw new RpcError("bad_request", "record.type is required");
			const { chatInput, ...fields } = input;
			const structured = input.type === "prompt" && chatInput !== undefined ? structuredChatInput(chatInput) : undefined;
			if (structured === null) throw new RpcError("bad_request", "record.chatInput 无效");
			const record = { ...fields, type: input.type, ...(structured && { message: chatPrompt(structured) }) };
			if (this.stopped && record.type === "prompt") throw new RpcError("unavailable", "后台正在退出");
			if (this.maintenance && record.type === "prompt") throw new RpcError("busy", `${this.maintenance}，请稍后再发`);
			const chat = this.module(ButterflyModule)?.chat;
			if (chat && await chat.route(slot, record, client?.id, structured)) {
				const reply = { id: (record as Params).id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } };
				client?.send({ event: "slot.record", slotId: slot.slotId, record: reply });
				void chat.refresh().catch(error => this.log.warn("无法刷新交办会话索引", error));
			} else if (!this.module(GoalsModule)?.executor.routeInput(slot, record as { type: string }, client?.id)) {
				void slot.handle(record as { type: string }, client?.id);
			}
			return { ok: true };
		});
		this.register("slot.close", async (params) => {
			await this.closeSlot(requireStr(params.slotId, "slotId"));
			return { ok: true };
		});

		this.register("confirm.list", (params) => this.confirmations.list({ status: params.status as never, limit: num(params.limit) }));
		this.register("confirm.answer", (params) => {
			const id = requireStr(params.id, "id");
			if (this.autonomy.answerConfirmation(id, params.response)) return { ok: true };
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
			this.broadcast({ event: "runs.changed" });
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
		// Timed so a slow exit can be traced (V07-07).
		const began = performance.now();
		const slow: string[] = [];
		for (const prepare of this.shutdownPreparations) {
			try { await prepare(); } catch (error) { this.log.warn("shutdown preparation failed", error); }
		}
		for (const module of [...this.modules].reverse()) {
			const at = performance.now();
			try {
				await module.stop?.();
			} catch (error) {
				this.log.warn("module stop failed", error);
			}
			const ms = performance.now() - at;
			if (ms >= 50) slow.push(`${module.constructor.name} ${Math.round(ms)}ms`);
		}
		const modulesDone = performance.now();
		for (const slot of this.opening.values()) slot.ui.cancelAll();
		const slots = this.slots.size;
		for (const slotId of [...this.slots.keys()]) await this.closeSlot(slotId);
		await Promise.all([...this.closingSlots.values()].map((c) => c.done));
		this.log.info(`shutdown: modules ${Math.round(modulesDone - began)}ms${slow.length ? ` (${slow.join(", ")})` : ""}, ${slots} session(s) closed in ${Math.round(performance.now() - modulesDone)}ms`);
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
