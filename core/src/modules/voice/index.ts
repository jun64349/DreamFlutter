import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { RpcError, type Client, type Core, type CoreModule, type Params } from "../../core.ts";
import { SecretStore } from "../secrets.ts";
import { BailianProvider } from "./bailian.ts";
import { correctHotwords, memoryHotwords } from "./hotwords.ts";
import { LocalProvider } from "./local.ts";
import { noAudio, voiceFailed, type VoiceProvider, type VoiceStream } from "./provider.ts";

export type VoiceEvent =
	| { event: "voice.partial"; sessionId: string; text: string }
	| { event: "voice.final"; sessionId: string; text: string; rawText: string }
	| { event: "voice.error"; sessionId: string; code: string; message: string };

type Owner = Client | ((event: VoiceEvent) => void);
type Active = {
	id: string;
	owner: Owner;
	abort: AbortController;
	stream?: VoiceStream;
	timer?: NodeJS.Timeout;
	disconnected?: NodeJS.Timeout;
	busy: boolean;
	received: boolean;
};

const busy = () => new RpcError("busy", "已有一路语音识别正在进行。");
const invalid = (message: string) => new RpcError("invalid_params", message);
function punctuation(text: string): string {
	if (/[.!?…。！？。]['"」』）)]*$/u.test(text)) return text;
	return text + (/\p{Script=Han}/u.test(text) ? "。" : ".");
}

export class VoiceModule implements CoreModule {
	private active?: Active;
	private readonly local: LocalProvider;
	private readonly providers: ReadonlyMap<string, VoiceProvider>;
	private readonly secrets: SecretStore;
	private readonly core: Core;
	private stopped = false;

	constructor(core: Core, providers?: ReadonlyMap<string, VoiceProvider>) {
		this.core = core;
		this.secrets = new SecretStore(core.paths.dataDir);
		this.local = new LocalProvider(() => core.settings.get().voiceIdleMinutes);
		this.providers = providers ?? new Map<string, VoiceProvider>([
			["local", this.local],
			["bailian", new BailianProvider(async () => {
				try { return await this.secrets.get("voice-bailian"); }
				catch { throw new RpcError("unavailable", "请先在设置中填写百炼语音识别 Key。"); }
			}, undefined, () => core.log.warn("百炼语音临时热词表删除失败。"))],
		]);
		core.register("voice.start", (p, c) => this.startRecognition(this.window(c), this.workspace(p)));
		core.register("voice.chunk", (p, c) => this.chunk(this.window(c), p.sessionId, decode(p.pcm)));
		core.register("voice.end", (p, c) => this.end(this.window(c), p.sessionId));
		core.register("voice.cancel", (p, c) => this.cancel(this.window(c), p.sessionId));
		core.register("voice.keyStatus", (_, c) => {
			this.window(c);
			return { configured: existsSync(this.secrets.fileFor("voice-bailian")) };
		});
		core.register("voice.setKey", async (p, c) => {
			this.window(c);
			if (p.key !== null && (typeof p.key !== "string" || !/^[\x21-\x7e]{1,512}$/.test(p.key))) {
				throw invalid("请输入有效的百炼 Key，或用空值清除。");
			}
			try {
				if (p.key === null) this.secrets.remove("voice-bailian");
				else await this.secrets.put("voice-bailian", p.key);
			} catch { throw new RpcError("unavailable", "语音识别 Key 无法保存，请检查系统的密钥存储。"); }
			return { configured: p.key !== null };
		});
	}

	private window(client?: Client): Client {
		if (!client || !this.core.clients.has(client)) throw new RpcError("forbidden", "语音接口需要已连接的窗口。");
		return client;
	}

	private workspace(p: Params): string | undefined {
		if (p.workspaceId === undefined) return undefined;
		if (typeof p.workspaceId !== "string" || !p.workspaceId || p.workspaceId.length > 128) throw invalid("工作区无效。");
		return p.workspaceId;
	}

	async startRecognition(owner: Owner, workspaceId?: string): Promise<{ sessionId: string }> {
		if (this.stopped) throw voiceFailed();
		if (this.active && typeof this.active.owner !== "function" && !this.core.clients.has(this.active.owner)) this.release(this.active);
		if (this.active) throw busy();
		const settings = this.core.settings.get();
		const provider = this.providers.get(settings.voiceMode === "local" ? "local" : settings.voiceCloudProvider);
		if (!provider) throw new RpcError("unavailable", "所选语音识别服务不可用。");
		const hotwords = memoryHotwords(this.core, workspaceId);
		const active: Active = { id: randomUUID(), owner, abort: new AbortController(), busy: true, received: false };
		this.active = active;
		if (typeof owner !== "function") {
			active.disconnected = setInterval(() => {
				if (!this.core.clients.has(owner)) this.release(active);
			}, 50);
			active.disconnected.unref();
		}
		try {
			const stream = await provider.open({
				hotwords, signal: active.abort.signal,
				fail: error => this.fail(active, error),
				emit: ({ kind, text }) => {
					if (this.active !== active || !text.trim()) return;
					if (kind === "partial") this.emit(active, { event: "voice.partial", sessionId: active.id, text });
					else this.emit(active, { event: "voice.final", sessionId: active.id, rawText: text, text: punctuation(correctHotwords(text, hotwords)) });
				},
			});
			if (active.abort.signal.aborted) {
				stream.cancel();
				throw new RpcError("cancelled", "语音识别已结束。");
			}
			active.stream = stream;
			active.busy = false;
			this.arm(active);
			return { sessionId: active.id };
		} catch (error) {
			const safe = error instanceof RpcError ? error : voiceFailed();
			// Before the session ID is returned, the start response carries setup errors.
			this.release(active);
			throw safe;
		}
	}

	private emit(active: Active, event: VoiceEvent): void {
		if (typeof active.owner === "function") active.owner(event);
		else if (this.core.clients.has(active.owner)) active.owner.send(event);
	}

	private require(owner: Owner, id: unknown): Active {
		const active = this.active;
		if (!active || active.id !== id || active.owner !== owner) throw new RpcError("not_found", "这一路语音识别已结束或不属于当前窗口。");
		return active;
	}

	private release(active: Active): void {
		if (this.active !== active) return;
		this.active = undefined;
		clearTimeout(active.timer);
		clearInterval(active.disconnected);
		active.abort.abort();
		active.stream?.cancel();
	}

	private fail(active: Active, error: RpcError): void {
		if (this.active !== active) return;
		const hadStream = active.stream !== undefined;
		this.release(active);
		if (hadStream) this.emit(active, { event: "voice.error", sessionId: active.id, code: error.code, message: error.message });
	}

	private arm(active: Active): void {
		clearTimeout(active.timer);
		active.timer = setTimeout(() => this.fail(active, active.received ?
			new RpcError("unavailable", "太久没有收到新的麦克风音频，语音识别已结束。") : noAudio()), 15_000);
		active.timer.unref();
	}

	async chunk(owner: Owner, id: unknown, pcm: Buffer): Promise<{ accepted: true }> {
		const active = this.require(owner, id);
		if (active.busy || !active.stream) throw busy();
		if (!Buffer.isBuffer(pcm) || pcm.length < 3200 || pcm.length > 6400 || pcm.length % 2) throw invalid("每块应为 100–200 毫秒的 16 kHz 单声道 16 位 PCM。");
		clearTimeout(active.timer);
		active.received = true;
		active.busy = true;
		try {
			await active.stream.chunk(pcm);
			if (this.active === active) this.arm(active);
			return { accepted: true };
		} catch (error) {
			const safe = error instanceof RpcError ? error : voiceFailed();
			this.fail(active, safe);
			throw safe;
		} finally { active.busy = false; }
	}

	async end(owner: Owner, id: unknown): Promise<{ ended: true }> {
		const active = this.require(owner, id);
		if (active.busy || !active.stream) throw busy();
		clearTimeout(active.timer);
		active.busy = true;
		try {
			if (!active.received) throw noAudio();
			await active.stream.end();
			return { ended: true };
		} catch (error) {
			const safe = error instanceof RpcError ? error : voiceFailed();
			this.fail(active, safe);
			throw safe;
		} finally { this.release(active); }
	}

	cancel(owner: Owner, id: unknown): { cancelled: true } {
		this.release(this.require(owner, id));
		return { cancelled: true };
	}

	stop(): void {
		this.stopped = true;
		if (this.active) this.release(this.active);
		this.local.dispose();
	}
}

function decode(value: unknown): Buffer {
	if (typeof value !== "string" || value.length < 4268 || value.length > 8536 || value.length % 4 ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw invalid("音频块需要使用 Base64 编码。");
	const pcm = Buffer.from(value, "base64");
	if (pcm.toString("base64") !== value) throw invalid("音频块需要使用标准 Base64 编码。");
	return pcm;
}

