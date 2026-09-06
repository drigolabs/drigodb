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

## Contents

- [0. Install the tools](#0-install-the-tools)
  - [macOS](#macos)
  - [Linux (Debian / Ubuntu)](#linux-debian--ubuntu)
  - [Windows](#windows)
  - [Give Docker enough memory](#give-docker-enough-memory)
  - [Check it worked](#check-it-worked)
- [What drigodb needs from a cluster](#what-drigodb-needs-from-a-cluster)
- [A. Local, with kind](#a-local-with-kind)
- [B. Local, developing drigodb](#b-local-developing-drigodb)
- [C. A remote cluster](#c-a-remote-cluster)
  - [C1. From a clone — one command](#c1-from-a-clone--one-command)
  - [C2. Helm only — no clone](#c2-helm-only--no-clone)
- [D. DigitalOcean from scratch](#d-digitalocean-from-scratch)
- [Your first database, end to end](#your-first-database-end-to-end)
  - [1. Provision it](#1-provision-it)
  - [2. Wait for it](#2-wait-for-it)
  - [3. Get a client that is allowed to reach it](#3-get-a-client-that-is-allowed-to-reach-it)
  - [4. Use it](#4-use-it)
  - [5. Check the connection is actually encrypted](#5-check-the-connection-is-actually-encrypted)
  - [6. Prove the label is doing something](#6-prove-the-label-is-doing-something)
  - [7. Clean up](#7-clean-up)
- [Connecting from your own machine](#connecting-from-your-own-machine)
- [When it does not work](#when-it-does-not-work)

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
to be real. This is the third thing, and the one the API does **not** check at
startup — there is no way to ask a cluster whether its CNI enforces policy short
of sending a packet and seeing whether it arrives. So `scripts/smoke.sh` sends
one: it connects from an unlabelled pod and expects to fail. [Step
6](#6-prove-the-label-is-doing-something) below does the same by hand. Recent
kind enforces it; older kind did not, and a cluster that does not will create
every policy and drop nothing.

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

Backups are not available in this release. They were a sidecar in the database's
pod template, and [decision 0004](decisions/0004-cloudnativepg-for-the-data-plane.md)
gave that template to CloudNativePG; adopting the operator's own backups is
[#95](https://github.com/drigolabs/drigodb/issues/95). `GET /v1/databases/{id}`
reports `"backups": "unavailable"` rather than leaving anyone to infer it.
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

## Your first database, end to end

Same on every path. Getting a connection URI is not proof of anything — this
section ends with you reading a row back out of a real database.

With the API reachable on `localhost:8080`:

```bash
TOKEN=$(kubectl -n drigodb-system get secret drigodb-api-token -o jsonpath='{.data.token}' | base64 -d)
kubectl -n drigodb-system port-forward svc/drigodb-api 8080:80 &
```

### 1. Provision it

```bash
RESP=$(curl -s -XPOST localhost:8080/v1/databases \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"external_id":"my-app"}')

DB_ID=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
DB_URI=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["connection_uri"])')

echo "$DB_ID"
```

**`DB_URI` is the only copy of that password.** It is returned here and on
rotation, never from a `GET`, so a leaked read token cannot leak database
credentials. Lose it and the only way back into a live database is
`POST /v1/databases/{id}/credentials`, which issues a new URI and invalidates
this one. In a real application, write it to a Secret or a vault before doing
anything else.

### 2. Wait for it

Provisioning is asynchronous — roughly 10 to 20 seconds.

```bash
until [ "$(curl -s -H "Authorization: Bearer $TOKEN" localhost:8080/v1/databases/$DB_ID \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')" = "ready" ]; do
  printf '.'; sleep 2
done; echo " ready"
```

### 3. Get a client that is allowed to reach it

Each database has a NetworkPolicy admitting only pods labelled
`drigodb.io/allow-database: <its id>`. So the client is a pod, and it carries
that label:

```bash
kubectl -n drigodb-databases run psql-client --restart=Never \
  --image=ghcr.io/cloudnative-pg/postgresql:18 \
  --labels="drigodb.io/allow-database=$DB_ID" \
  --command -- sleep 3600

kubectl -n drigodb-databases wait --for=condition=Ready pod/psql-client --timeout=120s
```

A pod running `sleep`, rather than `kubectl run --rm -it -- psql`, on purpose.
A one-shot pod can finish before `kubectl` finishes attaching to it, and then
the SQL runs, succeeds, and prints **nothing at all** — which looks exactly like
failure. Keeping a client around and `exec`-ing into it has no such race, and
you can go back into it as often as you like.

### 4. Use it

```bash
kubectl -n drigodb-databases exec psql-client -- psql "$DB_URI" \
  -c "create table hello (id serial primary key, said text)" \
  -c "insert into hello (said) values ('it works')" \
  -c "select * from hello"
```

```
CREATE TABLE
INSERT 0 1
 id |   said
----+----------
  1 | it works
(1 row)
```

**That row is the thing you came for.** A real PostgreSQL instance, its own
volume, its own credentials, provisioned by an API call about thirty seconds ago.

For an interactive session, add `-it` and drop the `-c` flags:

```bash
kubectl -n drigodb-databases exec -it psql-client -- psql "$DB_URI"
```

### 5. Check the connection is actually encrypted

The URI says `sslmode=require`. Confirm the server agrees rather than trusting
the string:

```bash
kubectl -n drigodb-databases exec psql-client -- psql "$DB_URI" -tAc \
  "select ssl, version from pg_stat_ssl join pg_stat_activity using (pid) where pid = pg_backend_pid()"
```

```
t|TLSv1.3
```

### 6. Prove the label is doing something

The most valuable thirty seconds in this document, because getting this wrong
in an application produces a hang rather than an error. Toggle the label on the
client you already have:

```bash
kubectl -n drigodb-databases label pod psql-client "drigodb.io/allow-database-"
kubectl -n drigodb-databases exec psql-client -- psql "${DB_URI}&connect_timeout=10" -tAc "select 1"
# psql: error: ... timeout expired

kubectl -n drigodb-databases label pod psql-client "drigodb.io/allow-database=$DB_ID"
kubectl -n drigodb-databases exec psql-client -- psql "$DB_URI" -tAc "select 1"
# 1
```

A NetworkPolicy denies by **dropping packets**, not by refusing the connection.
Your client hangs until it gives up. If an application cannot reach its database
and there is no error to read, this label is the first thing to check.

Two things worth knowing about that policy. It admits a labelled pod from **any
namespace**, so your application does not have to live anywhere in particular.
And it is **per database**: a pod labelled with a different database's id is
blocked, so one tenant's application cannot reach another's by carrying the wrong
label. A database pod cannot reach a neighbouring database either.

If step 6 connects *without* the label, your cluster's CNI is not enforcing
NetworkPolicy — the policies exist and do nothing. That is a property of the
cluster rather than of drigodb, and it is worth knowing before you rely on the
isolation. `scripts/smoke.sh` checks all of this and says so plainly.

### 7. Clean up

```bash
kubectl -n drigodb-databases delete pod psql-client
curl -XDELETE -H "Authorization: Bearer $TOKEN" localhost:8080/v1/databases/$DB_ID
```

`DELETE` removes the volume too. That is the point at which the data actually
goes, and there is no undo.

[consuming-drigodb.md](consuming-drigodb.md) is the full contract for an
application: the label, the statuses, hibernation, and what to do about the URI
you must not lose.

## Connecting from your own machine

Everything above connects from inside the cluster, which is what an application
does. For poking at a database by hand, a client on your own machine works too —
for any database, not just the one above.

A client outside the cluster can reach a database through a port-forward. The
URI is issued for the in-cluster hostname, so the host has to be rewritten and
nothing else:

```bash
kubectl -n drigodb-databases port-forward svc/db-$DB_ID 15432:5432 &

# the URI as issued, with only the host and port changed
LOCAL_URI=$(echo "$DB_URI" | sed "s#@db-$DB_ID\.drigodb-databases\.svc\.cluster\.local:5432#@localhost:15432#")
psql "$LOCAL_URI" -c "select 1"
```

Two things to know before relying on this.

**It bypasses the NetworkPolicy completely.** A port-forward is not pod-to-pod
traffic — it goes through the API server to the kubelet — so no label is
involved and the isolation you tested in step 6 does not apply. Anyone who can
port-forward in that namespace can reach any database, and the password is the
only thing left in the way. That is fine for a human debugging with `kubectl`
and it is not a connection path to build an application on.

**It breaks if server authentication is on.** With cert-manager configured, the
URI is issued with `sslmode=verify-full` and the certificate names the Service
DNS name — which `localhost` is not, so verification fails. Map the real name to
`127.0.0.1` in `/etc/hosts` and forward on `5432` if you need this, or connect
from a pod as above.

Also worth knowing why `scripts/smoke.sh` does **not** do this: rewriting the
host means the string being tested is no longer the string the API handed out.
It used to work this way, and the test could not have caught a bad hostname in
an issued URI.

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
