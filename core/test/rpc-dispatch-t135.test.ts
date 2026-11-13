import assert from "node:assert/strict";
import { test } from "node:test";
import { expectRpcError, startContractHarness } from "./api-contract/harness.ts";

test("window RPC dispatch reports unavailable once shutdown begins", async t => {
	const api = await startContractHarness(t);
	let release!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	let entered!: () => void;
	const shuttingDown = new Promise<void>(resolve => { entered = resolve; });
	api.core.beforeShutdown(() => {
		entered();
		return blocked;
	});
	const stopped = new Promise<void>(resolve => api.core.onShutdown(resolve));
	try {
		assert.deepEqual(await api.call("core.shutdown"), { ok: true });
		await shuttingDown;
		for (const method of ["core.hello", "settings.get", "memory.save", "slot.open", "core.shutdown"]) {
			await expectRpcError(api.call(method), "unavailable");
		}
	} finally {
		release();
		await api.core.shutdown();
		await stopped;
	}
	await expectRpcError(api.call("core.hello"), "unavailable");
});

test("window RPC dispatch preserves busy responses from guarded maintenance writes", async t => {
	const api = await startContractHarness(t);
	const { slotId } = await api.call<{ slotId: string }>("slot.open", { cwd: api.workspace });
	const previousSettings = await api.call("settings.get");
	const at = api.events.length;
	api.core.maintenance = "fixture maintenance";
	try {
		await expectRpcError(api.call("slot.send", { slotId, record: { type: "prompt", message: "fixture" } }), "busy");
		await expectRpcError(api.call("skills.importUrl", { url: "http://127.0.0.1:1/fixture" }), "busy");
		await expectRpcError(api.call("storage.move"), "busy");
		await expectRpcError(api.call("storage.compactMemory"), "busy");
		assert.deepEqual(await api.call("settings.get"), previousSettings);
		assert.equal(api.faux.state.callCount, 0);
		assert.equal(api.events.slice(at).some(event => event.event === "storage.restarting" || event.event === "library.changed"), false);
	} finally {
		api.core.maintenance = undefined;
	}
	await expectRpcError(api.call("storage.move"), "bad_request");
});

test("the wait guard names a condition and reports elapsed time when it expires", async t => {
	const api = await startContractHarness(t);
	assert.equal(await api.waitFor(() => 0), 0);
	await assert.rejects(api.waitFor(() => false, 20, "a fixture event"),
		/waitFor timed out after \d+ ms \(limit 20 ms\) waiting for a fixture event/);
	await assert.rejects(api.waitFor(function fixtureWasReceived() { return false; }, 20),
		/waitFor timed out after \d+ ms \(limit 20 ms\) waiting for function fixtureWasReceived/);
});
