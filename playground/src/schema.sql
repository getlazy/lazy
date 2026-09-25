-- The whole database. Two tables: the links themselves and one row per click.
-- Timestamps are milliseconds since the epoch, as Date.now() returns them.

CREATE TABLE IF NOT EXISTS links (
  slug       TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clicks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL REFERENCES links(slug) ON DELETE CASCADE,
  clicked_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS clicks_by_slug ON clicks(slug, clicked_at);
