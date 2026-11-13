import { ftruncateSync, writeSync } from "node:fs";
import { redact } from "../../src/security/redaction.ts";

export function writeReport(out: number, report: unknown): void {
	const data = Buffer.from(JSON.stringify(report, null, 2) + "\n");
	let offset = 0;
	while (offset < data.length) offset += writeSync(out, data, offset, data.length - offset, offset);
	ftruncateSync(out, data.length);
}

export async function cleanupStep(errors: Record<string, string>, step: string, operation: () => void | Promise<void>): Promise<boolean> {
	try { await operation(); return true; }
	catch (error) {
		errors[step] = redact(error instanceof Error ? error.message : String(error), true);
		return false;
	}
}
