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

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
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

step "Deploy credential for CI"
# CI used to fetch a kubeconfig from DigitalOcean at deploy time. That
# kubeconfig authenticates as the account owner and is cluster-admin, because
# DigitalOcean has no lesser one to issue — so a repository secret reached the
# whole account rather than one deployment.
#
# The credential is minted here instead. This script already runs as an
# administrator, because creating a cluster requires one; that is the right
# place for the privileged step, and it leaves CI holding a token scoped to what
# it actually does. It dies with the cluster.
if ! command -v gh >/dev/null 2>&1; then
  warn "gh not found — skipping. CI cannot deploy until the secrets are set."
elif ! gh auth status >/dev/null 2>&1; then
  warn "gh not authenticated — skipping. CI cannot deploy until the secrets are set."
else
  KCTX="do-${REGION}-${CLUSTER}"
  # The namespaces come from the chart, but the deployer's Roles live in them and
  # this runs before anything is installed. Created here rather than depending on
  # an install that has not happened yet.
  for ns in drigodb-system drigodb-databases; do
    kubectl --context "$KCTX" create namespace "$ns" --dry-run=client -o yaml \
      | kubectl --context "$KCTX" apply -f - >/dev/null
  done
  kubectl --context "$KCTX" apply -f "${ROOT}/deploy/05-deployer-rbac.yaml" >/dev/null
  ok "drigodb-deployer created"

  # The controller populates a manually-created token Secret asynchronously.
  for _ in $(seq 1 30); do
    TOKEN="$(kubectl --context "$KCTX" -n drigodb-system get secret drigodb-deployer-token \
      -o jsonpath='{.data.token}' 2>/dev/null | base64 -d || true)"
    [ -n "${TOKEN:-}" ] && break
    sleep 2
  done
  if [ -z "${TOKEN:-}" ]; then
    warn "the deployer token was never populated — CI cannot deploy"
  else
    SERVER="$(kubectl --context "$KCTX" config view --minify --raw \
      -o jsonpath='{.clusters[0].cluster.server}')"
    CA="$(kubectl --context "$KCTX" config view --minify --raw \
      -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
    printf '%s' "$TOKEN"  | gh secret set DRIGODB_DEPLOY_TOKEN  >/dev/null
    printf '%s' "$SERVER" | gh secret set DRIGODB_CLUSTER_SERVER >/dev/null
    printf '%s' "$CA"     | gh secret set DRIGODB_CLUSTER_CA     >/dev/null
    ok "pushed DRIGODB_DEPLOY_TOKEN, DRIGODB_CLUSTER_SERVER, DRIGODB_CLUSTER_CA"
  fi
fi

echo
printf "${GREEN}${BOLD}Cluster up.${RESET}  context: ${BOLD}do-${REGION}-${CLUSTER}${RESET}\n"
printf "  next: bash scripts/deploy.sh\n"
printf "  ${YELLOW}remember: bash scripts/doks-down.sh when finished${RESET}\n"
