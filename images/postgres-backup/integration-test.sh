#!/usr/bin/env bash
# Proof that a backup is a backup: dump a database holding real rows, push it to
# S3-compatible storage, restore it into a DIFFERENT PostgreSQL instance, and
# read those rows back.
#
# Asserting on the data and not on an exit code is the whole point, and it is
# the lesson the DocumentDB era paid for: pg_dump does not dump the data of
# tables belonging to an extension unless the extension marks them, DocumentDB
# marked none, and a restore therefore completed with no error and left every
# collection invisible. Nothing but reading a row back catches a failure shaped
# like that.
#
# A logical restore loads into a RUNNING server, so the target here is a second
# instance that is already initialised — not an empty data directory. That is
# the substantive difference from the physical backups this replaces, and it is
# what makes restore an ordinary operation rather than a provision.
#
# MinIO stands in for DigitalOcean Spaces. Both speak S3, so the endpoint is
# configuration — which is what keeps this test free of cloud credentials.
#
# Usage: ./integration-test.sh [backup-image] [postgres-image]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DB_CONF="${REPO_ROOT}/config"

BK_IMAGE="${1:-drigolabs/drigodb-backup:test}"
PG_IMAGE="${2:-ghcr.io/cloudnative-pg/postgresql:18}"

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
    # ssl is on in the shipped config and bootstrap.sh generates its certificate;
    # this test does not run bootstrap.sh and connects over the socket, so drop
    # the TLS lines rather than mint a certificate nothing here would present.
    grep -v '^ssl' /app-db/postgresql.conf >> \"\$PGDATA/postgresql.conf\"
    cp /app-db/pg_hba.conf \"\$PGDATA/\"
    pg_ctl -D \"\$PGDATA\" -l /tmp/pg.log -w start >/dev/null
    createdb -h /sockets -U postgres app
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

echo "==> writing rows"
psql1 "CREATE TABLE orders (id text PRIMARY KEY, doc jsonb NOT NULL);" >/dev/null
psql1 "INSERT INTO orders SELECT 'o' || g, jsonb_build_object('total', g, 'tag', 'survives-a-restore') FROM generate_series(1,50) g;" >/dev/null
# An expression index over a jsonb path as well: exactly the kind of object a
# dump can silently drop, and this is the test that would notice.
psql1 "CREATE INDEX orders_total ON orders ((doc->>'total'));" >/dev/null
BEFORE="$(psql1 "SELECT doc::text FROM orders WHERE id='o7';")"
echo "    ${BEFORE}"
case "$BEFORE" in
  *survives-a-restore*) echo "    50 rows written" ;;
  *) echo "==> FAIL: the source did not accept its own rows"; exit 1 ;;
esac

echo "==> backing up"
bk "$VOL1" once || { echo "    backup failed"; exit 1; }
KEY="$(bk "$VOL1" latest)"
[ -n "$KEY" ] || { echo "    no object was written"; exit 1; }
echo "    object ${DB_ID}/${KEY}"

echo "==> restoring into a second, already-running instance"
start_pg "$PG2" "$VOL2" || exit 1
echo "    target ready, holding an empty app database"

# The restore runs against the target's socket. Unlike the physical restore this
# replaces, it needs no PGDATA and no start afterwards — the server is already up.
bk "$VOL2" restore "$KEY" || { echo "    restore failed"; exit 1; }
echo "    dump loaded"

echo "==> reading the rows back"
AFTER="$(psql2 "SELECT doc::text FROM orders WHERE id='o7';" 2>&1 || true)"
echo "    ${AFTER}"
case "$AFTER" in
  *survives-a-restore*) ;;
  *) echo "==> FAIL: the restore did not bring the rows back"; exit 1 ;;
esac

# One row could survive by luck; the count says the table came back whole.
COUNT="$(psql2 "SELECT count(*) FROM orders;" 2>&1 || true)"
echo "    rows restored: ${COUNT}"
[ "$COUNT" = "50" ] || { echo "==> FAIL: expected 50 rows, got ${COUNT}"; exit 1; }

# The index too. A dump that carries data but not indexes restores something
# that works and then does not scale, which is the quiet version of this failure.
IDX="$(psql2 "SELECT count(*) FROM pg_indexes WHERE tablename='orders' AND indexname='orders_total';" 2>&1 || true)"
[ "$IDX" = "1" ] || { echo "==> FAIL: the expression index did not survive"; exit 1; }
echo "    expression index restored"

# Restoring again must refuse rather than double-load.
if bk "$VOL2" restore "$KEY" >/dev/null 2>&1; then
  echo "==> FAIL: a second restore into a populated database should have been refused"; exit 1
fi
echo "    a second restore is refused"

echo "==> PASS"
