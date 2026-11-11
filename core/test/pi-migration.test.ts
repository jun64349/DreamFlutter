import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { buildCore } from "../src/app.ts";
import { corePaths } from "../src/paths.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { PiMigration, type MigrationStep } from "../src/gateway/pi-migration.ts";
import { Gateway, type Transport } from "../src/gateway/gateway.ts";
import { readPiJson, snapshotFiles } from "../src/gateway/pi-config.ts";
import { piPresets } from "../src/gateway/pi-presets.ts";
import { redact } from "../src/security/redaction.ts";
import { recordedSessionModel } from "../src/pi/host.ts";

function fixture(failAt?: (step: MigrationStep) => void, automatic = false, transport?: Transport) {
	const dir = mkdtempSync(join(tmpdir(), "df-t66-")), agentDir = join(dir, "agent"), sessionDir = join(dir, "sessions"), workspace = join(dir, "workspace");
	for (const path of [agentDir, sessionDir, workspace]) mkdirSync(path, { recursive: true });
	const core = buildCore({ paths: corePaths(join(dir, "data")), agentDir, sessionDir, log: new Logger(), notifier: new RecordingNotifier(), piMigration: { automatic, failAt }, gatewayTransport: transport });
	const migration = core.module(PiMigration)!, gateway = core.module(Gateway)!;
	const put = (name: string, value: unknown) => writeFileSync(join(agentDir, name), JSON.stringify(value, null, 2));
	const provider = (key: string, extra = {}) => ({ api: "openai-completions", baseUrl: "https://example.invalid/v1", apiKey: key, models: [{ id: "model/a", contextWindow: 77000, maxTokens: 4096, input: ["text", "image"], reasoning: true, thinkingLevelMap: { off: "none", low: "low", high: "high" }, compat: { supportsStore: false } }], ...extra });
	const cleanup = async () => { await core.shutdown(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); };
	return { core, migration, gateway, dir, agentDir, sessionDir, workspace, put, provider, cleanup };
}

test("Pi migration preserves four credential kinds, metadata and cc-switch origin, rewrites every reference without executing commands", { skip: process.platform !== "win32" }, async () => {
	const t = fixture(); const marker = join(t.dir, "command-ran").replaceAll("\\", "/"), key = "T66_SYNTHETIC_PLAIN_KEY";
	const command = `!node -e "require('node:fs').writeFileSync('${marker}','ran');console.log('T66_SYNTHETIC_COMMAND')"`;
	const oauth = { type: "oauth", access: "T66_SYNTHETIC_OAUTH_ACCESS", refresh: "T66_SYNTHETIC_OAUTH_REFRESH", expires: 9999999999999 };
	try {
		t.put("models.json", { providers: { plain: t.provider(key, { headers: { Authorization: "Bearer T66_SYNTHETIC_HEADER" } }), command: t.provider(command), "cc-switch-env": t.provider("$T66_MISSING_ENV") } });
		t.put("auth.json", { openai: { type: "api_key", key: "T66_SYNTHETIC_BUILTIN_KEY" }, anthropic: oauth });
		t.put("settings.json", { defaultProvider: "plain", defaultModel: "model/a", theme: "unchanged" });
		t.core.settings.update({ defaultModel: "plain/model/a", auxModel: "command/model/a", visionModel: "plain/model/a", memoryModel: "cc-switch-env/model/a", fallbackModels: ["plain/model/a", "unknown/missing"], modelContextWindows: { "plain/model/a": 88000 } });
		t.core.db.run("INSERT INTO gateway_groups(id,name,entries,created_at) VALUES('g','group',?,1)", JSON.stringify([{ channel: "pi:plain", model: "model/a", priority: 3, weight: 2 }]));
		const status = await t.migration.migrate() as ReturnType<PiMigration["status"]>;
		assert.equal(status.status, "done", status.error); assert.equal(existsSync(marker), false);
		assert.equal(t.gateway.channels().filter((c) => c.source === "df").length, 4);
		const migrated = t.gateway.channels().find((c) => c.name === "plain")!, env = t.gateway.channels().find((c) => c.name === "cc-switch-env")!;
		assert.equal(env.origin, "cc-switch"); assert.equal(migrated.origin, "pi");
		const ref = `${migrated.provider}/model/a`;
		assert.equal(t.core.settings.get().defaultModel, ref); assert.equal(t.core.settings.get().visionModel, ref); assert.equal(t.core.settings.get().modelContextWindows[ref], 88000);
		assert.notEqual(t.core.settings.get().auxModel, "command/model/a"); assert.equal(t.core.settings.get().memoryModel, `${env.provider}/model/a`);
		assert.equal(t.core.settings.get().fallbackModels[1], "unknown/missing"); assert.ok(status.unresolved?.includes("unknown/missing"));
		assert.equal(t.gateway.groups()[0]!.entries[0]!.channel, migrated.id); assert.equal(t.gateway.groups()[0]!.entries[0]!.priority, 3);
		assert.equal(t.migration.resolveReference("plain/model/a", 0), ref);
		assert.equal(t.migration.resolveReference("plain/model/a"), "plain/model/a");
		const config = readPiJson(join(t.agentDir, "models.json")), serialized = readFileSync(join(t.agentDir, "models.json"), "utf8");
		assert.match(serialized, /由 DreamFlutter 渠道生成/); assert.ok(!serialized.includes(key)); assert.ok(!serialized.includes("T66_SYNTHETIC_HEADER")); assert.notEqual(redact(key), key);
		assert.equal(config.providers[env.provider].apiKey, "$T66_MISSING_ENV"); assert.equal(config.providers[t.gateway.channels().find((c) => c.name === "command")!.provider].apiKey, command);
		assert.deepEqual(readPiJson(join(t.agentDir, "auth.json")), { anthropic: oauth });
		assert.equal(readPiJson(join(t.agentDir, "settings.json")).defaultProvider, migrated.provider);
		assert.equal(config.providers[migrated.provider].models[0].contextWindow, 77000); assert.deepEqual(config.providers[migrated.provider].models[0].input, ["text", "image"]);
		assert.deepEqual(config.providers[migrated.provider].models[0].thinkingLevelMap, { off: "none", low: "low", high: "high" });
		assert.equal(config.providers[migrated.provider].models[0].compat.supportsStore, false);
		await assert.rejects(t.core.call("providers.setKey", { provider: "openai", apiKey: "T66_OTHER_SYNTHETIC" }), /渠道/);
		assert.ok(t.gateway.channels().some((c) => c.id === "pi:anthropic" && c.oauth));
		await t.migration.migrate(); assert.equal(t.gateway.channels().filter((c) => c.source === "df").length, 4);
	} finally { await t.cleanup(); }
});

