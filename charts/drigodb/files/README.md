# `config/`

The PostgreSQL configuration every hosted database mounts. `scripts/deploy.sh` loads these files into
the `drigodb-config` ConfigMap, so the shipped config is the deployed config, and a pod picks up a
change on its next start — which is also its next wake.

| File | What it is |
|---|---|
| `postgresql.conf` | Listen address, the two socket directories, TLS, and WAL sized against the volume |
| `pg_hba.conf` | Who may connect and how. **Order-sensitive**: pg_hba is first-match |
| `bootstrap.sh` | The postgres container's entrypoint. Owns first-start initialisation, credential rotation, running migrations, and the hand-off to the postmaster |
| `migrations/` | SQL applied inside every database, in order, once each. Its own ConfigMap — see [migrations/README.md](migrations/README.md) |
| `migrations-test.sh` | Runs the real `bootstrap.sh` against the real image and asserts what the runner promises |

## What is load-bearing

**Two socket directories.** The default, plus `/sockets` on a volume shared with the backup sidecar.
The sidecar reaches the server over that socket and authenticates by peer as the same UID, which is why
backups need no credential of their own and open no network path. Drop the second directory and backups
stop working.

**TLS is generated, not shipped.** The image carries Debian's snakeoil pair, but its private key is
`root:ssl-cert 0640` and Kubernetes does not grant a pod the image's group memberships — so using it
would mean pinning `supplementalGroups` to an image-specific gid. `bootstrap.sh` generates a
self-signed certificate into `PGDATA` at first start instead. Still self-signed, so clients pass
`sslmode=require`; a real issuer is issue #9.

**`pg_hba.conf` admits exactly two things**: local socket connections by peer, and `appuser` over TLS
into `app`. There is no rule for any other database, any other role, or the control plane. A leaked
credential reaches one database.

**The control plane is deliberately absent.** It holds every database's credential but has no route to
use one; schema changes reach a database through `bootstrap.sh` rather than over the network. The
reasoning is in issue #29.

**`include`, not append.** `bootstrap.sh` appends an `include` line to the generated `postgresql.conf`
at init time rather than copying settings into it, so a later config change takes effect on restart
instead of being frozen into `PGDATA` on the day the database was created.

**The two markers.** Rotation and migrations both need a running server, and an ordinary wake needs
neither. `.drigodb-credential` and `.drigodb-migrations` in `PGDATA` are what make that cost apply only
when something actually changed, and when both are due they share one start/stop cycle rather than
paying two.

The migrations marker is only a gate on whether starting is worth it. `_drigodb.schema_migrations`
inside the database is the source of truth for what actually ran, which is what keeps a restored volume
or a hand-edited marker from mattering.

## History

This directory used to carry DocumentDB's required settings — preload libraries, `cron.database_name`,
the internal-connection redirects, and a `pg_ident.conf` mapping the gateway's OS user onto the
`documentdb_*` role groups. All of it is gone with the extension and the gateway; see
[docs/leaving-documentdb.md](../docs/leaving-documentdb.md) for why, and
[docs/documentdb-multitenancy-spike.md](../docs/documentdb-multitenancy-spike.md) for the isolation
findings that forced the original design.
