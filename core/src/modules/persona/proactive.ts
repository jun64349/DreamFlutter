import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { samePath, RpcError, type Core } from "../../core.ts";
import { Gateway, GROUP_PROVIDER } from "../../gateway/gateway.ts";
import { estimate } from "../../ledger/rules.ts";
import { finite, withLedgerContext } from "../../ledger/types.ts";
import { readSessionEntries } from "../../pi/session-metadata.ts";
import { SANDBOX_ENTRY } from "../../pi/host.ts";
import { textOf } from "../../runs.ts";
import type { Slot } from "../../slots/slot.ts";
import { localDay, SessionIndex } from "../session-index.ts";
import { PERSONAS, personaPrompt } from "./presets.ts";

const dailyLimit = { low: 0, mid: 2, high: 5 };
const maxOutput = 256;

export interface ProactiveRequest { reason: string; refId: string }
export type ProactiveResult = { ok: true; sessionFile: string; entryId: string } | { ok: false; reason: string };
export function isProactiveTerminal(state: string): boolean { return state === "sent" || state === "skipped"; }
interface Delivery { ref_id: string; session_file: string; entry_id: string | null; sent_at: number; sent_day: string }

/** One bounded, tool-free draft, delivered to an existing ordinary conversation. */
export class ProactiveChat {
	private readonly core: Core;
	private readonly chatAllowed: () => boolean;
	private readonly clock: () => number;
	private tail: Promise<unknown> = Promise.resolve();
	private readonly shutdown = new AbortController();

	constructor(core: Core, chatAllowed: () => boolean, clock: () => number) {
		this.core = core;
		this.chatAllowed = chatAllowed;
		this.clock = clock;
		core.declareBackup({ id: "persona", title: "蝶君主动聊天记录", tables: ["butterfly_proactive"], paths: { butterfly_proactive: { session_file: "path" } } });
	}

	recover(): void {
		const db = this.core.db;
		for (const row of db.all<{ ref_id: string; estimate_usd: number }>("SELECT ref_id, estimate_usd FROM butterfly_proactive WHERE state='generating'")) {
			this.settleCost(row.ref_id, row.estimate_usd);
		}
		db.run("UPDATE butterfly_proactive SET state='skipped', reason='interrupted' WHERE state IN ('waiting','generating')");
		this.recoverDeliveries();
		this.reconcileDeletedMessages();
	}

	reconcileDeletedMessages(): void {
		if (this.core.maintenance) return;
		const db = this.core.db;
		const pending = db.get<Delivery>("SELECT * FROM butterfly_proactive WHERE state='sent' AND replied_at IS NULL AND reason IS NULL LIMIT 1");
		if (!pending?.entry_id || !pending.session_file) return;
		let deleted = false;
		try {
			// The entire file is checked so switching branches or compacting is not a deletion.
			const rows = readFileSync(pending.session_file, "utf8").split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
			deleted = rows[0]?.type === "session" && !rows.some(row => row?.id === pending.entry_id);
		} catch (error) {
			// A moved/deleted file is different from a file that is unreadable or being rewritten.
			deleted = (error as NodeJS.ErrnoException).code === "ENOENT";
		}
		if (deleted) db.run("UPDATE butterfly_proactive SET reason='declined_by_delete' WHERE ref_id=? AND replied_at IS NULL AND reason IS NULL", pending.ref_id);
	}

	request({ reason, refId }: ProactiveRequest): Promise<ProactiveResult> {
		if (typeof refId !== "string" || !refId.trim() || refId.length > 256 || typeof reason !== "string" || !reason.trim() || reason.length > 500) {
			throw new RpcError("bad_request", "主动聊天需要来源编号和简短原因");
		}
		refId = refId.trim();
		if (this.shutdown.signal.aborted) return Promise.resolve({ ok: false, reason: "stopping" });
		const inserted = this.core.db.run("INSERT OR IGNORE INTO butterfly_proactive (ref_id, requested_at, state) VALUES (?, ?, 'waiting')", refId, this.clock());
		if (!inserted.changes) return Promise.resolve({ ok: false, reason: "duplicate" });
		// Requests first received in quiet hours or while muted never enter the queue.
		const denial = this.interruption() ?? this.duplicateTopic(refId);
		if (denial) return Promise.resolve(this.skip(refId, denial));
		const next = this.tail.then(() => this.execute({ reason: reason.trim(), refId })).catch(error => {
			if (!this.shutdown.signal.aborted) this.core.log.warn("proactive chat failed", error);
			return this.skip(refId, this.shutdown.signal.aborted ? "stopping" : "failed");
		});
		this.tail = next;
		return next;
	}

