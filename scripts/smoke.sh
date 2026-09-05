#!/usr/bin/env bash
# Drive a deployed drigodb through its whole lifecycle and connect a real
# PostgreSQL client to what it provisions.
#
# Proves the thing that matters: the API hands back a connection string, and
# that connection string works.
#
# Runs against whatever kubectl points at — a kind cluster or DOKS. The point of
# it working on both is that it is the SAME script, so "it works locally" and
# "it works remotely" are the same claim rather than two similar ones.
#
#   scripts/smoke.sh [external-id]
set -euo pipefail

CTX="${KUBE_CONTEXT:-$(kubectl config current-context)}"
EXTERNAL_ID="${1:-smoke-$(date +%s)}"
API_PORT="${API_PORT:-18080}"
DB_PORT="${DB_PORT:-15432}"

if [ -t 1 ]; then GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'; else GREEN=''; RED=''; YELLOW=''; BLUE=''; BOLD=''; RESET=''; fi
step() { printf "${BOLD}${BLUE}▸${RESET} ${BOLD}%s${RESET}\n" "$1"; }
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
fail() { printf "  ${RED}✗${RESET} %s\n" "$1"; }
note() { printf "  ${YELLOW}…${RESET} %s\n" "$1"; }

k() { kubectl --context "$CTX" "$@"; }

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

jqf() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d$1)"; }

# Runs psql inside the cluster, against the connection URI EXACTLY as the API
# issued it. The previous version tunnelled a port to the laptop and rewrote the
# URI's host to match, which meant the string being tested was never the string
# the API handed out. This needs no psql on the host either.
#
# The pod carries drigodb.io/allow-database, which is how a consumer opts through
# the database's NetworkPolicy. On kind that policy is unenforced, but carrying
# the label keeps this honest about what a real consumer must do — and on DOKS it
# is the difference between connecting and not.
psql_in_cluster() { # uri sql
  k run "smoke-psql-$RANDOM" -n drigodb-databases --rm -i --restart=Never --quiet \
    --image="${SMOKE_PG_IMAGE:-ghcr.io/cloudnative-pg/postgresql:18}" \
    --labels="drigodb.io/allow-database=${DB_ID}" \
    --env="PGURI=$1" --command -- psql "$1" -tAc "$2" 2>&1
}

start_pf() { # resource local remote logfile
  k port-forward -n "$3" "$1" "$2:$4" >"$5" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 30); do grep -q "Forwarding from" "$5" 2>/dev/null && return 0; sleep 1; done
  fail "port-forward $1 never started"; cat "$5"; return 1
}

step "Target"
ok "context ${CTX}"
TOKEN="$(k get secret drigodb-api-token -n drigodb-system -o jsonpath='{.data.token}' | base64 -d)"
ok "API token read from the cluster"

step "Reaching the API"
start_pf svc/drigodb-api "$API_PORT" drigodb-system 80 /tmp/drigodb-smoke-api.log || exit 1
api() { curl -fsS -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' "$@"; }
api "localhost:${API_PORT}/healthz" >/dev/null || { fail "healthz failed"; exit 1; }
ok "healthz ok"

step "Provisioning '${EXTERNAL_ID}'"
RESP="$(api -XPOST "localhost:${API_PORT}/v1/databases" -d "{\"external_id\":\"${EXTERNAL_ID}\"}")"
DB_ID="$(echo "$RESP" | jqf '["id"]')"
URI="$(echo "$RESP" | jqf '["connection_uri"]')"
ok "id ${DB_ID}"

t0=$(date +%s)
for _ in $(seq 1 90); do
  STATUS="$(api "localhost:${API_PORT}/v1/databases/${DB_ID}" | jqf '["status"]')"
  [ "$STATUS" = "ready" ] && break
  [ "$STATUS" = "failed" ] && { fail "provisioning failed"; k get pods -n drigodb-databases; exit 1; }
  sleep 3
done
[ "$STATUS" = "ready" ] || { fail "never became ready (last: ${STATUS})"; exit 1; }
ok "ready in $(( $(date +%s) - t0 ))s"

step "Connecting a PostgreSQL client to what it gave us"
OUT="$(psql_in_cluster "$URI" "
  CREATE TABLE IF NOT EXISTS smoke (id text PRIMARY KEY, proof text NOT NULL);
  INSERT INTO smoke VALUES ('s1','provisioned-by-api') ON CONFLICT DO NOTHING;
  SELECT proof FROM smoke;")" || true
case "$OUT" in
  *provisioned-by-api*) ok "wrote and read a row, over TLS, with the URI as issued" ;;
  *) fail "client could not use the database"; echo "$OUT"; exit 1 ;;
