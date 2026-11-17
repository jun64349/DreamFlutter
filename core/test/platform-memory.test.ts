// The platform's starting memory (user 2026-11-17): written once into a fresh data
// folder as ordinary global background memories; editable, deletable, never re-added.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryModule } from "../src/modules/memory.ts";
import { PLATFORM_DEFAULTS } from "../src/memory/platform-defaults.ts";
import { startTestCore } from "./harness.ts";

type Item = { id: string; content: string; scope: string; kind: string; status: string };
const isPlatform = (m: Item) => PLATFORM_DEFAULTS.includes(m.content);

test("a fresh data folder starts with the platform memory, visible to the workbench and 蝶君", async () => {
	let t = await startTestCore(undefined, { platformMemory: true });
	try {
		const items = (await t.core.call("memory.list", { cwd: t.workspace })) as Item[];
		assert.equal(items.filter(isPlatform).length, PLATFORM_DEFAULTS.length);
		for (const m of items.filter(isPlatform)) { assert.equal(m.scope, "global"); assert.equal(m.kind, "background"); assert.equal(m.status, "active"); }
		assert.ok(PLATFORM_DEFAULTS.some((c) => c.includes("蝶君")) && PLATFORM_DEFAULTS.some((c) => /MCP/.test(c)) && PLATFORM_DEFAULTS.some((c) => c.includes("内置技能")));
		// 蝶君 reads global memories too.
		const memory = t.core.module(MemoryModule)!;
		const butterflySet = memory.scopesFor(t.core.paths.butterflyDir);
		assert.equal(butterflySet.butterfly, true);
		const forButterfly = (await t.core.call("memory.list", { cwd: t.core.paths.butterflyDir })) as Item[];
		assert.equal(forButterfly.filter(isPlatform).length, PLATFORM_DEFAULTS.length);
		// Editable and deletable like any other memory; a deleted one is not added back.
		const [first, second] = items.filter(isPlatform);
		await t.core.call("memory.update", { id: first!.id, content: "DreamFlutter 是我的桌面助手（我改过）" });
		// The memory page's delete.
		await t.core.call("memory.setStatus", { id: second!.id, status: "forgotten" });
		t = await t.reopen();
		const after = (await t.core.call("memory.list", { cwd: t.workspace })) as Item[];
		assert.equal(after.filter(isPlatform).length, PLATFORM_DEFAULTS.length - 2);
		assert.ok(after.some((m) => m.content === "DreamFlutter 是我的桌面助手（我改过）"));
		assert.equal(after.some((m) => m.content === second!.content), false);
	} finally {
		await t.cleanup();
	}
});

test("a data folder already in use gets no platform memory, and tests default to none", async () => {
	const plain = await startTestCore();
	try {
		assert.equal(((await plain.core.call("memory.list", {})) as Item[]).length, 0, "off unless the app asks for it");
		await plain.core.call("memory.save", { content: "我喜欢简短的回答", scope: "global" });
	} finally {
		await plain.core.shutdown();
	}
	const used = await startTestCore(plain.dir, { platformMemory: true });
	try {
		const items = (await used.core.call("memory.list", {})) as Item[];
		assert.equal(items.filter(isPlatform).length, 0);
		assert.equal(items.length, 1);
	} finally {
		await used.cleanup();
	}
});
