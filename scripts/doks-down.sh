#!/usr/bin/env bash
# Destroy the DOKS cluster and stop billing.
#
# Deletes every hosted database with it, and the block-storage volumes holding
# their data. Not recoverable.
#
# WHY THIS SWEEPS VOLUMES ITSELF
#
# `doctl kubernetes cluster delete --dangerous` is documented to remove the
# cluster's associated resources, and it does remove the nodes and any load
# balancers. It does not remove the block volumes that PVCs provisioned.
#
# Observed 2026-09-01: the cluster deleted immediately, its node disappeared
# about two and a half minutes later, and the 2 GiB volume behind the one
# hosted database was still there — unattached, still billing — ten minutes on.
# An earlier version of this script claimed in a comment that --dangerous took
# them, which is where the belief came from. It does not.
#
# Storage is the term that grows with signups, so a teardown that silently
# leaves a volume per database behind is the wrong default in exactly the
# direction that costs money.
#
# The sweep is exact rather than a guess. DOKS tags every volume it provisions
# `k8s:<cluster-id>`, so a volume is removed only when all three hold:
#
#   * it carries a k8s: tag                    — DOKS provisioned it
#   * the cluster in that tag no longer exists — nothing owns it now
#   * it is attached to no droplet             — nothing is using it
#
# A volume belonging to another live cluster fails the second test, and one
# still attached fails the third.
#
# Re-runnable. With the cluster already gone it still sweeps, which is the state
# an interrupted teardown leaves behind.
set -euo pipefail

CLUSTER="${DRIGODB_DO_CLUSTER:-drigodb}"

# Volumes that no surviving cluster owns. Prints "id<TAB>name<TAB>size<TAB>attached".
orphan_volumes() {
  local clusters volumes
  clusters="$(doctl kubernetes cluster list -o json 2>/dev/null || echo '[]')"
  volumes="$(doctl compute volume list -o json 2>/dev/null || echo '[]')"

  CLUSTERS="$clusters" VOLUMES="$volumes" python3 - <<'PY'
import json, os

def load(name):
    try:
        return json.loads(os.environ.get(name) or "[]") or []
    except json.JSONDecodeError:
        return []

live = {c.get("id") for c in load("CLUSTERS")}
for v in load("VOLUMES"):
    owner = next((t[4:] for t in (v.get("tags") or []) if t.startswith("k8s:")), None)
    if owner is None or owner in live:
        continue
    attached = "attached" if v.get("droplet_ids") else "free"
    print(f'{v["id"]}\t{v.get("name","?")}\t{v.get("size_gigabytes","?")}\t{attached}')
PY
}

if doctl kubernetes cluster get "$CLUSTER" >/dev/null 2>&1; then
  printf "This deletes cluster '%s', every database on it, and their volumes.\n" "$CLUSTER"
  printf "Type the cluster name to confirm: "
  read -r reply
  [ "$reply" = "$CLUSTER" ] || { echo "aborted"; exit 1; }

  doctl kubernetes cluster delete "$CLUSTER" --force --dangerous
  echo "cluster deleted"
else
  echo "no cluster named '${CLUSTER}'"
fi

# The node holds the volume open, and it is torn down asynchronously — so the
# volumes are usually still attached for a couple of minutes after the cluster
# call returns. Wait for them rather than failing on a detach that is in flight.
echo "checking for volumes left behind"
for attempt in $(seq 1 24); do
  ORPHANS="$(orphan_volumes)"
  [ -z "$ORPHANS" ] && { echo "  none"; break; }

  REMAINING=0
  while IFS=$'\t' read -r id name size state; do
    [ -z "${id:-}" ] && continue
    if [ "$state" = "free" ]; then
      printf "  removing %s (%s GiB)\n" "$name" "$size"
      doctl compute volume delete "$id" --force >/dev/null
    else
      REMAINING=$((REMAINING + 1))
    fi
  done <<< "$ORPHANS"

  [ "$REMAINING" -eq 0 ] && break
  if [ "$attempt" -eq 24 ]; then
    echo "  still attached after 6 minutes; delete by hand:" >&2
    orphan_volumes >&2
    exit 1
  fi
  printf "  %s still attached to a node being torn down; waiting\n" "$REMAINING"
  sleep 15
done

echo "billing stopped"
