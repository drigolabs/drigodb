---
date: 2026-09-06
status: decided
topic: scope
related:
  - docs/decisions/0004-cloudnativepg-for-the-data-plane.md
  - docs/consuming-drigodb.md
---

# Nothing inside a hosted database

**Decision: drigodb owns the database, the role and the volume, and puts nothing
inside.** No schema of its own, no ledger, no migrations, no runner.

## What was there

A `_drigodb` schema, applied from `charts/drigodb/files/migrations/` in filename
order, tracked in `_drigodb.schema_migrations`, with a forward-only runner that
recorded a `sha256` per file and refused to start a server whose applied
migration no longer matched the file.

Careful machinery. One migration existed. It created the ledger, and a function
reporting what was in the ledger.

**Nothing read it.** `src/` contained no reference to `_drigodb` at all. The only
consumers were the runner, a test asserting the runner had run, and
documentation describing the runner.

## Why it went

It was built for a future in which drigodb needs schema inside a database it
hosts, and that future never arrived. Under DocumentDB there was an extension to
manage; [leaving DocumentDB](../leaving-documentdb.md) removed it, and the
machinery outlived the reason for it.

The cost only became visible under
[0004](0004-cloudnativepg-for-the-data-plane.md). CloudNativePG owns the pod, so
the runner could no longer be an entrypoint and had to become a Job connecting
over TCP — which meant it needed an identity, which meant either handing the
application ownership of its own migration ledger, or a third role with its own
credential, or enabling superuser access and putting a superuser password beside
every application password.

That is a lot of design pressure, and a security question with no comfortable
answer, in service of a schema nothing uses.

The choice that clarified it: **if drigodb is database infrastructure, what is
inside the database is the tenant's.** A schema drigodb owns in someone else's
database cuts against the product it is trying to be, and the fact that the only
thing in it was self-referential is the tell.

## What went with it

- `charts/drigodb/files/migrations/` and `migrate.sh`
- `scripts/migrations-test.sh` and its CI step
- the `drigodb_migrator` role, its Secret, its bootstrap SQL and its managed role
- the `migrating` status, and the question of what a failed migration should do
  to a database that is otherwise up
- the frozen-checksum contract, which is what forced the Job design in the first
  place — `postInitApplicationSQL` mangles `$$` into `$`, and `001-core.sql`
  could not be rewritten to avoid it

`bootstrap.sh`, `postgresql.conf` and `pg_hba.conf` went at the same time, but
for a different reason: 0004 gave the pod to the operator, so they had nothing
left to configure.

## Bringing it back

Cheap, and better informed. A Job and a runner, built when there is a first real
migration to carry, shaped by what that migration actually needs rather than by a
hypothesis. Both files are in git history at the commit that removed them.

## What must not be lost with it

`pg_hba.conf` restricted the application to `hostssl` — TLS or nothing.
CloudNativePG's default ends `host all all all scram-sha-256`, so removing that
file silently allowed plaintext connections to every hosted database. Measured on
kind, not reasoned about.

The rule now lives in the Cluster's `spec.postgresql.pg_hba`, and
`scripts/smoke.sh` asserts a plaintext connection is refused — because every
other connection in that script uses the URI as issued, which carries
`sslmode=require` and passes either way.
