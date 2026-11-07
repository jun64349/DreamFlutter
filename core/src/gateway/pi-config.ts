import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Core } from "../core.ts";
import { modelConfig, type Gateway } from "./gateway.ts";

export type PiJson = Record<string, any>;
export const PI_FILES = ["models.json", "auth.json", "settings.json"] as const;
export const GENERATED_NOTE = "// 由 DreamFlutter 渠道生成，请勿手改；请在应用中编辑渠道。\n";
export function fileHash(path: string): string | null { return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null; }

/** JSONC reader matching Pi's comment support, without interpreting credentials. */
export function readPiJson(path: string): PiJson {
	if (!existsSync(path)) return {};
	const source = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	let output = "", quoted = false, escaped = false;
	for (let i = 0; i < source.length; i++) {
		const c = source[i]!, n = source[i + 1];
		if (quoted) { output += c; if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; }
		else if (c === '"') { quoted = true; output += c; }
		else if (c === "/" && n === "/") { while (i < source.length && source[i] !== "\n") i++; output += "\n"; }
		else if (c === "/" && n === "*") { i += 2; while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++; i++; output += " "; }
		else output += c;
	}
	try { const value = JSON.parse(output); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
	catch { throw new Error(`无法解析 ${path}；请修正 JSON 配置后重试。`); }
}

export function snapshotFiles(agentDir: string, backupDir: string): void {
	mkdirSync(backupDir, { recursive: true });
	const present: string[] = [];
	for (const name of PI_FILES) if (existsSync(join(agentDir, name))) { copyFileSync(join(agentDir, name), join(backupDir, name)); present.push(name); }
	writeFileSync(join(backupDir, "files.json"), JSON.stringify(present));
}

export function generatedConfig(core: Core, gateway: Gateway, source: PiJson = {}): PiJson {
	const providers: PiJson = {};
	const auth = readPiJson(join(core.agentDir, "auth.json"));
	const migration = core.db.get<{ value: string }>("SELECT value FROM pi_channel_migration WHERE id=1");
	const savedOAuth = migration ? JSON.parse(migration.value).oauthConfigs : undefined;
	// Only OAuth-owned provider definitions remain outside channels.
	if (savedOAuth) Object.assign(providers, savedOAuth);
	else for (const [id, config] of Object.entries(source.providers ?? {})) if (auth[id]?.type === "oauth") providers[id] = config;
	for (const channel of gateway.channels().filter((c) => c.source === "df" && c.enabled)) {
		const key = core.db.get<{ secret: string }>("SELECT secret FROM gateway_keys WHERE channel_id=? AND enabled=1 ORDER BY sort,created_at LIMIT 1", channel.id);
		const extra = core.db.get<{ config: string }>("SELECT config FROM pi_channel_map WHERE channel_id=?", channel.id);
		const previous = extra ? JSON.parse(extra.config) : {};
		providers[channel.provider] = { ...previous, name: channel.name, baseUrl: channel.baseUrl, api: channel.api, ...(key ? { apiKey: key.secret } : {}),
			headers: channel.headers ?? {}, authHeader: channel.authHeader, models: channel.models.map((m) => modelConfig(channel, m)) };
		delete providers[channel.provider].modelOverrides;
	}
	return { providers };
}

/** Uses only public credential-blind catalog methods; !commands are never executed. */
export async function validatePiConfig(core: Core, path: string): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ modelsPath: path, authPath: join(core.agentDir, "auth.json"), refreshOnCreate: false });
	if (runtime.getError()) throw new Error("Pi 公开接口拒绝了生成的模型配置；旧配置已保留，请检查迁移备份。");
	return runtime;
}

export async function writeGenerated(core: Core, gateway: Gateway, source?: PiJson): Promise<{ hash: string; at: number }> {
	const target = join(core.agentDir, "models.json"), temp = `${target}.t66-${process.pid}.tmp`;
	const config = generatedConfig(core, gateway, source ?? readPiJson(target));
	writeFileSync(temp, GENERATED_NOTE + JSON.stringify(config, null, 2) + "\n", "utf8");
	try { await validatePiConfig(core, temp); renameSync(temp, target); }
	finally { rmSync(temp, { force: true }); }
	return { hash: fileHash(target)!, at: Date.now() };
}
