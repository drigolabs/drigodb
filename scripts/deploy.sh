#!/usr/bin/env bash
# Deploy the drigodb control plane to the current kubectl context.
#
# Idempotent. Generates an API token on first run and prints it once.
#
# Deploys the newest released version by default — the newest v-tag — and
# whatever the chart's appVersion pins. Override it
# to deploy something else:
#
#   DRIGODB_API_IMAGE=ghcr.io/drigolabs/drigodb-api:0.1.0 bash scripts/deploy.sh
#
# DRIGODB_PG_IMAGE and DRIGODB_GATEWAY_IMAGE override the data-plane images the
# same way. Existing databases keep the images their StatefulSet already names;
# an override changes what the next provision or wake uses.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CTX="${KUBE_CONTEXT:-$(kubectl config current-context)}"

if [ -t 1 ]; then GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'; else GREEN=''; YELLOW=''; BLUE=''; BOLD=''; RESET=''; fi
step() { printf "${BOLD}${BLUE}▸${RESET} ${BOLD}%s${RESET}\n" "$1"; }
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
note() { printf "  ${YELLOW}…${RESET} %s\n" "$1"; }

k() { kubectl --context "$CTX" "$@"; }

step "Target"
ok "context ${CTX}"

step "Control plane"
# One `helm upgrade --install` replaces what used to be six kubectl invocations,
# two of which built ConfigMaps by piping `create --dry-run` into `apply` and one
# of which minted the API token from /dev/urandom. None of that could be
# reconciled by anything, which is why it had to go — see decision 0002.
#
# --install so this is the same command whether or not drigodb is already there.
# --create-namespace because the release namespace is Helm's to make; the
# database namespace is the chart's.
HELM_ARGS=()
if [ -n "${DRIGODB_API_IMAGE:-}" ]; then
  # Deploying something other than what the chart pins: a branch build, a
  # bisect, a local image on kind.
  HELM_ARGS+=(--set "image.repository=${DRIGODB_API_IMAGE%:*}" --set "image.tag=${DRIGODB_API_IMAGE##*:}")
  note "overriding the pinned image with ${DRIGODB_API_IMAGE}"
fi
if [ -n "${DRIGODB_STORAGE_CLASS:-}" ]; then
  HELM_ARGS+=(--set "database.storageClass=${DRIGODB_STORAGE_CLASS}")
fi
if [ -n "${DRIGODB_BACKUP_BUCKET:-}" ]; then
  HELM_ARGS+=(--set "backup.bucket=${DRIGODB_BACKUP_BUCKET}" --set "backup.endpoint=${DRIGODB_BACKUP_ENDPOINT:-}")
fi

helm --kube-context "$CTX" upgrade --install drigodb "${ROOT}/charts/drigodb" \
  --namespace drigodb-system --create-namespace \
  ${HELM_ARGS[@]+"${HELM_ARGS[@]}"} \
  --wait --timeout 5m >/dev/null
ok "drigodb-api Ready"

echo
printf "${GREEN}${BOLD}Deployed.${RESET}\n"
printf "  Reach the API:  kubectl --context %s -n drigodb-system port-forward svc/drigodb-api 8080:80\n" "$CTX"
printf "  Then:           curl -H \"Authorization: Bearer \$TOKEN\" localhost:8080/v1/databases\n"
