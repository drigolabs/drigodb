#!/usr/bin/env bash
# What drigodb does when the cluster underneath it, or its own configuration, is
# wrong — and in one case, deliberately unusual rather than wrong.
#
# Every failure here is SILENT without the readiness gate, which is the whole
# reason src/k8s/preflight.ts exists and the whole reason this script does:
#
#   * With no CloudNativePG operator, `helm install` succeeds, the Deployment goes
#     Ready, and the Role happily grants rights over an API group that does not
#     exist. Nothing is wrong until a consumer provisions.
#   * With no default StorageClass, every database sits `provisioning` forever
#     with an unbound volume and there is no error anywhere to find.
#   * With a `database.storageClass` naming a class this cluster does not have,
#     the same, for a different reason.
#   * And on a hardened cluster that declines the preflight ClusterRole, drigodb
#     must keep SERVING — "I was not allowed to look" is not "it is missing", and
#     refusing to run because a cluster would not answer a diagnostic question
#     makes drigodb unusable exactly where it is run most carefully.
#
# Each of those was verified once, by hand, and then nothing re-ran it. This is
# what re-runs it.
#
# ITS OWN CLUSTER, and its own job in CI. `drigodb works end to end` cannot host
# these: the first assertion is that `helm install --wait` FAILS, which needs an
# installation that has not happened yet, and that job's whole premise is one
# that has. Running in parallel also means these cost the critical path nothing —
# the same argument the `diagrams render` job is built on.
#
#   scripts/install-failure-test.sh
#
# Leaves the cluster up on failure so it can be looked at. Tear it down with
#   kind delete cluster --name drigodb-install-test
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLUSTER="${DRIGODB_KIND_CLUSTER:-drigodb-install-test}"
CTX="kind-${CLUSTER}"
NS=drigodb-system
# Token Secrets live beside the per-database ones, so this script needs both.
NS_DB=drigodb-databases
API_TOKEN=install-test-only
IMAGE="drigolabs/drigodb-api:install-test"

if [ -t 1 ]; then GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'; else GREEN=''; RED=''; YELLOW=''; BLUE=''; BOLD=''; RESET=''; fi
step() { printf "${BOLD}${BLUE}▸${RESET} ${BOLD}%s${RESET}\n" "$1"; }
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
fail() { printf "  ${RED}✗${RESET} %s\n" "$1"; }
note() { printf "  ${YELLOW}…${RESET} %s\n" "$1"; }

k() { kubectl --context "$CTX" "$@"; }

status=0
bad() { fail "$1"; status=1; }

for c in kind kubectl helm docker; do
  command -v "$c" >/dev/null || { echo "$c not found"; exit 1; }
done

step "Preflight"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  ok "cluster '${CLUSTER}' already exists"
else
  kind create cluster --name "$CLUSTER" >/dev/null
  ok "created kind cluster '${CLUSTER}'"
fi
k wait --for=condition=Ready node --all --timeout=180s >/dev/null
docker build -q -t "$IMAGE" --build-arg DRIGODB_VERSION=install-test "$ROOT" >/dev/null
kind load docker-image "$IMAGE" --name "$CLUSTER" >/dev/null
ok "${IMAGE} loaded into the node"

HELM=(--kube-context "$CTX" upgrade --install drigodb "${ROOT}/charts/drigodb"
      --namespace "$NS" --create-namespace
      --set "api.token=${API_TOKEN}"
      --set "image.repository=${IMAGE%:*}" --set "image.tag=${IMAGE##*:}"
      --set "image.pullPolicy=Never")

