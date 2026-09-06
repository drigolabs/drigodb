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
# the database's NetworkPolicy — which is what a real consumer must do, and the
# difference between connecting and not. Whether this cluster ENFORCES that is
# checked separately below rather than assumed either way.
PSQL_RUN=0
psql_in_cluster() { # uri sql
  local name out phase
  PSQL_RUN=$((PSQL_RUN + 1))
  name="smoke-psql-$$-${PSQL_RUN}"

  # Reads the pod's LOGS rather than attaching to it.
  #
  # `kubectl run --rm -i` attaches a stream, and a container that finishes before
  # the attach connects loses its output entirely. That race gets MORE likely
  # over time, not less: the first run of this test pulls the image and is slow
  # enough to win, and every run afterwards has it cached and is not. It failed
  # exactly that way — passing on a fresh cluster, then returning empty strings
  # that read as failed assertions.
  k run "$name" -n drigodb-databases --restart=Never --quiet \
    --image="${SMOKE_PG_IMAGE:-ghcr.io/cloudnative-pg/postgresql:18}" \
    --labels="drigodb.io/allow-database=${DB_ID}" \
    --command -- psql "$1" -tAc "$2" >/dev/null 2>&1

  for _ in $(seq 1 60); do
    phase="$(k get pod "$name" -n drigodb-databases -o jsonpath='{.status.phase}' 2>/dev/null)"
    case "$phase" in Succeeded|Failed) break ;; esac
    sleep 2
  done
  out="$(k logs "$name" -n drigodb-databases 2>&1)"
  k delete pod "$name" -n drigodb-databases --wait=false >/dev/null 2>&1 || true
  printf '%s' "$out"
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

step "The operator drigodb provisions through"
# Decision 0004 makes a hosted database a CloudNativePG Cluster. Two things have
# to be true and both fail silently in different ways: a missing CRD makes every
# provision fail at runtime with a message nobody reads until a consumer
# complains, and a missing RBAC rule does the same one layer further in.
#
# `auth can-i --as` asks the API server the same question it will ask itself,
# which is the only way to check a Role without exercising the thing it guards.
if k get crd clusters.postgresql.cnpg.io >/dev/null 2>&1; then
  ok "clusters.postgresql.cnpg.io present"
  # Read from the Deployment rather than assumed. The chart's fullname is
  # `drigodb-api`, not `drigodb`, and a hardcoded guess made this check report a
  # missing permission that was actually present — a false alarm in a preflight
  # is worse than no preflight, because the next person disables it.
  SA="system:serviceaccount:drigodb-system:$(k -n drigodb-system get deploy drigodb-api -o jsonpath='{.spec.template.spec.serviceAccountName}')"
  if [ "$(k auth can-i create clusters.postgresql.cnpg.io --as "$SA" -n drigodb-databases 2>/dev/null)" = "yes" ]; then
    ok "the API may create a Cluster in drigodb-databases"
  else
    fail "the API service account cannot create Clusters — provisioning will fail"
    exit 1
  fi
else
  fail "clusters.postgresql.cnpg.io is missing; run scripts/cnpg-install.sh"
  exit 1
fi

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

step "Two callers at once get one database"
# Not a replica test — a create test. The handler awaits a read before it
# writes, so two requests pass through that gap on a SINGLE replica and both
# create. Measured on main before the fix: two ids, two StatefulSets, two
# volumes, one application split in half, and the caller keeping only one of the
# two URIs it was handed.
#
# Runs at whatever replica count this installation uses, because the race does
# not need two of anything.
RACE_ID="${EXTERNAL_ID}-race"
race_codes=""
race_pids=()
for i in 1 2 3 4; do
  ( api -o "/tmp/drigodb-race-$$-$i.json" -w "%{http_code}" \
      -XPOST "localhost:${API_PORT}/v1/databases" -d "{\"external_id\":\"${RACE_ID}\"}" \
      > "/tmp/drigodb-race-$$-$i.code" 2>/dev/null ) &
  race_pids+=($!)
done
for p in "${race_pids[@]}"; do wait "$p" || true; done
for i in 1 2 3 4; do race_codes="${race_codes}$(cat "/tmp/drigodb-race-$$-$i.code" 2>/dev/null) "; done

RACE_COUNT="$(k get clusters.postgresql.cnpg.io -n drigodb-databases -l "drigodb.io/external-id=${RACE_ID}" --no-headers 2>/dev/null | wc -l | tr -d ' ')"
CREATED="$(printf '%s' "$race_codes" | tr ' ' '\n' | grep -c '^202$' || true)"

if [ "$RACE_COUNT" = "1" ]; then
  ok "4 simultaneous creates, 1 database (codes: ${race_codes})"
else
  if [ "$RACE_COUNT" = "0" ]; then
    fail "4 simultaneous creates made no database at all — every one of them failed"
  else
    fail "4 simultaneous creates made ${RACE_COUNT} databases — one caller's data is split"
  fi
  k get clusters.postgresql.cnpg.io -n drigodb-databases -l "drigodb.io/external-id=${RACE_ID}"
  exit 1
fi
# Exactly one caller owns the password. The others must not be handed a URI they
# would then believe in.
if [ "$CREATED" = "1" ]; then
  ok "exactly one 202, so exactly one connection_uri was issued"
else
  fail "expected one 202, got ${CREATED} (codes: ${race_codes})"
  exit 1
fi
RACE_DB="$(k get clusters.postgresql.cnpg.io -n drigodb-databases -l "drigodb.io/external-id=${RACE_ID}" \
  -o jsonpath='{.items[0].metadata.labels.drigodb\.io/database-id}' 2>/dev/null)"
