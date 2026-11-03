import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { Db } from "../db.ts";
import type { CorePaths } from "../paths.ts";
import { MIGRATIONS } from "../schema.ts";
import { dpapiMany, isSecretReference, relocateSecretRef, secretFileOf } from "../modules/secrets.ts";
import { Archive, ArchiveError, under } from "./archive.ts";
import { open as openSealed, type SealedBox } from "./crypto.ts";
import { FORMAT, FORMAT_VERSION, MIN_DB_VERSION, PI_FILES, tableCounts, type Manifest } from "./export.ts";
import { remapColumns, type BackupPart } from "./parts.ts";
import { PathMap, piSessionFolder, type PathRule } from "./path-map.ts";

/**
 * Restoring a package, up to the point where it can replace the live data
 * (docs/v0.3.1-backup-design.md §五–六): check it, show what it holds, then
 * extract it to restore-staging/, upgrade its database with the app's own
 * migrations, move every path to this machine and seal the keys with this
 * Windows user's DPAPI. The switch itself happens at the next start (switch.ts).
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface RestoreTarget {
	paths: CorePaths;
	agentDir: string;
	sessionsDir: string;
	appVersion: string;
	/** Oldest database accepted (default MIN_DB_VERSION; moving this machine's own older data takes any). */
	minDbVersion?: number;
}

export interface PathSuggestion {
	from: string;
	to: string;
	kind: "platform" | "workspace";
	/** Whether [to] exists on this machine. */
	exists: boolean;
}

export interface Preview {
	appVersion: string;
	dbVersion: number;
	kind: Manifest["kind"];
	createdAt: number;
	host: string;
	user: string;
	credentials: Manifest["credentials"];
	/** Sealed keys need the migration password. */
	needsPassword: boolean;
	/** Same Windows user on the same machine: local DPAPI keys still open. */
	sameUser: boolean;
	counts: Record<string, number>;
	includes: Manifest["includes"];
	size: number;
	paths: PathSuggestion[];
	replaces: string[];
	warnings: string[];
}

export class RestoreError extends Error {}

const SECRETS_ENC = "secrets.enc";

/** Checks a package without changing anything; what it holds and the suggested path map. */
export async function inspectBackup(file: string, target: RestoreTarget): Promise<{ archive: Archive; manifest: Manifest; preview: Preview }> {
	if (!existsSync(file)) throw new RestoreError("找不到这个备份文件");
	const archive = await Archive.open(file);
	try {
		const manifest = await readManifest(archive, target);
		return { archive, manifest, preview: previewOf(archive, manifest, target) };
	} catch (error) {
		archive.close();
		throw error;
	}
}

async function readManifest(archive: Archive, target: RestoreTarget): Promise<Manifest> {
	let manifest: Manifest;
	try {
		manifest = JSON.parse((await archive.readBuffer("manifest.json")).toString("utf8")) as Manifest;
	} catch (error) {
		throw new RestoreError(error instanceof ArchiveError ? `不是 DreamFlutter 的备份包（${error.message}）` : "备份包的清单读不出来");
	}
	if (manifest?.format !== FORMAT || !Array.isArray(manifest.files) || typeof manifest.dbVersion !== "number") throw new RestoreError("不是 DreamFlutter 的备份包");
	if (manifest.formatVersion > FORMAT_VERSION || manifest.dbVersion > MIGRATIONS.length || compareVersions(manifest.appVersion, target.appVersion) > 0) {
		throw new RestoreError(`这个备份来自更新的版本（v${manifest.appVersion}），当前是 v${target.appVersion}。请先升级应用再导入。`);
	}
	if (manifest.dbVersion < (target.minDbVersion ?? MIN_DB_VERSION)) throw new RestoreError(`只支持 v0.3.0 及以后的备份（这个备份来自 v${manifest.appVersion}）`);
	// Every file the manifest lists is there with its size, and nothing else is.
	const listed = new Set<string>();
	for (const f of manifest.files) {
		if (typeof f?.path !== "string" || !f.path.startsWith("data/")) throw new RestoreError("备份包的清单不对");
		const entry = archive.entries.get(f.path);
		if (!entry || entry.size !== f.size) throw new RestoreError(`备份包不完整：${f.path}`);
		listed.add(f.path);
	}
	for (const name of archive.entries.keys()) {
		if (name !== "manifest.json" && name !== SECRETS_ENC && !listed.has(name)) throw new RestoreError(`备份包里有清单之外的文件：${name}`);
	}
	if (manifest.credentials === "password" && !archive.entries.has(SECRETS_ENC)) throw new RestoreError("备份包缺少加密的 API Key");
	return manifest;
}

