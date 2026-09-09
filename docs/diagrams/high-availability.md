---
date: 2026-09-09
topic: high-availability
status: built — `high_availability: true` on create
related:
  - docs/decisions/0004-cloudnativepg-for-the-data-plane.md
  - docs/decisions/0001-instance-per-database-over-a-shared-cluster.md
  - src/k8s/manifests.ts
  - scripts/smoke.sh
---

# A database with a standby

**Opt-in, per database, at create only.** A database asked for with
`high_availability: true` gets a second instance, commits wait for it, and the
loss of the primary does not change the address the consumer stored.

[Decision 0004](../decisions/0004-cloudnativepg-for-the-data-plane.md) chose
opt-in; [0001](../decisions/0001-instance-per-database-over-a-shared-cluster.md)
is why it matters — a standby doubles a database's pods and volumes, and nodes
run out of both.

Two things carry the whole design and neither is new. **drigodb's Service selects
the primary by label** rather than naming a pod, and **the NetworkPolicy has
always admitted instance-to-instance traffic**. Both were written that way before
there was anything to fail over, with comments saying so.

## 1. Creating one

```mermaid
sequenceDiagram
    autonumber
    actor C as Consumer
    participant API as drigodb API
    participant K8s as Kubernetes
    participant CNPG as CloudNativePG
    participant P as Primary
    participant S as Standby

    C->>API: POST /v1/databases<br/>{ external_id, high_availability: true }
    API->>K8s: create Secret (the credential)
    API->>K8s: create Cluster<br/>instances: 2, postgresql.synchronous
    Note right of API: The Cluster's NAME is the lock.<br/>Kubernetes refuses a second object with<br/>the same name, which is the whole of<br/>idempotent create.
    API->>K8s: create Service — selector instanceRole=primary
    API->>K8s: create NetworkPolicy
    API-->>C: 202 + connection_uri

    CNPG->>P: initdb, start
    P-->>CNPG: ready
    Note over API,P: status becomes `ready` here.<br/>The database SERVES as soon as the primary<br/>does. The standby arrives after, and until<br/>it does the database is up and unprotected.

    CNPG->>S: pg_basebackup from the primary
    S->>P: streaming replication connection
    Note over P,S: Admitted by the NetworkPolicy rule for<br/>pods carrying this database's id — present<br/>since the policy was written.
    S-->>CNPG: ready
    CNPG->>P: synchronous_standby_names = ANY 1 (...)

    C->>API: GET /v1/databases/{id}
    API-->>C: high_availability: true, standby: "ready"
```

`standby` is counted from ready instance pods, not from `status.readyInstances`,
which CloudNativePG does not zero on hibernation.

## 2. A commit, once both are up

```mermaid
sequenceDiagram
    autonumber
    actor App as Application
    participant Svc as Service (db-id)
    participant P as Primary
    participant S as Standby

    App->>Svc: connect (URI as issued)
    Svc->>P: routed by instanceRole=primary
    App->>P: INSERT ...
    App->>P: COMMIT
    P->>P: write WAL locally
    P->>S: stream WAL
    S->>S: flush WAL to disk
    S-->>P: acknowledged (flushed)
    P-->>App: COMMIT returns
    Note over P,S: FLUSHED, not applied. The standby holds the<br/>WAL durably but has not necessarily replayed<br/>it into its data files. Enough for the promise<br/>below, and the reason the two servers are not<br/>byte-identical at any instant.
```

`synchronous_commit` is left at PostgreSQL's default `on`, which is what "flushed,
not applied" means. `remote_apply` would close the gap and cost a replay round
trip on every commit; it buys nothing while nothing reads a standby.

## 3. The primary dies

```mermaid
sequenceDiagram
    autonumber
    actor App as Application
    participant Svc as Service (db-id)
    participant CNPG as CloudNativePG
    participant P as Primary (dying)
    participant S as Standby

    P--xCNPG: gone
    App->>Svc: connect
    Svc--xApp: no endpoint — the label selects nothing
    Note over Svc,App: The outage is here, and it is short.<br/>Measured on kind: 14s from kill to serving.

    CNPG->>S: promote
    S->>S: replay every WAL record it holds
    Note right of S: Nothing is lost, because a commit did not<br/>return until this WAL was on this disk.
    CNPG->>S: label instanceRole=primary
    Svc->>S: now selected

    P->>P: restarts, sees it is no longer primary
    P->>S: rejoins as the standby
    Note over P,S: Nobody asked for this. instances is desired<br/>state and CloudNativePG converges on it, so<br/>the pair heals itself and the promoted<br/>standby simply stays primary. No failback.

    App->>Svc: connect (SAME URI, unchanged)
    Svc->>S: routed
    App->>S: SELECT — the committed row is there
    Note over App,S: No new address is issued. The URI names a<br/>Service, the Service selects a role, and<br/>failover moves the role.
```

## 4. When the standby is the one that dies

```mermaid
sequenceDiagram
    autonumber
    actor App as Application
    participant API as drigodb API
    participant CNPG as CloudNativePG
    participant P as Primary
    participant S as Standby (dying)

    S--xCNPG: gone
    CNPG->>P: shrink synchronous_standby_names
    Note right of CNPG: dataDurability `preferred`. Under `required`<br/>the next COMMIT would block until a standby<br/>came back — turning on high availability<br/>would make a database LESS available.

    App->>P: COMMIT
    P-->>App: returns without waiting for anyone
    Note over App,P: The window with no second copy.<br/>If the primary dies now, these writes go.

    App->>API: GET /v1/databases/{id}
    API-->>App: status: "ready", standby: "unavailable"
    Note over API,App: Serving and unprotected, reported as two<br/>fields rather than one that has to mean both.
```

## What each state is called

| `status` | `high_availability` | `standby` | What is true |
|---|---|---|---|
| `provisioning` | `true` | absent | no instance ready yet |
| `ready` | `true` | `unavailable` | serving on one instance; commits are not waiting for anyone |
| `ready` | `true` | `ready` | serving, and every commit is on two disks |
| `hibernated` | `true` | absent | switched off on purpose — not a fault, and deliberately not reported as one |
| `ready` | `false` | absent | one instance, and that is what was asked for |

## What this does not give you

- **Zero downtime.** Failover is fast, not instant, and in-flight connections are
  dropped. A client that does not reconnect sees an error — what survives is the
  address and the data, not the socket. Anything with a pool and retries rides
  through it.
- **Anything for the caller to do afterwards.** That is not a gap, it is the
  point: a failed instance is replaced by CloudNativePG rather than by whoever
  noticed. `standby: "unavailable"` is information, not a task.
- **A read replica.** The endpoint selects the primary, so the standby serves no
  traffic. It is redundancy, not capacity.
- **Durability while degraded.** Section 4 is the hole, and it is deliberate:
  the alternative refuses writes whenever one pod is missing.
- **Turning it on later.** A repeat create returns the existing database and does
  not act on the flag. Adding a standby to a live database is a different
  operation with its own failure modes and is not built.
