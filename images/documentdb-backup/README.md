# drigodb-backup

Physical backups of a drigodb database to S3-compatible storage, run as a
sidecar in the database's own pod.

## Why it is physical

`pg_dump` cannot produce a restorable backup of a DocumentDB database, and it
fails at it *silently*.

`pg_dump` never dumps the data of a table belonging to an extension unless that
extension marks it with `pg_extension_config_dump()`. Measured on 2026-09-03:

| | belongs to the extension | dumped |
|---|---|---|
| `documentdb_data.documents_<n>` — a collection's rows | no | yes |
| `documentdb_api_catalog.collections` — the registry | **yes** | **no** |

```
SELECT extname, extconfig FROM pg_extension;
 documentdb      | (none)
 pg_cron         | cron.job, cron.jobid_seq, cron.job_run_details, cron.runid_seq
 postgis         | spatial_ref_sys
```

`documentdb` marks nothing. So a logical restore completes with no error and
leaves every collection invisible: the rows are present and nothing can find
them. An explicit `-t` does not override it — the dump comes back empty.

`pg_basebackup` copies the cluster, catalogs included, so it is correct by
construction. The costs are real and worth stating: a backup is the whole
cluster, so there is a ~73 MB floor even for an empty database, and it restores
only into the same PostgreSQL major version. This image derives from the
server's own image, which makes that version match by construction.

## Why it runs inside the pod

`config/pg_hba.conf` admits TCP from `127.0.0.1` and `::1` only, and the Service
publishes the gateway's port rather than PostgreSQL's. Nothing outside the pod
can reach the server. A backup Job would need a `pg_hba` rule, a NetworkPolicy
hole and a credential of its own — reopening the path the isolation model
deliberately closes.

As a sidecar it uses the Unix socket the gateway already shares, authenticating
by peer as the same UID. `pg_basebackup` opens a *replication* connection, which
`all` in the DATABASE column does not match, so `config/pg_hba.conf` carries an
explicit `local replication all peer` line. `initdb` generates one by default;
this repo replaces the generated file outright, which is why it must be restated.

## Commands

| | |
|---|---|
| `once` | one backup, then exit |
| `run` | back up whenever one is due, forever |
| `latest` | print the newest object key, if any |
| `restore KEY` | unpack a backup into an empty `PGDATA` |

`restore` refuses a `PGDATA` that already holds a cluster. A physical restore
replaces a data directory rather than loading into a running server, so the
target is always a fresh instance — which the architecture forces anyway, since
`pg_cron` binds to one database per cluster.

## Configuration

| | |
|---|---|
| `DRIGODB_DATABASE_ID` | the object prefix |
| `DRIGODB_BACKUP_BUCKET` | bucket name |
| `DRIGODB_BACKUP_ENDPOINT` | `https://fra1.digitaloceanspaces.com`, or a MinIO URL |
| `DRIGODB_BACKUP_KEY` / `_SECRET` | credentials |
| `DRIGODB_BACKUP_INTERVAL` | seconds between backups, default 86400 |

`rclone` is configured entirely from the environment, so no credential is
written to disk. `force_path_style` is set, which MinIO needs and Spaces
tolerates — that is what lets the same image run against both.

`rclone` and not `mc`, despite the tests running against MinIO: `mc` is AGPL and
this image is published, whereas the MinIO server stays a test-only container
that is never distributed. `rclone` is MIT.

## Testing

```bash
./integration-test.sh [backup-image] [postgres-image]
```

Starts MinIO and a PostgreSQL, writes 50 documents through the DocumentDB API,
backs up, restores into a second instance with no cluster in it, and reads the
documents back **through the API**. That last assertion is the point — it is
what caught `pg_dump` restoring without error and losing every collection.