	async stop(): Promise<void> {
		this.shutdown.abort();
		await this.tail;
	}

	onSlotEvent(slot: Slot, event: AgentSessionEvent): void {
		if (event.type !== "message_end" || event.message.role !== "user" || !this.ordinary(slot)) return;
		// Pi emits message_end just before appending the message to the session tree.
		queueMicrotask(() => this.markReply(slot));
	}

	private markReply(slot: Slot): void {
		const file = slot.session.sessionFile;
		const last = this.core.db.get<Delivery>("SELECT * FROM butterfly_proactive WHERE state='sent' AND replied_at IS NULL AND reason IS NULL LIMIT 1");
		if (!file || !last || !samePath(file, last.session_file) || !last.entry_id) return;
		const branch = slot.session.sessionManager.getBranch();
		const sent = branch.findIndex(entry => entry.id === last.entry_id);
		if (sent >= 0 && branch.slice(sent + 1).some(entry => entry.type === "message" && entry.message.role === "user")) {
			this.core.db.run("UPDATE butterfly_proactive SET replied_at=? WHERE ref_id=? AND replied_at IS NULL", this.clock(), last.ref_id);
		}
	}

	private ordinary(slot: Slot): boolean {
		return slot.started && slot.sandboxed && !slot.unattended && !slot.incognito && !slot.isSideConversation &&
			samePath(slot.cwd, this.core.paths.butterflyDir);
	}

	private interruption(): string | undefined {
		if (!this.chatAllowed()) return "proactivity";
		const settings = this.core.settings.get();
		if (this.core.notifications.quiet(this.clock())) return "quiet_hours";
		if (!settings.notifications) return "notifications_disabled";
		if (this.core.maintenance) return "maintenance";
		if (this.shutdown.signal.aborted) return "stopping";
	}

	private lastDelivery(): Delivery | undefined {
		return this.core.db.get<Delivery>("SELECT * FROM butterfly_proactive WHERE state='sent' ORDER BY sent_at DESC,rowid DESC LIMIT 1");
	}

	private recoverDeliveries(): void {
		const db = this.core.db;
		for (const row of db.all<Delivery>("SELECT * FROM butterfly_proactive WHERE state='sending'")) {
			let entryId: string | undefined;
			try {
				entryId = readSessionEntries(row.session_file).find(entry => entry.type === "message" && entry.message?.dfProactiveRef === row.ref_id)?.id;
			} catch { /* The destination may have been deleted or never written. */ }
			if (entryId) db.run("UPDATE butterfly_proactive SET state='sent', entry_id=? WHERE ref_id=?", entryId, row.ref_id);
			else db.run("UPDATE butterfly_proactive SET state='skipped', reason='interrupted' WHERE ref_id=?", row.ref_id);
		}
	}

	private duplicateTopic(refId: string): string | undefined {
		if (!this.core.notifications.topicCovered(refId)) return undefined;
		this.core.notifications.noteDuplicate(this.clock());
		return "already_notified";
	}

