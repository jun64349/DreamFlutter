import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, createMcpExtension, ModelRuntime, SessionManager, SettingsManager, type McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { StdioTransport, StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp";
import type { SecurityAudit, AuditContext } from "./audit.ts";
import { redact, redactValue, rememberSecret } from "./redaction.ts";
import { loadSecurityMcpConfig } from "./mcp-config.ts";

const PLATFORM_ENV = new Set(["path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp", "home", "userprofile", "appdata", "localappdata", "systemdrive"]);
export function minimalMcpEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && PLATFORM_ENV.has(key.toLowerCase()))) as Record<string, string>;
}
const expandHome = (value: string) => /^~(?:[\\/]|$)/.test(value) ? join(homedir(), value.slice(2)) : value;

/** The documented Pi config syntax; no private SDK import or field access. */
export function resolveMcpValue(value: string): string {
	if (value.startsWith("!")) {
		const resolved = execSync(value.slice(1), { env: minimalMcpEnv(), windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
		rememberSecret(resolved); return resolved;
	}
	return value.replace(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string | undefined, plain: string | undefined) => {
		if (match === "$$") return "$";
		if (match === "$!") return "!";
		const resolved = process.env[braced ?? plain!];
		if (resolved === undefined) throw new Error(`MCP 显式声明的环境变量未设置：${braced ?? plain}`);
		rememberSecret(resolved); return resolved;
	});
}

/** Protect the public transport event boundary before Pi writes notifications/message to mcp.log. */
export function scrubMcpTransport(transport: McpTransport, observe?: (direction: "send" | "receive", message: unknown) => void): McpTransport {
	return {
		start: () => transport.start(),
		async send(message, options) { observe?.("send", message); try { await transport.send(message, options); } catch (error) { if (error instanceof Error) error.message = redact(error.message, true); throw error; } },
		close: () => transport.close(),
		onMessage: (listener) => transport.onMessage((message) => {
			observe?.("receive", message);
			listener(redactValue(message, "method" in message && message.method === "notifications/message"));
		}),
		onError: (listener) => transport.onError((error) => listener(new Error(redact(error.message, true)))),
		onClose: (listener) => transport.onClose(listener),
		setProtocolVersion: (version) => transport.setProtocolVersion?.(version),
	};
}

export function secureMcpFactory(audit?: SecurityAudit, observe?: (name: string, direction: "send" | "receive", message: unknown) => void, context: () => AuditContext = () => ({ requestId: "mcp" })): McpTransportFactory {
	return (entry, cwd, authProvider) => {
		const config = entry.config;
		const remember = (name: string, value: string) => {
			if (/key|secret|token|password|authorization|credential/i.test(name)) { rememberSecret(value); rememberSecret(value.replace(/^(Bearer|Basic)\s+/i, "")); }
			return value;
		};
		let transport: McpTransport;
		if ("url" in config) {
			transport = new StreamableHttpTransport({ url: config.url,
				headers: Object.fromEntries(Object.entries(config.headers ?? {}).map(([name, value]) => [name, remember(name, resolveMcpValue(value))])),
				authProvider: authProvider ? { async token() { const token = await authProvider.token(); if (token) rememberSecret(token); return token; },
					onUnauthorized: authProvider.onUnauthorized ? (context) => authProvider.onUnauthorized!(context) : undefined } : undefined });
		} else {
			const explicit = Object.fromEntries(Object.entries(config.env ?? {}).map(([name, value]) => [name, remember(name, resolveMcpValue(value))]));
			transport = new StdioTransport({ command: expandHome(config.command), args: config.args?.map(expandHome), cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
				env: { ...minimalMcpEnv(), ...explicit }, inheritEnv: false, stderr: "pipe", onStderr: () => {} });
		}
		audit?.record("mcp", entry.name, "start", "url" in config ? "HTTP/OAuth 公共 transport" : "最小平台环境 + 服务显式变量", context());
		return scrubMcpTransport(transport, (direction, message) => observe?.(entry.name, direction, message));
	};
}

/** Same public extension/factory as conversations, without invoking a model or the unguarded CLI. */
export async function checkMcpServers(agentDir: string, cwd: string, audit: SecurityAudit, reports: Record<string, unknown>[], projectTrusted = false): Promise<{ servers: Record<string, unknown>[]; errors: unknown[] }> {
	const states = new Map<string, { state: string; tools: string[]; error?: string }>();
	const requests = new Map<string, Map<unknown, string>>();
	const errors: string[] = [];
	const loaded = loadSecurityMcpConfig(agentDir, cwd, projectTrusted);
	const requestId = randomUUID();
	errors.push(...loaded.errors);
	const factory = secureMcpFactory(audit, (name, direction, data) => {
		const message = data as { id?: unknown; method?: string; result?: { tools?: { name: string }[]; capabilities?: { tools?: unknown } }; error?: unknown };
		if (!requests.has(name)) requests.set(name, new Map());
		if (direction === "send" && message.id !== undefined && message.method) requests.get(name)!.set(message.id, message.method);
		if (direction === "receive" && requests.get(name)!.get(message.id) === "tools/list" && message.result) states.set(name, { state: "connected", tools: message.result.tools?.map((tool) => tool.name) ?? [] });
		if (direction === "receive" && requests.get(name)!.get(message.id) === "initialize" && message.result && !message.result.capabilities?.tools) states.set(name, { state: "connected", tools: [] });
	}, () => ({ requestId }));
	const trackedFactory: McpTransportFactory = (entry, directory, auth) => {
		states.set(entry.name, { state: "connecting", tools: [] });
		try {
			const transport = factory(entry, directory, auth);
			const fail = (error: unknown) => { states.set(entry.name, { state: /401|sign.in|oauth|authorization required/i.test(String(error)) ? "needs-auth" : "failed", tools: [], error: redact(String(error), true) }); };
			transport.onError(fail);
			return { ...transport, async start() { try { await transport.start(); } catch (error) { fail(error); throw error; } }, async send(message, options) { try { await transport.send(message, options); } catch (error) { fail(error); throw error; } } };
		} catch (error) { states.set(entry.name, { state: "failed", tools: [], error: redact(String(error), true) }); throw error; }
	};
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false });
	const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime,
		resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, extensionFactories: [createMcpExtension({ logPath: join(agentDir, "mcp.log"), loadConfig: () => loaded, createTransport: trackedFactory })] } });
	const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin" });
	try {
		await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(redact(error.error, true)) });
		const deadline = Date.now() + 65_000;
		const enabled = loaded.servers.filter((entry) => entry.config.enabled !== false);
		while (enabled.some((entry) => !states.has(entry.name) || states.get(entry.name)!.state === "connecting") && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
		return { servers: reports.map((report) => ({ ...report, ...(states.get(String(report.name)) ?? { state: report.enabled === false ? "disabled" : "failed", tools: [], error: "MCP 未启动；检查配置或项目是否受信任" }) })), errors };
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
}
