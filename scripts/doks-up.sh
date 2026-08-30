#!/usr/bin/env bash
# Create the DOKS cluster drigodb runs on.
#
# Billing starts when this returns. Run scripts/doks-down.sh when you are done —
# a cluster left running for a month costs roughly the node price.
set -euo pipefail

CLUSTER="${DRIGODB_DO_CLUSTER:-drigodb}"
REGION="${DRIGODB_DO_REGION:-ams3}"
NODE_SIZE="${DRIGODB_DO_NODE_SIZE:-s-2vcpu-4gb}"
NODE_COUNT="${DRIGODB_DO_NODE_COUNT:-1}"

if [ -t 1 ]; then GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'; else GREEN=''; YELLOW=''; BLUE=''; BOLD=''; RESET=''; fi
step() { printf "${BOLD}${BLUE}▸${RESET} ${BOLD}%s${RESET}\n" "$1"; }
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "  ${YELLOW}!${RESET} %s\n" "$1"; }

step "Preflight"
command -v doctl >/dev/null || { echo "doctl not found; brew install doctl."; exit 1; }
doctl account get >/dev/null 2>&1 || { echo "doctl not authenticated; run: doctl auth init"; exit 1; }
ok "doctl ready"

if doctl kubernetes cluster get "$CLUSTER" >/dev/null 2>&1; then
  warn "cluster '${CLUSTER}' already exists"
  doctl kubernetes cluster kubeconfig save "$CLUSTER" >/dev/null
  ok "kubeconfig saved; context do-${REGION}-${CLUSTER}"
  exit 0
fi

step "Creating cluster '${CLUSTER}' (${NODE_COUNT}x ${NODE_SIZE} in ${REGION})"
warn "this starts billing"
doctl kubernetes cluster create "$CLUSTER" \
  --region "$REGION" \
  --node-pool "name=default;size=${NODE_SIZE};count=${NODE_COUNT}" \
  --wait
ok "cluster ready"

doctl kubernetes cluster kubeconfig save "$CLUSTER" >/dev/null
ok "kubeconfig saved"

kubectl --context "do-${REGION}-${CLUSTER}" wait --for=condition=Ready node --all --timeout=300s >/dev/null
ok "nodes Ready"

echo
printf "${GREEN}${BOLD}Cluster up.${RESET}  context: ${BOLD}do-${REGION}-${CLUSTER}${RESET}\n"
printf "  next: bash scripts/deploy.sh\n"
printf "  ${YELLOW}remember: bash scripts/doks-down.sh when finished${RESET}\n"
