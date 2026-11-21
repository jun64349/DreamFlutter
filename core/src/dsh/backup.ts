import { Context } from "@deepseek-ai/cordis";
import type { FileAttachmentRef, ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import LocalAttachments from "@deepseek-ai/dsh-attachment-local";
import SessionStore from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import * as persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

/** One window transcript can refer to several native logs after editing a prior turn. */
export async function projectedDshIds(file: string, owner: string): Promise<Set<string>> {
	const ids = new Set([owner]);
	const input = createReadStream(file);
	const lines = createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (!line.includes('"df.dshBranch"') && !line.includes('"dfDsh"')) continue;
			const entry = JSON.parse(line);
			if (entry.type === "custom" && entry.customType === "df.dshBranch" && entry.data?.owner === owner) {
				if (typeof entry.data.id === "string") ids.add(entry.data.id);
				if (typeof entry.data.fork?.id === "string") ids.add(entry.data.fork.id);
			} else {
				const ref = entry.type === "message" ? entry.message?.dfDsh : entry.type === "compaction" ? entry.details?.dfDsh : undefined;
				if (typeof ref?.id === "string" && Number.isSafeInteger(ref.seq) && ref.seq >= 0) ids.add(ref.id);
			}
		}
	} finally { lines.close(); input.destroy(); }
	return ids;
}

/** Recreate the official log from its durable events, letting the installed
 * backend choose its format and the folder for the restored workspace. */
export async function copyDshHistories(source: string, target: string, options: {
	ids?: ReadonlySet<string>;
	mapCwd?: (cwd: string) => string;
	signal?: AbortSignal;
} = {}): Promise<void> {
	if (!existsSync(source) || options.ids?.size === 0) return;
	const from = new Context(), to = new Context();
	try {
		for (const [ctx, root] of [[from, source], [to, target]] as const) {
			await ctx.plugin(SessionStore);
			await ctx.plugin(persistence, { root, compression: "none" });
			await ctx.plugin(LocalAttachments, { dshHome: root });
		}
		const copied = new Set<string>();
		for (const { header } of await from.sessionPersistence.list({ signal: options.signal })) {
			if (options.ids && !options.ids.has(header.id)) continue;
			const reader = await from.sessionPersistence.open(header.id, "read", { signal: options.signal });
			try {
				const meta = reader.header;
				const moved = meta.cwd && options.mapCwd ? { ...meta, cwd: options.mapCwd(meta.cwd) } : meta;
				const writer = await to.sessionPersistence.create(moved, { inheritedEventCount: reader.inheritedEventCount });
				try {
					let offset = 0;
					for (;;) {
						options.signal?.throwIfAborted();
						const { events } = await reader.read(offset, 128, { signal: options.signal });
						if (!events.length) break;
						for (const event of events) await copyAttachments(event.data, from, to, copied, options.signal);
						await writer.append(events);
						offset += events.length;
					}
					await writer.flush();
				} finally {
					await writer.close();
				}
			} finally {
				await reader.close();
			}
		}
	} finally {
		try { await to.fiber.dispose(); } finally { await from.fiber.dispose(); }
	}
}

async function copyAttachments(value: unknown, from: Context, to: Context, copied: Set<string>, signal?: AbortSignal): Promise<void> {
	if (!value || typeof value !== "object") return;
	const block = value as { type?: string; attachment?: ImageAttachmentRef | FileAttachmentRef };
	const ref = block.attachment;
	if (ref && (block.type === "image" || block.type === "file")) {
		const key = JSON.stringify([block.type, ref.attachmentId, ref.name]);
		if (copied.has(key)) return;
		if (block.type === "image") {
			const image = await from.attachments.readImage(ref as ImageAttachmentRef, signal);
			const path = to.attachments.imageHostPath(image.ref);
			if (!path) throw new Error("无法定位会话图片的备份位置");
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, image.data);
		} else {
			const saved = await to.attachments.saveFileStream({
				name: ref.name, data: from.attachments.readFileStream(ref as FileAttachmentRef, signal), signal,
			});
			if (saved.attachmentId !== ref.attachmentId) throw new Error("会话附件校验失败");
		}
		copied.add(key);
		return;
	}
	for (const child of Object.values(value)) await copyAttachments(child, from, to, copied, signal);
}
