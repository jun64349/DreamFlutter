import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { APP_ROOT } from "../src/paths.ts";
import { loadEngine } from "../src/modules/voice/engine.ts";
import { LocalProvider } from "../src/modules/voice/local.ts";
import type { Transcript } from "../src/modules/voice/provider.ts";

const directory = join(APP_ROOT, "core/bin/voice");
const fixture = join(directory, "test_wavs/zh.wav");
const english = join(directory, "test_wavs/en.wav");
const skip = !existsSync(fixture) && process.env.DF_VOICE_OFFLINE !== "1";
let samplePcm: Buffer;
test("SenseVoice transcribes its official sample with Node network entry points disabled", {
	skip,
}, () => {
	const require = createRequire(import.meta.url);
	const deny = () => { throw new Error("Network disabled for local voice test"); };
	const replacements: Array<() => void> = [];
	for (const [name, methods] of [
		["node:net", ["connect", "createConnection"]],
		["node:tls", ["connect"]],
		["node:http", ["request", "get"]],
		["node:https", ["request", "get"]],
		["node:dgram", ["createSocket"]],
		["node:dns", ["lookup", "resolve"]],
	] as const) {
		const api = require(name);
		for (const method of methods) {
			const previous = api[method];
			api[method] = deny;
			replacements.push(() => { api[method] = previous; });
		}
	}
	const fetch = globalThis.fetch;
	globalThis.fetch = deny;
	syncBuiltinESMExports();
	try {
		assert.throws(() => require("node:net").connect(443), /Network disabled/);
		const baseline = process.memoryUsage.rss();
		const begin = performance.now();
		const engine = loadEngine(directory);
		const loadMs = performance.now() - begin;
		const loadedRssMiB = process.memoryUsage.rss() / 1048576;
		const audio = engine.readWave(fixture);
		assert.equal(audio.sampleRate, 16000);
		const pcm = Buffer.alloc(audio.samples.length * 2);
		for (const [i, sample] of audio.samples.entries()) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), i * 2);
		samplePcm = pcm;
		const results = [];
		const decodeAt = performance.now();
		for (let offset = 0; offset < pcm.length; offset += 4800) results.push(...engine.chunk(pcm.subarray(offset, offset + 4800)));
		results.push(...engine.end());
		const decodeMs = performance.now() - decodeAt;
		const text = results.filter(r => r.kind === "final").map(r => r.text).join("");
		assert.match(text, /^开饭时间早上9点至下午5点/);
		console.log(JSON.stringify({ loadMs, loadedRssMiB, rssDeltaMiB: loadedRssMiB - baseline / 1048576,
			afterDecodeRssMiB: process.memoryUsage.rss() / 1048576, decodeMs, audioSeconds: audio.samples.length / 16000, text }));
	} finally {
		globalThis.fetch = fetch;
		for (const restore of replacements) restore();
		syncBuiltinESMExports();
	}
});

test("the local provider uses the native worker and can reopen after unloading", { skip }, async () => {
	const provider = new LocalProvider(() => 10, directory);
	const abort = new AbortController();
	const results: Transcript[] = [];
	const input = { hotwords: [], signal: abort.signal, emit: (event: Transcript) => results.push(event), fail: assert.fail };
	try {
		const stream = await provider.open(input);
		for (let offset = 0; offset < samplePcm.length; offset += 4800) await stream.chunk(samplePcm.subarray(offset, offset + 4800));
		await stream.end();
		assert.match(results.filter(result => result.kind === "final").map(result => result.text).join(""), /^开饭时间早上9点至下午5点/);
		provider.dispose();
		const reopened = await provider.open(input);
		reopened.cancel();
	} finally { provider.dispose(); }
});

test("SenseVoice keeps sentence starts and digits across different input chunk sizes", {
	skip: !existsSync(english) && process.env.DF_VOICE_OFFLINE !== "1",
}, () => {
	const engine = loadEngine(directory);
	for (const [file, wholeText] of [
		[fixture, "开饭时间早上9点至下午5点"],
		[english, "The tribal chieftain called for the boy and presented him with 50 pieces of code"],
	]) {
		const audio = engine.readWave(file);
		assert.equal(audio.sampleRate, 16_000);
		const pcm = Buffer.alloc(audio.samples.length * 2);
		for (const [i, sample] of audio.samples.entries()) {
			pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), i * 2);
		}
		for (const ms of [100, 200, 400]) {
			engine.reset();
			const output: Transcript[] = [];
			const bytes = 32 * ms;
			for (let i = 0; i < pcm.length; i += bytes) output.push(...engine.chunk(pcm.subarray(i, i + bytes)));
			output.push(...engine.end());
			assert.equal(output.filter(item => item.kind === "final").map(item => item.text).join("").replace(/[。.]$/, ""), wholeText, `${file}, ${ms} ms`);
		}
	}
});

