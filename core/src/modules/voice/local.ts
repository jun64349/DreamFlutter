import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { RpcError } from "../../core.ts";
import { APP_ROOT } from "../../paths.ts";
import { voiceFailed, type Transcript, type VoiceInput, type VoiceProvider, type VoiceStream } from "./provider.ts";

type WorkerReply = { id: number; results?: Transcript[]; failed?: boolean; missing?: boolean };
const cancelled = () => new RpcError("cancelled", "语音识别已结束。");

export class LocalProvider implements VoiceProvider {
	private child?: ChildProcess;
	private idle?: NodeJS.Timeout;
	private nextId = 0;
	private readonly idleMinutes: () => number;
	private readonly directory: string;

	constructor(idleMinutes: () => number, directory = join(APP_ROOT, "core/bin/voice")) {
		this.idleMinutes = idleMinutes;
		this.directory = directory;
	}

	dispose(): void {
		clearTimeout(this.idle);
		const child = this.child;
		this.child = undefined;
		child?.kill();
	}

	async open(input: VoiceInput): Promise<VoiceStream> {
		clearTimeout(this.idle);
		if (input.signal.aborted) throw cancelled();
		if (!this.child) {
			const worker = fileURLToPath(new URL("./worker.ts", import.meta.url));
			const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", worker, this.directory], {
				serialization: "advanced",
				stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
			});
			const exited = () => { if (this.child === child) this.child = undefined; };
			child.on("error", exited);
			child.once("exit", exited);
			this.child = child;
		}
		const child = this.child;
		let ended = false;
		const cancel = () => {
			input.signal.removeEventListener("abort", cancel);
			if (ended || this.child !== child) return;
			this.dispose();
		};
		input.signal.addEventListener("abort", cancel, { once: true });
		const request = (action: "open" | "chunk" | "end", pcm?: Buffer): Promise<void> => new Promise((resolve, reject) => {
			if (input.signal.aborted) { reject(cancelled()); return; }
			if (!child.connected) { reject(voiceFailed()); return; }
			const id = ++this.nextId;
			const done = (error?: RpcError) => {
				clearTimeout(deadline);
				child.off("message", message);
				child.off("exit", died);
				child.off("error", died);
				input.signal.removeEventListener("abort", abort);
				if (error) reject(error);
				else resolve();
			};
			const died = () => done(voiceFailed());
			const abort = () => done(cancelled());
			const message = (reply: WorkerReply) => {
				if (reply.id !== id) return;
				if (reply.failed) done(reply.missing ? new RpcError("model_unavailable", "本地语音模型缺失，请重新准备语音运行时。") : voiceFailed());
				else {
					try { for (const result of reply.results ?? []) input.emit(result); }
					catch { done(voiceFailed()); return; }
					done();
				}
			};
			const deadline = setTimeout(() => {
				done(new RpcError("unavailable", "本地语音识别响应超时。"));
				cancel();
			}, 30_000);
			child.on("message", message);
			child.once("exit", died);
			child.once("error", died);
			input.signal.addEventListener("abort", abort, { once: true });
			child.send({ id, action, pcm }, error => { if (error) died(); });
		});
		try { await request("open"); }
		catch (error) { cancel(); throw error; }
		return {
			chunk: pcm => request("chunk", pcm),
			end: async () => {
				await request("end");
				ended = true;
				this.idle = setTimeout(() => this.dispose(), this.idleMinutes() * 60_000);
				this.idle.unref();
			},
			cancel,
		};
	}
}

