#!/usr/bin/env bash
# Apply drigodb's migrations to a database that is already running.
#
# Extracted from bootstrap.sh, which cannot follow a database onto
# CloudNativePG: the operator owns the pod, so there is no entrypoint of ours to
# run migrations from. This runs as a Job instead, connecting over TCP like any
# other client — and carrying the drigodb.io/allow-database label, so drigodb's
# own tooling passes through the same network boundary a consumer does.
#
# Forward-only, and the checksum rule is the point: a migration that has been
# applied is frozen. Editing one would leave every database that already ran it
# describing a schema it no longer has.
#
# WHAT CHANGED, and it is a real weakening: bootstrap.sh ran as `postgres` over
# a Unix socket, so `_drigodb` was owned by a superuser and the application role
# could read the ledger but not write it — which stopped an application from
# convincing this runner that a migration it never ran had already been applied.
# This runs as the application role, so it owns the ledger and can forge it.
#
# The alternative was worse: reaching postgres means enabling CNPG's superuser
# access, which puts a superuser password in a Secret in the database namespace.
# That is a larger prize than the one it protects, and the protection was already
# thin — the application owns its whole database and can DROP SCHEMA _drigodb
# outright whether or not it can write to the ledger.
set -euo pipefail

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/drigodb-migrations}"

log() { printf '[migrate] %s\n' "$1"; }

# Every connection setting arrives through PG* environment variables, so no
# credential is ever written into a command line where `ps` would show it.
psql_app() { psql -v ON_ERROR_STOP=1 -q "$@"; }

[ -d "${MIGRATIONS_DIR}" ] || { log "no migrations directory at ${MIGRATIONS_DIR}; nothing to do"; exit 0; }

# The database may report ready a moment before it accepts connections, and a
# Job that fails on the first attempt costs a backoff rather than a retry.
for attempt in $(seq 1 30); do
  psql -tAc 'select 1' >/dev/null 2>&1 && break
  [ "$attempt" = "30" ] && { log "FATAL: could not connect after 30 attempts"; exit 1; }
  sleep 2
done

# The ledger has to exist before the runner can record that it created the
# ledger. 001-core.sql states this again so the schema is fully described by its
# migrations; both are idempotent.
psql_app <<'SQL'
CREATE SCHEMA IF NOT EXISTS _drigodb;
CREATE TABLE IF NOT EXISTS _drigodb.schema_migrations (
  filename   text        PRIMARY KEY,
  sha256     text        NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

applied=0
for f in $(cd "${MIGRATIONS_DIR}" && LC_ALL=C ls -1 ./*.sql 2>/dev/null | sed 's|^\./||' | LC_ALL=C sort); do
  file_sha="$(sha256sum "${MIGRATIONS_DIR}/${f}" | cut -d' ' -f1)"
  applied_sha="$(psql -tAc "SELECT sha256 FROM _drigodb.schema_migrations WHERE filename = '${f}'")"

  if [ -n "${applied_sha}" ]; then
    if [ "${applied_sha}" != "${file_sha}" ]; then
      # Deliberately fatal, and now visibly so: the Job fails, drigodb reports
      # the database `failed`, and no connection URI is issued for it. Migrations
      # are forward-only — fix this by reverting the edit and adding a new file.
      log "FATAL: ${f} was applied as ${applied_sha} but the file is now ${file_sha}"
      log "migrations are forward-only — revert the edit and add a new file instead"
      exit 1
    fi
    continue
  fi

  log "applying ${f}"
  # -1 wraps the whole input in one transaction, so the migration and the record
  # that it ran commit together or not at all.
  { cat "${MIGRATIONS_DIR}/${f}"
    printf '\nINSERT INTO _drigodb.schema_migrations (filename, sha256) VALUES (:%s, :%s);\n' \
      "'mig_file'" "'mig_sha'"
  } | psql_app -1 -v mig_file="${f}" -v mig_sha="${file_sha}" -f -
  applied=$((applied + 1))
done

log "migrations up to date at $(psql -tAc 'SELECT _drigodb.version()') (${applied} applied this run)"
