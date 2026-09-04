---
date: 2026-09-03
status: proposal
related:
  - README.md
  - docs/service-boundary.md
  - docs/storage-tiers.md
  - docs/documentdb-multitenancy-spike.md
---

# drigodb — migrating from DocumentDB/BSON to the Postgres document store with a schema dial

**Status:** proposal. Nothing here is built. It replaces the data plane and extends the API; it keeps
the control plane, the isolation model, hibernation, and the release pipeline as they are.

**One-line target:** *versioned document databases on PostgreSQL that start schemaless and dial each
field toward relational and columnar storage as semantics, usage and cost demand — provisioned through
an API.*

## Why

The DocumentDB path has three structural costs that the spike and the README already document:

1. **Isolation is forced, not chosen.** DocumentDB's roles are cluster-wide and `pg_cron` binds to one
   database per cluster, so the only safe topology is one PostgreSQL instance per database. That is
   fine as a premium tier and ruinous as the only tier: ~256 MiB requested per idle database, and
   compute that tracks concurrent databases.
2. **drigodb owns a base image it did not want.** Upstream builds against Ubuntu's libicu74, CNPG's
   image ships libicu76, so `images/postgres-documentdb` mirrors CNPG on Ubuntu 24.04 and rebuilds
   every Monday to patch its own base. Every version bump is a rebuild, a smoke test and an issue.
3. **BSON is a custom type behind a gateway.** No row-level security, no generated columns, no plain
   SQL joins into relational tables, no `pg_dump`-per-database that any Postgres tool understands, and a
   roadmap owned by one vendor. The gateway container, its self-signed TLS, its peer-auth socket
   coupling and `documentdb.localhost_connection_string` are all accidental complexity of that choice.

The replacement keeps everything Postgres already does well and adds the two things DocumentDB never
gave us: per-entity history with rollback, and a promotion path from JSON to real columns.

## What stays, what goes

| Area | Decision |
|---|---|
| Control-plane API (`/v1/databases`, idempotent `external_id`, credential rotation, 202 + poll) | **Keep.** Add manifest endpoints (phase 5). |
| Hibernate/wake, template-hash reconcile, StatefulSet-as-source-of-truth | **Keep** unchanged. Applies to the dedicated tier only once a shared tier exists. |
| Isolation: instance / role / NetworkPolicy | **Keep.** The role layer gets stronger: the app role can no longer read base tables. |
| Release pipeline, Conventional Commits, tag-not-branch | **Keep** unchanged. |
| `images/postgres-documentdb` | **Delete.** Replaced by CNPG's official `ghcr.io/cloudnative-pg/postgresql:18` — weekly rebuilds inherited, nothing to patch. |
| `images/documentdb-gateway` | **Delete.** No gateway. Apps connect with libpq/`pg` over TCP + SCRAM. |
| `images/documentdb-backup` | **Replace** in phase 6 with `pg_dump` per database (shared tier) or Barman/pgBackRest (dedicated). |
| `config/postgresql.conf` | **Rewrite.** Drop `shared_preload_libraries`, `cron.*`, `documentdb.*`, `bsonUseEJson`, the second socket dir. Keep the WAL sizing, it is still right. |
| `config/bootstrap.sh`, `pg_hba.conf`, `pg_ident.conf` | **Simplify.** No peer map for a gateway; TCP scram for the app role; keep the credential fingerprint marker. |
| `docs/documentdb-multitenancy-spike.md` | **Keep** as history. It is the reason the shared tier was impossible before and is possible now. |
| `images/versions.env` | **Shrink** to `PG_MAJOR`. The data plane no longer carries an upstream extension version. |
| `connection_uri` | **Change** from `mongodb://…?tls=…` to `postgres://appuser:…@db-{id}…:5432/app?sslmode=require`. Breaking; bumps 0.x minor. |

## Target architecture

Three artefacts make up the data plane. None of them is a network service in front of Postgres.

1. **`@drigodb/data`** — a TypeScript library the app links. Manifest definition (Zod + storage
   hints), repository primitives, the filter/aggregate compiler, the write path, and the deploy-time
   DDL pipeline. Everything transactional runs in the app's process against its own database.
2. **The SQL core** — a versioned migration set installed into every database on provision:
   the `_drigodb` schema with `apply_patch`, `jsonb_merge_patch`, `fold_patches`, `safe_numeric`, the
   `manifests` and `proposals` tables, and the role grants. Run as a Job on provision and on upgrade.
3. **The sweeper** — one Deployment per cluster, not per database. Compaction (only for entity types
   with a delta window), index-usage observation, invalid-index cleanup, patch retention, and the
   rebuild-equality check. It connects only to awake databases and never wakes one.

Per entity type the pipeline creates a table pair and a view:

