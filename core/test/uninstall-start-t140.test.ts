import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { Client, Core, Params } from "../src/core.ts";
import { registerUninstall, type UninstallLauncher } from "../src/uninstall/index.ts";

function fixture(installed: boolean, launcher: UninstallLauncher = () => {}) {
	const dir = mkdtempSync(join(tmpdir(), "df-uninstall-start-"));
	const current = join(dir, "version"), dataDir = join(dir, "data");
	mkdirSync(join(current, "app"), { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	if (installed) {
		writeFileSync(join(current, "sq.version"), "1");
		writeFileSync(join(current, "app", "dreamflutter_update.exe"), "fixture");
		writeFileSync(join(dir, "Update.exe"), "fixture");
	}
	const client = {} as Client;
	const methods = new Map<string, (params: Params, client?: Client) => unknown>();
	let busy = false;
	const core = {
		paths: { dataDir }, clients: new Set([client]), maintenance: undefined as string | undefined,
		busySlots: () => busy ? [{}] : [], db: { get: () => undefined }, shutdown: async () => {},
		register: (method: string, handler: (params: Params, caller?: Client) => unknown) => { methods.set(method, handler); },
	} as unknown as Core;
	registerUninstall(core, current, { launcher, platform: "win32" });
	const call = async (params: Params, caller?: Client) => await methods.get("uninstall.start")!(params, caller);
	return { dir, core, client, call, setBusy: (value: boolean) => { busy = value; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

it("uses only the injected launcher, writes or removes the preserve marker, and passes both PIDs", async () => {
	for (const keepData of [true, false]) {
		const calls: unknown[][] = [];
		const t = fixture(true, (...args) => { calls.push(args); });
		try {
			const marker = join(t.dir, "data", "uninstall-keep-data");
			if (!keepData) writeFileSync(marker, "1\n");
			assert.deepEqual(await t.call({ keepData, windowPid: 4242 }, t.client), { started: true });
			assert.equal(existsSync(marker), keepData);
			if (keepData) assert.equal(readFileSync(marker, "utf8").trim(), "1");
			assert.deepEqual(calls, [[join(t.dir, "Update.exe"), 4242, process.pid]]);
		} finally { t.cleanup(); }
	}
});

it("rejects noninstallations, running work, invalid input and nonwindow calls", async () => {
	const portable = fixture(false);
	try {
		await assert.rejects(portable.call({ keepData: true, windowPid: 3 }, portable.client), { code: "unavailable" });
		await assert.rejects(portable.call({ keepData: true, windowPid: 3 }), { code: "forbidden" });
	} finally { portable.cleanup(); }
	const installed = fixture(true, () => { throw new Error("launcher should not run"); });
	try {
		installed.core.maintenance = "test";
		await assert.rejects(installed.call({ keepData: true, windowPid: 3 }, installed.client), { code: "busy" });
		installed.core.maintenance = undefined;
		installed.setBusy(true);
		await assert.rejects(installed.call({ keepData: true, windowPid: 3 }, installed.client), { code: "busy" });
		installed.setBusy(false);
		await assert.rejects(installed.call({ keepData: true, windowPid: 0 }, installed.client), { code: "bad_request" });
		await assert.rejects(installed.call({ keepData: true, windowPid: 3 }, installed.client), { code: "unavailable" });
		assert.equal(existsSync(join(installed.dir, "data", "uninstall-keep-data")), false);
	} finally { installed.cleanup(); }
});

it("rejects a second start while the first launcher is pending and permits retry after failure", async () => {
	let release!: () => void;
	let reject!: (error: Error) => void;
	const gate = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
	let launches = 0;
	const t = fixture(true, () => { launches++; return launches === 1 ? gate : undefined; });
	try {
		const first = t.call({ keepData: true, windowPid: 100 }, t.client);
		assert.equal(launches, 1);
		await assert.rejects(t.call({ keepData: false, windowPid: 101 }, t.client), { code: "busy" });
		assert.equal(launches, 1);
		assert.equal(readFileSync(join(t.dir, "data", "uninstall-keep-data"), "utf8").trim(), "1");
		reject(new Error("synthetic launch failure"));
		await assert.rejects(first, { code: "unavailable" });
		assert.equal(existsSync(join(t.dir, "data", "uninstall-keep-data")), false);
		assert.deepEqual(await t.call({ keepData: false, windowPid: 102 }, t.client), { started: true });
		assert.equal(launches, 2);
	} finally { release(); t.cleanup(); }
});
