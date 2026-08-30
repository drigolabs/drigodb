# documentdb-gateway

MongoDB wire-protocol gateway for drigodb. Translates MongoDB commands into SQL against a
PostgreSQL backend running the DocumentDB extension, so app code can use an ordinary MongoDB driver.
See `docs/service-boundary.md` (U2).

Upstream ships this only as an OS package and inside the all-in-one emulator container, so the image is
drigodb's to build. Ubuntu 24.04 for the same reason as `postgres-documentdb`: upstream's Tier 1 target,
and the package declares `libc6 (>= 2.39)`.

## The deployment contract

**The gateway must run in the same pod as PostgreSQL.** This is not a preference — the OSS build refuses
to work any other way, and the constraint is worth understanding before designing around it.

The gateway rejects password-bearing connection URLs outright:

```
Password-bearing PostgreSQL URLs in DOCUMENTDB_PG_URL_FILE are not supported.
Use peer auth on a local Unix socket instead.
```

and the source is explicit that *"this build only supports passwordless local peer auth"*. It cannot
reach a remote PostgreSQL. Gateway and PostgreSQL must share a filesystem for the socket, which in
Kubernetes means one pod.

Four consequences, each verified by `integration-test.sh`:

| Requirement | Why |
|---|---|
| Gateway runs as **PostgreSQL's UID** (26 for CNPG) | PostgreSQL resolves the peer's UID against its *own* passwd database. A mismatch fails with `provided user name ... and authenticated user name ... do not match`. Baked into the image as `USER 26` |
| A **`pg_ident` map** granting that OS user the `documentdb_*` role groups | The gateway's system pool connects as its own role, but each client's data pool connects **as that client's role with an empty password**. Peer auth only permits that with a `+group` ident map |
| **PostgreSQL 16+** | `+group` membership in `pg_ident.conf` is a PG16 feature. Upstream refuses to register the gateway on older majors |
| The **port must be explicit** in the URL | The gateway defaults to PostgreSQL port **9712**, not 5432. Against a CNPG cluster on 5432, omitting it fails with a bare `error connecting to server` |

## Required PostgreSQL configuration

```conf
# pg_ident.conf — let the gateway's OS user assume documentdb member roles
documentdb-gateway-map   postgres   postgres
documentdb-gateway-map   postgres   +documentdb_admin_role
documentdb-gateway-map   postgres   +documentdb_readwrite_role
documentdb-gateway-map   postgres   +documentdb_readonly_role
```

```conf
# pg_hba.conf — scoped, and FIRST: pg_hba is first-match, and a catch-all peer
# rule locks out every other local user
local  all  "postgres",+documentdb_admin_role,+documentdb_readwrite_role,+documentdb_readonly_role  peer  map=documentdb-gateway-map
```

```conf
# postgresql.conf
unix_socket_directories = '/var/run/postgresql,/sockets'   # default path AND the shared one
documentdb.localhost_connection_string = 'host=/var/run/postgresql'
cron.host = '/var/run/postgresql'
```

Those last two matter more than they look. The extension's internal libpq connections — `create_collection`
among them — and pg_cron's job connections both default to `host=localhost` over TCP, where they have no
password. Left alone, the gateway authenticates fine and then every write fails with
`fe_sendauth: no password supplied` from inside the extension. Pointing them at the socket makes them
authenticate by peer, as the ident map expects.

## Configuration

Environment-first; the JSON config file is optional and unused here.

| Variable | Default | Notes |
|---|---|---|
| `DOCUMENTDB_PG_URL_FILE` | — | **Required.** Path to a file containing the URL, not the URL itself. Keeps the connection string out of the pod spec; the shape a mounted secret takes. Warns if more permissive than 0640 |
| `DOCUMENTDB_LISTEN_ADDR` | `:10260` | Client-facing listener |
| `DOCUMENTDB_TLS_AUTO_GENERATE` | `true` | Self-signed cert on first start; clients need the CA trusted or invalid certs allowed |
| `DOCUMENTDB_TLS_STATE_DIR` | `/var/lib/documentdb-gateway/tls` | Group-0 writable so an arbitrary UID can use it |
| `DOCUMENTDB_LOG_LEVEL` | `info` | |

## Build and verify

```sh
docker build --build-arg TARGETARCH=arm64 -t drigolabs/drigodb-gateway:0.116-0 .
./integration-test.sh
```

`integration-test.sh` stands up the backend and the gateway with the full configuration above and drives
a real MongoDB client through insert and find. Run it after any version bump — a green build proves only
that the package installed.

`documentdb-gateway check` probes the backend and verifies the extension is loaded, exiting 0/1. It is
the image's healthcheck and should be the readiness probe for the per-app Deployment.