for (const step of ["database_backup", "files_backup", "credentials", "channels", "references", "validation", "replace", "resolve", "commit"] as MigrationStep[]) {
	test(`Pi migration rolls back files, rows, references and completion marker after ${step}`, async () => {
		const t = fixture((at) => { if (at === step) throw new Error(`synthetic failure at ${step}`); });
		try {
			t.put("models.json", { providers: { original: t.provider("$T66_UNSET") } }); t.put("auth.json", {}); t.put("settings.json", { defaultProvider: "original", defaultModel: "model/a" });
			t.core.settings.update({ defaultModel: "original/model/a" });
			const before = ["models.json", "auth.json", "settings.json"].map((name) => readFileSync(join(t.agentDir, name), "utf8"));
			const result = await t.migration.migrate() as ReturnType<PiMigration["status"]>;
			assert.equal(result.status, "failed"); assert.equal(result.version, undefined); assert.ok(result.backup);
			assert.equal(t.core.db.get<{ n: number }>("SELECT COUNT(*) n FROM gateway_channels")!.n, 0); assert.equal(t.core.db.get<{ n: number }>("SELECT COUNT(*) n FROM pi_channel_map")!.n, 0);
			assert.equal(t.core.settings.get().defaultModel, "original/model/a");
			assert.deepEqual(["models.json", "auth.json", "settings.json"].map((name) => readFileSync(join(t.agentDir, name), "utf8")), before);
		} finally { await t.cleanup(); }
	});
}

test("Pi migration limits automatic failures to two attempts and allows explicit retry", async () => {
	const t = fixture(() => { throw new Error("synthetic unavailable"); }, true);
	try {
		await t.migration.start(); await t.migration.start();
		assert.equal(t.migration.status().attempts, 2);
		await t.migration.start(); assert.equal(t.migration.status().attempts, 2);
		await t.migration.migrate(false); assert.equal(t.migration.status().attempts, 2); assert.equal(t.migration.status().status, "failed");
	} finally { await t.cleanup(); }
});

