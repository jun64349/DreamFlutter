import { homedir } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Core } from "../core.ts";
import { APPROVAL_TITLE } from "../pi/dialogs.ts";
import { SecurityAudit, type AuditContext } from "./audit.ts";
import { canonicalPath, classifyPath, pathKey, type PathReading, type PathRoots } from "./paths.ts";
import { MASK, redact, redactValue, rememberSecret } from "./redaction.ts";
import { approveSecurityCall, safeLiteralCommand } from "./command.ts";
import { dpapiMany, SecretStore } from "../modules/secrets.ts";

const ONCE = "本次允许", WORKSPACE = "始终允许此路径", DENY = "拒绝";
export interface SecurityFileAccess {
	authorize(path: string, operation?: string, quiet?: boolean): Promise<boolean>;
	read(path: string, content: string): Promise<string>;
	assertWritable(path: string, content: string): Promise<void>;
}

export class SecurityService {
	private core: Core;
	readonly audit: SecurityAudit;
	readonly roots: PathRoots;
	private timer: NodeJS.Timeout;
	private credentialSignature?: string;
	private credentialLoad = Promise.resolve();
	private credentialCheckedAt = 0;
	constructor(core: Core, roots?: PathRoots) {
		this.core = core;
		this.roots = roots ?? { home: homedir(), localAppData: process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"),
			appData: process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), secrets: join(core.paths.dataDir, "secrets") };
		this.audit = new SecurityAudit(core.db);
		this.timer = setInterval(() => this.audit.cleanup(), 60 * 60 * 1000);
		this.timer.unref();
		core.onShutdown(() => clearInterval(this.timer));
		core.register("security.exceptions", async (p) => ({ paths: await this.exceptions(String(p.cwd ?? "")) }));
		core.register("security.addException", async (p) => {
			if (typeof p.cwd !== "string" || !p.cwd.trim() || typeof p.path !== "string" || !p.path.trim()) throw new Error("请填写工作区和路径");
			await this.addException(p.cwd, p.path); return { ok: true };
		});
		core.register("security.removeException", async (p) => {
			const workspace = await this.workspace(String(p.cwd ?? ""));
			const current = core.settings.get().securityPathExceptions;
			core.settings.update({ securityPathExceptions: { ...current, [workspace]: (current[workspace] ?? []).filter((path) => path !== p.path) } });
			return { ok: true };
		});
		core.register("security.audit", (p) => ({ events: this.audit.query({ before: typeof p.before === "number" ? p.before : undefined, limit: typeof p.limit === "number" ? p.limit : undefined, kind: typeof p.kind === "string" ? p.kind : undefined }) }));
		core.register("security.export", () => ({ name: "security-audit.jsonl", text: this.audit.export() }));
		core.declareBackup({ id: "security", title: "本地安全审计", tables: ["security_audit"] });
	}
	private async workspace(cwd: string): Promise<string> {
		if (!cwd.trim()) throw new Error("请选择工作区");
		return pathKey(await canonicalPath(cwd, cwd));
	}
	async exceptions(cwd: string): Promise<string[]> { return this.core.settings.get().securityPathExceptions[await this.workspace(cwd)] ?? []; }
	async addException(cwd: string, path: string): Promise<void> {
		const workspace = await this.workspace(cwd), canonical = await canonicalPath(path, cwd);
		const current = this.core.settings.get().securityPathExceptions;
		this.core.settings.update({ securityPathExceptions: { ...current, [workspace]: [...new Set([...(current[workspace] ?? []), canonical])] } });
		this.audit.record("exception", canonical, "allow", "用户添加工作区路径例外");
	}
	async inspect(path: string, cwd: string): Promise<PathReading> {
		const canonical = await canonicalPath(path, cwd);
		// Roots can themselves be relocated or linked (data migration). Resolve them on each access.
		const entries = await Promise.all(Object.entries(this.roots).map(async ([key, root]) => [key, await canonicalPath(root, cwd)]));
		return classifyPath(canonical, Object.fromEntries(entries) as unknown as PathRoots);
	}
	scope(cwd: string, unattended: boolean, context: () => AuditContext = () => ({})): SecurityScope {
		return new SecurityScope(this, cwd, unattended, context);
	}
	approvalMode(): string { return this.core.settings.get().approvalMode; }
	/** Use the normal credential decoder; no test path ever points at the user's store. */
	loadKnownSecrets(): Promise<void> {
		const load = this.credentialLoad.then(async () => {
			if (Date.now() - this.credentialCheckedAt < 1000) return;
			const store = new SecretStore(this.core.paths.dataDir);
			const files = await readdir(store.dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
			const blobs = await Promise.all(files.filter((file) => file.isFile() && file.name.endsWith(".dpapi")).sort((a, b) => a.name.localeCompare(b.name)).map((file) => readFile(join(store.dir, file.name), "utf8")));
			const signature = JSON.stringify([store.dir, blobs]);
			if (signature === this.credentialSignature) { this.credentialCheckedAt = Date.now(); return; }
			for (const secret of await dpapiMany("unprotect", blobs)) rememberSecret(secret);
			this.credentialSignature = signature;
			this.credentialCheckedAt = Date.now();
		});
		this.credentialLoad = load.catch(() => {});
		return load;
	}
}

