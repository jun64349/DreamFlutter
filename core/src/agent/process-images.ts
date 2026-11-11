import { AsyncLocalStorage } from "node:async_hooks";
import type { ImageContent } from "@earendil-works/pi-ai";
import { resizeImage, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { imageSize } from "./fs-tools.ts";
import { PYTHON_BACKGROUND_RESULT } from "./python-kernel.ts";

type CapturedImage = { image: ImageContent; path: string };
const childImages = new AsyncLocalStorage<CapturedImage[]>();
const MAX_DIMENSION = 1536;
const MAX_BYTES = 2 * 1024 * 1024;

function imagePaths(details: unknown): string[] {
	if (!details || typeof details !== "object") return [];
	const { imagePaths, path } = details as { imagePaths?: unknown; path?: unknown };
	if (Array.isArray(imagePaths)) return imagePaths.map(value => typeof value === "string" ? value : "");
	return typeof path === "string" ? [path] : [];
}

async function compactImage(image: ImageContent): Promise<ImageContent> {
	const bytes = Buffer.from(image.data, "base64");
	const dimensions = imageSize(bytes, image.mimeType);
	if (bytes.length <= MAX_BYTES && (!dimensions || (dimensions.width <= MAX_DIMENSION && dimensions.height <= MAX_DIMENSION))) return image;
	const preview = await resizeImage(bytes, image.mimeType, { maxWidth: MAX_DIMENSION, maxHeight: MAX_DIMENSION, maxBytes: MAX_BYTES });
	if (!preview) throw new Error("图片无法生成预览，原文件仍在原处。");
	return { type: "image", data: preview.data, mimeType: preview.mimeType };
}

/** Only this projection changes when a text-only model sees the conversation. */
export function textOnlyProcessImageView<T>(message: T): T {
	const value = message as { role?: string; customType?: string; content?: unknown; details?: unknown; toolName?: string };
	if ((value.role !== "toolResult" && value.customType !== PYTHON_BACKGROUND_RESULT) || !Array.isArray(value.content)) return message;
	const paths = imagePaths(value.details);
	let index = 0;
	const content = value.content.map(block => {
		if (block?.type !== "image") return block;
		const path = paths[index++] || (value.toolName === "read_image" ? "图片文件" : "工具生成的图片");
		return { type: "text", text: "已生成图片：" + path + "（当前模型看不到图片）" };
	});
	return index ? { ...value, content } as T : message;
}

export function registerProcessImageHooks(pi: ExtensionAPI): void {
	pi.on("context", (event, ctx) => {
		if (ctx.model?.input?.includes("image")) return;
		return { messages: event.messages.map(textOnlyProcessImageView) };
	});
	pi.on("tool_result", async event => {
		if (!event.content.some(block => block.type === "image")) return;
		const paths = imagePaths(event.details);
		const capture = childImages.getStore();
		const content: typeof event.content = [];
		let index = 0;
		for (const block of event.content) {
			if (block.type !== "image") { content.push(block); continue; }
			const path = paths[index++] ?? "";
			try {
				const image = await compactImage(block);
				content.push(image);
				if (capture) capture.push({ image, path });
			} catch {
				content.push({ type: "text", text: "图片预览无法生成" + (path ? "：" + path : "。") });
			}
		}
		return { content, details: event.details, structuredContent: event.structuredContent };
	});
}

/** Decorate the registered parent tool so parallel child sessions return only their own images. */
export function withSubagentImages(factory: ExtensionFactory): ExtensionFactory {
	return pi => factory({
		...pi,
		registerTool(tool) {
			if (tool.name !== "agent") { pi.registerTool(tool); return; }
			pi.registerTool({
				...tool,
				async execute(...args) {
					const images: CapturedImage[] = [];
					const result = await childImages.run(images, () => tool.execute(...args));
					if (!images.length) return result;
					return { ...result, content: [...result.content, ...images.map(({ image }) => image)],
						details: { ...result.details, imagePaths: images.map(({ path }) => path) } };
				},
			});
		},
	});
}
