import { spawn } from "node:child_process";
import type { Logger } from "./log.ts";

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