test("Pi migration backs up external edits, imports only new providers and leaves source files untouched", async () => {
	const t = fixture();
	try {
		t.put("models.json", { providers: { original: t.provider("$T66_ENV") } }); await t.migration.migrate();
		const original = t.gateway.channels().find((c) => c.name === "original")!;
		writeFileSync(join(t.agentDir, "models.json"), "broken external edit"); assert.equal(t.migration.status().externalModified, true);
		await t.migration.regenerate(); assert.equal(t.migration.status().externalModified, false);
		assert.equal(readFileSync(t.migration.status().externalBackup!, "utf8"), "broken external edit");
		const imported = join(t.dir, "manual-import"); mkdirSync(imported);
		const source = JSON.stringify({ providers: { original: t.provider("$SHOULD_NOT_OVERWRITE", { baseUrl: "https://changed.invalid" }), newone: t.provider("$T66_OTHER_ENV", { api: "openai-responses" }) } });
		writeFileSync(join(imported, "models.json"), source);
		const status = await t.migration.migrate(false, imported) as ReturnType<PiMigration["status"]>;
		assert.equal(status.status, "done", status.error); assert.equal(t.gateway.channel(original.id)!.baseUrl, "https://example.invalid/v1");
		assert.equal(t.gateway.channels().filter((c) => c.source === "df").length, 2); assert.ok(status.results?.some((r) => r.provider === "original" && r.status.includes("跳过")));
		assert.equal(readFileSync(join(imported, "models.json"), "utf8"), source);
		await t.migration.migrate(false, imported); assert.equal(t.gateway.channels().filter((c) => c.source === "df").length, 2);
	} finally { await t.cleanup(); }
});

test("Pi generated configuration loads through public SDK and bundled CLI and old sessions retain the chosen model", { skip: process.platform !== "win32" }, async () => {
	const t = fixture();
	try {
		t.put("models.json", { providers: { original: t.provider("T66_SYNTHETIC_CLI_KEY") } });
		const session = SessionManager.create(t.workspace, t.sessionDir); session.appendModelChange("original", "model/a"); session.appendMessage({ role: "user", content: "synthetic history", timestamp: Date.now() });
		const file = session.getSessionFile()!, before = readFileSync(file, "utf8");
		const status = await t.migration.migrate() as ReturnType<PiMigration["status"]>; assert.equal(status.status, "done", status.error);
		assert.equal(readFileSync(file, "utf8"), before);
		const channel = t.gateway.channels().find((c) => c.name === "original")!;
		const runtime = await ModelRuntime.create({ authPath: join(t.agentDir, "auth.json"), modelsPath: join(t.agentDir, "models.json"), refreshOnCreate: false });
		assert.equal(runtime.getError(), undefined); assert.ok(runtime.getModel(channel.provider, "model/a"));
		const cli = spawnSync(process.execPath, ["node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", "--list-models", "model/a", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session"], { cwd: process.cwd(), env: { ...process.env, PI_CODING_AGENT_DIR: t.agentDir, PI_OFFLINE: "1" }, encoding: "utf8", timeout: 30000, windowsHide: true });
		assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, new RegExp(channel.provider)); assert.match(cli.stdout, /model\/a/); assert.ok(!cli.stdout.includes("T66_SYNTHETIC_CLI_KEY"));
		await t.core.openSlot({ slotId: "old", cwd: t.workspace, sessionFile: file });
		assert.equal(t.core.slots.get("old")!.session.model?.provider, channel.provider); assert.equal(t.core.slots.get("old")!.session.model?.id, "model/a");
	} finally { await t.cleanup(); }
});

test("0.8.3: a conversation that chose a model group reopens on it, and one whose group was deleted opens on the default model", { skip: process.platform !== "win32" }, async () => {
	const t = fixture();
	try {
		t.put("models.json", { providers: { original: t.provider("T66_SYNTHETIC_GROUP_KEY") } });
		t.core.db.run("INSERT INTO gateway_groups(id,name,entries,created_at) VALUES('g','group',?,1)", JSON.stringify([{ channel: "pi:original", model: "model/a", priority: 0, weight: 0 }]));
		const chose = (id: string) => { const s = SessionManager.create(t.workspace, t.sessionDir); s.appendModelChange("dreamflutter", id); s.appendMessage({ role: "user", content: "synthetic history", timestamp: Date.now() }); return s.getSessionFile()!; };
		const kept = chose("g"), gone = chose("deleted");
		const status = await t.migration.migrate() as ReturnType<PiMigration["status"]>; assert.equal(status.status, "done", status.error);
		await t.core.openSlot({ slotId: "kept", cwd: t.workspace, sessionFile: kept });
		assert.equal(t.core.slots.get("kept")!.session.model?.provider, "dreamflutter"); assert.equal(t.core.slots.get("kept")!.session.model?.id, "g");
		await t.core.openSlot({ slotId: "gone", cwd: t.workspace, sessionFile: gone });
		assert.ok(t.core.slots.get("gone"), "a conversation whose group is gone still opens (on the default model)");
		assert.notEqual(t.core.slots.get("gone")!.session.model?.provider, "dreamflutter");
	} finally { await t.cleanup(); }
});

test("Pi built-in channel presets use the public catalog and preserve model capabilities", () => {
	const openai = piPresets().find((p) => p.catalog === "openai")!; assert.ok(openai); assert.ok(openai.modelDetails.length > 0); assert.ok(openai.endpoints.some((e) => e.api === "openai-responses")); assert.ok(openai.modelDetails.some((m) => typeof m.contextWindow === "number"));
});

test("Pi channel request resolves command/environment references only when used and registers the resolved key for redaction", async () => {
	const seen: string[] = [];
	const t = fixture(undefined, false, (_model, _context, options) => {
		seen.push(options?.apiKey ?? "");
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("OK") }); stream.end(); });
		return stream;
	});
	const previous = process.env.DF_T66_CREDENTIAL;
	process.env.DF_T66_CREDENTIAL = "T66_SYNTHETIC_ENV_RESOLVED";
	try {
		t.put("models.json", { providers: { env: t.provider("$DF_T66_CREDENTIAL"), cmd: t.provider("!echo T66_SYNTHETIC_COMMAND_RESOLVED") } });
		await t.migration.migrate(); assert.deepEqual(seen, []);
		const runtime = await ModelRuntime.create({ authPath: join(t.agentDir, "auth.json"), modelsPath: join(t.agentDir, "models.json"), refreshOnCreate: false });
		t.gateway.installRuntime(runtime);
		for (const name of ["env", "cmd"]) {
			const channel = t.gateway.channels().find((c) => c.name === name)!;
			await runtime.completeSimple(runtime.getModel(channel.provider, "model/a")!, { messages: [] });
		}
		assert.deepEqual(seen, ["T66_SYNTHETIC_ENV_RESOLVED", "T66_SYNTHETIC_COMMAND_RESOLVED"]);
		for (const key of seen) assert.notEqual(redact(key), key);
	} finally { if (previous === undefined) delete process.env.DF_T66_CREDENTIAL; else process.env.DF_T66_CREDENTIAL = previous; await t.cleanup(); }
});

