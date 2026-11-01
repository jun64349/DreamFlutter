import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { CardsModule, type Card, type PermissionQuestion, type RequestAnswer } from "../src/cards/cards.ts";
import { bindingsDigest, mintDocument, parseManifest, renderServed, scanSecrets, validatePackage } from "../src/cards/document.ts";
import { readZip, writeZip } from "../src/cards/zip.ts";
import { convertDocument, docxText, xlsxText } from "../src/modules/documents.ts";
import { imageHash } from "../src/modules/vision.ts";
import { startServer } from "../src/server.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

const manifest = (bindings: Record<string, unknown>) => `<script type="application/json" data-card-manifest>${JSON.stringify({ toolBindings: bindings })}</script>`;

describe("card documents (host side)", () => {
	it("mints a complete document: title, own CSP, spec written, opening state burned in", () => {
		const html = mintDocument(`${manifest({ w: { tool: "time.now" } })}<p>hi</p>`, "天气<卡>", { temp: 21 });
		assert.match(html, /^<!DOCTYPE html>/);
		assert.match(html, /<title>天气&lt;卡&gt;<\/title>/);
		assert.match(html, /http-equiv="Content-Security-Policy"/);
		assert.match(html, /"spec": "1.0"/);
		assert.match(html, /data-card-state>\n\{"temp":21\}/);
		assert.deepEqual(validatePackage(html, "{}"), []);
	});

	it("serves through the reference injection: runtime before the card's scripts, own CSP replaced, sizing marked", () => {
		const html = mintDocument("<script>run()</script>", "卡", undefined);
		const served = renderServed(html, { csp: "default-src 'none'", theme: { "--fg": "#123456", "--bad": "url(x)" }, sizing: "content" });
		assert.ok(served.indexOf("showcard reference injection layer") < served.indexOf("run()"));
		assert.equal((served.match(/http-equiv="Content-Security-Policy"/g) ?? []).length, 1);
		assert.match(served, /content="default-src &#39;none&#39;"|content="default-src 'none'"/);
		assert.match(served, /"TIMEOUT_MS": 180000/);
		assert.match(served, /<html lang="zh-CN" data-card-sizing="content">/);
		assert.match(served, /--fg:#123456/);
		assert.doesNotMatch(served, /url\(x\)/);
	});

	it("digests only toolBindings, ignoring key order", () => {
		const a = parseManifest(manifest({ a: { tool: "x", input: { b: 1, a: 2 } } })).raw;
		const b = parseManifest('<script type="application/json" data-card-manifest>{"display":{"preferredWidthPx":400},"toolBindings":{"a":{"input":{"a":2,"b":1},"tool":"x"}}}</script>').raw;
		assert.equal(bindingsDigest(a), bindingsDigest(b));
		assert.equal(parseManifest('<script type="application/json" data-card-manifest>{"display":{"preferredWidthPx":384.4}}</script>').preferredWidth, 384);
		assert.equal(parseManifest('<script type="application/json" data-card-manifest>{"display":{"preferredWidthPx":2000}}</script>').preferredWidth, null);
	});

	it("validates: whole document, natural title, legal JSON, no secrets (never echoed)", () => {
		assert.match(validatePackage("<p>x</p>", "{}").join(), /完整的 HTML/);
		assert.match(validatePackage("<!DOCTYPE html><html><head><title>q4_revenue</title></head><body></body></html>", "{}").join(), /标识符/);
		assert.match(validatePackage(`<!DOCTYPE html><html><head><title>好</title>${manifest({}).replace("}}", "")}</head><body></body></html>`, "{}").join(), /manifest/);
		const hits = scanSecrets("key = sk-abcdefghijklmnopqrstuvwxyz123456");
		assert.equal(hits.length, 1);
		assert.doesNotMatch(hits[0]!, /abcdefghij/);
	});

	it("round-trips zip archives", () => {
		const zip = writeZip([
			{ name: "index.html", data: Buffer.from("<html>卡片</html>") },
			{ name: "assets/a.txt", data: Buffer.from("x".repeat(5000)) },
		]);
		const entries = readZip(zip);
		assert.deepEqual(entries.map((e) => e.name), ["index.html", "assets/a.txt"]);
		assert.equal(entries[0]!.data.toString(), "<html>卡片</html>");
		assert.equal(entries[1]!.data.length, 5000);
	});

	it("v0.2 review: refuses stored entries whose sizes disagree (a forged size would dodge the total)", () => {
		// "index.html" is stored (too short to deflate): forge its central-directory size to 0.
		const zip = writeZip([{ name: "index.html", data: Buffer.from("<p>x</p>") }]);
		const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
		assert.equal(zip.readUInt16LE(central + 10), 0, "the entry is stored");
		zip.writeUInt32LE(0, central + 24);
		assert.throws(() => readZip(zip), /大小不一致/);
	});
});

describe("cards", () => {
	let t: TestCore;
	let api: Server;
	let http: { port: number; close(): Promise<void> };
	let cards: CardsModule;

	before(async () => {
		api = createServer((req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization ?? null, temp: 21 }));
		});
		await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
	});
	after(() => api.close());

	beforeEach(async () => {
		t = await startTestCore();
		http = await startServer(t.core, { port: 0, token: "test-token" });
		cards = t.core.module(CardsModule)!;
	});
	afterEach(async () => {
		await http.close();
		await t.cleanup();
	});

	const apiUrl = (path: string) => `http://127.0.0.1:${(api.address() as AddressInfo).port}${path}`;
	const ask = (r: RequestAnswer): PermissionQuestion => {
		assert.ok("ask" in r, JSON.stringify(r));
		return r.ask;
	};
	const envelope = (r: RequestAnswer) => {
		assert.ok(!("ask" in r), JSON.stringify(r));
		return r;
	};
	const request = (id: string, capability: string, payload: unknown, extra: Record<string, unknown> = {}) =>
		t.core.call("cards.request", { id, capability, payload, ...extra }) as Promise<RequestAnswer>;

	let slotCount = 0;
	async function showCard(args: Record<string, unknown>): Promise<{ card: Card; toolText: string }> {
		const slotId = `s${++slotCount}`;
		await t.core.call("slot.open", { slotId, cwd: t.workspace }, t.client);
		let toolText = "";
		const capture: FauxResponseFactory = (context) => {
			toolText = JSON.stringify(context.messages.findLast((m) => m.role === "toolResult"));
			return fauxAssistantMessage("好了");
		};
		t.respond(fauxAssistantMessage([fauxToolCall("show_card", args as never)], { stopReason: "toolUse" }), capture);
		await t.send(slotId, { id: "p", type: "prompt", message: "做一张卡片" });
		await t.waitFor(() => settledCount(t.records(slotId)) >= 1);
		const card = ((await t.core.call("cards.list", {})) as Card[])[0]!;
		return { card, toolText };
	}

	it("the agent shows a card without approval; the window opens it through a ticket with a per-instance CSP", async () => {
		t.core.settings.update({ approvalMode: "all" });
		const { card, toolText } = await showCard({ title: "计数器", html: '<button id="b">+1</button>', state: { n: 1 } });
		assert.equal(card.title, "计数器");
		assert.equal(card.resident, false);
		assert.ok(card.sessionFile);
		assert.match(toolText, new RegExp(`card_id: ${card.id}`));

		const { url } = (await t.core.call("cards.open", { id: card.id, theme: { "--accent": "#b0603a" } })) as { url: string };
		const shell = await fetch(url);
		assert.match(shell.headers.get("content-security-policy")!, /script-src 'nonce-/);
		const src = (await shell.text()).match(/<iframe id="card" sandbox="allow-scripts" src="([^"]+)"/)![1]!;
		assert.match(src, new RegExp(`^/cards/${card.id}/t/[A-Za-z0-9_-]+/index\\.html$`));
		const doc = await fetch(`http://127.0.0.1:${http.port}${src}`);
		const csp = doc.headers.get("content-security-policy")!;
		assert.match(csp, /sandbox allow-scripts/);
		assert.match(csp, /connect-src 'none'/);
		assert.match(csp, new RegExp(`img-src data: blob: http://127\\.0\\.0\\.1:${http.port}${src.replace("index.html", "")}`));
		assert.match(await doc.text(), /--accent:#b0603a/);

		// Another instance of the same card gets its own scope.
		const second = (await t.core.call("cards.open", { id: card.id, theme: {} })) as { url: string };
		assert.notEqual(second.url, url);
		// Unknown tickets, mismatched card ids, traversal, other Host names.
		assert.equal((await fetch(`http://127.0.0.1:${http.port}/shell/nonexistentticket`)).status, 404);
		assert.equal((await fetch(`http://127.0.0.1:${http.port}${src.replace(card.id, "c_0000000000000000")}`)).status, 404);
		assert.equal((await fetch(`http://127.0.0.1:${http.port}${src.replace("index.html", "..%2F..%2Fcore.db")}`)).status, 404);
		const rebinding = await new Promise<number>((resolve) => {
			const req = httpRequest({ host: "127.0.0.1", port: http.port, path: src, headers: { host: "evil.example" } }, (res) => resolve(res.statusCode!));
			req.end();
		});
		assert.equal(rebinding, 421);
	});

	it("asks per (kind, subject) with the complete call; once / session / always; revocable; re-checked; voided by a new declaration", async () => {
		cards.allowLocalNetwork = true;
		const html = `${manifest({ w: { tool: "fetch.request", input: { hosts: ["127.0.0.1"], headers: { Authorization: "x", "x-ok": "1" } } }, t: { tool: "time.now" }, x: { tool: "shell.magic" }, open: { tool: "fetch.request" } })}<p>w</p>`;
		const { card } = await showCard({ title: "天气", html });
		assert.deepEqual(card.bindings.find((b) => b.id === "w")!.units, [{ kind: "net", subject: "127.0.0.1" }]);
		assert.equal(card.bindings.find((b) => b.id === "x")!.known, false);

		assert.equal(envelope(await request(card.id, "invoke", { bindingId: "t" })).ok, true, "time.now asks nothing");
		assert.equal(envelope(await request(card.id, "invoke", { bindingId: "x" })).code, "CARD_HOST_TOOL_UNAVAILABLE");
		assert.equal(envelope(await request(card.id, "invoke", { bindingId: "open", input: { url: apiUrl("/") } })).code, "CARD_HOST_TOOL_UNAVAILABLE", "no declared hosts");
		assert.equal(envelope(await request(card.id, "invoke", { bindingId: "w", input: { url: "http://other.example/" } })).code, "CARD_HOST_TOOL_UNAVAILABLE", "undeclared host");

		const payload = { bindingId: "w", input: { url: apiUrl("/now") } };
		const q = ask(await request(card.id, "invoke", payload));
		assert.deepEqual([q.kind, q.subject, q.tool], ["net", "127.0.0.1", "fetch.request"]);
		assert.match(q.call, /^GET http:\/\/127\.0\.0\.1:\d+\/now$/);
		const answer = (grant: string) => ({ answer: { grant, epoch: q.epoch, digest: q.digest } });
		assert.equal(envelope(await request(card.id, "invoke", payload, answer("deny"))).code, "CARD_HOST_TOOL_UNAVAILABLE");

		const once = envelope(await request(card.id, "invoke", payload, answer("once")));
		assert.equal((once.result.json as { temp: number }).temp, 21);
		assert.equal((once.result.json as { auth: unknown }).auth, null, "sensitive headers stripped");
		ask(await request(card.id, "invoke", payload));

		envelope(await request(card.id, "invoke", payload, answer("session")));
		assert.equal(envelope(await request(card.id, "invoke", payload)).ok, true);
		assert.deepEqual(await t.core.call("cards.grants", { id: card.id }), [{ kind: "net", subject: "127.0.0.1", scope: "session" }]);
		await t.core.call("cards.revoke", { id: card.id, kind: "net", subject: "127.0.0.1" });
		ask(await request(card.id, "invoke", payload));

		envelope(await request(card.id, "invoke", payload, answer("always")));
		const { url } = (await t.core.call("cards.open", { id: card.id, theme: {} })) as { url: string };
		const src = (await (await fetch(url)).text()).match(/src="([^"]+)"/)![1]!;
		assert.match((await fetch(`http://127.0.0.1:${http.port}${src}`)).headers.get("content-security-policy")!, /connect-src https:\/\/127\.0\.0\.1/, "direct network for the granted host");

		// Same declaration (only text changed): grants kept. Changed declaration: all voided.
		const kept = await showCard({ title: "天气 2", html: `${html}<p>v2</p>`, card_id: card.id });
		assert.equal(kept.card.version, 2);
		assert.equal(kept.card.epoch, card.epoch);
		assert.equal(envelope(await request(card.id, "invoke", payload)).ok, true);
		const changed = await showCard({ title: "天气 3", html: `${manifest({ w: { tool: "fetch.request", input: { hosts: ["127.0.0.1", "a.example"] } } })}<p>v3</p>`, card_id: card.id });
		assert.equal(changed.card.epoch, card.epoch + 1);
		const q3 = ask(await request(card.id, "invoke", payload));
		// An answer given under the old declaration does not act or remember.
		assert.equal(envelope(await request(card.id, "invoke", payload, { answer: { grant: "always", epoch: card.epoch, digest: q.digest } })).code, "CARD_HOST_TOOL_UNAVAILABLE");
		assert.deepEqual(await t.core.call("cards.grants", { id: card.id }), []);
		assert.equal(q3.epoch, card.epoch + 1);
	});

	it("transport baseline: https only and no internal addresses; danger shown for read-files + send-out", async () => {
		const html = `${manifest({ w: { tool: "fetch.request", input: { hosts: ["127.0.0.1", "localhost"] } }, f: { tool: "fs.read", input: { dirs: ["."] } } })}<p>x</p>`;
		const { card } = await showCard({ title: "读文件", html });
		assert.equal(envelope(await request(card.id, "invoke", { bindingId: "w", input: { url: apiUrl("/") } })).code, "CARD_HOST_INVALID_INPUT", "http refused");
		assert.equal(envelope(await request(card.id, "invoke", { bindingId: "w", input: { url: "https://127.0.0.1/" } })).code, "CARD_HOST_TOOL_UNAVAILABLE", "loopback refused");
		writeFileSync(join(t.workspace, "a.txt"), "内容");
		const q = ask(await request(card.id, "invoke", { bindingId: "f", input: { path: "a.txt" } }));
		assert.equal(q.kind, "dir");
		assert.equal(q.danger, false, "nothing that sends out was granted yet");
		const read = envelope(await request(card.id, "invoke", { bindingId: "f", input: { path: "a.txt" } }, { answer: { grant: "session", epoch: q.epoch, digest: q.digest } }));
		assert.equal(read.result.text, "内容");
		assert.equal(envelope(await request(card.id, "invoke", { bindingId: "f", input: { path: "../../x" } })).code, "CARD_HOST_TOOL_UNAVAILABLE", "outside the declared folder");
		cards.allowLocalNetwork = true;
		assert.equal(ask(await request(card.id, "invoke", { bindingId: "w", input: { url: apiUrl("/") } })).danger, true, "send-out asked after a file grant");
	});

	it("v0.2 review: a link inside a granted folder does not lead outside it", async () => {
		const allowed = join(t.workspace, "allowed");
		const secret = join(t.dir, "private");
		mkdirSync(allowed, { recursive: true });
		mkdirSync(secret, { recursive: true });
		writeFileSync(join(secret, "secret.txt"), "机密");
		writeFileSync(join(allowed, "ok.txt"), "公开");
		symlinkSync(secret, join(allowed, "out"), "junction");
		const { card } = await showCard({ title: "读文件", html: `${manifest({ f: { tool: "fs.read", input: { dirs: ["allowed"] } } })}<p>x</p>` });
		const q = ask(await request(card.id, "invoke", { bindingId: "f", input: { path: "ok.txt" } }));
		const grant = { answer: { grant: "session", epoch: q.epoch, digest: q.digest } };
		assert.equal(envelope(await request(card.id, "invoke", { bindingId: "f", input: { path: "ok.txt" } }, grant)).result.text, "公开");
		const escaped = envelope(await request(card.id, "invoke", { bindingId: "f", input: { path: "out/secret.txt" } }));
		assert.equal(escaped.code, "CARD_HOST_TOOL_UNAVAILABLE");
		assert.doesNotMatch(JSON.stringify(escaped), /机密/);
	});

	it("v0.2 review: web.read checks every redirect like the first address", async () => {
		cards.allowLocalNetwork = true;
		const site = createServer((req, res) => {
			const port = (site.address() as AddressInfo).port;
			if (req.url === "/go") {
				res.writeHead(302, { location: `http://localhost:${port}/secret` });
				res.end();
			} else {
				res.writeHead(200, { "content-type": "text/plain" });
				res.end("内网机密");
			}
		});
		await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
		try {
			const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/go`;
			const { card } = await showCard({ title: "读网页", html: `${manifest({ r: { tool: "web.read", input: { hosts: ["127.0.0.1"] } } })}<p>x</p>` });
			const q = ask(await request(card.id, "invoke", { bindingId: "r", input: { url } }));
			const answer = envelope(await request(card.id, "invoke", { bindingId: "r", input: { url } }, { answer: { grant: "once", epoch: q.epoch, digest: q.digest } }));
			assert.notEqual(answer.ok, true, "localhost is not a declared host");
			assert.doesNotMatch(JSON.stringify(answer), /内网机密/);
		} finally {
			site.close();
		}
	});

	it("history honesty and rate limits", async () => {
		const { card } = await showCard({ title: "时间", html: `${manifest({ t: { tool: "time.now" } })}<p>t</p>` });
		assert.equal(envelope(await request(card.id, "invoke", { bindingId: "t" }, { armed: false })).code, "CARD_HOST_TOOL_UNAVAILABLE");
		let limited = 0;
		for (let i = 0; i < 40; i++) if (envelope(await request(card.id, "invoke", { bindingId: "t" })).code === "CARD_HOST_RATE_LIMITED") limited++;
		assert.ok(limited > 0);
	});

	it("pins a fork to the desk: current state copied, independent, grants from zero; forgetting the conversation keeps it", async () => {
		const { card } = await showCard({ title: "收藏", html: `${manifest({ t: { tool: "notify.send" } })}<p>hi</p>`, state: { n: 1 } });
		await request(card.id, "state.set", { key: "n", value: 2 });
		const q = ask(await request(card.id, "invoke", { bindingId: "t", input: { title: "x" } }));
		await request(card.id, "invoke", { bindingId: "t", input: { title: "x" } }, { answer: { grant: "always", epoch: q.epoch, digest: q.digest } });

		const pinned = (await t.core.call("cards.pin", { id: card.id, cwd: t.workspace })) as Card;
		assert.notEqual(pinned.id, card.id);
		assert.equal(pinned.resident, true);
		assert.equal(pinned.origin, "pin");
		assert.deepEqual(envelope(await request(pinned.id, "state.get", {})).result, { state: { n: 2 } });
		assert.deepEqual(await t.core.call("cards.grants", { id: pinned.id }), []);
		await request(pinned.id, "state.set", { key: "n", value: 9 });
		assert.deepEqual(envelope(await request(card.id, "state.get", { key: "n" })).result, { key: "n", value: 2 }, "the original is untouched");

		// emit: the conversation card delivers into its session; the resident one has no route.
		assert.deepEqual(envelope(await request(card.id, "emit", { name: "choice.made", payload: { pick: "B" }, userGesture: true })).result, { delivered: true });
		assert.equal(envelope(await request(pinned.id, "emit", { name: "choice.made" })).code, "CARD_HOST_EMIT_NO_ROUTE");
		const slot = t.core.findSlotByFile(card.sessionFile!)!;
		assert.ok(slot.session.messages.some((m) => (m as { customType?: string }).customType === "df.card_event"));

		assert.equal(((await t.core.call("cards.forgetSession", { sessionFile: card.sessionFile })) as { removed: number }).removed, 1);
		assert.deepEqual(((await t.core.call("cards.list", {})) as Card[]).map((c) => c.id), [pinned.id]);
	});

	it("exports with the equipment, imports as a new entity with zero trust, round-trips packages with assets", async () => {
		const { card } = await showCard({ title: "导出卡", html: `${manifest({ t: { tool: "notify.send" } })}<p>导出</p>`, state: { n: 7 } });
		assert.equal(((await t.core.call("cards.exportName", { id: card.id })) as { name: string }).name, "导出卡.card.html");
		const out = (await t.core.call("cards.export", { id: card.id, path: join(t.dir, "导出卡"), theme: { "--fg": "#111111" } })) as { path: string };
		assert.match(out.path, /导出卡\.card\.html$/);
		const exported = readFileSync(out.path, "utf8");
		assert.match(exported, /data-card-state>\n\{"n":7\}/);
		assert.match(exported, /data-card-export-shim>\/\* showcard reference injection layer \*\//);
		assert.match(exported, /"TIMEOUT_MS": 5000/, "exports keep the reference deadline");
		assert.match(exported, /--fg:#111111/);
		assert.match(exported, /http-equiv="Content-Security-Policy"/, "the card's own default-deny CSP stays");
		assert.doesNotMatch(exported, /df:resize/, "no host bridge in exports");

		const imported = (await t.core.call("cards.import", { path: out.path, cwd: t.workspace })) as Card;
		assert.notEqual(imported.id, card.id);
		assert.deepEqual([imported.origin, imported.resident], ["import", true]);
		assert.deepEqual(envelope(await request(imported.id, "state.get", {})).result, { state: { n: 7 } });
		// Exporting the import again does not stack shims.
		const again = readFileSync(((await t.core.call("cards.export", { id: imported.id, path: join(t.dir, "again.card.html") })) as { path: string }).path, "utf8");
		assert.equal((again.match(/data-card-export-shim>\/\* showcard reference/g) ?? []).length, 1);

		const pkg = join(t.dir, "pkg");
		mkdirSync(join(pkg, "assets"), { recursive: true });
		writeFileSync(join(pkg, "index.html"), '<!DOCTYPE html><html><head><title>带资源</title></head><body><img src="assets/a.png" alt="点"></body></html>');
		writeFileSync(join(pkg, "assets", "a.png"), Buffer.from([1, 2, 3, 4, 5]));
		const withAssets = (await t.core.call("cards.import", { path: pkg, cwd: null })) as Card;
		const zipPath = ((await t.core.call("cards.export", { id: withAssets.id, path: join(t.dir, "带资源") })) as { path: string }).path;
		assert.match(zipPath, /\.card\.zip$/);
		assert.deepEqual(readZip(readFileSync(zipPath)).map((e) => e.name).sort(), ["assets/a.png", "index.html"]);
		const fromZip = (await t.core.call("cards.import", { path: zipPath, cwd: null })) as Card;
		const { url } = (await t.core.call("cards.open", { id: fromZip.id, theme: {} })) as { url: string };
		const src = (await (await fetch(url)).text()).match(/src="([^"]+)"/)![1]!;
		const asset = await fetch(`http://127.0.0.1:${http.port}${src.replace("index.html", "assets/a.png")}`, { headers: { range: "bytes=1-2" } });
		assert.equal(asset.status, 206);
		assert.deepEqual([...new Uint8Array(await asset.arrayBuffer())], [2, 3]);

		const secret = join(t.dir, "secret.card.html");
		writeFileSync(secret, "<!DOCTYPE html><html><head><title>密</title></head><body>ghp_abcdefghijklmnopqrstuvwxyz0123456789</body></html>");
		await assert.rejects(t.core.call("cards.import", { path: secret, cwd: null }), /疑似密钥/);
	});

	it("minimal mode has no card tools", async () => {
		await t.core.call("slot.open", { slotId: "m", cwd: t.workspace, agentMode: "minimal" }, t.client);
		const tools: string[] = [];
		t.respond((context) => {
			for (const s of context.messages as unknown as { role: string; toolsAdded?: { name: string }[] }[]) {
				if (s.role === "system") tools.push(...(s.toolsAdded ?? []).map((tool) => tool.name));
			}
			return fauxAssistantMessage("ok");
		});
		await t.send("m", { id: "p", type: "prompt", message: "hi" });
		await t.waitFor(() => settledCount(t.records("m")) === 1);
		assert.ok(tools.length > 0);
		for (const name of ["show_card", "read_card", "read_document"]) assert.ok(!tools.includes(name), tools.join(","));
	});
});