function previewOf(archive: Archive, manifest: Manifest, target: RestoreTarget): Preview {
	const sameUser = manifest.source.host === hostname() && manifest.source.user === userInfo().username;
	const warnings: string[] = [];
	if (manifest.credentials === "none") warnings.push("备份里没有 API Key：这台电脑上已有的 Key 会保留，没有的渠道要重新填写。");
	if (manifest.credentials === "local" && !sameUser) warnings.push("这是另一台电脑或另一个 Windows 用户的自动备份，里面的 API Key 在这里解不开，需要重新填写。");
	if (manifest.includes.sandbox) warnings.push("蝶君沙箱里的文件会在沙箱下次启动时放回（没有沙箱时，建好后放回）。");
	return {
		appVersion: manifest.appVersion,
		dbVersion: manifest.dbVersion,
		kind: manifest.kind,
		createdAt: manifest.createdAt,
		host: manifest.source.host,
		user: manifest.source.user,
		credentials: manifest.credentials,
		needsPassword: manifest.credentials === "password",
		sameUser,
		counts: manifest.counts,
		includes: manifest.includes,
		size: archive.totalSize,
		paths: suggestPaths(manifest, target),
		replaces: [
			"后台数据库（会话索引、任务、记忆、定时任务、卡片、模型渠道……）",
			"卡片包、蝶君的家",
			`Pi 的设置（${PI_FILES.join("、")}）`,
			`${manifest.includes.sessions} 个会话记录（这台电脑上其他的会话保留）`,
		],
		warnings,
	};
}

/** The suggested old → new folders: the app's own always, workspaces where they can be found. */
export function suggestPaths(manifest: Manifest, target: RestoreTarget): PathSuggestion[] {
	const s = manifest.source;
	const home = homedir();
	const out: PathSuggestion[] = [
		{ from: s.dataDir, to: target.paths.dataDir, kind: "platform", exists: true },
		{ from: s.agentDir, to: target.agentDir, kind: "platform", exists: true },
		{ from: s.sessionsDir, to: target.sessionsDir, kind: "platform", exists: true },
		{ from: s.home, to: home, kind: "platform", exists: true },
	];
	const viaHome = new PathMap([{ from: s.home, to: home }]);
	for (const workspace of s.workspaces) {
		let to = workspace;
		if (!existsSync(to)) {
			const moved = viaHome.map(workspace);
			if (moved !== workspace && existsSync(moved)) to = moved;
		}
		out.push({ from: workspace, to, kind: "workspace", exists: existsSync(to) });
	}
	return out;
}

export interface StageOptions {
	password?: string;
	/** The user's edits to the workspace rows of the suggestion (from → to). */
	workspaces?: PathRule[];
	parts: BackupPart[];
	signal?: AbortSignal;
	onProgress?: (step: string) => void;
}

export interface Staged {
	dir: string;
	manifest: Manifest;
	preview: Preview;
	counts: Record<string, number>;
	sessions: number;
	materialsRestored: number;
	/** Channels / providers whose key is missing after the restore. */
	missingKeys: string[];
	prefs?: Record<string, unknown>;
	sandbox: boolean;
	secrets: boolean;
	piFiles: string[];
	/** Session files: staged relative path → where it goes. */
	sessionTargets: { staged: string; target: string }[];
}

export function stagingDir(paths: CorePaths): string {
	return join(paths.dataDir, "restore-staging");
}

