import { spawn } from "node:child_process";
import type { Logger } from "./log.ts";
import { randomUUID } from "node:crypto";
import type { Client, Core } from "./core.ts";
import { NoticeJournal, noticeKey, quietAt, type NoticeIdentity } from "./modules/notices/journal.ts";
import { goalNotice } from "./modules/goals/presentation.ts";
import { goalNoticeReceipt } from "./modules/goals/notices.ts";
import type { GoalRow } from "./modules/goals/types.ts";
import { redact } from "./security/redaction.ts";

export type NotificationKind = "butterfly.done" | "butterfly.waiting" | "workbench.approval" | "workbench.done";
export interface NotificationTarget {
	page: string;
	slotId?: string | null;
	sessionFile?: string | null;
	taskId?: string | null;
	runId?: string | null;
	itemId?: string | null;
	goalId?: string | null;
}

export interface Notice extends NoticeIdentity {
	object: string;
	situation: string;
	impact: string;
	action: string;
	target: NotificationTarget;
}
interface Copy { title: string; body: string }
type NativeResult = "delivered" | "undelivered" | "unknown";
type DeliveryResult = { state: NotificationState; reason?: string; native?: NativeResult };
interface SendOptions {
	at?: number;
	quiet?: "ignore";
	legacy?: Copy;
	window?: (copy: Copy) => void;
	started?: () => void;
	humanReview?: boolean;
	related?: NoticeIdentity[];
}

interface SlotDelivery {
	muted: boolean;
	report: (state: "muted" | "sent" | "failed") => void;
	accepted: boolean;
	identity?: Pick<NoticeIdentity, "key" | "objectRef">;
}

const places: Record<string, string> = { attention: "等你处理", schedule: "日程", butterfly: "蝶君对话", chat: "对话", goals: "目标", memory: "记忆", library: "技能与服务" };

export function noticeCopy(input: Notice): Copy {
	return {
		title: redact([input.object, input.situation].filter(Boolean).join(" · "), true).replace(/\s+/g, " ").slice(0, 180),
		body: redact([input.impact, [input.action, places[input.target.page]].filter(Boolean).join(" · ")].filter(Boolean).join("\n"), true),
	};
}

/** Window presence is per live connection; attached record streams do not imply visibility. */
export class NotificationCenter {
	private readonly core: Core;
	private readonly presence = new Map<Client, { foreground: boolean; slotId: string | null }>();
	private readonly slotDelivery = new Map<string, SlotDelivery>();
	private readonly journal: NoticeJournal;
	private recovered = false;
	constructor(core: Core) {
		this.core = core;
		this.journal = new NoticeJournal(core);
		core.declareBackup({ id: "notification-center", title: "通知送达和注意力指标", tables: ["notification_receipts", "notification_metrics"] });
	}
	recover(): void {
		if (this.recovered) return;
		this.journal.recover();
		this.recovered = true;
	}
	muteQueue(): void { this.journal.muteQueue(); }
	quiet(at = Date.now()): boolean { return quietAt(this.core.settings.get(), at); }
	deferQuiet(input: NoticeIdentity, at: number): void { this.journal.quiet(input, at, true); }
	discardDeferred(key: string, activeKey?: string): void {
		if (!activeKey || noticeKey(key) !== noticeKey(activeKey)) this.journal.mute(key, "stale");
	}
	noteDuplicate(at = Date.now()): void { this.journal.duplicate(at); }
	itemNotified(id: string, rawId: string): boolean { return this.journal.itemSent(id, rawId); }
	maySupplement(key: string): boolean { return this.journal.maySupplement(key) && !this.legacyGoalState(key); }

