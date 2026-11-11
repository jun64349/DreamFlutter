import type { Db } from "./db.ts";
import { json, parseJson } from "./db.ts";

export type ApprovalMode = "off" | "changes" | "all";

/** Agent mode of new sessions (see agent/harness.ts). */
export type AgentModeSetting = "standard" | "minimal";
export type ModelPurpose = "title" | "memory" | "compaction" | "analysis";
export type ModelOverrides = Partial<Record<ModelPurpose, string | null>>;
export interface GoalDefaultBudget {
	costUsd: number;
	activeMinutes: number;
	runs: number;
	concurrency: number;
}
const patrolCheckKeys = ["failed", "goal_stuck", "stale_attention", "upcoming", "health", "watch"] as const;
export type PatrolChecks = Record<(typeof patrolCheckKeys)[number], boolean>;

/** Agent-behaviour settings owned by the core so they also apply without a UI. */
export interface CoreSettings {
	autoCheckUpdates: boolean;
	startOnLogin: boolean;
	closeBehavior: "tray" | "quit";
	/** Package indexes apply only to tool child processes; inherit changes nothing. */
	pythonPackageSource: "inherit" | "pypi" | "tuna" | "ustc";
	npmPackageSource: "inherit" | "npm" | "npmmirror";
	/** Separate web-tool setting, unrelated to model channels. */
	webFetchBackend: "local" | "deepseek";
	approvalMode: ApprovalMode;
	/** Canonical path exceptions explicitly chosen by the user, per workspace. */
	securityPathExceptions: Record<string, string[]>;
	/** Mode new sessions start in. */
	agentMode: AgentModeSetting;
	autoCompaction: boolean;
	/** Compaction threshold as a percentage of the model's context window (roadmap 5.12); a session can set its own. Never above dsh's safe threshold. */
	compactionThresholdPercent: number;
	/**
	 * Background compaction (roadmap 5.12): auto = on in 蝶君 and scheduled (long-task) sessions, off in 工作台's
	 * ordinary conversations until measured; on / off for every session. A session can set its own.
	 */
	backgroundCompaction: "auto" | "on" | "off";
	/** Who writes the background summary: the session's own model (summary quality matters; user 2026-11-07) or the cheaper auxiliary one. */
	backgroundCompactionModel: "session" | "aux";
	/** Share of the threshold at which the background summary is written, in percent (user 2026-11-07: 85, to be tuned on our own tests). */
	backgroundCompactionLeadPercent: number;
	/** provider/id the UI preselects for new sessions; null lets Pi decide. */
	defaultModel: string | null;
	smallTaskModel: string | null;
	largeTaskModel: string | null;
	/** Advanced purpose overrides; compaction also accepts session/small. */
	modelOverrides: ModelOverrides;
	butterflyStartWaitSeconds: 0 | 10 | 60;
	firstSetupComplete: boolean;
	userName: string;
	defaultWorkspace: string | null;
	sandboxSetupChoice: "now" | "later";
	defaultThinking: string | null;
	/** Per-model context window overrides, keyed by provider/id. */
	modelContextWindows: Record<string, number>;
	/** The models of a channel that model lists show, keyed by channel id (0.8.3). Absent = the channel's default. */
	commonModels: Record<string, string[]>;
	/** Cheap model for titles, memory extraction and summaries; null = session model. */
	auxModel: string | null;
	/** Model (or model group) that describes images for models without vision; null = pick one that can see. */
	visionModel: string | null;
	/** Ordered provider/id list tried when the primary model fails. */
	fallbackModels: string[];
	memoryEnabled: boolean;
	memoryAutoExtract: boolean;
	memoryDetail: "brief" | "standard" | "detailed";
	memoryWriteFrequency: "standard" | "low";
	/** Tokens of long-term memory injected at task start. */
	memoryBudgetTokens: number;
	/** 「写入前要我确认」: memory changes the agents make wait for the user (docs/memory-design.md §4); off = they take effect and go in the memory log. */
	memoryConfirmWrites: boolean;
	/** Model the memory agent uses (provider/id or a model group); null = the auxiliary model (memory-design §5). */
	memoryModel: string | null;
	/** USD the memory agent may spend a day on ordinary work; 0 = none (memory-design §7). */
	memoryDailyBudgetUsd: number;
	/** 「暂停整理」: the memory agent's ordinary work waits; snapshots are still used. */
	memoryPaused: boolean;
	/** Active capacity of one partition (global, each workspace, 蝶君): tokens of the text of active and 「待复核」 items (memory-design §12 item 4). */
	memoryCapacityTokens: number;
	/** G-07: physical free-space threshold; memory writes resume automatically above it. */
	memoryMinFreeBytes: number;
	autoTitle: boolean;
	/** Daily spending cap for all runs, in USD; 0 = no cap. */
	dailyBudgetUsd: number;
	/** Monthly spending cap for all runs, in USD; 0 = no cap. */
	monthlyBudgetUsd: number;
	/** Turn cap for one run started from a window; 0 = no cap. */
	maxTurnsPerRun: number;
	/** Turn cap for one unattended run. */
	maxTurnsUnattended: number;
	notifications: boolean;
	scheduleMissedDefault: "skip" | "latest";
	goalDefaultBudget: GoalDefaultBudget;
	goalButterflyBudgetFactor: number;
	goalReviewModel: string | null;
	goalProposalEnabled: boolean;
	/** Minutes an idle session stays loaded with no UI attached. */
	idleSessionMinutes: number;
	/** 蝶君's sandbox may reach the internet (never the local network); false = offline. */
	sandboxOnline: boolean;
	/** Seconds the agent's questions wait before the recommended answer is taken; 0 = wait for the user. */
	askTimeoutSeconds: number;
	patrolEnabled: boolean;
	patrolIntervalMin: 10 | 15 | 30 | 60;
	patrolQuietEnabled: boolean;
	patrolQuietStart: string;
	patrolQuietEnd: string;
	patrolModel: string | null;
	patrolDailyBudget: number;
	patrolStaleHours: number;
	patrolKeepDays: number;
	patrolChecks: PatrolChecks;
}

