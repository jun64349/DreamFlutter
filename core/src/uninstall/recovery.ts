import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { userTables } from "../backup/parts.ts";
import { isInside } from "../backup/path-map.ts";
import { recordFile, type SwitchRecord } from "../backup/switch.ts";
import { RpcError, type Core } from "../core.ts";
import { PRICE_RULES } from "../ledger/rules.ts";
import { atomicJson, readLocationConfig, storageLocations } from "../storage/locations.ts";
import { keepMarker, preservedReceipt, relocatePreservedLocations, safePath } from "./plan.ts";

export type PreservedData = { path: string; bytes: number; savedAt: number };
const baselineFlags = new Set([
	"model_roles_v1", "memory_v05_migrated", "memory_v07_migrated_active",
	"desk_moved_to_butterfly", "session_index_last_message",
	"t95_schedule_owner_backfill", "t96_schedule_creator_backfill",
]);
const baselineSettings: Record<string, string> = { smallTaskModel: "null", largeTaskModel: "null", modelOverrides: "{}" };
const transientRoot = new Set(["core.lock", "core.json", "core-startup.json", "storage-locations.json"]);
const sourceOnlyRoot = new Set([...transientRoot].filter(name => name !== "storage-locations.json").concat([keepMarker, preservedReceipt]));
const pendingRecords = ["restore-switch.json", "restore-old", "storage-move.json", "updates"];
const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const conflict = () => new RpcError("conflict", "当前安装已有数据，不能覆盖。保留的数据仍在原处。");

function files(root: string, visit: (file: string, bytes: number) => void, skip?: string): void {
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (skip && same(path, skip)) continue;
			if (entry.isSymbolicLink()) throw new Error("linked_entry");
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) visit(path, lstatSync(path).size);
			else throw new Error("invalid_entry");
		}
	};
	walk(root);
}

export function preservedData(root: string): PreservedData[] {
	safePath(root);
	const parent = dirname(root), prefix = basename(root) + ".preserved-data";
	const result: PreservedData[] = [];
	for (const entry of readdirSync(parent, { withFileTypes: true })) {
		if (!entry.isDirectory() || !(entry.name === prefix || entry.name.startsWith(prefix + "-") &&
			/^\d+$/.test(entry.name.slice(prefix.length + 1)))) continue;
		const path = join(parent, entry.name);
		try {
			safePath(path);
			const config = join(path, "storage-locations.json");
			safePath(config);
			const dbPath = join(storageLocations(path).database, "core.db");
			if (isInside(path, dbPath)) {
				safePath(dbPath);
				if (!lstatSync(dbPath, { throwIfNoEntry: false })?.isFile()) continue;
			} else if (!lstatSync(config, { throwIfNoEntry: false })?.isFile()) continue;
			const receipt = join(path, preservedReceipt);
			safePath(receipt);
			const savedAt = lstatSync(receipt, { throwIfNoEntry: false })?.mtimeMs ?? lstatSync(path).mtimeMs;
			let bytes = 0;
			files(path, (_file, size) => { bytes += size; });
			result.push({ path, bytes, savedAt: Math.trunc(savedAt) });
		} catch { /* Unreadable or linked candidate remains available for manual inspection. */ }
	}
	return result.sort((a, b) => b.savedAt - a.savedAt || a.path.localeCompare(b.path));
}

