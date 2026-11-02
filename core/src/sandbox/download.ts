import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { request } from "node:https";
import { request as httpRequest } from "node:http";

/**
 * Plain HTTP(S) downloads that never go through a proxy: the sandbox's base
 * image and checksums come from domestic mirrors, which the user's proxy
 * cannot reach (user, 2026-11-02: 「直接直连下载就好了」). Pi's fetch uses the
 * proxy from the environment, so this uses node:https directly.
 */

function get(url: string, timeoutMs: number): Promise<import("node:http").IncomingMessage> {
	return new Promise((resolve, reject) => {
		const lib = url.startsWith("https:") ? request : httpRequest;
		const req = lib(url, { method: "GET", headers: { "User-Agent": "DreamFlutter" } }, resolve);
		req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs} ms: ${url}`)));
		req.on("error", reject);
		req.end();
	});
}

/** Follows redirects; rejects on anything but 200. */
async function open(url: string, timeoutMs: number, hops = 5): Promise<import("node:http").IncomingMessage> {
	const response = await get(url, timeoutMs);
	const status = response.statusCode ?? 0;
	if (status >= 300 && status < 400 && response.headers.location && hops > 0) {
		response.resume();
		return open(new URL(response.headers.location, url).toString(), timeoutMs, hops - 1);
	}
	if (status !== 200) {
		response.resume();
		throw new Error(`HTTP ${status}: ${url}`);
	}
	return response;
}

export async function fetchText(url: string, timeoutMs = 10_000): Promise<string> {
	const response = await open(url, timeoutMs);
	const chunks: Buffer[] = [];
	for await (const chunk of response) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

/** Downloads [url] to [path] (through a temporary file) and returns its SHA-256. */
export async function downloadFile(url: string, path: string, onProgress?: (received: number, total: number) => void, timeoutMs = 30_000): Promise<string> {
	const response = await open(url, timeoutMs);
	const total = Number(response.headers["content-length"] ?? 0);
	const hash = createHash("sha256");
	const partial = `${path}.part`;
	const out = createWriteStream(partial);
	let received = 0;
	try {
		await new Promise<void>((resolve, reject) => {
			response.on("data", (chunk: Buffer) => {
				hash.update(chunk);
				received += chunk.length;
				onProgress?.(received, total);
			});
			response.on("error", reject);
			out.on("error", reject);
			out.on("finish", resolve);
			response.pipe(out);
		});
	} catch (error) {
		out.destroy();
		await rm(partial, { force: true });
		throw error;
	}
	await rename(partial, path);
	return hash.digest("hex");
}

/** Bytes per second fetching up to [maxBytes] of [url]; 0 when it fails or times out (for picking the fastest mirror). */
export async function probeSpeed(url: string, maxBytes = 1_000_000, timeoutMs = 8_000): Promise<number> {
	const started = Date.now();
	let received = 0;
	try {
		const response = await open(url, timeoutMs);
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				response.destroy();
				resolve();
			};
			const timer = setTimeout(done, timeoutMs);
			response.on("data", (chunk: Buffer) => {
				received += chunk.length;
				if (received >= maxBytes) done();
			});
			response.on("end", done);
			response.on("error", done);
		});
	} catch {
		return 0;
	}
	return received / Math.max(0.05, (Date.now() - started) / 1000);
}