export async function stageBackup(file: string, target: RestoreTarget, options: StageOptions): Promise<Staged> {
	const { archive, manifest, preview } = await inspectBackup(file, target);
	const dir = stagingDir(target.paths);
	const step = (s: string) => {
		options.signal?.throwIfAborted();
		options.onProgress?.(s);
	};
	try {
		await rm(dir, { recursive: true, force: true });
		await mkdir(dir, { recursive: true });

		step("解开备份包");
		const raw = join(dir, "raw");
		for (const f of manifest.files) {
			options.signal?.throwIfAborted();
			const digest = await archive.extract(f.path, under(raw, f.path), options.signal);
			if (digest !== f.sha256) throw new RestoreError(`备份包已损坏：${f.path} 的校验值不对`);
		}
		let sealed: { secrets: Record<string, string>; files: Record<string, string> } | undefined;
		if (manifest.credentials === "password") {
			if (!options.password) throw new RestoreError("请输入迁移密码");
			const box = JSON.parse((await archive.readBuffer(SECRETS_ENC)).toString("utf8")) as SealedBox;
			sealed = JSON.parse((await openSealed(box, options.password)).toString("utf8"));
		}
		archive.close();

		const appdata = join(raw, "data", "appdata");
		const piDir = join(raw, "data", "pi");
		const sameUser = preview.sameUser;

		step("整理 API Key");
		const secretsDir = join(appdata, "secrets");
		if (manifest.credentials === "local" && !sameUser) await rm(secretsDir, { recursive: true, force: true });
		if (sealed) {
			const names = Object.keys(sealed.secrets).filter((n) => /^[\w.-]+\.dpapi$/.test(n));
			const protectedValues = await dpapiMany("protect", names.map((n) => sealed!.secrets[n]!));
			await mkdir(secretsDir, { recursive: true });
			for (const [i, name] of names.entries()) await writeFile(join(secretsDir, name), protectedValues[i]!, "utf8");
			for (const [name, text] of Object.entries(sealed.files)) {
				const base = name.replace(/^pi\//, "");
				if (!/^[\w.-]+\.json$/.test(base)) continue;
				await mkdir(piDir, { recursive: true });
				await writeFile(join(piDir, base), text, "utf8");
			}
		}
		const secrets = existsSync(secretsDir);
		const liveSecrets = join(target.paths.dataDir, "secrets");
		const secretsAfter = secrets ? secretsDir : liveSecrets;

		step("对照路径");
		const rules: PathRule[] = [
			{ from: manifest.source.dataDir, to: target.paths.dataDir },
			{ from: manifest.source.agentDir, to: target.agentDir },
			{ from: manifest.source.sessionsDir, to: target.sessionsDir },
			...(options.workspaces ?? preview.paths.filter((p) => p.kind === "workspace")).map((r) => ({ from: r.from, to: r.to })),
			{ from: manifest.source.home, to: homedir() },
		];
		const base = new PathMap(rules);
		// Sessions: Pi names their folder after the workspace, so a moved workspace moves its sessions' folder.
		const sessionRoot = join(raw, "data", "sessions");
		const sessionTargets: { staged: string; target: string; header?: Record<string, unknown> }[] = [];
		for (const path of listFiles(sessionRoot)) {
			const rel = relative(sessionRoot, path);
			const header = readHeader(path);
			const parts = rel.split(sep);
			let targetRel = rel;
			if (header && typeof header.cwd === "string" && parts.length > 1 && parts[0] === basename(piSessionFolder(manifest.source.sessionsDir, header.cwd))) {
				targetRel = join(basename(piSessionFolder(target.sessionsDir, base.map(header.cwd))), ...parts.slice(1));
			}
			sessionTargets.push({ staged: rel, target: join(target.sessionsDir, targetRel), header });
		}
		const map = new PathMap(
			rules,
			sessionTargets.map((s) => ({ from: join(manifest.source.sessionsDir, s.staged), to: s.target })),
		);
		const sessionsOut = join(dir, "sessions");
		for (const s of sessionTargets) {
			const from = join(sessionRoot, s.staged);
			const out = join(sessionsOut, s.staged);
			await mkdir(dirname(out), { recursive: true });
			const text = await readFile(from, "utf8");
			const newline = text.indexOf("\n");
			const first = newline < 0 ? text : text.slice(0, newline);
			let body = text;
			if (s.header) {
				const header = { ...s.header };
				if (typeof header.cwd === "string") header.cwd = map.map(header.cwd);
				if (typeof header.parentSession === "string") header.parentSession = map.map(header.parentSession);
				if (JSON.stringify(header) !== first) body = JSON.stringify(header) + (newline < 0 ? "" : text.slice(newline));
			}
			await writeFile(out, body, "utf8");
		}
		await rm(sessionRoot, { recursive: true, force: true });

		step("升级并整理数据库");
		const dbFile = join(appdata, "core.db");
		if (!existsSync(dbFile)) throw new RestoreError("备份包里没有数据库");
		const db = new Db(dbFile); // runs the app's migrations: an older package comes up to date
		let counts: Record<string, number>;
		let materialsRestored = 0;
		const missingKeys = new Set<string>();
		try {
			const context = { map, secretRef: (ref: string) => relocateSecretRef(ref, join(target.paths.dataDir, "secrets")) };
			db.transaction(() => {
				remapColumns(db, options.parts, context);
				for (const part of options.parts) part.onStage?.(db, context);
			});
			// 蝶君's materials: where the original is gone, the copy in the package takes its place.
			const materialsRoot = join(raw, "data", "materials");
			for (const row of db.all<{ id: string; path: string }>("SELECT id, path FROM materials WHERE path IS NOT NULL AND path != ''")) {
				if (existsSync(row.path)) continue;
				// Both come from the package: never let them name a place outside its materials folder.
				const name = basename(row.path);
				if (!SAFE_ID.test(row.id) || !name || name === "." || name === "..") continue;
				const copy = join(materialsRoot, row.id, name);
				if (!existsSync(copy)) continue;
				const home = join(appdata, "butterfly", "materials", row.id);
				await mkdir(home, { recursive: true });
				await rename(copy, join(home, basename(row.path)));
				db.run("UPDATE materials SET path = ? WHERE id = ?", join(target.paths.butterflyDir, "materials", row.id, basename(row.path)), row.id);
				materialsRestored++;
			}
			for (const row of db.all<{ name: string; secret: string }>("SELECT c.name, k.secret FROM gateway_keys k JOIN gateway_channels c ON c.id = k.channel_id")) {
				const keyFile = secretFileOf(row.secret);
				if (keyFile && !existsSync(join(secretsAfter, basename(keyFile)))) missingKeys.add(`模型渠道「${row.name}」`);
			}
			counts = tableCounts(db.raw);
		} finally {
			db.close();
		}
		await rm(join(raw, "data", "materials"), { recursive: true, force: true });

		step("整理 Pi 的设置");
		const piFiles: string[] = [];
		if (existsSync(piDir)) {
			for (const name of readdirSync(piDir)) {
				piFiles.push(name);
				const path = join(piDir, name);
				if (!name.endsWith(".json")) continue;
				let data: unknown;
				try {
					data = JSON.parse(await readFile(path, "utf8"));
				} catch {
					continue;
				}
				const fixed = fixPiJson(data, name, map, join(target.paths.dataDir, "secrets"), (ref) => {
					const keyFile = secretFileOf(ref);
					if (keyFile && !existsSync(join(secretsAfter, basename(keyFile)))) missingKeys.add(`Pi 配置 ${name} 里的 Key（${basename(keyFile, ".dpapi")}）`);
				});
				await writeFile(path, `${JSON.stringify(fixed, null, 2)}\n`, "utf8");
			}
		}

		let prefs: Record<string, unknown> | undefined;
		const prefsFile = join(raw, "data", "prefs.json");
		if (existsSync(prefsFile)) prefs = map.mapJson(JSON.parse(await readFile(prefsFile, "utf8"))) as Record<string, unknown>;
		const sandbox = existsSync(join(raw, "data", "sandbox", "workspace.tar.gz"));

		const staged: Staged = {
			dir,
			manifest,
			preview,
			counts,
			sessions: sessionTargets.length,
			materialsRestored,
			missingKeys: [...missingKeys],
			prefs,
			sandbox,
			secrets,
			piFiles,
			sessionTargets: sessionTargets.map((s) => ({ staged: s.staged, target: s.target })),
		};
		await writeFile(join(dir, "staged.json"), JSON.stringify({ ...staged, manifest: undefined }, null, 2), "utf8");
		return staged;
	} catch (error) {
		archive.close();
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}


/** Pi's JSON with this machine's paths (trust.json keys by folder) and key references. */
function fixPiJson(data: unknown, name: string, map: PathMap, secretsDir: string, onRef: (ref: string) => void): unknown {
	const walk = (value: unknown, keys: boolean): unknown => {
		if (typeof value === "string") {
			if (isSecretReference(value)) {
				onRef(value);
				return relocateSecretRef(value, secretsDir);
			}
			// Pi's include/exclude entries (settings.json skills, prompts): "-C:\…\SKILL.md", "+C:\…".
			const marked = /^([+-])(.+)$/s.exec(value);
			if (marked) return marked[1] + map.map(marked[2]!);
			return map.map(value);
		}
		if (Array.isArray(value)) return value.map((v) => walk(v, false));
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [keys ? map.map(k) : k, walk(v, false)]));
		return value;
	};
	return walk(data, name === "trust.json");
}

function readHeader(path: string): Record<string, unknown> | undefined {
	try {
		const text = readFileSync(path, "utf8");
		const line = text.slice(0, text.indexOf("\n") < 0 ? undefined : text.indexOf("\n"));
		const header = JSON.parse(line) as Record<string, unknown>;
		return header?.type === "session" ? header : undefined;
	} catch {
		return undefined;
	}
}

function listFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(d, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) out.push(path);
		}
	};
	walk(dir);
	return out;
}

/** -1, 0, 1 for dotted versions ("0.3.1" vs "0.3.0"). */
export function compareVersions(a: string, b: string): number {
	const pa = String(a).split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
	const pb = String(b).split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return Math.sign(d);
	}
	return 0;
}

