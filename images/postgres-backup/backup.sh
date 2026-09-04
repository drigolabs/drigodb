#!/usr/bin/env bash
# Back a drigodb database up to S3-compatible storage, and restore one back.
#
# WHY LOGICAL, NOW THAT IT CAN BE
#
# This used to be pg_basebackup, and not by preference. pg_dump never dumps the
# data of tables belonging to an extension unless that extension marks them with
# pg_extension_config_dump(), and DocumentDB marked none — so a logical restore
# completed without error and left every collection invisible. Physical was the
# only correct option, at a ~73 MB floor per backup and restores only into the
# same PostgreSQL major version.
#
# With the extension gone, pg_dump is correct again and strictly better: an
# empty database dumps to under a kilobyte instead of 73 MB, the output restores
# across major versions, and it can be read. Verified in issue #31 — 1000 rows
# with a GIN and an expression index, dumped and restored intact.
#
# A dump is one database, not the cluster, which is also what makes restore an
# ordinary operation: it loads into a running server rather than replacing a
# data directory.
#
#   drigodb-backup once            one backup, then exit
#   drigodb-backup run             back up whenever one is due, forever
#   drigodb-backup restore KEY     load that dump into the app database
#   drigodb-backup latest          print the newest object key, if any
#
# Configuration, all from the environment:
#
#   DRIGODB_DATABASE_ID      the database's id; the object prefix
#   DRIGODB_BACKUP_BUCKET    bucket name
#   DRIGODB_BACKUP_ENDPOINT  https://fra1.digitaloceanspaces.com, or MinIO
#   DRIGODB_BACKUP_KEY       access key
#   DRIGODB_BACKUP_SECRET    secret key
#   DRIGODB_BACKUP_INTERVAL  seconds between backups (default 86400)
#   APP_DB_NAME              database to probe for readiness (default app)
#   PGHOST                   socket directory (default /sockets)
#   DRIGODB_RESTORE_FORCE    set to 1 to load into a non-empty database
set -euo pipefail

DB_ID="${DRIGODB_DATABASE_ID:?DRIGODB_DATABASE_ID must be set}"
BUCKET="${DRIGODB_BACKUP_BUCKET:?DRIGODB_BACKUP_BUCKET must be set}"
APP_DB="${APP_DB_NAME:-app}"
INTERVAL="${DRIGODB_BACKUP_INTERVAL:-86400}"
# Waiting a whole interval to retry a server that simply had not finished
# starting would mean a database wakes, works all day, and is never backed up.
RETRY_SECONDS="${DRIGODB_BACKUP_RETRY:-30}"
export PGHOST="${PGHOST:-/sockets}"

log() { printf '[backup] %s\n' "$1"; }

# rclone is configured entirely from the environment, so there is no config file
# holding a credential and nothing to write at startup. `Other` rather than a
# named provider because the same settings then serve DigitalOcean Spaces and
# MinIO alike; force_path_style is what MinIO needs and Spaces tolerates.
export RCLONE_CONFIG_DEST_TYPE=s3
export RCLONE_CONFIG_DEST_PROVIDER=Other
export RCLONE_CONFIG_DEST_ENDPOINT="${DRIGODB_BACKUP_ENDPOINT:?DRIGODB_BACKUP_ENDPOINT must be set}"
export RCLONE_CONFIG_DEST_ACCESS_KEY_ID="${DRIGODB_BACKUP_KEY:?DRIGODB_BACKUP_KEY must be set}"
export RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY="${DRIGODB_BACKUP_SECRET:?DRIGODB_BACKUP_SECRET must be set}"
export RCLONE_CONFIG_DEST_FORCE_PATH_STYLE=true
export RCLONE_S3_NO_CHECK_BUCKET=true

PREFIX="dest:${BUCKET}/${DB_ID}"

wait_for_server() {
  for _ in $(seq 1 60); do
    pg_isready -q -d "$APP_DB" 2>/dev/null && return 0
    sleep 2
  done
  return 1
}

