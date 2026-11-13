import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { mintDocument } from "../../src/cards/document.ts";
import { CardsModule } from "../../src/cards/cards.ts";
import { expectKeys, expectRpcError, startContractHarness } from "./harness.ts";

const fields = ["id", "title", "cwd", "sessionFile", "toolCallId", "origin", "resident", "pinnedFrom", "epoch", "version", "height", "snapshotAt", "createdAt", "updatedAt", "bindings", "malformed", "preferredWidth", "specVersion", "specSupported", "hasAssets"];

test("card CRUD, grants, snapshots, events, tickets, and loopback routes", async t => {
	const api = await startContractHarness(t);
	const path = join(api.dir, "fixture.card.html");
	writeFileSync(path, mintDocument("<p>Contract fixture</p>", "测试卡片", { value: 1 }));
	await expectRpcError(api.call("cards.import", { path: join(api.dir, "absent") }), "not_found");
	const start = api.events.length;
	const imported = await api.call("cards.import", { path, cwd: api.workspace });
	expectKeys(imported, fields);
	const id = imported.id as string;
	assert.deepEqual(await api.call("cards.get", { id }), imported);
	assert.deepEqual(await api.call("cards.list", { cwd: api.workspace }), [imported]);
	await expectRpcError(api.call("cards.get", { id: "absent" }), "not_found");
	const source = await api.call("cards.source", { id });
	expectKeys(source, ["html", "state"]);
	assert.deepEqual(source.state, { value: 1 });

	const opened = await api.call<{ url: string; ticket: string }>("cards.open", { id });
	expectKeys(opened, ["url", "ticket"]);
	const shell = await fetch(opened.url);
	assert.equal(shell.status, 200);
	assert.equal(shell.headers.get("cache-control"), "no-store");
	const src = (await shell.text()).match(/<iframe id="card" sandbox="allow-scripts" src="([^"]+)"/)![1]!;
	const card = await fetch(api.origin + src);
	assert.equal(card.status, 200);
	assert.ok(card.headers.get("content-security-policy"));
	assert.match(await card.text(), /Contract fixture/);
	assert.equal((await fetch(api.origin + "/shell/invalid")).status, 404);
	assert.equal((await fetch(api.origin + "/cards/invalid/t/invalid/index.html")).status, 404);
	assert.equal((await fetch(api.origin + "/render/renderer.html")).status, 200);
	assert.equal((await fetch(api.origin + "/render/unknown")).status, 404);

	const unit = { id, kind: "net", subject: "example.invalid", scope: "always" };
	assert.deepEqual(await api.call("cards.grant", unit), { ok: true });
	assert.deepEqual(await api.call("cards.grants", { id }), [{ kind: "net", subject: "example.invalid", scope: "always" }]);
	assert.deepEqual(await api.call("cards.revoke", unit), { ok: true });
	assert.deepEqual(await api.call("cards.grants", { id }), []);
	assert.deepEqual(await api.call("cards.snapshot", { id }), { png: null });
	const png = Buffer.from("fixture snapshot").toString("base64");
	assert.deepEqual(await api.call("cards.saveSnapshot", { id, png, height: 200 }), { ok: true });
	assert.deepEqual(await api.call("cards.snapshot", { id }), { png });
	assert.deepEqual(await api.call("cards.setHeight", { id, height: 250 }), { ok: true });
	assert.equal((await api.call<{ height: number }>("cards.get", { id })).height, 250);
	for (const tool of await api.call<unknown[]>("cards.tools")) expectKeys(tool, ["tool", "label"]);
	const bad = await api.call("cards.request", { id, capability: "not-a-capability" });
	expectKeys(bad, ["ok", "result", "error", "code?"]);
	assert.equal(bad.ok, false);
	assert.deepEqual(await api.call("cards.events", { id }), []);
	expectKeys(await api.call("cards.exportName", { id }), ["name"]);
	const output = join(api.dir, "export.card.html");
	assert.deepEqual(await api.call("cards.export", { id, path: output }), { path: output });

	const slot = await api.call<{ sessionFile: string }>("slot.open", { slotId: "card-fixture", cwd: api.workspace });
	const sessionFile = slot.sessionFile;
	api.respond(fauxAssistantMessage("Fixture ready"));
	const beforePrompt = api.events.length;
	await api.call("slot.send", { slotId: "card-fixture", record: { type: "prompt", message: "Prepare this fixture" } });
	await api.waitForEvent("slot.record", e => (e.record as { type?: string }).type === "agent_settled", beforePrompt);
	const original = api.core.module(CardsModule)!.mint({ title: "会话测试", code: "<p>Fixture</p>", cwd: api.workspace, sessionFile });
	const emittedFrom = api.events.length;
	const result = await api.call("cards.request", { id: original.id, capability: "emit", payload: { name: "fixture-click", payload: { value: 2 } } });
	assert.deepEqual(result, { ok: true, result: { delivered: true } });
	const emitted = await api.waitForEvent("card.emitted", undefined, emittedFrom);
	expectKeys(emitted, ["event", "cardId", "title", "sessionFile", "name", "payload", "at"]);
	assert.deepEqual({ ...emitted, at: 0 }, { event: "card.emitted", cardId: original.id, title: "会话测试", sessionFile, name: "fixture-click", payload: { value: 2 }, at: 0 });
	assert.equal(api.events.slice(emittedFrom).filter(event => event.event === "card.emitted").length, 1);
	const pinned = await api.call("cards.pin", { id: original.id, cwd: api.workspace });
	expectKeys(pinned, fields);
	assert.equal(pinned.resident, true);
	assert.deepEqual(await api.call("cards.forgetSession", { sessionFile }), { removed: 1 });
	assert.deepEqual(await api.call("cards.delete", { id }), { ok: true });
	const updates = api.events.slice(start).filter(event => event.event.startsWith("card."));
	assert.equal(updates[0]?.event, "card.changed");
	assert.equal(updates.at(-1)?.event, "card.removed");
	assert.equal(updates.filter(event => event.event === "card.removed" && event.cardId === id).length, 1);
	expectKeys(updates[0], ["event", "card"]);
	expectKeys(updates.at(-1), ["event", "cardId"]);
});

test("card RPCs with required fields reject missing arguments on the wire", async t => {
	const api = await startContractHarness(t);
	for (const method of ["delete", "events", "export", "exportName", "forgetSession", "get", "grant", "grants", "import", "open", "pin", "request", "revoke", "saveSnapshot", "snapshot"]) {
		await expectRpcError(api.call("cards." + method), "bad_request");
	}
	for (const method of ["delete", "export", "exportName", "get", "grant", "grants", "open", "pin", "revoke", "saveSnapshot", "setHeight", "snapshot", "source"]) {
		await expectRpcError(api.call("cards." + method, { id: "c_missing000", kind: "net", subject: "example.invalid", png: "AA==", path: join(api.dir, "missing.html") }), "not_found");
	}
	await expectRpcError(api.call("cards.import", { path: join(api.dir, "missing.card.html") }), "not_found");
	const empty = join(api.dir, "empty-card");
	mkdirSync(empty);
	await expectRpcError(api.call("cards.import", { path: empty }), "invalid_card");
	const large = join(api.dir, "large.card.html");
	writeFileSync(large, mintDocument("<p>Fixture</p>", "Large card", { text: "x".repeat(66_000) }));
	await expectRpcError(api.call("cards.import", { path: large }), "too_large");
});