export const DEFAULT_SETTINGS: CoreSettings = {
	autoCheckUpdates: true,
	startOnLogin: false,
	closeBehavior: "tray",
	pythonPackageSource: "inherit",
	npmPackageSource: "inherit",
	webFetchBackend: "local",
	approvalMode: "changes",
	securityPathExceptions: {},
	agentMode: "standard",
	autoCompaction: true,
	compactionThresholdPercent: 80,
	backgroundCompaction: "auto",
	backgroundCompactionModel: "session",
	backgroundCompactionLeadPercent: 85,
	defaultModel: null,
	smallTaskModel: null,
	largeTaskModel: null,
	modelOverrides: {},
	butterflyStartWaitSeconds: 60,
	firstSetupComplete: false,
	userName: "",
	defaultWorkspace: null,
	sandboxSetupChoice: "later",
	defaultThinking: null,
	modelContextWindows: {},
	commonModels: {},
	auxModel: null,
	visionModel: null,
	fallbackModels: [],
	memoryEnabled: true,
	memoryAutoExtract: true,
	memoryDetail: "standard",
	memoryWriteFrequency: "standard",
	memoryBudgetTokens: 2000,
	memoryConfirmWrites: false,
	memoryModel: null,
	memoryDailyBudgetUsd: 0.2,
	memoryPaused: false,
	memoryCapacityTokens: 40_000,
	memoryMinFreeBytes: 1024 ** 3,
	autoTitle: true,
	dailyBudgetUsd: 0,
	monthlyBudgetUsd: 0,
	maxTurnsPerRun: 60,
	maxTurnsUnattended: 40,
	notifications: true,
	scheduleMissedDefault: "skip",
	goalDefaultBudget: { costUsd: 2, activeMinutes: 120, runs: 30, concurrency: 2 },
	goalButterflyBudgetFactor: 0.5,
	goalReviewModel: null,
	goalProposalEnabled: true,
	idleSessionMinutes: 10,
	askTimeoutSeconds: 60,
	patrolEnabled: true,
	patrolIntervalMin: 30,
	patrolQuietEnabled: true,
	patrolQuietStart: "23:00",
	patrolQuietEnd: "07:00",
	patrolModel: null,
	patrolDailyBudget: 0.5,
	patrolStaleHours: 4,
	patrolKeepDays: 30,
	patrolChecks: { failed: true, goal_stuck: true, stale_attention: true, upcoming: true, health: true, watch: true },
	sandboxOnline: true,
};

type Listener = (settings: CoreSettings, changed: (keyof CoreSettings)[]) => void;

export class SettingsStore {
	private readonly db: Db;
	private cache: CoreSettings;
	private readonly listeners = new Set<Listener>();

	constructor(db: Db) {
		this.db = db;
		this.migrateModelRoles();
		this.cache = this.load();
	}

