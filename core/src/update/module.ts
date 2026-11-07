import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, dirname, sep, parse as parsePath } from "node:path";
import { spawn } from "node:child_process";
import { CORE_VERSION, RpcError, type Core, type CoreModule } from "../core.ts";
import { autoPath, pruneAuto } from "../backup/backup.ts";
import { createBackup, estimateSize, freeSpace } from "../backup/export.ts";
import { inspectBackup } from "../backup/restore.ts";
import { Archive } from "../backup/archive.ts";
import { MemoryModule } from "../modules/memory.ts";
import { APP_ROOT } from "../paths.ts";
import { bridgeCall, launchGuardian, makeFeed, prepareGuardian } from "./bridge.ts";
import { buildInfo, installation, piVersion, type BuildInfo } from "./installation.ts";
import { compareVersions, LATEST_RELEASE, limitedText, localSource, parseRelease, request, UpdateError, type Release } from "./release.ts";
import { downloadPackage, recheckPackage, type PackageSignature } from "./download.ts";
import { JournalStore, pendingValidation } from "./state.ts";
import { recoverUpdateStartup } from "./startup.ts";
import { exportDiagnostics, licenseManifest, licenseText } from "./diagnostics.ts";

export interface UpdateOptions {
  testSource?: string; appRoot?: string; fetch?: typeof fetch; testThumbprints?: string[]; now?: () => number;
  install?: ReturnType<typeof installation>; build?: BuildInfo;
  nativeCall?: typeof bridgeCall; prepareGuard?: typeof prepareGuardian; launchGuard?: typeof launchGuardian;
  backup?: typeof createBackup;
}
const READ_ONLY = /(?:\.(?:status|info|list|get|overview|history|summary|items|item|log|blocks|pending|unsaved|settings|locations|quota|usage|search|windows|stats|sources|audit|snapshot|snapshotExplain|check|turns|children|checkpoints))$/;
const SAFE = new Set(["core.hello", "core.notify", "updates.uiReady", "updates.validateReady", "updates.cancel", "updates.status", "updates.licenses", "updates.licenseText", "app.exitState"]);
export class UpdateModule implements CoreModule {
  readonly modelFacing = false;
  private readonly core: Core;
  private readonly options: UpdateOptions;
  private readonly appRoot: string;
  private readonly source: string;
  private readonly store: JournalStore;
  private readonly clock: () => number;
  private readonly installed: ReturnType<typeof installation>;
  private readonly build: BuildInfo;
  private readonly native: typeof bridgeCall;
  private available?: Release;
  private downloaded?: { release: Release; path: string; signature: PackageSignature };
  private state = "idle";
  private message = "尚未检查更新";
  private checkedAt = 0;
  private progress = 0;
  private timer?: NodeJS.Timeout;
  private initialTimer?: NodeJS.Timeout;
  private checkController?: AbortController;
  private stopping = false;
  private controller?: AbortController;
  private preparation?: Promise<void>;
  private freezing = false;
  private hasJournal: boolean;
  private checking?: Promise<unknown>;
  private installWindowPid = 0;
  private readyUiPid = 0;
  private cachedRelease?: unknown;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(core: Core, options: UpdateOptions = {}) {
    this.core = core; this.options = options; this.appRoot = options.appRoot ?? APP_ROOT;
    const test = localSource(options.testSource); this.source = test ? `${test}/repos/jun64349/DreamFlutter/releases/latest` : LATEST_RELEASE;
    this.store = new JournalStore(core.paths.dataDir); this.clock = options.now ?? Date.now;
    this.installed = options.install ?? installation(this.appRoot); this.build = options.build ?? buildInfo(this.appRoot); this.native = options.nativeCall ?? bridgeCall;
    this.hasJournal = existsSync(this.store.file);
    core.beforeRpc = (method) => {
      const journal = this.hasJournal ? this.store.read() : undefined;
      if ((this.freezing || pendingValidation(journal)) && !SAFE.has(method) && !READ_ONLY.test(method)) throw new RpcError("update_validation", "正在验证版本更新，暂不接受写入。");
      if (journal?.phase === "verified" && !SAFE.has(method) && !READ_ONLY.test(method)) this.store.accepted();
    };
    core.beforeOpenSlot = () => { if (this.preparation || pendingValidation(this.hasJournal ? this.store.read() : undefined)) throw new RpcError("busy", "正在准备或验证版本更新，暂不启动新任务。"); };
    core.beforeModuleStart = () => { if (pendingValidation(this.hasJournal ? this.store.read() : undefined)) core.maintenance = "正在验证版本更新"; };
    if (pendingValidation(this.hasJournal ? this.store.read() : undefined)) core.maintenance = "正在验证版本更新";
    try {
      const cache = JSON.parse(readFileSync(this.cacheFile, "utf8")); this.checkedAt = Number(cache.checkedAt) || 0;
      if (typeof cache.message === "string") this.message = cache.message; if (typeof cache.state === "string") this.state = cache.state;
      if (cache.source === this.source) this.cachedRelease = cache.release;
    } catch { /* No previous check in a new installation. */ }
    core.register("updates.status", () => this.status());
    core.register("updates.check", () => this.check(true));
    core.register("updates.download", () => this.download());
    core.register("updates.install", (p) => {
      if (core.maintenance && !this.preparation) throw new UpdateError("busy", "后台正在维护数据，请完成后再安装更新。");
      if (!this.downloaded || !this.installed) throw new UpdateError("not_downloaded", "请先下载并校验可安装的更新包。");
      if (this.preparation) throw new UpdateError("busy", "已在准备更新。");
      if (!Number.isSafeInteger(p.windowPid) || (p.windowPid as number) < 0 || p.windowPid === process.pid) throw new UpdateError("invalid_window", "无法确认窗口进程，未开始安装。");
      if (this.downloaded.signature.state !== "trusted-test" && p.approveUnsigned !== true) throw new UpdateError("confirmation_required", "测试版包没有受信任签名，需要你明确确认后才能安装。");
      this.controller = new AbortController();
      this.installWindowPid = p.windowPid as number;
      this.preparation = this.prepare(p.windowPid as number, p.prefs as Record<string, unknown> | undefined).catch((error) => this.failedPreparation(error)).finally(() => { this.preparation = undefined; });
      return this.status();
    });
    core.register("updates.cancel", () => { const phase = this.hasJournal ? this.store.read()?.phase : undefined; if (phase && ["prepared", "applying", "validating", "rollback-needed"].includes(phase)) throw new UpdateError("busy", "程序已准备退出，请等待更新结果。"); this.controller?.abort(); this.checkController?.abort(); return this.status(); });
    core.register("updates.validateReady", (p) => { try { return this.validateReady(String(p.nonce ?? "")); } catch (error) { if (error instanceof UpdateError) throw new RpcError(error.code, error.message); throw error; } });
    core.register("updates.uiReady", async (p) => {
      const journal = this.store.read();
      if (!journal || journal.nonce !== p.nonce || p.version !== this.build.version || p.version !== journal.to || journal.phase !== "validating" || !this.installed || !Number.isSafeInteger(p.pid) || p.pid === process.pid) throw new UpdateError("validation_failed", "窗口版本验证失败。");
      const windows = (await this.native(this.installed.helper, ["windows", this.installed.root])).split(/\s+/).map(Number);
      if (!windows.includes(p.pid as number)) throw new UpdateError("validation_failed", "窗口进程验证失败。");
      this.readyUiPid = p.pid as number; return { ready: true };
    });
    core.register("updates.diagnostics", () => exportDiagnostics(core, this.appRoot));
    core.register("updates.licenses", () => licenseManifest(this.appRoot));
    core.register("updates.licenseText", (p) => licenseText(this.appRoot, String(p.id ?? "")));
    core.register("app.exitState", () => ({ busy: core.busySlots().length > 0 || !!core.module(MemoryModule)?.work.busy, conversations: core.busySlots().length }));
    core.register("app.setStartup", async (p) => {
      if (!this.installed) throw new UpdateError("not_packaged", "开发运行尚未生成启动器，打包后可设置开机启动。");
      const enabled = p.enabled === true;
      try { await this.native(this.installed.helper, ["startup", this.installed.root, enabled ? "enable" : "disable"]); }
      catch { throw new UpdateError("startup_failed", "无法修改当前用户的开机启动项；若已有其他安装版本，请先关闭其开机启动。"); }
      core.settings.update({ startOnLogin: enabled }); return this.status();
    });
  }
  private get cacheFile(): string { return join(this.core.paths.dataDir, "updates", "check-cache.json"); }
  private transport() { return { testSource: this.options.testSource, fetch: this.options.fetch, signal: this.controller?.signal }; }
  private changed(state: string, message: string): void { this.state = state; this.message = message; this.core.broadcast({ event: "updates.changed", status: this.status() }); }
  status(): Record<string, unknown> {
    const journal = this.hasJournal ? this.store.read() : undefined;
    return { state: this.state, message: this.message, checkedAt: this.checkedAt || null, progress: this.progress, available: this.available ? { version: this.available.version, notes: this.available.notes, page: this.available.page, size: this.available.asset.size, sha256: this.available.asset.sha256 } : null,
      downloaded: !!this.downloaded, signature: this.downloaded?.signature ?? null, application: this.build, coreVersion: CORE_VERSION, piVersion: piVersion(this.appRoot), nodeVersion: process.version, platform: process.platform, arch: process.arch,
      canInstall: !!this.installed && !!this.downloaded, canStartup: !!this.installed, autoCheckUpdates: this.core.settings.get().autoCheckUpdates, startOnLogin: this.core.settings.get().startOnLogin, closeBehavior: this.core.settings.get().closeBehavior,
      recovery: journal ? { phase: journal.phase, from: journal.from, to: journal.to, backup: journal.backup, error: journal.error ?? null, acceptedWrites: journal.acceptedWrites } : null };
  }
  async start(): Promise<void> {
    if (this.cachedRelease) { try { const cached = await parseRelease(this.cachedRelease, { platform: process.platform, arch: process.arch, testSource: this.options.testSource }); if (compareVersions(cached.version, this.build.version) > 0) this.available = cached; else { this.state = "current"; this.message = "已是最新版本。"; } } catch { this.checkedAt = 0; this.state = "idle"; this.message = "请重新检查更新。"; } }
    const journal = this.hasJournal ? this.store.read() : undefined;
    if (journal?.phase === "rolled-back") { this.core.settings.update({ memoryPaused: journal.memoryWasPaused }); this.message = "已恢复旧版本和更新前备份。"; }
    if (pendingValidation(journal)) this.core.maintenance = "正在验证版本更新";
    if (journal && !journal.cleaned) { this.cleanupTimer = setInterval(() => void this.maintainJournal(), 5000); this.cleanupTimer.unref(); }
    if (this.installed) { this.timer = setInterval(() => { if (this.core.settings.get().autoCheckUpdates && !this.preparation && this.state !== "downloading") void this.check(false); }, 60 * 60 * 1000); this.timer.unref(); this.initialTimer = setTimeout(() => { if (this.core.settings.get().autoCheckUpdates) void this.check(false); }, 2000); this.initialTimer.unref(); }
  }
  async stop(): Promise<void> { this.stopping = true; if (this.timer) clearInterval(this.timer); if (this.initialTimer) clearTimeout(this.initialTimer); if (this.cleanupTimer) clearInterval(this.cleanupTimer); this.controller?.abort(); this.checkController?.abort(); await Promise.allSettled([this.preparation, this.checking]); }
  private async maintainJournal(): Promise<void> {
    try {
      const journal = this.store.read();
      if (pendingValidation(journal) && journal!.to === this.build.version && journal!.phase !== "rollback-needed") {
        try { if (journal!.guardPid) { process.kill(journal!.guardPid, 0); return; } } catch {}
        await recoverUpdateStartup(this.core.paths); return;
      }
      await this.cleanupCompleted();
    } catch { /* Keep the write gate and retained recovery files if a guardian cannot restart. */ }
  }
  private async cleanupCompleted(): Promise<void> {
    const journal = this.store.read();
    if (!journal || journal.cleaned || this.preparation || !["verified", "accepted", "rolled-back"].includes(journal.phase)) return;
    try { if (journal.guardPid) { try { process.kill(journal.guardPid, 0); return; } catch {} }
      const expected = resolve(this.core.paths.dataDir, "updates", "runs", journal.id);
      if (resolve(journal.guardDir).toLowerCase() !== expected.toLowerCase() || !expected.toLowerCase().startsWith((resolve(this.core.paths.dataDir, "updates", "runs") + sep).toLowerCase())) return;
      if (existsSync(expected)) {
        if (realpathSync(expected).toLowerCase() !== expected.toLowerCase()) return;
        const log = join(expected, "guardian.log"), history = join(this.core.paths.dataDir, "updates", "history"); await mkdir(history, { recursive: true });
        if (existsSync(log)) await cp(log, join(history, `${journal.id}.log`));
        await rm(expected, { recursive: true, force: true });
      }
      const download = dirname(resolve(journal.targetPackage)), downloads = resolve(this.core.paths.dataDir, "updates", "downloads") + sep;
      if (download.toLowerCase().startsWith(downloads.toLowerCase()) && existsSync(download) && realpathSync(download).toLowerCase() === download.toLowerCase()) await rm(download, { recursive: true, force: true });
      this.store.mutate(current => { if (!current) throw Error("Missing stage"); return current.id === journal.id ? { ...current, cleaned: true } : current; }); if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    } catch { /* Retry after the guardian and native updater have released their files. */ }
  }
  private async releaseAt(url: string, signal?: AbortSignal): Promise<Release> {
    const options = { ...this.transport(), signal: signal ?? this.transport().signal }; const raw = JSON.parse(await limitedText(await request(url, options)));
    return parseRelease(raw, { platform: process.platform, arch: process.arch, testSource: this.options.testSource, checksum: async (url) => limitedText(await request(url, options), 64 * 1024) });
  }
  check(manual = true): Promise<unknown> {
    if (["downloading", "preparing", "installing"].includes(this.state)) return Promise.resolve(this.status());
    if (!manual && this.state === "downloaded") return Promise.resolve(this.status());
    if (this.checking) return this.checking;
    if (!manual && this.checkedAt && this.clock() - this.checkedAt < 24 * 60 * 60 * 1000) return Promise.resolve(this.status());
    this.checking = this.performCheck().finally(() => { this.checking = undefined; }); return this.checking;
  }
  private async performCheck(): Promise<unknown> {
    this.checkController = new AbortController();
    this.changed("checking", "正在检查更新…"); this.available = undefined; this.downloaded = undefined; this.checkedAt = this.clock();
    try {
      const release = await this.releaseAt(this.source, this.checkController.signal);
      if (compareVersions(release.version, this.build.version) <= 0) this.changed("current", "已是最新版本。");
      else {
        if (!release.notes) { try { release.notes = readFileSync(join(this.appRoot, "docs", "releases", `v${release.version}.md`), "utf8").slice(0, 100_000); } catch { release.notes = "此版本未提供更新日志。"; } }
        this.available = release; this.changed("available", `发现新版本 ${release.version}`);
      }
    } catch (error) { this.changed(error instanceof UpdateError ? error.code : "invalid_release", error instanceof UpdateError ? error.message : "更新服务返回的发布信息无法读取。"); }
    if (!this.stopping) { mkdirSync(dirname(this.cacheFile), { recursive: true }); const release = this.available; writeFileSync(this.cacheFile, JSON.stringify({ checkedAt: this.checkedAt, state: this.state, message: this.message, source: this.source, release: release ? { tag_name: release.version, body: release.notes, html_url: release.page, assets: [{ name: release.asset.name, size: release.asset.size, browser_download_url: release.asset.url, digest: `sha256:${release.asset.sha256}` }, ...(release.asset.signatureUrl ? [{ name: `${release.asset.name}.signature.json`, browser_download_url: release.asset.signatureUrl }] : [])] } : undefined })); } return this.status();
  }
  async download(): Promise<unknown> {
    if (!this.available) throw new UpdateError("no_update", "请先检查更新。");
    if (this.controller && !this.controller.signal.aborted && ["downloading", "preparing"].includes(this.state)) throw new UpdateError("busy", "已有更新步骤正在进行。");
    const release = this.available, directory = join(this.core.paths.dataDir, "updates", "downloads", randomUUID()), path = join(directory, release.asset.name);
    const space = freeSpace(this.core.paths.dataDir);
    if (space === undefined) throw new UpdateError("space_unknown", "无法确认可用磁盘空间，未开始下载。");
    if (space < release.asset.size * 2 + 64 * 1024 ** 2) throw new UpdateError("no_space", "可用空间不足，未开始下载。");
    this.controller = new AbortController(); this.progress = 0; this.changed("downloading", "正在下载并校验更新包…");
    const timeout = setTimeout(() => this.controller?.abort(), 10 * 60 * 1000);
    try {
      let last = 0;
      const signature = await downloadPackage(release.asset, path, { ...this.transport(), testThumbprints: this.options.testThumbprints, onProgress: (bytes) => { this.progress = bytes / release.asset.size; if (Date.now() - last > 300) { last = Date.now(); this.changed("downloading", "正在下载并校验更新包…"); } } });
      this.downloaded = { release, path, signature }; this.changed("downloaded", signature.state === "trusted-test" ? "更新包已通过测试签名校验；可安装并重启。" : "更新包校验通过；测试版未获受信任签名，安装前需要你确认。");
    } catch (error) { this.changed(error instanceof UpdateError ? error.code : "cancelled", error instanceof UpdateError ? error.message : "下载已取消。"); }
    finally { clearTimeout(timeout); }
    return this.status();
  }
  private async waitUntil(condition: () => boolean): Promise<void> { while (!condition()) { this.controller?.signal.throwIfAborted(); await new Promise((done) => setTimeout(done, 100)); } }
  private async prepare(windowPid: number, prefs?: Record<string, unknown>): Promise<void> {
    const installed = this.installed!, downloaded = this.downloaded!, core = this.core, memory = core.module(MemoryModule), previousPaused = core.settings.get().memoryPaused;
    this.changed("preparing", "正在等待对话和记忆任务结束；新任务暂不启动。" ); core.maintenance = "正在准备版本更新"; core.settings.update({ memoryPaused: true });
    try {
      const pids = (await this.native(installed.helper, ["processes", installed.root])).split(/\s+/).filter(Boolean).map(Number);
      if (pids.some((id) => id !== process.pid && id !== windowPid)) throw new UpdateError("other_instance", "同一安装目录还有其它窗口或后台，请先退出它们再更新。");
      await this.waitUntil(() => !core.busySlots().length);
      if (memory) await new Promise<void>((done, reject) => {
        const signal = this.controller!.signal, abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        memory.work.waitForIdle().then(done, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      }); this.controller?.signal.throwIfAborted(); this.freezing = true;
      this.changed("preparing", "任务已结束，正在保留回滚包并检查备份空间。" );
      await recheckPackage(downloaded.path, downloaded.release.asset);
      const id = randomUUID(), guardDir = join(core.paths.dataDir, "updates", "runs", id);
      const oldUrl = this.options.testSource ? `${localSource(this.options.testSource)}/repos/jun64349/DreamFlutter/releases/tags/v${this.build.version}` : `https://api.github.com/repos/jun64349/DreamFlutter/releases/tags/v${this.build.version}`;
      const old = await this.releaseAt(oldUrl); if (old.version !== this.build.version) throw new UpdateError("rollback_package", "当前版本的回滚包不匹配，未开始安装。");
      const sessionFiles = core.db.all<{ path: string }>("SELECT path FROM session_meta").map((row) => row.path);
      const estimate = estimateSize({ paths: core.paths, agentDir: core.agentDir, sessionsDir: core.sessionDir ?? join(core.agentDir, "sessions"), appVersion: CORE_VERSION }, sessionFiles, []);
      const space = freeSpace(core.paths.dataDir), programSpace = freeSpace(installed.root);
      if (space === undefined || programSpace === undefined) throw new UpdateError("space_unknown", "无法确认更新和备份位置的磁盘空间，未开始安装。");
      if (space < old.asset.size * 2 + downloaded.release.asset.size * 2 + estimate.data * 2 + estimate.sessions + 256 * 1024 ** 2 || programSpace < downloaded.release.asset.size * 4 + 256 * 1024 ** 2) throw new UpdateError("no_space", "可用空间不足以同时保留回滚包和数据备份，未开始安装。");
      const oldPath = join(guardDir, "old", old.asset.name); await downloadPackage(old.asset, oldPath, { ...this.transport(), testThumbprints: this.options.testThumbprints });
      const expanded = async (path: string) => { const zip = await Archive.open(path); try { return [...zip.entries.values()].reduce((sum, entry) => sum + entry.size, 0); } finally { zip.close(); } };
      const [newBytes, oldBytes] = await Promise.all([expanded(downloaded.path), expanded(oldPath)]);
      const dataNeed = old.asset.size * 3 + downloaded.release.asset.size * 2 + estimate.data * 2 + estimate.sessions + 256 * 1024 ** 2, programNeed = newBytes * 2 + oldBytes + 64 * 1024 ** 2;
      const sameVolume = parsePath(resolve(core.paths.dataDir)).root.toLowerCase() === parsePath(resolve(installed.root)).root.toLowerCase();
      const currentDataSpace = freeSpace(core.paths.dataDir), currentProgramSpace = freeSpace(installed.root);
      if (currentDataSpace === undefined || currentProgramSpace === undefined) throw new UpdateError("space_unknown", "无法确认解压后的更新所需空间，未开始安装。");
      if (currentDataSpace < dataNeed + (sameVolume ? programNeed : 0) || currentProgramSpace < programNeed) throw new UpdateError("no_space", "解压后的更新与回滚内容所需空间不足，未开始安装。");
      this.freezing = true; this.changed("preparing", "任务已结束，正在关闭窗口后备份数据。" ); core.broadcast({ event: "updates.closeWindow" });
      if (windowPid) { const limit = Date.now() + 60_000; await this.waitUntil(() => { try { process.kill(windowPid, 0); if (Date.now() > limit) throw new UpdateError("window_busy", "窗口未正常退出，未开始安装。"); return false; } catch (error) { if (error instanceof UpdateError) throw error; return true; } }); }
      this.controller?.signal.throwIfAborted();
      const backup = await (this.options.backup ?? createBackup)({ paths: core.paths, agentDir: core.agentDir, sessionsDir: core.sessionDir ?? join(core.agentDir, "sessions"), db: core.db.raw, appVersion: CORE_VERSION }, { out: autoPath(core.paths, "upgrade"), kind: "upgrade", credentials: "local", includeMaterials: false, prefs, signal: this.controller?.signal });
      const verified = await inspectBackup(backup.path, { paths: core.paths, agentDir: core.agentDir, sessionsDir: core.sessionDir ?? join(core.agentDir, "sessions"), appVersion: CORE_VERSION }); verified.archive.close();
      const newFeed = join(guardDir, "new-feed"), oldFeed = join(guardDir, "old-feed"), sdkCache = join(guardDir, "sdk-cache");
      await makeFeed(newFeed, downloaded.path, downloaded.release.asset, downloaded.release.version); await makeFeed(oldFeed, oldPath, old.asset, old.version); await mkdir(sdkCache, { recursive: true });
      const guard = await (this.options.prepareGuard ?? prepareGuardian)(this.appRoot, guardDir), nonce = randomUUID();
      const journal = this.store.mutate(() => ({ id, phase: "prepared", at: this.clock(), from: this.build.version, to: downloaded.release.version, installRoot: installed.root, appRoot: this.appRoot, dataRoot: core.paths.dataDir,
        agentDir: core.agentDir, sessionsDir: core.sessionDir ?? join(core.agentDir, "sessions"), databaseFile: core.paths.dbFile, backup: backup.path, targetPackage: downloaded.path, oldPackage: oldPath, asset: downloaded.release.asset,
        guardDir, windowPid, corePid: process.pid, nonce, acceptedWrites: false, attemptedRollback: false, memoryWasPaused: previousPaused })); this.hasJournal = true;
      const config = join(guardDir, "guard-config.json");
      await writeFile(config, JSON.stringify({ ...journal, journalFile: this.store.file, infoFile: core.paths.infoFile, helper: guard.helper, oldFeed, newFeed, sdkCache }), { mode: 0o600 });
      const guardPid = (this.options.launchGuard ?? launchGuardian)(guard.node, guard.script, config); this.store.patch({ guardPid });
      this.changed("installing", "备份已验证，正在通过 Velopack 更新并重启。" );
      setTimeout(() => void core.shutdown(), 50).unref();
    } catch (error) { core.settings.update({ memoryPaused: previousPaused }); throw error; }
  }
  private async failedPreparation(error: unknown): Promise<void> {
    const journal = this.hasJournal ? this.store.read() : undefined;
    if (journal?.phase === "prepared") this.store.patch({ phase: "cancelled", error: "更新未开始，备份已保留。" });
    this.freezing = false; this.core.maintenance = undefined;
    this.changed(this.controller?.signal.aborted ? "cancelled" : error instanceof UpdateError ? error.code : "prepare_failed", this.controller?.signal.aborted ? "更新准备已取消，程序未替换。" : error instanceof UpdateError ? error.message : "更新准备失败，程序未替换；数据和备份已保留。" );
    let windowAlive = false; try { if (this.installWindowPid) { process.kill(this.installWindowPid, 0); windowAlive = true; } } catch {}
    if (!this.stopping && this.installed && this.installWindowPid && !windowAlive) { const child = spawn(join(this.installed.root, "DreamFlutter.exe"), [], { detached: true, windowsHide: false, stdio: "ignore", env: { ...process.env, DREAMFLUTTER_DATA: this.core.paths.dataDir } }); child.on("error", () => {}); child.unref(); }
  }
  private validateReady(nonce: string): unknown {
    const journal = this.store.read();
    if (!this.readyUiPid) throw new UpdateError("waiting_window", "正在等待窗口完成首帧验证。");
    if (!journal || journal.nonce !== nonce || journal.to !== this.build.version || !this.installed || resolve(journal.appRoot).toLowerCase() !== resolve(this.appRoot).toLowerCase() || realpathSync(journal.dataRoot).toLowerCase() !== realpathSync(this.core.paths.dataDir).toLowerCase()) throw new UpdateError("validation_failed", "版本或数据位置验证失败。");
    if (resolve(journal.databaseFile).toLowerCase() !== resolve(this.core.paths.dbFile).toLowerCase() || resolve(journal.agentDir).toLowerCase() !== resolve(this.core.agentDir).toLowerCase() || resolve(journal.sessionsDir).toLowerCase() !== resolve(this.core.sessionDir ?? join(this.core.agentDir, "sessions")).toLowerCase()) throw new UpdateError("validation_failed", "数据库、配置或会话位置与更新前不一致。");
    const integrity = this.core.db.raw.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== "ok" || this.core.db.raw.prepare("PRAGMA foreign_key_check").all().length) throw new UpdateError("validation_failed", "数据库验证失败。");
    this.store.mutate((current) => { if (!current || !["applying", "validating"].includes(current.phase) || current.acceptedWrites || current.attemptedRollback) throw new UpdateError("validation_failed", "更新验证阶段已结束。"); return { ...current, phase: "verified", at: this.clock() }; });
    this.core.settings.update({ memoryPaused: journal.memoryWasPaused }); this.core.maintenance = undefined; pruneAuto(this.core.paths, "upgrade");
    this.changed("verified", "更新完成，版本和数据验证通过。" ); return { verified: true, version: this.build.version };
  }
}
