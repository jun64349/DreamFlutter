import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { CORE_VERSION, RpcError, requireStr, type Core, type CoreModule } from "../core.ts";
import { createBackup } from "../backup/export.ts";
import { redact, rememberSecret } from "../security/redaction.ts";
import type { Providers } from "../modules/providers.ts";
import type { Gateway } from "./gateway.ts";
import { catalogModel } from "./catalog.ts";
import { fileHash, PI_FILES, readPiJson, snapshotFiles, validatePiConfig, writeGenerated, type PiJson } from "./pi-config.ts";
import { canLoginChannelOAuth } from "./pi-oauth-policy.ts";

export type MigrationStep = "database_backup" | "files_backup" | "credentials" | "channels" | "references" | "validation" | "replace" | "resolve" | "commit";
export interface PiMigrationOptions {
	/** Tests only. Production always performs the first-start migration. */
	automatic?: boolean;
	failAt?: (step: MigrationStep) => void;
	/** Test-only OAuth runtime; production uses Pi's file-backed public runtime. */
	oauthRuntime?: () => Promise<ModelRuntime>;
}
type State = { status?: "running" | "failed" | "done"; attempts?: number; version?: number; at?: number; backup?: string; error?: string; hashes?: PiJson; generatedHash?: string; generatedAt?: number; externalBackup?: string; unresolved?: string[]; oauthProviders?: string[]; oauthConfigs?: PiJson; rollbackState?: State; results?: { provider: string; status: string }[] };
const REF_KEYS = ["defaultModel", "smallTaskModel", "largeTaskModel", "modelOverrides", "auxModel", "visionModel", "memoryModel", "fallbackModels", "modelContextWindows"];

