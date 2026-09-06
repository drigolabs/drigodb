# drigodb

PostgreSQL databases, provisioned through an API. Each one is a separate
PostgreSQL instance with its own volume, credentials and network policy, and
they hibernate when idle — zero compute, storage only.

## Getting started

Two commands, and the first one is the part people skip:

```bash
# 1. The operator drigodb provisions through.
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.27/releases/cnpg-1.27.0.yaml

# 2. drigodb itself.
helm install drigodb oci://ghcr.io/drigolabs/charts/drigodb \
  --namespace drigodb-system --create-namespace \
  --set api.token="$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-40)"
```

From a clone of this repository, `bash scripts/deploy.sh` does both plus the
token, against whatever `kubectl` context is current, and is the same script the
maintainers use on DigitalOcean.

Then `helm status drigodb` prints how to read the token and provision a database.

**[docs/getting-started.md](../../docs/getting-started.md)** has the complete
step-by-step for each way in — kind, a cluster you already have, and
DigitalOcean from nothing — plus what to check when it does not work.

## Why the chart does not install CloudNativePG

CRDs are cluster-scoped. A cluster already running CloudNativePG for something
else would find drigodb trying to own its CRDs, and Helm installs a subchart's
`crds/` directory once and never upgrades it — so the CRD would freeze at
whatever version got there first. Installing an operator is a cluster decision,
not an application one.

The honest consequence: **installing drigodb needs permission to install CRDs**,
which is a higher bar than installing an ordinary application. Better said here
than discovered at `helm install`.

`scripts/cnpg-install.sh` does step 1 pinned and idempotently, and leaves an
operator somebody else installed completely alone.

**Skipping step 1 cannot produce a green install.** The API checks for the
operator — and for a usable StorageClass — and reports itself **unready** when
either is missing, so `helm install --wait` fails and `kubectl get pods` shows
`0/1` with the reason in the logs. The pod stays up and goes Ready on its own
once the gap is filled, with nothing to restart.

The *chart* still cannot check: `lookup` is banned by
`scripts/chart-determinism-test.sh`, and `.Capabilities.APIVersions` is the same
mistake with a friendlier name, since it answers from the renderer rather than
the cluster. The API can, because it is in the cluster. See `src/k8s/preflight.ts`.

That is why this chart creates one cluster-scoped, read-only ClusterRole over
StorageClasses: they are cluster-scoped resources, so there is no namespaced way
to ask whether a default exists. The namespaced Role is unchanged — drigodb
still cannot read a Secret outside the database namespace — and a cluster that
declines the ClusterRole still runs drigodb, with that one check reported as
`unverified` rather than failed.


## What it installs

| | |
|---|---|
| `drigodb-system` (the release namespace) | the control-plane Deployment, its Service, ServiceAccount and API token |
| `drigodb-databases` | the ConfigMaps every hosted database mounts, and the Role the API acts through |

Hosted databases are **not** part of the chart. They are created at runtime by
API calls, which is why the API needs a Role rather than the chart needing more
templates.

## Values worth knowing about

**`database.storageClass`** — empty means the cluster's default StorageClass,
which is what makes this work on kind, EKS and GKE without being told which. Set
it only if the cluster has no default, or the default is the wrong one.
DigitalOcean is `do-block-storage`; kind is `standard`.

**`database.defaultTier` and `database.maxTier`** — which tier a database is
created on, and how far its owner may grow it.

| tier | volume | `max_wal_size` | ~rows |
|---|---|---|---|
| small | 1Gi | 256MB | ~2 M |
| medium | 5Gi | 1GB | ~11 M |
| large | 20Gi | 2GB | ~50 M |

A volume can be expanded in place and can never be shrunk, so a tier only ever
goes up. `maxTier` is the approval: `POST /v1/databases/{id}/resize` is granted
automatically as long as it stays within it, and nothing grows a database on its
own.

Growing needs a StorageClass with `allowVolumeExpansion: true`. kind's
`local-path` does not have it, so resize is one of the things a laptop cannot
test — the API returns a `409` saying exactly that rather than failing
obscurely.

**`api.existingSecret` or `api.token`** — one is required, and the chart will not
invent a credential.

It used to, using Helm's `lookup` to preserve the value across upgrades. That
made the chart render differently depending on who rendered it: anything without
a cluster — Argo CD, `helm diff`, `helm template` in CI, kustomize's Helm
inflator — took the random fallback instead. Measured under Argo CD, that meant a
new bearer token on every sync, reported as `Synced` and healthy, silently
invalidating every consumer's credential.

So the chart is a pure function of its values, asserted by
`scripts/chart-determinism-test.sh` on every CI run.

`api.existingSecret` is the right answer for anything real — the token belongs in
SOPS, External Secrets or sealed-secrets rather than a values file that lives in
git. It must hold a `token` key. `api.token` is an explicit value for kind and
for trying it out; it ends up in Helm's release metadata.

`scripts/deploy.sh` creates the Secret if it does not exist and leaves it alone
if it does, which is where querying a cluster is legitimate.

**`backup.bucket` / `backup.endpoint`** — off until both are set. With neither,
no backup sidecar is added at all, so a half-configured backup cannot be the
reason a database fails to start. Create the credentials Secret separately:

```bash
kubectl create secret generic drigodb-backup-credentials -n drigodb-databases \
  --from-literal=access_key=... --from-literal=secret_key=...
```

## Server authentication

Off by default. drigodb works without it — `bootstrap.sh` self-signs and
connection URIs say `sslmode=require`, so traffic is encrypted but a client
cannot tell it reached the database it asked for.

```yaml
tls:
  certManager:
    enabled: true
```

**cert-manager is a prerequisite, not a dependency.** Most clusters already run
one, and installing a second for someone who has one is worse than asking. With
it enabled the chart creates a private CA and each database gets a certificate
for its own Service name; connection URIs then say `verify-full`, and consumers
fetch the CA from `GET /v1/ca`.

Point `tls.certManager.issuerRef` at a CA you already run if you have one. A
public issuer cannot help here — the names are in-cluster and unresolvable
outside it, so nothing public could ever sign them.

A renewed certificate reaches a running database on its **next restart**, which
is why the default lifetime is 90 days with 15 days of headroom rather than
something tight.

## Trying it on kind

```bash
kind create cluster
helm install drigodb ./charts/drigodb --namespace drigodb-system --create-namespace
```

Verified: a database provisions in about 20 seconds, binds kind's `standard`
class, runs its migrations, accepts a TLS connection as `appuser`, and survives
hibernate and wake.

**Two things do not work on kind and are not the chart's fault.** kind's default
CNI does not implement NetworkPolicy, so the network isolation layer is a silent
no-op — install Calico if that matters to what you are testing. And `local-path`
volumes cannot be expanded, so storage resize is untestable there.

## Files, not values

`files/postgresql.conf`, `files/pg_hba.conf` and `files/bootstrap.sh` are shipped
as files rather than inlined into `values.yaml`, because each carries the
reasoning for its settings and a values file is the wrong place for a paragraph
explaining why `max_wal_size` is 256MB. `files/migrations/` is applied inside
every database, in filename order, once each.
