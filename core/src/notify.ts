import { spawn } from "node:child_process";
import type { Logger } from "./log.ts";
import { randomUUID } from "node:crypto";
import type { Client, Core } from "./core.ts";

export type NotificationKind = "butterfly.done" | "butterfly.waiting" | "workbench.approval" | "workbench.done";
export interface NotificationTarget {
	page: string;
	slotId?: string | null;
	sessionFile?: string | null;
	taskId?: string | null;
	runId?: string | null;
	itemId?: string | null;
}

/** Window presence is per live connection; attached record streams do not imply visibility. */
export class NotificationCenter {
	private readonly core: Core;
	private readonly presence = new Map<Client, { foreground: boolean; slotId: string | null }>();
	private readonly sent = new Set<string>();
	constructor(core: Core) { this.core = core; }
	setPresence(client: Client, state: { foreground: boolean; slotId: string | null }): void { this.presence.set(client, state); }
	remove(client: Client): void { this.presence.delete(client); }
	foreground(): boolean { return [...this.presence].some(([client, p]) => this.core.clients.has(client) && p.foreground); }
	viewing(slotId: string): boolean { return [...this.presence].some(([client, p]) => this.core.clients.has(client) && p.foreground && p.slotId === slotId); }
	publish(kind: NotificationKind, input: { title: string; body: string; target: NotificationTarget }, options: { legacyFallback?: boolean } = {}): boolean {
		if (!this.core.settings.get().notifications) return false;
		// Transitional clients have no visibility protocol. Preserve their former attached-slot rule
		// until a window explicitly reports presence; then only actual visibility counts.
		const legacyWatching = !this.presence.size && !!input.target.slotId && [...this.core.clients].some(c => c.attached.has(input.target.slotId!));
		if (kind === "workbench.done" && (this.foreground() || legacyWatching)) return false;
		if (kind === "workbench.approval" && (legacyWatching || input.target.slotId && this.viewing(input.target.slotId))) return false;
		const key = input.target.runId ? `${kind}:${input.target.runId}:${input.target.itemId ?? ""}` : undefined;
		if (key && this.sent.has(key)) return false;
		if (key) { this.sent.add(key); if (this.sent.size > 1000) this.sent.delete(this.sent.values().next().value!); }
		this.core.broadcast({ event: "notification", id: randomUUID(), kind, ...input, at: Date.now() });
		// Old windows do not consume the new event. Keep their existing native fallback.
		if (!this.presence.size && options.legacyFallback !== false) this.core.notifier.notify(input.title, input.body);
		return true;
	}
}

export interface Notifier {
	notify(title: string, body: string): void;
	/** Like notify, reporting whether the toast was handed to Windows. */
	deliver?(title: string, body: string): Promise<"delivered" | "undelivered" | "unknown">;
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
