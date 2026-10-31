import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Core, CoreModule } from "../core.ts";
import { RpcError, requireStr, samePath, str } from "../core.ts";
import { json, now, parseJson } from "../db.ts";
import { AVAILABLE_TOOLS, BindingError, declaredUnits, knownTool, prepareCall, readsLocal, sendsOut, toolLabel, type GrantKind, type Unit } from "./bindings.ts";
import {
	bindingsDigest,
	CODES,
	EMIT_NAME,
	EMIT_PAYLOAD_LIMIT,
	instancePolicy,
	isPlainObject,
	jsonSize,
	mintDocument,
	parseManifest,
	parseStateSeed,
	renderServed,
	rigForExport,
	scanSecrets,
	slugTitle,
	STATE_LIMIT,
	titleOf,
	validatePackage,
	type ParsedManifest,
	type Theme,
} from "./document.ts";
import { shellPage } from "./shell.ts";
import { readZip, writeZip } from "./zip.ts";

/**
 * Showcard 1.0 host (plan §H; spec github.com/liliMozi/showcard spec/1.0.md).
 *
 * - Cards are entities with host-assigned identity (§1.3), the package on
 *   disk under dataDir/cards/<id>/ exactly as minted (§1.1), state per
 *   entity (§2.5).
 * - Persistence gradient (§3.2): a card the agent shows lives in its
 *   conversation (ephemeral; forgotten with the conversation); pinning it to
 *   the desk copies its current state into a new resident entity (Fork) that
 *   lives on its own, with no grants.
 * - Authorization (§3.2, §3.3, §4.6, §5.8): per (kind, subject) and entity,
 *   once / this session / always, revocable, bound to the declaration epoch.
 * - Serving (§1.1, §7.1): ticketed URLs on the core's loopback HTTP port, the
 *   reference injection with a per-instance CSP that grows with network
 *   grants (§3.5).
 * - The socket (§2.3–2.6) follows the reference dispatcher (host.js
 *   createCapabilityDispatcher) plus the L2 gateway.
 */

export type CardOrigin = "agent" | "import" | "pin";

export interface Card {
	id: string;
	title: string;
	cwd: string | null;
	/** Conversation the card lives in (ephemeral); null for resident cards. */
	sessionFile: string | null;
	toolCallId: string | null;
	origin: CardOrigin;
	/** Resident entity on the desk (pinned or imported). */
	resident: boolean;
	pinnedFrom: string | null;
	epoch: number;
	version: number;
	height: number | null;
	snapshotAt: number | null;
	createdAt: number;
	updatedAt: number;
	bindings: { id: string; tool: string; label: string; description: string | null; known: boolean; units: Unit[] }[];
	malformed: Record<string, string>;
	preferredWidth: number | null;
	specVersion: string;
	specSupported: boolean;
	hasAssets: boolean;
}

export interface Grant {
	kind: GrantKind;
	subject: string;
	scope: "session" | "always";
}

interface CardRow {
	id: string;
	title: string;
	cwd: string | null;
	session_file: string | null;
	tool_call_id: string | null;
	origin: string;
	digest: string;
	epoch: number;
	version: number;
	state: string;
	on_desk: number;
	height: number | null;
	snapshot_at: number | null;
	created_at: number;
	updated_at: number;
}

export interface Envelope {
	ok: boolean;
	result: Record<string, unknown>;
	error?: string;
	code?: string;
}

/** What the window gets back for a card request: an envelope, or a question for the user first. */
export type RequestAnswer = Envelope | { ask: PermissionQuestion };

export interface PermissionQuestion {
	kind: GrantKind;
	subject: string;
	bindingId: string;
	tool: string;
	label: string;
	description: string | null;
	/** The complete call as it will run (§4.6). */
	call: string;
	/** Reads local data and can send it out, together with what was granted before (§4.6). */
	danger: boolean;
	origin: CardOrigin;
	/** Echoed back with the answer: the declaration is checked again before acting (§5.8). */
	epoch: number;
	digest: string;
}

const ok = (result: unknown = {}): Envelope => ({ ok: true, result: isPlainObject(result) ? result : {} });
const fail = (code: string, error: string): Envelope => ({ ok: false, code, error, result: {} });

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".txt": "text/plain; charset=utf-8",
};

/** Requests per card per 10 seconds before CARD_HOST_RATE_LIMITED (§2.3, §7.1). */
const RATE = { invoke: 30, emit: 20, other: 300 };

export const SHOW_CARD_TOOL = "show_card";
export const READ_CARD_TOOL = "read_card";

