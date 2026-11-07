import { StringDecoder } from "node:string_decoder";
import type { JobRegistry } from "../agent/shell.ts";
import { redact } from "./redaction.ts";

/** Line buffering keeps split UTF-8/keys and PEM blocks out of the shell's spill files. */
export function protectJobOutput(jobs: JobRegistry, masked: () => void): JobRegistry {
	const start = jobs.start.bind(jobs);
	jobs.start = (kind, label, child, stdout, stderr, timeoutKill) => {
		for (const [stream, pipe] of [[stdout, child.stdout], [stderr, child.stderr]] as const) {
			const decoder = new StringDecoder("utf8");
			const push = stream.push.bind(stream);
			let pending = "", privateKey = false, overflow = false;
			const emit = (text: string) => {
				let safe = text;
				if (privateKey) {
					const end = /-----END (?:[A-Z]+ )*PRIVATE KEY-----/.exec(text);
					if (!end) return;
					safe = text.slice(end.index + end[0].length); privateKey = false;
				}
				const begin = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/.exec(safe);
				if (begin && !/-----END (?:[A-Z]+ )*PRIVATE KEY-----/.test(safe.slice(begin.index))) privateKey = true;
				safe = redact(safe);
				if (safe !== text) masked();
				if (safe) push(Buffer.from(safe));
			};
			stream.push = (chunk: Buffer) => {
				pending += decoder.write(chunk);
				let newline: number;
				while ((newline = pending.indexOf("\n")) >= 0) {
					const line = pending.slice(0, newline + 1); pending = pending.slice(newline + 1);
					if (overflow) { overflow = false; continue; }
					emit(line);
				}
				if (pending.length > 1024 * 1024) { if (!overflow) push(Buffer.from("[单行输出超过缓存上限，已省略]\n")); overflow = true; pending = ""; }
			};
			pipe?.once("end", () => { pending += decoder.end(); if (!overflow) emit(pending); pending = ""; });
		}
		return start(kind, redact(label), child, stdout, stderr, timeoutKill);
	};
	return jobs;
}
