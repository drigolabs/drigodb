// Runtime configuration. Everything is environment-driven so the same image
// runs locally, in kind, and on DOKS.

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(
      `${name} is not set. The service refuses to start without it — an API that provisions ` +
        `databases must not run unauthenticated.`,
    );
  }
  return v;
}

export const config = {
  port: Number(envOr("DRIGODB_PORT", "8080")),

  // Stamped into the image at build time so /healthz reports the build that
  // is actually running. A local `docker build` says "dev"; only CI, which
  // knows the version it is releasing, sets a real one.
  version: envOr("DRIGODB_VERSION", "dev"),

  // Namespace the provisioned databases live in. The API's own pod runs
  // elsewhere; this is the blast radius of its RBAC.
  databaseNamespace: envOr("DRIGODB_DATABASE_NAMESPACE", "drigodb-databases"),

  // CNPG's official image, not one of ours. Upstream rebuilds it; drigodb no
  // longer patches a base it never wanted. See docs/leaving-documentdb.md.
  pgImage: envOr("DRIGODB_PG_IMAGE", "ghcr.io/cloudnative-pg/postgresql:18"),

  storageClass: envOr("DRIGODB_STORAGE_CLASS", "do-block-storage"),
  // 1Gi, against a measured floor of 73 MB and 365 bytes per document — about
  // two million documents once config/postgresql.conf bounds the WAL. 2Gi was
  // an unexamined default, and half of it was reserved for write-ahead log
  // nobody had chosen.
  //
  // Deliberately the small end: a PVC can be expanded in place and can never be
  // shrunk, and a StatefulSet's volumeClaimTemplates is immutable, so this
  // value is permanent for every database created under it. Too small is a
  // patch; too large is forever.
  storageSize: envOr("DRIGODB_STORAGE_SIZE", "1Gi"),

  // The DNS suffix used to build connection endpoints. In-cluster for v0.0.1.
  endpointSuffix: envOr("DRIGODB_ENDPOINT_SUFFIX", "svc.cluster.local"),

  // Backups. Off unless a bucket and an endpoint are configured — with neither,
  // no sidecar is added and a database is exactly what it was before. That
  // matters because a half-configured backup must not be the reason a database
  // fails to start.
  backup: {
    bucket: envOr("DRIGODB_BACKUP_BUCKET", ""),
    endpoint: envOr("DRIGODB_BACKUP_ENDPOINT", ""),
    intervalSeconds: envOr("DRIGODB_BACKUP_INTERVAL", "86400"),
    // Tagged by PostgreSQL major alone: the data plane no longer carries an
    // upstream extension version. pg_dump must not be older than the server, so
    // this image derives from the same postgres image the database runs.
    image: envOr("DRIGODB_BACKUP_IMAGE", "ghcr.io/drigolabs/drigodb-backup:18"),
    // Holds access_key and secret_key. Cluster-wide rather than per database:
    // one bucket, one credential, and the object prefix is what separates
    // tenants inside it.
    secretName: envOr("DRIGODB_BACKUP_SECRET", "drigodb-backup-credentials"),
    // SigV4 needs a region string and the server checks it, so a wrong guess
    // fails the signature rather than being ignored. Derived from the endpoint
    // by default — Spaces puts it in the hostname, MinIO has none — and
    // overridable for anything that does neither.
    region: envOr("DRIGODB_BACKUP_REGION", ""),
  },
} as const;

// Backups are configured only when there is somewhere to put them.
export function backupsEnabled(): boolean {
  return config.backup.bucket !== "" && config.backup.endpoint !== "";
}

// Read lazily so tests and `--help`-style invocations do not need a token.
export function apiToken(): string {
  return required("DRIGODB_API_TOKEN");
}
