import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { TestContext } from "node:test";
import WebSocket from "ws";
import { startServer } from "../../src/server.ts";
import { startTestCore, type TestCore } from "../harness.ts";

export type RpcParams = Record<string, unknown>;
export type RpcEvent = { event: string } & Record<string, unknown>;
export type RpcErrorPayload = { code: string; message: string; data?: unknown };

export class RpcFailure extends Error {
	readonly code: string;
	readonly data: unknown;
	constructor(error: RpcErrorPayload) {
		super(error.message);
		this.code = error.code;
		this.data = error.data;
	}
}

export interface ContractClient {
	/** All pushed events in delivery order, excluding RPC responses. */
	readonly events: readonly RpcEvent[];
	call<T = unknown>(method: string, params?: RpcParams): Promise<T>;
	/** Wait for a matching push recorded at or after an event index. */
	waitForEvent(name: string, predicate?: (event: RpcEvent) => boolean, from?: number): Promise<RpcEvent>;
	close(): Promise<void>;
}

export interface ContractHarness extends TestCore, ContractClient {
	readonly origin: string;
	/** A second authenticated window, with its own ordered event journal. */
	connect(): Promise<ContractClient>;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };

async function connect(port: number, token: string, waitFor: TestCore["waitFor"]): Promise<ContractClient> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
		headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 5000,
	});
	const pending = new Map<number, Pending>();
	const events: RpcEvent[] = [];
	let next = 0;
	const fail = (error: Error) => {
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		pending.clear();
	};
	socket.on("error", fail);
	socket.on("close", () => fail(new Error("Contract WebSocket closed")));
	socket.on("message", raw => {
		const message = JSON.parse(raw.toString());
		if (typeof message.event === "string") { events.push(message); return; }
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		clearTimeout(request.timer);
		if (message.error) request.reject(new RpcFailure(message.error));
		else request.resolve(message.result);
	});
	try { await once(socket, "open"); }
	catch (error) { socket.terminate(); throw error; }
	return {
		events,
		call<T>(method: string, params: RpcParams = {}) {
			return new Promise<T>((resolve, reject) => {
				assert.equal(socket.readyState, WebSocket.OPEN, method);
				const id = ++next;
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`No RPC response for ${method}`));
				}, 15_000);
				pending.set(id, { resolve: value => resolve(value as T), reject, timer });
				socket.send(JSON.stringify({ id, method, params }), error => {
					if (!error) return;
					pending.delete(id);
					clearTimeout(timer);
					reject(error);
				});
			});
		},
		waitForEvent: (name, predicate = () => true, from = 0) =>
			waitFor(() => events.slice(from).find(event => event.event === name && predicate(event)), undefined, `WebSocket event ${name}`),
		async close() {
			if (socket.readyState === WebSocket.CLOSED) return;
			const closed = once(socket, "close");
			socket.terminate();
			await closed;
		},
	};
}

type CoreOptions = NonNullable<Parameters<typeof startTestCore>[1]>;

/** Fresh temp data, a scripted model, an unavailable fake WSL by default and an authenticated loopback server. */
export async function startContractHarness(t: TestContext, options: CoreOptions = {}): Promise<ContractHarness> {
	const fixture = await startTestCore(undefined, {
		gatewayTransport: () => { throw new Error("Contract fixtures prohibit real model transport"); },
		...options,
		sandbox: { image: null, wsl: async () => ({ code: 1, stdout: "", stderr: "fixture WSL unavailable" }), ...options.sandbox },
	});
	const token = randomUUID();
	let server: Awaited<ReturnType<typeof startServer>> | undefined;
	const clients: ContractClient[] = [];
	let cleanup: Promise<void> | undefined;
	const finish = () => cleanup ??= (async () => {
		try {
			await Promise.all(clients.map(client => client.close()));
			await server?.close();
		} finally { await fixture.cleanup(); }
	})();
	t.after(finish);
	try {
		server = await startServer(fixture.core, { port: 0, token });
		const port = server.port;
		const open = async () => {
			const client = await connect(port, token, fixture.waitFor);
			clients.push(client);
			return client;
		};
		return { ...fixture, ...await open(), connect: open, origin: `http://127.0.0.1:${port}`, cleanup: finish };
	} catch (error) { await finish(); throw error; }
}

/** Reject extra wire fields and require every non-optional field. Optional keys can use a trailing '?'. */
export function expectKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
	assert.ok(value && typeof value === "object" && !Array.isArray(value), "expected a wire object");
	const keys = Object.keys(value);
	const mandatory = required.filter(key => !key.endsWith("?"));
	const allowed = new Set([...required, ...optional].map(key => key.replace(/\?$/, "")));
	assert.deepEqual({
		missing: mandatory.filter(key => !keys.includes(key)).sort(),
		extra: keys.filter(key => !allowed.has(key)).sort(),
	}, { missing: [], extra: [] });
}

/** Assert the wire error code and that the response included a usable message. */
export async function expectRpcError(call: Promise<unknown>, code: string): Promise<void> {
	await assert.rejects(call, error => error instanceof RpcFailure && error.code === code && error.message.length > 0);
}
