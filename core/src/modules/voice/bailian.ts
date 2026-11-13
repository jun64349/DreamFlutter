import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { RpcError } from "../../core.ts";
import type { VoiceInput, VoiceProvider, VoiceStream } from "./provider.ts";

const model = "paraformer-realtime-v2";
const defaults = {
	websocket: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
	vocabulary: "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/customization",
	timeoutMs: 10_000,
};
const auth = () => new RpcError("forbidden", "百炼未接受语音 Key，请检查 Key 和权限。");
const network = () => new RpcError("unavailable", "百炼语音连接已断开，请检查网络。");
const timeout = () => new RpcError("unavailable", "百炼语音服务响应超时。");
const failed = () => new RpcError("unavailable", "百炼暂时无法完成语音识别。");
const cancelled = () => new RpcError("cancelled", "语音识别已结束。");

function gate() {
	let resolve!: () => void;
	let reject!: (error: RpcError) => void;
	const promise = new Promise<void>((ok, bad) => { resolve = ok; reject = bad; });
	void promise.catch(() => {});
	return { promise, resolve, reject };
}

export class BailianProvider implements VoiceProvider {
	private readonly key: () => Promise<string>;
	private readonly endpoints: typeof defaults;
	private readonly cleanupFailed: () => void;

	constructor(
		key: () => Promise<string>,
		endpoints: typeof defaults = defaults,
		cleanupFailed: () => void = () => {},
	) {
		this.key = key;
		this.endpoints = endpoints;
		this.cleanupFailed = cleanupFailed;
	}

	private async vocabulary(key: string, input: object): Promise<unknown> {
		const signal = AbortSignal.timeout(this.endpoints.timeoutMs);
		try {
			const response = await fetch(this.endpoints.vocabulary, {
				method: "POST", redirect: "error", signal,
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model: "speech-biasing", input }),
			});
			if (response.status === 401 || response.status === 403) throw auth();
			if (!response.ok) throw new RpcError("unavailable", "百炼热词表无法更新，请检查主业务空间权限。");
			return await response.json();
		} catch (error) {
			throw error instanceof RpcError ? error : signal.aborted ? timeout() : network();
		}
	}

	async open(input: VoiceInput): Promise<VoiceStream> {
		const key = await this.key();
		if (!key) throw new RpcError("unavailable", "请先在设置中填写百炼语音识别 Key。");
		if (input.signal.aborted) throw cancelled();
		const taskId = randomUUID();
		let vocabularyId: string | undefined;
		if (input.hotwords.length) {
			const result = await this.vocabulary(key, {
				action: "create_vocabulary", target_model: model, prefix: "df" + taskId.slice(0, 8),
				vocabulary: input.hotwords.map(text => ({ text, weight: 4 })),
			}) as { output?: { vocabulary_id?: unknown } } | null;
			const id = result?.output?.vocabulary_id;
			if (typeof id !== "string" || !id) throw new RpcError("unavailable", "百炼未返回热词表编号。");
			vocabularyId = id;
		}
		const cleanup = async () => {
			if (!vocabularyId) return;
			const id = vocabularyId;
			vocabularyId = undefined;
			try { await this.vocabulary(key, { action: "delete_vocabulary", vocabulary_id: id }); }
			catch { this.cleanupFailed(); }
		};
		if (input.signal.aborted) {
			void cleanup();
			throw cancelled();
		}
		const socket = new WebSocket(this.endpoints.websocket, {
			headers: { Authorization: `Bearer ${key}` },
			handshakeTimeout: this.endpoints.timeoutMs,
			maxPayload: 256 * 1024,
		});
		const start = gate();
		const finish = gate();
		let stage: "starting" | "running" | "finishing" | "closed" = "starting";
		let deadline: NodeJS.Timeout;
		const stop = (error?: RpcError) => {
			if (stage === "closed") return;
			const previous = stage;
			stage = "closed";
			clearTimeout(deadline);
			input.signal.removeEventListener("abort", abort);
			socket.terminate();
			void cleanup();
			if (error) {
				start.reject(error);
				finish.reject(error);
				if (previous === "running" && !input.signal.aborted) input.fail(error);
			}
		};
		const abort = () => stop(cancelled());
		input.signal.addEventListener("abort", abort, { once: true });
		const arm = () => { deadline = setTimeout(() => stop(timeout()), this.endpoints.timeoutMs); };
		arm();
		const send = (data: string | Buffer) => new Promise<void>((resolve, reject) => {
			if (socket.readyState !== WebSocket.OPEN) { reject(network()); return; }
			socket.send(data, error => error ? reject(network()) : resolve());
		});
		const command = (action: string, payload: object) => send(JSON.stringify({
			header: { action, task_id: taskId, streaming: "duplex" }, payload,
		}));
		socket.on("open", () => void command("run-task", {
			task_group: "audio", task: "asr", function: "recognition", model, input: {},
			parameters: { format: "pcm", sample_rate: 16000, vocabulary_id: vocabularyId, punctuation_prediction_enabled: true },
		}).catch(() => stop(network())));
		socket.on("unexpected-response", (request, response) => {
			response.resume();
			request.destroy();
			stop(response.statusCode === 401 || response.statusCode === 403 ? auth() : network());
		});
		socket.on("error", () => stop(network()));
		socket.on("close", () => stop(network()));
		socket.on("message", (data, binary) => {
			if (binary || stage === "closed") return;
			try {
				const event = JSON.parse(data.toString());
				if (event.header?.task_id !== taskId) return;
				switch (event.header.event) {
					case "task-started":
						if (stage === "starting") {
							clearTimeout(deadline);
							stage = "running";
							start.resolve();
						}
						break;
					case "result-generated": {
						if (stage !== "running" && stage !== "finishing") break;
						const sentence = event.payload?.output?.sentence;
						if (sentence?.heartbeat !== true && typeof sentence?.text === "string") {
							input.emit({ kind: sentence.sentence_end === true ? "final" : "partial", text: sentence.text });
						}
						break;
					}
					case "task-finished":
						if (stage === "finishing") { finish.resolve(); stop(); }
						break;
					case "task-failed":
						stop(/auth|unauthor|invalidapikey|forbidden/i.test(String(event.header.error_code ?? "")) ? auth() : failed());
						break;
				}
			} catch { stop(failed()); }
		});
		await start.promise;
		return {
			chunk: pcm => send(pcm),
			end: async () => {
				if (stage !== "running") throw network();
				stage = "finishing";
				arm();
				try { await command("finish-task", { input: {} }); await finish.promise; }
				catch (error) { stop(network()); throw error; }
			},
			cancel: abort,
		};
	}
}

