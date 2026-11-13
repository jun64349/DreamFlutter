import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { BailianProvider } from "../src/modules/voice/bailian.ts";
import { correctHotwords, memoryHotwords } from "../src/modules/voice/hotwords.ts";
import { VoiceModule, type VoiceEvent } from "../src/modules/voice/index.ts";
import { SecretStore } from "../src/modules/secrets.ts";
import type { VoiceInput, VoiceProvider } from "../src/modules/voice/provider.ts";
import { startServer } from "../src/server.ts";
import { startTestCore } from "./harness.ts";

test("voice matches pronunciation conservatively and preserves ordinary words", () => {
	assert.equal(correctHotwords("请让叠军打开 dream flutter，今天下午开会", ["蝶君", "DreamFlutter"]), "请让蝶君打开 DreamFlutter，今天下午开会");
	assert.equal(correctHotwords("联络里明", ["李明", "礼明"]), "联络里明");
});

test("voice service is registered, validates PCM, scopes events and releases disconnected owners", async () => {
	const t = await startTestCore();
	const token = "t130";
	const server = await startServer(t.core, { port: 0, token });
	const sockets: WebSocket[] = [];
	const messages: Record<string, unknown>[] = [];
	let cancelled = 0;
	const provider: VoiceProvider = {
		async open(input) {
			return {
				async chunk() { input.emit({ kind: "partial", text: "叠军" }); },
				async end() { input.emit({ kind: "final", text: "叠军" }); },
				cancel() { cancelled++; },
			};
		},
	};
	const fake = new VoiceModuleProxy(t.core.module(VoiceModule)!, provider);
	try {
		const connect = async () => {
			const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { headers: { Authorization: `Bearer ${token}` } });
			sockets.push(socket);
			await once(socket, "open");
			return socket;
		};
		let sequence = 0;
		const call = (socket: WebSocket, method: string, params: object = {}) => new Promise<any>(resolve => {
			const id = ++sequence;
			const listener = (raw: Buffer) => {
				const reply = JSON.parse(raw.toString());
				if (reply.id === id) { socket.off("message", listener); resolve(reply); }
			};
			socket.on("message", listener);
			socket.send(JSON.stringify({ id, method, params }));
		});
		const a = await connect();
		const b = await connect();
		a.on("message", raw => { const msg = JSON.parse(raw.toString()); if (msg.event) messages.push(msg); });
		const otherEvents: unknown[] = [];
		b.on("message", raw => { const msg = JSON.parse(raw.toString()); if (msg.event) otherEvents.push(msg); });
		const { sessionId } = (await call(a, "voice.start")).result;
		assert.equal((await call(b, "voice.start")).error.code, "busy");
		assert.equal((await call(b, "voice.cancel", { sessionId })).error.code, "not_found");
		assert.equal((await call(a, "voice.chunk", { sessionId, pcm: "bad" })).error.code, "invalid_params");
		assert.deepEqual((await call(a, "voice.chunk", { sessionId, pcm: Buffer.alloc(4800).toString("base64") })).result, { accepted: true });
		assert.deepEqual((await call(a, "voice.end", { sessionId })).result, { ended: true });
		assert.deepEqual(messages, [
			{ event: "voice.partial", sessionId, text: "叠军" },
			{ event: "voice.final", sessionId, rawText: "叠军", text: "蝶君。" },
		]);
		assert.deepEqual(otherEvents, []);
		const pending = (await call(a, "voice.start")).result;
		assert.ok(pending.sessionId);
		a.close();
		await once(a, "close");
		for (let i = 0; i < 30 && cancelled < 2; i++) await delay(20);
		assert.equal(cancelled, 2);
		const session = (await call(b, "voice.start")).result;
		assert.equal((await call(b, "voice.end", session)).error.code, "invalid_params");
		assert.equal(otherEvents.length, 1);

		const events: VoiceEvent[] = [];
		const owner = (event: VoiceEvent) => events.push(event);
		const internal = await fake.module.startRecognition(owner);
		await fake.module.chunk(owner, internal.sessionId, Buffer.alloc(3200));
		await fake.module.end(owner, internal.sessionId);
		assert.equal(events.at(-1)?.event, "voice.final");
	} finally {
		for (const socket of sockets) socket.terminate();
		await server.close();
		await t.cleanup();
	}
});

// The production registry stays intact; only provider.open is replaced by the test.
class VoiceModuleProxy {
	readonly module: VoiceModule;
	constructor(module: VoiceModule, provider: VoiceProvider) {
		this.module = module;
		const registry = (module as unknown as { providers: Map<string, VoiceProvider> }).providers;
		registry.set("local", provider);
	}
}

test("memory vocabulary stays bounded and uses active scoped explicit names", async () => {
	const t = await startTestCore();
	try {
		const insert = (id: string, content: string, scope: string, workspace: string | null, status: string, uses: number) => t.core.db.run(`
			INSERT INTO memory_items(id, version, level, kind, content, scope, workspace_id, status, confidence, use_count, created_at, updated_at, created_by)
			VALUES(?, 1, 2, 'background', ?, ?, ?, ?, 'high', ?, 1, 1, 'user')
		`, id, content, scope, workspace, status, uses);
		insert("a", "项目名：青鸟", "global", null, "active", 9);
		insert("b", "人名：李明", "workspace", "my-project", "active", 8);
		insert("c", "术语：白松", "workspace", "another", "active", 7);
		insert("d", "术语：已过期", "global", null, "archived", 6);
		assert.deepEqual(memoryHotwords(t.core, "my-project"), ["蝶君", "梦蝶", "DreamFlutter", "青鸟", "李明"]);
	} finally { await t.cleanup(); }
});

