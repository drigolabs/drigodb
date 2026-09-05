# drigodb

PostgreSQL databases, provisioned through an API. Each one is a separate
PostgreSQL instance with its own volume, credentials and network policy, and
they hibernate when idle — zero compute, storage only.

```bash
helm install drigodb oci://ghcr.io/drigolabs/charts/drigodb \
  --namespace drigodb-system --create-namespace
```

Then read the token the chart generated, port-forward, and provision a database
— `helm status drigodb` prints the exact commands.

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

**`database.storageSize`** — 1Gi, deliberately small. A PVC can be expanded in
place and can never be shrunk, and a StatefulSet's `volumeClaimTemplates` is
immutable, so this is permanent for every database created under it. Too small
is a patch; too large is forever.

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
