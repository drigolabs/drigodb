#!/usr/bin/env bash
# End-to-end proof that the gateway image serves the MongoDB wire protocol
# against the postgres-documentdb image: a real MongoDB client inserts and finds
# a document through it.
#
# This is U2's verification in docs/plans/2026-08-29-001. It also encodes the
# gateway's deployment contract, which is not optional and not obvious:
#
#   * The gateway reaches PostgreSQL ONLY over a local Unix socket with peer
#     auth. The OSS build rejects password-bearing URLs outright ("this build
#     only supports passwordless local peer auth"), so gateway and PostgreSQL
#     must share a filesystem — in Kubernetes, the same pod.
#   * The gateway's system pool connects as its own role, but each client's data
#     pool connects AS THAT CLIENT'S ROLE with an empty password. Peer auth
#     therefore needs a pg_ident map granting the gateway's OS user the
#     documentdb_* role groups, and a pg_hba line scoped to them.
#   * pg_ident '+group' membership requires PostgreSQL 16 or newer.
#   * The gateway defaults to PostgreSQL port 9712, not 5432, so the port must
#     be explicit in the URL for a CNPG cluster.
#
# Usage: ./integration-test.sh [gateway-image] [postgres-image]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# The canonical PostgreSQL config lives in config and is mounted in, so
# this test proves the files U3 actually ships rather than a copy of them.
APP_DB_CONF="${REPO_ROOT}/config"

GW_IMAGE="${1:-drigolabs/drigodb-gateway:0.116-0}"
PG_IMAGE="${2:-drigolabs/drigodb-postgres:18-0.116-0}"
SFX="$$"
NET="docdb-it-${SFX}"; PG_C="docdb-it-pg-${SFX}"; GW_C="docdb-it-gw-${SFX}"; VOL="docdb-it-sock-${SFX}"
GW_PORT=27020; APP_DB="app"; APP_PW="AppUser123"
# The UID PostgreSQL runs as; the gateway must share it so peer auth resolves to
# the same OS user the pg_ident map names. CNPG uses 26.
PG_UID=26

cleanup() {
  docker rm -f "$GW_C" "$PG_C" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> gateway=${GW_IMAGE}  backend=${PG_IMAGE}"
docker network create "$NET" >/dev/null
docker volume create "$VOL" >/dev/null
docker run --rm -v "${VOL}:/sockets" --user 0 "$PG_IMAGE" chown "${PG_UID}:${PG_UID}" /sockets >/dev/null

echo "==> starting DocumentDB backend"
docker run -d --name "$PG_C" --network "$NET" -v "${VOL}:/sockets" \
  -v "${APP_DB_CONF}:/app-db:ro" --user "$PG_UID" "$PG_IMAGE" \
  bash -euo pipefail -c "
  export PGDATA=/tmp/pgdata
  initdb -D \"\$PGDATA\" -U postgres --auth-local=peer --auth-host=scram-sha-256 >/dev/null
  # The shipped config from config — postgresql.conf is appended to the
  # generated one, pg_hba/pg_ident replace theirs outright.
  cat /app-db/postgresql.conf >> \"\$PGDATA/postgresql.conf\"
  cp /app-db/pg_hba.conf /app-db/pg_ident.conf \"\$PGDATA/\"

  pg_ctl -D \"\$PGDATA\" -l /tmp/pg.log -w start >/dev/null
  createdb -h /sockets -U postgres ${APP_DB}
  psql -h /sockets -U postgres -d ${APP_DB} -v ON_ERROR_STOP=1 -q \
    -c 'CREATE EXTENSION IF NOT EXISTS documentdb CASCADE;' \
    -c \"CREATE ROLE appuser LOGIN PASSWORD '${APP_PW}';\" \
    -c 'GRANT documentdb_admin_role TO appuser;'
  echo BACKEND_READY
  sleep infinity
" >/dev/null

for i in $(seq 1 60); do
  docker logs "$PG_C" 2>&1 | grep -q BACKEND_READY && break
  docker ps -q --filter "name=$PG_C" | grep -q . || { echo "backend died:"; docker logs "$PG_C" 2>&1 | tail -20; exit 1; }
  sleep 2
done
echo "    backend ready"

echo "==> starting gateway (same UID, shared socket)"
docker run -d --name "$GW_C" --network "$NET" -v "${VOL}:/sockets" -p "${GW_PORT}:10260" \
  --user "$PG_UID" \
  -e DOCUMENTDB_PG_URL_FILE=/tmp/pg_url \
  --entrypoint bash "$GW_IMAGE" -c "
    umask 077
    printf 'postgresql://postgres@%%2Fsockets:5432/${APP_DB}' > /tmp/pg_url
    exec /usr/bin/documentdb-gateway run
  " >/dev/null

for i in $(seq 1 40); do
  docker logs "$GW_C" 2>&1 | grep -q "ready to accept connections" && { echo "    gateway ready"; break; }
  [ "$i" = 40 ] && { echo "    GATEWAY DID NOT START"; docker logs "$GW_C" 2>&1 | tail -15; exit 1; }
  sleep 2
done

echo "==> MongoDB driver round trip"
URI="mongodb://appuser:${APP_PW}@localhost:${GW_PORT}/?tls=true&tlsAllowInvalidCertificates=true&directConnection=true"
OUT=$(npx --yes mongosh@latest "$URI" --quiet --eval '
  const d = db.getSiblingDB("gwtest");
  d.widgets.insertOne({ _id: "w1", via: "wire-protocol" });
  print(JSON.stringify(d.widgets.find({}).toArray()));
' 2>&1 | tail -3) || true
echo "    ${OUT}"

case "$OUT" in
  *wire-protocol*) echo "==> PASS" ;;
  *) echo "==> FAIL"; docker logs "$GW_C" 2>&1 | tail -10; docker exec "$PG_C" tail -10 /tmp/pg.log 2>&1; exit 1 ;;
esac