test("Pi restart recovers interrupted manual import without losing the already-completed first migration", async () => {
	const t = fixture(); let restarted: ReturnType<typeof buildCore> | undefined;
	try {
		t.put("models.json", { providers: { existing: t.provider("$T66_ENV") } }); await t.migration.migrate();
		const before = JSON.parse(t.core.db.get<{ value: string }>("SELECT value FROM pi_channel_migration WHERE id=1")!.value);
		const backup = join(t.dir, "interrupted-import"); snapshotFiles(t.agentDir, backup);
		writeFileSync(join(backup, "presence.json"), JSON.stringify(Object.fromEntries(["models.json", "auth.json", "settings.json"].map((f) => [f, existsSync(join(t.agentDir, f))]))));
		t.core.db.run("UPDATE pi_channel_migration SET value=? WHERE id=1", JSON.stringify({ ...before, status: "running", backup, rollbackState: before }));
		writeFileSync(join(t.agentDir, "models.json"), "partial synthetic replacement");
		await t.core.shutdown();
		restarted = buildCore({ paths: corePaths(join(t.dir, "data")), agentDir: t.agentDir, sessionDir: t.sessionDir, log: new Logger(), notifier: new RecordingNotifier() });
		const migration = restarted.module(PiMigration)!; await migration.start();
		assert.equal(migration.status().status, "done"); assert.equal(migration.status().attempts, before.attempts); assert.equal(migration.status().version, 1);
		assert.equal(restarted.db.get<{ n: number }>("SELECT COUNT(*) n FROM gateway_channels")!.n, 1); assert.equal(migration.status().externalBackup, before.externalBackup);
		await assert.rejects(restarted.call("providers.setKey", { provider: "openai", apiKey: "T66_SYNTHETIC" }), /渠道/);
		assert.ok(Object.keys(readPiJson(join(t.agentDir, "models.json")).providers).length === 1);
	} finally { await restarted?.shutdown(); await t.cleanup(); }
});

test("Pi restored history with an unmappable model remains unchanged and reports the reference instead of selecting another model", async () => {
	const t = fixture();
	try {
		t.put("models.json", { providers: { existing: t.provider("$T66_ENV") } }); await t.migration.migrate();
		const history = SessionManager.create(t.workspace, t.sessionDir); history.appendModelChange("missing-provider", "missing-model"); history.appendMessage({ role: "user", content: "synthetic history", timestamp: Date.now() });
		const path = history.getSessionFile()!, before = readFileSync(path, "utf8");
		await assert.rejects(t.core.openSlot({ slotId: "missing", cwd: t.workspace, sessionFile: path }), /原引用已保留/);
		assert.equal(readFileSync(path, "utf8"), before); assert.ok(t.migration.status().unresolved?.includes("missing-provider/missing-model"));
	} finally { await t.cleanup(); }
});

