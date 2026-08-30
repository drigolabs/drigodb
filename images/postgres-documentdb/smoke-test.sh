#!/usr/bin/env bash
# Verifies that an drigolabs/drigodb-postgres image can actually run DocumentDB:
# the extension loads under the preload libraries CNPG will configure, and the
# MongoDB-shaped API performs a real round trip.
#
# Building the image proves only that the package installed. This proves the
# engine works. Run after any base-image, PostgreSQL-major, or DocumentDB
# version bump — see docs/plans/2026-08-29-001 U1.
#
# Usage: ./smoke-test.sh [image-tag]
set -euo pipefail

IMAGE="${1:-drigolabs/drigodb-postgres:18-0.116-0}"
APP_DB="app"

echo "==> smoke-testing ${IMAGE}"

docker run --rm --user 26 "${IMAGE}" bash -euo pipefail -c "
  export PGDATA=/tmp/pgdata PGPORT=5432 PGHOST=/tmp
  initdb -D \"\$PGDATA\" --auth=trust >/dev/null

  # The preload set and cron database CNPG will configure per app cluster.
  {
    echo \"shared_preload_libraries = 'pg_cron,pg_documentdb_core,pg_documentdb'\"
    echo \"cron.database_name = '${APP_DB}'\"
    # Without this, bson renders as a BSONHEX dump rather than extended JSON —
    # which is what an operator inspecting data over SQL (DBeaver) would see.
    echo \"documentdb_core.bsonUseEJson = on\"
    echo \"unix_socket_directories = '/tmp'\"
    # DocumentDB opens internal libpq connections back to the server over TCP,
    # so a socket-only server fails at the first document API call.
    echo \"listen_addresses = 'localhost'\"
  } >> \"\$PGDATA/postgresql.conf\"

  pg_ctl -D \"\$PGDATA\" -o '-c logging_collector=off' -w start >/dev/null
  createdb -h /tmp ${APP_DB}

  psql -h /tmp -d ${APP_DB} -v ON_ERROR_STOP=1 -q -c \
    'CREATE EXTENSION IF NOT EXISTS documentdb CASCADE;'

  echo '--- extensions ---'
  psql -h /tmp -d ${APP_DB} -At -F' ' -c \
    \"SELECT extname, extversion FROM pg_extension WHERE extname LIKE '%documentdb%' OR extname='pg_cron' ORDER BY 1;\"

  echo '--- round trip through the document API ---'
  psql -h /tmp -d ${APP_DB} -v ON_ERROR_STOP=1 -At -c \
    \"SELECT documentdb_api.create_collection('smoke','items');\" >/dev/null
  psql -h /tmp -d ${APP_DB} -v ON_ERROR_STOP=1 -At -c \
    \"SELECT documentdb_api.insert_one('smoke','items','{\\\"_id\\\":\\\"x1\\\",\\\"v\\\":\\\"round-trip\\\"}');\" >/dev/null
  found=\$(psql -h /tmp -d ${APP_DB} -At -c \
    \"SELECT cursorPage FROM documentdb_api.find_cursor_first_page('smoke','{\\\"find\\\":\\\"items\\\",\\\"filter\\\":{}}');\")
  echo \"\$found\"

  case \"\$found\" in
    *round-trip*) echo 'ROUNDTRIP_OK' ;;
    *) echo 'ROUNDTRIP_FAILED'; exit 1 ;;
  esac

  echo '--- PostgreSQL + CNPG-required binaries ---'
  psql -h /tmp -d ${APP_DB} -At -c 'SHOW server_version;'
  for b in initdb postgres pg_ctl pg_controldata pg_basebackup; do
    command -v \"\$b\" >/dev/null || { echo \"MISSING BINARY: \$b\"; exit 1; }
  done
  echo 'CNPG_BINARIES_OK'

  pg_ctl -D \"\$PGDATA\" -m immediate stop >/dev/null
"

echo "==> PASS"
