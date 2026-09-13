---
date: 2026-09-13
topic: measurements
status: current — every figure here was taken on a cluster, and says which
related:
  - docs/storage-tiers.md
  - scripts/measure.sh
---

# What it actually costs

Numbers, with the cluster they came from. Moved out of the README when that became a
landing page rather than a reference — a figure nobody can date is a figure nobody
should quote, so each one says where and when.

Retake them with [`scripts/measure.sh`](../scripts/measure.sh) rather than by hand. Every
figure here was once a single observation, and this table has already been wrong by 3.5×.

Taken on DigitalOcean 2026-09-05, against the plain-PostgreSQL data plane, with
[`scripts/measure.sh`](../scripts/measure.sh) — a script rather than a list of commands because every
figure here was previously a single observation, and a table that has already been wrong once by 3.5×
should be cheap to take again.

Cluster: 1× `s-1vcpu-2gb` in `fra1`, which is what `doks-up.sh` creates.

| | warm cache, single node | DigitalOcean, `s-1vcpu-2gb` |
|---|---|---|
| Provision from nothing | ~12s | **19–20s** warm (n=2), **45s** on a node that has never pulled the image |
| Wake from hibernation | ~8s | **9–11s** (n=2) |
| Hibernated | 0 pods; storage only | same |

Storage, freshly provisioned:

| | |
|---|---|
| A freshly provisioned database | **64 MB** |
| — catalogs | 31 MB (one extension, `plpgsql`) |
| — write-ahead log | 33 MB |
| One ~200-byte row | **308 bytes** at 20k, **318** at 100k |
| Default volume | 1Gi, so roughly **3 million rows** once WAL is bounded |

Leaving DocumentDB took 73 MB to 64 MB. The saving is the catalog term alone — PostGIS and the
extension's own catalogs — because the 33 MB write-ahead log floor is set by `min_wal_size` and does not
care which extension is installed. The migration plan predicted ~40 MB; that was too optimistic, and
this is the corrected figure.

Active memory, three samples, all identical:

| | |
|---|---|
| Resident set size, summed over the container's processes | **102 MiB** |
| Proportional set size, the same pages divided by their sharers | **30 MiB** |
| cgroup `memory.current` | 153 MiB |

Those are three different quantities and the difference is the point. `memory.current` includes page
cache, which is why the earlier attempt at this table refused to substitute it. Summed RSS
double-counts PostgreSQL's shared buffers across its processes. PSS divides shared pages by the number
of processes mapping them, and is the only one of the three that answers "what does this instance
actually cost". The container's true footprint is between the two: 102 MiB is what it holds resident,
30 MiB is what is not shared with itself.

The volume is deliberately at the small end. A PVC can be expanded in place and can never be
shrunk, and a StatefulSet's `volumeClaimTemplates` is immutable — so the default is permanent for
every database created under it. Too small is a patch; too large is forever.

`config/postgresql.conf` caps `max_wal_size` at 256MB for the same reason. Left at the PostgreSQL
default of 1GB, the write-ahead log alone can claim more than a 1Gi volume before a single row is
stored.

**Volume expansion is online.** Patching a PVC from 1Gi to 2Gi grew the filesystem from 974M to 2.0G
with the database still running, no restart, and no `FileSystemResizePending` condition — so a resize
is invisible to a tenant rather than costing them a pod cycle. That settles the open question in
[storage-tiers.md](storage-tiers.md), and it is why a resize costs a tenant nothing for the
volume itself.

**Growing a database is expansion in place, not a migration.** `POST /v1/databases/{id}/resize` takes a
tier — `small` 1Gi, `medium` 5Gi, `large` 20Gi — grows the volume and raises `max_wal_size` to match.
It does **not** cycle the pod: CloudNativePG expands the volume and decides for itself whether the
parameter needs a restart, and doing it by hand would race the thing already doing it. Measured on
DigitalOcean: 1Gi to 5Gi in 42 seconds with the database serving throughout. Volumes never shrink, so a
tier only goes up, and `DRIGODB_MAX_TIER` is the ceiling an owner is granted automatically within.

The volume grows **before** the WAL ceiling rises, and that order is load-bearing rather than tidy:
raising `max_wal_size` on a volume that has not grown is how PostgreSQL fills its disk, and a full disk
is a PANIC rather than a slowdown. There is no transaction across the two, so the order is also what
makes a partial failure survivable — it leaves a larger volume running the old ceiling, which is merely
wasteful.

Growing needs a StorageClass with `allowVolumeExpansion: true`. Without one the API returns a `409`
naming the class, which is what a laptop gets: kind's `local-path` cannot expand. drigodb checks that
**before** patching anything, because expansion is asynchronous — the patch would be accepted, the
response would carry the new tier, and the volume would silently stay the size it was.

### How many databases fit on a node

Two, on this one — and the limit is not what was expected.

| | |
|---|---|
| Node allocatable | 1500 MiB memory, 920m CPU |
| Requested with 2 databases + the control plane | 1222 MiB (83%), 762m CPU (82%) |
| A third database | **would not schedule** — `Insufficient memory` |
| Block volumes attachable per node (`dobs.csi.digitalocean.com`) | **15** |

The volume ceiling is real but far away; memory requests bind first, by a wide margin. And the request
is what binds, not the usage: a database *requests* 256Mi and *holds* 102 MiB, so the scheduler
reserves roughly 2.5× what an idle database uses.

**A hibernated database is not a reservation.** Waking one on a full node can fail: its memory was
returned when it hibernated, and databases provisioned since may hold it. That happened during this
measurement run and is why the wake figure is n=2 rather than n=3.

Compute therefore tracks *concurrent* databases, not total ones. Storage tracks total, at the
provisioned volume size each — that is the term that grows with signups.
