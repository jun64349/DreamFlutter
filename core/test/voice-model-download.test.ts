import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { VoiceModel } from "../src/modules/voice/model.ts";

/** 0.13.1 step 3: the SenseVoice model is downloaded on first local use instead of shipped. */
describe("voice model download (0.13.1 step 3)", () => {
	const content = Buffer.from("x".repeat(5000) + "model-bytes");
	const model = { file: "model.int8.onnx", bytes: content.length, sha256: createHash("sha256").update(content).digest("hex"), sources: ["https://a.test/m", "https://b.test/m"] };
	function folders() {
		const root = mkdtempSync(join(tmpdir(), "df-voice-model-"));
		const bundled = join(root, "bundled");
		mkdirSync(bundled);
		for (const name of ["tokens.txt", "silero_vad.onnx"]) writeFileSync(join(bundled, name), name);
		return { root, bundled, downloaded: join(root, "cache", "voice-model") };
	}

	it("falls back to the next source, resumes a partial file and becomes ready", async () => {
		const { root, bundled, downloaded } = folders();
		try {
			mkdirSync(downloaded, { recursive: true });
			writeFileSync(join(downloaded, "model.int8.onnx.part"), content.subarray(0, 1000));
			const asked: string[] = [];
			const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
				asked.push(`${url} ${init.headers.Range ?? "-"}`);
				if (url.startsWith("https://a.test")) return new Response("no", { status: 503 });
				const from = Number(/bytes=(\d+)-/.exec(init.headers.Range ?? "")?.[1] ?? 0);
				return new Response(content.subarray(from), { status: from ? 206 : 200 });
			};
			const events: string[] = [];
			const voice = new VoiceModel(bundled, downloaded, status => events.push(status.state), model, fetchImpl);
			assert.equal(voice.status().state, "absent");
			assert.equal(voice.directory(), undefined);
			await voice.download();
			assert.deepEqual(asked, ["https://a.test/m bytes=1000-", "https://b.test/m bytes=1000-"]);
			assert.equal(voice.directory(), downloaded);
			assert.equal(voice.status().state, "ready");
			assert.deepEqual(readFileSync(join(downloaded, "model.int8.onnx")), content);
			assert.equal(readFileSync(join(downloaded, "tokens.txt"), "utf8"), "tokens.txt");
			assert.equal(events.at(-1), "ready");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("a wrong download is thrown away and reported, never used", async () => {
		const { root, bundled, downloaded } = folders();
		try {
			const voice = new VoiceModel(bundled, downloaded, () => {}, model, async () => new Response("tampered", { status: 200 }));
			await assert.rejects(voice.download());
			assert.equal(voice.directory(), undefined);
			assert.equal(voice.status().state, "failed");
			assert.match(voice.status().error ?? "", /a\.test.*b\.test/);
			assert.equal(existsSync(join(downloaded, "model.int8.onnx")), false);
			assert.equal(existsSync(join(downloaded, "model.int8.onnx.part")), false);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("a model shipped next to the runtime (development checkout) is used as is", () => {
		const { root, bundled, downloaded } = folders();
		try {
			writeFileSync(join(bundled, "model.int8.onnx"), content);
			const voice = new VoiceModel(bundled, downloaded, () => {}, model, async () => { throw new Error("must not download"); });
			assert.equal(voice.directory(), bundled);
			assert.equal(voice.status().state, "ready");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});
