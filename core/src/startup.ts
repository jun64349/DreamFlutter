export interface StartupPhase { name: string; text: string; at: number; durationMs: number; }
export interface StartupState { phases: StartupPhase[]; current: StartupPhase | null; ready: boolean; }

/** Records real phase boundaries; early phases can be streamed before WebSocket discovery. */
export class StartupProgress {
	private readonly phases: StartupPhase[] = [];
	private phaseAt = performance.now();
	private ready = false;
	private readonly listeners = new Set<(state: StartupState) => void>();
	onChange(listener: (state: StartupState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	mark(name: string, text: string, ready = false): void {
		const at = performance.now();
		this.phases.push({ name, text, at: Date.now(), durationMs: Math.round(at - this.phaseAt) });
		this.phaseAt = at; this.ready = ready;
		for (const listener of this.listeners) listener(this.snapshot());
	}
	snapshot(): StartupState { return { phases: this.phases.map(p => ({ ...p })), current: this.phases.length ? { ...this.phases.at(-1)! } : null, ready: this.ready }; }
}
