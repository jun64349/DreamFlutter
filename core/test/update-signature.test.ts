import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { verifySignature } from "../src/update/download.ts";

it("a temporary in-memory self-signed certificate verifies only its bytes and pinned test identity; tampering is blocked", () => {
  const dir = mkdtempSync(join(tmpdir(), "df-update-signature-")), file = join(dir, "fixture.nupkg"), signature = join(dir, "signature.json");
  try {
    const bytes = Buffer.from("T67 synthetic package bytes"); writeFileSync(file, bytes);
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve("../scripts/t67-velopack-probe/sign-fixture.ps1"), "-Package", file, "-Signature", signature], { windowsHide: true, timeout: 15000, stdio: "pipe" });
    const proof = JSON.parse(readFileSync(signature, "utf8")), hash = createHash("sha256").update(bytes).digest("hex");
    const thumbprint = new X509Certificate(proof.certificate).fingerprint256.replaceAll(":", "").toLowerCase();
    assert.equal(verifySignature(hash, proof).state, "untrusted");
    assert.equal(verifySignature(hash, proof, [thumbprint]).state, "trusted-test");
    const changed = createHash("sha256").update("modified package bytes").digest("hex");
    assert.throws(() => verifySignature(changed, proof, [thumbprint]), (e: any) => e.code === "invalid_signature");
    assert.throws(() => verifySignature(hash, { ...proof, signature: Buffer.alloc(256).toString("base64") }, [thumbprint]), (e: any) => e.code === "invalid_signature");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
