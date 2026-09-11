#!/usr/bin/env bash
# drigodb on a laptop. No cloud account, no billing.
#
# The whole of scripts/doks-up.sh exists because DOKS clusters cost money and
# have to be created and destroyed deliberately. This is the other path: a kind
# cluster, and then THE SAME scripts/deploy.sh that DOKS uses. That sameness is
# the point — "it works locally" and "it works remotely" are one claim rather
# than two similar ones, and a second deploy path would drift from the first the
# way a stand-down check drifted from the credential it was checking.
#
#   scripts/kind-up.sh                  published images, as a consumer gets them
#   scripts/kind-up.sh --local          build the API from this tree and load it
#
# Tear down with scripts/kind-down.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# MinIO's pinned versions live with every other upstream pin, so a bump is one
# edit in one file. Sourced here because kind-up.sh is the only script that runs
# MinIO at all.
# shellcheck disable=SC1091
source "${ROOT}/scripts/versions.env"
CLUSTER="${DRIGODB_KIND_CLUSTER:-drigodb}"
LOCAL=0
BACKUPS=0
for a in "$@"; do
  case "$a" in
    --local) LOCAL=1 ;;
    --with-backups) BACKUPS=1 ;;
    *) echo "unknown option: $a" >&2; exit 64 ;;
  esac
done

if [ -t 1 ]; then GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'; else GREEN=''; YELLOW=''; BLUE=''; BOLD=''; RESET=''; fi
step() { printf "${BOLD}${BLUE}▸${RESET} ${BOLD}%s${RESET}\n" "$1"; }
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "  ${YELLOW}!${RESET} %s\n" "$1"; }

step "Preflight"
for c in kind kubectl helm; do
  command -v "$c" >/dev/null || { echo "$c not found; brew install $c."; exit 1; }
done
docker info >/dev/null 2>&1 || { echo "docker is not running"; exit 1; }
ok "kind, kubectl, helm, docker"

CTX="kind-${CLUSTER}"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  ok "cluster '${CLUSTER}' already exists"
else
  step "Creating kind cluster '${CLUSTER}'"
  kind create cluster --name "$CLUSTER" >/dev/null
  ok "created"
fi
kubectl --context "$CTX" wait --for=condition=Ready node --all --timeout=180s >/dev/null
ok "nodes Ready"

DEPLOY_ENV=()
if [ "$LOCAL" = 1 ]; then
  step "Building the API from this tree"
  # The inner loop, without a registry. Tilt does this on every save; this is
  # the one-shot version for when you just want your branch running.
  docker build -q -t "drigolabs/drigodb-api:dev" --build-arg DRIGODB_VERSION=dev "$ROOT" >/dev/null
  kind load docker-image "drigolabs/drigodb-api:dev" --name "$CLUSTER" >/dev/null
  ok "drigolabs/drigodb-api:dev loaded into the node"
  # pullPolicy Never, or the kubelet goes looking for a tag that exists nowhere
  # but inside this cluster.
  DEPLOY_ENV+=(DRIGODB_API_IMAGE="drigolabs/drigodb-api:dev" DRIGODB_IMAGE_PULL_POLICY=Never)
fi

if [ "$BACKUPS" = 1 ]; then
  # Only the values here. The storage itself is stood up AFTER the chart,
  # because the chart owns the drigodb-databases namespace and Helm refuses to
  # adopt a namespace something else created — "invalid ownership metadata",
  # which reads like a chart bug and is not one.
  DEPLOY_ENV+=(DRIGODB_BACKUP_BUCKET=drigodb DRIGODB_BACKUP_ENDPOINT="http://minio.drigodb-databases:9000")
fi

step "Deploying, with the same script DOKS uses"
KUBE_CONTEXT="$CTX" env ${DEPLOY_ENV[@]+"${DEPLOY_ENV[@]}"} bash "${ROOT}/scripts/deploy.sh"

if [ "$BACKUPS" = 1 ]; then
  step "MinIO, standing in for object storage"
  # Backups need somewhere S3-shaped to go, and CloudNativePG's plugin does the
  # talking — drigodb only names the Secret and never reaches object storage
  # itself. MinIO is S3-compatible and free, which is the whole requirement.
  #
  # After the chart, because the chart owns the drigodb-databases namespace and
  # Helm refuses to adopt one something else created: "invalid ownership
  # metadata", which reads like a chart bug and is not one.
  # Heredoc unquoted, so MINIO_VERSION expands. Nothing else in the block uses
  # `$`, which is what makes that safe.
  kubectl --context "$CTX" apply -n drigodb-databases -f - >/dev/null <<YAML
apiVersion: apps/v1
kind: Deployment
metadata: { name: minio, labels: { app: minio } }
spec:
  replicas: 1
  selector: { matchLabels: { app: minio } }
  template:
    metadata: { labels: { app: minio } }
    spec:
      containers:
        - name: minio
          image: quay.io/minio/minio:${MINIO_VERSION}
          args: ["server", "/data"]
          env:
            - { name: MINIO_ROOT_USER, value: drigodb }
            - { name: MINIO_ROOT_PASSWORD, value: drigodb-local-only }
          ports: [{ containerPort: 9000 }]
---
apiVersion: v1
kind: Service
metadata: { name: minio }
spec:
  selector: { app: minio }
  ports: [{ port: 9000, targetPort: 9000 }]
YAML
  kubectl --context "$CTX" -n drigodb-databases rollout status deployment/minio --timeout=180s >/dev/null

  # The bucket has to exist; barman does not create it.
  kubectl --context "$CTX" -n drigodb-databases delete pod drigodb-mkbucket --ignore-not-found >/dev/null 2>&1
  kubectl --context "$CTX" -n drigodb-databases run drigodb-mkbucket --restart=Never --quiet --image="quay.io/minio/mc:${MINIO_MC_VERSION}" \
    --command -- sh -c "mc alias set m http://minio:9000 drigodb drigodb-local-only && mc mb -p m/drigodb" >/dev/null
  kubectl --context "$CTX" -n drigodb-databases wait --for=jsonpath='{.status.phase}'=Succeeded \
    pod/drigodb-mkbucket --timeout=180s >/dev/null 2>&1
  kubectl --context "$CTX" -n drigodb-databases delete pod drigodb-mkbucket --wait=false >/dev/null 2>&1

  # Read by the operator, never by drigodb.
  kubectl --context "$CTX" -n drigodb-databases create secret generic drigodb-backup-credentials \
    --from-literal=access_key=drigodb --from-literal=secret_key=drigodb-local-only \
    --dry-run=client -o yaml | kubectl --context "$CTX" apply -f - >/dev/null
  ok "minio.drigodb-databases:9000, bucket drigodb"
fi

echo
printf "${GREEN}${BOLD}drigodb is running on kind.${RESET}  context: ${BOLD}${CTX}${RESET}\n"
printf "  Prove it:   ${BOLD}KUBE_CONTEXT=%s bash scripts/smoke.sh${RESET}\n" "$CTX"
printf "  Tear down:  bash scripts/kind-down.sh\n"
echo
warn "Volumes cannot be expanded here — kind's local-path provisioner reports"
warn "allowVolumeExpansion: false, so resize is untestable. Not the chart's doing;"
warn "see charts/drigodb/README.md."
warn ""
warn "NetworkPolicy used to be a no-op on kind and no longer is: kindnet enforces it"
warn "as of the version kind v0.33 ships. scripts/smoke.sh proves it either way"
warn "rather than either of us assuming."