/** P1–P6: one app-owned migration, all model references and rows commit together. */
export class PiMigration implements CoreModule {
	private state: State;
	private busy = false;
	private regenerating: Promise<unknown> = Promise.resolve();
	private core: Core;
	private providers: Providers;
	private gateway: Gateway;
	private options: PiMigrationOptions;
	private logins = new Map<string, { controller: AbortController; provider: string; state: PiJson; answer?: (value: string) => void; pending: Promise<void> }>();
	constructor(core: Core, providers: Providers, gateway: Gateway, options: PiMigrationOptions = {}) {
		this.core = core; this.providers = providers; this.gateway = gateway; this.options = options;
		core.db.raw.exec(`CREATE TABLE IF NOT EXISTS pi_channel_migration(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS pi_channel_map(provider TEXT PRIMARY KEY, channel_id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, config TEXT NOT NULL, imported_at INTEGER NOT NULL);`);
		core.declareBackup({ id: "pi-channels", title: "Pi 渠道迁移状态与映射", tables: ["pi_channel_migration", "pi_channel_map"] });
		this.state = JSON.parse(core.db.get<{ value: string }>("SELECT value FROM pi_channel_migration WHERE id=1")?.value ?? "{}");
		providers.channelsAuthoritative = this.state.status === "done";
		for (const id of this.state.oauthProviders ?? []) providers.oauthProviders.add(id);
		core.restoreSessionModel = (ref, runtime, recordedAt) => {
			if (this.state.status !== "done") return undefined;
			gateway.installRuntime(runtime);
			// 0.8.1: model groups are retired; a conversation that chose one continues with its first model, or the default.
			const retired = gateway.retiredGroupTarget(ref);
			if (retired === null) return undefined;
			if (retired !== undefined) ref = retired;
			const mapped = this.resolveReference(ref, recordedAt), slash = mapped.indexOf("/");
			const model = runtime.getModel(mapped.slice(0, slash), mapped.slice(slash + 1));
			if (model) return model;
			this.save({ ...this.state, unresolved: [...new Set([...(this.state.unresolved ?? []), ref])] }); this.changed();
			throw new RpcError("model_unavailable", `旧会话所选模型 ${ref} 当前无法解析；原引用已保留，请在渠道中补全后重新打开会话。`);
		};
		gateway.configChanged = () => this.regenerate();
		core.register("piMigration.status", () => this.status());
		core.register("piMigration.retry", () => this.migrate(false));
		core.register("piMigration.import", (p) => this.migrate(false, requireStr(p.folder, "folder")));
		core.register("piMigration.generate", () => this.regenerate());
		core.register("piMigration.oauthStart", (p) => this.startOAuth(requireStr(p.provider, "provider")));
		core.register("piMigration.oauthStatus", (p) => this.logins.get(requireStr(p.id, "id"))?.state ?? { status: "missing" });
		core.register("piMigration.oauthAnswer", (p) => { const login = this.logins.get(requireStr(p.id, "id")); if (!login?.answer) throw new RpcError("not_ready", "登录步骤已变化，请刷新重试。"); const value = requireStr(p.value, "value"); rememberSecret(value); login.answer(value); return { ok: true }; });
		core.register("piMigration.oauthCancel", (p) => { this.logins.get(requireStr(p.id, "id"))?.controller.abort(); return { ok: true }; });
		core.register("piMigration.oauthLogout", async (p) => { if (this.busy) throw new RpcError("busy", "请在迁移完成后管理登录。"); const id = requireStr(p.provider, "provider"); const credential = readPiJson(join(core.agentDir, "auth.json"))[id]; if (credential?.type !== "oauth") { if (!credential && (canLoginChannelOAuth(id) || providers.oauthProviders.has(id))) return { ok: true }; throw new RpcError("bad_request", "此项没有已保存的 OAuth 登录。"); } const runtime = await this.authRuntime(); await runtime.logout(id); await gateway.refreshConfiguration(); return { ok: true }; });
	}
	private authRuntime() { return this.options.oauthRuntime?.() ?? ModelRuntime.create({ authPath: join(this.core.agentDir, "auth.json"), modelsPath: join(this.core.agentDir, "models.json"), refreshOnCreate: false }); }
	private async startOAuth(provider: string) {
		if (this.busy) throw new RpcError("busy", "请在迁移完成后管理登录。");
		if (!canLoginChannelOAuth(provider)) throw new RpcError("oauth_login_disabled", "渠道页只支持 ChatGPT 订阅登录；其他已有登录可以继续使用或退出。");
		if ([...this.logins.values()].some((l) => l.provider === provider && l.state.status === "running")) throw new RpcError("busy", "该服务商已有登录流程，请先完成或取消。");
		for (const [id, old] of this.logins) if (old.state.status !== "running") this.logins.delete(id);
		const id = randomUUID(), controller = new AbortController();
		const login: { controller: AbortController; provider: string; state: PiJson; answer?: (value: string) => void; pending: Promise<void> } = { controller, provider, state: { id, provider, status: "running" }, pending: Promise.resolve() };
		this.logins.set(id, login);
		const notify = (event: AuthEvent) => { login.state = { ...login.state, event }; this.core.broadcast({ event: "piMigration.oauth", login: login.state }); };
		const prompt = (question: AuthPrompt) => new Promise<string>((resolve, reject) => {
			const signal = AbortSignal.any([controller.signal, ...(question.signal ? [question.signal] : [])]);
			if (signal.aborted) { reject(new Error("登录已取消")); return; }
			const abort = () => { login.answer = undefined; reject(new Error("登录已取消")); };
			signal.addEventListener("abort", abort, { once: true });
			login.answer = (value) => { signal.removeEventListener("abort", abort); login.answer = undefined; delete login.state.prompt; resolve(value); };
			const { signal: _signal, ...visible } = question; login.state = { ...login.state, prompt: visible }; this.core.broadcast({ event: "piMigration.oauth", login: login.state });
		});
		login.pending = (async () => {
			try { const runtime = await this.authRuntime(); await runtime.login(provider, "oauth", { signal: controller.signal, notify, prompt }); login.state = { id, provider, status: "done" }; await this.gateway.refreshConfiguration(); }
			catch (error) { login.state = { id, provider, status: controller.signal.aborted ? "cancelled" : "failed", error: redact(error instanceof Error ? error.message : "登录失败", true) }; }
			this.core.broadcast({ event: "piMigration.oauth", login: login.state });
		})();
		return { id, provider, status: "running" };
	}
	private save(state: State): void { this.core.db.run("INSERT INTO pi_channel_migration VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", JSON.stringify(state)); this.state = state; }
	private changed(): void { this.core.broadcast({ event: "piMigration.changed", status: this.status() }); }
	status() {
		const path = join(this.core.agentDir, "models.json");
		return { ...this.state, status: this.state.status ?? "pending", path, folder: this.core.agentDir, busy: this.busy,
			oauthConfigs: undefined,
			rollbackState: undefined,
			externalModified: this.state.status === "done" && fileHash(path) !== this.state.generatedHash,
			defaultImportFolder: join(homedir(), ".pi", "agent"), command: `$env:PI_CODING_AGENT_DIR='${this.core.agentDir.replaceAll("'", "''")}'; pi`,
			mappings: this.core.db.all("SELECT provider,channel_id,source,imported_at FROM pi_channel_map ORDER BY imported_at,provider") };
	}
	async start(): Promise<void> {
		if (this.options.automatic === false) return;
		// A previous process may have died after replacing files but before committing.
		if (this.state.status === "running" && this.state.backup) {
			this.restoreFiles(this.state.backup);
			const previous = this.state.rollbackState ?? this.state;
			this.save({ ...previous, status: previous.status === "done" ? "done" : "failed", rollbackState: undefined, error: "上次迁移中断，已从备份恢复配置。" });
		}
		if (this.state.status === "done") { this.providers.channelsAuthoritative = true; for (const id of this.state.oauthProviders ?? []) this.providers.oauthProviders.add(id); await this.regenerate(); return; }
		if ((this.state.attempts ?? 0) < 2) await this.migrate(true);
	}
	/** The transaction rewrites settings once; runtime translation is only for dated historical entries. */
	resolveReference(ref: string, recordedAt?: number): string {
		const inTransaction = recordedAt === undefined && this.busy && this.state.status === "running";
		if (!inTransaction && (this.state.status !== "done" || !this.state.at || !Number.isFinite(recordedAt) || recordedAt! >= this.state.at)) return ref;
		const slash = ref.indexOf("/"); if (slash < 1) return ref;
		const id = ref.slice(0, slash), model = ref.slice(slash + 1);
		// A later manual import must not turn an existing mapping into a permanent alias again.
		const row = inTransaction
			? this.core.db.get<{ channel_id: string }>("SELECT channel_id FROM pi_channel_map WHERE provider=?", id)
			: this.core.db.get<{ channel_id: string }>("SELECT channel_id FROM pi_channel_map WHERE provider=? AND imported_at>?", id, recordedAt!);
		if (!row) return ref;
		const channel = this.gateway.channel(row.channel_id);
		return channel?.models.some((m) => m.id === model) ? `${channel.provider}/${model}` : ref;
	}
	private restoreFiles(backup: string): void {
		const present = readPiJson(join(backup, "presence.json"));
		for (const name of PI_FILES) {
			const target = join(this.core.agentDir, name);
			if (present[name]) { const temp = `${target}.restore.tmp`; copyFileSync(join(backup, name), temp); renameSync(temp, target); }
			else rmSync(target, { force: true });
		}
	}
	private checkpoint(step: MigrationStep): void { this.options.failAt?.(step); }
	private async credential(value: unknown, name: string, created: string[]): Promise<unknown> {
		if (typeof value !== "string" || !value || value.startsWith("!") || /\$(?:[A-Za-z_]|\{)/.test(value)) return value;
		rememberSecret(value); created.push(name); return this.providers.secrets.put(name, value);
	}
	private async secureConfig(config: PiJson, name: string, created: string[]): Promise<PiJson> {
		const out = structuredClone(config);
		if (out.apiKey) out.apiKey = await this.credential(out.apiKey, `${name}-key`, created);
		for (const [header, value] of Object.entries(out.headers ?? {})) {
			if (/authorization|api.?key|token|secret|cookie/i.test(header)) out.headers[header] = await this.credential(value, `${name}-header-${header}`, created);
		}
		if (Array.isArray(out.models)) out.models = await Promise.all(out.models.map((m: PiJson, i: number) => this.secureConfig(m, `${name}-${i}`, created)));
		if (out.modelOverrides) for (const [id, model] of Object.entries(out.modelOverrides)) out.modelOverrides[id] = await this.secureConfig(model as PiJson, `${name}-override-${id}`, created);
		return out;
	}
	async migrate(automatic = false, importFolder?: string): Promise<unknown> {
		if ([...this.logins.values()].some((login) => login.state.status === "running")) throw new RpcError("busy", "请先完成或取消 Pi 登录，再迁移配置。");
		if (this.busy || this.core.busySlots().length) throw new RpcError("busy", "请先停止正在运行的对话，再重试迁移或导入。");
		if (importFolder && this.state.status !== "done") throw new RpcError("not_ready", "请先完成本应用配置迁移，再导入其他文件夹。");
		if (!importFolder && this.state.status === "done") return this.status();
		const sourceDir = importFolder ? resolve(importFolder) : this.core.agentDir;
		if (importFolder && (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory() || !PI_FILES.slice(0, 2).some((name) => existsSync(join(sourceDir, name))))) throw new RpcError("bad_request", "请选择包含 models.json 或 auth.json 的 Pi 配置文件夹。");
		if (importFolder && resolve(sourceDir) === resolve(this.core.agentDir)) throw new RpcError("bad_request", "这是应用生成的兼容配置，请选择原始 Pi 配置文件夹。");
		this.busy = true; this.core.maintenance = "正在迁移 Pi 服务商";
		const before = structuredClone(this.state), created: string[] = [];
		const backup = join(this.core.paths.dataDir, "backups", `pi-migration-${Date.now()}-${randomUUID().slice(0, 8)}`);
		let transaction = false, committed = false, filesBackedUp = false;
		try {
			mkdirSync(backup, { recursive: true });
			await createBackup({ paths: this.core.paths, agentDir: this.core.agentDir, sessionsDir: this.core.sessionDir ?? join(this.core.agentDir, "sessions"), db: this.core.db.raw, appVersion: CORE_VERSION },
				{ out: join(backup, "before.dfbackup"), kind: "upgrade", credentials: "local", includeMaterials: false });
			this.checkpoint("database_backup");
			snapshotFiles(this.core.agentDir, backup);
			writeFileSync(join(backup, "presence.json"), JSON.stringify(Object.fromEntries(PI_FILES.map((f) => [f, existsSync(join(this.core.agentDir, f))]))));
			filesBackedUp = true; this.checkpoint("files_backup");
			const models = readPiJson(join(sourceDir, "models.json")), auth = readPiJson(join(sourceDir, "auth.json"));
			const runtime = await ModelRuntime.create({ modelsPath: join(sourceDir, "models.json"), authPath: join(sourceDir, "auth.json"), refreshOnCreate: false });
			if (runtime.getError()) throw new Error("Pi 源模型配置无效，请修正后重试；迁移尚未提交。");
			const oauthIds = importFolder ? before.oauthProviders ?? [] : [...new Set([...Object.keys(auth).filter((id) => auth[id]?.type === "oauth"), ...Object.keys(models.providers ?? {}).filter((id) => models.providers[id]?.oauth)])];
			const oauthConfigs: PiJson = importFolder ? before.oauthConfigs ?? {} : {};
			if (!importFolder) for (const id of oauthIds) if (models.providers?.[id]) oauthConfigs[id] = await this.secureConfig(models.providers[id], `pi-oauth-${randomUUID()}`, created);
			const next: State = { ...before, rollbackState: importFolder ? before : undefined, oauthProviders: oauthIds, oauthConfigs, status: "running", backup, attempts: (before.attempts ?? 0) + Number(automatic), error: undefined };
			this.save(next);
			const ids = new Set([...Object.keys(models.providers ?? {}), ...Object.keys(auth).filter((id) => auth[id]?.type === "api_key")]);
			const pending: { id: string; channel: string; config: PiJson; key?: string; models: PiJson[] }[] = [], results: { provider: string; status: string }[] = [];
			for (const id of ids) {
				if (auth[id]?.type === "oauth" || models.providers?.[id]?.oauth) { results.push({ provider: id, status: "OAuth 保留 Pi 登录，不迁移" }); continue; }
				if (id.startsWith("df-") || id === "dreamflutter") { results.push({ provider: id, status: "应用生成项，跳过" }); continue; }
				if (this.core.db.get("SELECT provider FROM pi_channel_map WHERE provider=?", id)) { results.push({ provider: id, status: "已有映射，跳过；不覆盖渠道" }); continue; }
				const channel = `p${randomUUID().replaceAll("-", "").slice(0, 12)}`;
				const config = await this.secureConfig(models.providers?.[id] ?? {}, `pi-${channel}`, created);
				const key = config.apiKey ?? await this.credential(auth[id]?.key, `gateway-${channel}`, created);
				const catalog = runtime.getModels(id).map((m) => ({ ...m }));
				const list = catalog.map((m) => ({ ...m, ...(config.models?.find((raw: PiJson) => raw.id === m.id) ?? {}), ...(config.modelOverrides?.[m.id] ?? {}) }));
				// Preserve unknown windows instead of adopting Pi's synthetic 128K default.
				for (const item of list) if (config.models?.some((m: PiJson) => m.id === item.id && !m.contextWindow) && !catalogModel(id, item.id)) delete item.contextWindow;
				const first = list[0];
				if (!first) throw new Error(`服务商 ${id} 没有可迁移模型；请在原 Pi 配置页补全后重试。`);
				pending.push({ id, channel, config: { ...config, api: config.api ?? first.api, baseUrl: config.baseUrl ?? first.baseUrl }, key, models: list });
				results.push({ provider: id, status: key ? "已迁入渠道" : "已迁入渠道；未配置密钥，请在渠道页补全" });
			}
			this.checkpoint("credentials");
			this.core.db.raw.exec("BEGIN IMMEDIATE"); transaction = true;
			for (const item of pending) {
				this.core.db.run(`INSERT INTO gateway_channels(id,name,kind,api,base_url,models,headers,auth_header,enabled,created_at) VALUES(?,?,'payg',?,?,?,?,?,1,?)`,
					item.channel, item.config.name ?? item.id, item.config.api, item.config.baseUrl ?? "", JSON.stringify(item.models), JSON.stringify(item.config.headers ?? {}), item.config.authHeader ? 1 : 0, Date.now());
				if (item.key) this.core.db.run("INSERT INTO gateway_keys(id,channel_id,label,secret,enabled,created_at) VALUES(?,?,?,?,1,?)", item.channel, item.channel, "迁自 Pi", item.key, Date.now());
				this.core.db.run("INSERT INTO pi_channel_map VALUES(?,?,?,?,?)", item.id, item.channel, item.id.startsWith("cc-switch-") ? "cc-switch" : "pi", JSON.stringify(item.config), Date.now());
			}
			this.checkpoint("channels");
			const unresolved = new Set<string>();
			const map = (key: string): string => { const mapped = this.resolveReference(key); const slash = key.indexOf("/"); if (mapped === key && slash > 0 && !runtime.getModel(key.slice(0, slash), key.slice(slash + 1)) && !this.gateway.channels().some((c) => c.provider === key.slice(0, slash) && c.models.some((m) => m.id === key.slice(slash + 1)))) unresolved.add(key); return mapped; };
			for (const key of REF_KEYS) {
				const row = this.core.db.get<{ value: string }>("SELECT value FROM settings WHERE key=?", key); if (!row) continue;
				const value = JSON.parse(row.value);
				const mapped = key === "modelOverrides" && value && typeof value === "object"
					? Object.fromEntries(Object.entries(value).map(([purpose, ref]) => [purpose, typeof ref === "string" && ref.includes("/") ? map(ref) : ref]))
					: typeof value === "string" ? map(value) : Array.isArray(value) ? value.map(map) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([ref, n]) => [map(ref), n])) : value;
				this.core.db.run("UPDATE settings SET value=? WHERE key=?", JSON.stringify(mapped), key);
			}
			for (const group of this.core.db.all<{ id: string; entries: string }>("SELECT id,entries FROM gateway_groups")) {
				const entries = JSON.parse(group.entries).map((entry: PiJson) => { if (!entry.channel?.startsWith("pi:")) return entry; const old = `${entry.channel.slice(3)}/${entry.model}`, mapped = map(old); return mapped === old ? entry : { ...entry, channel: mapped.slice(3, mapped.indexOf("/")) }; });
				this.core.db.run("UPDATE gateway_groups SET entries=? WHERE id=?", JSON.stringify(entries), group.id);
			}
			const settings = readPiJson(join(this.core.agentDir, "settings.json"));
			if (settings.defaultProvider && settings.defaultModel) { const old = `${settings.defaultProvider}/${settings.defaultModel}`, mapped = map(old); if (old !== mapped) { settings.defaultProvider = mapped.slice(0, mapped.indexOf("/")); settings.defaultModel = mapped.slice(mapped.indexOf("/") + 1); } }
			this.checkpoint("references");
			this.checkpoint("validation");
			const generated = await writeGenerated(this.core, this.gateway, importFolder ? readPiJson(join(this.core.agentDir, "models.json")) : models);
			this.checkpoint("replace");
			const keepAuth = readPiJson(join(this.core.agentDir, "auth.json"));
			for (const item of pending) delete keepAuth[item.id];
			const atomic = (file: string, data: PiJson) => { const temp = join(this.core.agentDir, `${file}.t66.tmp`); writeFileSync(temp, JSON.stringify(data, null, 2) + "\n"); renameSync(temp, join(this.core.agentDir, file)); };
			atomic("auth.json", keepAuth); atomic("settings.json", settings);
			const verified = await validatePiConfig(this.core, join(this.core.agentDir, "models.json"));
			for (const item of pending) for (const model of item.models) if (!verified.getModel(`df-${item.channel}`, model.id)) throw new Error("生成配置中的模型无法解析，迁移已回滚。");
			this.checkpoint("resolve");
			this.save({ ...next, rollbackState: undefined, generatedHash: generated.hash, generatedAt: generated.at, status: "done", version: 1, at: Date.now(), hashes: Object.fromEntries(PI_FILES.map((f) => [f, fileHash(join(importFolder ? sourceDir : backup, f))])), results, unresolved: [...unresolved], externalBackup: importFolder && fileHash(join(backup, "models.json")) !== before.generatedHash ? join(backup, "models.json") : before.externalBackup });
			this.checkpoint("commit"); this.core.db.raw.exec("COMMIT"); transaction = false; committed = true;
			this.providers.channelsAuthoritative = true; for (const id of this.state.oauthProviders ?? []) this.providers.oauthProviders.add(id); this.core.settings.reloadFromDb();
			await this.gateway.refreshConfiguration(); this.changed(); return this.status();
		} catch (cause) {
			if (committed) { this.save({ ...this.state, error: "迁移已提交，但内存配置刷新失败；请重启应用。" }); this.changed(); return this.status(); }
			if (transaction) this.core.db.raw.exec("ROLLBACK");
			if (filesBackedUp) this.restoreFiles(backup);
			for (const name of created) this.providers.secrets.remove(name);
			this.save({ ...before, status: importFolder ? "done" : "failed", attempts: (before.attempts ?? 0) + Number(automatic), backup, error: `迁移失败：${redact(cause instanceof Error ? cause.message : "未知错误", true)}；备份：${backup}` });
			this.providers.channelsAuthoritative = this.state.status === "done"; this.changed(); return this.status();
		} finally { this.busy = false; this.core.maintenance = undefined; this.changed(); }
	}
	regenerate(): Promise<unknown> {
		const action = async () => {
			if (this.state.status !== "done" || this.busy) return this.status();
			try {
				const path = join(this.core.agentDir, "models.json");
				let externalBackup = this.state.externalBackup;
				if (fileHash(path) !== this.state.generatedHash && existsSync(path)) {
					externalBackup = join(this.core.paths.dataDir, "backups", `pi-external-${Date.now()}-${randomUUID().slice(0, 6)}.json`);
					mkdirSync(join(this.core.paths.dataDir, "backups"), { recursive: true }); copyFileSync(path, externalBackup);
				}
				// A malformed externally edited file must still be backed up and replaced from channels.
				let source: PiJson; try { source = readPiJson(path); } catch { source = {}; }
				const generated = await writeGenerated(this.core, this.gateway, source);
				this.save({ ...this.state, generatedHash: generated.hash, generatedAt: generated.at, externalBackup, error: undefined }); this.changed(); return this.status();
			} catch { this.save({ ...this.state, error: "Pi 兼容配置生成失败；已保留现有文件，请检查权限后重试生成。" }); this.changed(); return this.status(); }
		};
		const pending = this.regenerating.then(action); this.regenerating = pending.catch(() => {}); return pending;
	}
	async stop(): Promise<void> { for (const login of this.logins.values()) login.controller.abort(); await Promise.allSettled([this.regenerating, ...[...this.logins.values()].map((l) => l.pending)]); }
}
