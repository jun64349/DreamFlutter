import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserPipe } from "./render-html-cdp.ts";
import { killTree } from "./shell.ts";

// Fetch serves a private virtual origin. A dead proxy, DNS restrictions, and CSP
// also cover traffic outside normal page subresources on the Windows browser.
export const OFFLINE_BROWSER_FLAGS = [
	"--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
	"--disable-component-update", "--disable-domain-reliability", "--disable-sync", "--disable-extensions", "--disable-gpu",
	"--disable-breakpad", "--disable-crash-reporter",
	"--disable-quic", "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=<-loopback>",
	"--host-resolver-rules=MAP * ~NOTFOUND", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
	"--disable-features=OptimizationGuideModelDownloading,MediaRouter,Translate,NetworkPrediction,SpeculationRulesPrefetch",
];

export function browserEnvironment(): NodeJS.ProcessEnv {
	const allowed = /^(?:path|pathext|systemroot|windir|systemdrive|temp|tmp|comspec|userprofile|localappdata|appdata|programdata)$/i;
	return Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.test(name)));
}

export function managedBrowserPipe(child: ChildProcess, input: Writable, output: Readable, cleanup: () => Promise<void>): BrowserPipe {
	let closed = false;
	let stopping: Promise<void> | undefined;
	const ended = new Promise<void>(resolve => {
		const done = () => { closed = true; resolve(); };
		child.once("close", done);
		child.once("error", done);
	});
	input.on("error", () => {});
	output.on("error", () => {});
	return {
		input, output,
		stop() {
			return stopping ??= (async () => {
				input.end();
				await Promise.race([ended, delay(900, undefined, { ref: false })]);
				if (!closed) {
					killTree(child);
					await Promise.race([ended, delay(750, undefined, { ref: false })]);
				}
				await cleanup();
			})();
		},
	};
}

export class EdgeHtmlBrowser {
	async find(): Promise<string | undefined> {
		if (process.platform !== "win32") return;
		for (const root of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA]) {
			if (!root) continue;
			const file = join(root, "Microsoft", "Edge", "Application", "msedge.exe");
			try { await access(file, constants.R_OK); return file; } catch {}
		}
	}

	async launch(binary: string, signal: AbortSignal): Promise<BrowserPipe> {
		const profile = await mkdtemp(join(tmpdir(), "df-html-edge-"));
		const cleanup = () => rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
		try {
			signal.throwIfAborted();
			const child = spawn(binary, ["--headless", ...OFFLINE_BROWSER_FLAGS, "--user-data-dir=" + profile, "about:blank"], {
				windowsHide: true, env: browserEnvironment(), stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
			});
			return managedBrowserPipe(child, child.stdio[3] as Writable, child.stdio[4] as Readable, cleanup);
		} catch (error) { await cleanup(); throw error; }
	}
}
