#!/usr/bin/env bash
# Proof that a backup is a backup: dump a database holding real documents, push
# it to S3-compatible storage, restore it into a DIFFERENT PostgreSQL instance,
# and read those documents back through the DocumentDB API.
#
# The last step is the whole point, and it is the step that condemned the
# obvious approach. pg_dump does not dump the data of tables belonging to an
# extension unless the extension marks them, and DocumentDB marks none: a
# collection's rows are dumped, the catalog row that makes them a collection is
# not. The logical restore completed with no error and every collection was
# invisible. Only reading a document back through the API catches that, which is
# why this test asserts on a document and not on an exit code.
#
# A physical restore replaces a data directory, so the target is a fresh
# instance with no cluster in it — not a second database in the source. That
# would have been forced anyway: pg_cron binds to one database per cluster and
# DocumentDB can only be installed in that one, which is the constraint behind
# cluster-per-app in the first place.
#
# MinIO stands in for DigitalOcean Spaces. Both speak S3, so the endpoint is
# configuration — which is what keeps this test free of cloud credentials.
#
# Usage: ./integration-test.sh [backup-image] [postgres-image]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DB_CONF="${REPO_ROOT}/config"

BK_IMAGE="${1:-drigolabs/drigodb-backup:test}"
PG_IMAGE="${2:-drigolabs/drigodb-postgres:18-0.116-0-20260831-b1}"

SFX="$$"
NET="bk-it-${SFX}"
MINIO="bk-it-minio-${SFX}"; PG1="bk-it-pg1-${SFX}"; PG2="bk-it-pg2-${SFX}"
VOL1="bk-it-sock1-${SFX}"; VOL2="bk-it-sock2-${SFX}"
BUCKET="drigodb-test"; DB_ID="testdb01"
AK="minioadmin"; SK="minioadmin"
PG_UID=26

cleanup() {
  docker rm -f "$MINIO" "$PG1" "$PG2" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$VOL1" "$VOL2" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Extra `docker run` options for a single call. An array rather than a string
# so nothing is word-split, and expanded with the ${a[@]+"${a[@]}"} form so an
# empty array is not an error under `set -u` on bash 3.2.
BK_ENV=()

bk() { # volume, then the command for the image
  local vol="$1"; shift
  docker run --rm --network "$NET" -v "${vol}:/sockets" --user "$PG_UID" \
    -e DRIGODB_DATABASE_ID="$DB_ID" \
    -e DRIGODB_BACKUP_BUCKET="$BUCKET" \
    -e DRIGODB_BACKUP_ENDPOINT="http://${MINIO}:9000" \
    -e DRIGODB_BACKUP_KEY="$AK" -e DRIGODB_BACKUP_SECRET="$SK" \
    ${BK_ENV[@]+"${BK_ENV[@]}"} \
    "$BK_IMAGE" "$@"
}

start_pg() { # container volume
  local name="$1" vol="$2"
  docker volume create "$vol" >/dev/null
  docker run --rm -v "${vol}:/sockets" --user 0 "$PG_IMAGE" \
    chown "${PG_UID}:${PG_UID}" /sockets >/dev/null
  docker run -d --name "$name" --network "$NET" -v "${vol}:/sockets" \
    -v "${APP_DB_CONF}:/app-db:ro" --user "$PG_UID" "$PG_IMAGE" \
    bash -euo pipefail -c "
    export PGDATA=/tmp/pgdata
    initdb -D \"\$PGDATA\" -U postgres --auth-local=peer >/dev/null
    cat /app-db/postgresql.conf >> \"\$PGDATA/postgresql.conf\"
    cp /app-db/pg_hba.conf /app-db/pg_ident.conf \"\$PGDATA/\"
    pg_ctl -D \"\$PGDATA\" -l /tmp/pg.log -w start >/dev/null
    createdb -h /sockets -U postgres app
    psql -h /sockets -U postgres -d app -v ON_ERROR_STOP=1 -q \
      -c 'CREATE EXTENSION IF NOT EXISTS documentdb CASCADE;'
    echo PG_READY
    sleep infinity
  " >/dev/null
  for i in $(seq 1 90); do
    docker logs "$name" 2>&1 | grep -q PG_READY && return 0
    docker ps -q --filter "name=$name" | grep -q . || { echo "$name died:"; docker logs "$name" 2>&1 | tail -20; return 1; }
    sleep 2
  done
  echo "$name never became ready"; return 1
}

psql1() { docker exec "$PG1" psql -h /sockets -U postgres -d app -At -c "$1"; }
psql2() { docker exec "$PG2" psql -h /sockets -U postgres -d app -At -c "$1"; }

echo "==> backup=${BK_IMAGE}  postgres=${PG_IMAGE}"
docker network create "$NET" >/dev/null

echo "==> starting MinIO"
docker run -d --name "$MINIO" --network "$NET" \
  -e MINIO_ROOT_USER="$AK" -e MINIO_ROOT_PASSWORD="$SK" \
  minio/minio server /data >/dev/null
sleep 3

echo "==> starting source PostgreSQL"
start_pg "$PG1" "$VOL1" || exit 1
echo "    source ready"

echo "==> creating the bucket"
for i in $(seq 1 20); do
  docker run --rm --network "$NET" --entrypoint rclone \
    -e RCLONE_CONFIG_DEST_TYPE=s3 -e RCLONE_CONFIG_DEST_PROVIDER=Other \
    -e RCLONE_CONFIG_DEST_ENDPOINT="http://${MINIO}:9000" \
    -e RCLONE_CONFIG_DEST_ACCESS_KEY_ID="$AK" \
    -e RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY="$SK" \
    -e RCLONE_CONFIG_DEST_FORCE_PATH_STYLE=true \
    "$BK_IMAGE" mkdir "dest:${BUCKET}" >/dev/null 2>&1 && break
  [ "$i" = 20 ] && { echo "    could not create the bucket"; exit 1; }
  sleep 2
done
echo "    bucket ${BUCKET}"

echo "==> writing documents through the DocumentDB API"
psql1 "SELECT documentdb_api.create_collection('shop','orders');" >/dev/null
psql1 "SELECT documentdb_api.insert_one('shop','orders', ('{\"_id\":\"o' || g || '\",\"total\":' || g || ',\"tag\":\"survives-a-restore\"}')::documentdb_core.bson) FROM generate_series(1,50) g;" >/dev/null
BEFORE="$(psql1 "SELECT cursorPage FROM documentdb_api.find_cursor_first_page('shop','{\"find\":\"orders\",\"filter\":{\"_id\":\"o7\"}}');")"
case "$BEFORE" in
  *survives-a-restore*) echo "    50 documents written" ;;
  *) echo "    FAILED to write documents"; echo "$BEFORE"; exit 1 ;;