```sql
CREATE TABLE key_result (
  id            uuid PRIMARY KEY,
  head_seq      bigint NOT NULL DEFAULT 0,
  snapshot_seq  bigint NOT NULL DEFAULT 0,
  deleted_at    timestamptz,
  data          jsonb NOT NULL,
  -- promoted fields land here: objective_id uuid REFERENCES objective(id), seats__count numeric CHECK (...)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 80);
ALTER TABLE key_result ALTER COLUMN data SET COMPRESSION lz4;

CREATE TABLE key_result_patch (
  entity_id  uuid   NOT NULL,
  seq        bigint NOT NULL,
  patch      jsonb  NOT NULL,          -- {op, value|path+delta, actor, guard}
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, seq)
);

CREATE VIEW key_result_current AS ...;  -- folds promoted columns (and any delta window) back into data
```

Write path, default threshold 1 (write-through — the snapshot is always current):

```sql
UPDATE key_result
SET data = _drigodb.apply_patch(data, $patch),
    head_seq = head_seq + 1, snapshot_seq = head_seq + 1, updated_at = now()
WHERE id = $1 AND head_seq = $expected;      -- 0 rows → 409
INSERT INTO key_result_patch (entity_id, seq, patch) VALUES ($1, $new_seq, $patch);
```

Manifest vocabulary the compiler and pipeline understand:

| Hint | Storage | Enforcement |
|---|---|---|
| plain Zod field | JSON | Zod on write |
| field appears in compiled `WHERE`/`ORDER BY`/`GROUP BY` | JSON | typed partial expression index (observed → proposed) |
| `inc` op on a numeric field | JSON | commutative, no OCC required |
| `inc` + `guard` | JSON | evaluated under the row lock |
| `strict` (money, stock, counters) | column + `CHECK` | database |
| `ref('objective', { onDelete })` | `uuid` column + FK + index | database; library implements tombstone cascade |
| `refs('tag')` | join table with composite PK + FKs | database |
| `unique: [...]` | unique index over promoted columns | database |
| `churn: 'high'` | JSON, delta window (threshold > 1, fold in view) | opt-in only |

## Phases

Each phase merges on its own and leaves `main` deployable. Phases 1–3 are the migration; 4–7 are the
product.

### Phase 0 — decisions to lock before writing code

- **Tagline and README** change now, so every commit after this is toward the same thing.
- **Naming of promoted columns:** deterministic `path__segments`, 63-byte cap with a hash suffix; the
  mapping lives in the manifest, never in code.
- **No gateway, ever.** Apps speak Postgres. Mongo-driver compatibility is out of scope and stays out.
- **Threshold 1 is the default.** The delta window is an opt-in per entity type. This is the decision
  that keeps the view fold, retention rules and staleness reasoning out of the default path.
- **Licence stays MIT.** The SQL core and the library are the open-source surface; the control plane
  is the hosted surface.

### Phase 1 — swap the data-plane pod (the actual migration)

Goal: a provisioned database is a plain Postgres 18 with the SQL core installed, and nothing else.

