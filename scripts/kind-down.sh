#!/usr/bin/env bash
# Delete the local kind cluster and everything on it.
#
# Unlike doks-down.sh there is nothing to sweep afterwards: kind's volumes are
# directories inside the node container, so they go when it does. Nothing here
# was ever billed.
set -euo pipefail
CLUSTER="${DRIGODB_KIND_CLUSTER:-drigodb}"
command -v kind >/dev/null || { echo "kind not found"; exit 1; }
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "no kind cluster named '${CLUSTER}'"
  exit 0
fi
kind delete cluster --name "$CLUSTER"
echo "gone. nothing was billed."
