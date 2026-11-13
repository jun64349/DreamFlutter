import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dreamFlutterSessions, MIGRATION_FILE, MOVED_MARKER } from "../backup/backup.ts";
import { isInside } from "../backup/path-map.ts";
import { atomicJson, locationFile, readLocationConfig, storageLocations, type StorageKind } from "../storage/locations.ts";

export const keepMarker = "uninstall-keep-data";
export const preservedReceipt = ".dreamflutter-preserved.json";
export type DeleteTarget = { path: string; tree: boolean; kind: StorageKind | "data" | "legacyData" | "legacySession" };
export type LegacyPaths = { dataDir: string; agentDir: string };
export type UninstallPlan = {
	dataDir: string;
	sandboxDir: string;
	distro?: string;
	preserveTo?: string;
	remove: DeleteTarget[];
	review: { path: string; reason: string }[];
};

export function systemProtectedPaths(): string[] {
	return [process.env.USERPROFILE, process.env.APPDATA, process.env.LOCALAPPDATA,
		process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData]
		.filter((value): value is string => !!value && isAbsolute(value));
}

export function relocatePreservedLocations(source: string, destination: string, pathRoot = destination): void {
	const config = readLocationConfig(destination);
	if (!config) return;
	for (const [kind, path] of Object.entries(config.paths)) {
		if (isInside(source, path)) config.paths[kind as StorageKind] = join(pathRoot, relative(source, path));
	}
	atomicJson(locationFile(destination), config);
}

export function localPath(path: string): string {
	if (!isAbsolute(path) || path.startsWith("\\\\") || process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(path)) throw new Error("unsafe_path");
	const full = resolve(path);
	if (full === parse(full).root) throw new Error("unsafe_path");
	return full;
}

export function safePath(path: string): void {
	const full = localPath(path);
	let part = full;
	while (part !== dirname(part)) {
		const stat = lstatSync(part, { throwIfNoEntry: false });
		if (stat && (stat.isSymbolicLink() || resolve(realpathSync(part)).toLowerCase() !== part.toLowerCase())) throw new Error("linked_path");
		part = dirname(part);
	}
}

function read(path: string): string | undefined {
	safePath(path);
	if (!lstatSync(path, { throwIfNoEntry: false })) return undefined;
	return readFileSync(path, "utf8");
}

function installedLegacy(dataDir: string, legacy: LegacyPaths, plan: UninstallPlan): void {
	const migration = JSON.parse(read(join(dataDir, MIGRATION_FILE)) ?? "null") as { state?: string; from?: Partial<LegacyPaths> } | null;
	const same = (a: string | undefined, b: string) => !!a && isAbsolute(a) && resolve(a).toLowerCase() === resolve(b).toLowerCase();
	if (migration?.state !== "done" || !same(migration.from?.dataDir, legacy.dataDir) || !same(migration.from?.agentDir, legacy.agentDir)) return;
	const marker = read(join(legacy.dataDir, MOVED_MARKER));
	if (!same(marker?.split(/\r?\n/)[1], dataDir)) {
		plan.review.push({ path: legacy.dataDir, reason: "legacy_ownership_unconfirmed" });
		return;
	}
	const oldDisk = join(legacy.dataDir, "sandbox", "disk", "ext4.vhdx");
	safePath(oldDisk);
	if (lstatSync(oldDisk, { throwIfNoEntry: false })) {
		plan.review.push({ path: legacy.dataDir, reason: "legacy_disk_ownership_unconfirmed" });
		return;
	}
	const sessions = join(legacy.agentDir, "sessions");
	const file = join(legacy.dataDir, "core.db");
	safePath(file);
	if (lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
		const db = new DatabaseSync(file, { readOnly: true });
		try {
			for (const path of dreamFlutterSessions(db)) {
				if (!isAbsolute(path) || !isInside(sessions, path) || extname(path).toLowerCase() !== ".jsonl") continue;
				plan.remove.push({ path: resolve(path), tree: false, kind: "legacySession" });
			}
		} finally { db.close(); }
	}
	plan.remove.push({ path: legacy.dataDir, tree: true, kind: "legacyData" });
}

