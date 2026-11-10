import { randomUUID } from "node:crypto";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CompactionHooks, CompactionRecord } from "../agent/background-compaction.ts";
import { dshCompactionSettings } from "../agent/harness.ts";
import type { Core, CoreModule, Params } from "../core.ts";
import { num, RpcError, requireStr, str } from "../core.ts";
import type { Db } from "../db.ts";
import { textOf } from "../runs.ts";
import type { Slot } from "../slots/slot.ts";
import type { Llm } from "./llm.ts";
import { MemoryModule } from "./memory.ts";

/**
 * The context service (roadmap 5.12): a session's compaction threshold (a
 * percentage of the window, global default + per session), background
 * compaction (who writes the candidate, when, on whose bill), a record of
 * every compaction for comparing normal and background ones, checkpoints the
 * user can read the original of, report as wrong and have written again,
 * and a 「上下文可用」 event after a compaction (it never wakes the session:
 * continuing is the 0.8 scheduler's call).
 */
export class ContextModule implements CoreModule {
	private readonly core: Core;
	private readonly db: Db;
	private readonly llm: Llm;
	/** slot id → the user's note for the next compaction there (「重新生成」). */
	private readonly regenerate = new Map<string, { note: string; checkpoint?: { summary: string; firstKeptEntryId: string } }>();
	private readonly regenerationSource = new Map<string, "original" | "previous_summary">();
	private readonly regenerationErrors = new Map<string, unknown>();
	private readonly summaryWriters = new Map<string, string>();

	constructor(core: Core, llm: Llm) {
		this.core = core;
		this.db = core.db;
		this.llm = llm;
		core.declareBackup({
			id: "context",
			title: "上下文与压缩",
			tables: ["context_sessions", "context_compactions", "context_reports"],
			paths: { context_compactions: { session_file: "path" }, context_reports: { session_file: "path" } },
		});
		core.compactionHooks = (identity) => {
			const slot = core.slots.get(identity.slotId);
			return slot ? this.hooks(slot) : undefined;
		};
		this.register();
	}

	// ---- a session's settings --------------------------------------------------------------

	private sessionRow(sessionId: string): { threshold_percent: number | null; background: number | null } | undefined {
		return this.db.get("SELECT threshold_percent, background FROM context_sessions WHERE session_id = ?", sessionId);
	}

	/** The session's compaction threshold in percent of the window. */
	thresholdPercent(sessionId: string | undefined): number {
		const own = sessionId ? this.sessionRow(sessionId)?.threshold_percent : null;
		return own ?? this.core.settings.get().compactionThresholdPercent;
	}

	/** Whether background compaction is on for [slot]: the session's own choice, else the setting (auto = 蝶君 and scheduled sessions). */
	backgroundOn(slot: Slot): boolean {
		if (slot.incognito) return false;
		const own = slot.started ? this.sessionRow(slot.session.sessionId)?.background : null;
		if (own !== null && own !== undefined) return own === 1;
		const setting = this.core.settings.get().backgroundCompaction;
		if (setting === "auto") return slot.sandboxed || slot.unattended;
		return setting === "on";
	}

