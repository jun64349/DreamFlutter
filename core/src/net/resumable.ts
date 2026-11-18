import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Large on-demand downloads (0.13.1 step 3: the voice model, 蝶君's sandbox image).
 * Uses the global fetch, which follows the user's proxy setting (pi/http.ts), tries
 * each source in turn, resumes a partial file and only keeps a file whose size and
 * SHA-256 match.
 */
export type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
export interface Wanted { bytes: number; sha256: string; sources: string[] }

export async function downloadVerified(wanted: Wanted, path: string, options: {
	onProgress?: (received: number, total: number) => void;
	signal?: AbortSignal;
	fetchImpl?: Fetch;
} = {}): Promise<void> {
	const partial = `${path}.part`;
	const signal = options.signal ?? new AbortController().signal;
	const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
	const failures: string[] = [];
	for (const url of wanted.sources) {
		try {
			await fetchInto(url, partial, wanted.bytes, fetchImpl, signal, options.onProgress);
			if (statSync(partial).size !== wanted.bytes || await sha256(partial) !== wanted.sha256) {
				rmSync(partial, { force: true });
				throw new Error("校验不符");
			}
			renameSync(partial, path);
			return;
		} catch (error) {
			if (signal.aborted) throw error;
			failures.push(`${new URL(url).host}：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(failures.join("；"));
}

/** Appends to [partial] from where an earlier attempt stopped. */
async function fetchInto(url: string, partial: string, total: number, fetchImpl: Fetch, signal: AbortSignal,
	onProgress?: (received: number, total: number) => void): Promise<void> {
	let have = existsSync(partial) ? statSync(partial).size : 0;
	if (have > total) { rmSync(partial, { force: true }); have = 0; }
	if (have === total) return;
	const response = await fetchImpl(url, { headers: { "User-Agent": "DreamFlutter", ...(have ? { Range: `bytes=${have}-` } : {}) }, signal });
	if (response.status === 200) have = 0;
	else if (response.status !== 206) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
	if (!response.body) throw new Error("没有内容");
	let received = have;
	onProgress?.(received, total);
	const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
	body.on("data", (chunk: Buffer) => { received += chunk.length; onProgress?.(received, total); });
	await pipeline(body, createWriteStream(partial, { flags: have ? "a" : "w" }));
}

export function sha256(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		createReadStream(path).on("data", chunk => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
	});
}
