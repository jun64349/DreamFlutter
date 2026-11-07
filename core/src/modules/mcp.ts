import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Core } from "../core.ts";
import { RpcError, requireStr, str } from "../core.ts";
import { isSecretReference, SecretStore } from "./secrets.ts";
import { checkMcpServers } from "../security/mcp.ts";

type Json = Record<string, unknown>;

/** A value in the form: secrets come back masked (empty value, secret = true). */
export interface FormValue {
	value: string;
	secret: boolean;
}

export interface McpServerForm {
	name: string;
	transport: "stdio" | "http";
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, FormValue>;
	url?: string;
	headers?: Record<string, FormValue>;
	description?: string;
	exposure?: string;
	enabled?: boolean;
	timeout?: number;
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const EXPOSURES = ["codemode", "deferred", "direct", "hidden"];

/**
 * MCP servers (Pi's built-in MCP support): edits the user-level
 * `~/.pi/agent/mcp.json` with a form instead of hand-written JSON, keeps
 * secret env values and headers DPAPI-encrypted behind Pi's `!command`
 * syntax, and checks connections and tools with `pi mcp list --json`.
 */
export class McpModule {
	private readonly core: Core;
	private readonly secrets: SecretStore;

	constructor(core: Core) {
		this.core = core;
		this.secrets = new SecretStore(core.paths.dataDir);
		this.register();
	}

	private get file(): string {
		return join(this.core.agentDir, "mcp.json");
	}

	private read(file = this.file): Json {
		try {
			return JSON.parse(readFileSync(file, "utf8")) as Json;
		} catch {
			return {};
		}
	}

	private write(config: Json): void {
		const temp = `${this.file}.${process.pid}.tmp`;
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		renameSync(temp, this.file);
		this.core.broadcast({ event: "mcp.changed" });
	}

	private servers(config: Json): Record<string, Json> {
		const servers = config.mcpServers;
		return servers && typeof servers === "object" ? (servers as Record<string, Json>) : {};
	}

	/** Servers as form data: user-level ones are editable, project ones are shown read-only. */
	list(cwd?: string): (McpServerForm & { scope: "user" | "project"; source: string })[] {
		const mask = (values: unknown): Record<string, FormValue> =>
			Object.fromEntries(
				Object.entries((values as Record<string, unknown>) ?? {}).map(([k, v]) => [k, isSecretReference(v) ? { value: "", secret: true } : { value: String(v ?? ""), secret: false }]),
			);
		const toForm = (name: string, entry: Json, scope: "user" | "project", source: string) => ({
			name,
			scope,
			source,
			transport: (entry.url ? "http" : "stdio") as "stdio" | "http",
			command: str(entry.command),
			args: Array.isArray(entry.args) ? entry.args.map(String) : [],
			cwd: str(entry.cwd),
			env: mask(entry.env),
			url: str(entry.url),
			headers: mask(entry.headers),
			description: str(entry.description),
			exposure: str(entry.exposure),
			enabled: entry.enabled !== false,
			timeout: typeof entry.timeout === "number" ? entry.timeout : undefined,
		});
		const out = Object.entries(this.servers(this.read())).map(([name, entry]) => toForm(name, entry, "user", this.file));
		if (cwd) {
			const projectFile = join(cwd, ".pi", "mcp.json");
			if (existsSync(projectFile)) out.push(...Object.entries(this.servers(this.read(projectFile))).map(([name, entry]) => toForm(name, entry, "project", projectFile)));
		}
		return out;
	}

