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
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" >/dev/null 2>&1 || true; done
  [ -n "${SMOKE_CA_CONFIGMAP:-}" ] && k delete configmap "$SMOKE_CA_CONFIGMAP" -n drigodb-databases >/dev/null 2>&1
  return 0
}
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
  # With server authentication on, the issued URI says verify-full and psql
  # needs the CA to honour it. Mounting the one GET /v1/ca serves is what makes
  # this script work against such an installation at all — and it is the only
  # thing that exercises the verification, since every other assertion here
  # passes on sslmode=require whether or not the chain is any good.
  if [ -n "${SMOKE_CA_CONFIGMAP:-}" ]; then
    # The overrides JSON is generated rather than written by hand, because the
    # SQL argument is multi-line and pasting it into a JSON string produces
    # invalid JSON with a literal newline in it. That failed as "pods not found",
    # which is a long way from "your JSON is malformed".
    OVERRIDES="$(python3 -c '
import json, sys
uri, sql, image, cm = sys.argv[1:5]
print(json.dumps({"spec": {
  "containers": [{
    "name": "psql", "image": image,
    "command": ["psql", uri + "&sslrootcert=/drigodb-ca/ca.crt", "-tAc", sql],
    "volumeMounts": [{"name": "ca", "mountPath": "/drigodb-ca"}],
  }],
  "volumes": [{"name": "ca", "configMap": {"name": cm}}],
}}))' "$1" "$2" "${SMOKE_PG_IMAGE:-ghcr.io/cloudnative-pg/postgresql:18}" "$SMOKE_CA_CONFIGMAP")"
    k run "$name" -n drigodb-databases --restart=Never --quiet \
      --image="${SMOKE_PG_IMAGE:-ghcr.io/cloudnative-pg/postgresql:18}" \
      --labels="drigodb.io/allow-database=${DB_ID}" \
      --overrides="$OVERRIDES" >/dev/null 2>&1
  else
    k run "$name" -n drigodb-databases --restart=Never --quiet \
      --image="${SMOKE_PG_IMAGE:-ghcr.io/cloudnative-pg/postgresql:18}" \
      --labels="drigodb.io/allow-database=${DB_ID}" \
      --command -- psql "$1" -tAc "$2" >/dev/null 2>&1
  fi

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
  # Both resources, not just Clusters. The Role granted clusters and not backups,
  # and a preflight that checked only the first reported everything fine while
  # every backup request returned 500.
  # Verb by verb, because a Role that is right about the resource and wrong
  # about the verb fails at runtime and nowhere else. Both gaps found in this
  # data plane were of exactly that shape: `clusters` granted and `backups` not,
  # then `networkpolicies` granted without `update`, each surfacing as a 403
  # from a real request rather than from anything that checked.
  while read -r verb res; do
    [ -z "$verb" ] && continue
    if [ "$(k auth can-i "$verb" "$res" --as "$SA" -n drigodb-databases 2>/dev/null)" = "yes" ]; then
      ok "the API may ${verb} ${res%%.*}"
    else
      fail "the API service account cannot ${verb} ${res} — that path will fail at runtime"
      exit 1
    fi
  done <<'PERMS'
create clusters.postgresql.cnpg.io
patch clusters.postgresql.cnpg.io
create backups.postgresql.cnpg.io
update networkpolicies.networking.k8s.io
PERMS
else
  fail "clusters.postgresql.cnpg.io is missing; run scripts/cnpg-install.sh"
  exit 1
fi