/** Per-runtime state: never lets one session's one-time answer authorize another call. */
export class SecurityScope implements SecurityFileAccess {
	sandboxed = false;
	readonly service: SecurityService;
	readonly workspace: string;
	readonly unattended: boolean;
	readonly context: () => AuditContext;
	private ctx?: ExtensionContext;
	private masked = new Set<string>();
	private cwd: () => string;
	commandCwd?: () => Promise<string>;
	constructor(service: SecurityService, workspace: string, unattended: boolean, context: () => AuditContext) {
		this.service = service; this.workspace = workspace; this.unattended = unattended; this.context = context; this.cwd = () => workspace;
	}
	bindCwd(cwd: () => string): void { this.cwd = cwd; }
	async authorize(path: string, operation = "file", quiet = false): Promise<boolean> {
		await this.service.loadKnownSecrets();
		const reading = await this.service.inspect(path, this.cwd());
		const exceptions = await this.service.exceptions(this.workspace);
		const key = pathKey(reading.path);
		let allowed = reading.decision === "allow" || exceptions.some((p) => key === pathKey(p) || key.startsWith(`${pathKey(p)}/`));
		let reason = allowed && reading.decision !== "allow" ? "用户工作区路径例外" : reading.reason;
		if (!allowed && reading.decision === "confirm" && !quiet && !this.unattended && this.ctx?.hasUI) {
			const choice = await this.ctx.ui.select(`${APPROVAL_TITLE}\n\n敏感路径：${redact(reading.path, true)}\n${reading.reason}`, [ONCE, WORKSPACE, DENY], { signal: this.ctx.signal });
			allowed = choice === ONCE || choice === WORKSPACE;
			if (choice === WORKSPACE) await this.service.addException(this.workspace, reading.path);
			reason = allowed ? "用户确认敏感路径" : "用户未允许敏感路径";
			this.service.audit.record("approval", reading.path, allowed ? "allow" : "deny", reason, this.context());
		}
		if (!allowed && reading.decision === "confirm" && this.unattended) reason = "无人值守运行拒绝需确认路径";
		this.service.audit.record("path", reading.path, allowed ? "allow" : "deny", `${operation}: ${reason}`, this.context());
		if (!allowed && !quiet) throw new Error(`安全策略拒绝访问：${redact(reading.path, true)}（${reason}；可由用户在安全设置添加工作区例外）`);
		return allowed;
	}
	async read(path: string, content: string): Promise<string> {
		const safe = redact(content);
		if (safe !== content) {
			this.masked.add(pathKey(await canonicalPath(path, this.cwd())));
			this.service.audit.record("redaction", path, "masked", "文件内容已遮盖；禁止写入或编辑此文件", this.context());
		}
		return safe;
	}
	async assertWritable(path: string, content: string): Promise<void> {
		if (content.includes(MASK) || this.masked.has(pathKey(await canonicalPath(path, this.cwd())))) {
			this.service.audit.record("path", path, "deny", "禁止将遮盖后的文件或占位符写回", this.context());
			throw new Error("文件内容曾被遮盖，或写入包含遮盖占位符；为避免损坏原文件，已拒绝写入/编辑。请用户自行修改。");
		}
	}
	/** S1 shell rule is independent of approvalMode and remembered tool permissions. */
	async shellNeedsApproval(command: string, cwd?: string): Promise<boolean> {
		const base = cwd ?? await this.commandCwd?.() ?? this.cwd();
		const roots = this.service.roots;
		const expanded = command.replace(/\$(?:env:)?(?:USERPROFILE|HOME)\b|%USERPROFILE%/gi, roots.home)
			.replace(/\$env:LOCALAPPDATA\b|%LOCALAPPDATA%/gi, roots.localAppData).replace(/\$env:APPDATA\b|%APPDATA%/gi, roots.appData);
		const tokens = expanded.match(/'[^']*'|"[^"]*"|[^\s;|&()]+/g) ?? [];
		for (let token of tokens) {
			token = token.replace(/^['"]|['"]$/g, "").replace(/^-[\w-]+[:=]/, "");
			if (!token || token.startsWith("-")) continue;
			if (/^~[\\/]/.test(token)) token = join(roots.home, token.slice(2));
			try {
				if ((await this.service.inspect(resolve(base, token), base)).decision === "deny") return true;
			} catch { return true; }
		}
		return false;
	}
	extension(): ExtensionFactory {
		return (pi) => {
			pi.on("session_start", async (_event, ctx) => { this.ctx = ctx; await this.service.loadKnownSecrets(); });
			pi.on("before_agent_start", async () => { await this.service.loadKnownSecrets(); });
			pi.on("before_provider_headers", (event) => {
				for (const [name, value] of Object.entries(event.headers)) if (typeof value === "string" && /authorization|api[-_]?key|token/i.test(name)) {
					rememberSecret(value); rememberSecret(value.replace(/^(Bearer|Basic)\s+/i, ""));
				}
			});
			pi.on("tool_call", async (event, ctx) => {
				this.ctx = ctx;
				try { await this.service.loadKnownSecrets(); }
				catch { return { block: true, reason: "应用密钥无法通过正式凭据流程装载，已拒绝本次工具操作；请检查密钥存储。" }; }
				const input = event.input as Record<string, unknown>;
				if (["pwsh", "powershell", "bash"].includes(event.toolName) && typeof input.command === "string") {
					try {
					const sensitive = await this.shellNeedsApproval(input.command, typeof input.workdir === "string" ? resolve(this.cwd(), input.workdir) : undefined);
					const unsafe = event.toolName === "bash" || !safeLiteralCommand(input.command);
					const required = sensitive || (!this.sandboxed && unsafe && this.service.approvalMode() !== "off");
					this.service.audit.record("command", event.toolName, required ? "confirm" : "allow", sensitive ? "命令参数直接包含默认拒绝路径" : unsafe ? "未证明为安全 PowerShell 字面量命令" : "保守 PowerShell 字面量命令", { ...this.context(), requestId: event.toolCallId });
					if (required) {
						const choice = !this.unattended && ctx.hasUI ? await ctx.ui.select(`${APPROVAL_TITLE}\n\n${sensitive ? "命令直接包含敏感路径。" : "此命令需要批准。"}\n${redact(input.command, true)}`, ["允许", DENY], { signal: ctx.signal }) : undefined;
						this.service.audit.record("approval", event.toolName, choice === "允许" ? "allow" : "deny", choice === "允许" ? "用户批准本次命令" : "未获用户批准（含无人值守）", { ...this.context(), requestId: event.toolCallId });
						if (choice !== "允许") return { block: true, reason: "敏感路径或命令判断要求用户批准，本次未获批准" };
						approveSecurityCall(input);
					}
					} catch { return { block: true, reason: "无法安全判断命令路径或完成审批，已拒绝本次操作。" }; }
				}
				// Harness tools guard at their actual I/O, using their live cwd. Other registered file tools guard here.
				if (["read", "write", "edit", "read_image", "grep", "glob", "working_directory", "skill"].includes(event.toolName)) return;
				try {
					for (const key of ["file_path", "path"]) if (typeof input[key] === "string" && !/^https?:/i.test(input[key] as string)) await this.authorize(resolve(ctx.cwd, input[key] as string), event.toolName);
				} catch (error) { return { block: true, reason: (error as Error).message }; }
			});
			pi.on("tool_result", async (event) => {
				if (event.details && typeof event.details === "object" && "securityRedacted" in event.details && event.details.securityRedacted === true) {
					const path = event.input.file_path ?? event.input.path;
					if (typeof path === "string") this.masked.add(pathKey(await canonicalPath(path, this.cwd())));
					this.service.audit.record("redaction", event.toolName, "masked", "完整文档在分页前遮盖", { ...this.context(), requestId: event.toolCallId });
				}
				const result = { content: redactValue(event.content), details: redactValue(event.details), structuredContent: redactValue(event.structuredContent) };
				if (JSON.stringify(result) !== JSON.stringify({ content: event.content, details: event.details, structuredContent: event.structuredContent })) {
					const path = event.input.file_path ?? event.input.path;
					if (typeof path === "string" && ["read", "read_document", "read_image"].includes(event.toolName)) this.masked.add(pathKey(await canonicalPath(path, this.cwd())));
					this.service.audit.record("redaction", event.toolName, "masked", "工具输出已遮盖（不记录内容）", { ...this.context(), requestId: event.toolCallId });
				}
				return result;
			});
		};
	}
}