test("voice Key uses the existing DPAPI store and stays out of settings and log", { skip: process.platform !== "win32" }, async () => {
	const t = await startTestCore();
	const key = "test-only-t130-secret";
	try {
		const client = t.core.addClient(() => {});
		assert.deepEqual(await t.core.call("voice.setKey", { key }, client), { configured: true });
		const secrets = new SecretStore(t.core.paths.dataDir);
		assert.equal(await secrets.get("voice-bailian"), key);
		assert.doesNotMatch(readFileSync(secrets.fileFor("voice-bailian"), "utf8"), /test-only-t130-secret/);
		for (const file of [t.core.paths.dbFile, t.core.paths.dbFile + "-wal", t.core.paths.logFile]) {
			if (existsSync(file)) assert.equal(readFileSync(file).includes(key), false);
		}
		assert.deepEqual(await t.core.call("voice.setKey", { key: null }, client), { configured: false });
	} finally { await t.cleanup(); }
});

for (const scenario of ["normal", "http-auth", "ws-auth", "network", "timeout"] as const) {
	test(`Bailian loopback protocol: ${scenario}`, async () => {
		const actions: string[] = [];
		const violations: unknown[] = [];
		const events: string[] = [];
		const failure: string[] = [];
		const server = createServer(async (req, res) => {
			try {
				assert.equal(req.headers.authorization, "Bearer local-fake");
				const chunks: Buffer[] = [];
				for await (const chunk of req) chunks.push(Buffer.from(chunk));
				const body = JSON.parse(Buffer.concat(chunks).toString());
				assert.equal(body.model, "speech-biasing");
				actions.push(body.input.action);
				if (scenario === "http-auth") { res.writeHead(401).end(); return; }
				if (body.input.action === "create_vocabulary") {
					assert.equal(body.input.target_model, "paraformer-realtime-v2");
					assert.deepEqual(body.input.vocabulary, [{ text: "蝶君", weight: 4 }]);
				} else assert.equal(body.input.vocabulary_id, "local-vocab");
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ output: { vocabulary_id: "local-vocab" } }));
			} catch (error) { violations.push(error); res.writeHead(500).end(); }
		});
		const wss = new WebSocketServer({ noServer: true });
		server.on("upgrade", (req, socket, head) => {
			try {
				assert.equal(req.headers.authorization, "Bearer local-fake");
				if (scenario === "ws-auth") { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
				wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws));
			} catch (error) { violations.push(error); socket.destroy(); }
		});
		wss.on("connection", (ws: WebSocket) => {
			let task: string;
			const send = (event: string, payload?: object) => ws.send(JSON.stringify({ header: { task_id: task, event }, payload }));
			ws.on("message", (raw: Buffer, binary: boolean) => {
				try {
					if (binary) {
						assert.equal(raw.length, 4800);
						if (scenario === "network") { ws.terminate(); return; }
						send("result-generated", { output: { sentence: { text: "蝶", sentence_end: false } } });
						return;
					}
					const msg = JSON.parse(raw.toString());
					task = msg.header.task_id;
					assert.equal(msg.header.streaming, "duplex");
					if (msg.header.action === "run-task") {
						assert.equal(msg.payload.parameters.vocabulary_id, "local-vocab");
						assert.equal(msg.payload.parameters.sample_rate, 16000);
						if (scenario !== "timeout") send("task-started");
					} else {
						assert.equal(msg.header.action, "finish-task");
						send("result-generated", { output: { sentence: { text: "蝶君。", sentence_end: true } } });
						send("task-finished");
					}
				} catch (error) { violations.push(error); ws.terminate(); }
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const controller = new AbortController();
		const input: VoiceInput = { hotwords: ["蝶君"], signal: controller.signal, emit: event => events.push(event.kind),
			fail: error => failure.push(error.message) };
		const provider = new BailianProvider(async () => "local-fake", {
			websocket: `ws://127.0.0.1:${address.port}`, vocabulary: `http://127.0.0.1:${address.port}`, timeoutMs: 600,
		});
		try {
			if (scenario.endsWith("auth")) await assert.rejects(provider.open(input), { code: "forbidden" });
			else if (scenario === "timeout") await assert.rejects(provider.open(input), /超时/);
			else {
				const stream = await provider.open(input);
				await stream.chunk(Buffer.alloc(4800));
				if (scenario === "network") {
					for (let i = 0; i < 30 && !failure.length; i++) await delay(20);
					assert.match(failure.join(), /断开/);
				} else {
					await stream.end();
					assert.deepEqual(events, ["partial", "final"]);
				}
			}
			const expected = scenario === "http-auth" ? ["create_vocabulary"] : ["create_vocabulary", "delete_vocabulary"];
			for (let i = 0; i < 30 && actions.length < expected.length; i++) await delay(20);
			assert.deepEqual(actions, expected);
			assert.deepEqual(violations, []);
		} finally {
			controller.abort();
			for (const socket of wss.clients) socket.terminate();
			wss.close();
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
}

