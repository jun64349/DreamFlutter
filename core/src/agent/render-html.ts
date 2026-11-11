import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { addAbortListener } from "node:events";
import { QUESTION_TITLE } from "./interaction-tools.ts";
import { EdgeHtmlBrowser } from "./render-html-browser.ts";
import { captureHtmlPage, HTML_RENDER_TIMEOUT_MS, MAX_RENDER_PIXELS, type BrowserPipe, type CaptureOptions } from "./render-html-cdp.ts";
import { RenderHtmlResources } from "./render-html-resources.ts";
import type { HarnessState } from "./state.ts";
import { CHROMIUM_DOWNLOAD_MB, SandboxHtmlBrowser, type HtmlSandbox } from "../sandbox/html-browser.ts";

export const EDGE_MISSING = "这台电脑上没有找到 Edge，没法截图";
export const CHROMIUM_MISSING = "蝶君的截图浏览器还没装";
export const RENDER_TIMED_OUT = "HTML 截图超过 15 秒，浏览器已关闭。";

type StoreImage = (png: Buffer, signal: AbortSignal) => Promise<string | undefined>;
export const htmlFilesBySession = new WeakMap<object, (sessionId: string) => StoreImage | undefined>();

type RenderArgs = { file_path: string; width?: number; height?: number; full_page?: boolean; wait_ms?: number };
type Result = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; details: Record<string, unknown> };

function captureOptions(args: RenderArgs): CaptureOptions {
	const width = args.width ?? 1280, height = args.height ?? 800, waitMs = args.wait_ms ?? 0;
	if (![width, height].every(v => Number.isInteger(v) && v > 0 && v <= 8192) || width * height > MAX_RENDER_PIXELS) {
		throw new Error("截图宽高应为正整数，单边最多 8192，总像素不超过 1200 万。");
	}
	if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs >= HTML_RENDER_TIMEOUT_MS) throw new Error("wait_ms 必须是 0 到 14999 的整数。");
	return { width, height, waitMs, fullPage: args.full_page === true };
}

const textResult = (text: string): Result => ({ content: [{ type: "text", text }], details: {} });
const INSTALL_DECISION = "df.chromium-install-declined";
const INSTALL = "现在安装";
const DECLINE = "不安装";
const SKIP = "跳过";

async function untilCancelled<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const listener = addAbortListener(signal, () => reject(signal.reason));
		void operation.then(resolve, reject).finally(() => listener[Symbol.dispose]());
	});
}

function browserInstallPrompt(browser: SandboxHtmlBrowser, pi: ExtensionAPI) {
	const pending = new Map<string, Promise<void>>();
	return (ctx: ExtensionContext, signal: AbortSignal): Promise<void> | undefined => {
		const session = ctx.sessionManager, sessionId = session.getSessionId();
		const existing = pending.get(sessionId);
		if (existing) return existing;
		if (!ctx.hasUI || session.getEntries().some(entry => entry.type === "custom" && entry.customType === INSTALL_DECISION
			&& (entry.data as { sessionId?: string } | undefined)?.sessionId === sessionId)) return;
		const operation = (async () => {
			const choice = await ctx.ui.select(`${QUESTION_TITLE}\n\n截图要用的浏览器还没装（约 ${CHROMIUM_DOWNLOAD_MB} MB），现在装吗？`,
				[INSTALL, DECLINE, SKIP], { signal });
			if (choice !== INSTALL) {
				if (!signal.aborted) pi.appendEntry(INSTALL_DECISION, { sessionId });
				return;
			}
			signal.throwIfAborted();
			// Finish an approved APT transaction even if the requesting screenshot is cancelled.
			await browser.install();
		})().finally(() => pending.delete(sessionId));
		pending.set(sessionId, operation);
		return operation;
	};
}

export function renderHtmlTool(pi: ExtensionAPI, state: HarnessState, workspace: string | undefined, sandbox?: HtmlSandbox): ToolDefinition {
	const closed = new AbortController();
	const active = new Set<Promise<Result>>();
	const browser = sandbox ? new SandboxHtmlBrowser(sandbox.distro) : new EdgeHtmlBrowser();
	const askToInstall = browser instanceof SandboxHtmlBrowser ? browserInstallPrompt(browser, pi) : undefined;
	pi.on("session_shutdown", async () => {
		closed.abort(new Error("会话已关闭，截图已停止。"));
		await Promise.allSettled(active);
	});
	return {
		name: "render_html",
		label: "HTML 截图",
		description: "Render a local workspace HTML file as PNG using local images, styles and scripts. External requests are blocked.",
		parameters: {
			type: "object", required: ["file_path"], properties: {
				file_path: { type: "string", description: "Path to an HTML file inside this workspace." },
				width: { type: "integer", description: "Viewport width in pixels, default 1280." },
				height: { type: "integer", description: "Viewport height in pixels, default 800." },
				full_page: { type: "boolean", description: "Capture the whole page up to the pixel limit." },
				wait_ms: { type: "integer", description: "Optional delay after the document and fonts have loaded, in milliseconds." },
			},
		} as never,
		async execute(_id, args: RenderArgs, signal, _update, ctx) {
			const cancel = signal ? AbortSignal.any([signal, closed.signal]) : closed.signal;
			const store = htmlFilesBySession.get(ctx.sessionManager)?.(ctx.sessionManager.getSessionId());
			const operation = (async (): Promise<Result> => {
				if (typeof args.file_path !== "string") throw new Error("请选择工作区里的本地 HTML 文件。");
				const options = captureOptions(args);
				const resources = await RenderHtmlResources.create(state, sandbox ? "/workspace" : workspace ?? state.cwd, args.file_path, cancel);
				let binary = await browser.find(cancel);
				if (!binary && askToInstall) {
					const installation = askToInstall(ctx, cancel);
					if (installation) {
						await untilCancelled(installation, cancel);
						binary = await browser.find(cancel);
					}
				}
				if (!binary) return textResult(sandbox ? CHROMIUM_MISSING : EDGE_MISSING);
				await sandbox?.ready();
				const deadline = AbortSignal.timeout(HTML_RENDER_TIMEOUT_MS);
				const renderSignal = AbortSignal.any([cancel, deadline]);
				let pipe: BrowserPipe | undefined;
				try {
					pipe = await browser.launch(binary, renderSignal);
					const result = await captureHtmlPage(pipe, resources, options, renderSignal);
					renderSignal.throwIfAborted();
					const file = await store?.(result.png, renderSignal);
					const info = [file ? "已生成图片：" + file : "已生成 HTML 截图", result.width + "×" + result.height];
					if (result.cropped) info.push("页面超出像素上限，截图已裁切。");
					if (result.blocked.length) info.push("已拦截的资源：", ...result.blocked.map(([url, reason]) => "- " + url + "（" + reason + "）"));
					return {
						content: [{ type: "text", text: info.join("\n") }, { type: "image", data: result.png.toString("base64"), mimeType: "image/png" }],
						details: { imagePaths: [file ?? ""], blocked: result.blocked.map(([url]) => url), width: result.width, height: result.height },
					};
				} catch (error) {
					if (deadline.aborted && !cancel.aborted) return textResult(RENDER_TIMED_OUT);
					throw error;
				} finally { await pipe?.stop(); }
			})();
			active.add(operation);
			try { return await operation; }
			finally { active.delete(operation); }
		},
	};
}
