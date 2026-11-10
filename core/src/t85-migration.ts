/** Migration 16, explicitly assigned to T-85; T-83 may append 17 if needed. */
export const T85_MIGRATION = `
CREATE TABLE memory_boundary_decisions (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL,
 before_task TEXT, after_task TEXT NOT NULL, changed INTEGER NOT NULL, undone_at INTEGER
);
CREATE INDEX memory_boundary_session ON memory_boundary_decisions(session_id, at);
CREATE TABLE memory_reply_receipts (
 batch_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, session_file TEXT, run_id TEXT,
 tool_call_id TEXT, entry_id TEXT, at INTEGER NOT NULL, pending_id TEXT
);
CREATE TABLE session_recycle (
 batch_id TEXT NOT NULL, original_path TEXT PRIMARY KEY, stored_path TEXT NOT NULL UNIQUE,
 deleted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, phase TEXT NOT NULL,
 metadata TEXT NOT NULL
);
CREATE INDEX session_recycle_batch ON session_recycle(batch_id);
CREATE TABLE butterfly_intents (
 id TEXT PRIMARY KEY, slot_id TEXT NOT NULL, task_id TEXT NOT NULL, goal TEXT NOT NULL,
 restatement TEXT NOT NULL, plan TEXT NOT NULL, state TEXT NOT NULL,
 created_at INTEGER NOT NULL, start_at INTEGER, missing TEXT, error TEXT
);
CREATE INDEX butterfly_intents_due ON butterfly_intents(state,start_at);
`;
