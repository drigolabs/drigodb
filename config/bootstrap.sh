#!/usr/bin/env bash
# Entrypoint for the PostgreSQL container of a per-app database pod.
#
# CNPG's postgresql image is a bare operand — it declares no entrypoint that
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
# Records which credential this cluster has had applied. A fingerprint, not the
# password — this sits in PGDATA next to the data the password protects, and
# there is no reason for the plaintext to be there too.
CRED_MARKER="${PGDATA}/.drigodb-credential"

log() { printf '[bootstrap] %s\n' "$1"; }

credential_fingerprint() { printf '%s' "${APP_DB_PASSWORD:-}" | sha256sum | cut -d' ' -f1; }

record_credential() {
  credential_fingerprint > "${CRED_MARKER}"
  chmod 0600 "${CRED_MARKER}"
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

  record_credential

  pg_ctl -D "${PGDATA}" -m fast -w stop >/dev/null
  log "initialisation complete"
else
  # pg_hba is ours to own; refresh it so a config change ships with a restart.
  log "existing cluster, refreshing auth files"
  cp "${CONF_SRC}/pg_hba.conf" "${PGDATA}/"
  chmod 0600 "${PGDATA}/pg_hba.conf"

  # Rotation lands here rather than in the control plane, because the control
  # plane has no route to this server. The Service now does publish PostgreSQL's
  # port — that is how applications connect — but pg_hba admits only appuser,
  # over TLS, into its own database. Giving the API a way in would mean a
  # pg_hba rule, a NetworkPolicy hole and a DDL-capable credential per database
  # that the control plane holds and can use. It already holds every credential;
  # the point is that it cannot use one from where it runs. See issue #29.
  #
  # ALTER ROLE needs a running server, so this pays a start/stop cycle. It is
  # paid ONLY when the credential has actually changed, which is what the
  # fingerprint decides — an ordinary wake still execs straight into the
  # postmaster and costs nothing.
  #
  # A cluster created before this existed has no marker, so its first restart
  # re-applies the password it already has. Harmless, and it establishes the
  # marker.
  if [ -n "${APP_DB_PASSWORD:-}" ] && \
     [ "$(credential_fingerprint)" != "$(cat "${CRED_MARKER}" 2>/dev/null || true)" ]; then
    log "credential has changed; applying it"
    pg_ctl -D "${PGDATA}" -w start >/dev/null
    # Fed on stdin for the same reason as initialisation: psql interpolates
    # file and stdin input but not -c strings, and interpolation keeps the
    # password off the command line and quotes it correctly.
    psql -U postgres -d "${APP_DB_NAME}" -v ON_ERROR_STOP=1 -q \
      -v role="${APP_DB_USER}" -v pw="${APP_DB_PASSWORD}" -f - <<'SQL'
ALTER ROLE :"role" PASSWORD :'pw';
SQL
    pg_ctl -D "${PGDATA}" -m fast -w stop >/dev/null
    record_credential
    log "credential applied"
  fi
fi

# Belt and braces alongside fsGroupChangePolicy: PostgreSQL refuses to start
# unless PGDATA is 0700 or 0750, so any volume plugin that relaxes it on mount
# would otherwise break every restart after the first.
chmod 0700 "${PGDATA}"

log "starting postmaster"
exec postgres -D "${PGDATA}"
