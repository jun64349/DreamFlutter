import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import { inventory, prepareDirectoryCopy } from "../src/storage/copy.ts";
import { decodeWsl, officialMoveArguments, supportsOfficialMove } from "../src/storage/wsl.ts";

describe("relocation copy preparation, with no live data or WSL operations", () => {
	let root: string; let source: string; let target: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "df-relocate-")); source = join(root, "old"); target = join(root, "new");
		mkdirSync(source); mkdirSync(join(source, "空目录")); writeFileSync(join(source, "key.dpapi"), Buffer.from([0, 255, 12, 35]));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	const options = () => ({ source, target, stopWriters: async () => {}, backup: async () => "test-backup" });
	it("stops then backs up, copies encrypted bytes unchanged, verifies counts/sizes/hashes, preserves source", async () => {
		const order: string[] = [];
		const before = inventory(source);
		const result = await prepareDirectoryCopy({ ...options(), stopWriters: async () => { order.push("stop"); }, backup: async () => { order.push("backup"); return "test-backup"; } });
		assert.deepEqual(order, ["stop", "backup"]); assert.deepEqual(result.manifest, before);
		assert.deepEqual(inventory(source), before); assert.deepEqual(inventory(target), before);
	});
	it("backup or SQLite integrity failure never switches or changes the source", async () => {
		const before = inventory(source);
		await assert.rejects(prepareDirectoryCopy({ ...options(), backup: async () => { throw new Error("backup failed"); } }), /backup failed/);
		assert.equal(existsSync(target), false); assert.deepEqual(inventory(source), before);
		writeFileSync(join(source, "core.db"), "broken database");
		await assert.rejects(prepareDirectoryCopy({ ...options(), databases: ["core.db"] }));
		assert.equal(existsSync(target), false); assert.equal(readFileSync(join(source, "core.db"), "utf8"), "broken database");
	});
	it("refuses existing targets, overlapping paths, escaping DB paths and junctions", async () => {
		mkdirSync(target); writeFileSync(join(target, "keep"), "untouched");
		await assert.rejects(prepareDirectoryCopy(options())); assert.equal(readFileSync(join(target, "keep"), "utf8"), "untouched");
		await assert.rejects(prepareDirectoryCopy({ ...options(), target: join(source, "child") }), /互相包含/);
		await assert.rejects(prepareDirectoryCopy({ ...options(), target: join(root, "another"), databases: ["../outside.db"] }), /超出/);
		symlinkSync(target, join(source, "link"), process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(prepareDirectoryCopy({ ...options(), target: join(root, "another") }), /链接/);
		assert.equal(readFileSync(join(target, "keep"), "utf8"), "untouched");
	});
});

it("WSL official move is gated on capabilities and never falls back to VHD copy/unregister", () => {
	const help = "--manage <Distro> <Options...>\n  --move <Location>";
	assert.equal(supportsOfficialMove(decodeWsl(Buffer.from(help, "utf16le"))), true);
	assert.deepEqual(officialMoveArguments(help, "DreamFlutter-Test", "E:\\temp\\sandbox"), ["--manage", "DreamFlutter-Test", "--move", "E:\\temp\\sandbox"]);
	assert.throws(() => officialMoveArguments("--export --import", "test", "path"), /不支持/);
});