# The pod, not the Service. An unready pod is removed from its Service's
# endpoints, so anything asking the Service would be testing a connection refused
# rather than reading an answer — and "unready" is the state most of these
# assertions are about.
#
# And the pod of the CURRENT template, which is the whole reason this is not a
# one-line jsonpath. Every `helm upgrade` here changes an environment variable, so
# a new ReplicaSet rolls out — and mid-rollout there are three pods: the old one
# still Running and Ready, the new one ContainerCreating, and one Terminating.
# `{.items[0]}` picked the OLD pod, which answered with the OLD configuration, and
# the assertion that a nonexistent storageClass is caught passed as `ok` while the
# code was right. Found by the test failing and the product being innocent.
#
# The ReplicaSet the Deployment currently points at — by REVISION, not by
# creationTimestamp.
#
# The newest timestamp is wrong, and it fails in the one case this script needs
# most. Reverting `database.storageClass` to empty makes the pod template byte
# identical to the original, because Kubernetes drops an env var whose value is
# "". So the Deployment does not create a third ReplicaSet: it scales the FIRST
# one back up and bumps its revision, leaving the middle one newest by timestamp,
# at revision 2, and scaled to zero. Selecting on it found no pods at all, and two
# assertions read `{}` — reported as storageclass='missing' ready='none'.
#
# `deployment.kubernetes.io/revision` on the Deployment is the authoritative
# answer and is what `kubectl rollout` itself matches on. It is also right when the
# pod never becomes ready, which two of these cases require.
current_hash() {
  local want
  want="$(k -n "$NS" get deploy drigodb-api \
    -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}' 2>/dev/null)"
  k -n "$NS" get rs -l app.kubernetes.io/name=drigodb -o json 2>/dev/null | python3 -c "
import json,sys
want = '$want'
try: items = json.load(sys.stdin).get('items', [])
except Exception: raise SystemExit
for r in items:
    if (r['metadata'].get('annotations') or {}).get('deployment.kubernetes.io/revision') == want:
        print(r['metadata']['labels']['pod-template-hash']); break
else:
    # No revision match is a state worth failing loudly on rather than guessing a
    # ReplicaSet: every assertion downstream would read the wrong pod quietly.
    print('')
"
}
selector() { printf 'app.kubernetes.io/name=drigodb,pod-template-hash=%s' "$(current_hash)"; }
pod() { k -n "$NS" get pods -l "$(selector)" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null; }

# Wait for the current template's pod to be RUNNING — not ready. Ready is what
# half these assertions expect never to happen; running is what makes /readyz
# answerable at all.
await_running() {
  for _ in $(seq 1 45); do
    [ "$(k -n "$NS" get pods -l "$(selector)" \
      -o jsonpath='{.items[0].status.phase}' 2>/dev/null)" = "Running" ] && return 0
    sleep 2
  done
  return 1
}

# One settled reading of the current template: its pod running, and the cached
# preflight answer refreshed. PreflightCache holds for ten seconds, so a read
# taken the moment a pod starts serving can still be the answer from before
# whatever this test just changed.
settle() { await_running || true; sleep 12; snapshot; }

# /readyz, asked of the pod itself.
#
# NOT through `kubectl port-forward`, which this used first and which produced a
# false PASS. Two ways, both of them silent:
#
#   * A forward that outlives its caller keeps the local port. The next call
#     cannot bind it, curl reaches the OLD forward, and the answer comes from a
#     pod with the previous configuration. One leaked forward made "a nonexistent
#     storageClass is caught" report `ok` while the code was correct.
#   * A forward has to be backgrounded and killed, and a command substitution runs
#     its body in a subshell — so the kill races the bind it is trying to undo.
#
# `exec` has neither problem: no port, no background process, nothing to leak, and
# the answer provably comes from the pod named on the command line. The API image
# is node:22-alpine, so `fetch` is already in it — no curl, no extra container.
#
# It is also registered BEFORE the bearer-token middleware in src/server.ts, so
# this needs no credential, which is what lets a readiness probe call it at all.
readyz() {
  local p; p="$(pod)"
  [ -n "$p" ] || { echo '{}'; return 0; }
  k -n "$NS" exec "$p" -- node -e \
    "fetch('http://127.0.0.1:8080/readyz').then(r=>r.text()).then(t=>console.log(t)).catch(()=>console.log('{}'))" \
    2>/dev/null || echo '{}'
}

