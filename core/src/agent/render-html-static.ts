import { addAbortListener } from "node:events";
import { startAppContainerHtmlRenderer, type AppContainerConfig } from "../sandbox/appcontainer.ts";
import { imageSize } from "./fs-tools.ts";
import { MAX_RENDER_PIXELS, type CaptureOptions, type RenderCapture } from "./render-html-cdp.ts";
import type { RenderHtmlResources } from "./render-html-resources.ts";
import { staticHtmlDocument } from "./render-html-static-source.ts";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024 + 1;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

/** Capture sanitized HTML and CSS with the packaged off-screen tool in the zero-capability AppContainer. */
export async function captureWindowsStaticHtml(config: AppContainerConfig, resources: RenderHtmlResources,
	options: CaptureOptions, signal: AbortSignal): Promise<RenderCapture> {
	const html = Buffer.from(await staticHtmlDocument(resources, signal));
	const header = Buffer.alloc(20);
	header.writeInt32LE(options.width, 0);
	header.writeInt32LE(options.height, 4);
	header.writeInt32LE(options.waitMs, 8);
	header.writeInt32LE(options.fullPage ? 1 : 0, 12);
	header.writeInt32LE(html.length, 16);
	signal.throwIfAborted();
	const child = startAppContainerHtmlRenderer(config);
	const abort = addAbortListener(signal, () => { child.stdin?.destroy(); });
	try {
		const response = await new Promise<Buffer>((resolve, reject) => {
			const pieces: Buffer[] = [];
			let bytes = 0, diagnostic = "", oversized = false;
			child.stdout!.on("data", (part: Buffer) => {
				if (oversized) return;
				bytes += part.length;
				if (bytes > MAX_RESPONSE_BYTES) {
					oversized = true;
					child.stdin?.destroy();
					return;
				}
				pieces.push(part);
			});
			child.stderr!.on("data", (part: Buffer) => { diagnostic = (diagnostic + part.toString("utf8")).slice(0, 8000); });
			child.once("error", reject);
			child.stdin!.on("error", () => {});
			child.once("close", code => {
				if (signal.aborted) reject(signal.reason);
				else if (oversized) reject(new Error("截图浏览器输出过大。"));
				else if (code !== 0) reject(new Error("AppContainer HTML capture exited with " + code + ": " + diagnostic));
				else resolve(Buffer.concat(pieces, bytes));
			});
			// Keep stdin open after writing so the native runner still owns the Job's lifetime.
			child.stdin!.write(header);
			child.stdin!.write(html);
		});
		const flags = response[0];
		const png = response.subarray(1);
		const size = imageSize(png, "image/png");
		if ((flags !== 0 && flags !== 1) || !png.subarray(0, 8).equals(PNG_SIGNATURE) ||
			!size?.width || !size.height || size.width * size.height > MAX_RENDER_PIXELS) throw new Error("截图浏览器未返回有效的 PNG。");
		return { png, ...size, cropped: flags === 1, blocked: resources.publicBlocked() };
	} finally {
		child.stdin?.destroy();
		abort[Symbol.dispose]();
	}
}
