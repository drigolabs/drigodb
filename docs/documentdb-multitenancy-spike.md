---
date: 2026-08-29
topic: documentdb-multitenancy-isolation
status: complete
note: originally run inside the openvoid repo; carried across when drigodb was extracted
documentdb-version-tested: 0.116-0 (commit 7bceb7e, built 2026-08-24, PostgreSQL 17)
image-tested: ghcr.io/documentdb/documentdb/documentdb-local:latest
---

# DocumentDB Multi-Tenancy Isolation Spike

## Why this spike exists

The proposed design was "Postgres + DocumentDB + FerretDB, one schema/database per tenant for
isolation". Three premises in that sentence were unverified and load-bearing. This spike settles them
before any design commits to them.

The requirement being tested: **each hosted database must be unreadable and undestroyable by every
other.** Tenants are untrusted by definition — isolation has to be enforced, not conventional. This is
the finding the whole of drigodb's architecture rests on.

## What was tested

A `documentdb-local:latest` container (DocumentDB 0.116-0, PostgreSQL 17) with two app databases
(`app_alpha`, `app_beta`), each holding a private document, and Postgres login roles standing in for
per-app credentials. Access was exercised through `documentdb_api` — the same entry points the gateway
calls — under `SET ROLE`, plus direct SQL against the underlying tables.

## Findings

### F1. FerretDB is redundant and dormant — dropped

DocumentDB ships `pg_documentdb_gw`, its own Rust MongoDB-wire-protocol gateway, which is the job
FerretDB was doing. FerretDB's last release is v2.7.0 (2025-11-10) and its last commit is 2026-02-07;
both 2026 commits are dependency bumps. DocumentDB released `v0.116-0` on 2026-08-24 with `v0.118`
already in its changelog. Decision: use the DocumentDB gateway, drop FerretDB.

### F2. A MongoDB database is NOT a PostgreSQL schema

RFC-006 in the DocumentDB repo states *"DocumentDB maps MongoDB database maps to PG schema and MongoDB
collection maps to PG table."* **This is not what the shipped engine does.** Creating two MongoDB
databases produced zero new PostgreSQL schemas. The actual layout:

- Every collection, in every database, becomes a row in `documentdb_api_catalog.collections`
  carrying `database_name`, `collection_name`, `collection_id`.
- Data lands in a flat, cluster-wide `documentdb_data.documents_<collection_id>` table.
- The MongoDB database name is a **column value**, not a namespace.

There is no per-app schema to grant against. Treat RFC-006's prose as aspirational; it is a Draft with
an unfiled issue (`issue: TBD`).

### F3. The only functional role can read and destroy every app's data

All `documentdb_*` functions are `SECURITY INVOKER` (0 `SECURITY DEFINER` across 610 functions), so the
caller's privileges genuinely apply — promising, but it does not help, because of how the shipped roles
are provisioned. Collection tables are owned by `documentdb_admin_role` with `relacl = NULL`, meaning
**only the owner holds any privilege on them**:

| Role granted to an app | Result |
|---|---|
| `documentdb_readwrite_role` | Non-functional. Cannot create a collection (`permission denied for table collections`), cannot read one (`permission denied for table documents_4`). |
| `documentdb_admin_role` | Fully functional — and fully cross-tenant. |

With `documentdb_admin_role`, a role scoped to `app_beta` successfully:

- read `app_alpha`'s private document (`ALPHA-PRIVATE-DATA`) via `find_cursor_first_page`;
- **dropped `app_alpha`'s collection** via `drop_collection`.

Any app credential that can do useful work can therefore read and destroy every other app's data. There
is no middle role. Additionally, any role at all can enumerate every app in the cluster by selecting
`database_name` from `documentdb_api_catalog.collections` — a tenant-list metadata leak independent of
the data access above.

### F4. One Postgres cluster can host exactly one DocumentDB database

The fallback design — a Postgres *database* per app inside one shared cluster, isolated by
`REVOKE CONNECT` — **is not available.** `pg_cron` is a hard declared dependency of the `documentdb`
extension, and pg_cron's background worker binds to a single database named by `cron.database_name`
(here, `postgres`). Installing the extension into a second database fails outright:

```
ERROR:  can only create extension in database postgres
DETAIL:  Jobs must be scheduled from the database configured in cron.database_name...
```

DocumentDB is therefore one logical instance per PostgreSQL cluster. Isolation cannot be bought with a
cheap extra database.

## Conclusion

F3 and F4 together mean **enforced per-app isolation inside a shared DocumentDB instance is not
achievable at version 0.116-0.** The isolation unit the engine offers is a catalog column, not a
security boundary, and the boundary that would substitute for it (a separate Postgres database) is
foreclosed by pg_cron.

The surviving options are a PostgreSQL cluster per database, a service-owned mediation layer that never
hands apps direct credentials, or a shared instance with the gap documented and accepted. That choice
trades cost against isolation strength, and drigodb resolves it in favour of a PostgreSQL instance per
database. Every other architectural decision in this repo follows from that.

## Reproduction

Scripts used are in `/tmp/documentdb-spike/` for the life of the session; each finding above is a
single `psql` run against the container:

```
docker run -dt -p 10260:10260 -p 9712:9712 --name documentdb-spike \
  ghcr.io/documentdb/documentdb/documentdb-local:latest \
  --username spikeadmin --password '<pw>'
docker exec documentdb-spike psql -p 9712 -U documentdb -d postgres
```
