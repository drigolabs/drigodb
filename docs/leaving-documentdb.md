---
date: 2026-09-04
topic: leaving-documentdb
status: decided
decides: the three one-way doors in the migration plan's phase 0
related:
  - docs/plans/2026-09-03-postgres-document-store-migration-plan.md
  - docs/documentdb-multitenancy-spike.md
---

# Leaving DocumentDB

drigodb stops being MongoDB-compatible. A provisioned database becomes a plain PostgreSQL instance
that applications connect to with `libpq`, and the DocumentDB extension, the wire-protocol gateway and
the images built around them are removed.

This document records the decision and its reasoning. The work is tracked from
[#24](https://github.com/drigolabs/drigodb/issues/24); the design it implements is
[the migration plan](plans/2026-09-03-postgres-document-store-migration-plan.md).

## What is decided

**MongoDB wire-protocol compatibility is dropped.** Applications speak PostgreSQL. This is not
"deferred" or "pending demand" — it is the premise the rest of the migration is built on, and
reintroducing it later would mean rebuilding what this migration deletes.

**There is no gateway.** Not a smaller gateway, not a gateway behind a flag. The gateway container,
its self-signed TLS, the shared-UID constraint between two containers, the Unix-socket coupling and
`documentdb.localhost_connection_string` all go, because every one of them exists to serve the wire
protocol and nothing else.

**`connection_uri` changes shape**, from `mongodb://…?tls=…` to `postgres://…?sslmode=require`. This
breaks the documented contract. Under the 0.x rule already in the README a `feat!:` bumps the minor,
so it ships as an ordinary release rather than a 1.0.0 nobody decided on.

## Why

Three structural costs, each documented rather than assumed.

**Isolation is forced, not chosen.** [The multitenancy spike](documentdb-multitenancy-spike.md)
settled this with a running container, not a reading of the docs. DocumentDB's shipped roles are
cluster-wide: `documentdb_readwrite_role` cannot create or read a collection at all, and
`documentdb_admin_role` — the only role that can do useful work — owns every collection table in the
instance. A credential scoped to `app_beta` read `app_alpha`'s private document and then dropped its
collection. There is no role in between (F3). The usual fallback of a PostgreSQL database per tenant is
closed off too, because `pg_cron` is a hard dependency of the extension and binds to one database per
cluster (F4).

So the only safe topology is one PostgreSQL instance per database — fine as a premium tier, ruinous as
the only tier, at roughly 256 MiB requested per idle database.

**drigodb maintains a base image it never wanted.** Upstream builds against Ubuntu's libicu74 and
CNPG's image ships libicu76, so `images/postgres-documentdb` mirrors CNPG on Ubuntu 24.04 and rebuilds
every Monday to patch its own base. That is a standing weekly obligation, a smoke test and a recurring
issue, all in service of a version bump this project has no opinion about.

**BSON is a custom type behind a gateway.** The consequences are concrete: `pg_dump` cannot back up a
DocumentDB database at all — it never dumps the data of tables belonging to an extension, and
`documentdb` marks none of its catalog for dumping, so a restore completes with no error and every
collection is invisible. That single fact is why backups had to be physical, with a ~73 MB floor per
backup and restores only into the same PostgreSQL major version. Alongside it: no row-level security,
no generated columns, no plain SQL joins, and a roadmap owned by one vendor.

## What it costs

**The positioning.** "MongoDB-compatible databases on PostgreSQL" was the pitch and the reason someone
might pick this over provisioning Postgres themselves. A Postgres provisioning service is a more
crowded field. This is a real loss and is the main argument against the decision.

**The stated fallback is weaker than it looks.** The migration plan answers regret with "FerretDB in
front of a plain Postgres is an add-on, not a redesign." But F1 of the spike already retired FerretDB:
last release 2025-11-10, last commit 2026-02-07, and both 2026 commits are dependency bumps. The escape
hatch should not be counted on. If wire-protocol compatibility ever matters again, it is new work.

## Why now

openvoid, the only consumer, has not written a line against the MongoDB contract. There is no
`mongodb`, `mongoose`, `pg`, `drizzle`, `prisma` or `kysely` dependency in any of its four workspace
manifests; the sole `mongodb://` reference in that repo is in a planning document, describing an
`OPENVOID_DATABASE_URL` that would be passed to a session pod.

So the downstream migration cost is zero today and rises from here. There are also no accounts and no
public endpoint, so no provisioned database holds data anyone can have come to depend on — which is why
existing databases are destroyed and re-provisioned rather than migrated. A BSON→JSONB migration would
be built for nobody.

## What this does not decide

**The topology does not change.** One PostgreSQL instance, one pod, one volume, one credential set per
provisioned database, exactly as today. The three isolation layers — instance, role, network — survive
verbatim, and so do hibernate/wake and the template-hash reconcile. What changes is the contents of the
pod: `postgres + extension + gateway` becomes `postgres`.

A shared tier — many app databases inside one cluster — is what F4 made impossible and this migration
makes *available*. It is phase 6 of the plan, it is not scheduled, and when it arrives the current
per-instance path remains as the dedicated tier.

**The document framework is not adopted.** The migration plan continues into a manifest DSL, a patch
log with rollback, a filter/aggregate compiler, an index-proposal sweeper and an analytics dial
(phases 3–7). None of that is decided here. It is a separate bet with its own justification and its own
cost, and the migration is deliberately scoped so that it does not depend on the answer.

## Consequences

- `POST /v1/databases` and `POST /v1/databases/{id}/credentials` return a `postgres://` URI ([#28](https://github.com/drigolabs/drigodb/issues/28))
- three images, `versions.env` and the Monday rebuild are deleted ([#27](https://github.com/drigolabs/drigodb/issues/27))
- `pg_dump` works, so backups become logical and land with the migration rather than after it ([#31](https://github.com/drigolabs/drigodb/issues/31))
- [#22](https://github.com/drigolabs/drigodb/issues/22) needs rewriting: its argument rests on physical restore and on `pg_cron` binding one database per cluster, and both premises die here
- [#9](https://github.com/drigolabs/drigodb/issues/9) is unchanged in substance — CNPG's image self-signs too, so `sslmode=require` is the same weak guarantee under a different name
