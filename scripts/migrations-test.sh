#!/usr/bin/env bash
# Proof that the in-database migration runner does what bootstrap.sh claims.
#
# It runs the REAL bootstrap.sh against the REAL image, because every property
# worth asserting here is a property of that script's control flow and not of
# any SQL in isolation: what runs on a fresh cluster, what a wake costs when
# nothing changed, what a new file does on the next start, and what an edited
# file does — which is the one that must fail, loudly, before it can reach a
# fleet where it would stop every database from waking.
#
# Usage: ./migrations-test.sh [postgres-image]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILES="${REPO_ROOT}/charts/drigodb/files"
PG_IMAGE="${1:-ghcr.io/cloudnative-pg/postgresql:18}"

SFX="$$"
C="mig-it-${SFX}"
VOL="mig-it-data-${SFX}"
SOCK="mig-it-sock-${SFX}"
WORK="$(mktemp -d)"
PG_UID=26
PG_GID=102
PW="migtest123"

cleanup() {
  docker rm -f "$C" >/dev/null 2>&1 || true
  docker volume rm "$VOL" "$SOCK" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "==> FAIL: $1"; docker logs "$C" 2>&1 | tail -25; exit 1; }

# A private copy of the chart's files/, so the test can add and edit migrations
# without touching the repository.
cp "${FILES}/postgresql.conf" "${FILES}/pg_hba.conf" "${FILES}/bootstrap.sh" "$WORK/"
mkdir -p "$WORK/migrations"
cp "${FILES}"/migrations/*.sql "$WORK/migrations/"

# The container runs as uid 26 and mktemp -d is 0700 owned by whoever ran this,
# so without this the bind mount is unreadable and bootstrap.sh fails with
# "Permission denied" before it does anything. Docker Desktop on macOS remaps
# ownership and hides the problem; a Linux runner does not.
chmod -R a+rX "$WORK"

docker volume create "$VOL" >/dev/null
# postgresql.conf lists /sockets in unix_socket_directories — it is the volume
# the backup sidecar shares in production — and the server refuses to start if
# the directory is not there.
docker volume create "$SOCK" >/dev/null
docker run --rm --user 0 -v "${VOL}:/var/lib/postgresql/data" -v "${SOCK}:/sockets" \
  --entrypoint chown "$PG_IMAGE" -R "${PG_UID}:${PG_GID}" /var/lib/postgresql/data /sockets >/dev/null

# Waiting on pg_isready alone is a race: bootstrap.sh starts a server of its own
# to rotate a credential or run migrations, so the socket answers in the middle
# of work that has not finished. The postmaster that serves traffic is the one
# bootstrap.sh `exec`s, and only that one is PID 1.
wait_ready() {
  for _ in $(seq 1 60); do
    if docker exec "$C" sh -c 'tr "\0" " " < /proc/1/cmdline' 2>/dev/null | grep -q '^postgres ' \
       && docker exec "$C" pg_isready -U postgres -d app >/dev/null 2>&1; then
      return 0
    fi
    docker ps -q --filter "name=$C" | grep -q . || return 1
    sleep 1
  done
  return 1
}

restart_and_wait() {
  docker restart "$C" >/dev/null
  wait_ready || fail "the cluster did not come back after a restart"
}

start() { # returns once the server is accepting, or fails
  docker rm -f "$C" >/dev/null 2>&1 || true
  docker run -d --name "$C" --user "${PG_UID}:${PG_GID}" \
    -v "${VOL}:/var/lib/postgresql/data" \
    -v "${SOCK}:/sockets" \
    -v "${WORK}:/app-db-config:ro" \
    -v "${WORK}/migrations:/drigodb-migrations:ro" \
    -e PGDATA=/var/lib/postgresql/data/pgdata \
    -e APP_DB_CONF_DIR=/app-db-config \
    -e APP_DB_MIGRATIONS_DIR=/drigodb-migrations \
    -e APP_DB_PASSWORD="$PW" \
    --entrypoint bash "$PG_IMAGE" /app-db-config/bootstrap.sh >/dev/null
  wait_ready
}

q() { docker exec "$C" psql -U postgres -d app -tAc "$1"; }

echo "==> postgres=${PG_IMAGE}"

echo "==> first start applies the migration set"
start || fail "the cluster never came up"
[ "$(q "SELECT _drigodb.version()")" = "001-core.sql" ] || fail "version() did not report 001-core.sql"
[ "$(q "SELECT count(*) FROM _drigodb.schema_migrations")" = "1" ] || fail "the ledger did not record exactly one migration"
echo "    version() = 001-core.sql"

echo "==> an ordinary restart costs no start/stop cycle"
restart_and_wait
LOG="$(docker logs "$C" 2>&1 | tail -20)"
case "$LOG" in
  *"migration set has changed"*) fail "an unchanged migration set still started the server" ;;
esac
[ "$(q "SELECT count(*) FROM _drigodb.schema_migrations")" = "1" ] || fail "a restart re-applied a migration"
echo "    no migration work, ledger still at 1"

echo "==> a new migration is applied on the next start"
cat > "$WORK/migrations/002-test.sql" <<'SQL'
CREATE TABLE IF NOT EXISTS _drigodb.probe (ok boolean NOT NULL);
INSERT INTO _drigodb.probe (ok) VALUES (true);
SQL
restart_and_wait
[ "$(q "SELECT _drigodb.version()")" = "002-test.sql" ] || fail "002 was not applied on restart"
[ "$(q "SELECT count(*) FROM _drigodb.probe WHERE ok")" = "1" ] || fail "002 did not actually run its SQL"
echo "    002-test.sql applied, version() moved"

echo "==> it runs exactly once, not once per start"
restart_and_wait
[ "$(q "SELECT count(*) FROM _drigodb.probe")" = "1" ] || fail "002 ran a second time — the ledger is not gating"
echo "    probe row still 1"

echo "==> the app role can read its version and cannot write the ledger"
docker exec -e PGPASSWORD="$PW" "$C" \
  psql "postgresql://appuser@127.0.0.1:5432/app?sslmode=require" -tAc "SELECT _drigodb.version()" >/dev/null \
  || fail "appuser cannot read _drigodb.version()"
if docker exec -e PGPASSWORD="$PW" "$C" \
     psql "postgresql://appuser@127.0.0.1:5432/app?sslmode=require" -q -v ON_ERROR_STOP=1 \
     -c "INSERT INTO _drigodb.schema_migrations (filename, sha256) VALUES ('999-forged.sql','x')" >/dev/null 2>&1; then
  fail "appuser could forge a ledger row"
fi
echo "    read yes, write no"

echo "==> editing an applied migration stops the server from starting"
# The blast radius this guards: a fleet where every database wakes onto a schema
# that no longer matches the migration claiming to describe it.
echo "-- edited after shipping" >> "$WORK/migrations/002-test.sql"
if start; then fail "an edited migration was accepted"; fi
docker logs "$C" 2>&1 | grep -q "forward-only" || fail "it failed, but not with the forward-only message"
echo "    refused, with the reason"

echo "==> reverting the edit lets it start again"
sed -i.bak '/edited after shipping/d' "$WORK/migrations/002-test.sql" && rm -f "$WORK/migrations/002-test.sql.bak"
start || fail "reverting the edit did not restore a working cluster"
[ "$(q "SELECT _drigodb.version()")" = "002-test.sql" ] || fail "version() wrong after recovery"
echo "    recovered"

echo "==> PASS"
