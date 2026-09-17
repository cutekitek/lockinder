CREATE TABLE player_reports (
  id TEXT PRIMARY KEY NOT NULL,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (reporter_id <> target_id)
);
CREATE INDEX reports_target_created ON player_reports(target_id, created_at);
CREATE INDEX reports_reporter ON player_reports(reporter_id);
