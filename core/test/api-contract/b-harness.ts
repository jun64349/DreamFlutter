import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { startServer } from "../../src/server.ts";
import { startTestCore } from "../harness.ts";

export type Json = Record<string, unknown>;
export type Reply = { id: string; result?: unknown; error?: { code: string; message: string; data?: unknown } };

export function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Json {
	assert.ok(value && typeof value === "object" && !Array.isArray(value), "expected an object");
	const actual = Object.keys(value);
	assert.deepEqual(actual.filter(key => !required.includes(key) && !optional.includes(key)).sort(), [], "unexpected fields");
	assert.deepEqual(required.filter(key => !actual.includes(key)).sort(), [], "missing fields");
	return value as Json;
}

export async function startContractCore() {
	const t = await startTestCore(undefined, {
		gatewayTransport: () => { throw new Error("contract fixtures prohibit real model transport"); },
		webSearch: { fetch: async () => Response.json({ results: [] }) },
		sandbox: { image: null, wsl: async () => ({ code: 1, stdout: "", stderr: "fixture WSL unavailable" }) },
	});
	t.core.settings.update({ patrolQuietEnabled: false });
	const token = randomUUID();
	const server = await startServer(t.core, { port: 0, token }).catch(async error => {
		await t.cleanup();
		throw error;
	});
	const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { headers: { Authorization: `Bearer ${token}` } });
	try {
		await once(socket, "open");
	} catch (error) {
		await server.close();
		await t.cleanup();
		throw error;
	}
	const messages: Json[] = [];
	socket.on("message", data => messages.push(JSON.parse(String(data)) as Json));
	async function request(method: string, params: Json = {}): Promise<Reply> {
		const id = randomUUID();
		socket.send(JSON.stringify({ id, method, params }));
		return await t.waitFor(() => messages.find(message => message.id === id) as Reply | undefined, undefined, `RPC response for ${method}`);
	}
	async function call(method: string, params?: Json): Promise<unknown> {
		const reply = await request(method, params);
		assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
		return reply.result;
	}
	async function error(method: string, params: Json, code: string) {
		const reply = await request(method, params);
		assert.equal(reply.error?.code, code, `${method}: ${JSON.stringify(reply)}`);
		assert.ok(reply.error.message.length);
		assert.ok(!("result" in reply));
		return reply.error;
	}
	async function command(slotId: string, type: string, input: Json = {}): Promise<Json> {
		const id = randomUUID();
		await call("slot.send", { slotId, record: { ...input, id, type } });
		return await t.waitFor(() => {
			const record = messages.filter(message => message.event === "slot.record" && message.slotId === slotId)
				.map(message => message.record as Json).find(record => record.id === id && record.type === "response");
			return record;
		}, undefined, `slot.record response for ${type} in ${slotId}`);
	}
	function pushes(from: number, ...names: string[]): Json[] {
		return messages.slice(from).filter(message => typeof message.event === "string" && names.includes(message.event));
	}
	async function cleanup() {
		await server.close();
		await t.cleanup();
	}
	return { t, messages, request, call, error, command, pushes, cleanup };
}

export type ContractCore = Awaited<ReturnType<typeof startContractCore>>;
