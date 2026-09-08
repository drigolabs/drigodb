---
date: 2026-09-08
status: decided
topic: architecture
related:
  - docs/decisions/0004-cloudnativepg-for-the-data-plane.md
  - docs/decisions/0005-an-http-api-not-a-crd.md
  - docs/decisions/0006-nothing-inside-a-hosted-database.md
  - docs/decisions/0007-a-proxy-in-the-connection-path.md
---

# Mechanism in the core, policy outside

**Decision: drigodb's core provides mechanisms and holds no policy.** It can
create, hibernate, wake, resize, rotate, back up and restore a database. It does
not decide *when* any of those should happen.

The name is older than this project. Operating systems have called it the
separation of mechanism from policy since Hydra in 1975, and the design rule is
usually stated as *provide mechanism, not policy*.

## What prompted it

Automatic hibernation ([#85](https://github.com/drigolabs/drigodb/issues/85)).
The implementation sampled each database's open connections on an interval and
hibernated the ones that had been quiet — and it was wrong in a way worth
measuring: a database used once a minute by a short-lived connection had a
**67% chance of being hibernated while in use** at the interval first shipped,
falling to 0.2% at a much shorter one.

The obvious reading is that the sampling needed tuning. It is the wrong reading.
**The core was deciding something it structurally cannot know.** Connection
activity is an event, and drigodb sits outside the connection path, so it can
only sample and infer. No interval fixes a component reasoning about information
it does not have.

Two things followed from noticing that.

**Somebody else already knows.** OpenVoid serves the generated applications and
sees their HTTP requests. It knows when an application went quiet — exactly, as
events, earlier than drigodb could infer it. `POST /v1/databases/{id}/hibernate`
already exists, so the accurate version of this feature is a consumer calling
it, and needs nothing built at all.

**Every candidate fix was a new layer, not a smaller core.** The queue that
debounces activity, the connection-log stream that feeds it, the proxy in the
connection path ([0007](0007-a-proxy-in-the-connection-path.md)) — all of them
are policy machinery. None of them belong inside a service whose job is to make
a database exist.

## What this is not

Not an argument that drigodb should be small for its own sake, and not a refusal
to build the outer layer. It is a statement about where things go, and about
finishing one before starting the other: **a policy layer built on an unstable
core inherits every change to it.**

The core is close to stable. It provisions, hibernates, wakes, resizes, rotates,
backs up and restores, and each is proven end to end on a cluster in CI. The
outer layer has barely been designed. Doing the second while the first still
moves is how both end up half-finished.

## It has been the decision for a while

Naming it makes four earlier records one record.

| | |
|---|---|
| [0004](0004-cloudnativepg-for-the-data-plane.md) | the core does not reimplement PostgreSQL's mechanics |
| [0005](0005-an-http-api-not-a-crd.md) | the core exposes commands; the consumer drives |
| [0006](0006-nothing-inside-a-hosted-database.md) | the core does not own what is inside a tenant's database |
| this | the core does not decide when a database should sleep |

Each was argued on its own terms and reached the same place. That is usually a
sign the principle was already operating and had not been written down.

## Which record is which

Every record in this folder belongs to one of three groups, and the test for
which is a single question: **does it say what drigodb can do to a database, or
when to do it?**

| Group | Records |
|---|---|
| **Core** — a mechanism, or a constraint on one | [leaving DocumentDB](../leaving-documentdb.md), [0001](0001-instance-per-database-over-a-shared-cluster.md), [0004](0004-cloudnativepg-for-the-data-plane.md), [0005](0005-an-http-api-not-a-crd.md), [0006](0006-nothing-inside-a-hosted-database.md) |
| **Policy** — deciding when a mechanism runs | [0007](0007-a-proxy-in-the-connection-path.md) |
| **Neither** — how drigodb itself is operated | [0002](0002-gitops-for-the-control-plane.md), [0003](0003-argo-cd.md) |

The third group is not a hedge. GitOps and Argo CD are policy about drigodb's
own deployment, which is a different subject from policy about a tenant's
database; filing them under the same word would make the word useless.

That the policy column holds one record, still `proposed`, is the state this
decision describes rather than a gap in it.

[The index](README.md) carries the same grouping with each record's decision
spelled out, and is the copy to update when a record is added.

## What it means in practice

**The core keeps growing mechanisms.** Point-in-time recovery
([#19](https://github.com/drigolabs/drigodb/issues/19)), restore in place
([#22](https://github.com/drigolabs/drigodb/issues/22)), opt-in high
availability ([#81](https://github.com/drigolabs/drigodb/issues/81)), branching
([#86](https://github.com/drigolabs/drigodb/issues/86)) — all mechanisms, all
core work.

**Policy waits, and is built outside.** Automatic hibernation, the activity
queue, the connection proxy, retention scheduling, tier auto-scaling. When they
come, they come as components that call the API rather than as branches inside
it.

**Reporting is a mechanism; acting on the report is policy.** drigodb may say
what it observes — a database's status, when it last looked idle, what backups
exist. Deciding what that means is somebody else's.

**A mechanism must be complete enough to be driven.** This is the obligation the
decision creates rather than removes: if hibernation policy lives outside, then
`hibernate`, `wake` and the status they produce have to be good enough for an
outside caller to run a fleet on. That is a real bar, and it is the one
[#87](https://github.com/drigolabs/drigodb/issues/87) currently fails —
a policy layer cannot wake a database on a client's behalf if nothing sits in
the connection path.

## The immediate consequence

[#99](https://github.com/drigolabs/drigodb/pull/99) does not merge as it stands.
The parts of it that are mechanism — a NetworkPolicy that reconciles on wake, an
RBAC verb that was missing, permission checks that test verbs rather than
resources, and reporting who hibernated a database — are correct and belong in
the core. The sampling sweep is policy, and it was policy built on a signal the
core cannot see.

The NetworkPolicy rule admitting the control plane to each database's metrics
port goes with it. It is the only thing in that branch that costs something
permanently, and it exists solely to feed the signal this record says the core
should not be reading.