esac

echo "==> backing up"
bk "$VOL1" once || { echo "    backup failed"; exit 1; }
KEY="$(bk "$VOL1" latest)"
[ -n "$KEY" ] || { echo "    no object was written"; exit 1; }
echo "    object ${DB_ID}/${KEY}"

echo "==> restoring into a fresh instance with no cluster in it"
docker volume create "$VOL2" >/dev/null
docker run --rm -v "${VOL2}:/sockets" --user 0 "$PG_IMAGE" \
  chown "${PG_UID}:${PG_UID}" /sockets >/dev/null

# The backup image carries the server binaries as well as rclone, because it is
# built from the postgres image — so one container can unpack the archive and
# start the cluster it contains.
docker run -d --name "$PG2" --network "$NET" -v "${VOL2}:/sockets" --user "$PG_UID" \
  -e PGDATA=/tmp/pgdata \
  -e DRIGODB_DATABASE_ID="$DB_ID" \
  -e DRIGODB_BACKUP_BUCKET="$BUCKET" \
  -e DRIGODB_BACKUP_ENDPOINT="http://${MINIO}:9000" \
  -e DRIGODB_BACKUP_KEY="$AK" -e DRIGODB_BACKUP_SECRET="$SK" \
  --entrypoint bash "$BK_IMAGE" -c "
    set -euo pipefail
    /usr/local/bin/drigodb-backup restore '${KEY}'
    # No recovery.signal: a base backup with its WAL included starts as an
    # ordinary cluster and replays what it needs on the way up.
    pg_ctl -D \"\$PGDATA\" -l /tmp/pg.log -w start >/dev/null
    echo RESTORED_READY
    sleep infinity" >/dev/null

for i in $(seq 1 60); do
  docker logs "$PG2" 2>&1 | grep -q RESTORED_READY && break
  docker ps -q --filter "name=$PG2" | grep -q . || {
    echo "    restore container died:"; docker logs "$PG2" 2>&1 | tail -20; exit 1; }
  [ "$i" = 60 ] && { echo "    restore never came up"; docker logs "$PG2" 2>&1 | tail -20; exit 1; }
  sleep 2
done
echo "    cluster restored and started"

echo "==> reading the documents back through the DocumentDB API"
AFTER="$(psql2 "SELECT cursorPage FROM documentdb_api.find_cursor_first_page('shop','{\"find\":\"orders\",\"filter\":{\"_id\":\"o7\"}}');" 2>&1 || true)"
echo "    ${AFTER}"
case "$AFTER" in
  *survives-a-restore*) ;;
  *) echo "==> FAIL: the restore did not bring the documents back"; exit 1 ;;
esac

# One document could survive by luck; the count says the collection came back
# whole. Counted through the API rather than off documentdb_data.documents_<n>,
# because that numbering is DocumentDB's own business — a single create_collection
# already produces more than one such table, so naming one is guesswork.
ALL="$(psql2 "SELECT cursorPage FROM documentdb_api.find_cursor_first_page('shop','{\"find\":\"orders\",\"filter\":{},\"batchSize\":200}');" 2>&1 || true)"
COUNT="$(printf '%s' "$ALL" | grep -o 'survives-a-restore' | wc -l | tr -d ' ')"
echo "    documents restored: ${COUNT}"
[ "$COUNT" = "50" ] || { echo "==> FAIL: expected 50 documents, got ${COUNT}"; exit 1; }

echo "==> PASS"
