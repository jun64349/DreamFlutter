import { appendFileSync, renameSync, statSync } from "node:fs";
import { redact } from "./security/redaction.ts";

type Level = "info" | "warn" | "error";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Append-only file logger; the core usually runs detached with no console. */
export class Logger {
	private readonly file: string | undefined;
	private readonly echo: boolean;

	constructor(file?: string, echo = false) {
		this.file = file;
		this.echo = echo;
		if (file) this.rotate(file);
	}

	info(message: string, detail?: unknown): void {
		this.write("info", message, detail);
	}

	warn(message: string, detail?: unknown): void {
		this.write("warn", message, detail);
	}

	error(message: string, detail?: unknown): void {
		this.write("error", message, detail);
	}

	private write(level: Level, message: string, detail?: unknown): void {
		const suffix = detail === undefined ? "" : ` ${formatDetail(detail)}`;
		const line = redact(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}\n`, true);
		if (this.echo) process.stderr.write(line);
		if (!this.file) return;
		try {
			appendFileSync(this.file, line);
		} catch {
			// Logging must never take the core down.
		}
	}

	private rotate(file: string): void {
		try {
			if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
		} catch {
			// Missing file: nothing to rotate.
		}
	}
}

function formatDetail(detail: unknown): string {
	if (detail instanceof Error) return detail.stack ?? detail.message;
	if (typeof detail === "string") return detail;
	try {
		return JSON.stringify(detail);
	} catch {
		return String(detail);
	}
}

export const silentLogger = new Logger();
