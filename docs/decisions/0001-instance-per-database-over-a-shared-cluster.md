---
date: 2026-09-05
status: decided
topic: tenancy-model
supersedes: nothing — the first record in this log
related:
  - docs/leaving-documentdb.md
  - docs/documentdb-multitenancy-spike.md
  - docs/storage-tiers.md
---

# One PostgreSQL instance per database, over a shared cluster

**Decision:** drigodb keeps one PostgreSQL instance per hosted database. The shared tier — many app
databases inside one cluster — is not built, and is revisited on a measured trigger rather than a date.

This is the first time the choice has actually *been* a choice. Under DocumentDB it was forced; leaving
DocumentDB makes a shared cluster possible, so the topology now needs a reason rather than a
constraint.

## The two models

**Dedicated.** One app database is one StatefulSet: its own pod, its own PVC, its own credentials, its
own NetworkPolicy. What drigodb runs today.

**Shared.** One PostgreSQL cluster per installation, with a `CREATE DATABASE` per app inside it.
Isolation comes from PostgreSQL roles and `REVOKE CONNECT` rather than from separate processes.

## Why this was not previously available

`docs/documentdb-multitenancy-spike.md` settled it against a running container. DocumentDB's only
functional role is cluster-wide — a credential scoped to one app read another app's private document
and dropped its collection (F3) — and the database-per-tenant fallback is foreclosed because `pg_cron`
binds to one database per cluster, so the extension installs exactly once per instance (F4).

Both findings die with the extension. Per-database roles in plain PostgreSQL are a genuine boundary and
are what every managed Postgres relies on.

## Comparison

| | Dedicated (chosen) | Shared |
|---|---|---|
| Isolation boundary | Kernel: separate process, separate volume, separate cgroup | PostgreSQL privileges: roles, `REVOKE CONNECT` |
| Blast radius of a crash or corruption | One tenant | Every tenant in the cluster |
| Noisy neighbour | Impossible | Real: connections, WAL, temp space, CPU are shared |
| Per-tenant resource limits | Native (pod requests and limits) | Needs building |
| Provisioning latency | ~12s (27s on DigitalOcean warm, 50s cold) | Sub-second |
| Idle cost | Zero compute via hibernation; the PVC is billed | Effectively zero |
| Storage per database | 1Gi provisioned for ~64 MB used — about 94% waste | `CREATE DATABASE` costs roughly template1, ~8 MB |
| Backup and restore | `pg_dump` per database, already built | `pg_dump` per database, plus a story for the shared cluster |
| Connection pooling | Not needed | Needed (pgbouncer or equivalent) |
| Major version upgrades | Stageable per tenant | All tenants at once |
| Scaling ceiling | Pods per node (110 default) and **volumes attachable per node** | One instance's capacity |

### The cost curve

Rough monthly figures, DigitalOcean pricing ($0.10/GiB/month block storage, $24 for `s-2vcpu-4gb`),
assuming 10% of databases awake at any time. Order-of-magnitude, not quotes.

| | 100 databases | 1,000 databases |
|---|---|---|
| Dedicated | ~$10 storage + 1 node ≈ **$34** | ~$100 storage + ~7 nodes ≈ **$270** |
| Shared | ~$2 storage + 1 node ≈ **$26** | ~$10 storage + 2–3 nodes ≈ **$60–110** |

Below roughly 100 databases the difference is noise. Above roughly 500 it is 3–4×.

**The gap is storage, not compute, and that is because compute was already solved.** Hibernation means
an idle dedicated database costs zero CPU and zero RAM, which retires the usual argument for shared
tenancy — that idle tenants each hold a process. What remains is the PVC, billed at its provisioned
size, and the README already identifies storage as the term that tracks *total* signups where compute
tracks concurrent ones.

## Decision, and why

**Dedicated, for now.**

- **There is one consumer and it has no production databases.** At that scale the models cost the same,
  and dedicated is already built, already proven, and adds no new provisioning path. The migration plan
  calls the shared tier "the first genuinely new provisioning path since v0.0.1"; that is a large piece
  of work to do speculatively.
- **The isolation story is the product's.** The README leads with "tenants are untrusted by definition —
  isolation has to be enforced, not conventional." Dedicated gets that from the kernel. Shared gets it
  from PostgreSQL privileges, which is real but is a privilege bug away rather than a container escape
  away.
- **Shared costs more than it looks.** Connection pooling, per-database resource governance, and an
  answer for one tenant's runaway query are all prerequisites, none of which exist.
- **Nothing is foreclosed.** The migration removes F4 without spending it. Building shared later is the
  same work it would be now, minus the risk of having guessed wrong about the shape.

## Consequences

- Provisioning stays ~12s and wake stays ~8s; sub-second provisioning is not available.
- Storage stays the dominant cost per idle database. `DRIGODB_STORAGE_SIZE` stays at 1Gi, deliberately
  at the small end: a PVC can be expanded in place and never shrunk, and a StatefulSet's
  `volumeClaimTemplates` is immutable, so the default is permanent for every database created under it.
- Removing the gateway returns its 50m CPU and 32Mi memory request per pod, which is a direct density
  gain. Further tuning of the postgres container's requests should wait for the re-measurement in #32
  rather than be guessed.

## The risk this decision carries

**Volumes attachable per node is a hard ceiling that the cost curve does not predict.** Kubernetes
defaults to 110 pods per node, but cloud providers cap attached block volumes per node well below that,
and DigitalOcean's limit is believed to be single-digit per droplet. If that is right, a small cluster
tops out at a couple of dozen databases regardless of how much RAM is provisioned, and no amount of node
sizing fixes it.

**This is unverified and should be measured before the dedicated model is trusted to scale.** It is the
kind of limit that is invisible until it is a wall, and it would move the trigger below substantially.

## When to revisit

A trigger, not a date. Any one of:

- crossing ~50 provisioned databases
- idle storage becoming a visible line on a bill
- a consumer needing sub-second provisioning
- the volume-attach ceiling above turning out to be low

**And when it is revisited, shared is a tier and not a replacement.** Shared becomes the default;
dedicated stays for tenants who need the harder boundary. That is a product differentiator rather than
a legacy path, and `docs/storage-tiers.md` already assumes tiers exist.
