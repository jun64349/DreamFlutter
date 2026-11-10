import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { ExtensionFactory, McpServerEntry } from "@earendil-works/pi-coding-agent";
import type { Db } from "../db.ts";
import type { SecurityAudit } from "../security/audit.ts";
import { builtinSkillKey, isBuiltinSkillPath } from "./builtin-skills.ts";
import { mcpIdentity, mcpSourceKey, parseMcpIdentity } from "../security/mcp-identity.ts";

export type EntryKind = "skill" | "template" | "mcp";
export type SourceKind = "builtin" | "user" | "agent" | "community";
export interface EntryMetadata {
	sourceKind: SourceKind;
	sourceUrl: string | null;
	trust: "trusted" | "untrusted";
	enabled: boolean;
	butterflyAllowed: boolean;
	usageCount: number;
	lastUsedAt: number | null;
	identityConflict?: string;
}
interface EntryRow {
	kind: EntryKind; locator: string; source_kind: SourceKind; source_url: string | null;
	trusted: number; enabled: number; butterfly_allowed: number; fingerprint: string | null;
	usage_count: number; last_used_at: number | null;
	identity_conflict: string | null;
}

export function locator(path: string): string { return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path); }
export function digest(value: unknown): string {
	const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable) : item && typeof item === "object"
		? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, stable(val)])) : item;
	return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
export function mcpFingerprint(config: unknown): string {
	const { enabled: _enabled, exposure: _exposure, toolExposure: _toolExposure, dfLibrary: _provenance, ...execution } = config as Record<string, unknown>;
	return digest(execution);
}
/** A reviewed skill includes its scripts/references, not just SKILL.md. Never follows links. */
export function fileFingerprint(kind: "skill" | "template", path: string): string {
	const hash = createHash("sha256");
	let count = 0, bytes = 0;
	const visit = (file: string, relative: string) => {
		const stat = lstatSync(file);
		if (stat.isSymbolicLink()) throw new Error("技能不能包含符号链接或目录联接");
		if (++count > 2000 || (bytes += stat.isFile() ? stat.size : 0) > 32 * 1024 * 1024) throw new Error("技能文件过多或超过 32 MB 检查上限");
		hash.update(`${relative}\0`);
		if (stat.isDirectory()) for (const name of readdirSync(file).sort()) visit(join(file, name), `${relative}/${name}`);
		else if (stat.isFile()) hash.update(readFileSync(file));
		else throw new Error("技能包含不支持的特殊文件");
	};
	visit(kind === "skill" && /[\\/]SKILL\.md$/i.test(path) ? dirname(path) : path, "");
	return hash.digest("hex");
}