# Newest first by name, which is chronological because the key is an ISO-8601
# UTC timestamp. Missing prefix is not an error — it is a database that has
# never been backed up.
latest_key() {
  rclone lsf "${PREFIX}/" 2>/dev/null | grep '\.sql\.gz$' | sort | tail -1
}

backup() {
  local key ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  key="${ts}.sql.gz"
  log "backing up ${APP_DB} to ${DB_ID}/${key}"

  # Piped straight out rather than staged on disk. The volume is sized for the
  # database, not for a copy of it — on a 1Gi volume, staging a backup is how a
  # backup fills the disk it exists to protect.
  #
  # Plain SQL rather than -Fc: it compresses to about the same size through gzip,
  # and it can be read and partially recovered by hand, which matters more for a
  # backup than pg_restore's selective-restore options do.
  #
  # As postgres over the socket, so the dump includes objects appuser does not
  # own and needs no credential.
  pg_dump -U postgres -d "$APP_DB" --no-owner --no-privileges \
    | gzip -c \
    | rclone rcat "${PREFIX}/${key}"

  log "wrote ${DB_ID}/${key}"
}

due() {
  local newest age now
  newest="$(latest_key)"
  [ -z "$newest" ] && return 0

  now="$(date -u +%s)"
  # 20260903T101500Z -> a form date can parse.
  age=$(( now - $(date -u -d "$(echo "${newest%.sql.gz}" | sed -E 's/^(.{4})(.{2})(.{2})T(.{2})(.{2})(.{2})Z$/\1-\2-\3 \4:\5:\6/')" +%s 2>/dev/null || echo 0) ))
  [ "$age" -ge "$INTERVAL" ]
}

case "${1:-run}" in
  once)
    wait_for_server
    backup
    ;;
  run)
    # Nothing in this loop may exit non-zero, and that is a safety property
    # rather than tidiness. This container has no readiness probe on purpose,
    # but a crash loop would still leave the pod NotReady, and a NotReady pod is
    # removed from its Service — so an unreachable bucket, a wrong key or a
    # typo'd endpoint would sever a database that is working perfectly well.
    # Backups must never be why a database is unreachable. Every failure here is
    # logged and retried.
    while true; do
      if ! wait_for_server; then
        log "PostgreSQL not ready yet; retrying in ${RETRY_SECONDS}s"
        sleep "$RETRY_SECONDS"
        continue
      fi
      if due; then
        backup || log "backup failed; retrying at the next interval"
      else
        log "not due yet"
      fi
      sleep "$INTERVAL"
    done
    ;;
  latest)
    latest_key
    ;;
  restore)
    KEY="${2:?restore needs an object key}"
    wait_for_server
    # A logical restore loads into a running server, so unlike the physical one
    # it does not need an empty data directory — but it also does not replace
    # what is there. Loading a dump over a populated database leaves a mixture of
    # both, which is worse than either. Refuse by default.
    if [ "$(psql -U postgres -d "$APP_DB" -tAc \
              "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace \
               where n.nspname not in ('pg_catalog','information_schema') and c.relkind='r'")" != "0" ] \
       && [ "${DRIGODB_RESTORE_FORCE:-0}" != "1" ]; then
      log "refusing to restore into a non-empty ${APP_DB}; set DRIGODB_RESTORE_FORCE=1 to override"
      exit 1
    fi
    log "loading ${DB_ID}/${KEY} into ${APP_DB}"
    # ON_ERROR_STOP so a half-applied dump fails loudly instead of reporting
    # success over a database missing whatever errored.
    rclone cat "${PREFIX}/${KEY}" | gunzip -c \
      | psql -U postgres -d "$APP_DB" -v ON_ERROR_STOP=1 -q
    log "restored"
    ;;
  *)
    echo "unknown command: $1" >&2
    exit 64
    ;;
esac
