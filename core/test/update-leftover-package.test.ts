import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dropLeftoverPackages } from "../src/update/installation.ts";

test("only Velopack's leftover full packages are removed from the install root (0.13.1 step 3)", () => {
	const root = mkdtempSync(join(tmpdir(), "df-leftover-"));
	try {
		const packages = join(root, "packages");
		mkdirSync(join(packages, "DreamFlutter-0.13.1-win-x64-full.nupkg.d"), { recursive: true });
		writeFileSync(join(packages, "DreamFlutter-0.13.1-win-x64-full.nupkg"), "x".repeat(10));
		writeFileSync(join(packages, "DreamFlutter-0.13.2-test.1-win-x64-full.nupkg"), "y".repeat(5));
		writeFileSync(join(packages, "notes.txt"), "keep");
		writeFileSync(join(root, "DreamFlutter-0.13.1-win-x64-full.nupkg"), "outside packages: keep");
		assert.equal(dropLeftoverPackages(root), 15);
		assert.equal(existsSync(join(packages, "DreamFlutter-0.13.1-win-x64-full.nupkg")), false);
		assert.equal(existsSync(join(packages, "DreamFlutter-0.13.2-test.1-win-x64-full.nupkg")), false);
		assert.ok(existsSync(join(packages, "notes.txt")));
		assert.ok(existsSync(join(packages, "DreamFlutter-0.13.1-win-x64-full.nupkg.d")));
		assert.ok(existsSync(join(root, "DreamFlutter-0.13.1-win-x64-full.nupkg")));
		assert.equal(dropLeftoverPackages(join(root, "missing")), 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