const SHOW_CARD_DESCRIPTION = `Show an interactive card in the conversation: a small web page (Showcard 1.0) the user can use - calculators, interactive charts, forms, checklists, games, small dashboards, demos. It keeps its own state.

html: a complete HTML document (<!DOCTYPE html>, <html>, <head> with a natural-language <title> in the user's language, <body>) or just the body content (the host adds the rest). Inline <style>/<script> only. External URLs (CDNs, images) are blocked unless the user allows the host, so draw with inline SVG/canvas. Optional theme variables: var(--fg) var(--muted) var(--bg) var(--surface) var(--border) var(--accent) var(--font-sans) var(--font-serif). In the chat the card is about 600-720px wide; height follows the content (never height:100vh).

Inside the card, window.card (every call resolves {ok, result} or {ok:false, code, error}; never throws):
- await card.state.get() -> result.state ; card.state.get(key) -> result.value ; card.state.set(key, value) ; card.state.set(wholeObject) replaces the state. Persisted per card, 64 KiB max. Render from state on load.
- Declarative, no script needed: <input data-persist="key"> keeps a field in state; <button data-invoke="bindingId"> calls a binding (form fields become its input); <div data-result="bindingId"> shows its latest result.
- await card.invoke(bindingId, input) calls a host tool declared in the manifest; the user approves each host / folder / program the first time.
- card.emit("choice.made", payload) reports a finished user action to this conversation (you see it on your next turn). Not a way to ask you anything.
Declare tools in <script type="application/json" data-card-manifest>{"toolBindings":{"rates":{"tool":"fetch.request","input":{"hosts":["api.example.com"]},"description":"拉取汇率"}}}</script>. Shapes are fixed here; the card can only fill slots at run time.
Host tools: time.now; fetch.request (input.hosts required, input.method; call input: url, body) -> {status, body, json}; web.read (input.hosts; call input: url) -> {title, text}; fs.read / fs.list / fs.write (input.dirs required; call input: path, text); exec.run (input.program and input.args fixed; call input: stdin) -> {exitCode, stdout, stderr}; notify.send (call input: title, body).
Burn real opening data into the state (the state parameter) so the card shows content even before any tool runs.
Never put API keys, tokens or passwords in a card or its state.
To change a card you showed (same card, state kept), pass its card_id; leave card_id out for a new card.`;

/** Showcard host module. */
export class CardsModule implements CoreModule {
	readonly modelFacing = true;
	private readonly core: Core;
	readonly dir: string;
	/** ticket → instance it opens (§1.1 scope ticket). */
	private readonly tickets = new Map<string, { cardId: string; theme: Theme; sizing: "content" | "viewport"; at: number }>();
	/** cardId → "kind\0subject" granted for this run of the background service ("本次会话内"). */
	private readonly sessionGrants = new Map<string, Set<string>>();
	private readonly rates = new Map<string, number[]>();
	private lastTheme: Theme = {};
	/** Tests only: card bindings may reach http and loopback hosts. */
	allowLocalNetwork = false;

	constructor(core: Core) {
		this.core = core;
		this.dir = join(core.paths.dataDir, "cards");
		mkdirSync(this.dir, { recursive: true });
		core.exemptFromApproval(SHOW_CARD_TOOL, READ_CARD_TOOL);
		core.registerHttp("/cards/", (req, res, path) => this.serveCard(req, res, path));
		core.registerHttp("/shell/", (req, res, path) => this.serveShell(res, path));
		this.register();
	}

	// ---- store -------------------------------------------------------------------------

	private row(id: string): CardRow | undefined {
		return this.core.db.get<CardRow>("SELECT * FROM cards WHERE id = ?", id);
	}

	private requireRow(id: unknown): CardRow {
		const row = typeof id === "string" ? this.row(id) : undefined;
		if (!row) throw new RpcError("not_found", "找不到这张卡片");
		return row;
	}

	cardDir(id: string): string {
		if (!/^c_[a-z0-9]{8,32}$/.test(id)) throw new RpcError("bad_request", "卡片编号不对");
		return join(this.dir, id);
	}

	html(id: string): string {
		return readFileSync(join(this.cardDir(id), "index.html"), "utf8");
	}

	manifest(id: string): ParsedManifest {
		try {
			return parseManifest(this.html(id));
		} catch {
			return parseManifest("");
		}
	}

	private hasAssets(id: string): boolean {
		return existsSync(join(this.cardDir(id), "assets"));
	}

	private toCard(row: CardRow): Card {
		const manifest = this.manifest(row.id);
		const cwd = row.cwd ?? process.cwd();
		return {
			id: row.id,
			title: row.title,
			cwd: row.cwd,
			sessionFile: row.session_file,
			toolCallId: row.tool_call_id,
			origin: row.origin as CardOrigin,
			resident: row.on_desk === 1,
			pinnedFrom: null,
			epoch: row.epoch,
			version: row.version,
			height: row.height,
			snapshotAt: row.snapshot_at,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			bindings: Object.entries(manifest.bindings).map(([id, b]) => ({
				id,
				tool: b.tool,
				label: toolLabel(b.tool),
				description: b.description ?? null,
				known: knownTool(b.tool),
				units: declaredUnits(b, cwd),
			})),
			malformed: manifest.malformed,
			preferredWidth: manifest.preferredWidth,
			specVersion: manifest.specVersion,
			specSupported: manifest.specSupported,
			hasAssets: this.hasAssets(row.id),
		};
	}

	get(id: string): Card | undefined {
		const row = this.row(id);
		return row ? this.toCard(row) : undefined;
	}

	state(id: string): Record<string, unknown> {
		return parseJson<Record<string, unknown>>(this.row(id)?.state, {});
	}

