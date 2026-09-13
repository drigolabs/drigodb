# drigodb

PostgreSQL databases, provisioned through an API on Kubernetes — hibernating when idle, waking in seconds.

[![CI](https://github.com/drigolabs/drigodb/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/drigolabs/drigodb/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/drigolabs/drigodb?sort=semver)](https://github.com/drigolabs/drigodb/releases)
[![Licence](https://img.shields.io/github/license/drigolabs/drigodb)](LICENSE)

`POST /v1/databases` and you get a `postgres://` URI a few seconds later. Each database is
a real PostgreSQL instance with its own volume, its own credentials and its own network
policy — not a schema in a shared cluster. Idle ones hibernate to **zero compute, storage
only**, and wake on request.

It exists because the ergonomics of a hosted Postgres — a database per branch, per
preview, per tenant, created and thrown away by an API call — are worth having without
handing your data and your bill to someone else's control plane. drigodb runs in a cluster
you own, on [CloudNativePG](https://cloudnative-pg.io), and does one job: making databases
exist and stop existing.

It is a **mechanism, not a platform.** There is no scheduler deciding when to hibernate
your databases and no policy about who gets how many; those are decisions drigodb
deliberately refuses to make for you ([0008](docs/decisions/0008-mechanism-in-the-core-policy-outside.md)).

## Quickstart

### On your laptop

Needs Docker, `kubectl`, `helm`, `kind` and Node 22.

```bash
git clone https://github.com/drigolabs/drigodb && cd drigodb
bash scripts/kind-up.sh --local --with-backups
```

That builds a cluster, installs the CloudNativePG operator, cert-manager, the backup
plugin and MinIO, then deploys drigodb. Two to three minutes. Then:

```bash
TOKEN=$(kubectl -n drigodb-system get secret drigodb-api-token -o jsonpath='{.data.token}' | base64 -d)
kubectl -n drigodb-system port-forward svc/drigodb-api 8080:80 &

curl -sS -XPOST localhost:8080/v1/databases \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"external_id":"my-app"}'
```

```json
{ "id": "a1b2c3d4e5f6",
  "status": "provisioning",
  "connection_uri": "postgres://app:...@db-a1b2c3d4e5f6.drigodb-databases.svc.cluster.local:5432/app?sslmode=require" }
```

Ready in 25–35 seconds. `bash scripts/kind-down.sh` when you are done — kind clusters are
not free RAM.

### On a cluster you already have

Installing drigodb needs permission to install CRDs, because the operator is
cluster-scoped and drigodb does not own it.

```bash
# 1. The operator, cert-manager and the backup plugin.
KUBE_CONTEXT=my-cluster bash scripts/cnpg-install.sh

# 2. A token. The chart will not invent one — a template that generates a credential
#    rotates it silently under any renderer that has no cluster.
kubectl create namespace drigodb-system
kubectl -n drigodb-system create secret generic drigodb-api-token \
  --from-literal=token="$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-40)"

# 3. drigodb.
helm install drigodb oci://ghcr.io/drigolabs/charts/drigodb \
  --namespace drigodb-system \
  --set api.existingSecret=drigodb-api-token
```

[docs/getting-started.md](docs/getting-started.md) has the same path with the
prerequisites spelled out, plus DigitalOcean in one script (`scripts/doks-up.sh`).

## The API

Everything under `/v1` needs `Authorization: Bearer <token>`. `/healthz` and `/readyz` do
not — a probe must not need a credential.

### Databases

| | |
|---|---|
| `POST /v1/databases` | Create, or return the existing one for that `external_id`. Takes `restore_from` and `high_availability`. **The only response carrying a `connection_uri`**, besides credential rotation |
| `GET /v1/databases` | The caller's databases |
| `GET /v1/databases/{id}` | Status, endpoint, tier, backup state |
| `DELETE /v1/databases/{id}` | Destroys the data. Never the bucket — see [archives](docs/archive-purge.md) |
| `POST /v1/databases/{id}/hibernate` | Zero compute, volume kept |
| `POST /v1/databases/{id}/wake` | Back in 9–13 seconds, [measured](docs/measured.md) |
| `POST /v1/databases/{id}/credentials` | Rotate. Returns a new `connection_uri` |
| `POST /v1/databases/{id}/resize` | `{tier}`, one of three ([storage tiers](docs/storage-tiers.md)). Online, no restart |
| `POST /v1/databases/{id}/high-availability` | `{enabled}`. Add or remove a synchronous standby ([what a failover costs](docs/diagrams/high-availability.md)) |
| `POST /v1/databases/{id}/restore` | Destructive, in place, keeps the id and the URI ([how](docs/restore-in-place.md)) |

### Backups and archives

| | |
|---|---|
| `POST /v1/databases/{id}/backups` | Take one now |
| `GET /v1/databases/{id}/backups` | What can be restored, including while hibernated |
| `GET /v1/archives` | Every prefix in the bucket and whether a database still owns it. Admin only |
| `POST /v1/archives/{id}/purge` | Remove a deleted database's archive. Admin only, confirmed, irreversible |

Retention bounds less than it sounds like it does, and
[docs/backup-retention.md](docs/backup-retention.md) is the table of what it does and does
not cover. [docs/archive-purge.md](docs/archive-purge.md) covers the purge.

### Tokens

| | |
|---|---|
| `POST /v1/tokens` | `{name, tier?, expires_in?, owner?}` → the token, **once**. Admin only |
| `GET /v1/tokens` | Metadata. Never a token, never a hash |
| `DELETE /v1/tokens/{id}` | Revoke, and report which databases it orphaned |

A token is a Secret holding a SHA-256 hash, so the value is returned once and cannot be
shown again. `tier` defaults to `tenant`, so nothing becomes an administrator by omission.
A database belongs to an owner, and two tenants may both call theirs `main`.

[docs/tokens.md](docs/tokens.md) has the detail — including **how to get back in** if an
installation has no working token left, which is a procedure `scripts/install-failure-test.sh`
runs on every pull request rather than one written down and hoped for.
[0009](docs/decisions/0009-one-tenant-cannot-reach-another.md) is the model;
[who-can-reach-what.md](docs/diagrams/who-can-reach-what.md) draws it.

### Also

`GET /v1/ca` returns the CA to verify against, when server authentication is configured.

## How it works

One CloudNativePG `Cluster` per database, installed by a Helm chart, reconciled by Argo CD.
drigodb itself is a small HTTP service that creates Kubernetes objects and reads their
status — it never connects to a database it provisions.

- **One instance per database, not a shared cluster** — [0001](docs/decisions/0001-instance-per-database-over-a-shared-cluster.md)
- **CloudNativePG owns the pods, volumes and failover** — [0004](docs/decisions/0004-cloudnativepg-for-the-data-plane.md)
- **An HTTP API, not a CRD**, because the consumer is an application — [0005](docs/decisions/0005-an-http-api-not-a-crd.md)
- **Nothing inside a hosted database** — no drigodb schema, no migrations — [0006](docs/decisions/0006-nothing-inside-a-hosted-database.md)
- **Mechanism here, policy elsewhere** — [0008](docs/decisions/0008-mechanism-in-the-core-policy-outside.md)

Four layers keep one tenant away from another's data: a separate PostgreSQL process, a
per-database role, a NetworkPolicy, and ownership on every API call. The fourth is the
newest and [0009](docs/decisions/0009-one-tenant-cannot-reach-another.md) says what it does
and does not protect.

## What is here, and what is not

Built and exercised on a real cluster on every pull request: provisioning, hibernate and
wake, credential rotation, online resize, physical backups, point-in-time recovery,
in-place restore, an opt-in synchronous standby with failover, archive listing and purge,
issued tokens, and per-owner isolation.

Not built:

- **No public endpoint, no accounts, no quotas.** Databases are reachable inside the
  cluster; exposing them is the installation's decision.
- **Nothing decides when to hibernate.** That is policy and ships separately
  ([#85](https://github.com/drigolabs/drigodb/issues/85), [#87](https://github.com/drigolabs/drigodb/issues/87)).
- **No branching yet** — copy-on-write from a snapshot rather than a full copy
  ([#86](https://github.com/drigolabs/drigodb/issues/86)).
- **Backups are off** until a bucket is configured ([how to turn them on](docs/getting-started.md#turning-backups-on)),
  and the control plane holds no object-storage credential by design.

Version `0.0.1` of the API, chart `0.1.0`. Interfaces still move.
[The backlog](https://github.com/drigolabs/drigodb/issues) is short enough to read in one
sitting.

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Prerequisites, kind, DigitalOcean, an existing cluster |
| [Consuming drigodb](docs/consuming-drigodb.md) | For the application on the other end of the API |
| [Local development](docs/local-development.md) | The inner loop |
| [Decision records](docs/decisions/) | Why it is shaped this way, and what was rejected |
| [What it costs](docs/measured.md) | Provisioning times, storage and memory, with the cluster each came from |
| [Tokens and owners](docs/tokens.md) | Tiers, rotation, and recovering a locked-out installation |
| [Storage tiers](docs/storage-tiers.md) | Three sizes, and why growing is one-way |
| [Backup retention](docs/backup-retention.md) | What the policy bounds, and what it does not |
| [Archive purge](docs/archive-purge.md) | Removing what a deleted database left behind |
| [Restore in place](docs/restore-in-place.md) | Keeping the id and the URI |
| [High availability](docs/diagrams/high-availability.md) | The opt-in standby, the failover, and what it costs a client |
| [Continuous delivery](docs/continuous-delivery.md) | How a merge becomes a release, and why nothing pushes to `main` |
| [Service boundary](docs/service-boundary.md) | What belongs in drigodb and what does not |

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) has the loop and the review bar.
[CLAUDE.md](CLAUDE.md) is the working notes — why things are shaped the way they are, and
which mistakes have already been paid for. Read it before a first patch.

Security reports go through GitHub's **Security → Advisories** tab rather than a public
issue.

## Licence

[MIT](LICENSE).
