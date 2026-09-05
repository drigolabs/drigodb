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
APP_DB_CONF="${REPO_ROOT}/charts/drigodb/files"

BK_IMAGE="${1:-drigolabs/drigodb-backup:test}"
PG_IMAGE="${2:-ghcr.io/cloudnative-pg/postgresql:18}"

SFX="$$"
NET="bk-it-${SFX}"
MINIO="bk-it-minio-${SFX}"; PG1="bk-it-pg1-${SFX}"; PG2="bk-it-pg2-${SFX}"
VOL1="bk-it-sock1-${SFX}"; VOL2="bk-it-sock2-${SFX}"; VOL3="bk-it-sock3-${SFX}"
PG3="bk-it-pg3-${SFX}"
BUCKET="drigodb-test"; DB_ID="testdb01"
# The app credential, as production would issue it. The restore Job uses this
# and nothing else: no socket, no superuser.
APP_PW="restoretest123"
AK="minioadmin"; SK="minioadmin"
PG_UID=26

cleanup() {
  docker rm -f "$MINIO" "$PG1" "$PG2" "$PG3" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$VOL1" "$VOL2" "$VOL3" >/dev/null 2>&1 || true
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

# How the restore Job runs: its own pod, over TCP, with the app's credentials.
bk_remote() { # target-container, then the command
  local target="$1"; shift
  docker run --rm --network "$NET" --user "$PG_UID" \
    -e DRIGODB_DATABASE_ID="$DB_ID" \
    -e DRIGODB_BACKUP_BUCKET="$BUCKET" \
    -e DRIGODB_BACKUP_ENDPOINT="http://${MINIO}:9000" \
    -e DRIGODB_BACKUP_KEY="$AK" -e DRIGODB_BACKUP_SECRET="$SK" \
    -e DRIGODB_RESTORE_SOURCE="${DB_ID}/${KEY}" \
    -e PGHOST="$target" -e PGPORT=5432 -e PGUSER=appuser \
    -e PGDATABASE=app -e PGPASSWORD="$APP_PW" -e PGSSLMODE=require \
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
    # The shipped config verbatim, TLS included, and a certificate generated the
    # way bootstrap.sh does. Stripping ssl would be simpler and would make this
    # test unable to reach the server the way production does: pg_hba admits
    # appuser over hostssl only, so a restore Job connecting without TLS is
    # rejected — which is exactly the failure worth catching here.
    cat /app-db/postgresql.conf >> \"\$PGDATA/postgresql.conf\"
    cp /app-db/pg_hba.conf \"\$PGDATA/\"
    openssl req -new -x509 -days 3650 -nodes -text \
      -out \"\$PGDATA/server.crt\" -keyout \"\$PGDATA/server.key\" \
      -subj /CN=drigodb >/dev/null 2>&1
    chmod 0600 \"\$PGDATA/server.key\"
    pg_ctl -D \"\$PGDATA\" -l /tmp/pg.log -w start >/dev/null
    psql -h /sockets -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
      -c \"CREATE ROLE appuser LOGIN PASSWORD '${APP_PW}'\"
    createdb -h /sockets -U postgres -O appuser app
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

echo "==> list names every backup, latest names one"
bk "$VOL1" once >/dev/null 2>&1 || true
LIST_N="$(bk "$VOL1" list | wc -l | tr -d ' ')"
LATEST_N="$(bk "$VOL1" latest | wc -l | tr -d ' ')"
[ "$LATEST_N" = "1" ] || { echo "==> FAIL: latest printed ${LATEST_N} keys"; exit 1; }
[ "$LIST_N" -ge 1 ] || { echo "==> FAIL: list printed nothing"; exit 1; }
bk "$VOL1" list | grep -q "$(bk "$VOL1" latest)" || { echo "==> FAIL: latest is not in list"; exit 1; }
echo "    list=${LIST_N} latest=${LATEST_N}"

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

echo "==> a restore Job loads over TCP, as an ordinary consumer"
start_pg "$PG3" "$VOL3" || exit 1
bk_remote "$PG3" restore-remote || { echo "==> FAIL: restore-remote did not succeed"; exit 1; }
R3="$(docker exec "$PG3" psql -h /sockets -U postgres -d app -At -c 'SELECT count(*) FROM orders')"
[ "$R3" = "50" ] || { echo "==> FAIL: restore-remote loaded ${R3} rows, expected 50"; exit 1; }
echo "    50 rows over TCP with sslmode=require, as appuser"

echo "==> running it again skips rather than double-loading"
# Kubernetes retries a Job. A restore that already succeeded must not make the
# next attempt look like a failure, nor load a second copy over the first.
bk_remote "$PG3" restore-remote 2>&1 | grep -q "already holds tables" \
  || { echo "==> FAIL: a repeat restore-remote did not skip"; exit 1; }
R3B="$(docker exec "$PG3" psql -h /sockets -U postgres -d app -At -c 'SELECT count(*) FROM orders')"
[ "$R3B" = "50" ] || { echo "==> FAIL: a repeat restore changed the data (${R3B} rows)"; exit 1; }
echo "    skipped, still 50 rows"

echo "==> PASS"
