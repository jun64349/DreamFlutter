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
import type { CompactionHooks } from "../agent/background-compaction.ts";
import { type AgentMode, dshCompactionSettings, type HarnessControl, harnessExtension, MINIMAL_TOOLS, MODE_ENTRY, recordedMode, SANDBOX_TOOLS, STANDARD_TOOLS } from "../agent/harness.ts";
import { RETRY } from "../agent/dsh-text.ts";
import type { TodoItem } from "../agent/state.ts";
import { DISTRUST_ONCE, DISTRUST_REMEMBER, TRUST_ONCE, TRUST_REMEMBER, TRUST_TITLE } from "./dialogs.ts";
import type { UiBridge } from "./ui-bridge.ts";
import { dropSharedAgentSkills } from "../paths.ts";

/** Fixed inputs shared by every session the core hosts. */
export interface PiHostConfig {
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
}

/** DreamFlutter tools a standard session keeps beside dsh's (patterns as Pi's tool lists accept them). */
export const STANDARD_EXTRA_TOOLS = ["memory_*", "session_search", "skill_propose", "schedule_*", "tool_search", "show_card", "read_card", "read_document", "agent"];

/** The mode a runtime for [sessionManager] runs in: recorded, else standard for an old session, else the new-session mode. */
export function modeFor(sessionManager: SessionManager, newSessionMode: AgentMode): AgentMode {
	const recorded = recordedMode(sessionManager);
	if (recorded) return recorded;
	const hasHistory = sessionManager.getEntries().some((e) => e.type === "message");
	return hasHistory ? "standard" : newSessionMode;
}

/** Whether [cwd]'s project resources may load: nothing needing trust, or trusted now or before. */
export function isProjectTrusted(cwd: string, agentDir: string, decisions: Map<string, boolean>): boolean {
	if (!hasTrustRequiringProjectResources(cwd)) return true;
	return decisions.get(cwd.toLowerCase()) ?? new ProjectTrustStore(agentDir).get(cwd) === true;
}

/** The CLI's built-in extensions (not exported as a list by the package). */
function builtInExtensions(): InlineExtension[] {
	return [
		{ name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
		{ name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
		{ name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
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
	 * With [inMemory]: begin with this session file's current branch (a side conversation, 0.4).
	 * The copy gets its own id and remembers the source as its parent; the file is only read.
	 */
	forkOf?: string;
}

/**
 * Creates a Pi session runtime the way the CLI does for RPC mode, with the
 * core's extensions and trust prompt. The returned runtime handles new/switch/
 * fork in place, recreating cwd-bound services as needed.
 */
export async function createSessionRuntime(config: PiHostConfig, slot: SlotIdentity, ui: UiBridge, target: OpenTarget): Promise<AgentSessionRuntime> {
	const sessionManager = target.inMemory
		? target.forkOf
			? SessionManager.inMemory(target.cwd, { parentSession: target.forkOf }, SessionManager.open(target.forkOf, config.sessionDir).getBranch())
			: SessionManager.inMemory(target.cwd)
		: target.sessionFile
			? SessionManager.open(target.sessionFile, config.sessionDir)
			: SessionManager.create(target.cwd, config.sessionDir);

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const needsTrust = hasTrustRequiringProjectResources(cwd);
		const stored = new ProjectTrustStore(agentDir).get(cwd);
		const cached = config.trustDecisions.get(cwd.toLowerCase());
		const mustAsk = needsTrust && cached === undefined && stored === null && !target.unattended;
		const projectTrusted = !needsTrust || (cached ?? stored === true);
		// 蝶君's sessions run in the sandbox, in standard mode; the session file remembers it.
		const sandboxed = target.sandbox === true || recordedSandbox(sessionManager);
		const mode = sandboxed ? "standard" : modeFor(sessionManager, config.newSessionMode(slot));
		if (!recordedMode(sessionManager)) sessionManager.appendCustomEntry(MODE_ENTRY, { mode });
		if (sandboxed && !recordedSandbox(sessionManager)) sessionManager.appendCustomEntry(SANDBOX_ENTRY, { sandbox: true });
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
		const harness = harnessExtension({
			mode,
			agentDir,
			resources: () => services?.resourceLoader,
			complete: (model, context, options) => services!.modelRuntime.completeSimple(model as Model<never>, context, options as never),
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
		// 蝶君 has no MCP: its servers run on this machine, outside the sandbox.
		const builtIns = mode === "minimal" ? [] : builtInExtensions().filter((e) => (e.name === "mcp" && !sandbox) || e.name === "tool-search");
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
				extensionFactories: [...builtIns, harness, ...config.extensions(slot, mode)],
				skillsOverride: dropSharedAgentSkills,
			},
		});
		const created = await createAgentSessionFromServices({
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
