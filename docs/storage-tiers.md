---
date: 2026-09-01
status: draft
related:
  - docs/service-boundary.md
  - README.md
---

# Storage tiers and growth

**Status:** design, not built. The sizing it rests on is measured; the growth mechanism is not yet
implemented. It answers the open question `docs/service-boundary.md` leaves under *Tiers* — "currently
one fixed shape: 2Gi, single instance" — for the storage axis only. Vertical CPU and memory resize,
and connection pooling, are not in scope here.

## What we know, measured

On DigitalOcean, 2026-09-01, `s-2vcpu-4gb`:

| | |
|---|---|
| A freshly provisioned database | 73 MB |
| — catalogs and extensions | 41 MB, of which PostGIS is 7.1 MB |
| — write-ahead log | 33 MB |
| One ~220-byte document | 365 bytes, consistent at 20k and 100k |

The 365 bytes is the number that makes a tier meaningful: a tier is best stated in documents, because
that is the unit an app owner thinks in.

## Why growth is expansion, not migration

The obvious reading of "move a database to a bigger tier" is that it moves — a new pod, a new volume,
the data copied across. It should not, and it does not need to.

`do-block-storage` sets `allowVolumeExpansion: true`. Growing a database is a patch to one field of
one PVC; the CSI driver resizes the DigitalOcean volume and then the filesystem. Nothing is copied,
and the time it takes does not depend on how much data is in there.

Migration would mean downtime proportional to the dataset, a window in which two copies exist and
writes can be lost, and a rollback story for when the copy fails — all to achieve what a patch
achieves. The only operation that would genuinely require it is *shrinking*, which block storage does
not support and which this service should therefore not offer.

## The asymmetry that sets the default

A PVC can be expanded and can never be shrunk. A StatefulSet's `volumeClaimTemplates` is immutable —
the API server rejects a patch to it outright, naming the only fields that may change: `replicas`,
`ordinals`, `template`, `updateStrategy`, `revisionHistoryLimit`,
`persistentVolumeClaimRetentionPolicy`, `minReadySeconds`.

So the default volume size is permanent for every database created under it, and the mistake is only
recoverable in one direction. That is why the default is 1Gi rather than something roomier: too small
is a patch, too large is forever.

## Tiers

| tier | volume | `max_wal_size` | usable | ~documents |
|---|---|---|---|---|
| small (default) | 1Gi | 256MB | ~724 MB | ~2 M |
| medium | 5Gi | 1GB | ~4.0 GB | ~11 M |
| large | 20Gi | 2GB | ~18.0 GB | ~50 M |

Usable is the volume less the 41 MB floor and the WAL ceiling. WAL is held between 10% and 25% of the
volume: high enough that a busy database is not checkpointing constantly, low enough that it cannot
claim the disk.

`max_wal_size` scales with the tier for performance, not correctness. It is a checkpoint trigger, not
a cap on database size — a 20Gi database runs correctly with `max_wal_size = 256MB`, it simply
checkpoints far more often than it should, which costs full-page writes and I/O.

## Where a per-database setting can live

`drigodb-config` is one ConfigMap mounted by every database, so it cannot carry a per-tier
`max_wal_size`. Three places a per-database value could go:

| | |
|---|---|
| A ConfigMap per database | Another object per database to create, update and garbage-collect |
| `ALTER SYSTEM SET` | Puts the control plane on a PostgreSQL connection to every database, needing each one's credentials — the thing the isolation model exists to avoid |
| **An env var on the pod template** | `spec.template` is mutable, it is already what the wake reconcile rewrites, and `bootstrap.sh` already runs on every start |

The third. `bootstrap.sh` writes `DRIGODB_MAX_WAL_SIZE` into an include file inside PGDATA, ordered
after the mounted config so it wins. Existing databases need the include line added on the restart
path as well as at init, since theirs was written before this existed.

## The operation

```
POST /v1/databases/{id}/resize   { "tier": "medium" }

  1. reject if the target is smaller than current      volumes do not shrink
  2. reject if the target exceeds the configured max   this is the approval
  3. patch the PVC             data-db-<id>-0 → 5Gi
  4. patch the pod template    DRIGODB_MAX_WAL_SIZE → 1GB
  5. label the StatefulSet     drigodb.io/tier=medium
  6. cycle the pod             hibernate, then wake
```

**Owner-initiated, automatically approved.** There is no human in the loop: an app owner asks through
the API and is granted, provided the target is a real tier no larger than the configured ceiling. The
ceiling is what stops one app quietly becoming the whole storage bill. Nothing here watches usage and
grows on its own — see *Not in scope*.

**The order matters.** The volume grows before `max_wal_size` rises. Raising the WAL ceiling on a
volume that has not grown yet is a way to fill the disk.

Step 6 does three jobs at once, which is the reason this design costs so little: it completes the
filesystem resize if DigitalOcean's expansion turns out to be offline, it re-runs `bootstrap.sh` so
the new WAL setting is read, and it goes through the reconcile-on-wake path that already exists and is
already tested. The measured cost is one wake — 18s.

## Consequences to hold

**The StatefulSet's template will lie.** After a resize the PVC says 5Gi and `volumeClaimTemplates`
still says 1Gi, permanently, because it cannot be changed. The live PVC is the truth. The tier label
in step 5 is what lets `GET /v1/databases/{id}` report a size without reading PVCs, and what a future
recreate would have to consult — nothing recreates a StatefulSet today, and this is a reason to keep
it that way.

**Whether expansion is online is unverified.** `allowVolumeExpansion: true` says a volume *can* grow;
it does not say the filesystem grows while mounted. If DigitalOcean's CSI driver only expands offline,
the pod must restart to finish — which step 6 does anyway. Worth confirming on the next cluster, since
it decides whether step 6 is required or merely convenient.

**A tier is a floor, not a quota.** Nothing stops a database filling its volume, and the failure when
it does is PostgreSQL PANICking on ENOSPC and refusing to restart until space is freed. Growth being
available is not the same as growth happening. A database at 95% of its volume with no one watching is
the failure this design does not address.

## Not in scope

- **Automatic growth.** Detecting that a database is nearly full needs a usage source, and there is no
  good one: metrics-server does not report PVC usage, the kubelet summary API needs `nodes/proxy`
  cluster-wide, and asking PostgreSQL directly puts the control plane on a connection to every
  database. That is its own project, and the permission question is the hard half of it.
- **Shrinking.** Block storage does not support it.
- **CPU and memory tiers.** The same `spec.template` seam would carry them, but resource limits and
  storage have different failure modes and deserve separate thought.
- **Billing.** A tier that costs the same as any other is not a tier, it is a setting.
