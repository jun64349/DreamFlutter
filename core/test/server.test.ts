import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startServer } from "../src/server.ts";
import { startTestCore, type TestCore } from "./harness.ts";

function connect(port: number, headers: Record<string, string>): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
		socket.once("open", () => resolve(socket));
		socket.once("error", reject);
		socket.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
	});
}

function call(socket: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	const id = Math.random().toString(36).slice(2);
	return new Promise((resolve) => {
		const onMessage = (data: Buffer) => {
			const message = JSON.parse(data.toString());
			if (message.id === id) {
				socket.off("message", onMessage);
				resolve(message);
			}
		};
		socket.on("message", onMessage);
		socket.send(JSON.stringify({ id, method, params }));
	});
}

describe("websocket server", () => {
	let t: TestCore;
	let server: { port: number; close(): Promise<void> };
	const token = "a".repeat(64);

	before(async () => {
		t = await startTestCore();
		server = await startServer(t.core, { port: 0, token });
	});

	after(async () => {
		await server.close();
		await t.cleanup();
	});

	it("serves authenticated clients", async () => {
		const socket = await connect(server.port, { Authorization: `Bearer ${token}` });
		const hello = await call(socket, "core.hello");
		assert.equal((hello.result as { version: string }).version, "0.1.1");
		const bad = await call(socket, "nope.nope");
		assert.equal((bad.error as { code: string }).code, "unknown_method");
		socket.close();
	});

	it("rejects a wrong token", async () => {
		await assert.rejects(connect(server.port, { Authorization: "Bearer wrong" }), /401/);
	});

	it("rejects browser origins even with the token", async () => {
		await assert.rejects(connect(server.port, { Authorization: `Bearer ${token}`, Origin: "https://evil.example" }), /401/);
	});
});

describe("core process", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "df-proc-"));
	const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

	after(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

	it("starts once, writes core.json, refuses a second instance and shuts down on request", async () => {
		const args = ["--disable-warning=ExperimentalWarning", main, "--data-dir", dataDir, "--agent-dir", join(dataDir, "agent")];
		const first = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		const ready = await new Promise<{ port: number }>((resolve, reject) => {
			first.stdout.once("data", (data) => resolve(JSON.parse(String(data).split("\n")[0]!)));
			first.once("exit", (code) => reject(new Error(`exited ${code}`)));
		});
		const info = JSON.parse(readFileSync(join(dataDir, "core.json"), "utf8"));
		assert.equal(info.port, ready.port);

		const second = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		const secondCode = await new Promise((resolve) => second.once("exit", resolve));
		assert.equal(secondCode, 3);

		const socket = await connect(info.port, { Authorization: `Bearer ${info.token}` });
		const exited = new Promise((resolve) => first.once("exit", resolve));
		await call(socket, "core.shutdown");
		assert.equal(await exited, 0);
		assert.equal(existsSync(join(dataDir, "core.json")), false);
		assert.equal(existsSync(join(dataDir, "core.lock")), false);
	});
});