# An authenticated request, made from inside the pod for the same reasons readyz()
# is: no port to leak and no background process to race. Prints the status code.
#
# node's fetch rather than curl, because the API image is node:22-alpine and has no
# curl — and adding one to the image to make a test easier would be the test changing
# the thing it tests.
api_code() { # token, path, [method], [body]
  local p; p="$(pod)"
  [ -n "$p" ] || { echo "000"; return 0; }
  k -n "$NS" exec "$p" -- node -e "
const opts = { method: process.argv[2] || 'GET', headers: { authorization: 'Bearer ' + process.argv[1] } };
if (process.argv[3]) { opts.body = process.argv[3]; opts.headers['content-type'] = 'application/json'; }
fetch('http://127.0.0.1:8080' + process.argv[4], opts)
  .then(r => console.log(r.status)).catch(() => console.log('000'));
" -- "$1" "${3:-GET}" "${4:-}" "$2" 2>/dev/null || echo "000"
}

# One answer, read once, parsed as many times as an assertion needs. Asking twice
# about the same moment is also asking about two different moments, and these
# assertions read two fields of one answer.
BODY='{}'
snapshot() { BODY="$(readyz)"; }

# The STATUS of a NAMED check, not just the pod's ready bit. "Not ready" is one
# bit and these are four different failures; a test that cannot tell them apart
# would pass when the wrong one fired.
check_status() {
  printf '%s' "$BODY" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('no-answer'); raise SystemExit
print(next((c['status'] for c in d.get('checks',[]) if c['name']=='$1'), 'missing'))
"
}
overall_ready() {
  printf '%s' "$BODY" | python3 -c "
import json,sys
try: print(str(json.load(sys.stdin).get('ready')).lower())
except Exception: print('no-answer')
"
}
detail() {
  printf '%s' "$BODY" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: raise SystemExit
print(next((c['detail'] for c in d.get('checks',[]) if c['name']=='$1'), '')[:140])
"
}

# Readiness as the kubelet sees it, which is the thing `helm install --wait` and
# a Service's endpoints both act on.
await_ready() { # want, attempts
  local want="$1" n="${2:-45}" got=""
  for _ in $(seq 1 "$n"); do
    got="$(k -n "$NS" get pods -l "$(selector)" \
      -o jsonpath='{.items[0].status.containerStatuses[0].ready}' 2>/dev/null || true)"
    [ "$got" = "$want" ] && break
    sleep 2
  done
  printf '%s' "$got"
}
restarts() {
  k -n "$NS" get pods -l "$(selector)" \
    -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}' 2>/dev/null || echo "?"
}

# ---------------------------------------------------------------------------
step "Installing with no operator fails, rather than going green"
# --wait --timeout, and the failure is the assertion. Helm reports success on a
# Deployment that never becomes available if it is not told to wait, which is how
# this shipped installable-and-useless in the first place.
if helm "${HELM[@]}" --wait --timeout 90s >/dev/null 2>&1; then
  bad "helm install SUCCEEDED on a cluster with no CloudNativePG; a documented install would look fine and provision nothing"
else
  ok "helm install --wait failed, as it must"
fi

if [ "$(await_ready false 30)" = "false" ]; then
  ok "the pod is up and unready, rather than crash-looping"
  [ "$(restarts)" = "0" ] || note "it restarted $(restarts) time(s); readiness and liveness should be separate"
else
  bad "the pod did not settle into unready with no operator"
fi

settle
OP="$(check_status cloudnativepg)"
if [ "$OP" = "failed" ]; then
  ok "/readyz names cloudnativepg as the failure: $(detail cloudnativepg)"
else
  bad "cloudnativepg reported '${OP}', not 'failed' — the gate is not catching a missing operator"
fi
# The storage check must be INDEPENDENT of it. kind ships a default
# StorageClass, so a preflight that failed everything whenever one thing was
# wrong would be indistinguishable from this passing.
SC="$(check_status storageclass)"
if [ "$SC" = "ok" ]; then
  ok "storageclass is still ok, so the checks are independent"
else
  bad "storageclass reported '${SC}' on a cluster that has kind's default; the checks are not independent"
fi

