import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { imageSize } from "./fs-tools.ts";
import type { RenderHtmlResources } from "./render-html-resources.ts";

export const HTML_RENDER_TIMEOUT_MS = 15_000;
export const MAX_RENDER_PIXELS = 12_000_000;
const MAX_FRAME = 80 * 1024 * 1024;
const MAX_CAPTURE_SIDE = 8192;

export interface BrowserPipe {
	input: Writable;
	output: Readable;
	stop(): Promise<void>;
}

type Packet = { id?: number; sessionId?: string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };
type Reply = { resolve(value: unknown): void; reject(error: unknown): void };

class Cdp {
	private readonly pipe: BrowserPipe;
	private readonly signal: AbortSignal;
	private readonly pending = new Map<number, Reply>();
	private sequence = 0;
	private chunks: Buffer[] = [];
	private bytes = 0;
	private failure?: unknown;
	onEvent?: (packet: Packet) => void;

	constructor(pipe: BrowserPipe, signal: AbortSignal) {
		this.pipe = pipe;
		this.signal = signal;
		signal.addEventListener("abort", () => this.fail(signal.reason), { once: true });
		pipe.output.on("data", (bytes: Buffer) => this.read(bytes));
		pipe.output.once("close", () => this.fail(new Error("截图浏览器已关闭。")));
		pipe.output.once("end", () => this.fail(new Error("截图浏览器已关闭。")));
		pipe.output.once("error", error => this.fail(error));
		pipe.input.on("error", error => this.fail(error));
	}

	send<T = unknown>(method: string, params?: object, sessionId?: string): Promise<T> {
		return new Promise((resolve, reject) => {
			if (this.signal.aborted || this.failure) { reject(this.signal.reason ?? this.failure); return; }
			const id = ++this.sequence;
			this.pending.set(id, { resolve: value => resolve(value as T), reject });
			this.pipe.input.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
		});
	}

	assertOpen(): void {
		this.signal.throwIfAborted();
		if (this.failure) throw this.failure;
	}

	fail(error: unknown): void {
		if (this.failure) return;
		this.failure = error;
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
	}

	private read(bytes: Buffer): void {
		for (let start = 0; start < bytes.length;) {
			const terminator = bytes.indexOf(0, start);
			const part = bytes.subarray(start, terminator < 0 ? bytes.length : terminator);
			this.bytes += part.length;
			if (this.bytes > MAX_FRAME) { this.fail(new Error("截图浏览器输出过大。")); return; }
			this.chunks.push(part);
			if (terminator < 0) return;
			try { this.packet(JSON.parse(Buffer.concat(this.chunks, this.bytes).toString("utf8"))); }
			catch (error) { this.fail(error); }
			this.chunks = [];
			this.bytes = 0;
			start = terminator + 1;
		}
	}

	private packet(packet: Packet): void {
		if (packet.id === undefined) { this.onEvent?.(packet); return; }
		const reply = this.pending.get(packet.id);
		this.pending.delete(packet.id);
		if (packet.error) reply?.reject(new Error(packet.error.message));
		else reply?.resolve(packet.result);
	}
}

export interface CaptureOptions { width: number; height: number; fullPage: boolean; waitMs: number }
export interface RenderCapture { png: Buffer; width: number; height: number; cropped: boolean; blocked: [string, string][] }

