---
date: 2026-09-13
status: decided
topic: security
related:
  - docs/decisions/0005-an-http-api-not-a-crd.md
  - docs/decisions/0008-mechanism-in-the-core-policy-outside.md
  - docs/diagrams/who-can-reach-what.md
---

# One tenant cannot reach another

**Decision: a token is a Kubernetes Secret holding a hash, a database belongs to an
owner a token carries, and a database's id is derived from that owner as well as its
`external_id`.** Two tenants may both call a database `main`. Neither can see, reach or
restore from the other's.

Two issues, one decision: [#62](https://github.com/drigolabs/drigodb/issues/62) gave a
credential an identity, and [#72](https://github.com/drigolabs/drigodb/issues/72) made a
database belong to one. Neither is coherent alone — ownership needs something to name,
and identity with nothing scoped to it is bookkeeping.

## What prompted it

drigodb was carefully multi-tenant in the data plane and single-tenant in the control
plane. A database got its own PostgreSQL process ([0001](0001-instance-per-database-over-a-shared-cluster.md)),
its own role, and its own NetworkPolicy — three layers protecting the data — while one
static bearer token could list, resize and delete every database in the installation.

That was tolerable while the operator and the only consumer were the same organisation.
[0002](0002-gitops-for-the-control-plane.md) commits to drigodb being something other
people install, which is the point at which it stops being tolerable.

Then building it turned up something worse than the missing check.

**The derived id was the lock.** `create` is idempotent because Kubernetes refuses a
second Cluster with the same name, and the name is `db-<sha256(external_id)>`. So two
tenants calling their database `main` derived one id, the second took the idempotent
path, and **was handed the first one's database and its connection URI.** Not an error —
one tenant reading another's data, quietly, through the documented API.

## The decisions, and what was rejected

### Storing a token

**Decided: one Secret per token in the database namespace, holding a SHA-256 hash.**

| Alternative | Why not |
|---|---|
| Keep the static environment token | No identity, no expiry, no revocation, no rotation without an outage. It is also what forced the chart to generate a token, which is what made the chart render differently on every pass ([#63](https://github.com/drigolabs/drigodb/issues/63)) |
| A control-plane database | There isn't one, and adding one for this would be the largest change in the project to date. Kubernetes is the source of truth; a token is its Secret the way a database is its Cluster |
| Secrets in the release namespace | Cleaner conceptually — control-plane credentials beside the control plane — but it needs a second Role granting `secrets` in `drigodb-system`, which widens what a compromised API pod reaches. The database namespace needed **no RBAC change at all** |
| Store the token, not a hash | drigodb can already list Secrets in that namespace. Stored raw, anything able to read one Secret would hold every credential to the control plane rather than one |

The trade taken: control-plane auth material sits in the blast radius of provisioned
databases. What sits there is a hash, which is not a credential, and the invariant that
drigodb cannot read a Secret anywhere else in the cluster survives untouched.

### Knowing a token is still valid

**Decided: a five-second cache over a labelled list.**

| Alternative | Why not |
|---|---|
| An API call per request | Every authenticated call then depends on the API server being reachable. An availability problem waiting for a bad afternoon |
| A watch on labelled Secrets | Revokes instantly, and **silently stops updating when it dies**. An auth path that has quietly stopped learning about revocations is worse than one with a window this short and written down |
| A longer cache | The window is how long a leaked token keeps working after someone notices |

The trade taken: **a revoked token works for up to five seconds.** Documented in the
README as a property. A caller that revokes sees its own change immediately; the window
is for revocations made elsewhere.

### Deriving a database's id

**Decided: `sha256(owner + NUL + external_id)` for a tenant, `sha256(external_id)` for an
admin.**

| Alternative | Why not |
|---|---|
| Leave the derivation alone, scope by lookup | The Cluster **name** would still collide, so two tenants could not both have `main` at all |
| Random ids with idempotency by label | Removes the lock. Two concurrent creates of one `external_id` both succeed and one application is split in half — the bug [#76](https://github.com/drigolabs/drigodb/issues/76) fixed |
| Salt every owner uniformly | A Cluster's name cannot be rewritten. Every database created before this becomes unreachable by the only name its consumer knows, and the next `POST` builds a duplicate beside it |
| Salt uniformly, plus a legacy lookup for unowned databases | Works, and reintroduces a lookup-then-create path — the exact shape #76 found — on a branch that never goes away |

The trade taken: **all admin tokens share one id space**, the historical unsalted one.
Two admins creating `main` get the same database. That is consistent with admins seeing
every database anyway, and the unsalted space is not an exception invented for
convenience — every database that predates this was created by the installation's static
token, which is now the bootstrap admin. It is the record of who actually made them.

### What an owner is

**Decided: an owner is a value a token carries, defaulting to the token's own id.**

This is a deliberate deviation from #72, which says "a database belongs to the **token**
that created it". #72 predates #62 giving tokens an expiry, and together they strand a
consumer that does the responsible thing: rotate the credential, get a new token id, and
every database it owned becomes unreachable by the only name it knows.

| Alternative | Why not |
|---|---|
| Owner *is* the token id, as #72 says | Rotation orphans everything. A footgun aimed at the one consumer drigodb has |
| A first-class `tenants` resource | The right long-term model and a much larger feature. Two tokens sharing an owner string gets the property for one optional field |
| Transferable ownership | Also wanted, and not this. [#142](https://github.com/drigolabs/drigodb/issues/142) |

### Refusing an operation

**Decided: 404 for a database the caller may not reach. 403 for archives.**

A 403 confirms the database exists. Ids are derived from `external_id`, and an admin's
are derived from it *alone*, so `openvoid-app-01JQ` is a guess away — a 403 would let one
tenant test for another's databases. There is no reason to leak the id space.

Archives are the exception and get a 403, because there is no id to protect in "you are
not an administrator".

### Who may read an archive

**Decided: admin only, both endpoints.**

An orphaned archive's Cluster is gone, so there is no owner label to check and a prefix
name is a hash that cannot be turned back into an owner. A tenant cannot be shown
archives it cannot be proven to own, and certainly cannot purge one it might not.

Reclaiming storage across a fleet is an operator's job, which is also the honest reading
of [0008](0008-mechanism-in-the-core-policy-outside.md): the policy component driving a
purge is part of the installation, not one of its consumers.

### Revoking a token that owns databases

**Decided: revoke, never refuse, and report what was orphaned.**

| Alternative | Why not |
|---|---|
| Refuse while it owns databases | The reason to revoke is usually a leak. A token protected by the databases it can reach is a token an attacker keeps |
| Cascade delete | Destroys data on a credential operation |
| Revoke silently | The databases keep running and keep costing money with nothing pointing at them |

The databases become admin-visible for free — no tenant matches an owner naming a token
that is gone — so the only work is saying so. `DELETE /v1/tokens/{id}` returns the ids.

## Is it enough

Three independent barriers stand between a tenant and another's database by way of a
colliding id, and the third is the one that matters because the first two can be
reasoned about wrongly:

1. **The salt.** An accidental collision between two owners needs 2^48 databases.
2. **The `external_id` collision guard.** A derived-id match whose `external_id` differs
   is refused, which is the shape a brute-forced collision takes.
3. **The ownership check.** Even with both passed, the Cluster's owner label does not
   name the caller, and the answer is 404.

Barrier 1 is worth being honest about: **48 bits is not cryptographically out of reach
offline.** An attacker can search `external_id`s *of their own* until one derives a
victim's id. What they cannot do is make their own *owner* collide, and that is what
barrier 3 checks. A test plants a Cluster at exactly the colliding id, owned by someone
else and carrying the same `external_id` so barrier 2 cannot fire, and asserts the
answer is 404.

**What this does not protect.** Nothing here changes the network layer. A tenant that
learns a database id and can label a pod in the same Kubernetes cluster can reach that
database's port — and then needs the password, which it does not have. That is
pre-existing, and it is the third of the data-plane's layers rather than a gap in this
one.

## The enforcement is the type system

Every `Provisioner` method that names a database **requires** a `Caller`, so a handler
that forgets does not compile. #72's table is twelve endpoints long, and "remember the
check in each one" is a plan that works until the thirteenth. Making the change produced
66 compile errors, all of them call sites, which is what made it auditable rather than
hopeful.

## Consequences

- A fourth isolation layer, and the README can describe it honestly.
- Existing installations are unaffected: the chart's token is now a bootstrap admin
  credential, and admin ids are unchanged.
- Databases created before this carry no owner label and are admin-only. **There is no
  migration**, which is the decision rather than an omission — there is nobody to
  attribute them to, and an operator with tenants predating this must reassign by hand.
  There is no endpoint for that yet ([#142](https://github.com/drigolabs/drigodb/issues/142)).
- `idFor` carries a permanent branch on tier. It is the historical record, and it does
  not go away.
- Nothing tests more than one API replica. Each holds its own cache, so revocation stays
  bounded by the same five seconds, but that is reasoning rather than measurement.
