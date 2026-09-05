#!/usr/bin/env bash
# Take the README's Measured figures against a live cluster, in one pass.
#
# Cluster time is billed, so the needs-cluster questions are batched here rather
# than answered one at a time: storage and timings (#32), active memory as a
# quantity that actually means what the table says (#14), whether volume
# expansion is online (#13), and the per-node volume ceiling the tenancy
# decision record flags as unverified.
#
# It is a script rather than a list of commands because every DigitalOcean
# figure in the table is currently n=1, and a table that has already been wrong
# once by 3.5x should be cheap to take again.
#
# Usage: bash scripts/measure.sh [samples]
set -euo pipefail

SAMPLES="${1:-3}"
NS_DB=drigodb-databases
NS_API=drigodb-system
PF_PORT="${PF_PORT:-18080}"

if [ -t 1 ]; then B='\033[1m'; G='\033[0;32m'; Y='\033[0;33m'; R='\033[0m'; else B=''; G=''; Y=''; R=''; fi
step() { printf "\n${B}▸ %s${R}\n" "$1"; }
val()  { printf "  ${G}%-42s${R} %s\n" "$1" "$2"; }
warn() { printf "  ${Y}! %s${R}\n" "$1"; }

command -v kubectl >/dev/null || { echo "kubectl not found"; exit 1; }
kubectl cluster-info >/dev/null 2>&1 || { echo "no cluster in context"; exit 1; }

TOKEN="$(kubectl -n "$NS_API" get secret drigodb-api-token -o jsonpath='{.data.token}' | base64 -d)"
kubectl -n "$NS_API" port-forward svc/drigodb-api "${PF_PORT}:80" >/tmp/measure-pf.log 2>&1 &
PF_PID=$!
CREATED=()
cleanup() {
  for id in ${CREATED[@]+"${CREATED[@]}"}; do
    curl -s -XDELETE "localhost:${PF_PORT}/v1/databases/${id}" -H "Authorization: Bearer $TOKEN" >/dev/null || true
  done
  kill "$PF_PID" 2>/dev/null || true
}
trap cleanup EXIT
for _ in $(seq 1 30); do grep -q "Forwarding from" /tmp/measure-pf.log 2>/dev/null && break; sleep 1; done

api() { curl -s -H "Authorization: Bearer $TOKEN" "$@"; }
status_of() { api "localhost:${PF_PORT}/v1/databases/$1" | sed -E 's/.*"status":"([a-z]+)".*/\1/'; }

wait_ready() { # id timeout-seconds -> echoes seconds taken, or fails
  local id="$1" limit="${2:-300}" start now
  start=$(date +%s)
  while :; do
    [ "$(status_of "$id")" = "ready" ] && { echo $(( $(date +%s) - start )); return 0; }
    now=$(date +%s); [ $(( now - start )) -ge "$limit" ] && return 1
    sleep 1
  done
}

step "Cluster"
val "kubectl context" "$(kubectl config current-context)"
val "nodes" "$(kubectl get nodes --no-headers | wc -l | tr -d ' ')"
NODE_SIZE="$(kubectl get nodes -o jsonpath='{.items[0].metadata.labels.beta\.kubernetes\.io/instance-type}')"
val "node size" "${NODE_SIZE:-unknown}"
val "api version" "$(api "localhost:${PF_PORT}/healthz" || echo unreachable)"

# The ceiling the tenancy record flags as unverified: how many block volumes the
# CSI driver will attach to one node. It caps databases per node regardless of
# how much RAM is bought, and no amount of node sizing moves it.
step "Volume attach ceiling per node (docs/decisions/0001)"
CSI="$(kubectl get csinode -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.drivers[*].name}{"="}{.spec.drivers[*].allocatable.count}{"\n"}{end}' 2>/dev/null || true)"
if [ -n "$CSI" ]; then printf '%s\n' "$CSI" | sed 's/^/  /'; else warn "no csinode allocatable count reported"; fi

step "Provisioning, ${SAMPLES} samples"
PROV_TIMES=()
for i in $(seq 1 "$SAMPLES"); do
  EXT="measure-$(date +%s)-$i"
  T0=$(date +%s)
  ID="$(api -XPOST "localhost:${PF_PORT}/v1/databases" -H 'content-type: application/json' \
        -d "{\"external_id\":\"${EXT}\"}" | sed -E 's/.*"id":"([a-f0-9]+)".*/\1/')"
  [ -n "$ID" ] || { warn "provision $i returned no id"; continue; }
  CREATED+=("$ID")
  if S="$(wait_ready "$ID" 300)"; then
    TOTAL=$(( $(date +%s) - T0 ))
    PROV_TIMES+=("$TOTAL")
    val "sample $i" "${TOTAL}s  (id ${ID})"
  else
    warn "sample $i never became ready"
  fi
done
FIRST_ID="${CREATED[0]:-}"
[ -n "$FIRST_ID" ] || { echo "no database to measure"; exit 1; }
POD="db-${FIRST_ID}-0"