# ---------------------------------------------------------------------------
step "And goes ready when the operator arrives, with no redeploy"
KUBE_CONTEXT="$CTX" bash "${ROOT}/scripts/cnpg-install.sh" >/dev/null
BEFORE_RESTARTS="$(restarts)"
if [ "$(await_ready true 60)" = "true" ]; then
  ok "ready once CloudNativePG is installed"
else
  bad "drigodb stayed unready after the operator was installed"
fi
if [ "$(restarts)" = "$BEFORE_RESTARTS" ]; then
  ok "it recovered without a restart — the gate is readiness, not liveness"
else
  bad "it recovered by restarting ($BEFORE_RESTARTS -> $(restarts)); a crash loop would also 'recover'"
fi

# ---------------------------------------------------------------------------
step "No default StorageClass is caught"
# python, not a jsonpath filter: the annotation key contains dots, and escaping
# them inside a jsonpath filter expression is a different dialect on every
# kubectl version. A wrong one here yields an empty string, which looks like
# "this cluster has no default" and would skip the test silently.
DEFAULT_SC="$(k get sc -o json | python3 -c "
import json,sys
for c in json.load(sys.stdin)['items']:
    if (c['metadata'].get('annotations') or {}).get('storageclass.kubernetes.io/is-default-class') == 'true':
        print(c['metadata']['name']); break
")"
if [ -z "$DEFAULT_SC" ]; then
  bad "this cluster has no default StorageClass to un-default; the test cannot run"
else
  k annotate sc "$DEFAULT_SC" storageclass.kubernetes.io/is-default-class- >/dev/null
  settle
  SC="$(check_status storageclass)"
  if [ "$SC" = "failed" ] && [ "$(overall_ready)" = "false" ]; then
    ok "unready, and storageclass is named — a database would never bind a volume"
  else
    bad "storageclass reported '${SC}' with ready=$(overall_ready) and no default class; every database would sit in provisioning silently"
  fi
  k annotate sc "$DEFAULT_SC" storageclass.kubernetes.io/is-default-class=true >/dev/null
  [ "$(await_ready true 30)" = "true" ] \
    && ok "ready again once ${DEFAULT_SC} is the default" \
    || bad "did not recover when the default StorageClass came back"
fi

# ---------------------------------------------------------------------------
step "A storageClass this cluster does not have is caught"
# The other arm of the same check, and it is worth its own assertion: the named
# branch and the cluster-default branch are different code and only one of them
# is exercised by an installation that names nothing.
helm "${HELM[@]}" --set "database.storageClass=a-class-that-does-not-exist" >/dev/null 2>&1 || true
settle
SC="$(check_status storageclass)"
if [ "$SC" = "failed" ]; then
  ok "a named StorageClass that does not exist is a failure, not a default"
else
  bad "storageclass reported '${SC}' for a class this cluster does not have; databases would sit in provisioning"
fi
helm "${HELM[@]}" --set "database.storageClass=" >/dev/null 2>&1 || true
[ "$(await_ready true 30)" = "true" ] && ok "ready again with the setting removed" \
  || bad "did not recover when database.storageClass was cleared"

# ---------------------------------------------------------------------------
step "A cluster that declines the preflight ClusterRole still gets served"
# The assertion that is the opposite shape to the rest, and the one most likely
# to be broken by a well-meaning change: `unverified` must NOT block. drigodb
# takes exactly one cluster-scoped grant, read-only over StorageClasses, and an
# installation is entitled to refuse it.
k delete clusterrolebinding drigodb-api-preflight >/dev/null
settle
SC="$(check_status storageclass)"
RDY="$(overall_ready)"
if [ "$SC" = "unverified" ] && [ "$RDY" = "true" ]; then
  ok "storageclass is unverified and drigodb is still ready: $(detail storageclass)"
else
  bad "with the ClusterRoleBinding gone, storageclass='${SC}' ready='${RDY}' — expected unverified and still ready. A hardened cluster cannot run this build"
fi
if [ "$(await_ready true 20)" = "true" ]; then
  ok "the kubelet agrees: still serving"
else
  bad "the pod went unready because a diagnostic question was declined"
