import type { FailureKind } from "./classify.ts";
import type { Unavailable } from "./router.ts";

const BASE_REST_MS = 30_000;
const MAX_REST_MS = 10 * 60_000;
/** Quota and balance without a known reset time: look again after this long. */
const UNKNOWN_RESET_MS = 30 * 60_000;

interface KeyHealth {
	failures: number;
	kind: FailureKind;
	message: string;
	/** Resting until (ms). Undefined with [stopped] = until the user edits the key. */
	until?: number;
	stopped: boolean;
}

/**
 * Circuit breaker per key ("channel#key"). A failed key rests, doubling on
 * repeated failures; when the rest is over the next request tries it again
 * (one real request, no extra probe that would cost money). An invalid key
 * stops until the user changes it.
 */
export class HealthBook {
	private readonly keys = new Map<string, KeyHealth>();
	private readonly clock: () => number;

	constructor(clock: () => number = Date.now) {
		this.clock = clock;
	}

	status(key: string): Unavailable | null {
		const health = this.keys.get(key);
		if (!health) return null;
		if (health.stopped) return { kind: health.kind, message: health.message };
		if (health.until !== undefined && health.until > this.clock()) return { kind: health.kind, message: health.message, until: health.until };
		return null;
	}

	/** Records a failure. [resetAt] is when a plan's window reopens, if known. */
	fail(key: string, kind: FailureKind, message: string, resetAt?: number): void {
		if (kind === "other") return;
		const failures = (this.keys.get(key)?.failures ?? 0) + 1;
		const now = this.clock();
		if (kind === "auth") {
			this.keys.set(key, { failures, kind, message, stopped: true });
			return;
		}
		const until =
			kind === "quota" || kind === "balance"
				? (resetAt && resetAt > now ? resetAt : now + UNKNOWN_RESET_MS)
				: now + Math.min(MAX_REST_MS, BASE_REST_MS * 2 ** (failures - 1));
		this.keys.set(key, { failures, kind, message, until, stopped: false });
	}

	succeed(key: string): void {
		this.keys.delete(key);
	}

	/** The user edited the key or channel: try it again. */
	reset(prefix: string): void {
		for (const key of [...this.keys.keys()]) if (key === prefix || key.startsWith(`${prefix}#`)) this.keys.delete(key);
	}

	/** A plan's allowance came back early (quota query): stop resting on it. */
	clearQuota(prefix: string): void {
		for (const [key, health] of this.keys) {
			if ((key === prefix || key.startsWith(`${prefix}#`)) && (health.kind === "quota" || health.kind === "balance")) this.keys.delete(key);
		}
	}

	snapshot(): Record<string, Unavailable> {
		const out: Record<string, Unavailable> = {};
		for (const key of this.keys.keys()) {
			const status = this.status(key);
			if (status) out[key] = status;
		}
		return out;
	}
}
