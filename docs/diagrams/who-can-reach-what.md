---
date: 2026-09-13
topic: diagrams
status: current — draws what decision 0009 decided
related:
  - docs/decisions/0009-one-tenant-cannot-reach-another.md
---

# Who can reach what

Three drawings of decision [0009](../decisions/0009-one-tenant-cannot-reach-another.md).
The first is a token becoming a credential, the second is the case the whole design
exists for, and the third is the one that reads data rather than metadata.

## A token is issued, and then used

The raw token exists in one response and nowhere else. What is stored is a hash, so
drigodb could not show it to you twice if it wanted to.

```mermaid
sequenceDiagram
    autonumber
    participant Op as Operator
    participant API as drigodb API
    participant TS as TokenStore
    participant K8s as Kubernetes

    Op->>API: POST /v1/tokens {name}
    Note over API: bootstrap admin token in the header
    API->>TS: issue(name, tenant, owner defaults to the new id)
    TS->>TS: token equals ddb_ plus 32 random bytes
    TS->>K8s: create Secret token-<id> with sha256(token)
    TS-->>API: id, owner, tier
    API-->>Op: 201 with the token, once and never again

    Note over Op,K8s: later, on every request
    Op->>API: GET /v1/databases with Bearer ddb_...
    API->>TS: callerFor(presented)
    TS->>TS: hash the presented value
    alt cache older than five seconds
        TS->>K8s: list Secrets labelled drigodb.io/token-id
        K8s-->>TS: hashes, owners, tiers, expiries
    end
    TS-->>API: caller with id, owner and tier
    API->>K8s: list Clusters where owner equals caller.owner
    K8s-->>API: that tenant's databases only
    API-->>Op: 200
```

## Two tenants, both calling it `main`

The id is derived from the owner as well as the `external_id`, so the Cluster names
differ and the lock that makes `create` idempotent still holds for each of them
separately.

```mermaid
sequenceDiagram
    autonumber
    participant A as Tenant A
    participant B as Tenant B
    participant API as drigodb API
    participant K8s as Kubernetes

    A->>API: POST /v1/databases {external_id main}
    API->>API: id equals sha256(ownerA + NUL + main)
    API->>K8s: create Cluster db-8169... labelled owner ownerA
    API-->>A: 202 with a connection URI

    B->>API: POST /v1/databases {external_id main}
    API->>API: id equals sha256(ownerB + NUL + main)
    API->>K8s: create Cluster db-3f0c... labelled owner ownerB
    Note over API,K8s: a different name, so no conflict and no shared volume
    API-->>B: 202 with a DIFFERENT connection URI

    B->>API: GET /v1/databases/8169... which is A's
    API->>K8s: get Cluster db-8169...
    K8s-->>API: owner is ownerA
    API-->>B: 404, the same answer an absent database gives
```

Before this the second `POST` derived the **same** id, found A's Cluster, took the
idempotent path, and returned A's database with A's connection URI.

## Restoring from a database, which reads its data

`restore_from` is the sharpest of these and is not in #72's table. A restored database is
a full copy, and the only pre-existing guard checked that a named backup belonged to the
named source rather than that the caller could reach it.

```mermaid
sequenceDiagram
    autonumber
    participant B as Tenant B
    participant API as drigodb API
    participant K8s as Kubernetes
    participant Bucket as Object storage

    B->>API: POST /v1/databases with restore_from A's id
    API->>K8s: get Cluster for the SOURCE id
    alt the source exists
        K8s-->>API: owner is ownerA
        API-->>B: 404, before any bucket is read
    else the source was deleted
        K8s-->>API: not found
        Note over API: no owner label left to check, so admin only
        API-->>B: 404 for a tenant
    end

    Note over API,Bucket: an admin reaches the recovery path
    API->>Bucket: bootstrap a recovery from the archive prefix
```

An admin's id is `sha256(external_id)` alone, so a name like `openvoid-app-01JQ` is a
guess rather than a search. That is why this check is in front of the bucket read rather
than beside it.
