#!/usr/bin/env bash
# Deploy the drigodb control plane to the current kubectl context.
#
# Idempotent. Generates an API token on first run and prints it once.
#
# Deploys the newest released version by default — the newest v-tag — and
# whatever deploy/20-api.yaml pins if nothing has been tagged yet. Override it
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

step "Namespaces and RBAC"
k apply -f "${ROOT}/deploy/00-namespaces.yaml" >/dev/null
k apply -f "${ROOT}/deploy/10-rbac.yaml" >/dev/null
ok "applied"

step "Database configuration"
# The PostgreSQL config every hosted database mounts. Created from the files in
# config/ so the shipped config is the deployed config.
k create configmap drigodb-config -n drigodb-databases \
  --from-file="${ROOT}/config/postgresql.conf" \
  --from-file="${ROOT}/config/pg_hba.conf" \
  --from-file="${ROOT}/config/pg_ident.conf" \
  --from-file="${ROOT}/config/bootstrap.sh" \
  --from-file="${ROOT}/config/pg_url" \
  --dry-run=client -o yaml | k apply -f - >/dev/null
ok "drigodb-config applied"

step "API token"
if k get secret drigodb-api-token -n drigodb-system >/dev/null 2>&1; then
  note "token already exists; leaving it alone"
else
  TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-40)"
  k create secret generic drigodb-api-token -n drigodb-system --from-literal=token="$TOKEN" >/dev/null
  ok "token generated"
  # Printed only to a terminal. Under CI this same output is a build log, and on
  # a public repository that log is world-readable — so there the script says
  # where the token is rather than what it is.
  if [ -t 1 ]; then
    printf "\n  ${BOLD}API token (shown once):${RESET} %s\n\n" "$TOKEN"
  else
    note "token stored in secret drigodb-api-token; read it with:"
    note "  kubectl -n drigodb-system get secret drigodb-api-token -o jsonpath='{.data.token}' | base64 -d"
  fi
fi

step "Control plane"
# Substitution is anchored on the image name rather than a placeholder, so
# deploy/20-api.yaml stays a valid manifest you can read, diff, and apply by
# hand. Only the overrides that are actually set become sed expressions —
# an empty one would blank the line rather than leave the pinned value alone.
# Nothing writes the released version back into deploy/20-api.yaml any more —
# that would mean a pipeline pushing to main, and a main no one can push to is
# worth more than the bookkeeping. The newest v-tag is the record of what was
# released, so a hand-run deploy tracks the latest release without anyone
# editing a manifest. Falls back to whatever the manifest pins if there are no
# tags yet.
if [ -z "${DRIGODB_API_IMAGE:-}" ]; then
  # Best-effort: the tag is created by CI, so a local clone may not have it yet.
  git -C "$ROOT" fetch --tags --quiet >/dev/null 2>&1 || true
  LATEST="$(git -C "$ROOT" tag --list 'v[0-9]*' --sort=-v:refname 2>/dev/null | head -1)"
  if [ -n "$LATEST" ]; then
    DRIGODB_API_IMAGE="${DRIGODB_REGISTRY:-ghcr.io/drigolabs}/drigodb-api:${LATEST#v}"
    note "deploying the newest release, ${LATEST}"
  fi
fi

SED_ARGS=()
if [ -n "${DRIGODB_API_IMAGE:-}" ]; then
  SED_ARGS+=(-e "s#^\( *image: \).*drigodb-api:.*#\1${DRIGODB_API_IMAGE}#")
fi
if [ -n "${DRIGODB_PG_IMAGE:-}" ]; then
  SED_ARGS+=(-e "s#^\( *value: \).*drigodb-postgres:.*#\1${DRIGODB_PG_IMAGE}#")
fi
if [ -n "${DRIGODB_GATEWAY_IMAGE:-}" ]; then
  SED_ARGS+=(-e "s#^\( *value: \).*drigodb-gateway:.*#\1${DRIGODB_GATEWAY_IMAGE}#")
fi

if [ ${#SED_ARGS[@]} -gt 0 ]; then
  sed "${SED_ARGS[@]}" "${ROOT}/deploy/20-api.yaml" | k apply -f - >/dev/null
  for img in "${DRIGODB_API_IMAGE:-}" "${DRIGODB_PG_IMAGE:-}" "${DRIGODB_GATEWAY_IMAGE:-}"; do
    if [ -n "$img" ]; then ok "pinned ${img}"; fi
  done
else
  k apply -f "${ROOT}/deploy/20-api.yaml" >/dev/null
fi
k rollout status deployment/drigodb-api -n drigodb-system --timeout=300s >/dev/null
ok "drigodb-api Ready"

echo
printf "${GREEN}${BOLD}Deployed.${RESET}\n"
printf "  Reach the API:  kubectl --context %s -n drigodb-system port-forward svc/drigodb-api 8080:80\n" "$CTX"
printf "  Then:           curl -H \"Authorization: Bearer \$TOKEN\" localhost:8080/v1/databases\n"