export function freshInstallation(core: Core, staging?: string): boolean {
	const root = core.paths.dataDir;
	try {
		safePath(root);
		const locations = storageLocations(root);
		if (Object.values(locations).some(path => !isInside(root, path))) return false;
		if (!same(core.paths.dbFile, join(locations.database, "core.db")) || !same(core.agentDir, locations.configuration) ||
			core.sessionDir !== undefined && !same(core.sessionDir, locations.sessions)) return false;
		const configFile = join(locations.configuration, "settings.json");
		const logFiles = [join(locations.logs, "core.log"), join(locations.logs, "core.log.1")];
		let fresh = true;
		files(root, file => {
			if (same(dirname(file), root) && transientRoot.has(basename(file))) return;
			if (["", "-wal", "-shm"].some(suffix => same(file, core.paths.dbFile + suffix)) || logFiles.some(log => same(file, log))) return;
			if (same(file, configFile)) {
				const settings = JSON.parse(readFileSync(file, "utf8"));
				if (settings && Object.keys(settings).length === 2 &&
					JSON.stringify(settings.skills) === JSON.stringify([locations.skills]) &&
					JSON.stringify(settings.prompts) === JSON.stringify([locations.templates])) return;
			}
			fresh = false;
		}, staging);
		if (!fresh) return false;
		for (const table of userTables(core.db)) {
			if (table === "settings") {
				if (core.db.all<{ key: string; value: string }>("SELECT key,value FROM settings")
					.some(row => !Object.hasOwn(baselineSettings, row.key) || baselineSettings[row.key] !== row.value)) return false;
			} else if (table === "app_flags") {
				if (core.db.all<{ key: string }>("SELECT key FROM app_flags").some(row => !baselineFlags.has(row.key))) return false;
			} else if (table === "ledger_price_rules") {
				if (core.db.all<{ version: string; definition: string }>("SELECT version,definition FROM ledger_price_rules")
					.some(row => !PRICE_RULES.some(rule => rule.version === row.version && JSON.stringify(rule) === row.definition))) return false;
			} else if (core.db.get(`SELECT 1 FROM "${table.replaceAll('"', '""')}" LIMIT 1`)) return false;
		}
		return true;
	} catch { return false; }
}

/** Stage a copy for the existing pre-database restart switch. The retained original is never consumed. */
export async function stagePreservedData(core: Core, root: string, requested: string): Promise<void> {
	if (!freshInstallation(core)) throw conflict();
	const candidate = isAbsolute(requested) ? preservedData(root).find(item => same(item.path, requested)) : undefined;
	if (!candidate) throw new RpcError("not_found", "找不到可恢复的保留数据。");
	const live = core.paths.dataDir;
	const source = storageLocations(candidate.path);
	const target = storageLocations(live);
	// The restart resolves database and Pi paths before applying the switch.
	// A different database/agent layout requires a separate migration workflow.
	const config = readLocationConfig(candidate.path);
	if (pendingRecords.some(name => lstatSync(join(candidate.path, name), { throwIfNoEntry: false }))) {
		throw new RpcError("bad_config", "保留数据含有更新或切换记录，请先核对原数据。");
	}
	for (const key of ["database", "configuration", "sessions"] as const) {
		if (!isInside(candidate.path, source[key]) || !same(join(live, relative(candidate.path, source[key])), target[key])) {
			throw new RpcError("bad_config", "保留数据的存储布局与当前安装不同，原数据已保留。");
		}
	}
	for (const key of Object.keys(source) as (keyof typeof source)[]) {
		if (!isInside(candidate.path, source[key])) throw new RpcError("bad_config", "保留数据包含外移目录，原数据已保留。");
	}
	const staging = join(live, "restore-preserved-" + randomUUID());
	const payload = join(staging, "payload");
	const oldDir = join(staging, "old");
	safePath(staging);
	try {
		await mkdir(staging);
		await cp(candidate.path, payload, { recursive: true, errorOnExist: true, force: false });
		files(payload, () => {});
		const database = join(payload, relative(candidate.path, source.database), "core.db");
		const db = new DatabaseSync(database, { readOnly: true });
		try {
			const result = db.prepare("PRAGMA quick_check").get();
			if (result?.quick_check !== "ok") throw new Error("invalid_database");
		} finally { db.close(); }
		if (config) relocatePreservedLocations(candidate.path, payload, live);
		const names = readdirSync(payload).filter(name => !sourceOnlyRoot.has(name));
		if (!names.includes(relative(candidate.path, source.database).split(/[\\/]/)[0] || "core.db")) throw new Error("missing_database");
		// Staging lives inside the fresh directory, so exclude only this exact scratch path when rechecking.
		if (!freshInstallation(core, staging) || lstatSync(recordFile(core.paths), { throwIfNoEntry: false })) throw conflict();
		const record: SwitchRecord = {
			version: 1, state: "pending", createdAt: Date.now(), staging, oldDir,
			items: names.map((name, index) => ({
				label: "保留数据", source: join(payload, name), target: join(live, name), old: join(oldDir, String(index)),
			})),
			result: { source: "preserved-data" },
		};
		atomicJson(recordFile(core.paths), record);
	} catch (error) {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
		if (error instanceof RpcError) throw error;
		throw new RpcError("unavailable", "准备恢复失败，保留的数据仍在原处。");
	}
}
