-- The _drigodb schema: what drigodb itself owns inside a hosted database.
--
-- Forward-only. Once this file has been applied to any database it is frozen —
-- the runner records a checksum and refuses to start a server whose applied
-- migration no longer matches the file, because the alternative is a schema
-- that has silently diverged from the migration that claims to describe it.
-- Change something by adding 002, never by editing this.

-- The ledger is created by the runner before this file executes, because the
-- runner needs somewhere to record that it ran this file. Stated here anyway so
-- the schema is fully described by its migrations rather than half-described by
-- a shell script.
CREATE SCHEMA IF NOT EXISTS _drigodb;

CREATE TABLE IF NOT EXISTS _drigodb.schema_migrations (
  filename   text        PRIMARY KEY,
  sha256     text        NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- The highest migration this database has applied. The operational question is
-- almost always "is this database current?", which is this answer compared
-- against the newest file in config/migrations.
CREATE OR REPLACE FUNCTION _drigodb.version() RETURNS text
  LANGUAGE sql STABLE AS $$
    SELECT coalesce(max(filename), 'none') FROM _drigodb.schema_migrations;
  $$;

-- The app role may read what version its database is at and nothing else.
--
-- It owns its own database, so it can create whatever it likes in public — but
-- _drigodb is drigodb's, and an app that could write to schema_migrations could
-- convince the runner that a migration it never ran had already been applied.
REVOKE ALL ON SCHEMA _drigodb FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA _drigodb FROM PUBLIC;
