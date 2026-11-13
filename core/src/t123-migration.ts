export const T123_MIGRATION = `
	ALTER TABLE selfwork_runs ADD COLUMN restore_review_required INTEGER NOT NULL DEFAULT 0
		CHECK (restore_review_required IN (0,1));
`;
