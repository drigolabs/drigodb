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
CERT_MANAGER_MANIFEST="https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml"
PLUGIN_MANIFEST="https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/${BARMAN_PLUGIN_VERSION}/manifest.yaml"

# Install a component only if nothing already provides it, and never adopt one
# somebody else runs. Repeated three times below, so it lives here once.
already_there() { # crd, description
  if k get crd "$1" >/dev/null 2>&1; then
    note "$2 already present — leaving it alone"
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------

# cert-manager, because the backup plugin below requires it.
#
# Not because drigodb does. Server authentication has always been optional and
# off by default, and an installation that wants neither backups nor verifiable
# certificates needs none of this. It is installed here because the plugin ships
# two Certificates and an Issuer and will not start without something to issue
# them — see issue #95.
install_cert_manager() {
  step "cert-manager ${CERT_MANAGER_VERSION}"
  if already_there certificates.cert-manager.io "cert-manager"; then
    ok "cert-manager present"
    return 0
  fi
  k apply --server-side -f "$CERT_MANAGER_MANIFEST" >/dev/null
  for d in cert-manager cert-manager-webhook cert-manager-cainjector; do
    k -n cert-manager rollout status "deploy/$d" --timeout=300s >/dev/null
  done
  ok "installed ${CERT_MANAGER_VERSION}"
}

# The backup plugin. Decision 0004 took drigodb's backup sidecar with the pod
# template; this is what puts backups back.
#
# The PLUGIN, not spec.backup.barmanObjectStore. That works on the pinned 1.27
# and is removed in CloudNativePG 1.28 — a deprecation the CRD schema does not
# mention and only the admission webhook prints, on apply.
install_barman_plugin() {
  step "barman-cloud plugin ${BARMAN_PLUGIN_VERSION}"
  if already_there objectstores.barmancloud.cnpg.io "the barman-cloud plugin"; then
    ok "plugin present"
    return 0
  fi
  k apply --server-side -f "$PLUGIN_MANIFEST" >/dev/null
  k -n cnpg-system rollout status deploy/barman-cloud --timeout=300s >/dev/null
  ok "installed ${BARMAN_PLUGIN_VERSION}"
}

install_operator() {
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
    return 0
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
}

# ---------------------------------------------------------------------------

# Three components, in the order they depend on each other: the plugin will not
# start without cert-manager, and nothing provisions without the operator.
#
# Each is skipped if something already provides it, and none is ever adopted or
# upgraded — drigodb does not take ownership of a cluster-scoped component
# another team runs.
#
# This ordering, and these pins, are what issue #97 makes declarative. A shell
# script is not how the rest of drigodb is installed, and it is the one part of
# the install that a reconciler cannot see.
install_operator
install_cert_manager
install_barman_plugin
