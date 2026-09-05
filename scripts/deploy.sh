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
  --from-file="${ROOT}/config/bootstrap.sh" \
  --dry-run=client -o yaml | k apply -f - >/dev/null
ok "drigodb-config applied"

step "Database migrations"
# Its own ConfigMap, not more keys on drigodb-config: --from-file flattens a
# directory, so migrations would otherwise land beside postgresql.conf. Built by
# globbing rather than listing, so adding 002 needs no edit here.
MIG_ARGS=()
for f in "${ROOT}"/config/migrations/*.sql; do MIG_ARGS+=(--from-file="$f"); done
k create configmap drigodb-migrations -n drigodb-databases \
  "${MIG_ARGS[@]}" \
  --dry-run=client -o yaml | k apply -f - >/dev/null
ok "drigodb-migrations applied (${#MIG_ARGS[@]} migration(s))"

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
# deploy/20-api.yaml is the record of what is deployed, and it is read as
# written. This used to resolve the newest v-tag here instead, which was
# convenient and made the manifest a decoy: two clusters applying the same
# commit a week apart ran different images, so a commit did not describe a
# deployment. The pin had also been stale at 0.0.1 for seven releases without
# anyone noticing, because nothing ever read it.
#
# Moving the pin is now a merge. CI publishes an image and rewrites a standing
# issue carrying the one-line diff; a human merges it. That is deliberately not
# a pipeline pushing to main — see the release workflow.
#
# The overrides below remain for deploying something other than what is pinned:
# a branch build, a bisect, a local image on kind.
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
