---
date: 2026-09-13
topic: tokens
status: current — describes /v1/tokens and what a token can reach
related:
  - docs/decisions/0009-one-tenant-cannot-reach-another.md
  - docs/diagrams/who-can-reach-what.md
  - src/auth.ts
---

# Tokens, owners, and getting back in

Moved out of the README when that became a landing page. The last section is the one worth
knowing before you need it: an installation with no working token is **locked, not broken**,
and cluster access is enough to recover it.

```
POST   /v1/tokens        { name, tier?, expires_in? }   → 201, the token, once
GET    /v1/tokens        metadata only
DELETE /v1/tokens/{id}   revoke
```

A token is a Kubernetes Secret holding a **SHA-256 hash and never the token**. The raw
value is in the creating response and nowhere else, ever again — the same contract
`connection_uri` has, and for the same reason. drigodb could not show it to you twice
if it wanted to.

`tier` is `admin` or `tenant`, and defaults to **tenant**: a token that does not ask
for the power to issue more does not get it. Only an admin token may call these three
endpoints at all.

`DRIGODB_API_TOKEN` is still what the chart supplies and is now the **bootstrap admin
token** — the pre-existing trust that mints the rest, because to call the API you need
a token and to get a token you call the API. It is listed by `GET /v1/tokens` as
`bootstrap: true` and cannot be revoked through the API: it is the installation's, not
drigodb's. Remove it from the deployment once you have issued your own.

A revoked or expired token stops working within **five seconds** — the authentication
cache's TTL, chosen so that authenticating does not require an API round trip per
request. Written down rather than papered over.

## If you lock yourself out

An installation with no bootstrap token and no issued tokens answers 401 to
everything. It is **locked, not broken**: the pod stays ready and `/healthz` answers
200, which is deliberate, because the recovery below needs the process running.

The only trust left is the one drigodb never had a say in — cluster access. A token is
a Secret, so an administrator can make one:

```bash
TOKEN="$(openssl rand -hex 32)"
kubectl -n drigodb-databases create secret generic token-recovered \
  --from-literal=hash="$(printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1)"
kubectl -n drigodb-databases label secret token-recovered \
  drigodb.io/token-id=recovered drigodb.io/token-tier=admin
echo "$TOKEN"
```

It works within five seconds and can issue tokens normally.
`scripts/install-failure-test.sh` runs exactly this, so it is a procedure that is
executed on every pull request rather than one written down and hoped for.

`owner` is what a token's databases belong to, and defaults to the token's own id — so
"a database belongs to the token that created it" is the behaviour you get without
asking. Pass an existing token's `owner` to **rotate a credential** without its
databases moving; without that, a token expiring would strand everything it owned.

## What a token can reach

A database belongs to an owner, recorded as `drigodb.io/owner` on its Cluster.

- **A tenant token** sees and operates on its own databases only. Everything else is
  **404**, never 403 — a 403 confirms existence, and ids are derived from `external_id`,
  so it would let one tenant test for another's databases.
- **Two tenants may both call a database `main`** and get two databases. The id is
  derived per owner, which matters because the derived id is also the lock that makes
  concurrent creates idempotent.
- **`restore_from` is checked too.** A restored database is a full copy, so the source
  must be reachable by the caller. A source that no longer exists has no owner to
  check, so restoring from a deleted database is admin-only.
- **An admin token** sees every database, including those created before ownership
  existed — they carry no owner label, so no tenant matches them and there is no
  migration to run.
- **`/v1/archives` is admin-only**, both endpoints. An orphaned archive's Cluster is
  gone, so there is nothing left to prove who it belonged to.
- **Admin tokens share one id space**, the historical unsalted one, so every database
  created before this keeps resolving by its `external_id`.

Revoking a token never refuses, because the reason to revoke is usually a leak and a
token protected by the databases it reaches is a token an attacker keeps. Its databases
keep running and become admin-only; the response names them.
