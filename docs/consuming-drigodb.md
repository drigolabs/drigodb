---
date: 2026-09-06
topic: consumer-contract
status: current
related:
  - README.md
  - scripts/smoke.sh
---

# Using a drigodb database from your application

The README documents the HTTP API. This documents what a **consumer pod** has to
do, which is the half you actually implement.

Five things, and the third is the one that will cost you an afternoon.

## The short version

```
1. POST /v1/databases                     from in-cluster, with the bearer token
2. keep the connection_uri                it is returned once and never again
3. label your pod drigodb.io/allow-database: <id>     ← or you are silently denied
4. poll until status is "ready"           provisioning takes ~10-20s
5. connect with any PostgreSQL driver     sslmode=require
```

## The whole flow

```mermaid
sequenceDiagram
    autonumber
    participant App as Your pod
    participant API as drigodb-api<br/>drigodb-system
    participant Store as Your secret store<br/>(Secret, SOPS, Vault…)
    participant K8s as Kubernetes
    participant DB as db-&lt;id&gt;<br/>drigodb-databases

    App->>API: POST /v1/databases {external_id}<br/>Authorization: Bearer …
    Note right of API: Idempotent on external_id.<br/>A retry returns the existing<br/>database rather than a second one.
    API->>K8s: StatefulSet, Service, Secret, NetworkPolicy
    API-->>App: 202 {id, status: "provisioning", connection_uri}

    rect rgba(200,80,80,0.14)
        App->>Store: PERSIST connection_uri — this is your job
        Note over App,Store: drigodb does not store it for you. It is returned<br/>here and on rotation, never from a GET.<br/>Lose it and the ONLY way back into a live<br/>database is POST /credentials, which issues a<br/>new one and invalidates this one.
    end

    loop until status is "ready"
        App->>API: GET /v1/databases/{id}
        API-->>App: {status}
    end

    Note over App,DB: Your pod must carry<br/>drigodb.io/allow-database: &lt;id&gt;<br/>or the NetworkPolicy drops the packets

    Store-->>App: connection_uri
    App->>DB: connect (TLS)
    DB-->>App: rows

    Note over App,API: Later, if it may have hibernated
    App->>API: POST /v1/databases/{id}/wake
    API-->>App: 202
    App->>DB: connect again
```

## 1. Reach the API from inside the cluster

```
http://drigodb-api.drigodb-system.svc.cluster.local
Authorization: Bearer <token>
```

There is no public endpoint. The token is one per installation, held by whoever
installed drigodb — ask them for it rather than reading the Secret, unless you
are also the operator.

## 2. The connection URI is returned once

```
POST /v1/databases  {"external_id": "my-app"}
→ 202 {"id": "a1b2c3d4e5f6", "status": "provisioning",
       "connection_uri": "postgres://appuser:…@db-a1b2c3d4e5f6…:5432/app?sslmode=require"}
```

**Storing it is your job, and drigodb does not do it for you.** Write it to a
Secret, SOPS, Vault — wherever your application already keeps credentials —
before you do anything else with the response.

A plain `GET` never returns it, which is deliberate: a leaked read token does not
leak database credentials. The cost of that is that **a URI you did not persist
is gone**. The only way back into a live database is
`POST /v1/databases/{id}/credentials`, which issues a new URI and invalidates the
one you lost. The database is still there, still holding your data, still costing
money — you simply cannot reach it until you rotate.

The most common way to lose it is to hold it in memory, crash before writing it,
and retry the create — which is idempotent, returns the *existing* database, and
**does not return the URI again**.

`external_id` is yours and the call is **idempotent on it**. A retry — a failed
request, a restarted process, a reconcile loop — returns the existing database
rather than creating a second one and splitting your data across two instances.

That holds for calls made *at the same time*, not only one after another: two
pods, two reconcile loops or a client fanning out its retries all converge on one
database. The status code says which of them made it — `202` created it and
carries the `connection_uri`, `200` found it already there and does not. So a
caller that gets a `200` on what it thought was its first create has lost the
race, not the database, and it needs `POST /credentials` to get in.

One create is refused rather than served: a `409` while a database of the same
`external_id` is still being deleted. Deleting a database removes its volume,
and that removal is not instant. Retry after a few seconds.

## 3. Label your pod, or you will be denied silently

```yaml
metadata:
  labels:
    drigodb.io/allow-database: a1b2c3d4e5f6   # the database's id
```

