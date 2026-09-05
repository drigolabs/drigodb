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
#   scripts/kind-up.sh --with-backups   add MinIO, so backups and restore work
#
# Tear down with scripts/kind-down.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
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
  step "MinIO, standing in for object storage"
  # Backups need somewhere S3-shaped to go. MinIO is what the backup image's own
  # integration test already runs against, so this is the same substitution the
  # tests make, not a new one.
  kubectl --context "$CTX" create namespace drigodb-databases --dry-run=client -o yaml \
    | kubectl --context "$CTX" apply -f - >/dev/null
  kubectl --context "$CTX" apply -n drigodb-databases -f - >/dev/null <<'YAML'
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
          image: minio/minio
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
  kubectl --context "$CTX" -n drigodb-databases create secret generic drigodb-backup-credentials \
    --from-literal=access_key=drigodb --from-literal=secret_key=drigodb-local-only \
    --dry-run=client -o yaml | kubectl --context "$CTX" apply -f - >/dev/null
  kubectl --context "$CTX" -n drigodb-databases rollout status deployment/minio --timeout=180s >/dev/null
  ok "minio.drigodb-databases:9000, bucket drigodb"
  DEPLOY_ENV+=(DRIGODB_BACKUP_BUCKET=drigodb DRIGODB_BACKUP_ENDPOINT="http://minio.drigodb-databases:9000")
fi

step "Deploying, with the same script DOKS uses"
KUBE_CONTEXT="$CTX" env ${DEPLOY_ENV[@]+"${DEPLOY_ENV[@]}"} bash "${ROOT}/scripts/deploy.sh"

echo
printf "${GREEN}${BOLD}drigodb is running on kind.${RESET}  context: ${BOLD}${CTX}${RESET}\n"
printf "  Prove it:   ${BOLD}KUBE_CONTEXT=%s bash scripts/smoke.sh${RESET}\n" "$CTX"
printf "  Tear down:  bash scripts/kind-down.sh\n"
echo
warn "NetworkPolicy is a silent no-op here — kind's default CNI does not implement it,"
warn "so one of drigodb's three isolation layers is absent. Volumes cannot be expanded"
warn "either. Neither is the chart's doing; see charts/drigodb/README.md."