/** A one-page PDF with the text "Hello PDF" (xref offsets computed). */
function tinyPdf(): Buffer {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		"<< /Length 44 >>\nstream\nBT /F1 18 Tf 40 100 Td (Hello PDF) Tj ET\nendstream",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

describe("documents", () => {
	it("converts Word, Excel, PDF and GBK text; the agent reads large ones in chunks", async () => {
		const docx = writeZip([
			{
				name: "word/document.xml",
				data: Buffer.from(
					'<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">甲 &amp; 乙</w:t></w:r><w:r><w:tab/><w:t>丙</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>名</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>值</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
				),
			},
		]);
		assert.equal(docxText(docx), "# 标题\n甲 & 乙\t丙\n| 名 | 值 |\n| --- | --- |\n| a | 1 |");

		const xlsx = writeZip([
			{ name: "xl/workbook.xml", data: Buffer.from('<workbook><sheets><sheet name="销售" sheetId="1" r:id="rId1"/></sheets></workbook>') },
			{ name: "xl/_rels/workbook.xml.rels", data: Buffer.from('<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>') },
			{ name: "xl/sharedStrings.xml", data: Buffer.from("<sst><si><t>月份</t></si><si><t>金额</t></si><si><t>一月</t></si></sst>") },
			{
				name: "xl/worksheets/sheet1.xml",
				data: Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>12.5</v></c></row></sheetData></worksheet>'),
			},
		]);
		assert.deepEqual(xlsxText(xlsx), { text: "## 销售\n| 月份 | 金额 |  |\n| --- | --- | --- |\n| 一月 |  | 12.5 |", sheets: 1 });

		const t = await startTestCore();
		try {
			const pdf = join(t.dir, "a.pdf");
			writeFileSync(pdf, tinyPdf());
			const converted = (await t.core.call("files.convert", { path: pdf })) as { kind: string; text: string; parts: number; large: boolean };
			assert.equal(converted.kind, "pdf");
			assert.equal(converted.parts, 1);
			assert.match(converted.text, /Hello PDF/);
			assert.equal(converted.large, false);

			const gbk = join(t.dir, "g.txt");
			writeFileSync(gbk, Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
			assert.equal((await convertDocument(gbk)).text, "中文");
			const long = join(t.dir, "long.md");
			writeFileSync(long, "字".repeat(40_000));
			const big = (await t.core.call("files.convert", { path: long })) as { large: boolean; chars: number; text: string };
			assert.equal(big.large, true);
			assert.equal(big.chars, 40_000);
			assert.equal(big.text.length, 2000, "only a preview goes back to the window");
			await assert.rejects(t.core.call("files.convert", { path: join(t.dir, "x.exe") }), /不支持|no such file|ENOENT/);

			await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
			let seen = "";
			t.respond(fauxAssistantMessage([fauxToolCall("read_document", { path: long, start_index: 39_000 })], { stopReason: "toolUse" }), (context) => {
				seen = JSON.stringify(context.messages.findLast((m) => m.role === "toolResult"));
				return fauxAssistantMessage("读完了");
			});
			await t.send("s1", { id: "p", type: "prompt", message: "读一下" });
			await t.waitFor(() => settledCount(t.records("s1")) === 1);
			assert.match(seen, /共 40000 字，从第 39000 字开始/);
		} finally {
			await t.cleanup();
		}
	});
});

describe("images for models without vision", () => {
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII=";

	it("describes images with the vision model once and leaves vision models alone", async () => {
		const t = await startTestCore();
		try {
			t.core.settings.update({ visionModel: "faux/faux-1" });
			await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
			await t.send("s1", { id: "m", type: "set_model", provider: "faux", modelId: "faux-text" });
			let seen = "";
			t.respond(fauxAssistantMessage("一个红色的小方块"), (context) => {
				seen = JSON.stringify(context.messages);
				return fauxAssistantMessage("是红色");
			});
			await t.send("s1", { id: "p", type: "prompt", message: "什么颜色", images: [{ type: "image", data: png, mimeType: "image/png" }] });
			await t.waitFor(() => settledCount(t.records("s1")) === 1);
			assert.match(seen, /Faux 1 的文字转述/);
			assert.match(seen, /一个红色的小方块/);
			assert.doesNotMatch(seen, /"type":"image"/);
			const relayed = t.messages.find((m) => m.event === "vision.relayed") as { hashes: string[]; model: string };
			assert.equal(relayed.model, "Faux 1");
			const stored = (await t.core.call("vision.lookup", { hashes: relayed.hashes })) as Record<string, { text: string }>;
			assert.equal(stored[relayed.hashes[0]!]!.text, "一个红色的小方块");
			assert.equal(relayed.hashes[0], imageHash(png));

			t.respond((context) => {
				seen = JSON.stringify(context.messages);
				return fauxAssistantMessage("还是红色");
			});
			await t.send("s1", { id: "p2", type: "prompt", message: "再说一遍" });
			await t.waitFor(() => settledCount(t.records("s1")) === 2);
			assert.match(seen, /一个红色的小方块/, "the cached description is reused");

			await t.send("s1", { id: "m2", type: "set_model", provider: "faux", modelId: "faux-1" });
			t.respond((context) => {
				seen = JSON.stringify(context.messages);
				return fauxAssistantMessage("红");
			});
			await t.send("s1", { id: "p3", type: "prompt", message: "看图" });
			await t.waitFor(() => settledCount(t.records("s1")) === 3);
			assert.match(seen, /"type":"image"/, "a model that sees gets the image itself");
		} finally {
			await t.cleanup();
		}
	});

	it("reports when no model can see", async () => {
		const t = await startTestCore();
		try {
			t.core.settings.update({ visionModel: "faux/faux-text" });
			await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
			await t.send("s1", { id: "m", type: "set_model", provider: "faux", modelId: "faux-text" });
			t.respond(fauxAssistantMessage("看不到"));
			await t.send("s1", { id: "p", type: "prompt", message: "看", images: [{ type: "image", data: png, mimeType: "image/png" }] });
			await t.waitFor(() => settledCount(t.records("s1")) === 1);
			assert.ok(t.messages.some((m) => m.event === "vision.missing"));
		} finally {
			await t.cleanup();
		}
	});
});
