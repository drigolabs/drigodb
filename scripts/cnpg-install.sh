#!/usr/bin/env bash
# Install the CloudNativePG operator, pinned, idempotently.
#
# drigodb REQUIRES this operator; it does not ship it. Decision 0004 makes a
# hosted database a CNPG `Cluster`, and this is what teaches a cluster that word.
#
# Why a script and not a chart dependency:
#
#   - CRDs are cluster-scoped and shared. A cluster already running CNPG for
#     something else would find drigodb's chart trying to own its CRDs, and two
#     owners of one CRD is a bad failure that surfaces as an upgrade silently
#     reverting someone else's operator.
#   - Helm installs a subchart's crds/ directory once and never upgrades it, so
#     the CRD would freeze at whatever version was installed first.
#   - The chart cannot detect whether the operator is present. `lookup` is
#     banned (scripts/chart-determinism-test.sh), and `.Capabilities.APIVersions`
#     is the same mistake wearing a different name — it reports whatever the
#     renderer knows, which under `helm template` is a default list rather than
#     the cluster's.
#
# So the requirement is documented, drigodb's own install paths call this, and
# an installation missing the operator fails loudly at the first provision
# rather than quietly at render time.
#
#   bash scripts/cnpg-install.sh
#   KUBE_CONTEXT=kind-drigodb bash scripts/cnpg-install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CTX="${KUBE_CONTEXT:-$(kubectl config current-context)}"
# shellcheck disable=SC1091
source "${ROOT}/scripts/versions.env"

if [ -t 1 ]; then GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'; else GREEN=''; YELLOW=''; BLUE=''; BOLD=''; RESET=''; fi
step() { printf "${BOLD}${BLUE}▸${RESET} ${BOLD}%s${RESET}\n" "$1"; }
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
note() { printf "  ${YELLOW}…${RESET} %s\n" "$1"; }

k() { kubectl --context "$CTX" "$@"; }

MANIFEST="https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/${CNPG_RELEASE_BRANCH}/releases/cnpg-${CNPG_VERSION}.yaml"

step "CloudNativePG ${CNPG_VERSION}"

# An operator someone else installed is left exactly alone. drigodb needs the
# CRD to exist; it does not need to be the one who put it there, and taking
# ownership of a cluster-scoped resource another team manages is precisely the
# failure this script's shape is designed to avoid.
if k get crd clusters.postgresql.cnpg.io >/dev/null 2>&1; then
  FOUND="$(k -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
  if [ -n "$FOUND" ]; then
    note "already installed: ${FOUND}"
    if ! printf '%s' "$FOUND" | grep -q "${CNPG_VERSION}"; then
      note "that is not the pinned ${CNPG_VERSION} — leaving it alone"
      note "drigodb does not upgrade an operator it did not install"
    fi
  else
    note "the CRD exists but cnpg-system/cnpg-controller-manager does not"
    note "something else manages CloudNativePG here — leaving it alone"
  fi
  ok "operator present"
  exit 0
fi

# --server-side, because the CNPG manifest exceeds the annotation size limit a
# client-side apply writes its last-applied-configuration into. A plain apply
# fails on the CRDs with "metadata.annotations: Too long".
k apply --server-side -f "$MANIFEST" >/dev/null
ok "applied ${CNPG_VERSION}"

k -n cnpg-system rollout status deploy/cnpg-controller-manager --timeout=300s >/dev/null
ok "cnpg-system/cnpg-controller-manager ready"

# The webhook is what rejects an invalid Cluster. Provisioning before it is
# serving gets a connection refused from the API server rather than a database.
k -n cnpg-system wait --for=condition=Available deploy/cnpg-controller-manager --timeout=120s >/dev/null
ok "admission webhook serving"
