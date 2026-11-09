import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionFactory,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CompactionHooks } from "../agent/background-compaction.ts";
import { type AgentMode, dshCompactionSettings, type HarnessControl, harnessExtension, MINIMAL_TOOLS, MODE_ENTRY, recordedMode, SANDBOX_TOOLS, STANDARD_TOOLS } from "../agent/harness.ts";
import { RETRY } from "../agent/dsh-text.ts";
import type { TodoItem } from "../agent/state.ts";
import { DISTRUST_ONCE, DISTRUST_REMEMBER, TRUST_ONCE, TRUST_REMEMBER, TRUST_TITLE } from "./dialogs.ts";
import type { UiBridge } from "./ui-bridge.ts";
import { dropSharedAgentSkills } from "../paths.ts";
import { HISTORY_ENTRY, SIDE_ENTRY, sideConversation } from "./session-metadata.ts";
import type { SecurityService } from "../security/service.ts";
import type { AuditContext } from "../security/audit.ts";
import { secureMcpFactory } from "../security/mcp.ts";
import { loadSecurityMcpConfig } from "../security/mcp-config.ts";
import type { WebTools } from "../web/types.ts";
import { withToolEnvironment, type ToolEnvironmentProvider } from "../agent/tool-environment.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { withLedgerContext, type LedgerContext } from "../ledger/types.ts";
import { locator, type LibraryRegistry } from "../modules/library-registry.ts";
import { mergeBuiltinSkills } from "../modules/builtin-skills.ts";

/** Fixed inputs shared by every session the core hosts. */
export interface PiHostConfig {
	ledger?: () => Ledger | undefined;
	ledgerContext?: (slot: SlotIdentity) => LedgerContext;
	restoreSessionModel?: (ref: string, runtime: import("@earendil-works/pi-coding-agent").ModelRuntime, recordedAt?: number) => Model<never> | Model<any> | undefined;
	webTools?: () => WebTools | undefined;
	toolEnvironment?: () => ToolEnvironmentProvider | undefined;
	security?: SecurityService;
	library?: LibraryRegistry;
	securityContext?: (slot: SlotIdentity) => AuditContext;
	pendingSessionFiles?: Set<string>;
	agentDir: string;
	/** Overrides Pi's session directory (tests); undefined = Pi's default. */
	sessionDir?: string;
	/** Core extensions loaded into a session of [mode], after Pi's built-ins. */
	extensions: (slot: SlotIdentity, mode: AgentMode) => ExtensionFactory[];
	/** Mode for a session that has none recorded yet (a new session in [slot]). */
	newSessionMode: (slot: SlotIdentity) => AgentMode;
	/** Whether the core's automatic compaction setting is on. */
	autoCompaction: () => boolean;
	/** How long the agent's questions wait for an answer, in ms; 0 = no limit. */
	askTimeoutMs?: () => number;
	/** 蝶君's sandbox for sandboxed sessions; undefined while it is not set up. */
	sandbox?: () => { distro: string; ready: () => Promise<void>; online: () => boolean } | undefined;
	/** A session's todo list or plan mode changed. */
	agentStateChanged?: (slot: SlotIdentity, state: { todos: TodoItem[] | null; planMode: boolean }) => void;
	/** Handles of each slot's current harness, by slot id. */
	harnessControls?: Map<string, HarnessControl>;
	/** Slots running a manual compaction (dsh's compactNow keeps no recent history back). */
	manualCompactions?: Set<string>;
	/** The context service's part in a session's compactions (roadmap 5.12). */
	compaction?: (slot: SlotIdentity) => CompactionHooks | undefined;
	/**
	 * Trust decisions made during this core run, by lower-cased cwd. "Trust
	 * once" answers live here, so other sessions in the workspace do not ask again.
	 */
	trustDecisions: Map<string, boolean>;
	/** Test hook: replace Pi's model runtime (e.g. a faux provider). */
	modelRuntime?: () => import("@earendil-works/pi-coding-agent").ModelRuntime;
}

export interface SlotIdentity {
	slotId: string;
	sideConversation?: boolean;
}

/** DreamFlutter tools a standard session keeps beside dsh's (patterns as Pi's tool lists accept them). */
export const STANDARD_EXTRA_TOOLS = ["memory_*", "session_search", "skill_propose", "skill_register", "skill_test", "skill_script_trial", "skill_route", "mcp_register", "mcp_test", "schedule_*", "tool_search", "mcp__*", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "show_card", "read_card", "read_document", "agent", "web_search"];

