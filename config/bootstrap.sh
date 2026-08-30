#!/usr/bin/env bash
# Entrypoint for the PostgreSQL container of a per-app database pod.
#
# The postgres-documentdb image is a bare operand — it has no entrypoint that
# initialises a cluster — so this script owns first-start initialisation and
# then hands off to the postmaster.
#
# Runs on every start. Initialisation happens once; subsequent starts only
# refresh the auth files and exec. Keeping the restart path free of a
# start/stop cycle matters because it is also the hibernation wake path.
set -euo pipefail

: "${PGDATA:?PGDATA must be set}"
: "${APP_DB_NAME:=app}"
: "${APP_DB_USER:=appuser}"
CONF_SRC="${APP_DB_CONF_DIR:-/app-db-config}"

log() { printf '[bootstrap] %s\n' "$1"; }

if [ ! -s "${PGDATA}/PG_VERSION" ]; then
  : "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set for first-time initialisation}"
  log "initialising a new cluster at ${PGDATA}"

  initdb -D "${PGDATA}" -U postgres --auth-local=peer --auth-host=scram-sha-256 >/dev/null

  # Include rather than append, so a change to the mounted config takes effect
  # on the next restart instead of being frozen into PGDATA at init time.
  printf "\ninclude = '%s/postgresql.conf'\n" "${CONF_SRC}" >> "${PGDATA}/postgresql.conf"

  cp "${CONF_SRC}/pg_hba.conf" "${CONF_SRC}/pg_ident.conf" "${PGDATA}/"
  chmod 0600 "${PGDATA}/pg_hba.conf" "${PGDATA}/pg_ident.conf"

  log "creating database ${APP_DB_NAME} and role ${APP_DB_USER}"
  pg_ctl -D "${PGDATA}" -w start >/dev/null
  createdb -U postgres "${APP_DB_NAME}"

  # documentdb_admin_role is the only role that can actually do work — the
  # lesser documentdb_readwrite_role cannot create or read a collection. That is
  # safe here only because nothing is shared: this cluster holds one app.
  # See docs/documentdb-multitenancy-spike.md F3.
  # Fed on stdin rather than with -c: psql performs variable interpolation on
  # file/stdin input but NOT on -c strings, where `:"role"` reaches the server
  # verbatim and fails with a syntax error. Interpolation also keeps the
  # password out of the command line and quotes it correctly.
  psql -U postgres -d "${APP_DB_NAME}" -v ON_ERROR_STOP=1 -q \
    -v role="${APP_DB_USER}" -v pw="${APP_DB_PASSWORD}" -f - <<'SQL'
CREATE EXTENSION IF NOT EXISTS documentdb CASCADE;
CREATE ROLE :"role" LOGIN PASSWORD :'pw';
GRANT documentdb_admin_role TO :"role";
SQL

  pg_ctl -D "${PGDATA}" -m fast -w stop >/dev/null
  log "initialisation complete"
else
  # pg_hba and pg_ident are ours to own; refresh them so a config change ships
  # with a restart. Password rotation is not handled here — it needs a running
  # server, and paying a start/stop cycle on every wake is the wrong trade.
  # U7 owns rotation.
  log "existing cluster, refreshing auth files"
  cp "${CONF_SRC}/pg_hba.conf" "${CONF_SRC}/pg_ident.conf" "${PGDATA}/"
  chmod 0600 "${PGDATA}/pg_hba.conf" "${PGDATA}/pg_ident.conf"
fi

# Belt and braces alongside fsGroupChangePolicy: PostgreSQL refuses to start
# unless PGDATA is 0700 or 0750, so any volume plugin that relaxes it on mount
# would otherwise break every restart after the first.
chmod 0700 "${PGDATA}"

log "starting postmaster"
exec postgres -D "${PGDATA}"
