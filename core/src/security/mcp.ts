import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, createMcpExtension, ModelRuntime, SessionManager, SettingsManager, type McpTransportFactory, type McpServerEntry } from "@earendil-works/pi-coding-agent";
import { StdioTransport, StreamableHttpTransport, SUPPORTED_PROTOCOL_VERSIONS, type McpTransport } from "@earendil-works/pi-mcp";
import type { SecurityAudit, AuditContext } from "./audit.ts";
import { redact, redactValue, rememberSecret } from "./redaction.ts";
import { loadSecurityMcpConfig } from "./mcp-config.ts";
import type { LibraryRegistry } from "../modules/library-registry.ts";

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

export function secureMcpFactory(audit?: SecurityAudit, observe?: (name: string, direction: "send" | "receive", message: unknown) => void, context: () => AuditContext = () => ({ requestId: "mcp" }), policy?: { allowed: (entry: McpServerEntry) => boolean; used?: (entry: McpServerEntry, id: unknown) => void }): McpTransportFactory {
	return (entry, cwd, authProvider) => {
		const connectionId = randomUUID();
		const authorize = () => { if (policy && !policy.allowed(entry)) { audit?.record("mcp", entry.name, "deny", "服务未信任、已停用、配置已变更或未授权给蝶君", context()); throw new Error("MCP 服务未获信任、已停用或未授权给蝶君，请在技能页确认并重新加载"); } };
		authorize();
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
		const scrubbed = scrubMcpTransport(transport, (direction, message) => observe?.(entry.name, direction, message));
		return { ...scrubbed, async start() { authorize(); await scrubbed.start(); }, async send(message, options) {
			authorize(); await scrubbed.send(message, options);
			if ("method" in message && message.method === "tools/call") policy?.used?.(entry, `${connectionId}:${"id" in message ? String(message.id) : "notification"}`);
		} };
	};
}

/** Same public extension/factory as conversations, without invoking a model or the unguarded CLI. */
export async function checkMcpServers(agentDir: string, cwd: string, audit: SecurityAudit, reports: Record<string, unknown>[], projectTrusted = false, options: { registry?: LibraryRegistry; name?: string; source?: string; testDisabled?: boolean } = {}): Promise<{ servers: Record<string, unknown>[]; errors: unknown[] }> {
	const started = Date.now();
	const states = new Map<string, { state: string; tools: string[]; error?: string; errorCode?: string; protocolVersion?: string }>();
	const requests = new Map<string, Map<unknown, string>>();
	const errors: string[] = [];
	const loaded = loadSecurityMcpConfig(agentDir, cwd, projectTrusted);
	loaded.servers = loaded.servers.filter((entry) => (!options.name || entry.name === options.name) && (!options.source || entry.source === options.source));
	for (const entry of loaded.servers) if (!options.testDisabled && entry.config.enabled === false) {
		states.set(entry.name, { state: "disabled", tools: [] });
	} else if (options.registry && !(options.testDisabled ? options.registry.mcpTrusted(entry) : options.registry.mcpAllowed(entry))) {
		entry.config = { ...entry.config, enabled: false }; states.set(entry.name, { state: "blocked", tools: [], error: "MCP 服务未信任、已停用或配置已变化，请先在待确认里审阅" });
	} else if (options.testDisabled) entry.config = { ...entry.config, enabled: true };
	const requestId = randomUUID();
	errors.push(...loaded.errors);
	const factory = secureMcpFactory(audit, (name, direction, data) => {
		const message = data as { id?: unknown; method?: string; result?: { protocolVersion?: string; tools?: { name: string }[]; nextCursor?: string; capabilities?: { tools?: unknown } }; error?: unknown };
		if (!requests.has(name)) requests.set(name, new Map());
		if (direction === "send" && message.id !== undefined && message.method) requests.get(name)!.set(message.id, message.method);
		if (direction === "receive" && requests.get(name)!.has(message.id) && message.error) states.set(name, { state: "failed", tools: [], error: redact(JSON.stringify(message.error), true) });
		if (direction === "receive" && requests.get(name)!.get(message.id) === "tools/list" && message.result) states.set(name, { state: message.result.nextCursor ? "connecting" : "connected", tools: [...new Set([...(states.get(name)?.tools ?? []), ...message.result.tools?.map((tool) => tool.name) ?? []])] });
		if (direction === "receive" && requests.get(name)!.get(message.id) === "initialize" && message.result) {
			const version = message.result.protocolVersion;
			if (typeof version !== "string" || !version) states.set(name, { state: "failed", tools: [], errorCode: "invalid_initialize", error: "MCP 初始化响应缺少有效的 protocolVersion，无法确认协议或连接成功" });
			else if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) states.set(name, { state: "failed", tools: [], errorCode: "protocol_incompatible", protocolVersion: redact(version, true), error: redact(`协议不兼容：服务要求 ${version}；当前客户端支持 2025-11-25 及可协商的旧版本`, true) });
			else if (!message.result.capabilities?.tools) states.set(name, { state: "connected", tools: [] });
		}
	}, () => ({ requestId }), options.registry ? { allowed: (entry) => options.testDisabled ? options.registry!.mcpTrusted(entry) : options.registry!.mcpAllowed(entry) } : undefined);
	const trackedFactory: McpTransportFactory = (entry, directory, auth) => {
		states.set(entry.name, { state: "connecting", tools: [] });
		try {
			const transport = factory(entry, directory, auth);
			const fail = (error: unknown) => { if (states.get(entry.name)?.errorCode) return; states.set(entry.name, { state: /401|sign.in|oauth|authorization required/i.test(String(error)) ? "needs-auth" : "failed", tools: [], error: redact(String(error), true) }); };
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
		return { servers: reports.map((report) => {
			const state = states.get(String(report.name));
			return { ...report, ...(state?.state === "connecting" ? { state: "failed", tools: [], error: "MCP 连接或列出工具超时" } : state ?? { state: report.enabled === false ? "disabled" : "failed", tools: [], error: "MCP 未启动；检查配置或项目是否受信任" }), durationMs: Date.now() - started };
		}), errors };
	} finally {
		try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
		finally { session.dispose(); }
	}
}
