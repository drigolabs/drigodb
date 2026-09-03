#!/usr/bin/env bash
# Build and push the four drigodb images to GHCR, multi-arch.
#
# CI does this on every release (.github/workflows/release.yml for the API,
# images.yml for the data-plane pair). This script stays for the times CI is not
# the right tool: publishing from a branch, bisecting a build, or bootstrapping a
# new registry. It reads the same images/versions.env that CI does.
#
# DOKS nodes are amd64 and development happens on arm64, so everything is built
# for both. Requires `gh auth refresh -s write:packages` once per machine.
set -euo pipefail

REGISTRY="${DRIGODB_REGISTRY:-ghcr.io/drigolabs}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The upstream versions live in one file that CI reads too, so a hand-run
# publish and a pipeline publish cannot build different things.
# shellcheck source=../images/versions.env
. "${ROOT}/images/versions.env"
DOCUMENTDB_VERSION="${DOCUMENTDB_VERSION}"
PG_MAJOR="${PG_MAJOR}"
API_VERSION="${API_VERSION:-$(node -p "require('${ROOT}/package.json').version")}"

if [ -t 1 ]; then GREEN='\033[0;32m'; BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'; else GREEN=''; BLUE=''; BOLD=''; RESET=''; fi
step() { printf "${BOLD}${BLUE}▸${RESET} ${BOLD}%s${RESET}\n" "$1"; }
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }

step "Preflight"
command -v docker >/dev/null || { echo "docker not found"; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo "docker buildx required for multi-arch builds"; exit 1; }
gh auth token >/dev/null 2>&1 || { echo "gh not authenticated"; exit 1; }
gh auth token | docker login ghcr.io -u "$(gh api user --jq .login)" --password-stdin >/dev/null 2>&1 \
  || { echo "docker login to ghcr.io failed — run: gh auth refresh -s write:packages"; exit 1; }
ok "authenticated to ghcr.io"

# A named builder so repeated runs reuse the cache instead of rebuilding
# PostGIS from scratch every time.
docker buildx inspect drigodb >/dev/null 2>&1 || docker buildx create --name drigodb --use >/dev/null
docker buildx use drigodb

step "postgres (PostgreSQL ${PG_MAJOR} + DocumentDB ${DOCUMENTDB_VERSION})"
docker buildx build --platform "$PLATFORMS" \
  --build-arg "PG_MAJOR=${PG_MAJOR}" --build-arg "DOCUMENTDB_VERSION=${DOCUMENTDB_VERSION}" \
  -t "${REGISTRY}/drigodb-postgres:${PG_MAJOR}-${DOCUMENTDB_VERSION}" \
  --push "${ROOT}/images/postgres-documentdb"
ok "pushed drigodb-postgres:${PG_MAJOR}-${DOCUMENTDB_VERSION}"

step "gateway (DocumentDB ${DOCUMENTDB_VERSION})"
docker buildx build --platform "$PLATFORMS" \
  --build-arg "DOCUMENTDB_VERSION=${DOCUMENTDB_VERSION}" \
  -t "${REGISTRY}/drigodb-gateway:${DOCUMENTDB_VERSION}" \
  --push "${ROOT}/images/documentdb-gateway"
ok "pushed drigodb-gateway:${DOCUMENTDB_VERSION}"

step "backup (PostgreSQL ${PG_MAJOR} + DocumentDB ${DOCUMENTDB_VERSION})"
# Built from the postgres image published above, by digest-free tag: pg_basebackup
# must not be older than the server it copies, and deriving from the same image
# makes that true rather than remembered.
docker buildx build --platform "$PLATFORMS" \
  --build-arg "POSTGRES_IMAGE=${REGISTRY}/drigodb-postgres:${PG_MAJOR}-${DOCUMENTDB_VERSION}" \
  -t "${REGISTRY}/drigodb-backup:${PG_MAJOR}-${DOCUMENTDB_VERSION}" \
  --push "${ROOT}/images/documentdb-backup"
ok "pushed drigodb-backup:${PG_MAJOR}-${DOCUMENTDB_VERSION}"

step "api (${API_VERSION})"
docker buildx build --platform "$PLATFORMS" \
  --build-arg "DRIGODB_VERSION=${API_VERSION}" \
  -t "${REGISTRY}/drigodb-api:${API_VERSION}" \
  --push "${ROOT}"
ok "pushed drigodb-api:${API_VERSION}"

echo
printf "${GREEN}${BOLD}All images published.${RESET}\n"
printf "  Packages default to private on first push. Make them public at\n"
printf "  https://github.com/orgs/drigolabs/packages if the cluster cannot pull.\n"
