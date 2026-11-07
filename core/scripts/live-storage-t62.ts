/** Isolated official WSL move, using only a newly provisioned test distro. No model or user data. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCore } from "../src/app.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths, defaultAgentDir } from "../src/paths.ts";
import { Sandbox, runWsl } from "../src/sandbox/sandbox.ts";
import { bundledImage } from "../src/sandbox/image.ts";
import { storageLocations } from "../src/storage/locations.ts";
import { moveResultFile, preparePendingMove, remapMovedDatabase, rollbackMove, validateMove } from "../src/storage/move.ts";
import { supportsOfficialMove } from "../src/storage/wsl.ts";

const evidence = process.argv[2];
if (!evidence) throw new Error("usage: live-storage-t62.ts <evidence-json>");
const help = await runWsl(["--help"], { timeoutMs: 20_000 });
assert.ok(supportsOfficialMove(help.stdout), "WSL official move is required; no fallback permitted");
assert.ok(bundledImage(), "must use the existing bundled image; no network provisioning");
const temporary = mkdtempSync(join(tmpdir(), "df-t62-live-storage-")), root = join(temporary, "data");
const distro = `df-t62-live-${randomUUID().slice(0, 12)}`;
const commands: string[][] = [];
const steps: Record<string, unknown>[] = [];
let moving = false;
let sourceDisk = "";
let stoppedConfirmed = false;
async function waitForStopped(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= 60_000) {
    const reading = await runWsl(["--list", "--verbose"], { timeoutMs: 10_000 });
    const line = reading.stdout.split(/\r?\n/).find((row) => row.replace(/^\s*\*?\s*/, "").startsWith(distro + " "));
    const state = line?.trim().replace(/^\*\s*/, "").split(/\s+/)[1];
    steps.push({ operation: "wait-stopped", elapsedMs: Date.now() - started, code: reading.code, state: state ?? "not-found", list: reading.stdout.trim() });
    if (reading.code === 0 && /^(Stopped|已停止)$/i.test(state ?? "")) { stoppedConfirmed = true; return; }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error("Temporary distro did not reach Stopped within 60 seconds; move not attempted");
}
const wsl: typeof runWsl = async (args, options) => {
  commands.push(args);
  if (moving && args[0] === "--manage") {
    assert.equal(args[1], distro, "only this temporary distro may move");
    assert.ok(stoppedConfirmed, "must observe Stopped before official move");
  }
  const started = Date.now();
  const reading = await runWsl(args, options);
  if (moving) steps.push({ operation: args[0], args, elapsedMs: Date.now() - started, code: reading.code, error: reading.stderr || undefined });
  if (moving && args[0] === "--terminate") {
    assert.equal(args[1], distro, "only this temporary distro may terminate");
    if (reading.code === 0) { stoppedConfirmed = false; await waitForStopped(); }
  }
  if (moving && args[0] === "--manage" && /ERROR_SHARING_VIOLATION/.test(reading.stdout + reading.stderr)) {
    proof.stoppedMoveBlocked = true;
    try {
      proof.lockInspection = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", join(dirname(fileURLToPath(import.meta.url)), "t65-wsl-locks.ps1"), "-VhdPath", sourceDisk], { encoding: "utf8", timeout: 20_000, windowsHide: true }));
    } catch (error) { proof.lockInspectionError = String(error); }
    // A2 requires a pause after read-only inspection, not further move retries.
    throw new Error(`Stopped temporary distro move still blocked: ${reading.stderr || reading.stdout}`);
  }
  return reading;
};
let core: ReturnType<typeof buildCore> | undefined;
let migration: Awaited<ReturnType<typeof preparePendingMove>>;
const proof: Record<string, unknown> = { at: new Date().toISOString(), temporary, distro, modelCalls: 0, steps };
function construct() {
  for (const path of Object.values(storageLocations(root))) mkdirSync(path, { recursive: true });
  const result = buildCore({ paths: corePaths(root), agentDir: defaultAgentDir(root), sessionDir: storageLocations(root).sessions,
    log: new Logger(undefined, false), notifier: new RecordingNotifier(), sandbox: { distro, wsl } });
  result.settings.update({ memoryPaused: true, memoryAutoExtract: false, autoTitle: false });
  return result;
}
try {
  core = construct(); await core.start();
  console.log("Provisioning only isolated distro:", distro);
  await core.module(Sandbox)!.provision();
  const status = await core.module(Sandbox)!.status();
  assert.equal(status.state, "ready", status.error ?? "");
  const sentinel = await wsl(["-d", distro, "-u", "root", "--", "sh", "-c", "printf isolated-t62 > /workspace/t62-marker"], { timeoutMs: 60_000 });
  assert.equal(sentinel.code, 0, sentinel.stderr);
  const old = core.module(Sandbox)!.dir, target = join(temporary, "sandbox-moved");
  sourceDisk = join(old, "disk", "ext4.vhdx");
  await core.call("storage.move", { kind: "sandbox", target });
  await core.shutdown();
  moving = true;
  migration = await preparePendingMove(root, { wsl });
  if (!migration) {
    proof.outcome = JSON.parse(readFileSync(moveResultFile(root), "utf8"));
    proof.retainedSource = existsSync(join(old, "clean.vhdx")) && existsSync(join(old, "disk", "ext4.vhdx"));
    const restored = await wsl(["-d", distro, "-u", "root", "--", "cat", "/workspace/t62-marker"], { timeoutMs: 60_000 });
    proof.rollbackStartupVerified = restored.code === 0 && restored.stdout.trim() === "isolated-t62";
    proof.officialMoves = commands.filter((args) => args[0] === "--manage");
    assert.ok(proof.retainedSource && proof.rollbackStartupVerified, "old-location rollback must remain usable");
    throw new Error(`Official move blocked; original startup verified: ${(proof.outcome as any).error}`);
  }
  assert.ok(existsSync(join(old, "clean.vhdx")), "original template remains before startup verification");
  core = construct(); remapMovedDatabase(core, migration); await core.start(); await validateMove(core, migration, { wsl });
  const reading = await wsl(["-d", distro, "-u", "root", "--", "cat", "/workspace/t62-marker"], { timeoutMs: 60_000 });
  assert.equal(reading.code, 0); assert.equal(reading.stdout.trim(), "isolated-t62");
  assert.equal(core.module(Sandbox)!.dir, target);
  assert.equal(existsSync(join(old, "clean.vhdx")), false);
  assert.equal(existsSync(join(old, "disk", "ext4.vhdx")), false);
  proof.ok = true; proof.outcome = JSON.parse(readFileSync(moveResultFile(root), "utf8")); proof.marker = reading.stdout.trim();
  proof.officialMoves = commands.filter((args) => args[0] === "--manage");
  assert.equal((proof.officialMoves as string[][]).length, 1);
  console.log("Official move and new-location WSL startup verified.");
} catch (error) {
  proof.ok = false; proof.error = String(error);
  await core?.shutdown();
  if (migration && migration.stage !== "committed") await rollbackMove(root, migration, String(error), { wsl });
  throw error;
} finally {
  await core?.shutdown();
  // Lifecycle cleanup of this newly created distro, never a migration fallback.
  assert.ok(/^df-t62-live-[a-f0-9-]+$/.test(distro));
  await runWsl(["--terminate", distro], { timeoutMs: 30_000 });
  const removed = await runWsl(["--unregister", distro], { timeoutMs: 60_000 });
  const listed = await runWsl(["--list", "--quiet"], { timeoutMs: 20_000 });
  proof.cleanupCommandExit = removed.code;
  proof.cleanedDistro = listed.code === 0 && !listed.stdout.split(/\r?\n/).includes(distro);
  assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + "\\df-t62-live-storage-") || resolve(temporary).startsWith(resolve(tmpdir()) + "/df-t62-live-storage-"));
  if (proof.cleanedDistro) { rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); proof.cleanedDirectory = true; }
  writeFileSync(evidence, JSON.stringify(proof, null, 2));
}