	private deliveryDenial(refId: string): string | undefined {
		const denial = this.interruption() ?? this.duplicateTopic(refId);
		if (denial) return denial;
		this.recoverDeliveries();
		this.reconcileDeletedMessages();
		const db = this.core.db;
		const settings = this.core.settings.get();
		const at = this.clock();
		const day = localDay(at);
		if (db.get("SELECT 1 FROM butterfly_proactive WHERE state='sent' AND replied_at IS NULL AND reason IS NULL LIMIT 1")) return "awaiting_reply";
		const { count } = db.get<{ count: number }>("SELECT count(*) AS count FROM butterfly_proactive WHERE state='sent' AND sent_day=?", day)!;
		if (count >= dailyLimit[settings.butterflyProactivity]) return "daily_count";
		const last = this.lastDelivery();
		if (last?.sent_day === day && at < last.sent_at + PERSONAS[settings.butterflyPersona].intervalMin * 60_000) return "persona_interval";
	}

	private async waitForConversation(): Promise<string | undefined> {
		for (;;) {
			const denial = this.interruption();
			if (denial) return denial;
			const busy = this.core.sessionSlots().some(slot => slot.sandboxed && slot.started &&
				(slot.running || slot.compacting || slot.session.isStreaming || slot.session.isCompacting || slot.ui.pendingCount > 0));
			if (!busy) return undefined;
			await delay(50, undefined, { signal: this.shutdown.signal });
		}
	}

	private async target(): Promise<Slot | undefined> {
		const index = this.core.module(SessionIndex);
		if (!index) return undefined;
		await index.refresh();
		const cwd = this.core.paths.butterflyDir;
		const sessions = index.list({ cwd }).sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
		for (const { path } of sessions) {
			const live = this.core.findSlotByFile(path);
			if (live) {
				if (this.ordinary(live) && !this.core.isSlotClosing(live.slotId)) return live;
				continue;
			}
			const firstTask = this.core.db.get<{ source: string; goal_id: string | null }>(
				"SELECT source,goal_id FROM tasks WHERE session_file=? ORDER BY created_at,rowid LIMIT 1", path);
			if (firstTask?.source === "schedule" || firstTask?.goal_id) continue;
			if (!this.core.isProjectTrusted(cwd) || this.interruption()) return undefined;
			try {
				const entries = readSessionEntries(path);
				if (!entries.some(entry => entry.type === "custom" && entry.customType === SANDBOX_ENTRY && entry.data?.sandbox === true) ||
					!entries.some(entry => entry.type === "message" && entry.message?.role === "user")) continue;
			} catch { continue; }
			const opened = await this.core.openSlot({ cwd, sessionFile: path });
			if (this.ordinary(opened)) return opened;
		}
	}

	private skip(refId: string, reason: string): ProactiveResult {
		this.core.db.run("UPDATE butterfly_proactive SET state='skipped', reason=? WHERE ref_id=? AND state IN ('waiting','generating')", reason, refId);
		return { ok: false, reason };
	}

