#!/usr/bin/env bash
# Create the DOKS cluster drigodb runs on.
#
# Billing starts when this returns. Run scripts/doks-down.sh when you are done —
# a cluster left running for a month costs roughly the node price.
#
# SIZED FOR TESTING, NOT FOR LOAD
#
# s-1vcpu-2gb in fra1: ~$12/month, ~$0.018/hour, so an hour of live testing costs
# about two pence. The previous default, s-2vcpu-4gb, was twice that for headroom
# nothing here uses.
#
# The standard DOKS control plane is free, so the node plan plus the block
# storage each database claims is the whole bill — but only because --ha=false is
# passed below. See the comment there; it is not a formality.
#
# What fits on one 2 GiB node. Requests are 50m/128Mi for the control plane and
# 150m/288Mi per database (postgres 100m/256Mi, gateway 50m/32Mi). After DOKS
# reservations and system pods there is room for roughly THREE concurrent
# databases, with memory binding before CPU. smoke.sh provisions one; the sizing
# measurement provisioned two. Anything that needs more wants a bigger node:
#
#   DRIGODB_DO_NODE_SIZE=s-2vcpu-4gb bash scripts/doks-up.sh
set -euo pipefail

CLUSTER="${DRIGODB_DO_CLUSTER:-drigodb}"
REGION="${DRIGODB_DO_REGION:-fra1}"
NODE_SIZE="${DRIGODB_DO_NODE_SIZE:-s-1vcpu-2gb}"
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
# --ha=false is load-bearing, not belt-and-braces. doctl's own help: "When
# omitted, API applies version-specific default (true for 1.36.0+; false for
# older)" — and DOKS has been handing out 1.36.3. A highly-available control
# plane is a paid add-on, so omitting this flag is how a cluster meant to cost
# $12/month quietly costs several times that. auto-scale=false is stated for the
# same reason: a node pool that grows on its own has no ceiling on the bill.
doctl kubernetes cluster create "$CLUSTER" \
  --region "$REGION" \
  --node-pool "name=default;size=${NODE_SIZE};count=${NODE_COUNT};auto-scale=false" \
  --ha=false \
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