step "Reaching the API"
start_pf svc/drigodb-api "$API_PORT" drigodb-system 80 /tmp/drigodb-smoke-api.log || exit 1
api() { curl -fsS -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' "$@"; }
api "localhost:${API_PORT}/healthz" >/dev/null || { fail "healthz failed"; exit 1; }
ok "healthz ok"

# Server authentication is optional, so this asks rather than assumes. A 409
# means this installation issues no certificates and the URI will say
# sslmode=require; a certificate means it does, the URI will say verify-full,
# and every connection below has to carry the CA or fail.
SMOKE_CA_CONFIGMAP=""
if CA_PEM="$(api "localhost:${API_PORT}/v1/ca" 2>/dev/null)" && \
   printf '%s' "$CA_PEM" | grep -q "BEGIN CERTIFICATE"; then
  SMOKE_CA_CONFIGMAP="smoke-ca-$$"
  printf '%s' "$CA_PEM" > "/tmp/${SMOKE_CA_CONFIGMAP}.crt"
  k create configmap "$SMOKE_CA_CONFIGMAP" -n drigodb-databases \
    --from-file="ca.crt=/tmp/${SMOKE_CA_CONFIGMAP}.crt" >/dev/null
  ok "server authentication is on; connections will verify against GET /v1/ca"
else
  note "no CA served; this installation issues no certificates and URIs say sslmode=require"
fi

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
# Whatever sslmode the URI carries, not the one it carries today. With server
# authentication on it says verify-full, and a substitution written for
# `require` silently changed nothing — so this connected with verification
# intact, succeeded, and reported that plaintext had been accepted.
PLAIN_URI="$(printf '%s' "$URI" | sed -E 's/sslmode=[a-z-]+/sslmode=disable/')"
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

# Damage the NetworkPolicy while the database is down, so the wake below has
# something to repair.
#
# This stands in for the real case, which is slower and not reproducible in a
# smoke run: a database provisioned by an older drigodb, whose policy predates a
# rule this build renders. Nothing reconciles one — that is the point — so an
# emptied ingress list is the same situation reached in one command.
NP_RULES_BEFORE="$(k get networkpolicy "db-${DB_ID}" -n drigodb-databases \
  -o jsonpath='{.spec.ingress}' | jq 'length')"
k patch networkpolicy "db-${DB_ID}" -n drigodb-databases --type=merge \
  -p '{"spec":{"ingress":[]}}' >/dev/null
[ "$(k get networkpolicy "db-${DB_ID}" -n drigodb-databases -o jsonpath='{.spec.ingress}' | jq 'length')" = "0" ] \
  || { fail "could not empty the NetworkPolicy; the reconcile assertion below would pass for the wrong reason"; exit 1; }
ok "emptied the NetworkPolicy's ${NP_RULES_BEFORE} ingress rules"

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

# And the wake put the policy back. Without the reconcile this is 0, and the
# database comes up reachable by anything in the cluster — which is why an
# out-of-date policy is worth repairing rather than leaving.
NP_RULES_AFTER="$(k get networkpolicy "db-${DB_ID}" -n drigodb-databases \
  -o jsonpath='{.spec.ingress}' | jq 'length')"
if [ "$NP_RULES_AFTER" = "$NP_RULES_BEFORE" ]; then
  ok "the wake rewrote the NetworkPolicy — ${NP_RULES_AFTER} ingress rules back"
else
  fail "the wake left ${NP_RULES_AFTER} ingress rules, expected ${NP_RULES_BEFORE}"
  exit 1
fi

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
# sslmode=require, deliberately, whatever the issued URI says. This probe is
# about whether packets arrive, and with server authentication on the URI says
# verify-full — so a probe pod without the CA fails verification and looks
# exactly like the policy dropping it. It reported the policy as broken when the
# policy was fine.
NP_URI="$(printf '%s' "$URI" | sed -E 's/sslmode=[a-z-]+/sslmode=require/')"
np_try() { # returns 0 if it connected
  k exec -n "$NP_NS" "$NP_POD" -- psql "${NP_URI}&connect_timeout=10" -tAc "select 1" >/dev/null 2>&1
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

step "Backup and restore"
# Skipped when this installation has nowhere to put a backup, which is what the
# API says rather than something this script infers. An installation without
# object storage is a supported configuration, not a broken one.
BACKUPS_STATE="$(api "localhost:${API_PORT}/v1/databases/${DB_ID}" | jqf '["backups"]')"
if [ "$BACKUPS_STATE" != "enabled" ]; then
  note "backups are ${BACKUPS_STATE} for this installation; skipping"
else
  # A row that exists BEFORE the backup, and one after. Without the second, a
  # restore that silently returned the live database would pass.
  psql_in_cluster "$URI" "CREATE TABLE IF NOT EXISTS bk (id int PRIMARY KEY, note text);
    INSERT INTO bk VALUES (1,'before-backup') ON CONFLICT DO NOTHING;" >/dev/null

  BK_ID="$(api -XPOST "localhost:${API_PORT}/v1/databases/${DB_ID}/backups" | jqf '["id"]')"
  for _ in $(seq 1 60); do
    BK_STATE="$(api "localhost:${API_PORT}/v1/databases/${DB_ID}/backups" \
      | python3 -c "import json,sys;print(next((b['status'] for b in json.load(sys.stdin)['backups'] if b['id']=='${BK_ID}'),'missing'))")"
    case "$BK_STATE" in completed|failed) break ;; esac
    sleep 3
  done
  [ "$BK_STATE" = "completed" ] || { fail "backup did not complete (${BK_STATE})"; exit 1; }
  ok "backup ${BK_ID} completed"

  psql_in_cluster "$URI" "INSERT INTO bk VALUES (2,'after-backup') ON CONFLICT DO NOTHING;" >/dev/null

  RESTORED="$(api -XPOST "localhost:${API_PORT}/v1/databases" \
    -d "{\"external_id\":\"${EXTERNAL_ID}-restored\",\"restore_from\":{\"database_id\":\"${DB_ID}\",\"backup_id\":\"${BK_ID}\"}}")"
  R_ID="$(echo "$RESTORED" | jqf '["id"]')"
  R_URI="$(echo "$RESTORED" | jqf '["connection_uri"]')"
  for _ in $(seq 1 90); do
    R_STATE="$(api "localhost:${API_PORT}/v1/databases/${R_ID}" | jqf '["status"]')"
    case "$R_STATE" in ready|failed) break ;; esac
    sleep 3
  done
  [ "$R_STATE" = "ready" ] || { fail "restored database never became ready (${R_STATE})"; exit 1; }
  ok "restored into ${R_ID}"

  # The assertion the whole feature turns on: the restore is the state AT the
  # backup, not the state now. A restore that quietly handed back the live
  # database would look identical without this.
  SAVED_DB_ID="$DB_ID"; DB_ID="$R_ID"
  R_ROWS="$(psql_in_cluster "$R_URI" "SELECT string_agg(note, ',' ORDER BY id) FROM bk")"
  DB_ID="$SAVED_DB_ID"
  case "$R_ROWS" in
    *before-backup*after-backup*) fail "the restore contains data written AFTER the backup"; exit 1 ;;
    *before-backup*) ok "restored to the backup, not to now" ;;
    *) fail "restored database has no data (${R_ROWS})"; exit 1 ;;
  esac

  SRC_ROWS="$(psql_in_cluster "$URI" "SELECT string_agg(note, ',' ORDER BY id) FROM bk")"
  case "$SRC_ROWS" in
    *before-backup*after-backup*) ok "the source database is untouched" ;;
    *) fail "the source lost data during a restore (${SRC_ROWS})"; exit 1 ;;
  esac

  # Restoring someone else's backup is reading their data. A 400 here is a
  # security property, not a validation nicety.
  THEFT="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" \
    -H 'content-type: application/json' -XPOST "localhost:${API_PORT}/v1/databases" \
    -d "{\"external_id\":\"${EXTERNAL_ID}-theft\",\"restore_from\":{\"database_id\":\"${R_ID}\",\"backup_id\":\"${BK_ID}\"}}")"
  if [ "$THEFT" = "400" ]; then
    ok "a backup belonging to another database is refused"
  else
    fail "restoring another database's backup returned ${THEFT}, not 400"
    exit 1
  fi

  api -XDELETE "localhost:${API_PORT}/v1/databases/${R_ID}" >/dev/null 2>&1 || true
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
