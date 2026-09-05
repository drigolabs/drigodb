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

**`api.token`** — left empty, one is generated on install and **preserved across
upgrades**. A chart that regenerated it would invalidate every consumer's
credential on every upgrade, so the template reads what is already in the
cluster. Rotate deliberately: delete the Secret and upgrade, or set this.

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