	private legacyGoalState(key: string): "sent" | "muted" | undefined {
		const goalId = /^notify:([^:]+):/.exec(key)?.[1];
		if (!goalId) return undefined;
		const exact = goalNoticeReceipt(this.core.db, key)?.state;
		if (exact === "sent" || exact === "muted") return exact;
		if (!/^notify:[^:]+:\d+:(?:blocked|budget):/.test(key)) return undefined;
		const canonical = noticeKey(key);
		return this.core.db.all<{ dedupe_key: string; state: "sent" | "muted" }>(
			`SELECT dedupe_key,json_extract(payload,'$.state') state FROM goal_events WHERE goal_id=?
			AND kind='notification.delivery' AND state IN ('sent','muted') ORDER BY state DESC`, goalId)
			.find(row => noticeKey(row.dedupe_key.slice("delivery:".length)) === canonical)?.state;
	}

	topicNotified(refId: string): boolean {
		if (this.journal.sent(refId) || this.legacyGoalState(refId) === "sent") return true;
		const key = this.topicGoalKey(refId);
		if (key !== undefined) return !!key && (this.journal.sent(key) || this.legacyGoalState(key) === "sent");
		return !!this.core.db.get("SELECT 1 FROM notification_receipts WHERE object_ref=? AND state='sent' LIMIT 1", refId);
	}

	topicCovered(refId: string): boolean {
		if (this.topicNotified(refId)) return true;
		const activeKey = this.topicGoalKey(refId);
		if (activeKey === null) return false;
		const key = activeKey ?? refId;
		return !!this.core.db.get(`SELECT 1 FROM notification_receipts
			WHERE (key=? OR object_ref=?) AND state='queued' AND attempts>0 LIMIT 1`, noticeKey(key), activeKey ? null : refId)
			|| goalNoticeReceipt(this.core.db, key)?.state === "queued" && !!this.core.db.get(
				"SELECT 1 FROM goal_intents WHERE idem_key=? AND action='notify' AND status='pending'", key);
	}

	private topicGoalKey(refId: string): string | null | undefined {
		const goalId = refId.startsWith("selfwork:")
			? this.core.db.get<{ goal_id: string | null }>("SELECT goal_id FROM selfwork_runs WHERE id=?", refId.slice("selfwork:".length))?.goal_id
			: /^(?:goal:|chat-delivery:)?(g_[^:]+)$/.exec(refId)?.[1];
		const row = goalId ? this.core.db.get<GoalRow>("SELECT * FROM goals WHERE id=?", goalId) : undefined;
		return row ? goalNotice(row)?.key ?? null : undefined;
	}

	activeBudgetKey(goalId: string): string | undefined {
		const key = this.topicGoalKey(goalId);
		return key?.includes(":budget:") ? key : undefined;
	}

