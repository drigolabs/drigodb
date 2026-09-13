---
date: 2026-09-13
topic: archive-purge
status: current — describes POST /v1/archives/{id}/purge
related:
  - docs/backup-retention.md
  - docs/restore-in-place.md
  - docs/decisions/0008-mechanism-in-the-core-policy-outside.md
  - charts/drigodb/files/purge-archive.py
---

# Removing an archive that outlived its database

An archive is written under a prefix per database, and retention is enforced by the
running primary — so when a database is deleted, nothing prunes its archive ever
again (`docs/backup-retention.md`). This is the mechanism that removes one.

**Deciding when to remove it is not here.** That is policy, and it belongs to a
component outside this repository (`docs/decisions/0008`). What drigodb owes is an
operation such a component can drive:

```
POST /v1/archives/{id}/purge
{"confirm": "<id>", "dry_run": true}

200
{"id":"a1b2c3d4e5f6","server_name":"db-a1b2c3d4e5f6","dry_run":true,
 "generations":[{"generation":0,"prefix":"db-a1b2c3d4e5f6/","objects":41,"bytes":703594496},
                {"generation":1,"prefix":"db-a1b2c3d4e5f6-r1/","objects":9,"bytes":150994944}],
 "objects":50,"bytes":854589440,"truncated":false}
```

## Only an orphan

The endpoint refuses an id that still has a `Cluster`. That is not a convenience
check, it is the whole safety model: a live database's archive is its backups and
its recovery window, and there is no reason to reach it through this operation.
Purging the *old* generation of a live database — its pre-restore history — is a
different decision and is deliberately not offered here.

`has a Cluster` is the test, not `has a running pod`. A hibernated database has no
pod and its archive is not an orphan.

Confirmation is the id itself, the same shape as `POST /{id}/restore`. Not a
boolean: `{"force": true}` is something a script sets once and forgets, and an id
has to be looked up and cannot be copied between databases by accident. This is
irreversible and there is no second copy.

The id is also checked for *shape*, which no other endpoint has to do. Every other
operation finds a `Cluster` or returns 404, and the id never leaves the control
plane. This one's precondition is that there is no Cluster, so the id goes straight
into an object-storage prefix — and a malformed one is a prefix somebody else's data
is under. It is refused twice: once before a credential is mounted anywhere, and
again by the script from inside the pod.

## What it runs, and what it does not hold

drigodb has no object-storage credential and no S3 client, and it keeps neither. A
purge runs as a **Job** in the database namespace with the Secret the ObjectStore
names mounted into the pod — the same pattern CloudNativePG's own recovery Job uses,
and the same way drigodb already *causes* data to be written to that bucket without
holding the credential. The control plane passes a reference it cannot resolve.

The bucket is read from the **ObjectStore**, not from the API's own environment.
`destinationPath`, `endpointURL` and the *names* of the Secret keys, over a `get`
this Role did not previously have. The alternative was copying bucket and endpoint
into the API's environment, which gives one bucket two declarations that can
disagree — and this repository has already had a pin rot at 0.0.1 for seven
releases because nothing read it. A second copy of the destination path is that
failure with a customer's backups behind it.

## It is not barman-cloud-backup-delete, and that was the surprise

The obvious plan was the CLI that already exists in the sidecar image and already
has a `--dry-run`. **It cannot empty an archive.** From
`barman/clients/cloud_backup_delete.py` in the pinned image:

```python
if next_backup:
    remove_until = next_backup
else:
    remove_until = deleted_backup
...
if xlog.is_history_file(wal_name):
    continue
...
if wal_name < remove_until.begin_wal:
    wals_to_delete[wal_name] = wal
```

Delete every backup and the last one has no successor, so `remove_until` is the
backup being deleted and only WAL *before* its `begin_wal` goes. Every segment
archived from the last backup onwards survives, and so does every `.history` file,
unconditionally. For a database that was archiving right up to the moment it was
deleted, that is the newest and largest part of the archive — precisely the
accumulation this exists to end.

