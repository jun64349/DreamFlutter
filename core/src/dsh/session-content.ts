import type { Context } from "@deepseek-ai/cordis";
import { AttachmentStore, type ImageAttachmentRef, type SaveImageAttachment, type StoredImageAttachment } from "@deepseek-ai/dsh-attachment";
import { prepareImageFile, type LocalAttachmentStore } from "@deepseek-ai/dsh-attachment-local";
import type { ContentBlock, ImageBlock } from "@deepseek-ai/dsh-llm";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export function readWireImages(rawImages: unknown): ImageContent[] | undefined {
	if (rawImages === undefined) return undefined;
	if (!Array.isArray(rawImages)) throw new Error("图片附件不合法");
	return rawImages.map((image: unknown) => {
		if (!image || typeof image !== "object" || !("data" in image) || typeof image.data !== "string" ||
			!("mimeType" in image) || typeof image.mimeType !== "string") throw new Error("图片附件不合法");
		return { type: "image", data: image.data, mimeType: image.mimeType };
	});
}

/** Uses the same raster admission policy without materializing private attachments. */
export class DshMemoryAttachments extends AttachmentStore {
	readonly imageLimits: LocalAttachmentStore["imageLimits"];
	private readonly policy: LocalAttachmentStore["normalizationPolicy"];
	private readonly images = new Map<string, StoredImageAttachment>();

	constructor(ctx: Context, local: LocalAttachmentStore) {
		super(ctx);
		this.imageLimits = local.imageLimits;
		this.policy = local.normalizationPolicy;
	}

	async validateImage(input: SaveImageAttachment): Promise<void> {
		await prepareImageFile(input, this.imageLimits, this.policy);
	}

	async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
		const prepared = await prepareImageFile(input, this.imageLimits, this.policy);
		this.images.set(prepared.ref.attachmentId, prepared);
		return prepared.ref;
	}

	async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
		signal?.throwIfAborted();
		const image = this.images.get(ref.attachmentId);
		if (!image) throw new Error("找不到临时图片");
		return image;
	}

	clear(): void { this.images.clear(); }
}

/** The current window still uses inline blocks. */
export class DshSlotContent {
	private readonly images = new Map<string, { image: ImageContent; uses: number }>();
	private readonly attachments: Context["attachments"];

	constructor(attachments: Context["attachments"]) { this.attachments = attachments; }
	get attachmentStore(): AttachmentStore { return this.attachments; }
	clear(): void {
		this.images.clear();
		if (this.attachments instanceof DshMemoryAttachments) this.attachments.clear();
	}

	async admit(text: string, images: ImageContent[] = []): Promise<ContentBlock[]> {
		return this.toDsh([...(text ? [{ type: "text" as const, text }] : []), ...images]);
	}

	async toDsh(content: readonly (TextContent | ImageContent)[]): Promise<ContentBlock[]> {
		const admitted = await this.attachments.admitPromptContent(content.map(block => {
			if (block.type === "text") return block;
			const mediaType = this.attachments.imageLimits.mediaTypes.find(type => type === block.mimeType);
			if (!mediaType) throw new Error(`不支持的图片格式 ${block.mimeType}`);
			return { type: "image", data: block.data, mediaType };
		}));
		for (const [index, block] of admitted.entries()) {
			const original = content[index];
			if (block.type === "image" && original?.type === "image") this.retain(block, original);
		}
		return admitted;
	}

	async restore(blocks: readonly ContentBlock[]): Promise<void> {
		for (const block of blocks) {
			if (block.type !== "image") continue;
			const cached = this.images.get(block.attachment.attachmentId);
			if (cached) cached.uses++;
			else {
				const { data, ref } = await this.attachments.readImage(block.attachment);
				this.retain(block, { type: "image", mimeType: ref.mediaType, data: Buffer.from(data).toString("base64") });
			}
		}
	}

	fromDsh(blocks: readonly ContentBlock[]): (TextContent | ImageContent)[] {
		return blocks.flatMap((block): (TextContent | ImageContent)[] => {
			if (block.type === "text") return [block];
			if (block.type === "image") return [this.image(block)];
			return [];
		});
	}

	private image(block: ImageBlock): TextContent | ImageContent {
		const cached = this.images.get(block.attachment.attachmentId);
		if (!cached) return { type: "text", text: "[图片附件]" };
		this.release([block]);
		return cached.image;
	}

	release(blocks: readonly ContentBlock[]): void {
		for (const block of blocks) {
			if (block.type !== "image") continue;
			const id = block.attachment.attachmentId;
			const cached = this.images.get(id);
			if (cached && --cached.uses === 0) this.images.delete(id);
		}
	}

	private retain(block: ImageBlock, image: ImageContent): void {
		const id = block.attachment.attachmentId;
		const cached = this.images.get(id);
		if (cached) cached.uses++;
		else this.images.set(id, { image, uses: 1 });
	}
}