export async function captureHtmlPage(pipe: BrowserPipe, resources: RenderHtmlResources, options: CaptureOptions, signal: AbortSignal): Promise<RenderCapture> {
	const cdp = new Cdp(pipe, signal);
	const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
	const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
	const send = <T = unknown>(method: string, params?: object) => cdp.send<T>(method, params, sessionId);
	const requests = new Map<string, string>();
	const loaded = new Set<string>();
	cdp.onEvent = packet => {
		if (packet.sessionId !== sessionId || !packet.params) return;
		const params = packet.params;
		switch (packet.method) {
			case "Fetch.requestPaused": {
				const { requestId, resourceType, request } = params as { requestId: string; resourceType: string; request: { url: string; method: string } };
				void (async () => {
					const resource = await resources.get(request.url, request.method, resourceType, signal);
					if (!resource) await send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
					else await send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: resource.headers, body: resource.body });
				})().catch(error => cdp.fail(error));
				break;
			}
			case "Page.lifecycleEvent":
				if (params.name === "load") loaded.add(String(params.loaderId));
				break;
			case "Network.requestWillBeSent": {
				const request = params.request as { url?: string } | undefined;
				if (request?.url && requests.size < 512) requests.set(String(params.requestId), request.url);
				break;
			}
			case "Network.loadingFinished":
				requests.delete(String(params.requestId));
				break;
			case "Network.loadingFailed": {
				const url = requests.get(String(params.requestId));
				if (url && params.blockedReason && !resources.blocked.has(url)) resources.report(url, "浏览器阻止加载");
				requests.delete(String(params.requestId));
				break;
			}
			case "Audits.issueAdded": {
				const issue = params.issue as { details?: { contentSecurityPolicyIssueDetails?: { blockedURL?: string } } } | undefined;
				const blocked = issue?.details?.contentSecurityPolicyIssueDetails?.blockedURL;
				if (blocked && /^(https?:|file:|wss?:)/i.test(blocked)) resources.report(blocked, "页面安全策略阻止加载");
				break;
			}
			case "Log.entryAdded": {
				const entry = params.entry as { text?: string } | undefined;
				const file = entry?.text?.match(/Not allowed to load local resource:\s*(file:[^\s'"]+)/i)?.[1];
				if (file) resources.report(file, "只允许经检查的本地资源");
				break;
			}
		}
	};
	await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
	await send("Page.enable");
	await send("Page.setLifecycleEventsEnabled", { enabled: true });
	await send("Network.enable");
	await send("Network.setBypassServiceWorker", { bypass: true });
	await send("Audits.enable");
	await send("Log.enable");
	await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
	await send("Emulation.setDeviceMetricsOverride", { width: options.width, height: options.height, deviceScaleFactor: 1, mobile: false });

	const navigation = await send<{ errorText?: string; loaderId?: string }>("Page.navigate", { url: resources.url });
	if (navigation.errorText || !navigation.loaderId) throw new Error("截图页面无法打开：" + (navigation.errorText ?? "没有加载文档"));
	while (!loaded.has(navigation.loaderId)) {
		cdp.assertOpen();
		await delay(20, undefined, { signal });
	}
	await send("Runtime.evaluate", { expression: "document.fonts.ready.then(() => true)", awaitPromise: true, returnByValue: true });
	if (options.waitMs) await delay(options.waitMs, undefined, { signal });
	let { width, height } = options;
	let cropped = false;
	if (options.fullPage) {
		const { cssContentSize } = await send<{ cssContentSize: { width: number; height: number } }>("Page.getLayoutMetrics");
		width = Math.min(Math.ceil(cssContentSize.width), MAX_CAPTURE_SIDE);
		height = Math.min(Math.ceil(cssContentSize.height), MAX_CAPTURE_SIDE, Math.floor(MAX_RENDER_PIXELS / width));
		cropped = width < cssContentSize.width || height < cssContentSize.height;
	}
	const { data } = await send<{ data: string }>("Page.captureScreenshot", {
		format: "png", fromSurface: true, captureBeyondViewport: options.fullPage,
		clip: { x: 0, y: 0, width, height, scale: 1 },
	});
	const png = Buffer.from(data, "base64");
	const size = imageSize(png, "image/png");
	if (!png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) || !size?.width || !size.height || size.width * size.height > MAX_RENDER_PIXELS) {
		throw new Error("截图浏览器未返回有效的 PNG。");
	}
	return { png, ...size, cropped, blocked: [...resources.blocked] };
}
