import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import LocalAttachments from "@deepseek-ai/dsh-attachment-local";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import Store, { SessionId } from "@deepseek-ai/dsh-session";
import * as persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { copyDshHistories } from "../src/dsh/backup.ts";
import { SystemPlugins } from "../src/dsh/system-plugins.ts";

test("fixed plugins expose the original service and release dependencies in shutdown order", async () => {
	const plugins = new SystemPlugins();
	const order: string[] = [];
	const gateway = { stop() { order.push("gateway"); } };
	const chat = { start() { assert.equal(plugins.context.get("dfGateway"), gateway); }, stop() { order.push("chat"); } };
	plugins.add("dfGateway", gateway, []);
	plugins.add("dfChat", chat, ["dfGateway"]);
	assert.throws(() => plugins.add("dfGateway", {}, []), /Duplicate/);
	await assert.rejects(plugins.start(chat), /requires dfGateway/);
	try {
		await plugins.start(gateway);
		await plugins.start(chat);
		assert.equal(plugins.context.get("dfChat"), chat);
		await plugins.stop(chat);
		await plugins.stop(gateway);
	} finally {
		await plugins.context.fiber.dispose();
	}
	assert.deepEqual(order, ["chat", "gateway"]);
});

test("restore recreates the official session under its new workspace and retains the referenced image", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "df-dsh-transfer-"));
	const source = join(tmp, "original"), backup = join(tmp, "backup"), target = join(tmp, "target");
	const sourceCtx = new Context(), targetCtx = new Context();
	const id = SessionId("included");
	try {
		for (const [ctx, root] of [[sourceCtx, source], [targetCtx, target]] as const) {
			await ctx.plugin(Store);
			await ctx.plugin(persistence, { root, compression: "none" });
			await ctx.plugin(LocalAttachments, { dshHome: root });
		}
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==", "base64");
		const ref = await sourceCtx.attachments.saveImage({ data: png, mediaType: "image/png" });
		const session = sourceCtx.sessions.create(id, { meta: { cwd: source } });
		const writer = await sourceCtx.sessionPersistence.create(session.header);
		try {
			session.append("user/message", createUserMessage({ source: { kind: "user" }, content: [
				{ type: "text", text: "带图的旧对话" }, { type: "image", attachment: ref },
			] }), { surfaceOp: "append" });
			await sourceCtx.sessions.flush(session);
		} finally { await writer.close(); }
		const excluded = sourceCtx.sessions.create(SessionId("excluded"));
		const excludedWriter = await sourceCtx.sessionPersistence.create(excluded.header);
		await excludedWriter.close();
		await copyDshHistories(source, backup, { ids: new Set([id]) });
		await copyDshHistories(backup, target, { mapCwd: () => target });
		const restored = await targetCtx.sessionPersistence.open(id, "read");
		try {
			assert.equal(restored.header.cwd, target);
			assert.deepEqual((await restored.read()).events.map(event => event.type), ["user/message"]);
			assert.deepEqual((await targetCtx.attachments.readImage(ref)).data, (await sourceCtx.attachments.readImage(ref)).data);
			assert.equal(await targetCtx.sessionPersistence.stat(SessionId("excluded")), undefined);
		} finally { await restored.close(); }
	} finally {
		await Promise.all([sourceCtx.fiber.dispose(), targetCtx.fiber.dispose()]);
		await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
	}
});
