import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { JournalStore, pendingValidation, shouldRollback, type UpdateJournal } from "../src/update/state.ts";

function record(root: string): UpdateJournal {
  return { id: "fixture", phase: "validating", at: 1, from: "0.6.0-test.1", to: "0.6.0-test.2", installRoot: root, appRoot: join(root, "current"), dataRoot: root, databaseFile: join(root, "core.db"), agentDir: root, sessionsDir: root,
    backup: join(root, "retained.dfbackup"), targetPackage: join(root, "next.nupkg"), oldPackage: join(root, "old.nupkg"), asset: { name: "next.nupkg", size: 1, sha256: "a".repeat(64), url: "http://127.0.0.1/next" }, guardDir: root, corePid: process.pid, nonce: "synthetic", acceptedWrites: false, attemptedRollback: false, memoryWasPaused: false };
}
it("update journal gates validation and forbids any automatic restore once a write is accepted", () => {
  const dir = mkdtempSync(join(tmpdir(), "df-update-state-")), store = new JournalStore(dir);
  try {
    const initial = record(dir); store.mutate(() => initial);
    assert.equal(pendingValidation(store.read()), true); assert.equal(shouldRollback(initial), true);
    store.patch({ phase: "verified" }); store.accepted();
    assert.equal(store.read()!.acceptedWrites, true); assert.equal(pendingValidation(store.read()), false); assert.equal(shouldRollback(store.read()!), false);
    assert.throws(() => store.patch({ phase: "rollback-needed" }));
    assert.throws(() => store.patch({ phase: "validating", acceptedWrites: false }));
    assert.equal(store.read()!.phase, "accepted");
    store.mutate(() => ({ ...initial, id: "next-update" }));
    assert.equal(store.read()!.id, "next-update", "a later explicit update has its own journal identity");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("corrupt journal blocks startup instead of silently accepting writes; completed rollback is not retried", () => {
  const dir = mkdtempSync(join(tmpdir(), "df-update-state-")), store = new JournalStore(dir);
  try {
    store.mutate(() => record(dir)); store.patch({ phase: "rolled-back", attemptedRollback: true });
    assert.equal(shouldRollback(store.read()!), false); assert.equal(pendingValidation(store.read()), false);
    writeFileSync(store.file, "{"); assert.throws(() => store.read(), (e: any) => e.code === "recovery_required");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
