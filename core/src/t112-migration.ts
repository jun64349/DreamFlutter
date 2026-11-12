export const T112_MIGRATION = `
	ALTER TABLE patrol_runs ADD COLUMN notification_state TEXT;
	ALTER TABLE patrol_runs ADD COLUMN notification_targets TEXT NOT NULL DEFAULT '[]';
	ALTER TABLE patrol_runs ADD COLUMN notification_note TEXT;
	ALTER TABLE patrol_runs ADD COLUMN notification_started INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE patrol_runs ADD COLUMN model_started INTEGER NOT NULL DEFAULT 0;
	UPDATE patrol_runs SET notification_state=CASE WHEN notified=1 THEN 'sent' ELSE 'queued' END
	WHERE notification IS NOT NULL OR notified=1;

	ALTER TABLE patrol_reported ADD COLUMN state TEXT NOT NULL DEFAULT 'processed';
	ALTER TABLE patrol_reported ADD COLUMN run_id TEXT;
	ALTER TABLE patrol_reported ADD COLUMN fact TEXT;
	CREATE INDEX patrol_reported_run ON patrol_reported(run_id);
`;
