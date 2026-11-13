import { RpcError } from "../../core.ts";

export type Transcript = { kind: "partial" | "final"; text: string };
export type VoiceInput = {
	hotwords: readonly string[];
	signal: AbortSignal;
	emit(result: Transcript): void;
	fail(error: RpcError): void;
};

export interface VoiceStream {
	chunk(pcm: Buffer): Promise<void>;
	end(): Promise<void>;
	cancel(): void;
}

export interface VoiceProvider {
	open(input: VoiceInput): Promise<VoiceStream>;
}

export const noAudio = () => new RpcError("invalid_params", "没有收到麦克风音频。");
export const voiceFailed = () => new RpcError("unavailable", "语音识别暂时无法使用。");

