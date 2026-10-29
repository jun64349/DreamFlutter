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
import { DISTRUST_ONCE, DISTRUST_REMEMBER, TRUST_ONCE, TRUST_REMEMBER, TRUST_TITLE } from "./dialogs.ts";
import type { UiBridge } from "./ui-bridge.ts";

/** Fixed inputs shared by every session the core hosts. */
export interface PiHostConfig {
	agentDir: string;
	/** Overrides Pi's session directory (tests); undefined = Pi's default. */
	sessionDir?: string;
	/** Core extensions loaded into every session, after Pi's built-ins. */
	extensions: (slot: SlotIdentity) => ExtensionFactory[];
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
}

/**
 * Creates a Pi session runtime the way the CLI does for RPC mode, with the
 * core's extensions and trust prompt. The returned runtime handles new/switch/
 * fork in place, recreating cwd-bound services as needed.
 */
export async function createSessionRuntime(config: PiHostConfig, slot: SlotIdentity, ui: UiBridge, target: OpenTarget): Promise<AgentSessionRuntime> {
	const sessionManager = target.inMemory
		? SessionManager.inMemory(target.cwd)
		: target.sessionFile
			? SessionManager.open(target.sessionFile, config.sessionDir)
			: SessionManager.create(target.cwd, config.sessionDir);

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const needsTrust = hasTrustRequiringProjectResources(cwd);
		const stored = new ProjectTrustStore(agentDir).get(cwd);
		const cached = config.trustDecisions.get(cwd.toLowerCase());
		const mustAsk = needsTrust && cached === undefined && stored === null && !target.unattended;
		const projectTrusted = !needsTrust || (cached ?? stored === true);
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: mustAsk ? false : projectTrusted });
		const services = await createAgentSessionServices({
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
				extensionFactories: [...builtInExtensions(), ...config.extensions(slot)],
			},
		});
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
		return { ...created, services, diagnostics: [...services.diagnostics] };
	};

	return createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir: config.agentDir,
		sessionManager,
	});
}