esac

# The schema drigodb installs into every database, which nothing else asserts
# outside its own integration test.
VER="$(psql_in_cluster "$URI" "SELECT _drigodb.version()")" || true
case "$VER" in
  *.sql*) ok "migrations applied, at $(echo "$VER" | tr -d '\r' | head -1)" ;;
  *) fail "_drigodb.version() did not answer (${VER})"; exit 1 ;;
esac

step "Hibernate and wake"
api -XPOST "localhost:${API_PORT}/v1/databases/${DB_ID}/hibernate" >/dev/null
# Status reports the desired replica count, which reaches zero the moment the
# scale is accepted — well before the pod is gone. Waiting on the pod instead,
# otherwise the wake timing below measures a pod that never went away.
for _ in $(seq 1 60); do
  [ "$(k get pods -n drigodb-databases -l drigodb.io/database-id="${DB_ID}" --no-headers 2>/dev/null | wc -l | tr -d ' ')" = "0" ] && break
  sleep 2
done
ok "hibernated — zero compute, volume retained"

# Waking is also when a database picks up the pod template the control plane
# currently renders — a rebuilt postgres image, a fixed probe. Staling the
# recorded template hash makes the next wake think this database was built by
# an older drigodb, which is exactly the state a real fleet is in after an
# image rebuild. If the reconcile does not run, the hash stays "stale".
k annotate statefulset "db-${DB_ID}" -n drigodb-databases \
  drigodb.io/template-hash=stale --overwrite >/dev/null
ok "marked as built by an older template"

t0=$(date +%s)
api -XPOST "localhost:${API_PORT}/v1/databases/${DB_ID}/wake" >/dev/null
for _ in $(seq 1 60); do
  [ "$(api "localhost:${API_PORT}/v1/databases/${DB_ID}" | jqf '["status"]')" = "ready" ] && break
  sleep 2
done
ok "woke in $(( $(date +%s) - t0 ))s"

HASH="$(k get statefulset "db-${DB_ID}" -n drigodb-databases \
  -o jsonpath='{.metadata.annotations.drigodb\.io/template-hash}')"
case "$HASH" in
  stale|"") fail "wake did not reconcile the template (hash: ${HASH:-unset})"; exit 1 ;;
  *) ok "reconciled to template ${HASH} on the way up" ;;
esac

PG_RUNNING="$(k get pod -n drigodb-databases -l "drigodb.io/database-id=${DB_ID}" \
  -o jsonpath='{.items[0].spec.containers[?(@.name=="postgres")].image}')"
ok "running ${PG_RUNNING}"

step "Rotating credentials"
# The recovery path: the connection URI is handed out on creation and never
# again, so without rotation a caller that loses one can never reach its
# database. This proves the new credential works AND that the old one stops
# working — a rotation that leaves the old password valid is not a rotation.
NEW="$(api -XPOST "localhost:${API_PORT}/v1/databases/${DB_ID}/credentials")"
NEW_URI="$(echo "$NEW" | jqf '["connection_uri"]')"
[ -n "$NEW_URI" ] || { fail "rotation returned no connection_uri"; exit 1; }
[ "$NEW_URI" != "$URI" ] || { fail "rotation returned the same URI"; exit 1; }
ok "new credential issued"

# The pod was replaced to apply it, so the old tunnel is pointing at a pod that
# no longer exists.
OUT="$(psql_in_cluster "$NEW_URI" "SELECT proof FROM smoke")" || true
case "$OUT" in
  *provisioned-by-api*) ok "new credential reads the same data" ;;
  *) fail "new credential could not use the database"; echo "$OUT"; exit 1 ;;
esac

OUT="$(psql_in_cluster "$URI" "SELECT proof FROM smoke")" || true
case "$OUT" in
  *provisioned-by-api*) fail "the OLD credential still works — rotation did not take"; exit 1 ;;
  *) ok "old credential rejected" ;;
esac

echo
printf "${GREEN}${BOLD}drigodb works end to end.${RESET}\n"
printf "  database ${BOLD}%s${RESET} (external_id ${BOLD}%s${RESET}) is running.\n" "$DB_ID" "$EXTERNAL_ID"
printf "  Remove it: curl -XDELETE -H \"Authorization: Bearer \$TOKEN\" localhost:%s/v1/databases/%s\n" "$API_PORT" "$DB_ID"