/** The mode a runtime for [sessionManager] runs in: recorded, else standard for an old session, else the new-session mode. */
export function modeFor(sessionManager: SessionManager, newSessionMode: AgentMode): AgentMode {
	const recorded = recordedMode(sessionManager);
	if (recorded) return recorded;
	const hasHistory = sessionManager.getEntries().some((e) => e.type === "message");
	return hasHistory ? "standard" : newSessionMode;
}

/** Match Pi's model selection on the active branch, including assistant records without model_change. */
export function recordedSessionModel(sessionManager: Pick<SessionManager, "getBranch">): { ref: string; recordedAt?: number } | undefined {
	const entry = sessionManager.getBranch().findLast((e) => e.type === "model_change" || (e.type === "message" && e.message.role === "assistant"));
	if (!entry) return undefined;
	const ref = entry.type === "model_change" ? `${entry.provider}/${entry.modelId}`
		: entry.type === "message" && entry.message.role === "assistant" ? `${entry.message.provider}/${entry.message.model}` : undefined;
	if (!ref) return undefined;
	const at = Date.parse(entry.timestamp);
	return { ref, recordedAt: Number.isFinite(at) ? at : undefined };
}

/** Whether [cwd]'s project resources may load: nothing needing trust, or trusted now or before. */
export function isProjectTrusted(cwd: string, agentDir: string, decisions: Map<string, boolean>): boolean {
	if (!hasTrustRequiringProjectResources(cwd)) return true;
	return decisions.get(cwd.toLowerCase()) ?? new ProjectTrustStore(agentDir).get(cwd) === true;
}

