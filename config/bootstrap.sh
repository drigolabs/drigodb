#!/usr/bin/env bash
# Entrypoint for the PostgreSQL container of a per-app database pod.
#
# CNPG's postgresql image is a bare operand — it declares no entrypoint that
# initialises a cluster — so this script owns first-start initialisation and
# then hands off to the postmaster.
#
# Runs on every start. Initialisation happens once; an ordinary start refreshes
# the auth files and execs. Keeping that path free of a start/stop cycle matters
# because it is also the hibernation wake path — so the two things that DO need
# a running server, a rotated credential and a pending migration, are gated on
# markers in PGDATA and share one cycle when both are due.
set -euo pipefail

: "${PGDATA:?PGDATA must be set}"
: "${APP_DB_NAME:=app}"
: "${APP_DB_USER:=appuser}"
CONF_SRC="${APP_DB_CONF_DIR:-/app-db-config}"
MIGRATIONS_SRC="${APP_DB_MIGRATIONS_DIR:-/drigodb-migrations}"
# Records which credential this cluster has had applied. A fingerprint, not the
# password — this sits in PGDATA next to the data the password protects, and
# there is no reason for the plaintext to be there too.
CRED_MARKER="${PGDATA}/.drigodb-credential"
# Records which set of migration files this cluster has seen. A cheap gate on
# whether starting the server is worth it, and nothing more: _drigodb.schema_
# migrations inside the database is the source of truth for what actually ran.
# A restored volume or a hand-edited file would desync this marker, and the
# ledger is what stops that from mattering.
MIG_MARKER="${PGDATA}/.drigodb-migrations"

log() { printf '[bootstrap] %s\n' "$1"; }

credential_fingerprint() { printf '%s' "${APP_DB_PASSWORD:-}" | sha256sum | cut -d' ' -f1; }

record_credential() {
  credential_fingerprint > "${CRED_MARKER}"
  chmod 0600 "${CRED_MARKER}"
}

# Name and content of every migration, in the order they would be applied. Both
# halves matter: a renamed file is a different migration, and an edited one is
# the failure the runner exists to catch.
migrations_fingerprint() {
  if [ ! -d "${MIGRATIONS_SRC}" ]; then printf 'none'; return; fi
  # LC_ALL=C so ordering is byte order on every machine, which is what the
  # zero-padded numbering assumes.
  ( cd "${MIGRATIONS_SRC}" && LC_ALL=C ls -1 *.sql 2>/dev/null | LC_ALL=C sort | \
      while IFS= read -r f; do printf '%s %s\n' "$f" "$(sha256sum "$f" | cut -d' ' -f1)"; done \
  ) | sha256sum | cut -d' ' -f1
}

record_migrations() {
  migrations_fingerprint > "${MIG_MARKER}"
  chmod 0600 "${MIG_MARKER}"
}

psql_app() { psql -U postgres -d "${APP_DB_NAME}" -v ON_ERROR_STOP=1 -q "$@"; }

