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
# Runs as drigodb_migrator, NOT as the application role, and that is the whole
# reason a third role exists.
#
# bootstrap.sh ran as postgres over a Unix socket, so _drigodb was owned by a
# superuser: the application could read the ledger and not write it. Over TCP the
# runner has to be somebody, and the two obvious candidates were both wrong.
#
# As the application: it would own its own ledger. Dropping the schema is loud
# and self-correcting — the next run finds nothing applied and re-runs
# everything — but forging a row is silent, and it lets a tenant DECLINE a
# migration aimed at them, including one that tightens a permission.
#
# As postgres: CNPG superuser access puts a superuser password in the database
# namespace beside every application password, and PostgreSQL superuser includes
# COPY TO PROGRAM. That trades a ledger integrity problem for code execution in
# every database pod.
#
# So: a role that owns _drigodb, holds CREATE on the database and nothing else,
# and whose credential appears in no connection URI.
set -euo pipefail

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/drigodb-migrations}"

log() { printf '[migrate] %s\n' "$1"; }

# Every connection setting arrives through PG* environment variables, so no
# credential is ever written into a command line where `ps` would show it.
psql_app() { psql -v ON_ERROR_STOP=1 -q "$@"; }

[ -d "${MIGRATIONS_DIR}" ] || { log "no migrations directory at ${MIGRATIONS_DIR}; nothing to do"; exit 0; }

# This starts as soon as the Cluster object exists, which is well before the
# server is up: initdb runs, then the operator reconciles the managed roles that
# set this password. Three minutes covers both with room, and the Job's
# backoffLimit covers anything longer.
#
# The last error is kept and printed on giving up. The first version of this loop
# discarded it and reported only "could not connect", which turned an
# authentication failure, a missing role and an unroutable Service into one
# indistinguishable message — and the Service really was unroutable.
last_error=""
for attempt in $(seq 1 90); do
  if last_error="$(psql -tAc 'select 1' 2>&1)"; then break; fi
  if [ "$attempt" = "90" ]; then
    log "FATAL: could not connect after 90 attempts over 3 minutes"
    log "last error: ${last_error}"
    exit 1
  fi
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

# Role wiring, not schema: the application role's NAME is a deployment parameter,
# so it cannot live in a migration file that has no way to know it.
#
# The application may read what version its database is at. It may not write the
# ledger — a role that could would be able to convince this runner that a
# migration it never ran had already been applied, which is the property the
# separate migrator role exists to keep.
psql_app -v role="${APP_USER}" -f - <<'SQL'
GRANT USAGE ON SCHEMA _drigodb TO :"role";
GRANT SELECT ON _drigodb.schema_migrations TO :"role";
SQL

log "migrations up to date at $(psql -tAc 'SELECT _drigodb.version()') (${applied} applied this run)"
