import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { redact } from "../security/redaction.ts";
import { unregisterSandbox, type WslRunner } from "../sandbox/sandbox.ts";
import { isInside } from "../backup/path-map.ts";
import { keepMarker, planUninstall, preservedReceipt, relocatePreservedLocations, safePath, type DeleteTarget, type LegacyPaths, type UninstallPlan } from "./plan.ts";

type LogEntry = { step: string; status: "start" | "ok" | "skip" | "retry" | "remaining" | "scheduled"; path?: string; reason?: string };
export type UninstallDeps = {
	legacy: LegacyPaths;
	protectedPaths?: string[];
	logRoot?: string;
	stopCore(dataDir: string): Promise<void>;
	wsl: WslRunner;
	// A name match alone is insufficient: stale distro.txt may name a different registration.
	registeredDisk(distro: string): Promise<string | undefined>;
	remove?(path: string, tree: boolean): Promise<"scheduled" | void>;
	retryDelayMs?: number;
};

function recordLog(path: string, entry: LogEntry): void {
	// Never serialize arbitrary exceptions, WSL output, discovery JSON or configuration values.
	appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry,
		path: entry.path === undefined ? undefined : redact(entry.path, true) }) + "\n", { mode: 0o600 });
}

export async function cleanInstallation(root: string, deps: UninstallDeps, existingLog?: string): Promise<{
	ok: boolean; plan?: UninstallPlan; logPath: string; remaining: string[];
}> {
	const logRoot = resolve(deps.logRoot ?? tmpdir());
	safePath(logRoot);
	const candidates = [resolve(root), deps.legacy.dataDir, deps.legacy.agentDir];
	if (candidates.some(path => isInside(path, logRoot))) throw new Error("unsafe_log_root");
	const logPath = existingLog ?? join(mkdtempSync(join(logRoot, "dreamflutter-uninstall-")), "uninstall.jsonl");
	if (!isInside(logRoot, logPath)) throw new Error("unsafe_log_path");
	safePath(logPath);
	const log = (entry: LogEntry) => recordLog(logPath, entry);
	const remaining: string[] = [];
	const left = (step: string, path: string, reason: string) => {
		remaining.push(path);
		log({ step, status: "remaining", path, reason });
	};
	let plan: UninstallPlan | undefined;
	try {
		log({ step: "plan", status: "start" });
		plan = planUninstall(root, deps.legacy, [...(deps.protectedPaths ?? []), dirname(logPath)]);
		log({ step: "plan", status: "ok" });
	} catch {
		left("plan", resolve(root, "data"), "cannot_confirm_data_paths");
		return { ok: false, logPath, remaining };
	}
	for (const review of plan.review) left("plan", review.path, review.reason);

	let stopped = false;
	log({ step: "core.stop", status: "start" });
	try {
		await deps.stopCore(plan.dataDir);
		stopped = true;
		log({ step: "core.stop", status: "ok" });
	} catch { left("core.stop", plan.dataDir, "core_still_running_or_unverified"); }

	let sandboxReady = stopped && !plan.review.some(item => item.reason === "distro_ownership_unconfirmed");
	if (sandboxReady && plan.distro) {
		try {
			log({ step: "sandbox.owner", status: "start", path: plan.sandboxDir });
			const disk = await deps.registeredDisk(plan.distro);
			if (disk) {
				const expected = join(plan.sandboxDir, "disk", "ext4.vhdx");
				safePath(expected);
				safePath(disk);
				if (resolve(disk).toLowerCase() !== expected.toLowerCase()) throw new Error("different_disk");
				log({ step: "sandbox.owner", status: "ok", path: plan.sandboxDir });
				log({ step: "sandbox.stop", status: "start", path: plan.sandboxDir });
				if ((await deps.wsl(["--terminate", plan.distro], { timeoutMs: 3500 })).code !== 0) {
					// WSL can report an error for an already stopped distro. Confirm it before proceeding.
					const running = await deps.wsl(["--list", "--running", "--quiet"], { timeoutMs: 3000 });
					if (running.code !== 0 || running.stdout.split(/\r?\n/).some(name => name.trim().toLowerCase() === plan!.distro!.toLowerCase())) throw new Error("terminate_failed");
				}
				log({ step: "sandbox.stop", status: "ok", path: plan.sandboxDir });
				log({ step: "sandbox.unregister", status: "start", path: plan.sandboxDir });
				const result = await unregisterSandbox(deps.wsl, plan.distro, 4500);
				if (result.code !== 0) throw new Error("unregister_failed");
				log({ step: "sandbox.unregister", status: "ok", path: plan.sandboxDir });
			} else {
				log({ step: "sandbox.unregister", status: "skip", path: plan.sandboxDir, reason: "not_registered" });
			}
		} catch (error) {
			const reason = error instanceof Error && ["different_disk", "terminate_failed", "unregister_failed"].includes(error.message)
				? error.message : "registry_or_wsl_unavailable";
			left("sandbox", plan.sandboxDir, reason);
			sandboxReady = false;
		}
	} else if (sandboxReady) log({ step: "sandbox.unregister", status: "skip", path: plan.sandboxDir, reason: "no_distro_record" });

	const remove = deps.remove ?? (async (path: string, tree: boolean) => { await rm(path, { recursive: tree, force: true }); });
	const erase = async (target: DeleteTarget, attempts = 1): Promise<boolean> => {
		const { path, tree, kind } = target;
		log({ step: "remove." + kind, status: "start", path });
		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				safePath(path);
				if (await remove(path, tree) === "scheduled") log({ step: "remove." + kind, status: "scheduled", path });
				else log({ step: "remove." + kind, status: "ok", path });
				return true;
			} catch {
				if (attempt < attempts) {
					log({ step: "remove." + kind, status: "retry", path, reason: "could_not_remove" });
					await delay(deps.retryDelayMs ?? 250);
				}
			}
		}
		left("remove." + kind, path, "could_not_remove_after_retries");
		return false;
	};

	const sandboxFiles = plan.remove.filter(target => target.kind === "sandbox" && !target.tree);
	const sandboxTree = plan.remove.find(target => target.kind === "sandbox" && target.tree);
	if (sandboxReady && sandboxTree) {
		for (const disk of sandboxFiles) {
			if (!await erase(disk, 3)) sandboxReady = false;
		}
		if (sandboxReady) sandboxReady = await erase(sandboxTree, 3);
	}
	if (stopped && plan.preserveTo) {
		log({ step: "preserve", status: "start", path: plan.preserveTo });
		try {
			safePath(plan.dataDir);
			safePath(plan.preserveTo);
			if (lstatSync(plan.preserveTo, { throwIfNoEntry: false })) throw new Error("destination_exists");
			if (!sandboxReady && isInside(plan.dataDir, plan.sandboxDir)) {
				preserveExceptSandbox(plan.dataDir, plan.preserveTo, plan.sandboxDir);
			} else renameSync(plan.dataDir, plan.preserveTo);
			relocatePreservedLocations(plan.dataDir, plan.preserveTo);
			writeFileSync(join(plan.preserveTo, preservedReceipt), '{"version":1}\n', { flag: "wx" });
			rmSync(join(plan.preserveTo, keepMarker), { force: true });
			log({ step: "preserve", status: "ok", path: plan.preserveTo });
		} catch { left("preserve", plan.dataDir, "could_not_move_preserved_data"); }
	} else if (stopped) {
		for (const target of plan.remove) {
			if (target.kind === "sandbox") continue;
			if (!sandboxReady && isInside(target.path, plan.sandboxDir)) {
				left("remove." + target.kind, target.path, "contains_remaining_sandbox");
				continue;
			}
			await erase(target);
		}
	}
	log({ step: "complete", status: remaining.length ? "remaining" : "ok" });
	return { ok: remaining.length === 0, plan, logPath, remaining };
}

function preserveExceptSandbox(source: string, destination: string, sandbox: string): void {
	mkdirSync(destination);
	for (const name of readdirSync(source)) {
		const from = join(source, name), to = join(destination, name);
		if (from.toLowerCase() === sandbox.toLowerCase()) continue;
		if (isInside(from, sandbox)) preserveExceptSandbox(from, to, sandbox);
		else renameSync(from, to);
	}
}

// Velopack runs the main executable synchronously. Moving a large tree to an adjacent
// directory is cheap, so actual bulk deletion can run after Velopack removes the app.
export function quarantine(path: string, tree: boolean, installRoot: string): { path: string; directory: string } | undefined {
	safePath(path);
	if (!lstatSync(path, { throwIfNoEntry: false })) return undefined;
	const parent = isInside(installRoot, path) ? dirname(installRoot) : dirname(path);
	safePath(parent);
	const directory = mkdtempSync(join(parent, ".dreamflutter-remove-"));
	try {
		const destination = join(directory, tree ? "tree" : "file");
		renameSync(path, destination);
		return { path: destination, directory };
	} catch (error) {
		rmdirSync(directory);
		throw error;
	}
}

