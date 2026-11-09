/** Reconcile an interrupted owned benchmark without making any model requests or deleting Windows data copies. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { corePaths } from "../src/paths.ts";
import { runWsl } from "../src/sandbox/sandbox.ts";
import { redactValue } from "../src/security/redaction.ts";
import { scoreRouting, type RoutingDataset } from "../src/modules/skill-routing-eval.ts";

const file = resolve(process.argv[2]!); assert.ok(file.endsWith("T80-live-formal-r2.json"));
const proof = JSON.parse(readFileSync(file, "utf8"));
assert.equal(dirname(resolve(proof.root)).toLowerCase(), resolve(tmpdir()).toLowerCase());
assert.match(proof.root.split(/[\\/]/).at(-1), /^df-t80-real-[A-Za-z0-9]+$/);
assert.equal(proof.distro, "df-t80-real-6ca3f444-c79", "only the distro created by the interrupted run");
const db = new DatabaseSync(corePaths(join(proof.root, "data")).dbFile, { readOnly: true });
try {
	proof.requests = db.prepare("SELECT model,ok,error_kind,error,input,output,cost,duration_ms FROM gateway_requests ORDER BY id").all();
	proof.costUsd = Number((db.prepare("SELECT COALESCE(SUM(cost),0) total FROM gateway_requests").get() as {total:number}).total);
} finally { db.close(); }
const dataset = JSON.parse(readFileSync(new URL("../../docs/research/v0.7-routing-draft.json", import.meta.url), "utf8")) as RoutingDataset;
proof.score = scoreRouting(dataset, proof.attempts);
proof.stoppedByUser = true; proof.stoppedAt = new Date().toISOString(); proof.passed = false;
proof.error = "Stopped at user's request; incomplete, not a formal result. No further full batch authorized.";
proof.usageMayBeIncomplete = true;
proof.sourceFreezeUnchanged = Object.entries(proof.sourceFreeze as Record<string,string>).every(([path, hash]) => createHash("sha256").update(readFileSync(path)).digest("hex") === hash);
const stopped = await runWsl(["--terminate", proof.distro], { timeoutMs: 10000 });
proof.ownedSandboxTerminated = stopped.code === 0;
proof.ownedSandboxRemoved = false;
proof.cleanup = "Owned WSL terminated; registered image and Windows temporary profile retained. No recursive deletion retried after automatic review rejected copy cleanup.";
writeFileSync(file, JSON.stringify(redactValue(proof), null, 2));
console.log(JSON.stringify({ stoppedByUser: true, attempts: proof.attempts.length, physicalRequests: proof.physicalRequests, costUsd: proof.costUsd, complete: proof.score.complete, formalPassed: proof.score.formalPassed, ownedSandboxTerminated: proof.ownedSandboxTerminated, sourceFreezeUnchanged: proof.sourceFreezeUnchanged }));