This is the step worth leading with, because getting it wrong does not produce
an error. Each database has a NetworkPolicy admitting only pods carrying this
label, and **a NetworkPolicy denies by dropping packets** — so your client hangs
until its connect timeout and no log anywhere says "you were denied by policy".

It works across namespaces, so your pod can live wherever you like.

If a connection times out and the database says `ready`, check this first.

## 4. Wait for `ready`

| status | meaning |
|---|---|
| `provisioning` | starting; ~10-20s from nothing |
| `restoring` | provisioned from a backup, data still loading — **not usable yet** |
| `ready` | connect |
| `hibernated` | zero compute; call `wake` |
| `failed` | it will not become ready on its own |

`restoring` matters: a restored database answers on its port before its dump has
landed. Connecting then finds it empty, and anything you write leaves the restore
to find a non-empty target and skip.

## 5. Connect

Any PostgreSQL driver. The URI names the `app` database and carries
`sslmode=require`.

**Read the `sslmode` in the URI you were given — it tells you what you can
verify.**

`verify-full` means the installation runs cert-manager and each database serves a
certificate for its own Service name. Fetch the CA once and point your client at
it:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://drigodb-api.drigodb-system.svc.cluster.local/v1/ca > ca.crt
```

```
postgres://…?sslmode=verify-full&sslrootcert=/path/to/ca.crt
```

A CA certificate is not a secret — it is what your client checks a chain
against — so mount it however you mount any other config.

`require` means the server self-signs. Traffic is encrypted, but you cannot tell
you are talking to the database you asked for. That is the installation's choice
and not something you can fix from the client.

**`kubectl port-forward` breaks `verify-full`, inherently.** Through a tunnel you
are connecting to `localhost`, and no certificate for a Service name will ever
match that. Use `sslmode=require` for tunnelled debugging — that is what
`scripts/smoke.sh` does — and keep `verify-full` for the in-cluster path that
production actually uses.

## Hibernation

A database with no traffic can be hibernated — zero compute, storage only — and
wakes in about nine seconds. Nothing hibernates it automatically today; it is an
API call.

Two things follow for a consumer:

**Call `wake` before use if it may be hibernated**, and be ready to retry the connection. If the operator turned on automatic hibernation, "may be" means "will be, if nobody used it recently". It is safe to call on a
database that is already awake: a speculative wake must not restart something
serving traffic, so it does nothing.

**Waking is also when a database picks up changes** — a rebuilt image, a new
a resize. A database that stays hibernated indefinitely never
reconciles; one that cycles gets everything owed to it.

## A complete example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    metadata:
      labels:
        app: my-app
        # Without this, connections time out with no error anywhere.
        drigodb.io/allow-database: a1b2c3d4e5f6
    spec:
      containers:
        - name: app
          image: my-app:1.0.0
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef: { name: my-app-db, key: uri }   # you stored it at step 2
```

## What drigodb does not do for you

- **No connection pooling.** One PostgreSQL instance per database, `max_connections` at the server default. Pool in your application.
- **No schema management.** drigodb puts nothing inside your database — no schema, no table, no extension. It is yours entirely.
- **No automatic backups.** WAL is archived continuously once an installation configures storage, but a base backup is taken when you ask for one — `POST /v1/databases/{id}/backups`. Nothing takes one on a schedule yet.
- **No restore in place.** Restoring gives you a *new* database from a backup; it never overwrites the one you have. Point your application at the new URI when you are satisfied with it.
- **Automatic hibernation, if the operator turned it on.** A database with no connections for long enough is put to sleep, and `GET` reports `hibernated_by: auto` so you can tell that from one you asked for. **Nothing wakes it when a client connects** — the next connection fails, and your application has to call `wake` and retry. Ask your operator whether it is on, because it changes what your client has to do.
- **No accounts or quotas.** One token per installation, and every holder can do everything —
  including to databases they did not create. If you are not also the operator, you are trusting
  everyone else who holds that token. See
  [#72](https://github.com/drigolabs/drigodb/issues/72).

## When something is wrong

| symptom | cause |
|---|---|
| connection hangs, status is `ready` | the `drigodb.io/allow-database` label — start here |
| `401` | wrong or missing bearer token |
| database is empty after a restore | connected while `restoring` |
| `certificate verify failed` | no `sslrootcert`, or connecting through a port-forward — see above |
| stuck `provisioning` | usually no node has room, or the StorageClass has no default |
