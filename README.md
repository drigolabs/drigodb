# drigodb

PostgreSQL databases, provisioned through an API.

Each database is a PostgreSQL instance with its own volume, its own credentials and its own network
policy. Databases hibernate when idle — **zero compute, storage only** — and wake in about eight
seconds.

> **v0.0.1, mid-migration.** The data plane is now plain PostgreSQL 18 — no DocumentDB extension, no
> MongoDB gateway, and a `postgres://` connection URI. The reasoning is in
> [docs/leaving-documentdb.md](docs/leaving-documentdb.md).
>
> Still outstanding: the figures under [Measured](#measured) still describe the DocumentDB data plane
> until they are taken again on a cluster (#32).
>
> There is no public endpoint, no accounts and no quotas. Backups exist but are off unless a bucket is
> configured. See [Status](#status).

## Why one instance per database

The obvious design — one shared instance, a database per tenant — does not work *with DocumentDB*, and
the reason is worth keeping because it is what the current topology was built around.

DocumentDB's shipped roles are cluster-wide. `documentdb_readwrite_role` cannot create or read a
collection at all, and `documentdb_admin_role`, the only role that can do useful work, owns every
collection table in the instance. In testing, a credential scoped to one tenant read another tenant's
private document and dropped its collection. There is no role between the two.

The usual fallback — a separate PostgreSQL *database* per tenant — is also closed off: `pg_cron` is a
hard dependency of the extension and binds to one database per cluster, so the extension can only ever
be installed once per instance.

Full write-up, with the commands: [docs/documentdb-multitenancy-spike.md](docs/documentdb-multitenancy-spike.md).

**This constraint is removed, and the topology is now a choice.** Leaving DocumentDB makes a shared
instance possible for the first time — many app databases in one cluster, isolated by ordinary
PostgreSQL roles rather than by a catalog column.

One instance per database stays anyway, deliberately: hibernation already takes idle compute to zero,
so the shared tier's advantage is storage, and it only becomes material somewhere past a few hundred
databases. The comparison and the trigger for revisiting it are in
[docs/decisions/0001](docs/decisions/0001-instance-per-database-over-a-shared-cluster.md).

## Isolation

Three independent layers, so no single misconfiguration exposes one tenant to another:

| Layer | What it is |
|---|---|
| Instance | A separate PostgreSQL process, on a separate volume, with separate credentials |
| Role | A per-database PostgreSQL role, admin *within its own database only* |
| Network | A NetworkPolicy admitting only pods that opt in by label |

The network layer is deliberately trusted least. It fails open if its selector stops matching,
`kubectl port-forward` bypasses it entirely, and a CNI that does not implement NetworkPolicy makes it a
silent no-op. The other two hold without it.

## API

```
POST   /v1/databases            { external_id, restore_from? }  → 202 + connection_uri
GET    /v1/databases            list
GET    /v1/databases/{id}       status and endpoint
POST   /v1/databases/{id}/wake       → 202
POST   /v1/databases/{id}/hibernate  → 202
POST   /v1/databases/{id}/credentials  → 200 + a new connection_uri
GET    /v1/databases/{id}/backups      what can be restored
DELETE /v1/databases/{id}       destroys the data
```

Bearer token on everything except `/healthz`.

**Provisioning is asynchronous** — roughly 12 seconds, so `POST` returns `202` and a status to poll.

**`POST /v1/databases` is idempotent on `external_id`.** A repeat returns the existing database rather
than creating a second one. Callers retry — failed requests, restarted processes, reconcile loops — and
a duplicate would split one application's data across two instances while quietly doubling its cost.

**The connection URI is returned on creation and on rotation only**, never from a plain `GET`, so a
leaked read token does not leak database credentials. Rotation is therefore also the recovery path: a
caller that loses a URI has no other way back into a live database, since reading the credential
Secret directly would mean holding access to *every* database's credentials.

Rotating writes a new password into the database's Secret and restarts it, because the control plane
deliberately cannot reach PostgreSQL — `pg_hba` admits TCP from localhost only. `config/bootstrap.sh`
applies the change on start, and pays the start/stop cycle that needs *only* when the credential has
actually changed, so an ordinary wake is unaffected.

Kubernetes is the source of truth. There is no control-plane database: a hosted database *is* its
StatefulSet, and the caller's identifier lives on it as a label.

## Running it

```bash
bash scripts/publish-images.sh   # multi-arch to GHCR (needs gh auth refresh -s write:packages)
bash scripts/doks-up.sh          # DigitalOcean cluster — starts billing
bash scripts/deploy.sh           # control plane; prints the API token once
bash scripts/doks-down.sh        # stop billing
```

CI does the publishing and deploying on every merge — see [Continuous delivery](#continuous-delivery).
The one step it cannot do is `doks-up.sh`, because creating the cluster starts billing.

Then:

```bash
kubectl -n drigodb-system port-forward svc/drigodb-api 8080:80

curl -XPOST localhost:8080/v1/databases \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"external_id":"my-app"}'
```

Connect the returned `connection_uri` with `psql`, `pg`, or any PostgreSQL client. The URI names the
`app` database and carries `sslmode=require` — the server presents a self-signed certificate generated
at first start, so a client can encrypt but cannot verify it. A real issuer is
[#9](https://github.com/drigolabs/drigodb/issues/9).

## Continuous delivery

Merging to `main` is the whole release process. The flow end to end, and which credential each step
holds, is in [docs/diagrams/deploy-flow.md](docs/diagrams/deploy-flow.md) — which describes the
target in [decision 0002](docs/decisions/0002-gitops-for-the-control-plane.md), not what runs today.
What runs today is the push path below. `.github/workflows/release.yml` reads the
Conventional Commit subjects since the last tag, and if they earned a version it builds the API image
for both architectures, publishes it under an immutable tag, tags the merged commit, cuts a GitHub
release, and rolls it out to DOKS — then reads `/healthz` back to confirm the cluster is serving the
build the run just made.

Nothing in the pipeline writes to `main`. It creates a tag, and a tag is not a branch, so `main` stays
protected against everyone. That tag is the record of what shipped: `scripts/next-version.sh` computes
the next version from it.

**A release does not deploy itself.** `deploy/20-api.yaml` is what is deployed, read as written — the
commit being released cannot name the image the release is about to build. So publishing and shipping
are two merges: CI publishes, then rewrites a standing issue carrying the one-line diff that moves the
pin, and merging that is what ships it. The alternative is a pipeline pushing to `main`, and a `main`
no one can push to is worth more than the bookkeeping.

This used to resolve the newest tag at apply time instead, which made the manifest a decoy: two
clusters applying the same commit a week apart ran different images. The pin had sat stale at `0.0.1`
for seven releases without anyone noticing, because nothing read it.

A merge of only `docs:` or `chore:` commits releases nothing. That is the intended amount of ceremony
for a README fix.

| commits since the last tag | 0.x today | once past 1.0.0 |
|---|---|---|
| `feat:`, `feat!:`, `BREAKING CHANGE:` | minor — `0.1.0` | minor, or major for a breaking one |
| `fix:`, `perf:`, `revert:` | patch — `0.0.2` | patch |
| anything else | no release | no release |

Below 1.0.0 the minor position is the one allowed to break, so a `!` bumps the minor rather than
declaring a 1.0.0 nobody decided on. Reaching 1.0.0 is a deliberate `git tag`. Preview any of this
before pushing:

```bash
scripts/next-version.sh --why
```

**The cluster being gone is not a failure.** DOKS bills whether or not anyone is connected, so it gets
torn down between sessions. A merge with no cluster running publishes the image, says so, and stops —
`scripts/doks-up.sh && scripts/deploy.sh` picks it up later.

The pipeline decides that by **asking whether the cluster answers**, using the credential it is about
to deploy with. It used to ask DigitalOcean whether the cluster existed, which a read-scoped token
could do — so the check passed while the very next call failed `403`, and seven releases reported a
successful deploy without ever deploying. A check that does not exercise the credential it is checking
is not a check. See [#15](https://github.com/drigolabs/drigodb/issues/15).

### The data-plane image

`drigodb-backup` carries the PostgreSQL major it is built against, not this repo's version, so it is
not part of a semver release. `.github/workflows/images.yml` builds it when `images/postgres-backup/`,
`config/` or `images/versions.env` changes, and on demand.

**There is no weekly rebuild any more.** It existed because the postgres image was built on Ubuntu
rather than CNPG's own, and that trade bought drigodb the job of patching its own base. Databases now
run `ghcr.io/cloudnative-pg/postgresql:18` directly; CNPG rebuild it and drigodb inherits that.

Nothing is published until it has been proved to run. For the backup image that means
`images/postgres-backup/integration-test.sh`: write rows to a real PostgreSQL, back them up to MinIO
standing in for Spaces, restore into a *second, running* instance, and read the rows and the expression
index back. A rebuild that merely *builds* would sail past the failure that matters, which is a runtime
one — and the DocumentDB era proved that exactly: a dump that exits zero and restores nothing.

### Setting it up

The pipeline needs two things arranged once, and neither is a token you create by hand:

1. **Nothing, for the deploy credential.** `scripts/doks-up.sh` mints it and pushes it to the
   repository itself, because that script already runs as an administrator — creating a cluster
   requires one — and that is the right place for the privileged step.

   It creates a `drigodb-deployer` ServiceAccount scoped to what deploying actually does, and sets
   `DRIGODB_DEPLOY_TOKEN`, `DRIGODB_CLUSTER_SERVER` and `DRIGODB_CLUSTER_CA`. CI never calls the
   DigitalOcean API. The credential dies with the cluster, which is the point: one that outlives what
   it grants access to is one nobody remembers to revoke.

   This replaces a `DIGITALOCEAN_ACCESS_TOKEN` that the pipeline used to exchange for a kubeconfig at
   deploy time. That kubeconfig authenticates as the **account owner** and is cluster-admin — verified,
   it can delete nodes and read every Secret in the cluster — because DigitalOcean has no lesser
   kubeconfig to issue. A leaked repository secret reached the whole account rather than one
   deployment. **If `DIGITALOCEAN_ACCESS_TOKEN` is still set on the repository, delete it**; nothing
   reads it any more.

   Without the secrets the pipeline still builds and publishes; it just reports the deploy as skipped.

2. **Write access from this repo to the GHCR packages.** The three packages were first pushed by hand
   with a personal token, so they are not yet linked to the repository. On each package's page →
   *Package settings* → *Manage Actions access* → add `drigolabs/drigodb` with **Write**, or the
   workflow's token cannot push.
3. **Nothing else.** `main` is protected and no one — the pipeline included — pushes to it. The
   release writes a tag, and a tag is not a branch, so protection and automated releases do not
   trade off against each other.

The repository's default token is read-only, which is correct and needs no change — each job asks for
exactly the access it needs. Nothing asks for `pull-requests: write`, so *Allow GitHub Actions to
create and approve pull requests* stays off.

`scripts/publish-images.sh` and `scripts/deploy.sh` still work by hand — for publishing off a branch,
bisecting a build, or bootstrapping a registry. They are the escape hatch, not the route.

## Backups

Off by default. Set a bucket and an endpoint and every database gains a sidecar that streams a
logical backup to S3-compatible storage on an interval.

```bash
kubectl create secret generic drigodb-backup-credentials -n drigodb-databases \
  --from-literal=access_key=... --from-literal=secret_key=...

# then, on the control plane
DRIGODB_BACKUP_BUCKET=my-bucket
DRIGODB_BACKUP_ENDPOINT=https://fra1.digitaloceanspaces.com
```

Existing databases pick the sidecar up on their next wake, through the same template reconcile that
carries image updates. With no bucket configured no sidecar is added at all — a database is exactly
what it was before, rather than one carrying a container that cannot do its job.

**Logical, now that it can be.** A backup is `pg_dump` of the app database, gzipped and streamed
straight to object storage. It was `pg_basebackup` under DocumentDB and not by preference — `pg_dump`
never dumps the data of tables belonging to an extension, `documentdb` marked none of its catalog, and
a restore completed with no error leaving every collection invisible. With the extension gone an empty
database dumps to under a kilobyte instead of ~73 MB, and it restores across PostgreSQL major versions.
[Full write-up](images/postgres-backup/README.md).

**A broken bucket cannot take a database offline.** The sidecar carries no probes and absorbs its own
failures. A readiness probe would put backups on the pod's Ready condition, and a NotReady pod leaves
its Service — so an unreachable bucket would sever a database that is working perfectly well.

**A hibernated database is not backed up, and does not need to be.** No pod means no writes, so
nothing can have changed since the last backup. The sidecar only exists while the database is awake,
which is the only time it can have anything new to say.

**`GET /v1/databases/{id}/backups` lists what can be restored** — keys, sizes and timestamps, newest
first, never a credential. It answers for a **hibernated** database, which is the point: that is when
the question gets asked, and it is exactly when there is no pod to ask. The control plane lists the
bucket itself for that reason; the alternative, `kubectl exec` into the database pod, needs `pods/exec`
RBAC, and a control plane that can exec into any pod can read every tenant's data.

An empty list means a database that has never been backed up. A `409` means backups are off for the
installation, which is a different fact and one a caller must not confuse with the first.

**Restoring is provisioning with a source.**

```bash
curl -XPOST localhost:8080/v1/databases -H "Authorization: Bearer $TOKEN" \
  -d '{"external_id":"my-app-recovered",
       "restore_from":{"database_id":"a1b2c3d4e5f6","key":"20260905T040000Z.sql.gz"}}'
```

A new database, with its own id, volume and credentials. **The one it was restored from is untouched**,
which is what makes this the safe shape — an undo that cannot destroy the thing being undone. To
replace a database with an older version of itself, restore into a new one, repoint, and delete the old.

The load runs as a Kubernetes Job that is an *ordinary consumer* of the new database: it connects over
TCP with the app's own credentials and carries the same `drigodb.io/allow-database` label any consumer
opts in with. It holds nothing the isolation model does not already hand out, and no service account
token at all.

**The database reports `restoring` until the data has landed**, and that status is doing real work: a
restored database answers on its port before its dump has been loaded, and a caller that connected then
would find it empty — and any write it made would leave the restore to find a non-empty target and skip
it. Poll until `ready`.

Restoring in place, over an existing database, is not built. It is the one someone recovering from
corruption wants and it is genuinely destructive, so it waits for someone to have needed it —
[#22](https://github.com/drigolabs/drigodb/issues/22).

## Schema inside a database

A provisioned database carries a `_drigodb` schema, applied from
[`config/migrations/`](config/migrations/) in filename order, exactly once each and recorded in
`_drigodb.schema_migrations`. `SELECT _drigodb.version()` says where a database is up to.

`config/bootstrap.sh` runs them, over the local socket, as `postgres`. **The control plane never
connects to a database** — it holds every credential but has no route to use one, and giving it a way in
would mean a `pg_hba` rule, a NetworkPolicy hole and a DDL-capable credential per database. Shipping
schema through the pod instead means a new migration reaches an existing database on its next wake,
through the same template reconcile that carries an image update.

An ordinary wake still costs nothing: a marker in `PGDATA` records which set of files the cluster has
seen, so the server is only started early when there is actually work — the same trick the credential
fingerprint uses, and they share one start/stop cycle when both are due.

**Migrations are forward-only.** The runner records a checksum per file, and an edited migration that
has already been applied stops the server from starting rather than letting a schema drift from the file
claiming to describe it. That failure is fleet-wide by design, so it has to be caught before it ships —
`config/migrations-test.sh` runs the real `bootstrap.sh` against the real image on every CI run and
asserts exactly that.

What is deliberately *not* in there: no patch log, no manifest tables, no `apply_patch`. Those belong to
the document-framework proposal in [docs/plans/](docs/plans/), which is a separate bet. This is the
mechanism that would deliver them, and is worth having either way — without it nothing can change a
provisioned database after it is created.

## Measured

Taken on DigitalOcean 2026-09-05, against the plain-PostgreSQL data plane, with
[`scripts/measure.sh`](scripts/measure.sh) — a script rather than a list of commands because every
figure here was previously a single observation, and a table that has already been wrong once by 3.5×
should be cheap to take again.

Cluster: 1× `s-1vcpu-2gb` in `fra1`, which is what `doks-up.sh` creates.

| | warm cache, single node | DigitalOcean, `s-1vcpu-2gb` |
|---|---|---|
| Provision from nothing | ~12s | **19–20s** warm (n=2), **45s** on a node that has never pulled the image |
| Wake from hibernation | ~8s | **9–11s** (n=2) |
| Hibernated | 0 pods; storage only | same |

Storage, freshly provisioned:

| | |
|---|---|
| A freshly provisioned database | **64 MB** |
| — catalogs | 31 MB (one extension, `plpgsql`) |
| — write-ahead log | 33 MB |
| One ~200-byte row | **308 bytes** at 20k, **318** at 100k |
| Default volume | 1Gi, so roughly **3 million rows** once WAL is bounded |

Leaving DocumentDB took 73 MB to 64 MB. The saving is the catalog term alone — PostGIS and the
extension's own catalogs — because the 33 MB write-ahead log floor is set by `min_wal_size` and does not
care which extension is installed. The migration plan predicted ~40 MB; that was too optimistic, and
this is the corrected figure.

Active memory, three samples, all identical:

| | |
|---|---|
| Resident set size, summed over the container's processes | **102 MiB** |
| Proportional set size, the same pages divided by their sharers | **30 MiB** |
| cgroup `memory.current` | 153 MiB |

Those are three different quantities and the difference is the point. `memory.current` includes page
cache, which is why the earlier attempt at this table refused to substitute it. Summed RSS
double-counts PostgreSQL's shared buffers across its processes. PSS divides shared pages by the number
of processes mapping them, and is the only one of the three that answers "what does this instance
actually cost". The container's true footprint is between the two: 102 MiB is what it holds resident,
30 MiB is what is not shared with itself.

The volume is deliberately at the small end. A PVC can be expanded in place and can never be
shrunk, and a StatefulSet's `volumeClaimTemplates` is immutable — so the default is permanent for
every database created under it. Too small is a patch; too large is forever.

`config/postgresql.conf` caps `max_wal_size` at 256MB for the same reason. Left at the PostgreSQL
default of 1GB, the write-ahead log alone can claim more than a 1Gi volume before a single row is
stored.

**Volume expansion is online.** Patching a PVC from 1Gi to 2Gi grew the filesystem from 974M to 2.0G
with the database still running, no restart, and no `FileSystemResizePending` condition — so a resize
is invisible to a tenant rather than costing them a pod cycle. That settles the open question in
[docs/storage-tiers.md](docs/storage-tiers.md) and removes a required step from
[#10](https://github.com/drigolabs/drigodb/issues/10).

### How many databases fit on a node

Two, on this one — and the limit is not what was expected.

| | |
|---|---|
| Node allocatable | 1500 MiB memory, 920m CPU |
| Requested with 2 databases + the control plane | 1222 MiB (83%), 762m CPU (82%) |
| A third database | **would not schedule** — `Insufficient memory` |
| Block volumes attachable per node (`dobs.csi.digitalocean.com`) | **15** |

The volume ceiling is real but far away; memory requests bind first, by a wide margin. And the request
is what binds, not the usage: a database *requests* 256Mi and *holds* 102 MiB, so the scheduler
reserves roughly 2.5× what an idle database uses.

**A hibernated database is not a reservation.** Waking one on a full node can fail: its memory was
returned when it hibernated, and databases provisioned since may hold it. That happened during this
measurement run and is why the wake figure is n=2 rather than n=3.

Compute therefore tracks *concurrent* databases, not total ones. Storage tracks total, at the
provisioned volume size each — that is the term that grows with signups.

## Status

**In migration.** The DocumentDB data plane is being replaced by plain PostgreSQL — decision and
reasoning in [docs/leaving-documentdb.md](docs/leaving-documentdb.md), design in
[docs/plans/](docs/plans/2026-09-03-postgres-document-store-migration-plan.md), tracked from #24.
Decisions taken along the way are logged in [docs/decisions/](docs/decisions/).

Built: per-database topology, isolation, the control-plane API, DigitalOcean deployment, and logical
backups behind a configured bucket.

Not built: public endpoints (databases are in-cluster only), TLS from a real issuer — the server
self-signs, so clients pass `sslmode=require` rather than `verify-full` — accounts, quotas, billing,
restore as an API operation, backup retention, and vertical or storage autoscaling.

## Licence

MIT.
