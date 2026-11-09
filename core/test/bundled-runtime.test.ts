import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

test("T75 packaging fails closed for missing or corrupted pinned assets without falling back to network", async () => {
	const api = await import(new URL("../../scripts/prepare-bundled-runtime.mjs", import.meta.url).href);
	const dir = mkdtempSync(join(tmpdir(), "df-t75-hashes-"));
	try {
		assert.throws(() => api.cachedAssets(dir, true), /Offline build cache is missing/);
		const fake = join(dir, api.lock.git.file); writeFileSync(fake, "corrupted archive");
		assert.throws(() => api.cachedAssets(dir, true), /SHA-256 mismatch/);
		assert.throws(() => api.cachedAssets(dir, false), /SHA-256 mismatch/, "even online preparation must reject existing corruption");
		const valid = join(dir, "sample.whl"); writeFileSync(valid, "valid");
		const entry = { file: "sample.whl", sha256: createHash("sha256").update("valid").digest("hex") };
		api.verify(valid, entry); writeFileSync(valid, "changed"); assert.throws(() => api.verify(valid, entry), /SHA-256 mismatch/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