step "Storage, freshly provisioned"
kubectl exec -n "$NS_DB" "$POD" -c postgres -- sh -c '
  D=/var/lib/postgresql/data/pgdata
  echo "  total_pgdata_mb $(du -sm $D | cut -f1)"
  echo "  wal_mb $(du -sm $D/pg_wal | cut -f1)"
  echo "  base_mb $(du -sm $D/base | cut -f1)"
  echo "  app_db $(psql -U postgres -tAc "select pg_size_pretty(pg_database_size(\"app\"))")"
  echo "  extensions $(psql -U postgres -tAc "select count(*) from pg_extension")"
' 2>/dev/null | sed 's/^/ /'

# The quantity #14 exists about. memory.current includes page cache and is not
# RSS; summed RSS double-counts shared_buffers across PostgreSQL's processes.
# PSS divides shared pages by the number of sharers, which is the only one of
# the three that answers "what does this instance actually cost".
step "Active memory, ${SAMPLES} samples"
for i in $(seq 1 "$SAMPLES"); do
  kubectl exec -n "$NS_DB" "$POD" -c postgres -- sh -c '
    rss=0; pss=0
    for p in /proc/[0-9]*; do
      [ -r "$p/smaps_rollup" ] || continue
      r=$(awk "/^Rss:/ {print \$2}" "$p/smaps_rollup" 2>/dev/null || echo 0)
      s=$(awk "/^Pss:/ {print \$2}" "$p/smaps_rollup" 2>/dev/null || echo 0)
      rss=$((rss + ${r:-0})); pss=$((pss + ${s:-0}))
    done
    cur=$(cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0)
    echo "  sum_rss_mib $((rss/1024))  sum_pss_mib $((pss/1024))  cgroup_current_mib $((cur/1048576))"
  ' 2>/dev/null | sed "s/^/  sample $i:/"
  sleep 2
done

step "Row size at scale"
kubectl exec -n "$NS_DB" "$POD" -c postgres -- psql -U postgres -d app -q -c "
  CREATE TABLE IF NOT EXISTS m (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc jsonb NOT NULL);" >/dev/null
for n in 20000 100000; do
  kubectl exec -n "$NS_DB" "$POD" -c postgres -- psql -U postgres -d app -q -c "
    TRUNCATE m;
    INSERT INTO m (doc) SELECT jsonb_build_object('i', g, 'pad', repeat('x', 180))
    FROM generate_series(1, ${n}) g;" >/dev/null
  BYTES="$(kubectl exec -n "$NS_DB" "$POD" -c postgres -- psql -U postgres -d app -tAc \
    "SELECT pg_total_relation_size('m')")"
  val "${n} rows, bytes/row" "$(( BYTES / n ))"
done
kubectl exec -n "$NS_DB" "$POD" -c postgres -- psql -U postgres -d app -q -c "DROP TABLE m" >/dev/null

step "Wake from hibernation, ${SAMPLES} samples"
for i in $(seq 1 "$SAMPLES"); do
  api -XPOST "localhost:${PF_PORT}/v1/databases/${FIRST_ID}/hibernate" >/dev/null
  for _ in $(seq 1 120); do [ "$(status_of "$FIRST_ID")" = "hibernated" ] && break; sleep 1; done
  T0=$(date +%s)
  api -XPOST "localhost:${PF_PORT}/v1/databases/${FIRST_ID}/wake" >/dev/null
  if S="$(wait_ready "$FIRST_ID" 300)"; then val "sample $i" "$(( $(date +%s) - T0 ))s"; else warn "wake $i timed out"; fi
done

# #13: does the FILESYSTEM grow while the volume stays mounted, or does the PVC
# sit in FileSystemResizePending until the pod cycles? Either way the resize
# design in #10 works — it cycles the pod anyway — but this decides whether that
# step is required or merely convenient, which is what it costs a tenant.
step "Volume expansion: online or offline (#13)"
PVC="data-db-${FIRST_ID}-0"
BEFORE="$(kubectl exec -n "$NS_DB" "$POD" -c postgres -- df -h /var/lib/postgresql/data | tail -1 | awk '{print $2}')"
val "filesystem before" "$BEFORE"
kubectl patch pvc "$PVC" -n "$NS_DB" -p '{"spec":{"resources":{"requests":{"storage":"2Gi"}}}}' >/dev/null
for _ in $(seq 1 60); do
  CAP="$(kubectl get pvc "$PVC" -n "$NS_DB" -o jsonpath='{.status.capacity.storage}')"
  [ "$CAP" = "2Gi" ] && break
  sleep 5
done
val "pvc status.capacity" "$(kubectl get pvc "$PVC" -n "$NS_DB" -o jsonpath='{.status.capacity.storage}')"
val "pvc conditions" "$(kubectl get pvc "$PVC" -n "$NS_DB" -o jsonpath='{.status.conditions[*].type}' || echo none)"
AFTER="$(kubectl exec -n "$NS_DB" "$POD" -c postgres -- df -h /var/lib/postgresql/data | tail -1 | awk '{print $2}')"
val "filesystem after, no restart" "$AFTER"
if [ "$AFTER" != "$BEFORE" ]; then
  printf "  ${G}${B}ONLINE${R} — the filesystem grew without cycling the pod\n"
else
  printf "  ${Y}${B}OFFLINE${R} — the pod must restart before the filesystem picks it up\n"
  kubectl delete pod -n "$NS_DB" "$POD" >/dev/null
  kubectl wait --for=condition=Ready pod -n "$NS_DB" "$POD" --timeout=300s >/dev/null 2>&1 || true
  val "filesystem after restart" "$(kubectl exec -n "$NS_DB" "$POD" -c postgres -- df -h /var/lib/postgresql/data | tail -1 | awk '{print $2}')"
fi

printf "\n${B}Done.${R} %d database(s) will be destroyed on exit.\n" "${#CREATED[@]}"
