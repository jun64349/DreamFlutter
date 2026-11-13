import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
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
	const host = options.host ?? "127.0.0.1";
	// Plain HTTP on the same port serves cards and the renderer page to the window's WebViews.
	const http = createServer((req, res) => {
		const port = core.httpPort;
		// Only loopback names for this port (no DNS rebinding), only GET/HEAD.
		if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
			res.writeHead(421).end();
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405).end();
			return;
		}
		let path: string;
		try {
			path = decodeURI(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
		} catch {
			res.writeHead(400).end();
			return;
		}
		core
			.handleHttp(req, res, path)
			.then((handled) => {
				if (!handled) res.writeHead(404).end();
			})
			.catch((error: unknown) => {
				core.log.error(`http ${path} failed`, error);
				if (!res.headersSent) res.writeHead(500);
				res.end();
			});
	});
	const server = new WebSocketServer({
		server: http,
		maxPayload: 64 * 1024 * 1024,
		verifyClient: (info: { req: IncomingMessage }) => !info.req.headers.origin && tokenMatches(options.token, info.req.headers.authorization),
	});
	// ws forwards the HTTP bind error before our startup Promise sees it.
	// A listener prevents that forwarding from throwing and bypassing rollback.
	server.on("error", (error) => core.log.error("websocket server error", error));

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
			if (!request || typeof request !== "object" || Array.isArray(request)) {
				client.send({ id: null, error: { code: "bad_request", message: "request must be an object" } });
				return;
			}
			const id = request.id ?? null;
			if (typeof request.method !== "string") {
				client.send({ id, error: { code: "bad_request", message: "method is required" } });
				return;
			}
			const params = request.params;
			if (params !== undefined && params !== null && (typeof params !== "object" || Array.isArray(params))) {
				client.send({ id, error: { code: "bad_request", message: "params must be an object" } });
				return;
			}
			core
				.call(request.method, (request.params ?? {}) as Record<string, unknown>, client)
				.then((result) => client.send({ id, result: result ?? null }))
				.catch((error: unknown) => {
					const code = error instanceof RpcError ? error.code : "internal";
					const message = error instanceof Error ? error.message : String(error);
					if (code === "internal") core.log.error(`method ${String(request.method)} failed`, error);
					const data = error instanceof RpcError ? error.data : undefined;
					client.send({ id, error: { code, message, ...(data !== undefined && { data }) } });
				});
		});
		socket.on("close", () => core.removeClient(client));
		socket.on("error", () => core.removeClient(client));
	});

	return new Promise((resolve, reject) => {
		http.once("error", reject);
		http.listen(options.port, host, () => {
			const address = http.address();
			const port = typeof address === "object" && address ? address.port : options.port;
			core.httpPort = port;
			resolve({
				port,
				close: () =>
					new Promise<void>((done) => {
						for (const socket of server.clients) socket.terminate();
						server.close(() => {
							http.closeAllConnections();
							http.close(() => done());
						});
					}),
			});
		});
	});
}