# Apply every migration that has not run, in filename order, each in one
# transaction together with the row that records it — so a migration is either
# applied and recorded or neither.
run_migrations() {
  [ -d "${MIGRATIONS_SRC}" ] || { log "no migrations directory at ${MIGRATIONS_SRC}; skipping"; return 0; }

  # The ledger has to exist before the runner can record that it created the
  # ledger. 001-core.sql states this again for the sake of being a complete
  # description of the schema; both are idempotent.
  psql_app <<'SQL'
CREATE SCHEMA IF NOT EXISTS _drigodb;
CREATE TABLE IF NOT EXISTS _drigodb.schema_migrations (
  filename   text        PRIMARY KEY,
  sha256     text        NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

  local f name file_sha applied_sha applied=0
  for f in $(cd "${MIGRATIONS_SRC}" && LC_ALL=C ls -1 *.sql 2>/dev/null | LC_ALL=C sort); do
    name="$f"
    file_sha="$(sha256sum "${MIGRATIONS_SRC}/${f}" | cut -d' ' -f1)"
    applied_sha="$(psql -U postgres -d "${APP_DB_NAME}" -tAc \
      "SELECT sha256 FROM _drigodb.schema_migrations WHERE filename = '${name}'")"

    if [ -n "${applied_sha}" ]; then
      if [ "${applied_sha}" != "${file_sha}" ]; then
        # Deliberately fatal. The schema in this database no longer matches the
        # file claiming to describe it, and continuing would mean every database
        # in the fleet quietly diverging from the migrations in git. Migrations
        # are forward-only: fix this by reverting the edit, not by rerunning.
        log "FATAL: ${name} was applied as ${applied_sha} but the file is now ${file_sha}"
        log "migrations are forward-only — revert the edit and add a new file instead"
        return 1
      fi
      continue
    fi

    log "applying ${name}"
    # -1 wraps the whole input in one transaction. The INSERT is appended to the
    # migration's own SQL so both commit together; psql interpolates :'vars' on
    # stdin, which is also what keeps the values quoted correctly.
    { cat "${MIGRATIONS_SRC}/${f}"
      printf '\nINSERT INTO _drigodb.schema_migrations (filename, sha256) VALUES (:%s, :%s);\n' \
        "'mig_file'" "'mig_sha'"
    } | psql_app -1 -v mig_file="${name}" -v mig_sha="${file_sha}" -f -
    applied=$((applied + 1))
  done

  # Role wiring, not schema: the role's NAME is a deployment parameter, so it
  # cannot live in a migration file that has no way to know it. The app may read
  # what version its database is at; it may not write the ledger, because a role
  # that could would be able to convince this runner that a migration it never
  # ran had already been applied.
  psql_app -v role="${APP_DB_USER}" -f - <<'SQL'
GRANT USAGE ON SCHEMA _drigodb TO :"role";
GRANT SELECT ON _drigodb.schema_migrations TO :"role";
SQL

  log "migrations up to date at $(psql -U postgres -d "${APP_DB_NAME}" -tAc 'SELECT _drigodb.version()') (${applied} applied this start)"
}

if [ ! -s "${PGDATA}/PG_VERSION" ]; then
  : "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set for first-time initialisation}"
  log "initialising a new cluster at ${PGDATA}"

  initdb -D "${PGDATA}" -U postgres --auth-local=peer --auth-host=scram-sha-256 >/dev/null

  # Include rather than append, so a change to the mounted config takes effect
  # on the next restart instead of being frozen into PGDATA at init time.
  printf "\ninclude = '%s/postgresql.conf'\n" "${CONF_SRC}" >> "${PGDATA}/postgresql.conf"

  cp "${CONF_SRC}/pg_hba.conf" "${PGDATA}/"
  chmod 0600 "${PGDATA}/pg_hba.conf"

  # A self-signed certificate, into PGDATA where postgres already owns
  # everything. The image ships Debian's snakeoil pair, but its key is
  # root:ssl-cert 0640 and Kubernetes does not grant a pod the image's group
  # memberships — so relying on it would mean pinning supplementalGroups to an
  # image-specific gid. Generating our own costs one openssl call at first start
  # and nothing afterwards.
  log "generating a self-signed certificate"
  openssl req -new -x509 -days 3650 -nodes -text \
    -out "${PGDATA}/server.crt" -keyout "${PGDATA}/server.key" \
    -subj "/CN=drigodb" >/dev/null 2>&1
  chmod 0600 "${PGDATA}/server.key"

  log "creating database ${APP_DB_NAME} and role ${APP_DB_USER}"
  pg_ctl -D "${PGDATA}" -w start >/dev/null

  # The app role owns its database outright — "admin within its own database
  # only", which under DocumentDB took a cluster-wide grant that reached every
  # other tenant's data (spike F3) and here is just ownership.
  #
  # Fed on stdin rather than with -c: psql performs variable interpolation on
  # file/stdin input but NOT on -c strings, where `:"role"` reaches the server
  # verbatim and fails with a syntax error. Interpolation also keeps the
  # password out of the command line and quotes it correctly.
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
    -v role="${APP_DB_USER}" -v pw="${APP_DB_PASSWORD}" -f - <<'SQL'
CREATE ROLE :"role" LOGIN PASSWORD :'pw';
SQL
  createdb -U postgres -O "${APP_DB_USER}" "${APP_DB_NAME}"

  run_migrations
  record_credential
  record_migrations

  pg_ctl -D "${PGDATA}" -m fast -w stop >/dev/null
  log "initialisation complete"
else
  # pg_hba is ours to own; refresh it so a config change ships with a restart.
  log "existing cluster, refreshing auth files"
  cp "${CONF_SRC}/pg_hba.conf" "${PGDATA}/"
  chmod 0600 "${PGDATA}/pg_hba.conf"

  # Both of these need a running server, and an ordinary wake needs neither.
  # Deciding first, then starting once, is what keeps a wake at the cost of an
  # exec — and stops a database that has both a rotated password and a pending
  # migration from paying two start/stop cycles.
  #
  # Rotation lands here rather than in the control plane, because the control
  # plane has no route to this server. The Service does publish PostgreSQL's
  # port — that is how applications connect — but pg_hba admits only appuser,
  # over TLS, into its own database. Giving the API a way in would mean a
  # pg_hba rule, a NetworkPolicy hole and a DDL-capable credential per database
  # that the control plane holds and can use. It already holds every credential;
  # the point is that it cannot use one from where it runs. See issue #29.
  #
  # A cluster created before either marker existed has neither, so its first
  # restart re-applies the password it already has and re-runs the migration
  # runner. Both are idempotent — the ledger has the last word on what actually
  # runs — and it establishes the markers.
  # Written as `if` blocks rather than `[ ... ] && VAR=1`: under `set -e` a
  # trailing AND-list whose test fails is exempt only by a rule subtle enough
  # that it should not be what keeps every wake working.
  CRED_CHANGED=0
  MIGS_CHANGED=0
  if [ -n "${APP_DB_PASSWORD:-}" ] &&
     [ "$(credential_fingerprint)" != "$(cat "${CRED_MARKER}" 2>/dev/null || true)" ]; then
    CRED_CHANGED=1
  fi
  if [ "$(migrations_fingerprint)" != "$(cat "${MIG_MARKER}" 2>/dev/null || true)" ]; then
    MIGS_CHANGED=1
  fi

  if [ "${CRED_CHANGED}" = 1 ] || [ "${MIGS_CHANGED}" = 1 ]; then
    pg_ctl -D "${PGDATA}" -w start >/dev/null

    if [ "${CRED_CHANGED}" = 1 ]; then
      log "credential has changed; applying it"
      # Fed on stdin for the same reason as initialisation: psql interpolates
      # file and stdin input but not -c strings, and interpolation keeps the
      # password off the command line and quotes it correctly.
      psql_app -v role="${APP_DB_USER}" -v pw="${APP_DB_PASSWORD}" -f - <<'SQL'
ALTER ROLE :"role" PASSWORD :'pw';
SQL
      record_credential
      log "credential applied"
    fi

    if [ "${MIGS_CHANGED}" = 1 ]; then
      log "migration set has changed; running it"
      # No `|| true`. A checksum mismatch must stop the pod rather than serve a
      # database whose schema has diverged from the migrations in git — and
      # config/migrations-test.sh asserts exactly that in CI, which is where a
      # bad edit is meant to be caught rather than on a live fleet.
      if ! run_migrations; then
        pg_ctl -D "${PGDATA}" -m fast -w stop >/dev/null || true
        exit 1
      fi
      record_migrations
    fi

    pg_ctl -D "${PGDATA}" -m fast -w stop >/dev/null
  fi
fi

# Belt and braces alongside fsGroupChangePolicy: PostgreSQL refuses to start
# unless PGDATA is 0700 or 0750, so any volume plugin that relaxes it on mount
# would otherwise break every restart after the first.
chmod 0700 "${PGDATA}"

log "starting postmaster"
exec postgres -D "${PGDATA}"
