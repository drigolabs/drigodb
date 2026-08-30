---
date: 2026-08-30
status: draft
related:
  - docs/plans/2026-08-29-001-feat-app-data-plane-documentdb-plan.md
  - docs/spikes/2026-08-29-documentdb-multitenancy.md
  - docs/ideation/2026-05-25-platform-cicd-and-deployment-ideation.md
---

# App Data Service — Boundary and API Contract

**Status:** the extraction was decided on 2026-08-30 and this repo is the result. The document is kept
as written — it is the reasoning behind the boundary, including the objections raised against it.
References to openvoid describe it as this service's first consumer, which it still is.

## Why this exists

The app data plane (`docs/plans/2026-08-29-001`) was built inside openvoid. The proposal is to extract
it into a standalone service under the Drigolabs brand: openvoid provisions databases through an API,
and apps then connect **directly** to their own database. Longer term, others might use the same
service.

Two questions have to be answered before that is a decision rather than an aspiration: what the API
boundary actually is, and what replaces the network isolation layer once apps connect from outside the
cluster. This document answers both.

## What is actually coupled today

Measured, not assumed, on 2026-08-30:

| Artifact | openvoid coupling |
|---|---|
| `infra/images/postgres-documentdb/` | Comments only |
| `infra/images/documentdb-gateway/` | Comments only |
| `infra/app-db/*.conf`, `bootstrap.sh` | None |
| `scripts/measure-app-db.sh`, `check-app-db-isolation.sh` | Resource names only |
| `src/k8s/app-db.ts` | Namespace name, label prefix, env var prefix, image paths — all cosmetic |

There is exactly **one structural tie**: the NetworkPolicy admits ingress from the `openvoid-sessions`
namespace, matching a pod carrying the app's ID. Everything else is naming.

That tie is also the thing the proposal removes, since apps connecting directly are not in that
namespace. So the extraction is close to free right now, and gets more expensive as U5 onward wires
provisioning into session-api. **This is the cheapest moment it will ever be.**

## The API contract

Designed against openvoid as the single real consumer. Generalising before a second consumer exists is
how these APIs go wrong.

### Operations

| Operation | Purpose |
|---|---|
| `POST /v1/databases` | Provision. Idempotent on `external_id` |
| `GET /v1/databases/{id}` | Status and connection details |
| `DELETE /v1/databases/{id}` | Destroy, including data |
| `POST /v1/databases/{id}/wake` | Wake from hibernation ahead of need |
| `POST /v1/databases/{id}/credentials` | Rotate credentials |
| `GET /v1/databases` | List — for reconciling drift |

### Provisioning is asynchronous

U6 measured 12s to provision and 8.1s to wake. Both are too long to block a request and short enough
that polling is fine.

```
POST /v1/databases  { external_id, tier }
  → 202 { id, status: "provisioning" }

GET /v1/databases/{id}
  → 200 { id, status: "provisioning" | "ready" | "hibernated" | "failed", endpoint?, ... }
```

This matches how openvoid already gates session readiness by polling, so it needs no new pattern on the
consumer side.

### Idempotency is not optional

`external_id` is the caller's own identifier (openvoid's app ID). Provisioning the same `external_id`
twice must return the same database, not create a second one. openvoid will retry — on a failed
request, a restarted process, a reconcile loop — and a service that creates a duplicate database on
retry silently doubles cost and splits an app's data across two instances.

### Credentials

The response carries a connection URI containing generated credentials. The service never accepts a
caller-supplied password, and returns the URI on creation and on rotation only — not on every `GET` —
so a leaked read-only API token does not leak database credentials.

### What each side owns

| openvoid | the service |
|---|---|
| Which app has which database | Provisioning, hibernation, wake |
| Injecting the URI into the session pod | Backups, restore, upgrades |
| Calling `wake` at session start | Isolation between databases |
| Deleting on app deletion | Metrics, health, capacity |

Everything in `docs/plans/2026-08-29-001` U1–U4, U6, U8–U13 moves. U5 shrinks to "openvoid calls this
API". U7 splits: the service generates and rotates credentials; openvoid decides how the URI reaches a
pod, which is where its own threat model applies.

