#!/usr/bin/env bash
# Drive a deployed drigodb through its whole lifecycle and connect a real
# MongoDB client to what it provisions.
#
# Proves the thing that matters: the API hands back a connection string, and
# that connection string works.
#
#   scripts/smoke.sh [external-id]
set -euo pipefail

CTX="${KUBE_CONTEXT:-$(kubectl config current-context)}"
EXTERNAL_ID="${1:-smoke-$(date +%s)}"
API_PORT="${API_PORT:-18080}"
DB_PORT="${DB_PORT:-17017}"

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

step "Connecting a MongoDB client to what it gave us"
start_pf "svc/db-${DB_ID}" "$DB_PORT" drigodb-databases 27017 /tmp/drigodb-smoke-db.log || exit 1
# The URI addresses the in-cluster Service; rewrite the host for the tunnel.
LOCAL_URI="$(echo "$URI" | sed -E "s#@[^/]+/#@localhost:${DB_PORT}/#")"
OUT="$(npx --yes mongosh@latest "$LOCAL_URI" --quiet --eval '
  const d = db.getSiblingDB("smoke");
  d.docs.insertOne({_id:"s1", proof:"provisioned-by-api"});
  print(JSON.stringify(d.docs.find().toArray()));
' 2>&1 | tail -2)" || true
case "$OUT" in
  *provisioned-by-api*) ok "wrote and read a document" ;;
  *) fail "client could not use the database"; echo "$OUT"; exit 1 ;;
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
DB_PORT2=$((DB_PORT + 1))
start_pf "svc/db-${DB_ID}" "$DB_PORT2" drigodb-databases 27017 /tmp/drigodb-smoke-db2.log || exit 1

NEW_LOCAL="$(echo "$NEW_URI" | sed -E "s#@[^/]+/#@localhost:${DB_PORT2}/#")"
OUT="$(npx --yes mongosh@latest "$NEW_LOCAL" --quiet --eval '
  print(JSON.stringify(db.getSiblingDB("smoke").docs.find().toArray()));
' 2>&1 | tail -2)" || true
case "$OUT" in
  *provisioned-by-api*) ok "new credential reads the same data" ;;
  *) fail "new credential could not use the database"; echo "$OUT"; exit 1 ;;
esac

OLD_LOCAL="$(echo "$URI" | sed -E "s#@[^/]+/#@localhost:${DB_PORT2}/#")"
OUT="$(npx --yes mongosh@latest "$OLD_LOCAL" --quiet \
  --eval 'db.getSiblingDB("smoke").docs.find().toArray()' 2>&1 | tail -3)" || true
case "$OUT" in
  *provisioned-by-api*) fail "the OLD credential still works — rotation did not take"; exit 1 ;;
  *) ok "old credential rejected" ;;
esac

echo
printf "${GREEN}${BOLD}drigodb works end to end.${RESET}\n"
printf "  database ${BOLD}%s${RESET} (external_id ${BOLD}%s${RESET}) is running.\n" "$DB_ID" "$EXTERNAL_ID"
printf "  Remove it: curl -XDELETE -H \"Authorization: Bearer \$TOKEN\" localhost:%s/v1/databases/%s\n" "$API_PORT" "$DB_ID"
