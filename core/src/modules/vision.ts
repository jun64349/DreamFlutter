import { createHash } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Core, CoreModule } from "../core.ts";
import { now } from "../db.ts";
import type { Llm } from "./llm.ts";

type Block = { type: string; text?: string; data?: string; mimeType?: string };

const DESCRIBE_PROMPT =
	"请把这张图片完整地转述成文字，供一个看不到图片的助手使用。先一句话说明这是什么图，然后描述所有可见内容：文字（逐字抄录，保留排版和代码）、界面元素、表格数据、图表的坐标和数值、人物和物体、颜色和布局。不要猜测看不到的内容，不要加评论。";

export function imageHash(data: string): string {
	return createHash("sha256").update(data, "utf8").digest("hex");
}

export interface ImageDescription {
	hash: string;
	model: string;
	text: string;
}

/**
 * Images for models without vision (plan §C2): before each model call, every
 * image in the context is replaced by a description from a model that can
 * see (settings.visionModel, else one picked automatically). Descriptions are
 * cached by image hash; the session itself keeps the images, so the window
 * still shows them and notes "图片由 X 转述". Models that read images get
 * them untouched.
 */
export class VisionModule implements CoreModule {
	private readonly core: Core;
	private readonly llm: Llm;
	/** In-flight descriptions, so one image is described once. */
	private readonly pending = new Map<string, Promise<ImageDescription | null>>();

	constructor(core: Core, llm: Llm) {
		this.core = core;
		this.llm = llm;
		core.register("vision.lookup", (params) => {
			const hashes = Array.isArray(params.hashes) ? params.hashes.filter((h): h is string => typeof h === "string").slice(0, 200) : [];
			const out: Record<string, ImageDescription> = {};
			for (const hash of hashes) {
				const row = this.cached(hash);
				if (row) out[hash] = row;
			}
			return out;
		});
	}

	private cached(hash: string): ImageDescription | undefined {
		return this.core.db.get<ImageDescription>("SELECT hash, model, text FROM image_descriptions WHERE hash = ?", hash);
	}

	/** The model that describes images: the setting, else the default/aux model if it sees, else any that does. */
	async visionModel(): Promise<Model<never> | undefined> {
		const runtime = await this.llm.runtime();
		const available = (await runtime.getAvailable()) as Model<never>[];
		const find = (key: string | null) => {
			if (!key) return undefined;
			const slash = key.indexOf("/");
			return available.find((m) => m.provider === key.slice(0, slash) && m.id === key.slice(slash + 1));
		};
		const { visionModel, defaultModel, auxModel } = this.core.settings.get();
		if (visionModel) return find(visionModel);
		for (const key of [defaultModel, auxModel]) {
			const model = find(key);
			if (model?.input.includes("image")) return model;
		}
		return available.find((m) => m.input.includes("image") && m.provider !== "dreamflutter") ?? available.find((m) => m.input.includes("image"));
	}

	async describe(data: string, mimeType: string, model: Model<never>, signal?: AbortSignal): Promise<ImageDescription | null> {
		const hash = imageHash(data);
		const hit = this.cached(hash);
		if (hit) return hit;
		const running = this.pending.get(hash);
		if (running) return running;
		const job = (async () => {
			try {
				const text = await this.llm.complete(
					[
						{ type: "image", data, mimeType },
						{ type: "text", text: DESCRIBE_PROMPT },
					],
					{ model, maxTokens: 2048, timeoutMs: 120_000 },
				);
				if (signal?.aborted || !text.trim()) return null;
				const label = model.name ?? `${model.provider}/${model.id}`;
				this.core.db.run("INSERT OR REPLACE INTO image_descriptions(hash, model, text, created_at) VALUES(?, ?, ?, ?)", hash, label, text.trim(), now());
				return { hash, model: label, text: text.trim() };
			} catch (error) {
				this.core.log.warn("describing an image failed", error);
				return null;
			} finally {
				this.pending.delete(hash);
			}
		})();
		this.pending.set(hash, job);
		return job;
	}

	extensions(slot: { slotId: string }): ExtensionFactory[] {
		const module = this;
		return [
			(pi: ExtensionAPI) => {
				pi.on("context", async (event, ctx) => {
					const model = ctx.model;
					if (!model || model.input.includes("image")) return undefined;
					const images: Block[] = [];
					for (const message of event.messages as { role?: string; content?: unknown }[]) {
						if (!Array.isArray(message.content)) continue;
						for (const block of message.content as Block[]) if (block?.type === "image" && typeof block.data === "string") images.push(block);
					}
					if (!images.length) return undefined;
					const vision = await module.visionModel();
					if (!vision || !vision.input.includes("image")) {
						module.core.broadcast({ event: "vision.missing", slotId: slot.slotId, model: `${model.provider}/${model.id}` });
						return undefined;
					}
					const described = new Map<string, ImageDescription | null>();
					const fresh: string[] = [];
					for (const image of images) {
						const hash = imageHash(image.data!);
						if (described.has(hash)) continue;
						const known = module.cached(hash);
						if (!known) fresh.push(hash);
						described.set(hash, known ?? (await module.describe(image.data!, image.mimeType ?? "image/png", vision, ctx.signal)));
					}
					if (fresh.length) {
						module.core.broadcast({ event: "vision.relayed", slotId: slot.slotId, hashes: fresh, model: vision.name ?? vision.id });
					}
					let n = 0;
					const messages = (event.messages as { content?: unknown }[]).map((message) => {
						if (!Array.isArray(message.content) || !(message.content as Block[]).some((b) => b?.type === "image")) return message;
						const content = (message.content as Block[]).map((block) => {
							if (block?.type !== "image" || typeof block.data !== "string") return block;
							n++;
							const d = described.get(imageHash(block.data));
							return {
								type: "text",
								text: d ? `[图片 ${n}，当前模型看不到图片，以下是 ${d.model} 的文字转述]\n${d.text}\n[图片 ${n} 转述结束]` : `[图片 ${n}：转述失败，看不到这张图片的内容]`,
							};
						});
						return { ...message, content };
					});
					return { messages: messages as never };
				});
			},
		];
	}
}
