import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { downloadVerified, type Fetch } from "../../net/resumable.ts";

/**
 * The SenseVoice model (228 MB) is no longer shipped (route step 3, user 2026-11-18):
 * the first use of local voice input downloads it from the official sources and keeps
 * it in the cache folder, where it works offline from then on. The small files
 * (tokens, VAD) still ship with the app in core/bin/voice.
 */
export const VOICE_MODEL = {
	file: "model.int8.onnx",
	bytes: 239_233_841,
	sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
	// The model's own Hugging Face repository (sherpa-onnx author); hf-mirror first for users in China.
	sources: [
		"https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx",
		"https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx",
	],
};
const SMALL_FILES = ["tokens.txt", "silero_vad.onnx"];
const VERIFIED = "model.verified";

export type ModelState = "ready" | "absent" | "downloading" | "failed";
export interface ModelStatus { state: ModelState; received: number; total: number; error: string | null }

export class VoiceModel {
	private downloading: Promise<void> | null = null;
	private received = 0;
	private error: string | null = null;
	private lastEvent = 0;
	private readonly abort = new AbortController();

	private readonly bundled: string;
	private readonly downloaded: string;
	private readonly notify: (status: ModelStatus) => void;
	private readonly model: typeof VOICE_MODEL;
	private readonly fetchImpl: Fetch;

	/**
	 * [bundled]: where the app ships the voice runtime (core/bin/voice); a development checkout may have the model there too.
	 * [downloaded]: <cache>/voice-model, the downloaded model next to copies of the small files.
	 */
	constructor(bundled: string, downloaded: string, notify: (status: ModelStatus) => void = () => {}, model = VOICE_MODEL,
		fetchImpl: Fetch = (url, init) => fetch(url, init)) {
		this.bundled = bundled;
		this.downloaded = downloaded;
		this.notify = notify;
		this.model = model;
		this.fetchImpl = fetchImpl;
	}

	/** The folder the recognizer loads; undefined until the model is there. */
	directory(): string | undefined {
		if (existsSync(join(this.bundled, this.model.file))) return this.bundled;
		const verified = join(this.downloaded, VERIFIED);
		try {
			if (readFileSync(verified, "utf8").trim() === this.model.sha256 && statSync(join(this.downloaded, this.model.file)).size === this.model.bytes &&
				SMALL_FILES.every(name => existsSync(join(this.downloaded, name)))) return this.downloaded;
		} catch { /* not downloaded yet */ }
		return undefined;
	}

	status(): ModelStatus {
		if (this.directory()) return { state: "ready", received: this.model.bytes, total: this.model.bytes, error: null };
		return { state: this.downloading ? "downloading" : this.error ? "failed" : "absent", received: this.received, total: this.model.bytes, error: this.error };
	}

	/** Starts (or joins) the download; resolves when the model is ready. */
	download(): Promise<void> {
		if (this.directory()) return Promise.resolve();
		this.downloading ??= this.run().finally(() => { this.downloading = null; this.notify(this.status()); });
		return this.downloading;
	}

	dispose(): void { this.abort.abort(); }

	private async run(): Promise<void> {
		this.error = null;
		mkdirSync(this.downloaded, { recursive: true });
		const target = join(this.downloaded, this.model.file);
		try {
			await downloadVerified(this.model, target, { signal: this.abort.signal, fetchImpl: this.fetchImpl, onProgress: (received) => {
				this.received = received;
				const now = Date.now();
				if (now - this.lastEvent > 500) { this.lastEvent = now; this.notify(this.status()); }
			} });
		} catch (error) {
			if (this.abort.signal.aborted) throw error;
			this.error = `语音模型下载失败（${error instanceof Error ? error.message : String(error)}）。请检查网络后再试。`;
			throw new Error(this.error);
		}
		for (const name of SMALL_FILES) copyFileSync(join(this.bundled, name), join(this.downloaded, name));
		writeFileSync(join(this.downloaded, VERIFIED), this.model.sha256, "utf8");
		this.received = this.model.bytes;
	}
}
