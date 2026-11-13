import type { Db } from "../../db.ts";

export type SelfworkSource = "goal" | "learning" | "skill";
export interface SelfworkDraft {
	refId: string;
	source: SelfworkSource;
	mandateRef: string;
	title: string;
	instruction: string;
	cwd: string;
	sandbox: true;
	deliverable: string;
}

export interface SelfworkDelivery {
	goalId: string;
	files: string[];
	explanation: string;
}

export interface SelfworkGrant {
	run_id: string;
	goal_id: string;
	mandate_id: string;
	source: SelfworkSource;
	source_ref: string;
	deliverable: string;
	paused_day: string | null;
	delivery: string | null;
}

export function selfworkGrant(db: Db, goalId: string): SelfworkGrant | undefined {
	return db.get<SelfworkGrant>("SELECT * FROM goal_selfwork WHERE goal_id=?", goalId);
}

export function selfworkDeliverable(refId: string): string {
	return `/workspace/outbox/selfwork-${refId}.md`;
}
