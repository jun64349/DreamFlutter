import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../log.ts";

/**
 * Network setup the Pi CLI does at startup and the SDK leaves to the host:
 * the user's `httpProxy` setting, and Pi's undici dispatcher (proxy-aware,
 * 2 s connect attempts instead of Node's 250 ms, which fails first requests
 * on high-latency routes). The dispatcher module is not a public export, so
 * it is loaded by file next to the package entry.
 */
export async function configurePiNetworking(agentDir: string, log: Logger): Promise<void> {
	try {
		const settings = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
		const proxy = (settings.getGlobalSettings() as { httpProxy?: string }).httpProxy?.trim();
		if (proxy) {
			process.env.HTTP_PROXY ??= proxy;
			process.env.HTTPS_PROXY ??= proxy;
		}
		const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
		const dispatcher = (await import(new URL("./core/http-dispatcher.js", entry).href)) as {
			configureHttpDispatcher(timeoutMs?: number): void;
		};
		dispatcher.configureHttpDispatcher(settings.getHttpIdleTimeoutMs());
	} catch (error) {
		log.warn("could not configure Pi networking; using Node defaults", error);
	}
}
