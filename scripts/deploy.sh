#!/usr/bin/env bash
# Deploy the drigodb control plane to the current kubectl context.
#
# Idempotent. Generates an API token on first run and prints it once.
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
  printf "\n  ${BOLD}API token (shown once):${RESET} %s\n\n" "$TOKEN"
fi

step "Control plane"
k apply -f "${ROOT}/deploy/20-api.yaml" >/dev/null
k rollout status deployment/drigodb-api -n drigodb-system --timeout=300s >/dev/null
ok "drigodb-api Ready"

echo
printf "${GREEN}${BOLD}Deployed.${RESET}\n"
printf "  Reach the API:  kubectl --context %s -n drigodb-system port-forward svc/drigodb-api 8080:80\n" "$CTX"
printf "  Then:           curl -H \"Authorization: Bearer \$TOKEN\" localhost:8080/v1/databases\n"