## The exposure model

This is the sharper question, and the one that genuinely changes the design.

Today isolation rests on three independent layers: a separate PostgreSQL instance per database, a
per-database PostgreSQL role, and a NetworkPolicy admitting only that app's session pod. **If apps
connect from outside the cluster, the third layer stops applying** — traffic arrives from the internet,
not from a labelled pod, and NetworkPolicy has nothing to match on.

### The routing problem

MongoDB's wire protocol is TCP, not HTTP, so ordinary Ingress cannot route it by hostname. Three ways
out, with real trade-offs:

| Approach | Cost | Verdict |
|---|---|---|
| A LoadBalancer per database | One public IP each — untenable past a handful | No |
| A port per database on a shared LB | Simple, but a finite port range and ugly URIs | Fallback |
| **SNI routing on one TCP port** | An SNI-aware TCP proxy (nginx `ssl_preread`, HAProxy, Envoy) reads the TLS handshake and routes `<db-id>.db.<domain>` to the right backend | **Preferred** |

SNI routing works because the gateway already speaks TLS, and TLS carries the server name in the clear
during the handshake. One public endpoint serves every database.

The honest cost: this puts a proxy back in the data path, which partly undercuts "the service is only
on the control path". It is a *dumb TCP* proxy rather than a protocol-aware one — far less risk than
the mediation layer rejected in the original spike — but it is a component whose failure takes every
database offline, and it must be sized and monitored accordingly.

### Replacing the lost layer

An IP allowlist per database, enforced at the proxy. This is what Atlas and PlanetScale do, it is cheap
at the proxy, and it restores a genuine second layer independent of credentials.

Isolation then stays three-deep:

| Layer | In-cluster today | Public |
|---|---|---|
| 1 | Separate PostgreSQL instance | unchanged |
| 2 | Per-database PostgreSQL role | unchanged |
| 3 | NetworkPolicy | **IP allowlist at the proxy** |

Certificates also change: the gateway currently generates a self-signed certificate per pod, which is
why every client in this repo passes `tlsAllowInvalidCertificates`. A public endpoint needs a real
wildcard certificate for `*.db.<domain>`, terminated at or passed through the proxy. Telling users to
disable certificate validation is not an option for a public service.

### Recommendation

**Stay in-cluster until there is a second consumer.** openvoid runs in the same cluster, so nothing is
lost today, and the three-layer model survives untouched. Build the API boundary now — that is what
makes the service separable — and treat public exposure as its own project, gated on someone other than
openvoid actually needing it.

The API contract above is deliberately unchanged by that choice: `endpoint` is a hostname either way,
in-cluster or public. Nothing in the contract has to be redesigned when exposure changes, which is the
test of whether the boundary is drawn in the right place.

## What extraction costs

Stated plainly, because the case for it is easy to overstate:

- **A second thing to operate.** Its own deployment, upgrades, and on-call, for one person
- **A hard dependency for openvoid.** If the service is down, provisioning stops. Existing apps keep
  working — they connect directly — which is the main argument for this shape over a proxy
- **Two repos to keep in step** during the period when openvoid is the only consumer
- **No second consumer to validate the design.** openvoid is the only real one; the risk is designing
  for an imagined second, and the mitigation is refusing to generalise until it appears

Against that: the boundary is genuinely clean, the extraction is cheapest today, and the service is a
sharper portfolio artifact standing alone than as a feature inside openvoid.

## Open questions

- **Name and domain.** `drigodb` is a placeholder
- **Tiers.** Currently one fixed shape: 2Gi, single instance. "Autoscale" in the original framing spans
  vertical resize, storage growth and connection pooling — years of work in real products. Scope it
  explicitly or it will swallow the project
- **Storage is the term that grows.** U6: compute tracks concurrent sessions, storage tracks total
  databases at 2Gi each. A public free tier makes that someone's real bill
- **Multi-tenancy of the service itself.** Today openvoid is the only caller and holds one API key.
  Other users means accounts, quotas, and abuse prevention — none of which exists
