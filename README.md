# drigodb

MongoDB-compatible databases on PostgreSQL, provisioned through an API.

Each database is a PostgreSQL instance running the [DocumentDB](https://github.com/documentdb/documentdb)
extension behind a MongoDB wire-protocol gateway, so applications connect with an ordinary MongoDB
driver. Databases hibernate when idle — **zero compute, storage only** — and wake in about eight
seconds.

> **v0.0.1.** The control plane runs on Kubernetes and provisions real databases. There is no public
> endpoint, no accounts, no quotas and no backups yet. See [Status](#status).

## Why one instance per database

The obvious design — one shared instance, a database per tenant — does not work, and the reason is
worth stating up front because everything here follows from it.

DocumentDB's shipped roles are cluster-wide. `documentdb_readwrite_role` cannot create or read a
collection at all, and `documentdb_admin_role`, the only role that can do useful work, owns every
collection table in the instance. In testing, a credential scoped to one tenant read another tenant's
private document and dropped its collection. There is no role between the two.

The usual fallback — a separate PostgreSQL *database* per tenant — is also closed off: `pg_cron` is a
hard dependency of the extension and binds to one database per cluster, so the extension can only ever
be installed once per instance.

Full write-up, with the commands: [docs/documentdb-multitenancy-spike.md](docs/documentdb-multitenancy-spike.md).

## Isolation

Three independent layers, so no single misconfiguration exposes one tenant to another:

| Layer | What it is |
|---|---|
| Instance | A separate PostgreSQL process, on a separate volume, with separate credentials |
| Role | A per-database PostgreSQL role, admin *within its own database only* |
| Network | A NetworkPolicy admitting only pods that opt in by label |

The network layer is deliberately trusted least. It fails open if its selector stops matching,
`kubectl port-forward` bypasses it entirely, and a CNI that does not implement NetworkPolicy makes it a
silent no-op. The other two hold without it.

## API

```
POST   /v1/databases            { external_id }   → 202 + connection_uri
GET    /v1/databases            list
GET    /v1/databases/{id}       status and endpoint
POST   /v1/databases/{id}/wake       → 202
POST   /v1/databases/{id}/hibernate  → 202
DELETE /v1/databases/{id}       destroys the data
```

Bearer token on everything except `/healthz`.

**Provisioning is asynchronous** — roughly 12 seconds, so `POST` returns `202` and a status to poll.

**`POST /v1/databases` is idempotent on `external_id`.** A repeat returns the existing database rather
than creating a second one. Callers retry — failed requests, restarted processes, reconcile loops — and
a duplicate would split one application's data across two instances while quietly doubling its cost.

**The connection URI is returned on creation only**, never from a plain `GET`, so a leaked read token
does not leak database credentials.

Kubernetes is the source of truth. There is no control-plane database: a hosted database *is* its
StatefulSet, and the caller's identifier lives on it as a label.

## Running it

```bash
bash scripts/publish-images.sh   # multi-arch to GHCR (needs gh auth refresh -s write:packages)
bash scripts/doks-up.sh          # DigitalOcean cluster — starts billing
bash scripts/deploy.sh           # control plane; prints the API token once
bash scripts/doks-down.sh        # stop billing
```

Then:

```bash
kubectl -n drigodb-system port-forward svc/drigodb-api 8080:80

curl -XPOST localhost:8080/v1/databases \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"external_id":"my-app"}'
```

Connect the returned `connection_uri` with any MongoDB driver, `mongosh`, or Compass. Compass browses
and queries normally; its **Performance tab does not work**, because the gateway implements neither
`serverStatus` nor `top`.

## Measured

On a single node, warm image cache:

| | |
|---|---|
| Provision from nothing | ~12s (includes `initdb` and `CREATE EXTENSION`) |
| Wake from hibernation | ~8s |
| Active memory | ~114 MiB (PostgreSQL 110, gateway 4) |
| Hibernated | 0 pods; storage only |

Compute therefore tracks *concurrent* databases, not total ones. Storage tracks total, at the
provisioned volume size each — that is the term that grows with signups.

## Status

Built: images, per-database topology, isolation, the control-plane API, DigitalOcean deployment.

Not built: public endpoints (databases are in-cluster only), TLS from a real issuer — the gateway
self-signs, so clients pass `tlsAllowInvalidCertificates` — accounts, quotas, billing, backups,
credential rotation, and vertical or storage autoscaling.

## Licence

MIT.