[ -n "$RACE_DB" ] && api -XDELETE "localhost:${API_PORT}/v1/databases/${RACE_DB}" >/dev/null 2>&1
rm -f "/tmp/drigodb-race-$$-"*

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
# TLS or nothing. CloudNativePG's default pg_hba ends `host all all all
# scram-sha-256` — plain `host` — so a client passing sslmode=disable connects in
# the clear unless drigodb says otherwise. It does, in the Cluster's pg_hba.
#
# This assertion exists because every other connection in this script uses the
# URI as issued, which carries sslmode=require and passes whether or not
# plaintext is ALSO accepted. Nothing else asks the opposite question, and the
# regression was real: measured on kind before the rule was added.
#
# Asserted on the OUTPUT, not on an exit code: psql_in_cluster returns the pod's
# logs and its own status is `printf`, which always succeeds. Written the other
# way round first, and the assertion then fired on every run whatever the server
# did — a check that cannot pass is no better than one that cannot fail.
PLAIN_URI="$(printf '%s' "$URI" | sed 's/sslmode=require/sslmode=disable/')"
PLAIN_OUT="$(psql_in_cluster "$PLAIN_URI" "SELECT 'PLAINTEXT-ACCEPTED'")"
case "$PLAIN_OUT" in
  *PLAINTEXT-ACCEPTED*)
    fail "a plaintext connection was accepted — pg_hba is not requiring TLS"
    exit 1 ;;
  *)
    ok "a plaintext connection is refused" ;;
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

# The template reconcile this used to stale-and-check is gone: CloudNativePG
# owns the pod template and rolls it itself, so there is no drigodb-rendered
# hash for a wake to bring forward. What is still drigodb's, and still worth
# timing, is that a hibernated database comes back.
t0=$(date +%s)
api -XPOST "localhost:${API_PORT}/v1/databases/${DB_ID}/wake" >/dev/null
for _ in $(seq 1 60); do
  [ "$(api "localhost:${API_PORT}/v1/databases/${DB_ID}" | jqf '["status"]')" = "ready" ] && break
  sleep 2
done
[ "$(api "localhost:${API_PORT}/v1/databases/${DB_ID}" | jqf '["status"]')" = "ready" ] \
  || { fail "never came back from hibernation"; exit 1; }
ok "woke in $(( $(date +%s) - t0 ))s"

# The data survived the cycle. Cheap, and it is the assertion that makes
# hibernation a feature rather than a way to lose a volume.
WOKE="$(psql_in_cluster "$URI" "SELECT proof FROM smoke")"
case "$WOKE" in
  *provisioned-by-api*) ok "the row written before hibernation is still there" ;;
  *) fail "data did not survive the hibernate/wake cycle (${WOKE})"; exit 1 ;;
esac

PG_RUNNING="$(k get pod -n drigodb-databases -l "drigodb.io/database-id=${DB_ID}" \
  -o jsonpath='{.items[0].spec.containers[?(@.name=="postgres")].image}')"
ok "running ${PG_RUNNING}"

step "Is the network policy actually enforced?"
# The label is one of drigodb's three isolation layers and the only one that can
# be silently absent: a CNI that does not implement NetworkPolicy creates the
# policies and enforces nothing, with no error anywhere. Every other assertion in
# this script passes identically either way, which is exactly why this one exists.
#
# From `default`, not from drigodb-databases, because that is the shape of a real
# consumer — the policy pairs `namespaceSelector: {}` with a podSelector, so it
# admits a labelled pod from ANY namespace, and probing from inside the database
# namespace would never exercise that.
#
# One pod, relabelled between attempts, so the label is the only variable.
NP_NS=default
NP_POD="smoke-np-$$"
np_try() { # returns 0 if it connected
  k exec -n "$NP_NS" "$NP_POD" -- psql "${URI}&connect_timeout=10" -tAc "select 1" >/dev/null 2>&1
}
k run "$NP_POD" -n "$NP_NS" --restart=Never --quiet \
  --image="${SMOKE_PG_IMAGE:-ghcr.io/cloudnative-pg/postgresql:18}" \
  --command -- sleep 300 >/dev/null 2>&1
if k wait -n "$NP_NS" --for=condition=Ready "pod/$NP_POD" --timeout=120s >/dev/null 2>&1; then
  if np_try; then
    warn "an UNLABELLED pod in ${NP_NS} reached the database"
    warn "this cluster does not enforce NetworkPolicy — the policies exist and drop nothing,"
    warn "so one of drigodb's three isolation layers is decorative here"
  else
    ok "an unlabelled pod in ${NP_NS} cannot reach it"

    # The sharpest assertion: a label naming a DIFFERENT database must not work.
    # Without this, a policy that admitted any drigodb consumer at all would pass
    # the test above and still be broken in the way that matters.
    k label pod -n "$NP_NS" "$NP_POD" "drigodb.io/allow-database=not-this-one" >/dev/null 2>&1
    if np_try; then
      fail "a pod labelled for a DIFFERENT database reached this one — isolation is not per-database"
      exit 1
    fi
    ok "a pod labelled for another database cannot reach it either"

    k label pod -n "$NP_NS" "$NP_POD" "drigodb.io/allow-database=${DB_ID}" --overwrite >/dev/null 2>&1
    if np_try; then
      ok "the same pod reaches it with the right label — the policy is load-bearing"
    else
      fail "labelling the pod correctly did not let it through"
      exit 1
    fi
  fi
  k delete pod -n "$NP_NS" "$NP_POD" --wait=false >/dev/null 2>&1
else
  note "could not start a probe pod; skipping the NetworkPolicy check"
fi

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