	setPresence(client: Client, state: { foreground: boolean; slotId: string | null }): void { this.presence.set(client, state); }
	remove(client: Client): void { this.presence.delete(client); }
	foreground(): boolean { return [...this.presence].some(([client, p]) => this.core.clients.has(client) && p.foreground); }
	viewing(slotId: string): boolean { return [...this.presence].some(([client, p]) => this.core.clients.has(client) && p.foreground && p.slotId === slotId); }
	withSlotDelivery<T>(slotId: string, muted: boolean, report: SlotDelivery["report"], open: () => T, identity?: SlotDelivery["identity"]): T {
		const delivery = { muted, report, accepted: false, identity };
		this.slotDelivery.set(slotId, delivery);
		try { return open(); } finally {
			this.slotDelivery.delete(slotId);
			if (!delivery.accepted) report(muted ? "muted" : "failed");
		}
	}
	publish(kind: NotificationKind, input: Copy & { target: NotificationTarget } & Partial<Notice>): boolean {
		this.recover();
		const delivery = input.target.slotId ? this.slotDelivery.get(input.target.slotId) : undefined;
		if (delivery?.muted) {
			delivery.accepted = true;
			delivery.report("muted");
			return false;
		}
		// Transitional clients have no visibility protocol. Preserve their former attached-slot rule
		// until a window explicitly reports presence; then only actual visibility counts.
		const legacyWatching = !this.presence.size && !!input.target.slotId && [...this.core.clients].some(c => c.attached.has(input.target.slotId!));
		const visible = kind === "workbench.done" && (this.foreground() || legacyWatching) ||
			kind === "workbench.approval" && (legacyWatching || !!input.target.slotId && this.viewing(input.target.slotId));
		const notice: Notice = {
			key: delivery?.identity?.key ?? input.key ?? (input.target.itemId ? `${kind}:${input.target.itemId}`
				: input.target.runId ? `${kind}:${input.target.runId}` : randomUUID()),
			category: input.category ?? (kind.endsWith(".done") ? "done" : "decision"),
			object: input.object ?? input.title, situation: input.situation ?? "", impact: input.impact ?? input.body,
			action: input.action ?? "打开", target: input.target, objectRef: delivery?.identity?.objectRef ?? input.objectRef, itemId: input.target.itemId,
		};
		const at = Date.now();
		const legacy = this.core.settings.get().notifications ? this.legacyGoalState(notice.key) : undefined;
		if (legacy) {
			this.journal.duplicate(at);
			if (delivery) { delivery.accepted = true; delivery.report(legacy); }
			return false;
		}
		const claim = this.journal.claim(notice, at, {
			quiet: this.quiet(at),
			mute: !this.core.settings.get().notifications ? "notifications_disabled" : visible ? "already_visible"
				: notice.category === "review" ? "review_only" : undefined,
		});
		if (!claim.claimed) {
			if (delivery) { delivery.accepted = true; delivery.report(claim.state === "sent" ? "sent" : claim.state === "muted" ? "muted" : "failed"); }
			return false;
		}
		this.core.broadcast({ event: "notification", id: randomUUID(), kind, ...notice, ...(input.object ? noticeCopy(notice) : { title: input.title, body: input.body }), at });
		// Old windows do not consume the new event. Keep their existing native fallback.
		const native = !this.presence.size;
		if (delivery) delivery.accepted = true;
		if (native) void this.deliverClaimed(notice, { title: input.title, body: input.object ? noticeCopy(notice).body : input.body }, at)
			.then(result => delivery?.report(result.state === "queued" ? "failed" : result.state))
			.catch(error => this.core.log.warn("无法记录确认通知结果", error));
		else {
			this.journal.finish(notice.key, "sent", at);
			delivery?.report("sent");
		}
		return true;
	}

	post(input: Notice, options: SendOptions = {}): void {
		void this.send(input, options).catch(error => this.core.log.warn("无法发送或记录通知", error));
	}

	/** Preserve an observed condition across process restarts. A different condition starts a new episode. */
	postTransition(input: Omit<Notice, "key" | "objectRef"> & { objectRef: string }, announce: boolean, legacy: Copy): void {
		this.recover();
		const prior = this.journal.latest(input.objectRef);
		const same = prior?.category === input.category;
		const notice = { ...input, key: same ? prior.key : `${input.objectRef}:${randomUUID()}` };
		if (announce) this.post(notice, { legacy });
		else if (prior && !same) this.journal.claim(notice, Date.now(), { mute: "initial_state" });
	}

	async send(input: Notice, options: SendOptions = {}): Promise<DeliveryResult> {
		this.recover();
		const at = options.at ?? Date.now();
		const legacy = this.core.settings.get().notifications ? this.legacyGoalState(input.key) : undefined;
		if (legacy) {
			this.journal.duplicate(at);
			return { state: legacy, reason: "duplicate" };
		}
		const claim = this.journal.claim({ ...input, itemId: input.itemId ?? input.target.itemId }, at, {
			quiet: options.quiet !== "ignore" && this.quiet(at),
			mute: !this.core.settings.get().notifications ? "notifications_disabled"
				: input.category === "review" && !options.humanReview ? "review_only" : undefined,
		});
		if (!claim.claimed) return { state: claim.state, reason: claim.reason };
		const related = options.related?.filter(item => this.journal.claim(item, at, { retryFailed: true }).claimed) ?? [];
		options.started?.();
		const copy = options.legacy ?? noticeCopy(input);
		if (options.window) {
			try {
				options.window(copy);
				for (const notice of [input, ...related]) this.journal.finish(notice.key, "sent", at);
				return { state: "sent" };
			} catch (error) {
				for (const notice of [input, ...related]) this.journal.finish(notice.key, "failed", at, "delivery_failed");
				this.core.log.warn("窗口通知发送失败", error);
				return { state: "failed" };
			}
		}
		return this.deliverClaimed(input, copy, at, related);
	}

