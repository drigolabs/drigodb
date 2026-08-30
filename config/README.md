# app-db

PostgreSQL configuration for a per-app database pod. Every drigodb app gets its own instance of this
— see `docs/service-boundary.md` (U3), and
`docs/documentdb-multitenancy-spike.md` for why isolation has to work this way.

These three files become a ConfigMap mounted into the app's pod. U4 assembles the StatefulSet around
them.

| File | Purpose |
|---|---|
| `postgresql.conf` | DocumentDB's required settings — preload libraries, the pg_cron database, socket directories, and the internal-connection redirects |
| `pg_hba.conf` | Who may connect and how. **Order-sensitive**: the scoped gateway rule must be first |
| `pg_ident.conf` | Maps the gateway's OS user onto the `documentdb_*` role groups. Requires PostgreSQL 16+ |

## Why these files are not boilerplate

Each setting was established by a failure in `images/documentdb-gateway/integration-test.sh`, and
each failure looked like something other than its cause:

- Without the `pg_ident` `+group` map, the gateway cannot authenticate clients at all. Its system pool
  connects as its own role, but each client's data pool connects **as that client's role with an empty
  password**, which peer auth allows only through a group ident entry.
- Without `documentdb.localhost_connection_string` and `cron.host` pointed at the socket, everything
  appears to work — the client authenticates, the gateway is healthy — and then every write fails with
  `fe_sendauth: no password supplied`, raised from inside `create_collection`. The extension's own
  internal libpq connections default to `host=localhost` over TCP, where they have no password.
- Without `documentdb_core.bsonUseEJson`, documents read back as `BSONHEX7500...` when inspected over
  SQL, which is what an operator sees in DBeaver (U13).
- `cron.database_name` is why a PostgreSQL cluster can host exactly one DocumentDB database. It is the
  constraint the whole cluster-per-app design rests on.

The pod also has two hard requirements the config cannot express: **both containers must run as the
same UID** (26), because PostgreSQL resolves the peer's UID against its own passwd database, and the
gateway's PostgreSQL URL **must state port 5432 explicitly**, because the gateway defaults to 9712.
Both live in `images/documentdb-gateway/README.md`.

## Storage class

Per the provider-differences-in-values pattern
(`docs/solutions/best-practices/helm-routing-abstraction-2026-05-03.md`), the class name is
configuration, not code:

| Environment | StorageClass | Notes |
|---|---|---|
| kind (local) | `standard` | rancher local-path provisioner, shipped with kind |
| DOKS | `do-block-storage` | DigitalOcean Block Storage; expands online |

U4 reads this from `OPENVOID_APP_DB_STORAGE_CLASS`, following the env-overridable routing constants
already in `services/session-api/src/k8s/client.ts`.

## Verifying the cluster can enforce isolation

The NetworkPolicy in U4 is only one of three isolation layers, and it is the one that fails silently:
kind's default CNI accepts policies and ignores them. `scripts/kind-up.sh` installs Calico instead, and
`scripts/check-netpol.sh` proves enforcement with a baseline → deny → allow sequence. Run it before
trusting any local isolation test.