test("T70b restores the same model in 17 synthetic pre-migration histories copied after migration", async () => {
	const t = fixture();
	try {
		t.put("models.json", { providers: { original: t.provider("T70B_SYNTHETIC_COPY_KEY") } });
		const originals = Array.from({ length: 17 }, (_, i) => {
			const history = SessionManager.create(t.workspace, t.sessionDir);
			history.appendModelChange("original", "model/a"); history.appendMessage({ role: "user", content: `Synthetic copy ${i}`, timestamp: Date.now() });
			return { path: history.getSessionFile()!, content: readFileSync(history.getSessionFile()!, "utf8") };
		});
		const status = await t.migration.migrate() as ReturnType<PiMigration["status"]>; assert.equal(status.status, "done", status.error);
		const channel = t.gateway.channels().find((c) => c.name === "original")!;
		for (const [i, original] of originals.entries()) {
			const copy = join(t.sessionDir, `t70b-copy-${i}.jsonl`); copyFileSync(original.path, copy);
			assert.equal(readFileSync(copy, "utf8"), original.content);
			await t.core.openSlot({ slotId: `copy-${i}`, cwd: t.workspace, sessionFile: copy });
			const model = t.core.slots.get(`copy-${i}`)!.session.model!;
			assert.equal(model.provider, channel.provider); assert.equal(model.id, "model/a"); assert.equal(model.contextWindow, 77000);
			await t.core.closeSlot(`copy-${i}`);
			assert.equal(readFileSync(original.path, "utf8"), original.content);
		}
	} finally { await t.cleanup(); }
});

test("T70b manual imports date each alias separately and never extend existing aliases to newer references", async () => {
	const t = fixture();
	try {
		t.put("models.json", { providers: { original: t.provider("T70B_SYNTHETIC_INITIAL") } });
		const initial = await t.migration.migrate() as ReturnType<PiMigration["status"]>; assert.equal(initial.status, "done", initial.error);
		const newerReferenceTime = initial.at!;
		const imported = join(t.dir, "manual-history-import"); mkdirSync(imported);
		writeFileSync(join(imported, "models.json"), JSON.stringify({ providers: { added: t.provider("T70B_SYNTHETIC_IMPORT") } }));
		const result = await t.migration.migrate(false, imported) as ReturnType<PiMigration["status"]>; assert.equal(result.status, "done", result.error);
		const row = t.core.db.get<{ imported_at: number }>("SELECT imported_at FROM pi_channel_map WHERE provider='added'")!;
		const added = t.gateway.channels().find((c) => c.name === "added")!;
		assert.equal(t.migration.resolveReference("added/model/a", row.imported_at - 1), `${added.provider}/model/a`);
		assert.equal(t.migration.resolveReference("added/model/a", row.imported_at), "added/model/a");
		assert.equal(t.migration.resolveReference("added/model/a", row.imported_at + 1), "added/model/a");
		assert.equal(t.migration.resolveReference("original/model/a", newerReferenceTime), "original/model/a");
		assert.equal(t.migration.resolveReference("original/model/a"), "original/model/a");
		assert.equal(t.migration.resolveReference("original/model/a", Number.NaN), "original/model/a");
	} finally { await t.cleanup(); }
});

test("T70b persisted aliases do not translate history without a migration completion marker", async () => {
	const t = fixture(); let restarted: ReturnType<typeof buildCore> | undefined;
	try {
		t.put("models.json", { providers: { original: t.provider("T70B_SYNTHETIC_MARKER") } }); await t.migration.migrate();
		assert.notEqual(t.migration.resolveReference("original/model/a", 0), "original/model/a");
		t.core.db.run("DELETE FROM pi_channel_migration"); await t.core.shutdown();
		restarted = buildCore({ paths: corePaths(join(t.dir, "data")), agentDir: t.agentDir, sessionDir: t.sessionDir, log: new Logger(), notifier: new RecordingNotifier(), piMigration: { automatic: false } });
		assert.ok(restarted.db.get("SELECT provider FROM pi_channel_map WHERE provider='original'"));
		assert.equal(restarted.module(PiMigration)!.resolveReference("original/model/a", 0), "original/model/a");
	} finally { await restarted?.shutdown(); await t.cleanup(); }
});
