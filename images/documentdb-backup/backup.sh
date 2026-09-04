#!/usr/bin/env bash
# Back a drigodb database up to S3-compatible storage, and restore one back.
#
# WHY PHYSICAL AND NOT pg_dump
#
# pg_dump cannot produce a restorable backup of a DocumentDB database, and fails
# at it silently. It never dumps the data of tables belonging to an extension
# unless that extension marks them with pg_extension_config_dump(). DocumentDB
# marks none: `SELECT extconfig FROM pg_extension WHERE extname='documentdb'`
# is NULL, where pg_cron marks four tables and PostGIS marks spatial_ref_sys.
#
# A collection's rows live in documentdb_data.documents_<n>, which is created at
# runtime and IS dumped. The registry that makes those rows a collection lives
# in documentdb_api_catalog.collections, which belongs to the extension and is
# NOT. So a logical restore completes without error and leaves every collection
# invisible — the data is there, and nothing can find it. An explicit -t does
# not override this; the dump comes back empty.
#
# pg_basebackup copies the cluster, catalogs included, so it is correct by
# construction. The cost is that a backup is the whole cluster — a ~73 MB floor
# even for an empty database — and restores only into the same PostgreSQL major
# version, which this image guarantees by deriving from the server's own image.
#
#   drigodb-backup once            one backup, then exit
#   drigodb-backup run             back up whenever one is due, forever
#   drigodb-backup restore KEY     unpack that backup into an EMPTY PGDATA
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
#   PGDATA                   restore target; must be empty (restore only)
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
  rclone lsf "${PREFIX}/" 2>/dev/null | grep '\.tar\.gz$' | sort | tail -1
}

backup() {
  local key ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  key="${ts}.tar.gz"
  log "backing up the cluster to ${DB_ID}/${key}"

  # -D - writes a tar to stdout, which requires -Ft and rules out -X stream:
  # streaming WAL needs a second connection and a real directory. -X fetch
  # collects the WAL generated during the copy at the end instead, which is what
  # makes the archive self-contained and restorable on its own.
  #
  # Piped straight out rather than staged on disk. The volume is sized for the
  # database, not for a copy of it — on a 1Gi volume, staging a backup is how a
  # backup fills the disk it exists to protect.
  #
  # --checkpoint=fast so this does not wait out a scheduled checkpoint; the
  # extra I/O is cheaper than holding the backup open.
  pg_basebackup -U postgres -D - -Ft -z -X fetch --checkpoint=fast \
    | rclone rcat "${PREFIX}/${key}"

  log "wrote ${DB_ID}/${key}"
}

due() {
  local newest age now
  newest="$(latest_key)"
  [ -z "$newest" ] && return 0

  now="$(date -u +%s)"
  # 20260903T101500Z -> a form date can parse.
  age=$(( now - $(date -u -d "$(echo "${newest%.tar.gz}" | sed -E 's/^(.{4})(.{2})(.{2})T(.{2})(.{2})(.{2})Z$/\1-\2-\3 \4:\5:\6/')" +%s 2>/dev/null || echo 0) ))
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
    : "${PGDATA:?PGDATA must be set for a restore}"
    # A physical restore replaces a data directory; it does not load into a
    # running server. So the target must be a cluster that does not exist yet —
    # refusing a populated PGDATA rather than unpacking over someone's data.
    if [ -e "${PGDATA}/PG_VERSION" ]; then
      log "refusing to restore over the existing cluster at ${PGDATA}"
      exit 1
    fi
    mkdir -p "$PGDATA"
    log "unpacking ${DB_ID}/${KEY} into ${PGDATA}"
    rclone cat "${PREFIX}/${KEY}" | tar -xzf - -C "$PGDATA"
    # PostgreSQL refuses to start on a data directory that is group- or
    # world-readable, and tar restores whatever modes the archive carries.
    chmod 0700 "$PGDATA"
    log "restored; the server will recover on its next start"
    ;;
  *)
    echo "unknown command: $1" >&2
    exit 64
    ;;
esac
