import assert from "node:assert/strict";
const normalized = (text: string) => text.replaceAll("\\", "/").replace(/\/{2,}/g, "/").toLowerCase();
/** SDK starts model turns outside the RPC async context; identify the actual isolated cwd instead. */
export class RoutingPromptScopes {
	private workspaces = new Map<string, string>();
	private counts = new Map<string, number>();
	start(id: string, cwd: string): void { this.workspaces.set(id, normalized(cwd)); this.counts.set(id, 0); }
	find(context: unknown, ledgerSlot?: string | null): string {
		const raw = normalized(JSON.stringify(context)), matches = new Set([...this.workspaces].filter(([,cwd]) => raw.includes(cwd)).map(([id]) => id));
		if (ledgerSlot && this.workspaces.has(ledgerSlot)) matches.add(ledgerSlot);
		assert.equal(matches.size, 1, "actual request must belong to exactly one isolated prompt");
		return [...matches][0]!;
	}
	count(id: string): number { return this.counts.get(id) ?? 0; }
	increment(id: string): void { assert.ok(this.workspaces.has(id)); this.counts.set(id, this.count(id)+1); }
}
