#!/usr/bin/env bash
# Destroy the DOKS cluster and stop billing.
#
# Deletes every hosted database with it. Block-storage volumes provisioned by
# PVCs are removed with the cluster, so this is not recoverable.
set -euo pipefail

CLUSTER="${DRIGODB_DO_CLUSTER:-drigodb}"

if ! doctl kubernetes cluster get "$CLUSTER" >/dev/null 2>&1; then
  echo "no cluster named '${CLUSTER}'"
  exit 0
fi

printf "This deletes cluster '%s' and every database on it.\n" "$CLUSTER"
printf "Type the cluster name to confirm: "
read -r reply
[ "$reply" = "$CLUSTER" ] || { echo "aborted"; exit 1; }

doctl kubernetes cluster delete "$CLUSTER" --force --dangerous
echo "deleted; billing stopped"