/** Persistent policy shared by management, resource loading and the actual MCP transport. */
export class LibraryRegistry {
	private db: Db;
	private audit: SecurityAudit;
	private changed?: () => void;
	private userMcpFile?: string;
	constructor(db: Db, audit: SecurityAudit, changed?: () => void, userMcpFile?: string) { this.db = db; this.audit = audit; this.changed = changed; this.userMcpFile = userMcpFile; }
	private key(kind: EntryKind, key: string): string {
		if (kind === "skill") return builtinSkillKey(key) ?? key;
		const mcp = kind === "mcp" ? parseMcpIdentity(key, true) : undefined;
		return mcp ? mcpIdentity(mcp.source, mcp.name) : key;
	}
	private row(kind: EntryKind, key: string): EntryRow | undefined {
		key = this.key(kind, key);
		return this.db.get<EntryRow>("SELECT * FROM library_entries WHERE kind=? AND locator=?", kind, key);
	}
	get(kind: EntryKind, key: string): EntryMetadata {
		const row = this.row(kind, key);
		return { sourceKind: row?.source_kind ?? "user", sourceUrl: row?.source_url ?? null,
			trust: row ? row.trusted && !row.identity_conflict ? "trusted" : "untrusted" : kind === "mcp" ? "untrusted" : "trusted", enabled: row ? !!row.enabled && !row.identity_conflict : kind !== "mcp",
			butterflyAllowed: !!row?.butterfly_allowed && !row?.identity_conflict, usageCount: row?.usage_count ?? 0, lastUsedAt: row?.last_used_at ?? null, ...(row?.identity_conflict ? { identityConflict: row.identity_conflict } : {}) };
	}
	/** Existing user files retain v0.6 behavior. Managed imports/proposals always set provenance explicitly. */
	ensure(kind: EntryKind, key: string): EntryMetadata {
		if (!this.row(kind, key)) this.write(kind, key, { sourceKind: "user", sourceUrl: null, trust: kind === "mcp" ? "untrusted" : "trusted", enabled: kind !== "mcp" });
		return this.get(kind, key);
	}
	write(kind: EntryKind, key: string, change: Partial<EntryMetadata>, fingerprint?: string | null): EntryMetadata {
		key = this.key(kind, key);
		const old = this.row(kind, key), previous = this.get(kind, key), next = { ...previous, ...change };
		if (old && JSON.stringify(previous) === JSON.stringify(next) && (fingerprint === undefined || fingerprint === old.fingerprint)) return previous;
		this.db.run(`INSERT INTO library_entries(kind,locator,source_kind,source_url,trusted,enabled,butterfly_allowed,fingerprint)
			VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,locator) DO UPDATE SET source_kind=excluded.source_kind,
			source_url=excluded.source_url,trusted=excluded.trusted,enabled=excluded.enabled,butterfly_allowed=excluded.butterfly_allowed,fingerprint=excluded.fingerprint,
			identity_conflict=CASE WHEN excluded.trusted=1 THEN NULL ELSE library_entries.identity_conflict END`,
			kind, key, next.sourceKind, next.sourceUrl, Number(next.trust === "trusted"), Number(next.enabled), Number(next.butterflyAllowed), fingerprint === undefined ? old?.fingerprint ?? null : fingerprint);
		if (!old || previous.sourceKind !== next.sourceKind || previous.sourceUrl !== next.sourceUrl || previous.trust !== next.trust || previous.butterflyAllowed !== next.butterflyAllowed) {
			this.audit.record("library", `${kind}:${key}`, next.trust, `来源=${next.sourceKind}; 出处=${next.sourceUrl ?? "未提供"}; 蝶君=${next.butterflyAllowed ? "允许" : "禁止"}`);
		}
		if (old) this.changed?.();
		return this.get(kind, key);
	}
	fileAllowed(kind: "skill" | "template", path: string): boolean {
		return this.get(kind, locator(path)).enabled && this.fileTrusted(kind, path);
	}
	fileTrusted(kind: "skill" | "template", path: string): boolean {
		const key = locator(path), row = this.row(kind, key);
		if (!row) return true;
		if (!row.trusted) return false;
		if (row.fingerprint) {
			try { if (fileFingerprint(kind, path) === row.fingerprint) return true; } catch { /* fail closed */ }
			this.write(kind, key, { trust: "untrusted", enabled: false, butterflyAllowed: false });
			return false;
		}
		return true;
	}
	mcpKey(entry: Pick<McpServerEntry, "source" | "name">): string { return mcpIdentity(entry.source, entry.name); }
	/** Recover old case-folded identities only when the actual configuration makes the match unique. */
	ensureMcp(entry: Pick<McpServerEntry, "source" | "name" | "config">): EntryMetadata {
		const key = this.mcpKey(entry), source = mcpSourceKey(entry.source), fold = entry.name.toLowerCase();
		let names: string[] = [entry.name];
		let configured: Record<string, Record<string, unknown>> | undefined;
		try { const file = JSON.parse(readFileSync(entry.source, "utf8").replace(/^\uFEFF/, "")); if (file.mcpServers && typeof file.mcpServers === "object" && !Array.isArray(file.mcpServers)) { configured = file.mcpServers; names = Object.keys(configured!).filter((name) => name.toLowerCase() === fold); } } catch { /* a virtual/runtime registration is not a direct legacy user file */ }
		const matches = this.db.all<EntryRow>("SELECT * FROM library_entries WHERE kind='mcp'").filter((row) => {
			const id = parseMcpIdentity(row.locator, true);
			return id && mcpSourceKey(id.source) === source && id.name.toLowerCase() === fold && !(row.identity_conflict && configured && !Object.hasOwn(configured, id.name));
		});
		if (names.length > 1 || matches.length > 1) {
			const reason = "MCP 服务名大小写或历史登记冲突，未合并策略/使用记录；请将服务改为无歧义的名称后重新确认";
			if (!this.row("mcp", key)) this.write("mcp", key, { sourceKind: matches[0]?.source_kind ?? "user", trust: "untrusted", enabled: false });
			for (const row of new Map([...matches, this.row("mcp", key)!].map((value) => [value.locator, value])).values()) {
				if (row.identity_conflict === reason && !row.trusted && !row.enabled && !row.butterfly_allowed) continue;
				this.db.run("UPDATE library_entries SET trusted=0,enabled=0,butterfly_allowed=0,identity_conflict=? WHERE kind='mcp' AND locator=?", reason, row.locator);
				this.audit.record("library", row.locator, "untrusted", reason); this.changed?.();
			}
			return this.get("mcp", key);
		}
		if (matches.length === 1 && matches[0]!.locator !== key) {
			const old = matches[0]!.locator;
			this.db.transaction(() => {
				this.db.run("UPDATE library_entries SET locator=? WHERE kind='mcp' AND locator=?", key, old);
				this.db.run("UPDATE library_usage SET locator=? WHERE kind='mcp' AND locator=?", key, old);
			});
			this.audit.record("library", key, "identity-migrated", "旧 MCP 定位符按配置中的唯一大小写匹配找回；信任、来源、指纹与使用记录未改变");
			this.changed?.();
		}
		if (!this.row("mcp", key)) {
			const literal = configured?.[entry.name];
			const marker = (literal?.dfLibrary ?? (entry.config as unknown as Record<string, unknown>).dfLibrary) as { sourceKind?: SourceKind; sourceUrl?: string } | undefined;
			const proposal = this.userMcpFile && mcpSourceKey(this.userMcpFile) === source ? this.db.all<{ payload: string }>("SELECT payload FROM proposals WHERE kind='mcp'").map((row) => { try { return JSON.parse(row.payload) as { name?: string; sourceKind?: SourceKind; sourceUrl?: string }; } catch { return undefined; } }).find((item) => item?.name?.toLowerCase() === fold) : undefined;
			const managed = !!marker || !!proposal;
			const legacyUser = !managed && !!literal && typeof literal === "object" && mcpFingerprint(literal) === mcpFingerprint(entry.config);
			this.write("mcp", key, { sourceKind: marker?.sourceKind ?? proposal?.sourceKind ?? "user", sourceUrl: marker?.sourceUrl ?? proposal?.sourceUrl ?? null, trust: legacyUser ? "trusted" : "untrusted", enabled: legacyUser });
		}
		return this.get("mcp", key);
	}
	mcpAllowed(entry: McpServerEntry, butterfly = false): boolean {
		const key = this.mcpKey(entry), meta = this.ensureMcp(entry), row = this.row("mcp", key)!;
		if (row.fingerprint && row.fingerprint !== mcpFingerprint(entry.config)) return false;
		return entry.config.enabled !== false && meta.trust === "trusted" && meta.enabled && (!butterfly || meta.butterflyAllowed);
	}
	mcpTrusted(entry: McpServerEntry): boolean {
		const key = this.mcpKey(entry), meta = this.ensureMcp(entry), row = this.row("mcp", key)!;
		return meta.trust === "trusted" && (!row.fingerprint || row.fingerprint === mcpFingerprint(entry.config));
	}
	/** Re-read tool policy on every call so an already open transport obeys it. */
	mcpToolAllowed(entry: McpServerEntry, tool: string): boolean {
		try {
			const literal = JSON.parse(readFileSync(entry.source, "utf8").replace(/^\uFEFF/, "")).mcpServers?.[entry.name];
			if (!literal) return false;
			let effective = literal;
			if (entry.override) {
				const override = JSON.parse(readFileSync(entry.override, "utf8").replace(/^\uFEFF/, "")).mcpServers?.[entry.name];
				if (override) effective = { ...literal, ...override };
			}
			return (effective.toolExposure?.[tool] ?? effective.exposure) !== "hidden";
		} catch { return false; }
	}
	/** Guard literal host shell invocations of managed, unreviewed skill scripts. No script is run by tests. */
	blockedHostScript(command: string, cwd: string): string | undefined {
		const normalize = (value: string) => value.replaceAll("\\", "/").replace(/["'`]/g, "").toLowerCase();
		for (const row of this.db.all<EntryRow>("SELECT * FROM library_entries WHERE kind='skill'")) {
			if (row.trusted && this.fileTrusted("skill", row.locator)) continue;
			const root = dirname(row.locator), scriptRoot = join(root, "scripts");
			const text = normalize(command), working = normalize(resolve(cwd)), scripts = normalize(scriptRoot);
			const rel = normalize(relative(cwd, scriptRoot));
			if (text.includes(scripts) || rel && !rel.startsWith("../") && text.includes(rel)
				|| (working === normalize(root) || working.startsWith(normalize(root) + "/")) && /scripts\/|\.(?:py|[cm]?js|ts|ps1|sh|cmd|bat)\b/.test(text)) return root;
		}
		return undefined;
	}
	/** This guard also runs in minimal mode, where management tools are deliberately absent. */
	extension(sandboxed: boolean, resources: () => { skills: { name: string; filePath: string }[]; prompts: { name: string; filePath: string }[] }, usagePrefix: () => string): ExtensionFactory {
		return (pi) => {
			// Child runtimes may share a parent's run/slot prefix and tool-call ids.
			// Deduplicate deliveries inside this runtime, never across actual loads.
			const runtimeId = randomUUID();
			let pendingCommand: { kind: "skill" | "template"; path: string } | undefined;
			pi.on("input", (event, ctx) => {
				pendingCommand = undefined;
				const skillName = event.text.match(/^\/skill:([^\s]+)/)?.[1], templateName = event.text.match(/^\/([^\s:]+)/)?.[1];
				const entry = skillName ? resources().skills.find((s) => s.name === skillName) : templateName ? resources().prompts.find((t) => t.name === templateName) : undefined;
				if (!entry) return;
				const kind = skillName ? "skill" : "template";
				if (!this.fileAllowed(kind, entry.filePath)) {
					this.audit.record("library", entry.filePath, "deny", "停用或未信任条目的直接命令被拦截");
					ctx.ui.notify("此条目已停用或未获信任，请在技能页确认后重新加载", "warning");
					return { action: "handled" };
				}
				pendingCommand = { kind, path: entry.filePath };
			});
			pi.on("before_agent_start", (event) => {
				const entry = pendingCommand; pendingCommand = undefined;
				if (entry && (entry.kind === "template" || "prompt" in event && event.prompt.startsWith("<skill "))) this.used(entry.kind, locator(entry.path));
			});
			pi.on("tool_call", (event, ctx) => {
				if (!sandboxed && ["write", "edit"].includes(event.toolName)) {
					const input = event.input as Record<string, unknown>, path = input.file_path ?? input.path;
					if (typeof path === "string" && isBuiltinSkillPath(resolve(ctx.cwd, path))) return { block: true, reason: "内置技能随版本更新且只读，请先在管理页复制为用户技能再修改" };
				}
				if (event.toolName === "skill") {
					const skill = resources().skills.find((s) => s.name === event.input.name);
					if (skill && !this.fileAllowed("skill", skill.filePath)) return { block: true, reason: "技能已停用或未获信任，请先在待确认里审阅" };
				}
				if (sandboxed || !["pwsh", "powershell", "bash"].includes(event.toolName)) return;
				const input = event.input as Record<string, unknown>;
				if (typeof input.command !== "string") return;
				const root = this.blockedHostScript(input.command, typeof input.workdir === "string" ? resolve(ctx.cwd, input.workdir) : ctx.cwd);
				if (root) { this.audit.record("library", root, "deny", "未信任技能脚本禁止在本机执行"); return { block: true, reason: "未信任技能脚本不能在本机执行，请先在待确认里审阅" }; }
			});
			pi.on("tool_result", (event, ctx) => {
				if (event.isError) return;
				const details = event.details as { path?: string } | undefined, id = `${usagePrefix()}:${runtimeId}:${event.toolCallId}`;
				if (event.toolName === "skill" && details?.path) this.used("skill", locator(details.path), id);
				if (event.toolName === "read") {
					const file = event.input.file_path ?? event.input.path;
					if (typeof file !== "string") return;
					const path = resolve(ctx.cwd, file);
					if (resources().skills.some((skill) => locator(skill.filePath) === locator(path)) && this.fileAllowed("skill", path)) this.used("skill", locator(path), id);
				}
			});
		};
	}
	used(kind: EntryKind, key: string, eventId: string = randomUUID()): void {
		key = this.key(kind, key);
		this.ensure(kind, key);
		this.db.transaction(() => {
			const at = Date.now();
			const inserted = this.db.run("INSERT OR IGNORE INTO library_usage(event_id,kind,locator,at) VALUES(?,?,?,?)", eventId, kind, key, at);
			if (inserted.changes) this.db.run("UPDATE library_entries SET usage_count=usage_count+1,last_used_at=? WHERE kind=? AND locator=?", at, kind, key);
		});
		this.changed?.();
	}
}
