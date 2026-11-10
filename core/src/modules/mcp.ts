import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Core, CoreModule } from "../core.ts";
import type { ExtensionFactory, McpServerEntry } from "@earendil-works/pi-coding-agent";
import { RpcError, requireStr, str } from "../core.ts";
import { isSecretReference, relocateSecretRef, secretFileOf, SecretStore } from "./secrets.ts";
import { checkMcpServers } from "../security/mcp.ts";
import { locator, mcpFingerprint, type EntryMetadata, type SourceKind } from "./library-registry.ts";
import { redactValue } from "../security/redaction.ts";

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
export class McpModule implements CoreModule {
	readonly modelFacing = true;
	private readonly core: Core;
	private readonly secrets: SecretStore;

	constructor(core: Core) {
		this.core = core;
		this.secrets = new SecretStore(core.paths.dataDir);
		core.exemptFromApproval("mcp_register", "mcp_test");
		this.register();
	}

	private get file(): string {
		return join(this.core.agentDir, "mcp.json");
	}

	private read(file = this.file): Json {
		if (!existsSync(file)) return {};
		try {
			const value = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
			if (!value || typeof value !== "object" || Array.isArray(value) || value.mcpServers !== undefined && (!value.mcpServers || typeof value.mcpServers !== "object" || Array.isArray(value.mcpServers))) throw new Error("invalid structure");
			return value as Json;
		} catch {
			throw new RpcError("bad_config", "MCP 配置无法读取或格式无效，请修复 mcp.json 后重试；原文件未改写");
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
	private readonly toolNames = new Map<string, string[]>();
	private tools(source: string, name: string, entry: Json): { name: string; enabled: boolean }[] {
		const overrides = entry.toolExposure as Record<string, string> | undefined;
		const names = new Set([...(this.toolNames.get(`${source}:${name}`) ?? []), ...Object.keys(overrides ?? {})]);
		return [...names].map((tool) => ({ name: tool, enabled: (overrides?.[tool] ?? entry.exposure) !== "hidden" }));
	}

	/** Servers as form data: user-level ones are editable, project ones are shown read-only. */
	list(cwd?: string): (McpServerForm & EntryMetadata & { scope: "user" | "project"; source: string })[] {
		const mask = (values: unknown): Record<string, FormValue> =>
			Object.fromEntries(
				Object.entries((values as Record<string, unknown>) ?? {}).map(([k, v]) => [k, isSecretReference(v) ? { value: "", secret: true } : { value: String(v ?? ""), secret: false }]),
			);
		const toForm = (name: string, entry: Json, scope: "user" | "project", source: string) => {
			const key = this.core.library.mcpKey({ source, name });
			this.core.library.ensureMcp({ name, source, config: entry as never });
			if (!this.core.library.mcpTrusted({ name, source, config: entry as never })) this.core.library.write("mcp", key, { trust: "untrusted", enabled: false, butterflyAllowed: false });
			const meta = this.core.library.get("mcp", key);
			return ({
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
				tools: this.tools(source, name, entry),
			...meta,
			enabled: entry.enabled !== false && meta.enabled && meta.trust === "trusted",
			timeout: typeof entry.timeout === "number" ? entry.timeout : undefined,
		}); };
		const out = Object.entries(this.servers(this.read())).map(([name, entry]) => toForm(name, entry, "user", this.file));
		if (cwd) {
			const projectFile = join(cwd, ".pi", "mcp.json");
			if (existsSync(projectFile)) out.push(...Object.entries(this.servers(this.read(projectFile))).map(([name, entry]) => toForm(name, entry, "project", projectFile)));
		}
		return out;
	}

	async save(form: McpServerForm, previousName?: string, origin?: { sourceKind: SourceKind; sourceUrl?: string; cwd?: string; sourceSession?: string | null }): Promise<unknown> {
		const name = typeof form?.name === "string" ? form.name.trim() : "";
		if (!NAME.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) throw new RpcError("bad_request", "名称只能用字母、数字、横线和下划线，不能使用保留名称");
		const config = this.read();
		const servers = { ...this.servers(config) };
		const previous = servers[previousName ?? name] ?? {};
		if (servers[previousName ?? name]) this.core.library.ensureMcp({ source: this.file, name: previousName ?? name, config: previous as never });
		if (previousName && previousName !== name && servers[name]) throw new RpcError("conflict", `已经有名为 ${name} 的服务`);
		if (Object.keys(servers).some((other) => other !== name && other !== previousName && other.replaceAll("-", "_").toLowerCase() === name.replaceAll("-", "_").toLowerCase())) throw new RpcError("conflict", "服务名称的大小写或工具命名空间冲突");
		const pending = origin?.sourceKind === "agent" || origin?.sourceKind === "community";
		const secretName = pending ? `${name}-pending-${randomUUID().slice(0, 8)}` : name;
		const entry: Json = {};
		if (form.transport === "http") {
			const url = form.url?.trim();
			if (!url || !/^https?:\/\//i.test(url)) throw new RpcError("bad_request", "请填写以 http:// 或 https:// 开头的网址");
			if (/\/sse\/?$/i.test(url)) throw new RpcError("bad_request", "Pi 不支持旧的 SSE 连接方式，这类服务通常也提供 /mcp 地址");
			entry.url = url;
			const headers = await this.values(secretName, previousName ?? name, "header", form.headers, previous.headers as Json | undefined);
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
			const env = await this.values(secretName, previousName ?? name, "env", form.env, previous.env as Json | undefined);
			if (Object.keys(env).length) entry.env = env;
		}
		if (form.description?.trim()) entry.description = form.description.trim();
		if (form.exposure && EXPOSURES.includes(form.exposure)) entry.exposure = form.exposure;
		if (previous.toolExposure) entry.toolExposure = previous.toolExposure;
		if (form.timeout && form.timeout > 0) entry.timeout = form.timeout;
		if (form.enabled === false) entry.enabled = false;
		const previousMeta = this.core.library.get("mcp", this.core.library.mcpKey({ source: this.file, name: previousName ?? name }));
		entry.dfLibrary = { sourceKind: origin?.sourceKind ?? previousMeta.sourceKind, sourceUrl: origin?.sourceUrl ?? previousMeta.sourceUrl };
		if (pending) {
			if (previousName && previousName !== name) throw new RpcError("bad_request", "Agent 更新 MCP 时请保持服务名；重命名由用户管理页执行");
			const id = `p_${randomUUID().slice(0, 8)}`;
			const payload = { name, description: form.description ?? "", content: JSON.stringify(redactValue(entry), null, 2), scope: "user", sourceKind: origin!.sourceKind, sourceUrl: origin?.sourceUrl ?? origin?.sourceSession ?? null,
				mcpConfig: entry, previous: servers[name] ? JSON.stringify(servers[name]) : null };
			this.core.db.run("INSERT INTO proposals(id,kind,title,payload,status,source_session,cwd,created_at) VALUES(?,'mcp',?,?,'pending',?,?,?)", id, name, JSON.stringify(payload), origin?.sourceSession ?? null, origin?.cwd ?? null, Date.now());
			if (!servers[name]) this.core.library.write("mcp", this.core.library.mcpKey({ source: this.file, name }), { sourceKind: origin!.sourceKind, sourceUrl: origin?.sourceUrl ?? null, trust: "untrusted", enabled: false });
			this.core.broadcast({ event: "proposals.changed" });
			return { id, status: "pending", enabled: false, trust: "untrusted" };
		}
		// Encrypting the keys took a while: write into the file as it is now, not as it was read above.
		const current = this.read();
		const latest = { ...this.servers(current) };
		if (previousName && previousName !== name) {
			this.removeSecrets(previousName, latest[previousName]);
			delete latest[previousName];
		}
		latest[name] = entry;
		this.write({ ...current, mcpServers: latest });
		const meta = this.core.library.get("mcp", this.core.library.mcpKey({ source: this.file, name: previousName ?? name }));
		this.core.library.write("mcp", this.core.library.mcpKey({ source: this.file, name }), { sourceKind: origin?.sourceKind ?? meta.sourceKind, sourceUrl: origin?.sourceUrl ?? meta.sourceUrl, trust: "trusted", enabled: form.enabled !== false, butterflyAllowed: false }, mcpFingerprint(entry));
		if (previousName && previousName !== name) this.core.library.write("mcp", this.core.library.mcpKey({ source: this.file, name: previousName }), { enabled: false, trust: "untrusted", butterflyAllowed: false });
		return { ok: true };
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
					const oldFile = secretFileOf(String(previous![key]));
					out[key] = previousServer === server ? previous![key] : await this.secrets.put(`mcp-${server}-${kind}-${key}`, await this.secrets.get(oldFile ? basename(oldFile, ".dpapi") : `mcp-${previousServer}-${kind}-${key}`));
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
		const server: McpServerEntry = { name, source: this.file, config: entry as never };
		this.core.library.ensureMcp(server);
		if (enabled && !this.core.library.mcpTrusted(server)) throw new RpcError("untrusted", "请先在待确认里审阅并确认此 MCP 服务");
		if (enabled) delete entry.enabled;
		else entry.enabled = false;
		servers[name] = entry;
		this.core.library.write("mcp", this.core.library.mcpKey({ source: this.file, name }), { enabled });
		this.write({ ...config, mcpServers: servers });
	}

	remove(name: string): void {
		const config = this.read();
		const servers = { ...this.servers(config) };
		const entry = servers[name];
		if (!entry) return;
		this.core.library.ensureMcp({ source: this.file, name, config: entry as never });
		this.removeSecrets(name, entry);
		delete servers[name];
		this.core.library.write("mcp", this.core.library.mcpKey({ source: this.file, name }), { enabled: false, trust: "untrusted", butterflyAllowed: false });
		this.write({ ...config, mcpServers: servers });
	}


	private setToolEnabled(name: string, source: string, tool: string, enabled: boolean): void {
		if (locator(source) !== locator(this.file)) throw new RpcError("read_only", "项目里的服务由项目配置管理");
		if (!tool || tool.length > 256 || ["__proto__", "constructor", "prototype"].includes(tool)) throw new RpcError("bad_request", "工具名称无效");
		const config = this.read(), servers = this.servers(config), entry = servers[name];
		if (!entry) throw new RpcError("not_found", "没有这个服务");
		if (!this.core.library.mcpTrusted({ name, source: this.file, config: entry as never })) throw new RpcError("untrusted", "请先到等你处理确认这个服务");
		const toolExposure = { ...(entry.toolExposure as Json ?? {}) };
		toolExposure[tool] = enabled ? entry.exposure === "hidden" ? "codemode" : entry.exposure ?? "codemode" : "hidden";
		this.write({ ...config, mcpServers: { ...servers, [name]: { ...entry, toolExposure } } });
	}

	private removeSecrets(name: string, entry: Json | undefined): void {
		for (const kind of ["env", "headers"] as const) {
			for (const [key, value] of Object.entries((entry?.[kind] as Json | undefined) ?? {})) {
				if (isSecretReference(value)) { const file = secretFileOf(String(value)); this.secrets.remove(file ? basename(file, ".dpapi") : `mcp-${name}-${kind === "env" ? "env" : "header"}-${key}`); }
			}
		}
	}

	/** Connects to every enabled server (as Pi would) and reports state, tools and errors. */
	async status(cwd: string): Promise<{ servers: Json[]; errors: unknown[] }> {
		await this.core.security.loadKnownSecrets();
		const trusted = this.core.isProjectTrusted(cwd);
		const reports = [...new Map(this.list(trusted ? cwd : undefined).map((form) => [form.name, { name: form.name, scope: form.scope, source: form.source, enabled: form.enabled, exposure: form.exposure }])).values()];
		return checkMcpServers(this.core.agentDir, cwd, this.core.security.audit, reports, trusted, { registry: this.core.library });
	}

	async test(name: string, cwd: string, source = this.file): Promise<Json> {
		await this.core.security.loadKnownSecrets();
		const server = this.list(this.core.isProjectTrusted(cwd) ? cwd : undefined).find((entry) => entry.name === name && locator(entry.source) === locator(source));
		if (!server) throw new RpcError("not_found", "没有这个服务，或工作区未获信任");
		const result = await checkMcpServers(this.core.agentDir, cwd, this.core.security.audit, [server as unknown as Json], this.core.isProjectTrusted(cwd), { registry: this.core.library, name, source: server.source, testDisabled: true });
		const report = result.servers[0]!;
		const names = Array.isArray(report.tools) ? report.tools.filter((t): t is string => typeof t === "string") : [];
		if (report.state === "connected") this.toolNames.set(`${server.source}:${name}`, names);
		const literal = this.servers(this.read(server.source))[name] ?? {};
		return { ...report, ok: report.state === "connected", errors: result.errors, toolStates: this.tools(server.source, name, literal) };
	}

	private acceptProposal(id: string): Json {
		const row = this.core.db.get<{ payload: string; status: string; kind: string }>("SELECT * FROM proposals WHERE id=?", id);
		if (!row || row.status !== "pending" || row.kind !== "mcp") throw new RpcError("gone", "这个 MCP 建议已经处理过了");
		const payload = JSON.parse(row.payload) as { name: string; mcpConfig: Json; sourceKind: SourceKind; sourceUrl?: string; previous: string | null };
		const config = this.read(), servers = { ...this.servers(config) };
		if ((servers[payload.name] ? JSON.stringify(servers[payload.name]) : null) !== payload.previous) throw new RpcError("conflict", "MCP 配置已变化，请重新登记建议");
		for (const section of ["env", "headers"]) for (const [key, value] of Object.entries((payload.mcpConfig[section] as Json | undefined) ?? {})) {
			if (isSecretReference(value)) (payload.mcpConfig[section] as Json)[key] = relocateSecretRef(String(value), this.secrets.dir);
		}
		servers[payload.name] = payload.mcpConfig;
		this.write({ ...config, mcpServers: servers });
		this.core.library.write("mcp", this.core.library.mcpKey({ source: this.file, name: payload.name }), { sourceKind: payload.sourceKind, sourceUrl: payload.sourceUrl ?? null,
			trust: "trusted", enabled: payload.mcpConfig.enabled !== false, butterflyAllowed: false }, mcpFingerprint(payload.mcpConfig));
		this.core.db.run("UPDATE proposals SET status='accepted',resolved_at=? WHERE id=?", Date.now(), id);
		this.core.broadcast({ event: "proposals.changed" });
		return { path: this.file, name: payload.name };
	}

	extensions(slot: { slotId: string }): ExtensionFactory[] {
		return [(pi) => {
			pi.registerTool({ name: "mcp_register", label: "登记 MCP", description: "Register or update an MCP server for user review. It remains untrusted until the user accepts it. This tool cannot grant trust or butterfly access.",
				parameters: { type: "object", properties: { server: { type: "object", properties: { name: { type: "string" }, transport: { type: "string", enum: ["stdio", "http"] }, command: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, url: { type: "string" }, description: { type: "string" }, exposure: { type: "string", enum: EXPOSURES }, env: { type: "object", additionalProperties: { type: "object", properties: { value: { type: "string" }, secret: { type: "boolean" } }, required: ["value", "secret"] } }, headers: { type: "object", additionalProperties: { type: "object", properties: { value: { type: "string" }, secret: { type: "boolean" } }, required: ["value", "secret"] } } }, required: ["name", "transport"] }, sourceUrl: { type: "string" }, sourceKind: { type: "string", enum: ["agent", "community"] } }, required: ["server"] } as never,
				execute: async (_id, input: { server: McpServerForm; sourceUrl?: string; sourceKind?: "agent" | "community" }) => {
					const live = this.core.slots.get(slot.slotId);
					const result = await this.save(input.server, undefined, { sourceKind: input.sourceKind === "agent" ? "agent" : input.sourceKind === "community" || input.sourceUrl ? "community" : "agent", sourceUrl: input.sourceUrl, cwd: live?.cwd, sourceSession: live?.info().sessionFile });
					return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
				},
			});
			pi.registerTool({ name: "mcp_test", label: "测试 MCP", description: "Start/connect one trusted MCP server, initialize, list tools and close. Returns duration, tool names and failure reason. Never counts as tool use; untrusted servers are blocked.",
				parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } as never,
				execute: async (_id, input: { name: string }) => {
					const live = this.core.slots.get(slot.slotId);
					if (!live) throw new RpcError("gone", "会话已关闭");
					if (live.info().sandbox && !this.list().find((entry) => entry.name === input.name)?.butterflyAllowed) throw new RpcError("forbidden", "此 MCP 服务未单独授权给蝶君");
					return { content: [{ type: "text", text: JSON.stringify(await this.test(input.name, live.cwd)) }], details: {} };
				},
			});
		}];
	}

	private register(): void {
		const core = this.core;
		const values = (v: unknown): Record<string, FormValue> =>
			Object.fromEntries(
				Object.entries((v as Record<string, { value?: unknown; secret?: unknown }>) ?? {}).map(([k, f]) => [k, { value: typeof f?.value === "string" ? f.value : "", secret: f?.secret === true }]),
			);
		core.register("mcp.list", (p) => ({ file: this.file, servers: this.list(str(p.cwd)) }));
		core.register("mcp.register", (p) => this.save(p.server as McpServerForm, undefined, { sourceKind: p.sourceUrl ? "community" : "agent", sourceUrl: str(p.sourceUrl), cwd: str(p.cwd) }));
		core.register("mcp.acceptProposal", (p) => this.acceptProposal(requireStr(p.id, "id")));
		core.register("mcp.test", (p) => this.test(requireStr(p.name, "name"), requireStr(p.cwd, "cwd"), str(p.source)));
		core.register("mcp.setButterflyAllowed", (p) => {
			const name = requireStr(p.name, "name");
			const source = str(p.source) ?? this.file;
			const cwd = str(p.cwd);
			const entry = this.list(cwd && core.isProjectTrusted(cwd) ? cwd : undefined).find((entry) => entry.name === name && locator(entry.source) === locator(source));
			if (!entry) throw new RpcError("not_found", "没有这个服务，或项目未获信任");
			if (p.allowed === true && entry.trust !== "trusted") throw new RpcError("untrusted", "请先在待确认里确认服务，再单独授权给蝶君");
			core.library.write("mcp", core.library.mcpKey({ source: entry.source, name }), { butterflyAllowed: p.allowed === true });
			core.broadcast({ event: "mcp.changed" }); return { ok: true };
		});
		core.register("mcp.save", async (p) => {
			const form = (p.server ?? {}) as Json;
			return this.save(
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
				p.sourceKind === "community" || p.sourceKind === "agent" ? { sourceKind: p.sourceKind, sourceUrl: str(p.sourceUrl) } : undefined,
			);
		});
		core.register("mcp.setEnabled", (p) => {
			if (str(p.source) && locator(p.source as string) !== locator(this.file)) throw new RpcError("read_only", "项目里的服务由项目配置管理");
			this.setEnabled(requireStr(p.name, "name"), p.enabled === true);
			return { ok: true };
		});
		core.register("mcp.setToolEnabled", (p) => { this.setToolEnabled(requireStr(p.name, "name"), str(p.source) ?? this.file, requireStr(p.tool, "tool"), p.enabled === true); return { ok: true }; });
		core.register("mcp.remove", (p) => {
			if (str(p.source) && locator(p.source as string) !== locator(this.file)) throw new RpcError("read_only", "项目里的服务由项目配置管理");
			this.remove(requireStr(p.name, "name"));
			return { ok: true };
		});
		core.register("mcp.status", (p) => this.status(requireStr(p.cwd, "cwd")));
	}
}