	async save(form: McpServerForm, previousName?: string): Promise<void> {
		const name = form.name.trim();
		if (!NAME.test(name)) throw new RpcError("bad_request", "名称只能用字母、数字、横线和下划线");
		const config = this.read();
		const servers = { ...this.servers(config) };
		const previous = servers[previousName ?? name] ?? {};
		if (previousName !== name && servers[name]) throw new RpcError("conflict", `已经有名为 ${name} 的服务`);
		const entry: Json = {};
		if (form.transport === "http") {
			const url = form.url?.trim();
			if (!url || !/^https?:\/\//i.test(url)) throw new RpcError("bad_request", "请填写以 http:// 或 https:// 开头的网址");
			if (/\/sse\/?$/i.test(url)) throw new RpcError("bad_request", "Pi 不支持旧的 SSE 连接方式，这类服务通常也提供 /mcp 地址");
			entry.url = url;
			const headers = await this.values(name, previousName ?? name, "header", form.headers, previous.headers as Json | undefined);
			if (Object.keys(headers).length) entry.headers = headers;
			if (previous.oauth) entry.oauth = previous.oauth;
		} else {
			const command = form.command?.trim();
			if (!command) throw new RpcError("bad_request", "请填写启动命令");
			if (/\s/.test(command) && !existsSync(command)) throw new RpcError("bad_request", "命令只写程序名（例如 npx），参数写在下面的参数栏里");
			entry.command = command;
			const args = (form.args ?? []).map((a) => a.trim()).filter(Boolean);
			if (args.length) entry.args = args;
			if (form.cwd?.trim()) entry.cwd = form.cwd.trim();
			const env = await this.values(name, previousName ?? name, "env", form.env, previous.env as Json | undefined);
			if (Object.keys(env).length) entry.env = env;
		}
		if (form.description?.trim()) entry.description = form.description.trim();
		if (form.exposure && EXPOSURES.includes(form.exposure)) entry.exposure = form.exposure;
		if (previous.toolExposure) entry.toolExposure = previous.toolExposure;
		if (form.timeout && form.timeout > 0) entry.timeout = form.timeout;
		if (form.enabled === false) entry.enabled = false;
		// Encrypting the keys took a while: write into the file as it is now, not as it was read above.
		const current = this.read();
		const latest = { ...this.servers(current) };
		if (previousName && previousName !== name) {
			this.removeSecrets(previousName, latest[previousName]);
			delete latest[previousName];
		}
		latest[name] = entry;
		this.write({ ...current, mcpServers: latest });
	}

	/** Env values / headers: secret ones are encrypted; an empty secret keeps the stored one. */
	private async values(server: string, previousServer: string, kind: string, form: Record<string, FormValue> | undefined, previous: Json | undefined): Promise<Json> {
		const out: Json = {};
		for (const [rawKey, field] of Object.entries(form ?? {})) {
			const key = rawKey.trim();
			if (!key) continue;
			if (field.secret) {
				if (field.value) out[key] = await this.secrets.put(`mcp-${server}-${kind}-${key}`, field.value);
				else if (isSecretReference(previous?.[key])) {
					// Renamed: re-store under the new name, so the old name's blob can go and never aliases.
					out[key] = previousServer === server ? previous![key] : await this.secrets.put(`mcp-${server}-${kind}-${key}`, await this.secrets.get(`mcp-${previousServer}-${kind}-${key}`));
				}
			} else if (field.value !== "") {
				out[key] = field.value;
			}
		}
		return out;
	}

	setEnabled(name: string, enabled: boolean): void {
		const config = this.read();
		const servers = { ...this.servers(config) };
		if (!servers[name]) throw new RpcError("not_found", "没有这个服务");
		const entry = { ...servers[name] };
		if (enabled) delete entry.enabled;
		else entry.enabled = false;
		servers[name] = entry;
		this.write({ ...config, mcpServers: servers });
	}

	remove(name: string): void {
		const config = this.read();
		const servers = { ...this.servers(config) };
		const entry = servers[name];
		if (!entry) return;
		this.removeSecrets(name, entry);
		delete servers[name];
		this.write({ ...config, mcpServers: servers });
	}

	private removeSecrets(name: string, entry: Json | undefined): void {
		for (const kind of ["env", "headers"] as const) {
			for (const [key, value] of Object.entries((entry?.[kind] as Json | undefined) ?? {})) {
				if (isSecretReference(value)) this.secrets.remove(`mcp-${name}-${kind === "env" ? "env" : "header"}-${key}`);
			}
		}
	}

	/** Connects to every enabled server (as Pi would) and reports state, tools and errors. */
	async status(cwd: string): Promise<{ servers: Json[]; errors: unknown[] }> {
		await this.core.security.loadKnownSecrets();
		const trusted = this.core.isProjectTrusted(cwd);
		const reports = [...new Map(this.list(trusted ? cwd : undefined).map((form) => [form.name, { name: form.name, scope: form.scope, source: form.source, enabled: form.enabled, exposure: form.exposure }])).values()];
		return checkMcpServers(this.core.agentDir, cwd, this.core.security.audit, reports, trusted);
	}

	private register(): void {
		const core = this.core;
		const values = (v: unknown): Record<string, FormValue> =>
			Object.fromEntries(
				Object.entries((v as Record<string, { value?: unknown; secret?: unknown }>) ?? {}).map(([k, f]) => [k, { value: typeof f?.value === "string" ? f.value : "", secret: f?.secret === true }]),
			);
		core.register("mcp.list", (p) => ({ file: this.file, servers: this.list(str(p.cwd)) }));
		core.register("mcp.save", async (p) => {
			const form = (p.server ?? {}) as Json;
			await this.save(
				{
					name: requireStr(form.name, "name"),
					transport: form.transport === "http" ? "http" : "stdio",
					command: str(form.command),
					args: Array.isArray(form.args) ? form.args.map(String) : [],
					cwd: str(form.cwd),
					env: values(form.env),
					url: str(form.url),
					headers: values(form.headers),
					description: str(form.description),
					exposure: str(form.exposure),
					enabled: form.enabled !== false,
					timeout: typeof form.timeout === "number" ? form.timeout : undefined,
				},
				str(p.previousName),
			);
			return { ok: true };
		});
		core.register("mcp.setEnabled", (p) => {
			this.setEnabled(requireStr(p.name, "name"), p.enabled === true);
			return { ok: true };
		});
		core.register("mcp.remove", (p) => {
			this.remove(requireStr(p.name, "name"));
			return { ok: true };
		});
		core.register("mcp.status", (p) => this.status(requireStr(p.cwd, "cwd")));
	}
}