/** The CLI's built-in extensions (not exported as a list by the package). */
function builtInExtensions(agentDir: string, security?: SecurityService, context?: () => AuditContext, library?: LibraryRegistry, butterfly = false): InlineExtension[] {
	const transportId = randomUUID();
	return [
		{ name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
		{ name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
		{ name: "mcp", factory: createMcpExtension({ logPath: join(agentDir, "mcp.log"), loadConfig: (ctx) => {
			const loaded = loadSecurityMcpConfig(agentDir, ctx.cwd, ctx.isProjectTrusted());
			loaded.servers = loaded.servers.filter((entry) => library ? library.mcpAllowed(entry, butterfly) : !butterfly);
			return loaded;
		}, createTransport: secureMcpFactory(security?.audit, undefined, context, library ? {
			allowed: (entry) => library.mcpAllowed(entry, butterfly),
			used: (entry, id) => library.used("mcp", library.mcpKey(entry), `${transportId}:${entry.name}:${String(id)}`),
		} : undefined) }), replaceable: true, builtin: true },
	] as InlineExtension[];
}

/**
 * Asks whether to trust a workspace's project resources (.pi/ settings,
 * extensions, skills…). Pi cannot prompt in RPC mode, so the core asks through
 * the session's UI bridge; "remember" answers go to Pi's own trust.json.
 */
async function askTrust(cwd: string, agentDir: string, ui: UiBridge): Promise<boolean> {
	const choice = await ui
		.context()
		.select(`${TRUST_TITLE}\n\n${cwd}\n\n这个工作区包含 Pi 项目配置（.pi 目录里的设置、扩展、技能等）。只信任你了解的工作区。`, [
			TRUST_ONCE,
			TRUST_REMEMBER,
			DISTRUST_ONCE,
			DISTRUST_REMEMBER,
		]);
	const trusted = choice === TRUST_ONCE || choice === TRUST_REMEMBER;
	if (choice === TRUST_REMEMBER || choice === DISTRUST_REMEMBER) {
		new ProjectTrustStore(agentDir).set(cwd, trusted);
	}
	return trusted;
}

export interface OpenTarget {
	cwd: string;
	/** Existing session file to open; omitted = new session. */
	sessionFile?: string;
	/** Temporary chat: never written to disk (and so never indexed or remembered). */
	inMemory?: boolean;
	/** Opened by the scheduler: nobody can answer the trust prompt, so untrusted project resources stay off. */
	unattended?: boolean;
	/** A 蝶君 session: its tools run in the WSL sandbox (remembered in the session file). */
	sandbox?: boolean;
	/**
	 * Begin with this session file's current branch (a side conversation).
	 * The copy gets its own id and remembers the source as its parent; the file is only read.
	 */
	forkOf?: string;
	/** Host-owned snapshot of the parent's branch (also supports an incognito parent). */
	forkEntries?: import("@earendil-works/pi-coding-agent").SessionEntry[];
	side?: { quote: string; quoteEntryId: string | null };
}

/**
 * Creates a Pi session runtime the way the CLI does for RPC mode, with the
 * core's extensions and trust prompt. The returned runtime handles new/switch/
 * fork in place, recreating cwd-bound services as needed.
 */
export async function createSessionRuntime(config: PiHostConfig, slot: SlotIdentity, ui: UiBridge, target: OpenTarget): Promise<AgentSessionRuntime> {
	const sessionManager = target.inMemory || target.side
		? target.forkOf || target.forkEntries
			? SessionManager.inMemory(target.cwd, { parentSession: target.forkOf }, target.forkEntries ?? SessionManager.open(target.forkOf!, config.sessionDir).getBranch())
			: SessionManager.inMemory(target.cwd)
		: target.sessionFile
			? SessionManager.open(target.sessionFile, config.sessionDir)
			: SessionManager.create(target.cwd, config.sessionDir);
	if (target.side) {
		const lastEntryId = sessionManager.getLeafId();
		sessionManager.appendCustomEntry(HISTORY_ENTRY, { sessionId: sessionManager.getSessionId(), lastEntryId });
		sessionManager.appendCustomEntry(SIDE_ENTRY, { sessionId: sessionManager.getSessionId(), ...target.side });
	}

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const side = !!sideConversation(sessionManager);
		if (sessionStartEvent?.reason === "fork") {
			sessionManager.appendCustomEntry(HISTORY_ENTRY, { sessionId: sessionManager.getSessionId(), lastEntryId: sessionManager.getLeafId() });
		}
		const needsTrust = hasTrustRequiringProjectResources(cwd);
		const stored = new ProjectTrustStore(agentDir).get(cwd);
		const cached = config.trustDecisions.get(cwd.toLowerCase());
		const mustAsk = needsTrust && cached === undefined && stored === null && !target.unattended;
		const projectTrusted = !needsTrust || (cached ?? stored === true);
		// 蝶君's sessions run in the sandbox, in standard mode; the session file remembers it.
		const sandboxed = target.sandbox === true || recordedSandbox(sessionManager);
		const mode = sandboxed ? "standard" : modeFor(sessionManager, config.newSessionMode(slot));
		const sandbox = sandboxed ? config.sandbox?.() : undefined;
		if (sandboxed && !sandbox) throw new Error("蝶君的沙箱还没有准备好");
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: mustAsk ? false : projectTrusted });
		// Pi's "Block images" setting (made for terminals) swaps every image for
		// "Image reading is disabled." before it reaches the model. The window only
		// offers images for models that accept them, so it never applies here. An
		// instance override, because a settings reload would drop applyOverrides.
		settingsManager.getBlockImages = () => false;
		// Session behaviour comes from the core and the agent mode (dsh's compaction
		// budget and retry policy), never from writes to the user's Pi settings.
		let services: Awaited<ReturnType<typeof createAgentSessionServices>> | undefined;
		const fullModel = (ref?: { provider: string; id: string }) =>
			ref ? services?.modelRuntime.getAvailableSnapshot().find((m) => m.provider === ref.provider && m.id === ref.id) : undefined;
		settingsManager.getCompactionEnabled = () => config.autoCompaction();
		settingsManager.setCompactionEnabled = () => {};
		settingsManager.getCompactionSettings = (model) => {
			const full = fullModel(model);
			const base = dshCompactionSettings(full, config.autoCompaction());
			// The session's own threshold (a percentage of the window), never above dsh's safe one.
			const settings = config.compaction?.(slot)?.settings?.(full, base) ?? base;
			return config.manualCompactions?.has(slot.slotId) ? { ...settings, keepRecentTokens: 1 } : settings;
		};
		settingsManager.getRetrySettings = () => ({ enabled: true, maxRetries: RETRY.maxRetries, baseDelayMs: RETRY.baseDelayMs, maxAgentDelayMs: RETRY.maxDelayMs });
		settingsManager.getHttpIdleTimeoutMs = () => 300_000;
		const requestId = randomUUID();
		const securityContext = () => ({ requestId, ...config.securityContext?.(slot), slotId: slot.slotId });
		const security = config.security?.scope(cwd, target.unattended === true, securityContext);
		if (security) security.sandboxed = sandboxed;
		const harness = harnessExtension({
			webTools: config.webTools?.(),
			webContext: () => ({ ...securityContext(), sessionId: sessionManager.getSessionId() }),
			security,
			mode,
			agentDir,
			resources: () => services?.resourceLoader,
			complete: (model, context, options) => withLedgerContext({ ...config.ledgerContext?.(slot), sessionId: sessionManager.getSessionId(), purpose: "compaction" }, () => services!.modelRuntime.completeSimple(model as Model<never>, context, options as never)),
			autoCompaction: config.autoCompaction,
			compaction: () => config.compaction?.(slot),
			askTimeoutMs: config.askTimeoutMs,
			unattended: target.unattended === true,
			sandbox,
			onStateChanged: (state) => config.agentStateChanged?.(slot, state),
			control: (() => {
				const control: HarnessControl = {};
				config.harnessControls?.set(slot.slotId, control);
				return control;
			})(),
		});
		// dsh compositions own the tool catalog: no code mode, and the minimal mode no MCP either.
		// Resource reloads and child runtimes invoke the factory outside Core.openSlot's async scope.
		const sourceHarness: ExtensionFactory = (api) => {
			const provider = config.toolEnvironment?.();
			return provider ? withToolEnvironment({ provider, workspace: cwd }, () => harness(api)) : harness(api);
		};
		// A host-side MCP service is visible to 蝶君 only after a separate per-service user grant.
		const builtIns = mode === "minimal" ? [] : builtInExtensions(agentDir, config.security, securityContext, config.library, sandboxed).filter((e) => (e.name === "mcp" && (!sandboxed || !!config.library)) || e.name === "tool-search");
		services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			modelRuntime: config.modelRuntime?.(),
			modelRuntimeSignal: AbortSignal.timeout(15_000),
			resourceLoaderReloadOptions: mustAsk
				? {
						resolveProjectTrust: async () => {
							const trusted = await askTrust(cwd, agentDir, ui);
							config.trustDecisions.set(cwd.toLowerCase(), trusted);
							return trusted;
						},
					}
				: undefined,
			resourceLoaderOptions: {
				extensionFactories: [...(config.library ? [config.library.extension(sandboxed, () => ({ skills: services?.resourceLoader.getSkills().skills ?? [], prompts: services?.resourceLoader.getPrompts().prompts ?? [] }), () => `${slot.slotId}:${securityContext().runId ?? requestId}`)] : []), ...(security ? [security.extension()] : []), ...builtIns, sourceHarness, ...config.extensions({ ...slot, sideConversation: side }, mode)],
				skillsOverride: (base) => { const filtered = mergeBuiltinSkills(dropSharedAgentSkills(base), config.library); return { ...filtered, skills: filtered.skills.filter((skill) => config.library?.fileAllowed("skill", skill.filePath) !== false) }; },
				promptsOverride: (base) => ({ ...base, prompts: base.prompts.filter((prompt) => config.library?.fileAllowed("template", prompt.filePath) !== false) }),
			},
		});
		const requestContext = () => ({ ...config.ledgerContext?.(slot), sessionId: sessionManager.getSessionId(), workspace: cwd });
		config.ledger?.()?.bindSession(sessionManager.getSessionId(), requestContext);
		config.ledger?.()?.install(services.modelRuntime, requestContext);
		const recorded = recordedSessionModel(sessionManager);
		const restoredModel = recorded ? config.restoreSessionModel?.(recorded.ref, services.modelRuntime, recorded.recordedAt) : undefined;
		if (!recordedMode(sessionManager)) sessionManager.appendCustomEntry(MODE_ENTRY, { mode });
		if (sandboxed && !recordedSandbox(sessionManager)) sessionManager.appendCustomEntry(SANDBOX_ENTRY, { sandbox: true });
		const created = await createAgentSessionFromServices({
			...(restoredModel ? { model: restoredModel } : {}),
			services,
			sessionManager,
			sessionStartEvent,
			noTools: "builtin",
			// read_document reads on this machine: not for 蝶君, whose files are in the sandbox.
			tools: mode === "minimal" ? MINIMAL_TOOLS : sandbox ? [...SANDBOX_TOOLS(), ...STANDARD_EXTRA_TOOLS.filter((t) => t !== "read_document")] : [...STANDARD_TOOLS, ...STANDARD_EXTRA_TOOLS],
		});
		return { ...created, services, diagnostics: [...services.diagnostics] };
	};

	return createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir: config.agentDir,
		sessionManager,
	});
}

/** Custom entry marking a session that runs in 蝶君's sandbox. */
export const SANDBOX_ENTRY = "df.sandbox";

export function recordedSandbox(sessionManager: Pick<SessionManager, "getEntries">): boolean {
	return (sessionManager.getEntries() as { type: string; customType?: string }[]).some((e) => e.type === "custom" && e.customType === SANDBOX_ENTRY);
}