	/** Idempotent settings migration, deliberately independent of schema numbering. */
	private migrateModelRoles(): void {
		if (this.db.get("SELECT key FROM app_flags WHERE key='model_roles_v1'")) return;
		const rows = this.db.all<{key: string; value: string}>("SELECT key,value FROM settings");
		const old = Object.fromEntries(rows.map(r => [r.key, parseJson<unknown>(r.value, null)]));
		const overrides: ModelOverrides = {};
		if (typeof old.memoryModel === "string") overrides.memory = old.memoryModel;
		// Old installations implicitly compacted with each session's own model.
		if (rows.length) overrides.compaction = old.backgroundCompactionModel === "aux" ? "small" : "session";
		this.db.transaction(() => {
			for (const [key, value] of Object.entries({ smallTaskModel: typeof old.auxModel === "string" ? old.auxModel : null, largeTaskModel: null, modelOverrides: overrides })) {
				this.db.run("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", key, json(value));
			}
			if (rows.length) this.db.run("INSERT OR IGNORE INTO settings(key,value) VALUES('firstSetupComplete','true')");
			this.db.run("INSERT INTO app_flags(key,value,at) VALUES('model_roles_v1','1',?)", Date.now());
		});
	}

	get(): CoreSettings {
		return this.cache;
	}

	/** Applies the known keys of [patch]; unknown keys and wrong types are ignored. */
	update(patch: Record<string, unknown>): CoreSettings {
		// Keep old windows/clients functional during the UI transition.
		patch = { ...patch };
		if ("auxModel" in patch && !("smallTaskModel" in patch)) patch.smallTaskModel = patch.auxModel;
		if (!("modelOverrides" in patch)) {
			const overrides = { ...this.cache.modelOverrides };
			if ("memoryModel" in patch && (patch.memoryModel === null || typeof patch.memoryModel === "string")) overrides.memory = patch.memoryModel;
			if (patch.backgroundCompactionModel === "aux" || patch.backgroundCompactionModel === "session") overrides.compaction = patch.backgroundCompactionModel === "aux" ? "small" : "session";
			if (JSON.stringify(overrides) !== JSON.stringify(this.cache.modelOverrides)) patch.modelOverrides = overrides;
		}
		const changed: (keyof CoreSettings)[] = [];
		const next = { ...this.cache } as Record<string, unknown>;
		for (const [key, value] of Object.entries(patch)) {
			if (!(key in DEFAULT_SETTINGS)) continue;
			const k = key as keyof CoreSettings;
			if (!sameType(DEFAULT_SETTINGS[k], value) || !valid(k, value)) continue;
			if (JSON.stringify(next[key]) === JSON.stringify(value)) continue;
			next[key] = value;
			changed.push(k);
		}
		if (changed.length === 0) return this.cache;
		this.db.transaction(() => {
			for (const key of changed) {
				this.db.run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, json(next[key]));
			}
		});
		this.cache = next as unknown as CoreSettings;
		for (const listener of this.listeners) listener(this.cache, changed);
		return this.cache;
	}

	onChange(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Refresh only after a larger owner transaction has committed its setting references. */
	reloadFromDb(): void {
		const previous = this.cache;
		this.cache = this.load();
		const changed = (Object.keys(DEFAULT_SETTINGS) as (keyof CoreSettings)[]).filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(this.cache[key]));
		if (changed.length) for (const listener of this.listeners) listener(this.cache, changed);
	}

	private load(): CoreSettings {
		const settings = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
		for (const row of this.db.all<{ key: string; value: string }>("SELECT key, value FROM settings")) {
			if (!(row.key in DEFAULT_SETTINGS)) continue;
			const value = parseJson<unknown>(row.value, undefined);
			const k = row.key as keyof CoreSettings;
			if (sameType(DEFAULT_SETTINGS[k], value) && valid(k, value)) settings[row.key] = value;
		}
		return settings as unknown as CoreSettings;
	}
}

function sameType(reference: unknown, value: unknown): boolean {
	if (reference === null) return value === null || typeof value === "string";
	if (Array.isArray(reference)) return Array.isArray(value) && value.every((v) => typeof v === "string");
	return typeof reference === typeof value;
}

