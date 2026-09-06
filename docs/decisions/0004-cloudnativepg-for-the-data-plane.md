---
date: 2026-09-06
status: decided
topic: data plane
related:
  - docs/decisions/0001-instance-per-database-over-a-shared-cluster.md
  - src/k8s/provisioner.ts
  - src/k8s/manifests.ts
---

# CloudNativePG for the data plane

**Decision: a hosted database becomes a CloudNativePG `Cluster`, not a
StatefulSet drigodb assembles itself.** High availability is opt-in per
database; single-instance stays the default.

[0001](0001-instance-per-database-over-a-shared-cluster.md) is unchanged — still
one PostgreSQL instance per hosted database. This record is about *who builds
the instance*, not how many there are.

## What prompted it

[#11](https://github.com/drigolabs/drigodb/issues/11) gave the control-plane API
two replicas. That was read, reasonably, as making databases highly available.
It does not: consumers connect to their database directly and never through the
API, so control-plane replicas change nothing about what happens when a database
dies.

Nothing in the data plane replicates. Every database is one pod on one
`ReadWriteOnce` volume. The only `replication` in the repository is
`pg_basebackup` opening a replication connection to take a backup.

What a database failure costs today:

| | |
|---|---|
| pod crashes | the StatefulSet restarts it on the same volume — seconds, no data loss |
| node fails | the pod reschedules once the node is `NotReady` (~5 min), volume detaches and reattaches — minutes, no data loss |
| volume or AZ lost | the data is gone; only a backup recovers it, to the last backup |

So the data has a fail-safe. Nothing picks up the load.

## Why not hand-roll replication

A second pod and a replication slot are the easy half. The hard half is that
failover is a *decision*, and it needs three things this repository has no
machinery for:

1. **Establishing the primary is dead** rather than briefly unreachable from one
   vantage point.
2. **Choosing which standby to promote** — the one furthest ahead, or committed
   transactions are silently discarded.
3. **Fencing the old primary** so it cannot take a write if it returns. Without
   this, a network partition produces two primaries accepting writes and there
   is no reconciling them afterwards. Someone's data is simply chosen to be
   thrown away.

That is consensus-backed leader election. Writing it here would be writing a
distributed-systems component from scratch, in a repository whose one operator
would be debugging it during an outage, with silent data loss as the failure
mode of getting it subtly wrong. It is the single category of bug this product
cannot survive.

**The sharpest argument is what CloudNativePG itself does: it does not use
StatefulSets.** It manages Pods and PVCs directly, because a StatefulSet's model
— identical, interchangeable, ordinal-ordered pods — is the wrong shape when
exactly one pod is special and which one changes at runtime. The people who
solved this concluded the primitive drigodb currently builds on does not fit.

## drigodb is already an operator

This is what makes the change smaller than it sounds. `src/k8s/provisioner.ts`
watches for desired state, builds objects, stores its state in labels on them,
and reconciles the pod template on every wake. That is an operator; it simply
takes desired state through an HTTP API rather than a CRD, which is the right
choice for the product — a consumer should never need `kubectl`.

So the question was never "operator or StatefulSet". It was **whose controller
owns the PostgreSQL-specific part**. drigodb keeps owning the product — the API,
tokens, tiers, hibernation, the network boundary — and delegates database
internals.

| stays drigodb's | becomes CNPG's |
|---|---|
| the HTTP API and its idempotency | the pods, the PVCs, the replication |
| tiers, and what a tier means | primary election, promotion, fencing |
| the NetworkPolicy and the `drigodb.io/allow-database` contract | the read-write Service the URI points at |
| the bearer token, and [#72](https://github.com/drigolabs/drigodb/issues/72) after it | backup, WAL archiving and PITR |
| hibernation as a product feature | how an instance is actually stopped |

The stored-URI contract survives: CNPG's read-write Service follows the primary,
so a URI a consumer wrote down keeps working across a failover. That matters more
here than in most installations, because drigodb returns the URI once and never
again.

## Opt-in, not default

Every consumer asked for HA would be the simpler contract, and it was the
literal ask. It is refused on cost.

[0001](0001-instance-per-database-over-a-shared-cluster.md) measured a 1500 MiB
node fitting two databases, and DigitalOcean's CSI driver caps a node at 15
attached volumes. A standby doubles both the pods and the volumes per database —
roughly halving how many databases a node holds, on a design that deliberately
chose the smallest workable pod to keep storage cheap.

Most hosted databases are a side project's, and minutes of downtime after a node
failure is the correct trade for them. The ones that are not should say so, and
pay for it.

## What this costs

- **An operator and its CRDs in the install path.** drigodb's pitch is that
  someone can install it on their own cluster; that now requires cluster-scoped
  CRD permissions and a second component. It is the largest thing given up.
- **Legibility.** Today every failure mode in this repository can be read end to
  end. Afterwards, some answers live in someone else's controller.
- **`bootstrap.sh` loses most of its job**, and with it direct control of the pod
  template — the tier configuration, the certificate install, the credential
  fingerprint marker.
- **A migration for databases that already exist.** They are plain StatefulSets
  and nothing rewrites them in place.

## Unverified, and the work must establish it

This record has no measurements behind it, which makes it weaker than
[0003](0003-argo-cd.md). Nothing below is assumed to be free:

- **Hibernation.** Zero-compute hibernation is a drigodb feature, not a nicety —
  it is what makes a dormant database nearly free, and waking is on the critical
  path for a cold application. CNPG documents declarative hibernation; that it
  behaves the way this product needs, at the speed it needs, is the first thing
  to prove and the one that could reverse this decision.
- **Migrations.** `bootstrap.sh` runs forward-only checksummed migrations on
  every start, which is how a new migration reaches a database that already
  exists. CNPG's `initdb` hooks run at creation only. There is no obvious
  equivalent and this is the biggest open design question.
- **Certificates.** CNPG manages its own TLS. Whether that replaces the
  cert-manager `Certificate` from
  [#73](https://github.com/drigolabs/drigodb/issues/73) or fights it is untested,
  and `GET /v1/ca` promises consumers something specific.
- **Backups.** CNPG's object-store support has been moving to a plugin; which
  mechanism a current release wants is a question for implementation, not for
  this record. It plausibly subsumes
  [#19](https://github.com/drigolabs/drigodb/issues/19) and
  [#22](https://github.com/drigolabs/drigodb/issues/22) — neither should be
  built against the hand-rolled data plane in the meantime.
- **Operator overhead**, against 0003's measured node budget, where Argo core
  already costs most of one database.
