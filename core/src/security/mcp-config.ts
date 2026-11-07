import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedMcpConfig, McpServerConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";
import { redact } from "./redaction.ts";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): boolean => value === undefined || record(value) && Object.values(value).every((item) => typeof item === "string");
const exposures = new Set(["codemode", "direct", "deferred", "hidden"]);

/** Public mcpServers config contract, bound to this core's explicit agentDir rather than the CLI's global directory. */
export function loadSecurityMcpConfig(agentDir: string, cwd: string, trusted: boolean): LoadedMcpConfig {
	const servers = new Map<string, McpServerEntry>(), errors: string[] = [];
	let autoEnableCodemode = true;
	const project = join(cwd, ".pi", "mcp.json");
	for (const [source, scope] of [[join(agentDir, "mcp.json"), "global"], ...(trusted ? [[project, "project"]] : [])]) {
		if (!existsSync(source!)) continue;
		try {
			const config: unknown = JSON.parse(readFileSync(source!, "utf8").replace(/^\uFEFF/, ""));
			if (!record(config) || config.mcpServers !== undefined && !record(config.mcpServers)) throw new Error("mcpServers 必须是对象");
			if (typeof config.autoEnableCodemode === "boolean") autoEnableCodemode = config.autoEnableCodemode;
			for (const [name, raw] of Object.entries((config.mcpServers ?? {}) as Record<string, unknown>)) {
				try {
					if (!/^[A-Za-z0-9_-]+$/.test(name) || !record(raw)) throw new Error("服务名称或配置无效");
					const override = scope === "project" && raw.command === undefined && raw.url === undefined && raw.type === undefined;
					const base = servers.get(name);
					if (override && (!base || Object.keys(raw).some((key) => !["enabled", "exposure", "toolExposure"].includes(key)))) throw new Error("项目覆盖只能修改已存在服务的 enabled/exposure/toolExposure");
					const value = override ? { ...base!.config, ...raw } : raw;
					if (value.url !== undefined) {
						if (typeof value.url !== "string" || !/^https?:\/\//i.test(value.url) || value.command !== undefined || !strings(value.headers)) throw new Error("HTTP 配置无效");
						if (scope === "project" && !override && value.auth) throw new Error("项目配置不能使用服务商身份认证");
					} else if (typeof value.command !== "string" || !value.command.trim() || !strings(value.env) || value.args !== undefined && (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string"))) throw new Error("stdio 命令、参数或环境变量无效");
					if (value.enabled !== undefined && typeof value.enabled !== "boolean" || value.timeout !== undefined && (typeof value.timeout !== "number" || !Number.isFinite(value.timeout) || value.timeout <= 0) || value.exposure !== undefined && !exposures.has(String(value.exposure))) throw new Error("服务启用状态、超时或暴露方式无效");
					const collision = [...servers.keys()].find((key) => key !== name && key.replaceAll("-", "_") === name.replaceAll("-", "_"));
					if (collision) throw new Error("服务名称的工具命名空间冲突");
					servers.set(name, override ? { ...base!, config: value as unknown as McpServerConfig, override: source } : { name, config: value as unknown as McpServerConfig, source: source!, scope: scope as "global" | "project" });
				} catch (error) { errors.push(redact(`${source}: ${name}: ${(error as Error).message}`, true)); }
			}
		} catch (error) { errors.push(redact(`${source}: ${(error as Error).message}`, true)); }
	}
	return { servers: [...servers.values()], errors, autoEnableCodemode, projectConfig: trusted ? project : undefined };
}