	private estimate(model: Model<never>, slot: Slot, input: number): number | null {
		const usage = {
			input, output: Math.min(maxOutput, model.maxTokens), cacheRead: 0, cacheWrite: 0, totalTokens: input + maxOutput,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		if (model.api !== "pi-virtual") return estimate(model, usage);
		const gateway = this.core.module(Gateway);
		const group = model.provider === GROUP_PROVIDER ? gateway?.groups().find(item => item.id === model.id) : undefined;
		if (!group?.entries.length) return null;
		const prices = group.entries.map(entry => {
			const channel = gateway?.channel(entry.channel);
			const member = channel && slot.session.modelRuntime.getModel(channel.provider, entry.model);
			return member ? estimate(member, usage) : null;
		});
		return prices.some(price => price === null) ? null : Math.max(...prices as number[]);
	}

	private settleCost(refId: string, estimateUsd: number, answer?: AssistantMessage): void {
		const rows = this.core.db.all<{ amount: number | null; currency: string | null }>(
			"SELECT amount,currency FROM request_ledger WHERE run_id=? AND purpose='auxiliary'", this.ledgerRun(refId));
		const cost = rows.length && rows.every(row => row.currency === "USD" && finite(row.amount) !== null)
			? rows.reduce((sum, row) => sum + row.amount!, 0)
			: answer?.stopReason === "stop" && !rows.length ? finite(answer.usage.cost.total) ?? estimateUsd : estimateUsd;
		this.core.autonomy.budget.settle("chat", refId, cost);
	}

	private ledgerRun(refId: string): string { return "persona-chat:" + refId; }

	private async execute({ reason, refId }: ProactiveRequest): Promise<ProactiveResult> {
		let denial = await this.waitForConversation() ?? this.deliveryDenial(refId);
		if (denial) return this.skip(refId, denial);
		const slot = await this.target();
		denial = await this.waitForConversation() ?? this.deliveryDenial(refId);
		if (denial) return this.skip(refId, denial);
		const session = slot?.session;
		const file = session?.sessionFile;
		if (!slot || !session || !file || this.core.isSlotClosing(slot.slotId)) return this.skip(refId, "no_conversation");
		const model = session.model && this.core.resolveModel(session.model) as Model<never>;
		if (!model) return this.skip(refId, "no_model");
		const persona = this.core.settings.get().butterflyPersona;
		const systemPrompt = "你是蝶君。根据下面的来意，给用户写一条简短、自然的主动消息。只输出消息正文。\n\n" + personaPrompt(persona);
		const user = { role: "user" as const, content: reason, timestamp: this.clock() };
		const estimateUsd = this.estimate(model, slot, Buffer.byteLength(systemPrompt + reason, "utf8") + 64);
		if (estimateUsd === null) return this.skip(refId, "unpriced_model");
		const budget = this.core.autonomy.budget.check(estimateUsd, "chat");
		if (!budget.ok) return this.skip(refId, budget.reason);

		const db = this.core.db;
		db.run("UPDATE butterfly_proactive SET state='generating', estimate_usd=? WHERE ref_id=?", estimateUsd, refId);
		if (!this.core.autonomy.budget.reserve(estimateUsd, "chat", refId)) return this.skip(refId, "daily_cap");
		let answer: AssistantMessage | undefined;
		try {
			const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(30_000)]);
			answer = await withLedgerContext({ purpose: "auxiliary", slotId: slot.slotId, runId: this.ledgerRun(refId), workspace: slot.cwd, sessionId: session.sessionId },
				() => session.modelRuntime.completeSimple(model, { systemPrompt, messages: [user] }, { maxTokens: maxOutput, thinkingLevel: "off", signal } as never));
		} finally {
			this.settleCost(refId, estimateUsd, answer);
		}
		const content = answer?.content.filter(block => block.type === "text");
		if (!answer || answer.stopReason !== "stop" || !content || !textOf(content).trim()) return this.skip(refId, "model_failed");

		denial = await this.waitForConversation() ?? this.deliveryDenial(refId);
		if (denial) return this.skip(refId, denial);
		if (this.core.settings.get().butterflyPersona !== persona) return this.skip(refId, "persona_changed");
		if (this.core.slots.get(slot.slotId) !== slot || this.core.isSlotClosing(slot.slotId) || slot.session !== session ||
			!samePath(file, session.sessionFile)) return this.skip(refId, "conversation_changed");

		const at = this.clock();
		const message = { ...answer, content, timestamp: at, dfProactiveRef: refId };
		const manager = session.sessionManager;
		db.run("UPDATE butterfly_proactive SET state='sending', sent_at=?, sent_day=?, session_file=? WHERE ref_id=?", at, localDay(at), file, refId);
		const entryId = manager.appendMessage(message);
		db.run("UPDATE butterfly_proactive SET state='sent', entry_id=? WHERE ref_id=?", entryId, refId);
		session.agent.state.messages = manager.buildSessionProjection().messages;
		slot.lastActivity = Date.now();
		for (const client of this.core.clients) if (client.attached.has(slot.slotId)) {
			try { client.send({ event: "slot.record", slotId: slot.slotId, record: { type: "message_end", message, entryId } }); }
			catch (error) { this.core.log.warn("could not stream proactive chat to window", error); }
		}
		void this.core.module(SessionIndex)?.refresh().then(() => this.core.broadcast({ event: "sessions.changed" }))
			.catch(error => this.core.log.warn("could not index proactive chat", error));
		return { ok: true, sessionFile: file, entryId };
	}
}
