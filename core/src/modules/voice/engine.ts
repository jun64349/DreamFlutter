import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Transcript } from "./provider.ts";

const rate = 16_000;
const windowSize = 512;
const preRoll = rate * 0.45;
const firstUtteranceLead = rate;
const ringCapacity = 21 * rate;

type Stream = { acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void };
type Recognizer = { createStream(): Stream; decode(stream: Stream): void; getResult(stream: Stream): { text: string } };
type Detector = {
	acceptWaveform(samples: Float32Array): void; isDetected(): boolean; isEmpty(): boolean;
	front(copy: false): { start: number; samples: Float32Array }; pop(): void; reset(): void; flush(): void;
};
type Sherpa = {
	OfflineRecognizer: new (config: object) => Recognizer;
	Vad: new (config: object, bufferSeconds: number) => Detector;
	readWave(path: string): { samples: Float32Array; sampleRate: number };
};

export function loadEngine(directory: string) {
	const model = join(directory, "model.int8.onnx");
	const tokens = join(directory, "tokens.txt");
	const vadPath = join(directory, "silero_vad.onnx");
	if (![model, tokens, vadPath].every(existsSync)) throw new Error("missing");
	const sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as Sherpa;
	const recognizer = new sherpa.OfflineRecognizer({
		featConfig: { sampleRate: rate, featureDim: 80 },
		modelConfig: { senseVoice: { model, language: "auto", useInverseTextNormalization: 1 },
			tokens, numThreads: 2, provider: "cpu", debug: 0 },
	});
	const vad = new sherpa.Vad({
		sileroVad: { model: vadPath, threshold: 0.5, minSilenceDuration: 0.45, minSpeechDuration: 0.2, maxSpeechDuration: 15, windowSize },
		sampleRate: rate, numThreads: 1, provider: "cpu", debug: 0,
	}, 20);
	const ring = new Float32Array(ringCapacity);
	let written = 0;
	let vadOffset = 0;
	let previousEnd = 0;
	let previewStart = 0;
	let previewSamples = 0;

	function read(start: number, end: number): Float32Array {
		const from = Math.max(start, written - ringCapacity, 0);
		const size = Math.max(0, end - from);
		const result = new Float32Array(size);
		const index = from % ringCapacity;
		const first = Math.min(size, ringCapacity - index);
		result.set(ring.subarray(index, index + first));
		result.set(ring.subarray(0, size - first), first);
		return result;
	}

	function recognize(samples: Float32Array): string {
		const stream = recognizer.createStream();
		stream.acceptWaveform({ samples, sampleRate: rate });
		recognizer.decode(stream);
		return recognizer.getResult(stream).text.trim();
	}

	function drain(results: Transcript[]): void {
		while (!vad.isEmpty()) {
			const { start, samples } = vad.front(false);
			const end = Math.min(written, start + samples.length);
			vad.pop();
			// The VAD start may fall after the first phoneme. Do not read back into
			// an already emitted segment when two utterances are close together.
			const lead = previousEnd === 0 && start <= firstUtteranceLead ? firstUtteranceLead : preRoll;
			const audio = read(Math.max(previousEnd, start - lead), end);
			if (audio.length) results.push({ kind: "final", text: recognize(audio) });
			previousEnd = end;
			previewSamples = 0;
		}
	}

	return {
		readWave: sherpa.readWave,
		reset() {
			vad.reset();
			written = vadOffset = previousEnd = previewStart = previewSamples = 0;
		},
		chunk(pcm: Buffer) {
			const results: Transcript[] = [];
			for (let i = 0; i + 1 < pcm.length; i += 2) {
				ring[written++ % ringCapacity] = pcm.readInt16LE(i) / 32768;
				if (written - vadOffset !== windowSize) continue;
				// Give Silero exactly the same windows regardless of transport chunk size.
				const wasSpeaking = vad.isDetected();
				vad.acceptWaveform(read(vadOffset, written));
				vadOffset = written;
				drain(results);
				if (!vad.isDetected()) { previewSamples = 0; continue; }
				if (!wasSpeaking || previewStart < previousEnd) {
					previewStart = Math.max(previousEnd, written - rate);
				}
				previewSamples += windowSize;
				if (previewSamples >= rate * 2) {
					results.push({ kind: "partial", text: recognize(read(previewStart, written)) });
					previewSamples = 0;
				}
			}
			return results;
		},
		end() {
			if (written > vadOffset) {
				const tail = new Float32Array(windowSize);
				tail.set(read(vadOffset, written));
				vad.acceptWaveform(tail);
			}
			vad.flush();
			const results: Transcript[] = [];
			drain(results);
			return results;
		},
	};
}