	private async deliverClaimed(input: NoticeIdentity, copy: Copy, at: number, related: NoticeIdentity[] = []): Promise<DeliveryResult> {
		let native: NativeResult = "undelivered";
		try {
			if (this.core.notifier.deliver) native = await this.core.notifier.deliver(copy.title, copy.body);
			else { this.core.notifier.notify(copy.title, copy.body); native = "unknown"; }
		} catch (error) { this.core.log.warn("通知发送失败", error); }
		const state = native === "delivered" || !this.core.notifier.deliver && native === "unknown" ? "sent" : "failed";
		try {
			for (const notice of [input, ...related]) this.journal.finish(notice.key, state, at, state === "failed" ? "delivery_failed" : null);
		} catch (error) { this.core.log.warn("无法保存通知送达结果", error); }
		return { state, native };
	}
}

export interface Notifier {
	notify(title: string, body: string): void;
	/** Like notify, reporting whether the toast was handed to Windows. */
	deliver?(title: string, body: string): Promise<"delivered" | "undelivered" | "unknown">;
}

export type NotificationState = "queued" | "muted" | "sent" | "failed";

export function notificationQueueState(core: Core): "queued" | "muted" {
	return core.settings.get().notifications ? "queued" : "muted";
}

/** PowerShell's registered AppUserModelID; lets an unpackaged process raise toasts. */
const POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

function xmlEscape(text: string): string {
	return text.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

/** Windows toast notifications via the WinRT API from PowerShell (no native modules). */
export class WindowsNotifier implements Notifier {
	private readonly log: Logger;

	constructor(log: Logger) {
		this.log = log;
	}

	notify(title: string, body: string): void {
		void this.deliver(title, body);
	}

	deliver(title: string, body: string): Promise<"delivered" | "undelivered" | "unknown"> {
		if (process.platform !== "win32") return Promise.resolve("undelivered");
		const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body.slice(0, 300))}</text></binding></visual></toast>`;
		const script = [
			"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
			"[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
			"$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
			`$xml.LoadXml([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(xml, "utf8").toString("base64")}')))`,
			`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`,
		].join("; ");
		return new Promise((resolve) => {
			try {
				const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
					stdio: "ignore",
					windowsHide: true,
				});
				// Showing takes a second or two; a hung PowerShell counts as unknown.
				const timer = setTimeout(() => {
					child.kill();
					resolve("unknown");
				}, 20_000);
				timer.unref();
				child.on("error", (error) => {
					clearTimeout(timer);
					this.log.warn("toast failed", error);
					resolve("undelivered");
				});
				child.on("exit", (code) => {
					clearTimeout(timer);
					if (code !== 0) this.log.warn(`toast failed: powershell exited with ${code}`);
					resolve(code === 0 ? "delivered" : "undelivered");
				});
				child.unref();
			} catch (error) {
				this.log.warn("toast failed", error);
				resolve("undelivered");
			}
		});
	}
}

export class RecordingNotifier implements Notifier {
	readonly sent: { title: string; body: string }[] = [];

	notify(title: string, body: string): void {
		this.sent.push({ title, body });
	}

	async deliver(title: string, body: string): Promise<"delivered"> {
		this.notify(title, body);
		return "delivered";
	}
}