1. `config.pgImage` → `ghcr.io/cloudnative-pg/postgresql:18`. Delete `gatewayImage`.
2. `buildPodTemplate`: remove the gateway container, the socket volume, `GATEWAY_STATE_VOLUME`, the
   shared-UID constraint. Keep `RUN_AS_USER = 26` (CNPG's image uses it). Add an init container or a
   post-start hook that runs the SQL core migrations idempotently against `app` — or run them from the
   provisioner over TCP once `pg_hba` admits it from the control plane's namespace. Prefer the
   provisioner: the control plane already owns the credential, and "the control plane cannot reach
   PostgreSQL" was a DocumentDB-era rule that bought nothing once there is no gateway to protect.
3. `config/postgresql.conf`: keep `max_wal_size = 256MB`, `min_wal_size = 64MB`, `listen_addresses`.
   Drop everything DocumentDB-specific. Add `wal_compression = lz4`, `default_toast_compression = lz4`.
4. `pg_hba.conf`: `hostssl app appuser 0.0.0.0/0 scram-sha-256`; keep peer for `postgres` local.
   TLS from CNPG's image self-signed for now; the real-issuer item in Status is unchanged.
5. `connectionUri()` returns a `postgres://` URI. `Service` port `5432`, name `postgres`.
6. `images/`: delete the three DocumentDB images, their tests, `versions.env` entries, the Monday
   rebuild in `images.yml` and the standing issue writer. The postgres image is no longer ours.
7. CI: replace `data-plane-images` with a Testcontainers job (phase 2) — the thing that must be proved
   is now "the SQL core installs and round-trips a patch", not "the extension loads".
8. Re-measure and update the README tables: baseline storage should drop from 73 MB toward ~40 MB
   (no PostGIS, no DocumentDB catalogs), provision time should drop by the `CREATE EXTENSION` cost,
   idle RSS should drop below 110 MiB.

Existing v0.0.1 databases hold no customer data (no accounts, no public endpoint). Destroy and
re-provision; do not build a BSON→JSONB migration nobody will run.

**Done when:** `POST /v1/databases` returns a Postgres URI, `psql` connects with it, and
`SELECT _drigodb.version()` answers.

### Phase 2 — the SQL core

Everything that must be identical between the write path, the views and the sweeper lives in SQL, once.

- `_drigodb` schema, versioned migrations (`_drigodb.schema_migrations`), idempotent, forward-only.
- `jsonb_merge_patch(target, patch)` — RFC 7396, recursive; `apply_patch(doc, p)` — `replace`,
  `restore`, `merge`, `inc`; `fold_patches` aggregate; `safe_numeric(text)`.
- `manifests(entity_type, version, manifest jsonb, applied_at)` and
  `proposals(id, entity_type, kind, detail jsonb, created_at, applied_at)`.
- Roles: `appuser` gets `SELECT` on `*_current` views and on `*_patch`, `INSERT/UPDATE` on entity
  tables through the library's statements, no `SELECT` on base tables. A separate `drigodb_ddl` role,
  used only by the pipeline Job, owns DDL. The app role can never create an index.
- Tests: Vitest + Testcontainers against `cloudnative-pg/postgresql:18`. The RLS-style fixture rule
  from earlier work still applies: tests connect as `appuser`, never as owner, or grants are untested.
- The **rebuild equality test**: `fold_patches` over every patch since seq 0 must equal `data` for a
  randomised sequence of `merge`/`inc`/`replace`/`restore` ops. This is the property test that keeps
  the whole design honest.

**Done when:** the CI job that used to prove "the extension loads" now proves the property test, and
the migration set installs on a fresh database in under a second.

### Phase 3 — `@drigodb/data`

Lift the earlier `@oam/data` implementation spec onto the SQL core, with these changes:

- `defineManifest` takes Zod plus storage hints (table above). The manifest serialises to JSON and is
  what the control plane stores and the pipeline consumes; TypeScript types come from Zod as before.
- Repository primitives: `get`, `getMany`, `list`, `create`, `patch(op)`, `restore(seq)`, `delete`
  (tombstone), `hardDelete` (erasure), `history(id)`, `asOf(id, ts)`. `update` is gone: every mutation
  is a patch with an op, so history is complete by construction.
- Filter/aggregate compiler emits SQL against `*_current` views; predicates on promoted columns push
  down; predicates on JSON fields target the base expression exactly as the index defines it. The
  compiler records which fields appear in predicates into a per-process counter the sweeper reads via
  `pg_stat_statements` — no application-side telemetry.
- Write path exactly as in the architecture section, in one transaction; `inc`+`guard` takes
  `FOR UPDATE` first. Redis is optional and cache-aside: `DEL` in an `afterCommit` hook, never
  write-through.
- Deploy-time pipeline (`applyManifest(db, manifest)`): create table pairs and views for new entity
  types; create typed partial expression indexes `CONCURRENTLY`; run promotions as the
  add-column → batched backfill → constraint → index → regenerate-view sequence; record the applied
  manifest version. Runs as a Kubernetes Job under `drigodb_ddl`, never from the app.
- Ships as a public npm package (MIT), versioned independently of the control plane.

**Done when:** a `hello-okr` scaffold app in `examples/` provisions a database through the API,
applies a manifest with one `ref`, one `strict` field and one `inc`+`guard`, exercises a rollback,
and runs one aggregate — and that example is also an integration test.

### Phase 4 — the sweeper

One Deployment per cluster. It lists awake databases by label, connects with a read-mostly role, and
runs on a schedule:

- **Compaction** for `churn: 'high'` types only (fold when `head_seq - snapshot_seq >= threshold`).
- **Index observation:** from `pg_stat_statements` and `pg_stat_user_indexes`, write proposals: "index
  `key_result.data->>'due_date'::date`, seen in 1,240 predicates this week"; "drop
  `ix_okr_kr_owner`, unused for 30 days"; "promote `seats.count` — `inc` op with guard". Proposals are
  rows, surfaced through the API (phase 5); the sweeper never applies DDL.
- **Cleanup:** `INVALID` indexes from failed concurrent builds; patch partitions fully below every
  `snapshot_seq` (only meaningful with a delta window).
- **Rebuild check:** sample 100 entities per table per night and assert fold-equality; alert on drift.

**Done when:** a proposal appears within one sweep of the example app running its list query 20 times.

### Phase 5 — control-plane API additions

```
PUT    /v1/databases/{id}/manifest        { manifest }  → 202; runs the pipeline Job, status to poll
GET    /v1/databases/{id}/manifest        applied version + pending
GET    /v1/databases/{id}/proposals       list
POST   /v1/databases/{id}/proposals/{pid}/apply   → 202; merges the proposal into the manifest and runs the pipeline
GET    /v1/databases/{id}/history?entity=…&id=…   convenience over *_patch, read-only
```

Manifests are stored in the database itself (`_drigodb.manifests`), so Kubernetes stays the source of
truth for topology and the database stays the source of truth for schema. The control plane keeps no
database of its own. "Proposed automatically, applied deliberately" is the governance story: a
proposal is a diff to the manifest, applying it is an authenticated call, and both are recorded.

### Phase 6 — tiers (the thing DocumentDB made impossible)

- **Shared tier (new default):** one CNPG cluster per drigodb installation, a *database* per app
  (`CREATE DATABASE`, not a schema — `pg_dump` per app, separate stats, no cross-app catalog
  visibility). Provisioning drops from ~12 s to sub-second and idle cost per database to ~0.
  Hibernation does not apply; a database in a shared cluster costs nothing idle anyway.
- **Dedicated tier:** the current StatefulSet path, unchanged — its own process, volume, credentials,
  NetworkPolicy, hibernate/wake. `storage-tiers.md` expansion applies here.
- `POST /v1/databases` gains `tier: "shared" | "dedicated"`; migration between tiers is
  `pg_dump | psql` behind a `POST /v1/databases/{id}/tier`, which is the one data migration worth
  building because it moves whole databases with standard tools.
- Backups: `pg_dump` per shared database nightly to object storage; Barman/pgBackRest through CNPG for
  dedicated. Replaces `images/documentdb-backup`.

### Phase 7 — analytics dial

In order, each gated on a measurement rather than a plan:

1. Promoted and generated columns for hot aggregate fields (already in phase 3).
2. `pg_duckdb` in the dedicated-tier image when a dashboard query crosses ~500 ms; verify grants and
   view behaviour under `duckdb.force_execution` in the Testcontainers suite first.
3. A ClickHouse feed from `*_patch` tables via the sweeper (tail by `seq` per table, `ReplacingMergeTree`
   keyed on entity id with `seq` as version) when cross-app analytics or ~10M+ rows per database appear.
   Not PeerDB: it is ELv2, and the patch tables already carry actor and intent.

## Risks and how the plan answers them

| Risk | Answer |
|---|---|
| DDL run by automation on a live database | The sweeper proposes; only the pipeline Job applies; only after an authenticated API call. `CONCURRENTLY` everywhere, backfills batched at 5k rows, and the pipeline detects and drops `INVALID` indexes. |
| Two fold implementations drift | There is one: SQL. TypeScript never folds; the guard path calls the SQL function. The nightly equality check catches a bug in `apply_patch` within a day. |
| Identifier limits (63 bytes) for promoted columns and index names | Deterministic naming with hash suffix, decided in phase 0, tested in phase 2. |
| Index sprawl per table | Hard cap of 10 per entity type in the pipeline; unused-index proposals from the sweeper. Per-app databases mean no cross-app planner cost. |
| Breaking the `connection_uri` contract | 0.x: a `feat!:` commit bumps the minor. There is one consumer and no external users. |
| Losing the "control plane cannot reach Postgres" property | Deliberate. It existed to protect a gateway credential path that no longer exists. The pipeline role can only run DDL through the Job; the API token still never yields a connection string on `GET`. |
| Regret about dropping Mongo-driver compatibility | Out of scope by decision in phase 0. If it ever matters, FerretDB in front of a plain Postgres database is an add-on, not a redesign. |

## Sequencing and size

Rough, for one person on side-project hours; each phase is independently mergeable.

| Phase | Size | Notes |
|---|---|---|
| 0 | 1 evening | README, decisions, delete list. |
| 1 | 1–2 weekends | Mostly deletion. The provisioner change is ~100 lines; the config rewrite is smaller than the file it replaces. |
| 2 | 2 weekends | The property test is the bulk of it and the most valuable code in the repo. |
| 3 | 4–6 weekends | The library. The earlier `@oam/data` spec and its test strategy carry over almost verbatim; the compiler and pipeline are the new work. |
| 4 | 1–2 weekends | Small once phase 2 exists. |
| 5 | 1 weekend | Five routes over existing plumbing. |
| 6 | 2 weekends | The shared tier is the first genuinely new provisioning path since v0.0.1. |
| 7 | measurement-gated | Do not schedule. |

Order matters only at the front: 0 → 1 → 2 → 3. After that, 4/5/6 can interleave with real usage from
the first consumer, which is the point — the dial exists to be turned by observed use, not planned use.
