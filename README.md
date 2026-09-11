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

**All three protect data. None protects the control plane, and that is a real gap.** There is one API
token per installation and every holder of it can enumerate, rotate and destroy *every* database, not
only their own. drigodb is carefully multi-tenant at the data plane and single-tenant at the control
plane.

That is fine while the operator and the consumer are the same party. It is not fine for two consumers
sharing an installation, so do not do that yet. The missing fourth layer is
[#72](https://github.com/drigolabs/drigodb/issues/72) — a database belonging to the token that created
it — on top of [#62](https://github.com/drigolabs/drigodb/issues/62).

## API

```
POST   /v1/databases            { external_id, restore_from?, high_availability? }  → 202 + connection_uri
                                restore_from: { database_id, backup_id? | target_time? }
                                                             → 200 if it already existed (no uri)
GET    /v1/databases            list
GET    /v1/databases/{id}       status and endpoint
POST   /v1/databases/{id}/wake       → 202
POST   /v1/databases/{id}/hibernate  → 202
POST   /v1/databases/{id}/credentials  → 200 + a new connection_uri
POST   /v1/databases/{id}/resize      { tier }  → 202
GET    /v1/databases/{id}/backups      what can be restored
GET    /v1/ca                         the CA consumers verify against
DELETE /v1/databases/{id}       destroys the data
```

Bearer token on everything except `/healthz`.

Requires the [CloudNativePG](https://cloudnative-pg.io) operator on the cluster —
a hosted database is a CNPG `Cluster`, per
[decision 0004](docs/decisions/0004-cloudnativepg-for-the-data-plane.md).
`scripts/deploy.sh` installs it; `scripts/cnpg-install.sh` does it on its own,
pinned, and leaves one somebody else installed alone.

drigodb will not report itself ready on a cluster missing the operator or a
usable StorageClass — both fail silently otherwise, and a green install that
cannot provision is worse than one that refuses to start. `GET /readyz` says
which. `GET /healthz` stays liveness only.

**New here? [docs/getting-started.md](docs/getting-started.md)** — kind on a
laptop, a cluster you already have, or DigitalOcean from nothing, step by step.

Creating is idempotent on `external_id`, including when two callers do it at the same moment: the id
is derived from the `external_id`, so the StatefulSet's own name is the lock and Kubernetes decides
the winner. Only the caller that created it gets the `connection_uri`. The one case that is refused
rather than served is a `409` on a create arriving while a database of the same `external_id` is
still being deleted — its volume has not gone yet, and a retry a few seconds later is clean.

**Building an application against drigodb?** [docs/consuming-drigodb.md](docs/consuming-drigodb.md)
documents the pod-side contract — the half that is not HTTP. It leads with the
`drigodb.io/allow-database` label, because forgetting it produces a connection that hangs with no
error anywhere rather than a refusal you can read.

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

drigodb installs with Helm, on any cluster — including one on your laptop:

```bash
bash scripts/kind-up.sh                              # kind cluster + drigodb, free
KUBE_CONTEXT=kind-drigodb bash scripts/smoke.sh      # provision, connect, hibernate, rotate
```

`smoke.sh` is the same script that runs against DigitalOcean, so "it works locally" and "it works
remotely" are one claim rather than two similar ones. See
[docs/local-development.md](docs/local-development.md) for the inner loop, backups against MinIO, and
the four things a laptop cannot tell you — and [charts/drigodb/README.md](charts/drigodb/README.md)
for the chart's values.

On DigitalOcean:

```bash
bash scripts/doks-up.sh          # DigitalOcean cluster — starts billing
bash scripts/deploy.sh           # helm upgrade --install, against the current context
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

**A release does not deploy itself.** The chart's `appVersion` is what is deployed, read as written — the
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

### There is no data-plane image

drigodb built and published one — `drigodb-backup`, a sidecar — and it went with
the pod template it lived in ([decision 0004](docs/decisions/0004-cloudnativepg-for-the-data-plane.md)).
Databases run `ghcr.io/cloudnative-pg/postgresql:18` directly, which CloudNativePG
rebuilds and drigodb inherits, so there is nothing here to publish and no weekly
rebuild to run. The API image is the only image this repository makes.

Backups return with [#95](https://github.com/drigolabs/drigodb/issues/95), on the
operator's own machinery rather than an image of drigodb's.

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

`scripts/deploy.sh` still works by hand — for standing a cluster up outside the
reconciler, or bootstrapping one. It is the escape hatch, not the route.

## Backups

Off by default. Set a bucket and an endpoint and every database archives WAL
continuously and can be backed up on demand.

```bash
kubectl create secret generic drigodb-backup-credentials -n drigodb-databases \
  --from-literal=access_key=... --from-literal=secret_key=...

# then, on the control plane
DRIGODB_BACKUP_BUCKET=my-bucket
DRIGODB_BACKUP_ENDPOINT=https://fra1.digitaloceanspaces.com
```

```
POST /v1/databases/{id}/backups   → 202, take one now
GET  /v1/databases/{id}/backups   → what can be restored

POST /v1/databases  { external_id, restore_from: { database_id, backup_id? } }
POST /v1/databases  { external_id, restore_from: { database_id, target_time } }
```

**A restored database is a new database** — its own id, its own volume, its own
credentials — and the one it came from is untouched. That is what makes it a
safe undo: the thing being undone cannot be damaged by undoing it. Omit
`backup_id` for the latest backup.

**`target_time` recovers to an instant, not to a backup.** WAL is archived for
every database, so the recoverable moments are not only the ones a backup landed
on: the difference between restoring yesterday's database and restoring it to
the second before the statement that emptied a table. RFC3339, and it must carry
an offset — `2026-09-09T09:30:00Z` — because a timestamp without one resolves
against whichever timezone the control plane happens to run in. Either spelling
of UTC is accepted; drigodb converts what it sends onward, for a reason recorded
in `validateRestoreFrom`.

`backup_id` and `target_time` are alternatives; sending both is a 400 rather
than a precedence rule. A `target_time` before the earliest backup finished is
also a 400, at the moment of the request, rather than a database that fails to
bootstrap several minutes later. The window is bounded by the `ObjectStore`
retention policy, 30 days by default.

A backup belongs to the database it was taken from, and drigodb refuses a
`restore_from` that names someone else's — otherwise any backup in the
installation could be read by guessing its id.

### High availability

```
POST /v1/databases  { external_id, high_availability: true }
```

Opt-in, per database, at create only. A database gets a standby, and a primary
failure promotes it **without the stored URI changing** — the endpoint drigodb
issues selects the primary by label, so a failover moves it rather than issuing
a new address.

**A failover is not transparent to the client.** While it happens the endpoint
selects no pod, so in-flight connections are dropped and new ones are refused
until the standby is promoted — measured at 14 seconds on kind. **A client that
does not reconnect sees an error.** Anything with a connection pool and retries
rides through it; anything that treats one failed connection as fatal does not.
What is guaranteed is the address and the data, not the socket.

**Nothing needs to be done afterwards — as long as WAL archiving works.** A
failed instance is recreated by CloudNativePG, not by the caller: `instances: 2`
is desired state and the operator converges on it. The old primary restarts,
notices it is no longer the primary and rejoins as the standby. Measured on
DigitalOcean: 9 seconds to serve again on the same URI, and **21 seconds to be
protected again**, with the original pod rejoining rather than being rebuilt.
The promoted standby stays primary; there is no failback, and no reason to want
one.

**The condition on that sentence is real, and the API reports it.** A demoted
primary holds WAL it wrote before demotion and must archive it before it can
rejoin. If archiving is failing — a wrong key, a deleted bucket, a changed
policy — it never rejoins, and the database sits on one instance reporting
`ready` indefinitely. That is why a missing standby has two values rather than
one:

```
standby: "unavailable"    it is being rebuilt; wait
standby: "blocked"        it cannot come back without you
archiving: "failing"      why
```

`unavailable` is information. **`blocked` is a task**, and the thing to fix is
the object storage, not the database.

`GET /v1/databases/{id}` reports two things, because they answer different
questions:

```
high_availability: true       what was asked for; never changes
standby: "ready"              what is true this second
archiving: "healthy"          whether WAL is reaching the bucket
```

`archiving` is reported for any database when the installation has somewhere to
back up to, not only a highly available one. It is separate from `backups`,
which says a destination is *configured* — an installation can be configured and
failing every write, and nothing used to say so.

A database with `standby: "unavailable"` is serving and unprotected, which is
the state worth being able to see. A hibernated database reports no `standby` at
all rather than an unhealthy one.

**Commits wait for the standby**, so a failover cannot promote a replica missing
writes the application was told had committed — silent data loss is worse than
the downtime this is bought to avoid. The guarantee relaxes to asynchronous when
no healthy standby exists, rather than blocking writes: `required` durability
would mean a database stops accepting writes the moment its only standby is
drained or rolled, which would make turning this on *reduce* availability. The
cost of that choice, stated plainly: if the standby is already gone and then the
primary dies, writes accepted in that window can be lost.

**Waiting means flushed, not applied.** A commit returns once the standby has
written that WAL to its own disk; the standby has not necessarily replayed it
into its data files yet. That is what makes the failover guarantee hold — a
promoted standby replays what it holds, so no acknowledged write is lost — while
leaving the two servers not byte-identical at any given instant. Nothing reads
the standby today, because the endpoint drigodb issues selects the primary, so
this is invisible until read replicas exist. When they do, a read served by a
standby can miss a row its own primary has already acknowledged, and closing
that gap means `synchronous_commit = remote_apply` and paying a replay round
trip on every commit.

[docs/diagrams/high-availability.md](docs/diagrams/high-availability.md) draws
all of this step by step: creating one, what a commit actually waits for, what
happens when the primary dies, and what happens when the standby is the one that
dies.

**It cannot be turned on later.** A repeat `POST` returns the existing database
and does not act on the flag; adding a standby to a live database is a different
operation and is not built. Read the field rather than assume the request took.

**It costs what it sounds like.** A standby doubles a database's pods and
volumes. ADR 0001 measured a 1500 MiB node fitting three databases, and
DigitalOcean caps a node at 15 attached volumes — turning this on roughly halves
how many databases a node holds, which is why it is not the default.

**drigodb never touches object storage.** It names a Secret, and CloudNativePG's
barman-cloud plugin does the reading, the archiving and the writing. The control
plane holds no bucket credential and has no S3 client — which is a smaller blast
radius than the sidecar era managed with 250 lines of its own request signing.

A backup is a Kubernetes object, so `GET` answers for a **hibernated** database
too. That is exactly when someone asks what they can restore, and exactly when
there is no pod to ask; the previous implementation listed the bucket and could
not answer it at all.

**Requires the barman-cloud plugin, which requires cert-manager.**
`scripts/cnpg-install.sh` installs both, pinned. Turning backups on therefore
costs an installation two cluster-scoped components it may not have wanted —
stated here rather than discovered.

The plugin, not `spec.backup.barmanObjectStore`. That works on the pinned
CloudNativePG 1.27 and is **removed in 1.28**, a deprecation nothing in the CRD
schema mentions and only the admission webhook prints, on apply.

## Nothing inside a database

drigodb creates the database, the role and the volume, and then it stops. There
is no drigodb schema in a hosted database, no table it owns, nothing it reads
back out. `public` is yours and so is everything else.

That was not always true. A `_drigodb` schema used to be applied from a set of
migration files, tracked in a ledger, with a runner enforcing checksums — and
the only migration that ever existed created the ledger and a function reporting
what was in the ledger. Nothing in the control plane read either. See
[decision 0006](docs/decisions/0006-nothing-inside-a-hosted-database.md).

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
[docs/storage-tiers.md](docs/storage-tiers.md), and it is why a resize costs a tenant nothing for the
volume itself.

**Growing a database is expansion in place, not a migration.** `POST /v1/databases/{id}/resize` takes a
tier — `small` 1Gi, `medium` 5Gi, `large` 20Gi — grows the volume, raises `max_wal_size` to match, and
cycles the pod once. Volumes never shrink, so a tier only goes up, and `DRIGODB_MAX_TIER` is the ceiling
an owner is granted automatically within.

The volume grows **before** the WAL ceiling rises, and that order is load-bearing rather than tidy:
raising `max_wal_size` on a volume that has not grown is how PostgreSQL fills its disk, and a full disk
is a PANIC rather than a slowdown. There is no transaction across the two, so the order is also what
makes a partial failure survivable — it leaves a larger volume running the old ceiling, which is merely
wasteful.

Growing needs a StorageClass with `allowVolumeExpansion: true`. Without one the API returns a `409`
saying so, which is what a laptop gets: kind's `local-path` cannot expand.

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

Not built: public endpoints (databases are in-cluster only), accounts, quotas, billing,
restore as an API operation, backup retention, and vertical or storage autoscaling.

## Licence

MIT.
