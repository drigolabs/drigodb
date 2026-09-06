---
date: 2026-09-06
topic: getting-started
status: current
related:
  - scripts/kind-up.sh
  - scripts/deploy.sh
  - scripts/cnpg-install.sh
  - charts/drigodb/README.md
---

# Getting started

Four ways in. Pick the row that describes you, do
[section 0](#0-install-the-tools), then read only your section.

| | you want | go to |
|---|---|---|
| **A** | to try drigodb on a laptop, with nothing billed | [Local, with kind](#a-local-with-kind) |
| **B** | to work on drigodb itself | [Local, developing drigodb](#b-local-developing-drigodb) |
| **C** | to run drigodb on a real cluster you already have | [A remote cluster](#c-a-remote-cluster) |
| **D** | a cluster too, from nothing, on DigitalOcean | [DigitalOcean from scratch](#d-digitalocean-from-scratch) |

All four end the same way: `scripts/smoke.sh` provisions a real database,
connects to it over TLS, hibernates it, wakes it, and rotates its credentials.
If that passes, drigodb works.

**A takes about fifteen minutes from nothing**, including installing the tools,
and costs nothing. If you are not sure which row you are, you are A.

## 0. Install the tools

Skip to [what drigodb needs from a cluster](#what-drigodb-needs-from-a-cluster)
if you already have these. Otherwise start here — nothing below assumes anything
is installed.

| tool | A: kind | B: developing | C: remote | D: DigitalOcean |
|---|:-:|:-:|:-:|:-:|
| `docker` | ● | ● | | |
| `kind` | ● | ● | | |
| `kubectl` | ● | ● | ● | ● |
| `helm` (3.8+) | ● | ● | ● | ● |
| `git` | ● | ● | ● | ● |
| `node` 22+ | | ● | | |
| `doctl` | | | | ● |

`curl` and `python3` are used by the scripts and are already present on macOS
and on any ordinary Linux install. `jq` is optional — it only makes JSON output
easier to read. **You do not need `psql`**: everything that speaks to a database
does so from a pod inside the cluster, deliberately, so the connection string
being tested is the one the API actually issued.

### macOS

[Homebrew](https://brew.sh) first, if you do not have it:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Then:

```bash
brew install kubernetes-cli helm kind    # kubectl comes from kubernetes-cli
brew install node                        # only for scenario B
brew install doctl                       # only for scenario D
```

Docker Desktop is a `.dmg` rather than a formula — download it from
[docker.com](https://www.docker.com/products/docker-desktop/), or
`brew install --cask docker-desktop`. **Open it once after installing**; the
`docker` command does nothing until the daemon is running, and "Cannot connect
to the Docker daemon" is what that looks like.

`git` and `curl` arrive with the Xcode command line tools, which macOS offers to
install the first time you run `git`. If it does not: `xcode-select --install`.

### Linux (Debian / Ubuntu)

```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
```

**Log out and back in after that**, or every docker command fails with
`permission denied while trying to connect to the Docker daemon socket`. It is
the single most common way this step appears to have failed when it worked.

```bash
# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl && rm kubectl

# helm
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# kind
curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.33.0/kind-linux-amd64
sudo install -o root -g root -m 0755 kind /usr/local/bin/kind && rm kind

# git, curl, python3 — almost certainly already there
sudo apt-get update && sudo apt-get install -y git curl python3

# node 22, only for scenario B
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs

# doctl, only for scenario D. No snapd? Grab the tarball from
# https://github.com/digitalocean/doctl/releases and put the binary on PATH.
sudo snap install doctl
```

On arm64, replace `linux/amd64` with `linux/arm64` and `kind-linux-amd64` with
`kind-linux-arm64`.

### Windows

Use [WSL 2](https://learn.microsoft.com/windows/wsl/install), then follow the
Linux instructions inside it. Install Docker Desktop on Windows and enable its
WSL 2 backend in Settings → Resources → WSL integration, rather than installing
Docker inside WSL — the two fight over the same socket otherwise.

### Give Docker enough memory

A kind cluster runs a Kubernetes control plane, the CloudNativePG operator,
drigodb, and then a PostgreSQL instance per database — all inside one container.
**Docker Desktop → Settings → Resources → at least 4 GB of memory and 2 CPUs.**

Below that, the symptom is not an error message. Pods sit `Pending` with
`0/1 nodes are available: Insufficient memory`, or the kind node is killed
mid-install and `kubectl` starts reporting connection refused.

### Check it worked

```bash
docker info >/dev/null && echo "docker: ok"
kind version
kubectl version --client
helm version --short
```

Four lines of output and no errors means you are ready. If `docker info` prints
`Cannot connect to the Docker daemon`, the daemon is not running — start Docker
Desktop, or `sudo systemctl start docker` on Linux.

## What drigodb needs from a cluster

Three things. drigodb checks the first two itself and **refuses to become ready
without them**, so a cluster missing either cannot produce a green install —
`helm install --wait` fails, and `kubectl get pods` shows `0/1` with the reason
in the logs. The pod stays up and goes Ready on its own once the gap is filled,
with nothing to restart.

**The CloudNativePG operator.** A hosted database is a CNPG `Cluster`
([decision 0004](decisions/0004-cloudnativepg-for-the-data-plane.md)). Without
the operator, drigodb installs cleanly, reports itself healthy, and fails at the
first provision. Every path below installs it; if you install the chart by hand,
this is the step to not skip.

**A default StorageClass**, or `database.storageClass` set to one. Without
either, every database sits `Pending` with no error anywhere — the PVC is simply
never bound. `kubectl get storageclass` should show one marked `(default)`.

**A CNI that implements NetworkPolicy**, if you want drigodb's network isolation
to be real. This is the third thing, and the one drigodb does **not** check —
there is no reliable way to ask a cluster whether its CNI enforces policy short
of sending a packet and seeing whether it arrives. kind's default CNI does not,
and it fails silently: the policies are created and enforce nothing. See [what a
laptop cannot tell you](local-development.md#what-a-laptop-cannot-tell-you).

You can see what drigodb thinks of your cluster at any time:

```bash
kubectl -n drigodb-system port-forward svc/drigodb-api 8080:80 &
curl -s localhost:8080/readyz | jq
```

```json
{"ready": true,
 "checks": [{"name": "cloudnativepg", "status": "ok", "detail": "postgresql.cnpg.io is served by this cluster"},
            {"name": "storageclass",  "status": "ok", "detail": "cluster default is standard"}]}
```

A check can also come back `unverified`, which means drigodb was not permitted
to look rather than that the thing is missing — a cluster that declines the
read-only ClusterRole over StorageClasses still runs drigodb, it just cannot
warn you about that one.

---

## A. Local, with kind

The fastest way to see drigodb work. No cloud account, nothing billed.

**You need:** `docker`, `kind`, `kubectl`, `helm` and `git` — all of
[section 0](#0-install-the-tools). Docker must be *running*, not merely
installed.

```bash
git clone https://github.com/drigolabs/drigodb.git
cd drigodb
bash scripts/kind-up.sh
```

That creates a kind cluster, installs the CloudNativePG operator, generates an
API token, and installs the chart with **the same `scripts/deploy.sh` a remote
cluster uses**. It pulls the published API image — the one a consumer gets —
rather than building anything, so a green run here is evidence about the real
artefact.

Prove it end to end:

```bash
KUBE_CONTEXT=kind-drigodb bash scripts/smoke.sh
```

Add object storage if you want backups and restore to work:

```bash
bash scripts/kind-up.sh --with-backups
```

That adds MinIO and points drigodb at it — the same substitution the backup
image's own integration test makes.

**Tear down:** `bash scripts/kind-down.sh`. Nothing to sweep afterwards; kind's
volumes are directories inside the node container.

## B. Local, developing drigodb

Everything from A, plus `node` 22 or newer. Same cluster, but running your
working tree instead of a published image.

```bash
git clone https://github.com/drigolabs/drigodb.git
cd drigodb
npm install
npm test          # 91 tests, no cluster needed — this should pass before you start
```

Then bring the cluster up on your own build:

```bash
bash scripts/kind-up.sh --local
```

Builds the API from this checkout, loads it straight into the kind node, and
deploys with `pullPolicy: Never` so the kubelet does not go looking for a tag
that exists nowhere but inside this cluster.

For a continuous loop, install [Tilt](https://tilt.dev)
(`brew install tilt-dev/tap/tilt`, or `curl -fsSL https://raw.githubusercontent.com/tilt-dev/tilt/master/scripts/install.sh | bash`)
and run `tilt up`. It rebuilds and reloads on every save.

The two loops want opposite things and both matter:
`--local` is for speed, plain `kind-up.sh` is for proving the deployment path.
[local-development.md](local-development.md) covers the difference, the Tilt
setup, and the four things a laptop cannot tell you.

## C. A remote cluster

Any Kubernetes cluster you can already reach with `kubectl`.

First find out what your cluster is called and that you can actually reach it.
`KUBE_CONTEXT` below is the **context name** from the first column — the entry
marked `*` is the one `kubectl` uses when you do not say:

```bash
kubectl config get-contexts
kubectl get nodes          # should list nodes, not an error
```

If that second command fails, nothing below will work. Get a kubeconfig from
whoever runs the cluster, or from your provider — DigitalOcean is
`doctl kubernetes cluster kubeconfig save <name>`, EKS is
`aws eks update-kubeconfig --name <name>`, GKE is
`gcloud container clusters get-credentials <name>`.

Then pick a route.

### C1. From a clone — one command

```bash
git clone https://github.com/drigolabs/drigodb.git
cd drigodb
KUBE_CONTEXT=my-cluster bash scripts/deploy.sh
```

`deploy.sh` is idempotent and does the whole job: installs CloudNativePG pinned
(leaving alone any operator already there), generates the API token on first run
and prints it once, then `helm upgrade --install`. Re-running it is safe and
does not rotate the token.

Useful overrides:

```bash
DRIGODB_STORAGE_CLASS=do-block-storage \
DRIGODB_BACKUP_BUCKET=my-bucket \
DRIGODB_BACKUP_ENDPOINT=https://fra1.digitaloceanspaces.com \
KUBE_CONTEXT=my-cluster bash scripts/deploy.sh
```

### C2. Helm only — no clone

For installing drigodb as a dependency rather than working on it.

```bash
# 1. The operator. Skipping this is the one mistake that fails silently.
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.27/releases/cnpg-1.27.0.yaml
kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager

# 2. A token. The chart will not invent one — a template that generates a
#    credential rotates it silently under any renderer without a cluster.
kubectl create namespace drigodb-system
kubectl -n drigodb-system create secret generic drigodb-api-token \
  --from-literal=token="$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-40)"

# 3. drigodb.
helm install drigodb oci://ghcr.io/drigolabs/charts/drigodb \
  --namespace drigodb-system \
  --set api.existingSecret=drigodb-api-token
```

**Installing drigodb requires permission to install CRDs**, because of step 1.
That is a higher bar than an ordinary application and it is worth knowing before
you start. The chart does not install the operator itself — CRDs are
cluster-scoped and belong to the cluster rather than to one application, and Helm
installs a subchart's `crds/` once and never upgrades it.

Then read the token and check it works:

```bash
TOKEN=$(kubectl -n drigodb-system get secret drigodb-api-token -o jsonpath='{.data.token}' | base64 -d)
kubectl -n drigodb-system port-forward svc/drigodb-api 8080:80 &
curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/databases
```

## D. DigitalOcean from scratch

Creates the cluster too. **Billing starts when this returns.**

**You need:** `kubectl`, `helm`, `git` and `doctl` from
[section 0](#0-install-the-tools), plus a DigitalOcean account.

Authenticate `doctl` first — it opens a browser and asks you to paste back a
token:

```bash
doctl auth init
doctl account get      # should print your account, not an error
```

```bash
git clone https://github.com/drigolabs/drigodb.git
cd drigodb
bash scripts/doks-up.sh          # ~$12/month for s-1vcpu-2gb in fra1
bash scripts/deploy.sh
bash scripts/smoke.sh
```

`doks-up.sh` writes the kubeconfig and switches your current context to the new
cluster, so `deploy.sh` and `smoke.sh` need no `KUBE_CONTEXT`. Check with
`kubectl config current-context` if you want to be sure what you are about to
deploy to.

A 1500 MiB node fits roughly **two** concurrent databases — memory binds before
CPU. For more, `DRIGODB_DO_NODE_SIZE=s-2vcpu-4gb bash scripts/doks-up.sh`.

**Tear down, and mean it:** `bash scripts/doks-down.sh`. A cluster left running
costs the node price every month whether or not anything uses it.

---

## Your first database

Same on every path. With the API reachable on `localhost:8080` and `$TOKEN` set:

```bash
curl -XPOST localhost:8080/v1/databases \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"external_id":"my-app"}'
```

```json
{"id":"a1b2c3d4e5f6","status":"provisioning",
 "connection_uri":"postgres://appuser:…@db-a1b2c3d4e5f6…:5432/app?sslmode=require"}
```

**Store `connection_uri` now.** It is returned here and on rotation, never from
a `GET`. A URI you did not persist is gone, and the only way back into a live
database is `POST /v1/databases/{id}/credentials`, which issues a new one and
invalidates the old.

Poll `GET /v1/databases/{id}` until `status` is `ready`, then connect — **from a
pod carrying `drigodb.io/allow-database: a1b2c3d4e5f6`**, or the NetworkPolicy
drops your packets with no error. [consuming-drigodb.md](consuming-drigodb.md) is
the full contract, and that label is the step worth leading with because getting
it wrong looks like a hang rather than a denial.

## When it does not work

| symptom | cause |
|---|---|
| the pod is `0/1`, logs mention `cloudnativepg` | the CloudNativePG operator is not installed. `bash scripts/cnpg-install.sh` |
| the pod is `0/1`, logs mention `storageclass` | no default StorageClass. `kubectl get storageclass`, then set `database.storageClass` |
| a database sits `provisioning` forever, PVC `Pending` | a StorageClass exists but cannot bind — often `WaitForFirstConsumer` plus an unschedulable pod. `kubectl -n drigodb-databases describe pvc` |
| your client hangs with no error | the pod is missing `drigodb.io/allow-database: <id>`. A NetworkPolicy denies by dropping packets |
| `401` on every call | the token. `kubectl -n drigodb-system get secret drigodb-api-token -o jsonpath='{.data.token}' \| base64 -d` |
| everything green on kind, isolation not enforced | expected. kind's CNI does not implement NetworkPolicy |
| the pod is `0/1` and never becomes Ready | preflight failed. `kubectl -n drigodb-system logs deploy/drigodb-api \| grep preflight` names which check and why |
| `helm install --wait` times out on `Available: 0/1` | the same thing, seen from the installer. The cluster is missing the operator or a StorageClass |

`bash scripts/smoke.sh` is the fastest way to find out which of these it is —
it checks the operator, the RBAC, and then the whole lifecycle in order.