export function planUninstall(installRoot: string, legacy: LegacyPaths, protect: readonly string[] = []): UninstallPlan {
	const root = localPath(installRoot);
	const dataDir = join(root, "data");
	safePath(dataDir);
	const locations = storageLocations(dataDir);
	const sandboxDir = localPath(locations.sandbox);
	const plan: UninstallPlan = { dataDir, sandboxDir, remove: [], review: [] };
	if (isInside(sandboxDir, dataDir)) throw new Error("overlapping_sandbox_path");
	const protectedPaths = [root, legacy.dataDir, legacy.agentDir, ...protect].filter(isAbsolute);
	for (const path of Object.values(locations)) {
		localPath(path);
		if (!isInside(dataDir, path) && (protectedPaths.some(boundary => isInside(path, boundary)) ||
			[root, legacy.dataDir, legacy.agentDir].some(boundary => isInside(boundary, path)))) throw new Error("unsafe_storage_path");
		safePath(path);
	}
	for (const [kind, path] of Object.entries(locations)) {
		if (kind !== "sandbox" && isInside(sandboxDir, path)) throw new Error("overlapping_sandbox_path");
	}
	const disk = join(sandboxDir, "disk", "ext4.vhdx");
	safePath(disk);
	const distro = read(join(sandboxDir, "distro.txt"))?.trim();
	if (distro && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(distro)) plan.distro = distro;
	else if (distro !== undefined || lstatSync(disk, { throwIfNoEntry: false })) {
		plan.review.push({ path: sandboxDir, reason: "distro_ownership_unconfirmed" });
	}
	const add = (path: string, tree: boolean, kind: DeleteTarget["kind"]) => {
		if (!lstatSync(path, { throwIfNoEntry: false })) return;
		plan.remove.push({ path, tree, kind });
	};
	add(disk, false, "sandbox");
	add(join(sandboxDir, "clean.vhdx"), false, "sandbox");
	add(sandboxDir, true, "sandbox");
	const preserve = read(join(dataDir, keepMarker));
	if (preserve !== undefined) {
		if (preserve.trim() !== "1") throw new Error("invalid_keep_marker");
		plan.preserveTo = root + ".preserved-data";
		safePath(plan.preserveTo);
		if (lstatSync(plan.preserveTo, { throwIfNoEntry: false })) {
			let suffix = 2;
			while (lstatSync(plan.preserveTo + "-" + suffix, { throwIfNoEntry: false })) suffix++;
			plan.preserveTo += "-" + suffix;
		}
		// Remove the consumed marker after the directory is moved outside Velopack's root.
		return plan;
	}
	for (const [raw, path] of Object.entries(locations)) {
		const kind = raw as StorageKind;
		if (kind === "sandbox" || isInside(dataDir, path)) continue;
		if (kind === "database") {
			for (const name of ["core.db", "core.db-wal", "core.db-shm", "core.db-journal"]) add(join(path, name), false, kind);
		} else if (kind === "logs") {
			for (const name of ["core.log", "core.log.1"]) add(join(path, name), false, kind);
		} else add(path, true, kind);
	}
	if (lstatSync(join(dataDir, "storage-move.json"), { throwIfNoEntry: false })) {
		plan.review.push({ path: dataDir, reason: "unfinished_storage_move" });
	}
	installedLegacy(dataDir, legacy, plan);
	add(dataDir, true, "data");
	const seen = new Set<string>();
	plan.remove = plan.remove.filter(target => {
		const key = target.path.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	plan.remove = plan.remove.filter(target => !plan.remove.some(parent => parent !== target && parent.tree &&
		parent.kind !== "sandbox" && target.kind !== "sandbox" && isInside(parent.path, target.path)));
	if (plan.remove.some(target => target.tree && target.kind !== "sandbox" && !isInside(dataDir, target.path) && isInside(target.path, sandboxDir))) {
		throw new Error("overlapping_sandbox_path");
	}
	// Files inside separately managed directories precede their parent directories.
	plan.remove.sort((a, b) => b.path.length - a.path.length);
	return plan;
}

