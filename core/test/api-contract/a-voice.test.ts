import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { join } from "node:path";
import { test } from "node:test";
import { RpcError } from "../../src/core.ts";
import { LocalProvider } from "../../src/modules/voice/local.ts";
import { VoiceModule } from "../../src/modules/voice/index.ts";
import type { VoiceProvider } from "../../src/modules/voice/provider.ts";
import { expectKeys, expectRpcError, startContractHarness } from "./harness.ts";

test("voice RPCs validate ownership and audio, deliver ordered private events and release the session", async t => {
	const api = await startContractHarness(t);
	const module = api.core.module(VoiceModule)!;
	const providers = (module as unknown as { providers: Map<string, VoiceProvider> }).providers;
	providers.set("local", {
		async open(input) {
			return {
				async chunk() { input.emit({ kind: "partial", text: "123" }); },
				async end() { input.emit({ kind: "final", text: "123" }); },
				cancel() {},
			};
		},
	});
	const second = await api.connect();
	const from = api.events.length;
	const otherFrom = second.events.length;
	await expectRpcError(api.call("voice.start", { workspaceId: 123 }), "invalid_params");
	const session = await api.call<{ sessionId: string }>("voice.start");
	expectKeys(session, ["sessionId"]);
	await expectRpcError(second.call("voice.start"), "busy");
	const pcm = Buffer.alloc(3200).toString("base64");
	for (const method of ["voice.chunk", "voice.end", "voice.cancel"]) {
		await expectRpcError(second.call(method, { ...session, pcm }), "not_found");
	}
	await expectRpcError(api.call("voice.chunk", { ...session, pcm: "bad" }), "invalid_params");
	assert.deepEqual(await api.call("voice.chunk", { ...session, pcm }), { accepted: true });
	assert.deepEqual(await api.call("voice.end", session), { ended: true });
	assert.deepEqual(api.events.slice(from).filter(e => e.event.startsWith("voice.")), [
		{ event: "voice.partial", ...session, text: "123" },
		{ event: "voice.final", ...session, rawText: "123", text: "123." },
	]);
	assert.deepEqual(second.events.slice(otherFrom).filter(e => e.event.startsWith("voice.")), []);
	const empty = await api.call<{ sessionId: string }>("voice.start");
	await expectRpcError(api.call("voice.end", empty), "invalid_params");
	const error = await api.waitForEvent("voice.error", e => e.sessionId === empty.sessionId, from);
	expectKeys(error, ["event", "sessionId", "code", "message"]);
	assert.equal(error.code, "invalid_params");
	const cancel = await api.call<{ sessionId: string }>("voice.start");
	assert.deepEqual(await api.call("voice.cancel", cancel), { cancelled: true });
	await expectRpcError(api.call("voice.cancel", cancel), "not_found");
	assert.deepEqual(api.events.slice(from).filter(e => e.event.startsWith("voice.")).map(e => e.event),
		["voice.partial", "voice.final", "voice.error"]);
});

test("voice keys use an isolated credential directory and uninstall rejects development mode", async t => {
	const api = await startContractHarness(t);
	const module = api.core.module(VoiceModule)!;
	const providers = (module as unknown as { providers: Map<string, VoiceProvider> }).providers;
	providers.set("local", new LocalProvider(() => 1, join(api.dir, "missing-voice-model")));
	await expectRpcError(api.call("voice.start"), "model_unavailable");
	await api.call("settings.update", { voiceMode: "cloud" });
	await expectRpcError(api.call("voice.start"), "unavailable");
	for (const method of ["voice.start", "voice.chunk", "voice.end", "voice.cancel", "voice.setKey", "voice.keyStatus"])
		await assert.rejects(api.core.call(method, {}), { code: "forbidden" });
	assert.deepEqual(await api.call("voice.keyStatus"), { configured: false });
	await expectRpcError(api.call("voice.setKey", { key: "含空格 key" }), "invalid_params");
	if (process.platform === "win32") {
		assert.deepEqual(await api.call("voice.setKey", { key: "T132A_VOICE_KEY" }), { configured: true });
		assert.deepEqual(await api.call("voice.keyStatus"), { configured: true });
	}
	assert.deepEqual(await api.call("voice.setKey", { key: null }), { configured: false });
	await expectRpcError(api.call("uninstall.preview"), "unavailable");
	assert.deepEqual(await api.call("uninstall.preservedData"), { candidates: [] });
	await expectRpcError(api.call("uninstall.restorePreservedData", { path: join(api.dir, "nonexistent") }), "unavailable");
	for (const method of ["uninstall.preview", "uninstall.preservedData", "uninstall.restorePreservedData"])
		await assert.rejects(api.core.call(method, {}), { code: "forbidden" });
});

test("voice reports provider failures and cancellation over the authenticated connection", async t => {
	const api = await startContractHarness(t);
	const module = api.core.module(VoiceModule)!;
	const providers = (module as unknown as { providers: Map<string, VoiceProvider> }).providers;
	const signals = new EventEmitter();
	let release: (() => void) | undefined;
	t.after(() => release?.());
	providers.set("local", {
		async open(input) {
			return {
				chunk: () => new Promise((_resolve, reject) => {
					input.signal.addEventListener("abort", () => reject(new RpcError("cancelled", "fixture cancelled")), { once: true });
					release = () => reject(new RpcError("unavailable", "fixture provider failure"));
					signals.emit("audio");
				}),
				async end() { throw new RpcError("unavailable", "fixture end failure"); },
				cancel() {},
			};
		},
	});
	const pcm = Buffer.alloc(3200).toString("base64");
	const run = async (cancel: boolean) => {
		const at = api.events.length;
		const session = await api.call<{ sessionId: string }>("voice.start");
		const begun = once(signals, "audio");
		const result = expectRpcError(api.call("voice.chunk", { ...session, pcm }), cancel ? "cancelled" : "unavailable");
		await begun;
		await expectRpcError(api.call("voice.chunk", { ...session, pcm }), "busy");
		await expectRpcError(api.call("voice.end", session), "busy");
		if (cancel) assert.deepEqual(await api.call("voice.cancel", session), { cancelled: true });
		else release!();
		await result;
		const failures = api.events.slice(at).filter(e => e.event === "voice.error");
		assert.deepEqual(failures, cancel ? [] : [{ event: "voice.error", ...session, code: "unavailable", message: "fixture provider failure" }]);
	};
	await run(false);
	await run(true);
	providers.set("local", { async open() {
		return { async chunk() {}, async end() { throw new RpcError("unavailable", "fixture end failure"); }, cancel() {} };
	} });
	const session = await api.call<{ sessionId: string }>("voice.start");
	await api.call("voice.chunk", { ...session, pcm });
	const at = api.events.length;
	await expectRpcError(api.call("voice.end", session), "unavailable");
	assert.deepEqual(api.events.slice(at).filter(e => e.event === "voice.error"),
		[{ event: "voice.error", ...session, code: "unavailable", message: "fixture end failure" }]);
});
