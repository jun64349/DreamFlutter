import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, win32 } from "node:path";
import { atomicJson } from "../storage/locations.ts";

export const nativePlacementsFile = "windows-workspace-placement.json";
export const nativeArchiveSourceFile = "pending-workspace-source.json";
export const LOCAL_NATIVE_FLAGS = ["windows-appcontainer-profile-v1", "windows-appcontainer-retained-v1", "windows-appcontainer-internet-v1"] as const;
const ownerFile = "dreamflutter-workspace-owner";
const idPattern = /^[a-f0-9]{32}$/;

export type GitWorkspacePlacement = { profileId: string; standardDir: string };
export type NativePlacements = { version: 1; owner: string; entries: GitWorkspacePlacement[] };

const installation = (dataDir: string) => resolve(dataDir).toLowerCase();

export function compatibleParent(standardDir: string): string {
	const root = win32.parse(standardDir).root;
	if (!/^[a-z]:\\$/i.test(root)) throw new Error("Git 兼容工作区需要本地磁盘。");
	return root;
}

export function nativeArchiveSource(value: unknown): string | undefined {
	if (typeof value !== "string" || !/^[a-z]:\\/i.test(value) || /[:\0]/.test(value.slice(2))) return;
	const normalized = win32.resolve(value);
	if (normalized.toLowerCase() !== value.toLowerCase() || !/\\appcontainer-[a-f0-9]{32}\\workspace$/i.test(value)) return;
	return normalized;
}

export function readNativePlacements(dataDir: string): NativePlacements {
	const file = join(dataDir, nativePlacementsFile);
	const stat = lstatSync(file, { throwIfNoEntry: false });
	if (!stat) return { version: 1, owner: installation(dataDir), entries: [] };
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024) throw new Error("Windows 工作区位置记录无效。");
	const value = JSON.parse(readFileSync(file, "utf8")) as NativePlacements;
	if (value?.version !== 1 || value.owner !== installation(dataDir) || !Array.isArray(value.entries) || value.entries.some(entry =>
		!entry || !idPattern.test(entry.profileId) || typeof entry.standardDir !== "string" || !/^[a-z]:\\/i.test(entry.standardDir) ||
		win32.resolve(entry.standardDir) !== entry.standardDir) || new Set(value.entries.map(entry => entry.profileId)).size !== value.entries.length) {
		throw new Error("Windows 工作区位置记录与本安装不符。");
	}
	return value;
}

export function saveNativePlacements(dataDir: string, value: NativePlacements): void {
	atomicJson(join(dataDir, nativePlacementsFile), value);
}

export function gitWorkspaceRoot(entry: GitWorkspacePlacement): string {
	if (!idPattern.test(entry.profileId)) throw new Error("Git 兼容工作区标识无效。");
	return win32.join(compatibleParent(entry.standardDir), `appcontainer-${entry.profileId}`);
}

export function gitWorkspaceOwner(dataDir: string, entry: GitWorkspacePlacement): { name: string; value: string } {
	return { name: ownerFile, value: createHash("sha256").update(`${installation(dataDir)}\n${gitWorkspaceRoot(entry).toLowerCase()}`).digest("hex") };
}

/** A ledger entry alone cannot activate, retire or erase a profile. */
export function ownsGitWorkspace(dataDir: string, entry: GitWorkspacePlacement): boolean {
	const root = gitWorkspaceRoot(entry);
	const marker = gitWorkspaceOwner(dataDir, entry);
	const rootStat = lstatSync(root, { throwIfNoEntry: false });
	if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root).toLowerCase() !== root.toLowerCase()) return false;
	const file = win32.join(root, marker.name);
	const stat = lstatSync(file, { throwIfNoEntry: false });
	return stat?.isFile() === true && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === marker.value.length &&
		readFileSync(file, "utf8") === marker.value;
}
