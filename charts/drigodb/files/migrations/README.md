# `config/migrations/`

SQL applied inside every hosted database, in filename order, exactly once each.

`config/bootstrap.sh` runs them: on first start, and on any later start where
the set of files has changed. They are mounted from the `drigodb-migrations`
ConfigMap, so an existing database picks up a new migration on its next wake —
the same route a config change already travels.

## Rules

**Forward-only. Never edit a file that has shipped.** The runner records a
`sha256` per file, and a mismatch on an already-applied migration stops the
server from starting rather than letting the schema diverge from the migration
that claims to describe it. Change something by adding the next number.

That failure is deliberately loud and deliberately fleet-wide, so it has to be
caught before it reaches a cluster. `config/migrations-test.sh` runs the real
`bootstrap.sh` against the real image on every CI run, and asserts exactly this.

**Numbered, zero-padded, three digits.** `001-core.sql`, `002-….sql`. Order is
`LC_ALL=C` filename order, so padding is what keeps 10 after 9.

**Each file runs in one transaction.** A migration that fails leaves nothing
behind. `CREATE INDEX CONCURRENTLY` cannot run in a transaction and so cannot
go here — that belongs to a pipeline that can manage its own failure, not to
pod startup.

**Idempotent where it is free** (`IF NOT EXISTS`, `CREATE OR REPLACE`). The
ledger already guarantees each file runs once, so this is belt-and-braces for
the case where a migration is interrupted between committing and being recorded.

## What is deliberately not here

No `apply_patch`, no `jsonb_merge_patch`, no `fold_patches`, no manifest or
proposal tables. Those belong to the document-framework proposal in
`docs/plans/`, which is a separate bet with its own justification. This is the
mechanism that would deliver them if that bet is ever taken, and is worth having
either way: without it, nothing can change a provisioned database after it is
created.