function valid(key: keyof CoreSettings, value: unknown): boolean {
	switch (key) {
		case "scheduleMissedDefault": return value === "skip" || value === "latest";
		case "goalDefaultBudget": {
			if (!value || typeof value !== "object" || Array.isArray(value)) return false;
			const { costUsd, activeMinutes, runs, concurrency } = value as Partial<GoalDefaultBudget>;
			return typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0
				&& typeof activeMinutes === "number" && Number.isSafeInteger(activeMinutes * 60_000) && activeMinutes > 0
				&& typeof runs === "number" && Number.isSafeInteger(runs) && runs > 0
				&& typeof concurrency === "number" && Number.isSafeInteger(concurrency) && concurrency > 0;
		}
		case "goalButterflyBudgetFactor": return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
		case "goalReviewModel": return value === null || typeof value === "string" && /^[^/]+\/.+$/.test(value);
		case "goalProposalEnabled": return typeof value === "boolean";
		case "patrolIntervalMin": return value === 10 || value === 15 || value === 30 || value === 60;
		case "patrolQuietStart":
		case "patrolQuietEnd": return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
		case "patrolModel": return value === null || typeof value === "string" && /^[^/]+\/.+$/.test(value);
		case "patrolDailyBudget": return typeof value === "number" && Number.isFinite(value) && value >= 0;
		case "patrolStaleHours": return typeof value === "number" && Number.isFinite(value) && value > 0;
		case "patrolKeepDays": return Number.isSafeInteger(value) && (value as number) > 0;
		case "patrolChecks":
			return value !== null && typeof value === "object" && !Array.isArray(value) &&
				Object.keys(value).length === patrolCheckKeys.length &&
				patrolCheckKeys.every(check => typeof (value as Record<string, unknown>)[check] === "boolean");
		case "modelOverrides":
			return value !== null && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([purpose, ref]) =>
				["title", "memory", "compaction", "analysis"].includes(purpose) && (ref === null || typeof ref === "string" && (ref.includes("/") || purpose === "compaction" && ["session", "small"].includes(ref))));
		case "butterflyStartWaitSeconds": return value === 0 || value === 10 || value === 60;
		case "sandboxSetupChoice": return value === "now" || value === "later";
		case "closeBehavior":
			return value === "tray" || value === "quit";
		case "pythonPackageSource":
			return value === "inherit" || value === "pypi" || value === "tuna" || value === "ustc";
		case "npmPackageSource":
			return value === "inherit" || value === "npm" || value === "npmmirror";
		case "webFetchBackend":
			return value === "local" || value === "deepseek";
		case "securityPathExceptions":
			return value !== null && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([cwd, paths]) => cwd.trim().length > 0 && Array.isArray(paths) && paths.every((path) => typeof path === "string" && path.trim().length > 0));
		case "commonModels":
			return value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string" && id.length > 0));
		case "modelContextWindows":
			return value !== null && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([id, window]) => id.indexOf("/") > 0 && !id.endsWith("/") && Number.isSafeInteger(window) && window > 0);
		case "memoryDetail":
			return value === "brief" || value === "standard" || value === "detailed";
		case "memoryWriteFrequency":
			return value === "standard" || value === "low";
		case "approvalMode":
			return value === "off" || value === "changes" || value === "all";
		case "agentMode":
			return value === "standard" || value === "minimal";
		case "compactionThresholdPercent":
			return Number.isInteger(value) && (value as number) >= 20 && (value as number) <= 95;
		case "backgroundCompactionLeadPercent":
			return Number.isInteger(value) && (value as number) >= 50 && (value as number) <= 99;
		case "backgroundCompaction":
			return value === "auto" || value === "on" || value === "off";
		case "backgroundCompactionModel":
			return value === "session" || value === "aux";
		case "memoryBudgetTokens":
		case "maxTurnsUnattended":
		case "idleSessionMinutes":
		case "memoryCapacityTokens":
			return Number.isInteger(value) && (value as number) > 0;
		case "memoryMinFreeBytes":
			return Number.isSafeInteger(value) && (value as number) >= 0;
		case "maxTurnsPerRun":
		case "askTimeoutSeconds":
			return Number.isInteger(value) && (value as number) >= 0;
		case "dailyBudgetUsd":
		case "memoryDailyBudgetUsd":
		case "monthlyBudgetUsd":
			return (value as number) >= 0;
		default:
			return true;
	}
}

/** null means inherit the session, then the conversation default. */
export function purposeModel(settings: CoreSettings, purpose: ModelPurpose): string | null {
	const override = settings.modelOverrides[purpose];
	if (override === "session" && purpose === "compaction") return null;
	if (override === "small" && purpose === "compaction") return settings.smallTaskModel;
	if (override) return override;
	return purpose === "compaction" || purpose === "analysis" ? settings.largeTaskModel : settings.smallTaskModel;
}
