# drigodb

PostgreSQL databases, provisioned through an API.

Each database is a PostgreSQL instance with its own volume, its own credentials and its own network
policy. Databases hibernate when idle — **zero compute, storage only** — and wake in about eight
seconds.

> **v0.0.1, mid-migration.** The data plane is now plain PostgreSQL 18 — no DocumentDB extension, no
> MongoDB gateway, and a `postgres://` connection URI. The reasoning is in
> [docs/leaving-documentdb.md](docs/leaving-documentdb.md).
>
> Still outstanding: nothing installs schema into a provisioned database yet (#30), and the figures
> under [Measured](#measured) still describe the DocumentDB data plane until they are taken again on a
> cluster (#32).
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
POST   /v1/databases            { external_id }   → 202 + connection_uri
GET    /v1/databases            list
GET    /v1/databases/{id}       status and endpoint
POST   /v1/databases/{id}/wake       → 202
POST   /v1/databases/{id}/hibernate  → 202
POST   /v1/databases/{id}/credentials  → 200 + a new connection_uri
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

Merging to `main` is the whole release process. `.github/workflows/release.yml` reads the
Conventional Commit subjects since the last tag, and if they earned a version it builds the API image
for both architectures, publishes it under an immutable tag, tags the merged commit, cuts a GitHub
release, and rolls it out to DOKS — then reads `/healthz` back to confirm the cluster is serving the
build the run just made.

Nothing in the pipeline writes to `main`. It creates a tag, and a tag is not a branch, so `main` stays
protected against everyone. That tag is the record of what shipped: `scripts/next-version.sh` computes
the next version from it, and `scripts/deploy.sh` deploys the newest one by default, so a hand-run
deploy tracks the latest release without anyone editing a manifest.

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

The pipeline needs three things arranged once:

1. **`DIGITALOCEAN_ACCESS_TOKEN`** as a repository secret. `kubernetes: read` is the whole scope it
   needs — the pipeline fetches a kubeconfig and nothing more, because creating the cluster starts
   billing and stays a deliberate `doks-up.sh`. Without the secret the pipeline still builds and
   publishes; it just reports the deploy as skipped. Set the repository variable
   `DRIGODB_DO_CLUSTER` too if the cluster is not named `drigodb`.
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

**Restore is not wired to the API yet.** The image can do it by hand — `drigodb-backup restore KEY`
loads a dump into the app database, and refuses a database that already holds tables unless
`DRIGODB_RESTORE_FORCE=1` says otherwise. Making that an operation is
[#22](https://github.com/drigolabs/drigodb/issues/22), which gets substantially simpler now that a
restore loads into a running server rather than replacing a data directory.

## Measured

| | warm cache, single node | DigitalOcean, `s-2vcpu-4gb` |
|---|---|---|
| Provision from nothing | ~12s (includes `initdb` and `CREATE EXTENSION`) | **27s** warm, **50s** on a node that has never pulled the images |
| Wake from hibernation | ~8s | **18s** |
| Hibernated | 0 pods; storage only | same |

**These figures predate the migration and describe the DocumentDB data plane.** They are kept until
they can be taken again on a cluster ([#32](https://github.com/drigolabs/drigodb/issues/32)). An early
Docker measurement of the replacement puts a fresh database at ~64 MB rather than 73 MB — the saving is
the catalog term only, since the ~33 MB WAL floor is set by `min_wal_size` and does not care which
extension is installed.

Storage, measured on DigitalOcean 2026-09-01:

| | |
|---|---|
| A freshly provisioned database | **73 MB** |
| — catalogs and extensions | 41 MB, of which PostGIS is 7.1 MB |
| — write-ahead log | 33 MB |
| One ~220-byte document | **365 bytes** — consistent at 20k and 100k |
| Default volume | 1Gi, so roughly **2 million documents** once WAL is bounded |

The volume is deliberately at the small end. A PVC can be expanded in place and can never be
shrunk, and a StatefulSet's `volumeClaimTemplates` is immutable — so the default is permanent for
every database created under it. Too small is a patch; too large is forever.

`config/postgresql.conf` caps `max_wal_size` at 256MB for the same reason. Left at the PostgreSQL
default of 1GB, the write-ahead log alone can claim more than a 1Gi volume before a single document
is stored.

Growing a database past its tier is expansion in place, not a migration — design in
[docs/storage-tiers.md](docs/storage-tiers.md). Not built yet.

**Active memory is not currently comparable across the two columns.** The `~114 MiB` (PostgreSQL 110,
gateway 4) is resident set size. The DigitalOcean cluster had no metrics-server, so the only reading
available was the cgroup's `memory.current` — 167 MiB and 3 MiB — which includes page cache and is
not the same quantity. It needs a proper measurement rather than a substituted one.

An earlier run of this table recorded 176s to provision on DigitalOcean. A second cluster of the same
size in the same region did it in 50s, so that figure was not representative and has been replaced.
Every DigitalOcean number here is still a single observation.

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
restore as an API operation, backup retention, and vertical or storage autoscaling. Nothing installs
schema into a provisioned database yet ([#30](https://github.com/drigolabs/drigodb/issues/30)).

## Licence

MIT.
