CREATE TABLE app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE settings_revision (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO settings_revision (id, revision) VALUES (1, 0);
-- The migration runner imports the known application environment variables
-- within this same transaction, before marking this migration as applied.