	/** Pi's settings with the session's threshold: reserve = window − threshold, never less than dsh's own reserve. */
	settingsFor(sessionId: string | undefined, model: { contextWindow: number; maxTokens: number } | undefined, base: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }) {
		if (!model?.contextWindow) return base;
		const threshold = Math.floor((model.contextWindow * this.thresholdPercent(sessionId)) / 100);
		const reserveTokens = Math.max(base.reserveTokens, model.contextWindow - threshold);
		// A lower threshold keeps less recent history too, or a compaction would hardly free anything.
		const keepRecentTokens = Math.max(1, Math.min(base.keepRecentTokens, Math.floor((model.contextWindow - reserveTokens) * 0.4)));
		return { ...base, reserveTokens, keepRecentTokens };
	}

	private hooks(slot: Slot): CompactionHooks {
		const sessionId = () => (slot.started ? slot.session.sessionId : undefined);
		const writer: NonNullable<CompactionHooks["summaryModel"]> = async sessionModel => {
			if (this.core.settings.get().modelOverrides.compaction === "session") return sessionModel;
			return (await this.llm.modelFor("compaction", undefined, `${sessionModel.provider}/${sessionModel.id}`)) ?? sessionModel;
		};
		return {
			summaryModel: writer,
			invalidatedFacts: () => slot.incognito || slot.isSideConversation ? "" : this.core.module(MemoryModule)?.compactionExclusions(slot.cwd, sessionId()) ?? "",
			regenerated: source => this.regenerationSource.set(slot.slotId, source),
			regenerateFailed: error => this.regenerationErrors.set(slot.slotId, error),
			settings: (model, base) => this.settingsFor(sessionId(), model, base),
			background: {
				enabled: () => this.core.settings.get().autoCompaction && this.backgroundOn(slot),
				lead: () => this.core.settings.get().backgroundCompactionLeadPercent / 100,
				model: writer,
				allowed: () => this.budgetLeft(),
				charge: (usage, model) => this.charge(slot, usage, model),
			},
			record: (entry) => this.record(slot, entry),
			takeRegenerate: () => {
				const note = this.regenerate.get(slot.slotId);
				this.regenerate.delete(slot.slotId);
				return note;
			},
		};
	}

	// ---- money ---------------------------------------------------------------------------------

	/** The main task's daily and monthly budgets are not spent (user 2026-11-07: the candidate is the main task's spending). */
	budgetLeft(): boolean {
		const settings = this.core.settings.get();
		const day = new Date();
		day.setHours(0, 0, 0, 0);
		if (settings.dailyBudgetUsd > 0 && this.core.runs.costSince(day.getTime()) >= settings.dailyBudgetUsd) return false;
		const month = new Date(day.getFullYear(), day.getMonth(), 1).getTime();
		if (settings.monthlyBudgetUsd > 0 && this.core.runs.costSince(month) >= settings.monthlyBudgetUsd) return false;
		return true;
	}

	/** A candidate is paid for whether it is used or not: on the run going on, and in the session file (so the dashboard counts it). */
	private charge(slot: Slot, usage: Usage, model: Model<never>): void {
		this.account(slot, usage, "background_compaction", `${model.provider}/${model.id}`);
		try {
			if (slot.started) slot.session.sessionManager.appendUsage("background_compaction", model.provider, model.id, usage, "后台压缩候选");
		} catch (error) {
			this.core.log.warn("context: could not record the background summary's usage in the session", error);
		}
	}

	private account(slot: Slot, usage: Usage, kind: "background_compaction" | "compaction", model: string | null): void {
		const u = { input:usage.input ?? 0, output:usage.output ?? 0, cacheRead:usage.cacheRead ?? 0, cacheWrite:usage.cacheWrite ?? 0, cost:usage.cost?.total ?? 0 };
		if (slot.currentRun) slot.absorbSubagent(u, []);
		else this.core.runs.recordCompaction({slotId:slot.slotId,sessionId:slot.info().sessionId,sessionFile:slot.info().sessionFile,cwd:slot.cwd,model,kind,usage:u});
	}

	// ---- records --------------------------------------------------------------------------------

	private record(slot: Slot, entry: CompactionRecord): void {
		if (["normal", "manual", "regenerate"].includes(entry.kind) && entry.outcome === "done" && entry.model) this.summaryWriters.set(slot.slotId, entry.model);
		const id = `cc_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
		const session = slot.started ? slot.session : undefined;
		this.db.run(
			"INSERT INTO context_compactions(id, session_id, session_file, at, kind, outcome, reason, wait_ms, tokens_before, tokens_after, cost, model) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id,
			session?.sessionId ?? slot.slotId,
			session?.sessionFile ?? null,
			Date.now(),
			entry.kind,
			entry.outcome,
			entry.reason ?? null,
			entry.waitMs ?? null,
			entry.tokensBefore ?? null,
			entry.tokensAfter ?? null,
			entry.cost ?? 0,
			entry.model ?? null,
		);
		this.core.broadcast({ event: "context.compaction", slotId: slot.slotId, sessionId: session?.sessionId ?? null, ...entry });
	}

	/**
	 * After a compaction: 「上下文可用」 for whoever waits on it (it does not
	 * start a turn: 16.7), and a normal summary's cost counted on the run.
	 */
	onSlotEvent(slot: Slot, event: AgentSessionEvent): void {
		if (event.type !== "compaction_end") return;
		const usage = event.result?.usage;
		if (usage) this.account(slot, usage, "compaction", this.summaryWriters.get(slot.slotId) ?? (slot.session.model ? `${slot.session.model.provider}/${slot.session.model.id}` : null));
		this.summaryWriters.delete(slot.slotId);
		if (event.result && !event.aborted) {
			this.core.broadcast({ event: "context.available", slotId: slot.slotId, sessionId: slot.started ? slot.session.sessionId : null, reason: event.reason, tokensBefore: event.result.tokensBefore });
		}
	}

	/** Normal and background compactions side by side (roadmap 5.12: decide the default from these). */
	stats(filter: { since?: number } = {}): Record<string, unknown> {
		const rows = this.db.all<{ kind: string; outcome: string; reason: string | null; wait_ms: number | null; cost: number }>("SELECT kind, outcome, reason, wait_ms, cost FROM context_compactions WHERE at >= ?", filter.since ?? 0);
		const waits = (pick: (r: (typeof rows)[number]) => boolean) => {
			const list = rows.filter(pick).map((r) => r.wait_ms ?? 0).sort((a, b) => a - b);
			const at = (q: number) => (list.length ? list[Math.min(list.length - 1, Math.floor(q * list.length))]! : null);
			return { count: list.length, p50: at(0.5), p95: at(0.95) };
		};
		const background = rows.filter((r) => r.kind === "background");
		const made = background.filter((r) => r.outcome === "made").length;
		const used = background.filter((r) => r.outcome === "used").length;
		const dropped: Record<string, number> = {};
		for (const r of background.filter((r) => r.outcome === "dropped" || r.outcome === "failed")) dropped[r.reason ?? r.outcome] = (dropped[r.reason ?? r.outcome] ?? 0) + 1;
		return {
			normal: { ...waits((r) => r.kind === "normal" && r.outcome === "done"), cost: rows.filter((r) => r.kind === "normal").reduce((s, r) => s + r.cost, 0) },
			background: { ...waits((r) => r.kind === "background" && r.outcome === "used"), made, used, useRate: made ? used / made : null, dropped, cost: background.reduce((s, r) => s + r.cost, 0) },
		};
	}

	// ---- checkpoints --------------------------------------------------------------------------------

	private slotOf(p: Params): Slot {
		const slot = this.core.slot(p.slotId);
		if (!slot.started) throw new RpcError("bad_request", "会话还在启动中");
		return slot;
	}

	/** The compactions on the session's current branch, oldest first, with the ones the user reported. */
	checkpoints(slot: Slot): { entryId: string; summary: string; firstKeptEntryId: string; tokensBefore: number; at: string; reported: boolean }[] {
		const reported = new Set(this.db.all<{ entry_id: string }>("SELECT entry_id FROM context_reports WHERE session_id = ? AND resolved_at IS NULL", slot.session.sessionId).map((r) => r.entry_id));
		return (slot.session.sessionManager.getBranch() as SessionEntry[])
			.filter((e) => e.type === "compaction")
			.map((e) => {
				const c = e as SessionEntry & { summary: string; firstKeptEntryId: string; tokensBefore: number; timestamp: string };
				return { entryId: c.id, summary: c.summary, firstKeptEntryId: c.firstKeptEntryId, tokensBefore: c.tokensBefore, at: c.timestamp, reported: reported.has(c.id) };
			});
	}

	/** 「看原文」: the messages a checkpoint stands for (between the previous checkpoint's kept part and its own). */
	original(slot: Slot, entryId: string): { entryId: string; role: string; text: string }[] {
		const branch = slot.session.sessionManager.getBranch() as SessionEntry[];
		const index = branch.findIndex((e) => e.id === entryId && e.type === "compaction");
		if (index < 0) throw new RpcError("not_found", "没有这个压缩检查点");
		const own = branch[index] as SessionEntry & { firstKeptEntryId: string };
		let start = 0;
		for (let i = index - 1; i >= 0; i--) {
			if (branch[i]!.type === "compaction") {
				const kept = branch.findIndex((e) => e.id === (branch[i] as SessionEntry & { firstKeptEntryId: string }).firstKeptEntryId);
				start = kept >= 0 ? kept : i + 1;
				break;
			}
		}
		const end = branch.findIndex((e) => e.id === own.firstKeptEntryId);
		return branch.slice(start, end < 0 ? index : end).flatMap((e) => {
			if (e.type !== "message") return [];
			const message = (e as SessionEntry & { message: { role: string; content: unknown } }).message;
			const text = textOf(message.content);
			return text ? [{ entryId: e.id, role: message.role, text }] : [];
		});
	}

	private register(): void {
		const core = this.core;
		core.register("context.info", async (p) => {
			const slot = this.slotOf(p);
			await slot.refreshModelConfig();
			const session = slot.session;
			const model = session.model as { contextWindow?: number; maxTokens?: number; provider?: string; id?: string } | undefined;
			const usage = slot.contextUsage();
			const window = session.model ? core.modelWindow(session.model) : null;
			const settings = window ? this.settingsFor(session.sessionId, { contextWindow: window, maxTokens: model?.maxTokens ?? 0 }, dshCompactionSettings({ contextWindow: window, maxTokens: model?.maxTokens ?? 0 }, true)) : null;
			const last = this.db.get<{ kind: string; outcome: string; reason: string | null; at: number }>("SELECT kind, outcome, reason, at FROM context_compactions WHERE session_id = ? AND kind = 'background' ORDER BY at DESC, rowid DESC LIMIT 1", session.sessionId);
			return {
				usage,
				contextWindow: window,
				thresholdPercent: this.thresholdPercent(session.sessionId),
				thresholdTokens: window && settings ? window - settings.reserveTokens : null,
				ownThreshold: this.sessionRow(session.sessionId)?.threshold_percent ?? null,
				autoCompaction: core.settings.get().autoCompaction,
				background: { on: this.backgroundOn(slot), ownChoice: this.sessionRow(session.sessionId)?.background ?? null, model: core.settings.get().backgroundCompactionModel, leadPercent: core.settings.get().backgroundCompactionLeadPercent, last: last ?? null },
				compacting: slot.compacting,
				checkpoints: this.checkpoints(slot).length,
			};
		});
		core.register("context.setSession", (p) => {
			const sessionId = str(p.sessionId) ?? this.slotOf(p).session.sessionId;
			const row = this.sessionRow(sessionId) ?? { threshold_percent: null, background: null };
			let threshold = row.threshold_percent;
			let background = row.background;
			if (p.thresholdPercent === null) threshold = null;
			else if (p.thresholdPercent !== undefined) {
				const value = num(p.thresholdPercent);
				if (value === undefined || !Number.isInteger(value) || value < 20 || value > 95) throw new RpcError("bad_request", "压缩阈值是 20–95 之间的整数（上下文窗口的百分比）");
				threshold = value;
			}
			if (p.background === null) background = null;
			else if (typeof p.background === "boolean") background = p.background ? 1 : 0;
			if (threshold === null && background === null) this.db.run("DELETE FROM context_sessions WHERE session_id = ?", sessionId);
			else this.db.run("INSERT OR REPLACE INTO context_sessions(session_id, threshold_percent, background, updated_at) VALUES(?, ?, ?, ?)", sessionId, threshold, background, Date.now());
			return { thresholdPercent: threshold, background: background === null ? null : background === 1 };
		});
		core.register("context.compactNow", async (p) => {
			const slot = this.slotOf(p);
			if (slot.compacting) throw new RpcError("bad_request", "正在压缩");
			return (await slot.compactNow(str(p.focus))) ?? null;
		});
		core.register("context.checkpoints", (p) => this.checkpoints(this.slotOf(p)));
		core.register("context.original", (p) => this.original(this.slotOf(p), requireStr(p.entryId, "entryId")));
		core.register("context.report", (p) => {
			const slot = this.slotOf(p);
			const entryId = requireStr(p.entryId, "entryId");
			if (!this.checkpoints(slot).some((c) => c.entryId === entryId)) throw new RpcError("not_found", "没有这个压缩检查点");
			const id = `cr_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
			this.db.run("INSERT INTO context_reports(id, session_id, session_file, entry_id, note, at) VALUES(?, ?, ?, ?, ?, ?)", id, slot.session.sessionId, slot.session.sessionFile ?? null, entryId, str(p.note) ?? null, Date.now());
			return { id };
		});
		// 「重新生成」: a new checkpoint written from the original messages, with what the user said was wrong.
		core.register("context.regenerate", async (p) => {
			const slot = this.slotOf(p);
			if (slot.compacting) throw new RpcError("bad_request", "正在压缩");
			const latest = this.checkpoints(slot).at(-1);
			if (!latest || (p.entryId !== undefined && p.entryId !== latest.entryId)) throw new RpcError("bad_request", "只能重新生成当前分支最新的压缩检查点");
			const note = str(p.note) ?? this.db.get<{ note: string | null }>("SELECT note FROM context_reports WHERE session_id = ? AND resolved_at IS NULL ORDER BY at DESC LIMIT 1", slot.session.sessionId)?.note ?? "摘要有误";
			// Keep the summary for the documented long-original fallback before
			// the immediate-regeneration path moves to the checkpoint's parent.
			const atCheckpoint = slot.session.sessionManager.getLeafId() === latest.entryId;
			this.regenerate.set(slot.slotId, { note, checkpoint: atCheckpoint ? latest : undefined });
			try {
				const result = await slot.compactNow(str(p.focus), latest.entryId);
				if (!result) return null;
				this.db.run("UPDATE context_reports SET resolved_at = ? WHERE session_id = ? AND entry_id = ? AND resolved_at IS NULL", Date.now(), slot.session.sessionId, latest.entryId);
				return { ...result, source: this.regenerationSource.get(slot.slotId) };
			} catch (error) {
				throw this.regenerationErrors.get(slot.slotId) ?? error;
			} finally {
				this.regenerate.delete(slot.slotId);
				this.regenerationSource.delete(slot.slotId);
				this.regenerationErrors.delete(slot.slotId);
			}
		});
		core.register("context.compactions", (p) =>
			this.db.all("SELECT * FROM context_compactions WHERE (? IS NULL OR session_id = ?) ORDER BY at DESC, rowid DESC LIMIT ?", str(p.sessionId) ?? null, str(p.sessionId) ?? null, num(p.limit) ?? 100),
		);
		core.register("context.stats", (p) => this.stats({ since: num(p.since) }));
	}
}
