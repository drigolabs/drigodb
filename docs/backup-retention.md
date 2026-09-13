---
date: 2026-09-13
topic: backup-retention
status: current — describes what the retention policy does and does not cover
related:
  - docs/archive-purge.md
  - docs/restore-in-place.md
  - charts/drigodb/values.yaml
  - src/k8s/provisioner.ts
---

# What the retention policy actually bounds

`backup.retention` is `30d` by default, and both the chart and this README used to
describe it as "how long backups and WAL are kept". That reads as a guarantee that
object storage is bounded. **It is not one**, and the gap is worth understanding
before you size a bucket or a bill.

## How retention is enforced

The barman-cloud plugin does it, and its own code says where from
(`internal/cnpgi/instance/retention.go`, v0.15.0):

```go
if cluster.Status.CurrentPrimary != c.CurrentPodName {
    // "Skipping retention policy enforcement, not the current primary"
    return nil
}
...
DeleteBackupsByPolicy(ctx, &objectStore.Spec.Configuration,
    configuration.ServerName, env, retentionPolicy)
```

Three things follow from those two facts — it runs **in the instance sidecar**, and
only for **that Cluster's current `serverName`**.

## What it covers, and what it does not

| archive | pruned by the policy? | why |
|---|---|---|
| a running database's current prefix | **yes** | the primary is there to enforce it |
| a hibernated database's prefix | not while it sleeps | no pod, so no sidecar. Resumes on wake |
| a **deleted** database's prefix | **never** | there is no Cluster and no pod. Nothing will ever apply the policy — purge it (`docs/archive-purge.md`) |
| an archive generation left by a restore in place | **never** | the Cluster archives to the new prefix, and retention runs only on that one. Purged with the rest when the database is deleted |

## Why a deleted database's archive survives at all

Deliberately. `DELETE` removes a database's `Backup` records and never the bucket
contents, because Barman's retention policy owns the data — that split is what
stops drigodb destroying a customer's backups by removing a Kubernetes object.

The consequence nobody chose is that the thing meant to own the data stops running
the moment the database goes.

## And it is invisible

An orphaned archive has no `Cluster`, no `Backup` objects and no drigodb record of
any kind. `GET /v1/databases/{id}/backups` lists Kubernetes objects, and those went
with the database. What is left is bytes in a bucket that nothing will list,
prune, or mention.

Measured after one test session: **14 prefixes, most belonging to databases that no
longer existed**, plus one `-r1` generation from a single in-place restore. All
inside the 30-day window, so nothing *should* have pruned them — the point is that
nothing ever would.

## This was a missing mechanism, not a chore

That distinction is what got it built rather than written up as an operator
procedure.

`docs/decisions/0008` asks one question of any change: does it say *what* drigodb
can do to a database, or *when* to do it? Removing a database's archive is **what**
— a mechanism, and it was a missing one. Deciding when to sweep orphans is **when**,
and belongs to a policy component outside this repository.

The mechanism is now `POST /v1/archives/{id}/purge`, which clears every generation
an id left behind and reports what it removed. `docs/archive-purge.md` is the record
of how it works and what it deliberately does not do — starting with discovery,
which is still the caller's problem.

### What the invariant forbids, exactly

This was misread once, so it is worth quoting:

> `DELETE` removes a database's `Backup` records and never the bucket contents …
> the split that keeps drigodb from destroying a customer's backups **by deleting a
> Kubernetes object**.

That forbids destroying backups *implicitly*, as a side effect of deleting a
database. It does not forbid an explicit, separately-authorised purge. Different
operations, different blast radii.

### And the credential does not have to move

The control plane holds **no object-storage credential** and has **no S3 client**,
deliberately — and that can stay true. drigodb already *causes* data to be written
to the bucket without holding the credential: it names a Secret and
CloudNativePG's plugin does the reading and writing. A purge can work the same way,
as a Job with that Secret mounted, which is the pattern CloudNativePG's own recovery
Job uses.

The property to preserve is *the control plane holds no bucket credential* — not
*nothing drigodb runs may touch the bucket*.

### One alternative recorded as not taken

**A bucket lifecycle rule** prunes by age whether or not anything is running, which
is right for orphans and **dangerous for live prefixes**: ageing out a base backup
while keeping the WAL that depends on it leaves an archive that cannot be replayed.
A bucket cannot tell a live prefix from an orphan.

## Finding orphans

The purge takes an id. It does not discover which ids are orphaned, and a policy
component that deletes databases already knows — so the gap is only for archives
nobody has a record of, like the 14 measured above.

The prefixes are named after the database, so they are identifiable without
drigodb. What is live is what has a `Cluster`:

```
# Every prefix in the bucket
mc alias set s3 "$ENDPOINT" "$ACCESS_KEY" "$SECRET_KEY"
mc ls s3/<bucket>/

# Every database that still exists
kubectl -n drigodb-databases get clusters -o name
```

A prefix whose `db-<id>` has no `Cluster` is an orphan — **with one exception worth
pausing on**: a `db-<id>-rN` prefix beside a live `db-<id>` Cluster is not
garbage. It is that database's history from before a restore in place, and it is
what makes a pre-restore backup restorable at all (`docs/restore-in-place.md`).
Deleting it is a decision about whether that history is still wanted, not
housekeeping.

Then purge it through the API rather than with `mc`:

```
curl -XPOST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  "$DRIGODB/v1/archives/<id>/purge" -d '{"confirm":"<id>","dry_run":true}'
```

The dry run first, always. It is irreversible, and an id is twelve hex characters —
two of them differ by one character more often than is comfortable. The endpoint
refuses an id that still has a `Cluster`, which is the guard `mc rm` does not have.