fi
helm "${HELM[@]}" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
step "cnpg-install.sh leaves an operator it did not install alone"
# The invariant: drigodb needs the CRD to exist, not to be the one who put it
# there. Taking ownership of a cluster-scoped resource another team manages is
# the failure that script's whole shape is designed to avoid, and nothing
# re-checked it.
BEFORE_IMAGE="$(k -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}')"
BEFORE_GEN="$(k -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.metadata.generation}')"
OUT="$(KUBE_CONTEXT="$CTX" bash "${ROOT}/scripts/cnpg-install.sh" 2>&1)"
AFTER_GEN="$(k -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.metadata.generation}')"
if printf '%s' "$OUT" | grep -q "already installed"; then
  ok "a second run recognises what is there"
else
  bad "a second run did not report the operator as already installed"
fi
if [ "$BEFORE_GEN" = "$AFTER_GEN" ]; then
  ok "it changed nothing — generation ${AFTER_GEN} before and after"
else
  bad "the Deployment's generation moved ${BEFORE_GEN} -> ${AFTER_GEN}; a re-run is not a no-op"
fi

step "And does not upgrade one at a different version"
# Pretending someone else runs a different CNPG. The image is reverted below, so
# this leaves the cluster as it found it.
k -n cnpg-system set image deploy/cnpg-controller-manager \
  manager=ghcr.io/cloudnative-pg/cloudnative-pg:1.26.0 >/dev/null
OUT="$(KUBE_CONTEXT="$CTX" bash "${ROOT}/scripts/cnpg-install.sh" 2>&1)"
NOW_IMAGE="$(k -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}')"
if printf '%s' "$NOW_IMAGE" | grep -q "1.26.0"; then
  ok "left the other version in place"
else
  bad "it replaced someone else's operator: ${NOW_IMAGE}"
fi
if printf '%s' "$OUT" | grep -q "leaving it alone"; then
  ok "and said so, rather than doing it quietly"
else
  bad "it left the version alone without saying why; the next person will not know it was deliberate"
fi
k -n cnpg-system set image deploy/cnpg-controller-manager manager="$BEFORE_IMAGE" >/dev/null

# ---------------------------------------------------------------------------
step "An installation can lose its bootstrap token and keep working"
# The one case here that is not a broken cluster: it is a deliberate and supported
# end state. DRIGODB_API_TOKEN is the pre-existing trust that mints the first real
# token (#62), and an installation that has issued its own should be able to take
# it away. That path cannot be reached from smoke.sh, whose every other assertion
# authenticates with exactly this token.
#
# The failure mode if it is wrong is an installation that looks bricked: 401 to
# everything, with nothing in the logs saying why.
ISSUE_BODY='{"name":"survives bootstrap removal","tier":"admin"}'
ISSUED="$(k -n "$NS" exec "$(pod)" -- node -e "
fetch('http://127.0.0.1:8080/v1/tokens', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + process.argv[1], 'content-type': 'application/json' },
  body: process.argv[2],
}).then(r => r.text()).then(t => console.log(t)).catch(() => console.log('{}'));
" -- "$API_TOKEN" "$ISSUE_BODY" 2>/dev/null || echo '{}')"
SURVIVOR="$(printf '%s' "$ISSUED" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('token',''))
except Exception: print('')")"
if [ -n "$SURVIVOR" ]; then
  ok "issued an admin token with the bootstrap token"
else
  bad "could not issue a token to survive with: ${ISSUED}"
fi

# Removed the way an operator removes it. `set env ... NAME-` drops the variable
# whatever its source, which here is a secretKeyRef.
k -n "$NS" set env deploy/drigodb-api DRIGODB_API_TOKEN- >/dev/null
settle
if [ "$(await_ready true 45)" = "true" ]; then
  ok "it comes back up and stays ready with no bootstrap token"
else
  bad "the pod did not become ready after the bootstrap token was removed"
