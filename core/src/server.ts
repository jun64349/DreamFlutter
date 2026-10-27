import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { RpcError, type Core } from "./core.ts";

export interface ServerOptions {
	host?: string;
	port: number;
	token: string;
}

function tokenMatches(expected: string, header: string | undefined): boolean {
	if (!header?.startsWith("Bearer ")) return false;
	const given = Buffer.from(header.slice(7));
	const want = Buffer.from(expected);
	return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Local WebSocket endpoint. Accepts only loopback connections that present the
 * token from core.json, and refuses browser requests (which always carry an
 * Origin header) so web pages cannot talk to the agent.
 *
 * Wire format, one JSON object per message:
 *   client → core  {id, method, params}
 *   core → client  {id, result} | {id, error: {code, message}} | {event, ...}
 */
export function startServer(core: Core, options: ServerOptions): Promise<{ port: number; close(): Promise<void> }> {
	const server = new WebSocketServer({
		host: options.host ?? "127.0.0.1",
		port: options.port,
		maxPayload: 64 * 1024 * 1024,
		verifyClient: (info: { req: IncomingMessage }) => !info.req.headers.origin && tokenMatches(options.token, info.req.headers.authorization),
	});

	server.on("connection", (socket: WebSocket) => {
		const client = core.addClient((message) => {
			if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
		});
		socket.on("message", (data) => {
			let request: { id?: unknown; method?: unknown; params?: unknown };
			try {
				request = JSON.parse(data.toString());
			} catch {
				client.send({ id: null, error: { code: "parse_error", message: "Invalid JSON" } });
				return;
			}
			const id = request.id ?? null;
			if (typeof request.method !== "string") {
				client.send({ id, error: { code: "bad_request", message: "method is required" } });
				return;
			}
			core
				.call(request.method, (request.params ?? {}) as Record<string, unknown>, client)
				.then((result) => client.send({ id, result: result ?? null }))
				.catch((error: unknown) => {
					const code = error instanceof RpcError ? error.code : "internal";
					const message = error instanceof Error ? error.message : String(error);
					if (code === "internal") core.log.error(`method ${String(request.method)} failed`, error);
					client.send({ id, error: { code, message } });
				});
		});
		socket.on("close", () => core.removeClient(client));
		socket.on("error", () => core.removeClient(client));
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.once("listening", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : options.port;
			resolve({
				port,
				close: () =>
					new Promise<void>((done) => {
						for (const socket of server.clients) socket.terminate();
						server.close(() => done());
					}),
			});
		});
	});
}
