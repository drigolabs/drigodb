# postgres-documentdb

CloudNativePG-compatible PostgreSQL image carrying the [DocumentDB](https://github.com/documentdb/documentdb)
extension. This is the storage half of drigodb — every app gets its own CNPG cluster
running this image. See `docs/service-boundary.md` (U1).

## Why drigodb builds this

DocumentDB publishes no CNPG-compatible image. Upstream ships an all-in-one `documentdb-local` emulator
container (PostgreSQL + gateway in one process tree, unsuitable as a CNPG operand) and OS packages. The
only third-party candidate, `ghcr.io/ferretdb/postgres-documentdb`, is built by a project whose last
substantive commit was 2026-02-07 and trails the current extension by eleven releases.

## Why Ubuntu, not CNPG's own image

Building `FROM ghcr.io/cloudnative-pg/postgresql` (Debian trixie) was tried first, to inherit CNPG's
weekly security rebuilds. The package installs cleanly — `libc6 (>= 2.38)` is satisfied and the other
dependencies are PGDG packages published for both distributions — but PostgreSQL then refuses to start:

```
FATAL: could not load library ".../pg_documentdb_core.so": undefined symbol: ucol_getSortKey_74
```

ICU exports version-suffixed symbols. Upstream builds against Ubuntu 24.04's **libicu74**; Debian trixie
ships **libicu76**, so the symbol does not exist. There is no shim for this.

The image therefore mirrors CNPG's own Dockerfile structure — PGDG apt, `postgresql-$PG_MAJOR`, uid 26,
`locales-all`, required binaries on `PATH` — on Ubuntu 24.04, which is upstream DocumentDB's Tier 1
target: the combination their CI builds, tests, and runs an install-and-start E2E against.

**The trade-off:** drigodb owns base-image patching here instead of inheriting CNPG's weekly rebuild.
A scheduled CI rebuild is required, not optional.

## Build

```sh
docker build --build-arg TARGETARCH=arm64 -t drigolabs/drigodb-postgres:18-0.116-0 .
```

| Build arg | Default | Notes |
|---|---|---|
| `PG_MAJOR` | `18` | Upstream's paved-road default; 17 is also Tier 1 |
| `DOCUMENTDB_VERSION` | `0.116-0` | Must match a DocumentDB release tag; the package is checksum-verified against that release's `SHA256SUMS` |
| `TARGETARCH` | `amd64` | Set automatically by buildx; both arches are published upstream |
| `BASE` | `ubuntu:24.04` | Upstream's Tier 1 target — changing this is what broke the Debian attempt above |

The tag must start with the PostgreSQL major version, or CNPG cannot auto-detect it.

## Verify

Building only proves the package installed. `smoke-test.sh` proves the engine runs: the extension loads
under the preload libraries CNPG will configure, and a document round-trips through the MongoDB-shaped
API.

```sh
./smoke-test.sh drigolabs/drigodb-postgres:18-0.116-0
```

Run it after any base-image, PostgreSQL-major, or DocumentDB version bump.

## Required PostgreSQL configuration

CNPG cluster config must set these; the image does not bake them in.

| Setting | Value | Why |
|---|---|---|
| `shared_preload_libraries` | `pg_cron,pg_documentdb_core,pg_documentdb` | The extension will not load otherwise |
| `cron.database_name` | the app's database | pg_cron binds to exactly one database per cluster, and the extension can only be created in that one |
| `listen_addresses` | must include localhost | DocumentDB opens internal libpq connections back to the server over TCP; a socket-only server fails at the first document API call |
| `documentdb_core.bsonUseEJson` | `on` | Renders BSON as extended JSON instead of a `BSONHEX...` dump. Off by default, and the difference between readable and unreadable data when inspecting over SQL with DBeaver |

`cron.database_name` is the reason a PostgreSQL cluster can host exactly one DocumentDB database — the
constraint behind the whole cluster-per-app design. See
`docs/documentdb-multitenancy-spike.md` F4.