What empties a prefix is `delete_under_prefix`, which barman implements and exposes
to no CLI. So the Job runs a program of ours on that image — for barman's S3 code,
not its command line. `charts/drigodb/files/purge-archive.py`, shipped as a
ConfigMap the chart renders from the file, mounted into the Job. A real reviewable
file rather than a heredoc inside TypeScript, because the thing holding delete
rights on a customer's bucket is the wrong place for a string literal.

Still barman's deletion, though, and that matters for one specific reason:
`delete_under_prefix` refuses a prefix that is empty, `/`, or not slash-terminated,
and it falls back to deleting one object at a time when an S3-compatible store
rejects a bulk delete for a missing `Content-MD5`. DigitalOcean Spaces — the store
this was built against — is one of those. Reimplementing it on raw boto3 would be
reimplementing the bug reports too.

The image is a pin, not a dependency: every installation with backups already pulls
`plugin-barman-cloud-sidecar`. It has python3 and barman and **no shell**, so the
Job's command is the interpreter and the mounted path, and could not be a shell
one-liner even if it wanted to be.

## Every generation, and never stopping at the first empty one

After a database is deleted, **drigodb does not know how many archive generations it
had.** The generation lives as an annotation on the Cluster, and the Cluster is
gone. `db-<id>`, `db-<id>-r1`, `db-<id>-r2` … are separate prefixes, and a database
restored in place twice has three.

So the script probes generation 0 up to a bound and removes every one it finds
something under. One call clears everything for an id, which is what a policy
component wants — it should not have to know how many times a database was restored.

The first design stopped at the first empty generation, relying on generations being
contiguous. **That is wrong, and not because the contiguity argument is wrong.** A
purge that fails part way through leaves holes, and the retry — which is a caller
re-POSTing the same id — would find generation 0 gone, conclude the archive is
clean, and leak exactly the generations the retry existed to collect. Scanning all
of them costs one `list_objects_v2` per generation and removes the assumption
entirely. Verified against MinIO with generations 0, 1 and 3 and no 2: all three
were found and removed, and a neighbouring database's prefix was untouched.

The bound is `backup.purgeMaxGenerations`, 20 by default, because the alternative is
an unbounded loop against object storage. A purge that reaches it with objects still
under the last generation reports `truncated: true` rather than a clean sweep, and
the caller's move is to run again.

Recording the count in control-plane state that outlives the Cluster — a ConfigMap
drigodb maintains — was the other option. Rejected: Kubernetes is the source of
truth and there is no control-plane database, and an exact count is a bad thing to
buy that with when it is derivable.

## Why it waits, where a restore does not

`POST /{id}/restore` returns 202 and a caller polls. This returns 200 with what it
removed, because a purge is list calls and a batch delete per thousand objects —
seconds, not the minutes a recovery takes — and because **there is no database left
to poll.** A job id the caller has to come back for would make reclaiming storage a
two-step conversation with nothing to have the second half of it with.

The number is also the answer: a caller purging to reclaim storage wants to know how
much came back, per generation as well as in total. "One prefix held all of it" and
"this database was restored four times" are different facts about a bucket, and the
second is the one that explains the bill.

The ceiling is five minutes, on both the Job's `activeDeadlineSeconds` and the
request — deliberately the same number, because a request that gave up while the Job
ran on would report a failure that was not one. If a purge ever stops being seconds,
the shape to move to is 202 plus a `GET` on the Job, not a longer wait.

`backoffLimit` is 0. Above zero the Job retries behind a pod that has already been
replaced, and the endpoint answers by reading one pod's log — it would then report on
an attempt that is not the one that ran. Retrying is a caller POSTing again, which is
safe: emptying a prefix that is already partly empty is the same operation.

## A dry run, because this is the only way to see a prefix at all

`dry_run: true` lists and counts without deleting. Worth having on its own for an
irreversible operation, and it is also the only way a caller can learn what is in a
prefix: drigodb does not list buckets, and after the database is deleted there are no
`Backup` objects left to read either.

## What this does not do

- **Discover orphans.** A policy component that deletes databases knows their ids,
  which is enough to drive this. Finding archives nobody has a record of — the 14
  already in the bucket — needs either bucket listing or control-plane state, and it
  is not on the critical path for the mechanism.
- **Remove an old generation of a live database.** See above.
- **Decide when.** No sweeper, no schedule.
