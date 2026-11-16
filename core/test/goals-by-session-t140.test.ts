import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { normalizeCwd } from "../src/core.ts";
import { startTestCore } from "./harness.ts";

it("returns the latest goal for each original session path, including task links and terminal goals", async () => {
	const t = await startTestCore();
	try {
		const a = join(t.dir, "A.jsonl"), b = join(t.dir, "B.jsonl"), c = join(t.dir, "C.jsonl");
		const add = (id: string, file: string | null, at: number, partition = "workbench") => t.core.db.run(
			`INSERT INTO goals(id,title,origin_text,spec,scope,mandate_ref,source,status,created_at,updated_at,session_file)
			 VALUES(?,?,?,'{}',?,'user:test','user','completed',?,?,?)`, id, id, id,
			JSON.stringify({ cwd: t.workspace, partition, sandbox: partition === "butterfly" }), at, at, file);
		add("old", a, 1); add("new", a, 2); add("task-only", null, 3, "butterfly");
		t.core.db.run(`INSERT INTO tasks(id,title,goal,cwd,cwd_key,session_file,source,status,created_at,updated_at,goal_id)
			VALUES('t','t','t',?,?,?,'user','done',1,1,'task-only')`, t.workspace, normalizeCwd(t.workspace), b);
		const query = [a.toUpperCase(), b, c];
		const result = await t.core.call("goals.bySession", { sessionFiles: query }) as { goals: Record<string, { id: string } | null> };
		assert.deepEqual(Object.keys(result.goals), query);
		assert.equal(result.goals[query[0]!]!.id, "new");
		assert.equal(result.goals[b]!.id, "task-only");
		assert.equal(result.goals[c], null);
		const filtered = await t.core.call("goals.bySession", { sessionFiles: [a, b], partition: "workbench" }) as { goals: Record<string, { id: string } | null> };
		assert.equal(filtered.goals[a]!.id, "new");
		assert.equal(filtered.goals[b], null);
		for (const sessionFiles of [[], Array(201).fill(a)]) await assert.rejects(t.core.call("goals.bySession", { sessionFiles }), { code: "bad_request" });
	} finally { await t.cleanup(); }
});
