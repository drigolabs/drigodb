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

step "API token"
# The chart will not invent a credential — a template that generates one renders
# differently every time, and silently rotates it under any renderer without a
# cluster. Querying the cluster is legitimate HERE, in an installer, which is
# why the responsibility moved rather than disappeared.
#
# Created once and then left alone. Rotating it is a deliberate act, not
# something a redeploy does to you: every consumer holds this token, and there is
# no notification when it changes — calls simply start returning 401.
#
# Issue #62 replaces this with tokens drigodb issues itself.
TOKEN_SECRET="${DRIGODB_TOKEN_SECRET:-drigodb-api-token}"
if k get secret "$TOKEN_SECRET" -n drigodb-system >/dev/null 2>&1; then
  note "token already exists; leaving it alone"
else
  k create namespace drigodb-system --dry-run=client -o yaml | k apply -f - >/dev/null
  TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-40)"
  k create secret generic "$TOKEN_SECRET" -n drigodb-system --from-literal=token="$TOKEN" >/dev/null
  ok "token generated"
  note "read it with:"
  note "  kubectl -n drigodb-system get secret ${TOKEN_SECRET} -o jsonpath='{.data.token}' | base64 -d"
fi

step "Control plane"
# One `helm upgrade --install` replaces what used to be six kubectl invocations,
# two of which built ConfigMaps by piping `create --dry-run` into `apply` and one
# of which minted the API token from /dev/urandom. None of that could be
# reconciled by anything, which is why it had to go — see decision 0002.
#
# --install so this is the same command whether or not drigodb is already there.
# --create-namespace because the release namespace is Helm's to make; the
# database namespace is the chart's.
HELM_ARGS=(--set "api.existingSecret=${TOKEN_SECRET}")
if [ -n "${DRIGODB_API_IMAGE:-}" ]; then
  # Deploying something other than what the chart pins: a branch build, a
  # bisect, a local image on kind.
  HELM_ARGS+=(--set "image.repository=${DRIGODB_API_IMAGE%:*}" --set "image.tag=${DRIGODB_API_IMAGE##*:}")
  note "overriding the pinned image with ${DRIGODB_API_IMAGE}"
fi
if [ -n "${DRIGODB_IMAGE_PULL_POLICY:-}" ]; then
  # Never, for an image loaded straight into a kind node: it exists nowhere else,
  # so a kubelet that goes looking for it will fail to pull a tag no registry has.
  HELM_ARGS+=(--set "image.pullPolicy=${DRIGODB_IMAGE_PULL_POLICY}")
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
