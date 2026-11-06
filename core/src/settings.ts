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
	/** Tokens of long-term memory injected at task start. */
	memoryBudgetTokens: number;
	/** 「写入前要我确认」: memory changes the agents make wait for the user (docs/memory-design.md §4); off = they take effect and go in the memory log. */
	memoryConfirmWrites: boolean;
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
	defaultModel: null,
	defaultThinking: null,
	auxModel: null,
	visionModel: null,
	fallbackModels: [],
	memoryEnabled: true,
	memoryAutoExtract: true,
	memoryBudgetTokens: 2000,
	memoryConfirmWrites: false,
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
		case "approvalMode":
			return value === "off" || value === "changes" || value === "all";
		case "agentMode":
			return value === "standard" || value === "minimal";
		case "memoryBudgetTokens":
		case "maxTurnsUnattended":
		case "idleSessionMinutes":
			return Number.isInteger(value) && (value as number) > 0;
		case "maxTurnsPerRun":
		case "askTimeoutSeconds":
			return Number.isInteger(value) && (value as number) >= 0;
		case "dailyBudgetUsd":
		case "monthlyBudgetUsd":
			return (value as number) >= 0;
		default:
			return true;
	}
}