	private newId(): string {
		return `c_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
	}

	private writePackage(id: string, html: string, assets: { name: string; data: Buffer }[]): void {
		const dir = this.cardDir(id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "index.html"), html, "utf8");
		const root = resolve(dir, "assets");
		for (const asset of assets) {
			const target = resolve(dir, asset.name);
			if (!target.startsWith(root + sep)) continue;
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, asset.data);
		}
	}

	private insert(row: Omit<CardRow, "epoch" | "version" | "height" | "snapshot_at" | "created_at" | "updated_at">): Card {
		const at = now();
		this.core.db.run(
			`INSERT INTO cards(id, title, cwd, session_file, tool_call_id, origin, digest, state, on_desk, created_at, updated_at)
			 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			row.id,
			row.title,
			row.cwd,
			row.session_file,
			row.tool_call_id,
			row.origin,
			row.digest,
			row.state,
			row.on_desk,
			at,
			at,
		);
		const card = this.get(row.id)!;
		this.core.broadcast({ event: "card.changed", card });
		return card;
	}

	/**
	 * Generative mint (§5.2) or hot update of [cardId] (§5.5 channel one: same
	 * entity, state kept unless replaced; a changed declaration starts a new
	 * epoch, voiding every grant, §5.8). Validated in full each time (§5.4).
	 */
	mint(input: { title: string; code: string; cardId?: string; state?: Record<string, unknown>; cwd?: string | null; sessionFile?: string | null; toolCallId?: string | null }): Card {
		if (input.state !== undefined && !isPlainObject(input.state)) throw new RpcError("bad_request", "state 必须是对象");
		const existing = input.cardId ? this.row(input.cardId) : undefined;
		if (input.cardId && !existing) throw new RpcError("not_found", `没有编号为 ${input.cardId} 的卡片`);
		const state = input.state ?? (existing ? parseJson<Record<string, unknown>>(existing.state, {}) : undefined);
		const html = mintDocument(input.code, input.title.trim(), state);
		const seeded = state ?? parseStateSeed(html);
		const errors = validatePackage(html, JSON.stringify(seeded));
		if (errors.length) throw new RpcError("invalid_card", `卡片没有通过校验：${errors.join("；")}`);
		if (jsonSize(seeded) > STATE_LIMIT) throw new RpcError("too_large", `卡片状态超过 ${STATE_LIMIT} 字节`);
		const title = titleOf(html).slice(0, 120);
		const digest = bindingsDigest(parseManifest(html).raw);
		if (existing) {
			const renewed = existing.digest !== digest;
			writeFileSync(join(this.cardDir(existing.id), "index.html"), html, "utf8");
			this.core.db.run(
				"UPDATE cards SET title = ?, digest = ?, epoch = epoch + ?, version = version + 1, state = ?, tool_call_id = COALESCE(?, tool_call_id), snapshot_at = NULL, updated_at = ? WHERE id = ?",
				title,
				digest,
				renewed ? 1 : 0,
				json(seeded),
				input.toolCallId ?? null,
				now(),
				existing.id,
			);
			if (renewed) this.voidGrants(existing.id);
			const card = this.get(existing.id)!;
			this.core.broadcast({ event: "card.changed", card });
			return card;
		}
		const id = this.newId();
		this.writePackage(id, html, []);
		return this.insert({ id, title, cwd: input.cwd ?? null, session_file: input.sessionFile ?? null, tool_call_id: input.toolCallId ?? null, origin: "agent", digest, state: json(seeded), on_desk: 0 });
	}

	/** Pin (§3.2): the card's current state printed into a new resident entity, grants from zero. */
	pin(id: string, cwd: string | null): Card {
		const source = this.requireRow(id);
		const copy = this.newId();
		const from = this.cardDir(source.id);
		const to = this.cardDir(copy);
		mkdirSync(to, { recursive: true });
		cpSync(join(from, "index.html"), join(to, "index.html"));
		if (existsSync(join(from, "assets"))) cpSync(join(from, "assets"), join(to, "assets"), { recursive: true });
		if (existsSync(join(from, "snapshot.png"))) cpSync(join(from, "snapshot.png"), join(to, "snapshot.png"));
		const card = this.insert({ id: copy, title: source.title, cwd: cwd ?? source.cwd, session_file: null, tool_call_id: null, origin: "pin", digest: source.digest, state: source.state, on_desk: 1 });
		if (source.snapshot_at) this.core.db.run("UPDATE cards SET snapshot_at = ?, height = ? WHERE id = ?", source.snapshot_at, source.height, copy);
		return this.get(card.id)!;
	}

	list(filter: { cwd?: string; resident?: boolean; sessionFile?: string } = {}): Card[] {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (filter.resident !== undefined) {
			where.push("on_desk = ?");
			params.push(filter.resident ? 1 : 0);
		}
		let rows = this.core.db.all<CardRow>(`SELECT * FROM cards ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC`, ...params);
		if (filter.sessionFile) rows = rows.filter((r) => samePath(r.session_file, filter.sessionFile));
		if (filter.cwd) rows = rows.filter((r) => !r.cwd || samePath(r.cwd, filter.cwd));
		return rows.map((r) => this.toCard(r));
	}

	delete(id: string): void {
		const row = this.requireRow(id);
		this.core.db.run("DELETE FROM cards WHERE id = ?", row.id);
		this.sessionGrants.delete(row.id);
		this.rates.delete(row.id);
		rmSync(this.cardDir(row.id), { recursive: true, force: true });
		this.core.broadcast({ event: "card.removed", cardId: row.id });
	}

	/** Ephemeral cards end with their conversation (§3.2), their grants with them (§3.3). */
	forgetSession(sessionFile: string): number {
		const cards = this.core.db.all<{ id: string; session_file: string }>("SELECT id, session_file FROM cards WHERE on_desk = 0 AND session_file IS NOT NULL");
		let removed = 0;
		for (const card of cards) {
			if (!samePath(card.session_file, sessionFile)) continue;
			this.delete(card.id);
			removed++;
		}
		return removed;
	}

	// ---- authorization -----------------------------------------------------------------

	private voidGrants(id: string): void {
		this.core.db.run("DELETE FROM card_grants WHERE card_id = ?", id);
		this.sessionGrants.delete(id);
	}

	grants(id: string): Grant[] {
		const row = this.requireRow(id);
		const always = this.core.db
			.all<{ kind: string; subject: string }>("SELECT kind, subject FROM card_grants WHERE card_id = ? AND epoch = ? ORDER BY created_at", row.id, row.epoch)
			.map((g) => ({ kind: g.kind as GrantKind, subject: g.subject, scope: "always" as const }));
		const session = [...(this.sessionGrants.get(row.id) ?? [])]
			.map((key) => {
				const [kind, subject] = key.split("\0") as [GrantKind, string];
				return { kind, subject, scope: "session" as const };
			})
			.filter((s) => !always.some((a) => a.kind === s.kind && a.subject === s.subject));
		return [...always, ...session];
	}

	private granted(row: CardRow, unit: Unit): boolean {
		if (this.sessionGrants.get(row.id)?.has(`${unit.kind}\0${unit.subject}`)) return true;
		return !!this.core.db.get("SELECT 1 FROM card_grants WHERE card_id = ? AND kind = ? AND subject = ? AND epoch = ?", row.id, unit.kind, unit.subject, row.epoch);
	}

	private remember(row: CardRow, unit: Unit, scope: "session" | "always"): void {
		if (scope === "session") {
			const set = this.sessionGrants.get(row.id) ?? new Set();
			set.add(`${unit.kind}\0${unit.subject}`);
			this.sessionGrants.set(row.id, set);
		} else {
			this.core.db.run("INSERT OR REPLACE INTO card_grants(card_id, kind, subject, epoch, created_at) VALUES(?, ?, ?, ?, ?)", row.id, unit.kind, unit.subject, row.epoch, now());
		}
	}

	/** Records a grant directly (direct-network permission asked by the window, §3.5). */
	grant(id: string, unit: Unit, scope: "once" | "session" | "always"): void {
		const row = this.requireRow(id);
		if (scope !== "once") this.remember(row, unit, scope);
	}

	/** Revokes one unit, nothing else (§3.3). */
	revoke(id: string, kind: string, subject: string): void {
		const row = this.requireRow(id);
		this.core.db.run("DELETE FROM card_grants WHERE card_id = ? AND kind = ? AND subject = ?", row.id, kind, subject);
		this.sessionGrants.get(row.id)?.delete(`${kind}\0${subject}`);
	}

	/** Hosts this card instance may reach directly (§3.5). */
	private allowedHosts(row: CardRow): string[] {
		return this.grants(row.id)
			.filter((g) => g.kind === "net")
			.map((g) => g.subject)
			.filter((h) => /^[a-z0-9.-]+(:\d+)?$/i.test(h));
	}

	private rateLimited(id: string, capability: string): boolean {
		const limit = capability === "invoke" ? RATE.invoke : capability === "emit" ? RATE.emit : RATE.other;
		const key = `${id}\0${capability === "invoke" || capability === "emit" ? capability : "other"}`;
		const at = Date.now();
		const recent = (this.rates.get(key) ?? []).filter((t) => at - t < 10_000);
		if (recent.length >= limit) {
			this.rates.set(key, recent);
			return true;
		}
		recent.push(at);
		this.rates.set(key, recent);
		return false;
	}

	// ---- the socket (§2.3–2.6, reference host.js) --------------------------------------

	/**
	 * One `card:request` from a live card. The window answers a question with
	 * [answer] (the user's choice and the epoch/digest it was asked under).
	 * [armed]: the user has touched this card since it was restored from
	 * history (§3.2 history honesty) - tools wait for that.
	 */
	async request(
		id: string,
		capability: unknown,
		payload: unknown,
		options: { answer?: { grant: "once" | "session" | "always" | "deny"; epoch: number; digest: string }; armed?: boolean } = {},
	): Promise<RequestAnswer> {
		if (typeof capability !== "string" || capability === "") return fail(CODES.CAPABILITY_REQUIRED, "a capability name is required");
		const row = this.row(id);
		if (!row) return fail(CODES.TOOL_UNAVAILABLE, "这张卡片已经被删除");
		const manifest = this.manifest(row.id);
		if (!manifest.specSupported) return fail(CODES.CONTRACT_UNSUPPORTED, `这张卡片声明的规范版本 ${manifest.specVersion} 高于本宿主支持的 1.0`);
		if (!options.answer && this.rateLimited(row.id, capability)) return fail(CODES.RATE_LIMITED, "请求太频繁，稍后再试");
		const input = isPlainObject(payload) ? payload : {};
		try {
			switch (capability) {
				case "capabilities":
					return ok({ environment: "host", capabilities: { state: "available", invoke: "available", emit: "available" } });
				case "state.get": {
					const state = parseJson<Record<string, unknown>>(row.state, {});
					const key = typeof input.key === "string" ? input.key : null;
					return key === null ? ok({ state }) : ok({ key, value: state[key] });
				}
				case "state.set": {
					let next: Record<string, unknown>;
					if (isPlainObject(input.state)) next = { ...input.state };
					else if (typeof input.key === "string" && input.key !== "") next = { ...parseJson<Record<string, unknown>>(row.state, {}), [input.key]: input.value };
					else return fail(CODES.INVALID_INPUT, "state.set needs a key and a value, or a whole state object");
					let serialized: string;
					try {
						serialized = JSON.stringify(next);
					} catch (error) {
						return fail(CODES.INVALID_INPUT, `the state cannot be serialized: ${String(error)}`);
					}
					if (Buffer.byteLength(serialized, "utf8") > STATE_LIMIT) return fail(CODES.STATE_TOO_LARGE, `the serialized state exceeds the ${STATE_LIMIT} byte budget`);
					if (scanSecrets(serialized).length) return fail(CODES.STORAGE_FAILED, "状态里有疑似密钥，没有保存（密钥不能放进卡片）");
					this.core.db.run("UPDATE cards SET state = ? WHERE id = ?", serialized, row.id);
					return ok({ state: next });
				}
				case "emit":
					return await this.emit(row, input);
				case "invoke":
					return await this.invoke(row, manifest, input, options);
				default:
					return fail(CODES.CAPABILITY_NOT_SUPPORTED, `this host does not support the capability ${JSON.stringify(capability)}`);
			}
		} catch (error) {
			return fail(CODES.TOOL_FAILED, `the host failed to answer: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async invoke(
		row: CardRow,
		manifest: ParsedManifest,
		input: Record<string, unknown>,
		options: { answer?: { grant: "once" | "session" | "always" | "deny"; epoch: number; digest: string }; armed?: boolean },
	): Promise<RequestAnswer> {
		const bindingId = typeof input.bindingId === "string" ? input.bindingId : "";
		const binding = Object.hasOwn(manifest.bindings, bindingId) ? manifest.bindings[bindingId]! : null;
		if (!binding) return fail(CODES.TOOL_UNAVAILABLE, `this card declares no binding named ${JSON.stringify(bindingId)}`);
		if (options.armed === false) return fail(CODES.TOOL_UNAVAILABLE, "这张卡片是从历史记录里恢复的，点一下卡片之后才能调用工具");
		const args = input.input === undefined ? null : input.input;
		const ctx = { cwd: row.cwd ?? process.cwd(), notify: (title: string, body: string) => this.core.notifier.notify(title, body), allowLocalNetwork: this.allowLocalNetwork };
		let call;
		try {
			call = await prepareCall(binding, args, ctx);
		} catch (error) {
			if (error instanceof BindingError) return fail(error.code, error.message);
			throw error;
		}
		const unit = call.unit;
		if (unit && !this.granted(row, unit)) {
			const answer = options.answer;
			if (!answer) {
				const held = this.grants(row.id);
				const danger = (readsLocal(unit) && held.some((g) => sendsOut(g))) || (sendsOut(unit) && held.some((g) => readsLocal(g))) || (readsLocal(unit) && sendsOut(unit));
				return {
					ask: {
						kind: unit.kind,
						subject: unit.subject,
						bindingId,
						tool: binding.tool,
						label: toolLabel(binding.tool),
						description: binding.description ?? null,
						call: call.summary,
						danger,
						origin: row.origin as CardOrigin,
						epoch: row.epoch,
						digest: row.digest,
					},
				};
			}
			if (answer.grant === "deny") return fail(CODES.TOOL_UNAVAILABLE, "用户没有允许这次调用");
			// §5.8: check the declaration again before acting or remembering anything.
			const current = this.row(row.id);
			if (!current || current.epoch !== answer.epoch || current.digest !== answer.digest) {
				return fail(CODES.TOOL_UNAVAILABLE, "卡片的工具声明在询问期间变了，这次调用没有执行");
			}
			if (answer.grant !== "once") this.remember(current, unit, answer.grant);
		}
		try {
			const result = await call.run();
			return ok(result ?? {});
		} catch (error) {
			if (error instanceof BindingError) return fail(error.code, error.message);
			return fail(CODES.TOOL_FAILED, `the binding failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * emit (§2.3): a finished user action, delivered to the conversation the
	 * card lives in, or to [to] (a session id). A resident card without `to`
	 * has no conversation to go to here: CARD_HOST_EMIT_NO_ROUTE.
	 */
	private async emit(row: CardRow, input: Record<string, unknown>): Promise<Envelope> {
		const name = typeof input.name === "string" ? input.name : "";
		if (!EMIT_NAME.test(name)) return fail(CODES.INVALID_INPUT, "emit takes a name matching ^[a-z0-9][a-z0-9._-]{0,63}$");
		if (Object.hasOwn(input, "payload")) {
			let serialized: string | undefined;
			try {
				serialized = JSON.stringify(input.payload);
			} catch (error) {
				return fail(CODES.INVALID_INPUT, `the emit payload cannot be serialized: ${String(error)}`);
			}
			if (serialized === undefined) return fail(CODES.INVALID_INPUT, "the emit payload must be JSON-serializable");
			if (Buffer.byteLength(serialized, "utf8") > EMIT_PAYLOAD_LIMIT) return fail(CODES.INVALID_INPUT, `the serialized emit payload exceeds the ${EMIT_PAYLOAD_LIMIT} byte budget`);
		}
		const to = typeof input.to === "string" && input.to ? input.to : undefined;
		let sessionFile: string | null = null;
		let cwd = row.cwd;
		if (to) {
			const slot = [...this.core.slots.values()].find((s) => s.info().sessionId === to);
			sessionFile = slot?.info().sessionFile ?? (this.core.db.get<{ path: string; cwd: string }>("SELECT path, cwd FROM session_meta WHERE session_id = ?", to)?.path ?? null);
			cwd = slot?.cwd ?? cwd;
		} else if (row.on_desk === 0) {
			sessionFile = row.session_file;
		}
		if (!sessionFile || !existsSync(sessionFile)) return fail(CODES.NO_ROUTE, to ? `找不到会话 ${to}` : "这张卡片不在任何对话里，事件没有可以投递的地方");
		const payload = input.payload === undefined ? null : input.payload;
		const at = now();
		this.core.db.run("INSERT INTO card_events(card_id, name, payload, at) VALUES(?, ?, ?, ?)", row.id, name, json(payload), at);
		const slot = this.core.findSlotByFile(sessionFile) ?? (await this.core.openSlot({ cwd: cwd ?? process.cwd(), sessionFile }));
		const text = `[卡片「${row.title}」（card_id: ${row.id}）上报了一次用户操作：${name}${payload === null ? "" : ` ${JSON.stringify(payload)}`}]`;
		await slot.session.sendCustomMessage({ customType: "df.card_event", content: text, display: true, details: { cardId: row.id, title: row.title, name, payload, userGesture: input.userGesture === true } });
		this.core.broadcast({ event: "card.emitted", cardId: row.id, title: row.title, sessionFile, name, payload, at });
		return ok(to ? { delivered: true, to } : { delivered: true });
	}

	// ---- serving -----------------------------------------------------------------------

	/** A ticket for one instance of [id]; returns the shell page URL the WebView loads. */
	open(id: string, theme: Theme, sizing: "content" | "viewport" = "content"): { url: string; ticket: string } {
		const row = this.requireRow(id);
		if (Object.keys(theme).length) this.lastTheme = theme;
		const ticket = randomBytes(18).toString("base64url");
		this.tickets.set(ticket, { cardId: row.id, theme, sizing, at: now() });
		if (this.tickets.size > 500) {
			for (const [t] of [...this.tickets.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100)) this.tickets.delete(t);
		}
		return { url: `http://127.0.0.1:${this.core.httpPort}/shell/${ticket}`, ticket };
	}

	private origin(): string {
		return `http://127.0.0.1:${this.core.httpPort}`;
	}

	private serveShell(res: ServerResponse, path: string): void {
		const ticket = path.match(/^\/shell\/([A-Za-z0-9_-]{10,64})$/)?.[1];
		const instance = ticket ? this.tickets.get(ticket) : undefined;
		if (!ticket || !instance) return void notFound(res);
		const nonce = randomBytes(16).toString("base64");
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src ${this.origin()}/cards/; base-uri 'none'; form-action 'none'`,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		});
		res.end(shellPage(nonce, `/cards/${instance.cardId}/t/${ticket}/index.html`));
	}

	/** /cards/{cardId}/t/{ticket}/{relativePath} (§1.1). */
	private serveCard(req: IncomingMessage, res: ServerResponse, path: string): void {
		const match = path.match(/^\/cards\/(c_[a-z0-9]{8,32})\/t\/([A-Za-z0-9_-]{10,64})\/(.*)$/);
		const instance = match ? this.tickets.get(match[2]!) : undefined;
		if (!match || !instance || instance.cardId !== match[1]) return void notFound(res);
		const row = this.row(instance.cardId);
		if (!row) return void notFound(res);
		const rel = match[3] || "index.html";
		if (rel.split("/").some((segment) => segment === "..")) {
			res.writeHead(400).end();
			return;
		}
		const prefix = `${this.origin()}/cards/${row.id}/t/${match[2]}/`;
		const csp = instancePolicy(prefix, this.allowedHosts(row));
		if (rel === "index.html") {
			let html: string;
			try {
				html = this.html(row.id);
			} catch {
				return void notFound(res);
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `${csp}; sandbox allow-scripts`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
			res.end(req.method === "HEAD" ? "" : renderServed(html, { csp, theme: instance.theme, sizing: instance.sizing }));
			return;
		}
		const root = this.cardDir(row.id);
		const target = resolve(root, rel);
		if (!target.startsWith(resolve(root, "assets") + sep)) return void notFound(res);
		sendFile(req, res, target, { "Content-Security-Policy": `${csp}; sandbox allow-scripts` });
	}

	// ---- snapshot, export, import ------------------------------------------------------

	saveSnapshot(id: string, png: Buffer, height?: number): void {
		const row = this.requireRow(id);
		writeFileSync(join(this.cardDir(row.id), "snapshot.png"), png);
		this.core.db.run("UPDATE cards SET snapshot_at = ?, height = COALESCE(?, height) WHERE id = ?", now(), height ?? null, row.id);
	}

	snapshot(id: string): Buffer | null {
		const row = this.requireRow(id);
		const file = join(this.cardDir(row.id), "snapshot.png");
		return row.snapshot_at && existsSync(file) ? readFileSync(file) : null;
	}

	/** Suggested export file name (§6.6). */
	exportName(id: string): string {
		const row = this.requireRow(id);
		return `${slugTitle(row.title)}${this.hasAssets(row.id) ? ".card.zip" : ".card.html"}`;
	}

	/** Writes `.card.html` (no assets) or `.card.zip` with the export equipment (§6.3, §6.4). */
	export(id: string, path: string, theme?: Theme): string {
		const row = this.requireRow(id);
		const html = rigForExport(this.html(row.id), { state: parseJson(row.state, {}), theme: theme ?? this.lastTheme });
		const dir = this.cardDir(row.id);
		if (!this.hasAssets(row.id) && !/\.zip$/i.test(path)) {
			const target = /\.card\.html$/i.test(path) ? path : path.replace(/(\.html?)?$/i, ".card.html");
			writeFileSync(target, html, "utf8");
			return target;
		}
		const entries = [{ name: "index.html", data: Buffer.from(html, "utf8") }];
		const walk = (folder: string) => {
			if (!existsSync(folder)) return;
			for (const entry of readdirSync(folder, { withFileTypes: true })) {
				const full = join(folder, entry.name);
				if (entry.isDirectory()) walk(full);
				else entries.push({ name: relative(dir, full).split(sep).join("/"), data: readFileSync(full) });
			}
		};
		walk(join(dir, "assets"));
		const target = /\.card\.zip$/i.test(path) ? path : path.replace(/(\.zip|\.html?)?$/i, ".card.zip");
		writeFileSync(target, writeZip(entries));
		return target;
	}

	/**
	 * Import (§5.7, §6.3, §7.6): a `.card.html`, `.card.zip` or package
	 * folder becomes a new local entity on the desk - state from the burned-in
	 * snapshot, no grants. Validated (§5.4).
	 */
	import(path: string, cwd: string | null): Card {
		if (!existsSync(path)) throw new RpcError("not_found", "文件不存在");
		let html: string;
		let assets: { name: string; data: Buffer }[] = [];
		if (statSync(path).isDirectory()) {
			const entry = join(path, "index.html");
			if (!existsSync(entry)) throw new RpcError("invalid_card", "文件夹根目录里没有 index.html");
			html = readFileSync(entry, "utf8");
			const walk = (folder: string) => {
				for (const e of readdirSync(folder, { withFileTypes: true })) {
					const full = join(folder, e.name);
					if (e.isDirectory()) walk(full);
					else assets.push({ name: relative(path, full).split(sep).join("/"), data: readFileSync(full) });
				}
			};
			if (existsSync(join(path, "assets"))) walk(join(path, "assets"));
		} else if (/\.zip$/i.test(path)) {
			const entries = readZip(readFileSync(path));
			const index = entries.find((e) => e.name === "index.html");
			if (!index) throw new RpcError("invalid_card", "压缩包根层没有 index.html（规范要求 zip 的根就是包的根，不套外层文件夹）");
			html = index.data.toString("utf8");
			assets = entries.filter((e) => e.name.startsWith("assets/"));
		} else {
			html = readFileSync(path, "utf8");
		}
		const state = parseStateSeed(html);
		const textAssets = assets.filter((a) => /\.(js|mjs|css|json|html?|svg|txt|csv|md)$/i.test(a.name)).map((a) => a.data.toString("utf8"));
		const errors = validatePackage(html, [JSON.stringify(state), ...textAssets].join("\n"));
		if (errors.length) throw new RpcError("invalid_card", `这张卡片没有通过校验，没有导入：${errors.join("；")}`);
		if (jsonSize(state) > STATE_LIMIT) throw new RpcError("too_large", "卡片状态超过 64 KiB");
		const id = this.newId();
		this.writePackage(id, html, assets);
		return this.insert({ id, title: titleOf(html).slice(0, 120), cwd, session_file: null, tool_call_id: null, origin: "import", digest: bindingsDigest(parseManifest(html).raw), state: json(state), on_desk: 1 });
	}

	// ---- agent tools (§5) --------------------------------------------------------------

	extensions(slot: { slotId: string }): ExtensionFactory[] {
		const module = this;
		return [
			(pi: ExtensionAPI) => {
				pi.registerTool({
					name: SHOW_CARD_TOOL,
					label: "展示卡片",
					description: SHOW_CARD_DESCRIPTION,
					parameters: {
						type: "object",
						properties: {
							title: { type: "string", description: "Natural-language title in the user's language (not snake_case)" },
							html: { type: "string", description: "Complete HTML document, or the body content only" },
							state: { type: "object", description: "Opening state, burned into the card (replaces the state when updating)" },
							card_id: { type: "string", description: "Update this card in place (same card, state kept unless state is given)" },
						},
						required: ["title", "html"],
					} as never,
					async execute(toolCallId, params: { title: string; html: string; state?: Record<string, unknown>; card_id?: string }) {
						const current = module.core.slots.get(slot.slotId);
						const card = module.mint({
							title: params.title,
							code: params.html,
							cardId: params.card_id || undefined,
							state: params.state,
							cwd: current?.cwd ?? null,
							sessionFile: current?.info().sessionFile ?? null,
							toolCallId,
						});
						const tools = card.bindings.map((b) => `${b.id}→${b.tool}${b.known ? "" : "（本宿主没有这个工具）"}`).join("，");
						const text = [
							`卡片「${card.title}」已显示在对话里（card_id: ${card.id}，第 ${card.version} 版）。`,
							tools ? `声明的工具：${tools}。用户第一次使用某个主机、文件夹或程序时会被询问。` : "",
							Object.keys(card.malformed).length ? `这些绑定写得不对，调用会失败：${Object.entries(card.malformed).map(([k, v]) => `${k}（${v}）`).join("，")}。` : "",
						]
							.filter(Boolean)
							.join("");
						return { content: [{ type: "text", text }], details: { cardId: card.id, title: card.title, version: card.version } };
					},
				});
				pi.registerTool({
					name: READ_CARD_TOOL,
					label: "查看卡片",
					description: "Read a card you showed earlier: its current state and (with source=true) its HTML. Use before updating a card or to answer what it shows now.",
					parameters: {
						type: "object",
						properties: { card_id: { type: "string" }, source: { type: "boolean" } },
						required: ["card_id"],
					} as never,
					async execute(_id, params: { card_id: string; source?: boolean }) {
						const card = module.get(params.card_id);
						if (!card) throw new Error(`没有编号为 ${params.card_id} 的卡片`);
						const parts = [`卡片「${card.title}」（第 ${card.version} 版）当前状态：${JSON.stringify(module.state(card.id))}`];
						if (params.source) parts.push(`源代码：\n${module.html(card.id)}`);
						return { content: [{ type: "text", text: parts.join("\n\n") }], details: { cardId: card.id } };
					},
				});
			},
		];
	}

	// ---- methods -----------------------------------------------------------------------

	private register(): void {
		const core = this.core;
		const theme = (value: unknown): Theme => (isPlainObject(value) ? (value as Theme) : {});
		const unit = (p: Record<string, unknown>): Unit => {
			const kind = requireStr(p.kind, "kind") as GrantKind;
			if (!["net", "exec", "tool", "dir"].includes(kind)) throw new RpcError("bad_request", "kind 不对");
			return { kind, subject: requireStr(p.subject, "subject") };
		};
		core.register("cards.get", (p) => {
			const card = this.get(requireStr(p.id, "id"));
			if (!card) throw new RpcError("not_found", "找不到这张卡片");
			return card;
		});
		core.register("cards.list", (p) => this.list({ cwd: str(p.cwd), resident: typeof p.resident === "boolean" ? p.resident : undefined, sessionFile: str(p.sessionFile) }));
		core.register("cards.open", (p) => this.open(requireStr(p.id, "id"), theme(p.theme), p.sizing === "viewport" ? "viewport" : "content"));
		core.register("cards.request", (p) => {
			const a = isPlainObject(p.answer) ? p.answer : undefined;
			const answer =
				a && ["once", "session", "always", "deny"].includes(a.grant as string) && typeof a.epoch === "number" && typeof a.digest === "string"
					? { grant: a.grant as "once", epoch: a.epoch, digest: a.digest }
					: undefined;
			return this.request(requireStr(p.id, "id"), p.capability, p.payload, { answer, armed: p.armed === false ? false : undefined });
		});
		core.register("cards.grants", (p) => this.grants(requireStr(p.id, "id")));
		core.register("cards.grant", (p) => {
			const u = unit(p);
			if (u.kind === "net") u.subject = u.subject.toLowerCase();
			this.grant(requireStr(p.id, "id"), u, p.scope === "always" ? "always" : p.scope === "session" ? "session" : "once");
			return { ok: true };
		});
		core.register("cards.revoke", (p) => {
			const u = unit(p);
			this.revoke(requireStr(p.id, "id"), u.kind, u.subject);
			return { ok: true };
		});
		core.register("cards.pin", (p) => this.pin(requireStr(p.id, "id"), str(p.cwd) ?? null));
		core.register("cards.delete", (p) => {
			this.delete(requireStr(p.id, "id"));
			return { ok: true };
		});
		core.register("cards.forgetSession", (p) => ({ removed: this.forgetSession(requireStr(p.sessionFile, "sessionFile")) }));
		core.register("cards.saveSnapshot", (p) => {
			this.saveSnapshot(requireStr(p.id, "id"), Buffer.from(requireStr(p.png, "png"), "base64"), typeof p.height === "number" ? Math.round(p.height) : undefined);
			return { ok: true };
		});
		core.register("cards.snapshot", (p) => {
			const png = this.snapshot(requireStr(p.id, "id"));
			return { png: png ? png.toString("base64") : null };
		});
		core.register("cards.setHeight", (p) => {
			const row = this.requireRow(p.id);
			if (typeof p.height === "number") this.core.db.run("UPDATE cards SET height = ? WHERE id = ?", Math.round(p.height), row.id);
			return { ok: true };
		});
		core.register("cards.exportName", (p) => ({ name: this.exportName(requireStr(p.id, "id")) }));
		core.register("cards.export", (p) => ({ path: this.export(requireStr(p.id, "id"), requireStr(p.path, "path"), p.theme ? theme(p.theme) : undefined) }));
		core.register("cards.import", (p) => this.import(requireStr(p.path, "path"), str(p.cwd) ?? null));
		core.register("cards.source", (p) => {
			const row = this.requireRow(p.id);
			return { html: this.html(row.id), state: this.state(row.id) };
		});
		core.register("cards.events", (p) =>
			this.core.db
				.all<{ id: number; name: string; payload: string; at: number }>("SELECT id, name, payload, at FROM card_events WHERE card_id = ? ORDER BY id DESC LIMIT 50", requireStr(p.id, "id"))
				.map((e) => ({ ...e, payload: parseJson(e.payload, null) })),
		);
		core.register("cards.tools", () => AVAILABLE_TOOLS.map((tool) => ({ tool, label: toolLabel(tool) })));
	}
}

function notFound(res: ServerResponse): void {
	res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
	res.end("not found");
}

/** A package asset with ETag and single-range support (§1.2; reference serve.js semantics). */
function sendFile(req: IncomingMessage, res: ServerResponse, file: string, headers: Record<string, string>): void {
	let stat;
	try {
		stat = statSync(file);
	} catch {
		return notFound(res);
	}
	if (!stat.isFile()) return notFound(res);
	const etag = `W/"${createHash("sha1").update(`${stat.size}-${stat.mtimeMs}`).digest("hex").slice(0, 16)}"`;
	const base = { ...headers, "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", ETag: etag, "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" };
	if (req.headers["if-none-match"] === etag) {
		res.writeHead(304, { ETag: etag });
		res.end();
		return;
	}
	const match = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? "").trim());
	if (match) {
		const size = stat.size;
		let start: number;
		let end: number;
		if (match[1] === "" && match[2] === "") start = end = Number.NaN;
		else if (match[1] === "") {
			const suffix = Number(match[2]);
			start = suffix > 0 ? Math.max(0, size - suffix) : Number.NaN;
			end = size - 1;
		} else {
			start = Number(match[1]);
			end = match[2] === "" ? size - 1 : Number(match[2]);
		}
		if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || start >= size) {
			res.writeHead(416, { ...base, "Content-Range": `bytes */${size}` });
			res.end();
			return;
		}
		end = Math.min(end, size - 1);
		res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) });
		if (req.method === "HEAD") return void res.end();
		createReadStream(file, { start, end }).pipe(res);
		return;
	}
	res.writeHead(200, { ...base, "Content-Length": String(stat.size) });
	if (req.method === "HEAD") return void res.end();
	createReadStream(file).pipe(res);
}
