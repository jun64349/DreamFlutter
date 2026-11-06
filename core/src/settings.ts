import type { Db } from "./db.ts";
import { json, parseJson } from "./db.ts";

export type ApprovalMode = "off" | "changes" | "all";

/** Agent mode of new sessions (see agent/harness.ts). */
export type AgentModeSetting = "standard" | "minimal";

/** Agent-behaviour settings owned by the core so they also apply without a UI. */
export interface CoreSettings {
	approvalMode: ApprovalMode;
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
	defaultThinking: string | null;
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
	/** Minutes an idle session stays loaded with no UI attached. */
	idleSessionMinutes: number;
	/** 蝶君's sandbox may reach the internet (never the local network); false = offline. */
	sandboxOnline: boolean;
	/** Seconds the agent's questions wait before the recommended answer is taken; 0 = wait for the user. */
	askTimeoutSeconds: number;
}

export const DEFAULT_SETTINGS: CoreSettings = {
	approvalMode: "changes",
	agentMode: "standard",
	autoCompaction: true,
	compactionThresholdPercent: 80,
	backgroundCompaction: "auto",
	backgroundCompactionModel: "session",
	backgroundCompactionLeadPercent: 85,
	defaultModel: null,
	defaultThinking: null,
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
	autoTitle: true,
	dailyBudgetUsd: 0,
	monthlyBudgetUsd: 0,
	maxTurnsPerRun: 60,
	maxTurnsUnattended: 40,
	notifications: true,
	idleSessionMinutes: 10,
	askTimeoutSeconds: 60,
	sandboxOnline: true,
};

type Listener = (settings: CoreSettings, changed: (keyof CoreSettings)[]) => void;

export class SettingsStore {
	private readonly db: Db;
	private cache: CoreSettings;
	private readonly listeners = new Set<Listener>();

	constructor(db: Db) {
		this.db = db;
		this.cache = this.load();
	}

	get(): CoreSettings {
		return this.cache;
	}

	/** Applies the known keys of [patch]; unknown keys and wrong types are ignored. */
	update(patch: Record<string, unknown>): CoreSettings {
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