fi
# `pod()`, not `-l app.kubernetes.io/name=drigodb`. That selector matches both
# ReplicaSets during a rollout, and kubectl read the OLD pod's log — which says the
# opposite, because the old pod still had the token. THIRD time this file has been
# bitten by selecting pods without pinning the revision; the helper exists, use it.
if k -n "$NS" logs "$(pod)" --tail=40 2>/dev/null | grep -q "NO bootstrap token"; then
  ok "and says so in the log, rather than leaving 401s unexplained"
else
  bad "nothing in the log mentions the missing bootstrap token; a locked installation would look broken"
fi

if [ -n "$SURVIVOR" ]; then
  SURV_CODE="$(api_code "$SURVIVOR" /v1/databases)"
  OLD_CODE="$(api_code "$API_TOKEN" /v1/databases)"
  if [ "$SURV_CODE" = "200" ] && [ "$OLD_CODE" = "401" ]; then
    ok "the issued token still works and the removed one no longer does"
  else
    bad "issued token got ${SURV_CODE} (want 200) and the removed bootstrap token got ${OLD_CODE} (want 401)"
  fi
  # The property that makes removal safe rather than a one-way door.
  MINT="$(api_code "$SURVIVOR" /v1/tokens POST '{"name":"minted after removal"}')"
  if [ "$MINT" = "201" ]; then
    ok "and can still mint more — the installation is self-sustaining"
  else
    bad "the surviving admin token got ${MINT} from POST /v1/tokens, not 201; removing the bootstrap token is a one-way door"
  fi
fi

step "And an installation with no tokens at all is locked, not broken"
# Every credential gone. It must answer 401 and stay READY: a pod that went unready
# here would be restarted by nothing and fixed by nobody, and the recovery below
# needs the process running.
k -n "$NS_DB" delete secret -l drigodb.io/token-id >/dev/null 2>&1 || true
settle
LOCKED="$(api_code "${SURVIVOR:-nothing}" /v1/databases)"
if [ "$LOCKED" = "401" ]; then
  ok "every token is refused"
else
  bad "with no tokens at all, a request returned ${LOCKED} rather than 401"
fi
if [ "$(await_ready true 20)" = "true" ]; then
  ok "and the pod is still ready, so there is something left to recover"
else
  bad "the pod went unready with no tokens; an operator would be debugging the wrong thing"
fi

# Recovery from cluster access alone, which is the only trust left. This is the
# bootstrap #62 documents, and it had never been executed.
RECOVERED_TOKEN="recovered-$(date +%s)-$$"
RECOVERED_HASH="$(printf %s "$RECOVERED_TOKEN" | shasum -a 256 | cut -d' ' -f1)"
k -n "$NS_DB" create secret generic token-recovered --from-literal=hash="$RECOVERED_HASH" >/dev/null
k -n "$NS_DB" label secret token-recovered \
  drigodb.io/token-id=recovered drigodb.io/token-tier=admin >/dev/null
k -n "$NS_DB" annotate secret token-recovered \
  drigodb.io/token-name="recovered with kubectl" >/dev/null
settle
REC="$(api_code "$RECOVERED_TOKEN" /v1/databases)"
REC_MINT="$(api_code "$RECOVERED_TOKEN" /v1/tokens POST '{"name":"back in business"}')"
if [ "$REC" = "200" ] && [ "$REC_MINT" = "201" ]; then
  ok "a Secret made with kubectl is a working admin token — the documented bootstrap works"
else
  bad "the hand-made token got ${REC} on /v1/databases and ${REC_MINT} on POST /v1/tokens; an installation could not be recovered from cluster access alone"
fi

echo
if [ "$status" = 0 ]; then
  printf "${GREEN}${BOLD}A broken cluster is a loud failure, and a hardened one still works.${RESET}\n"
  kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
  printf "  cluster '%s' deleted\n" "$CLUSTER"
else
  printf "${RED}${BOLD}Install-time behaviour is not what it claims.${RESET}\n"
  printf "  cluster '%s' left up: kubectl --context %s -n %s get pods\n" "$CLUSTER" "$CTX" "$NS"
  printf "  tear down with: kind delete cluster --name %s\n" "$CLUSTER"
fi
exit "$status"
