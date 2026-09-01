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

  pgImage: envOr("DRIGODB_PG_IMAGE", "ghcr.io/drigolabs/drigodb-postgres:18-0.116-0"),
  gatewayImage: envOr("DRIGODB_GATEWAY_IMAGE", "ghcr.io/drigolabs/drigodb-gateway:0.116-0"),

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
} as const;

// Read lazily so tests and `--help`-style invocations do not need a token.
export function apiToken(): string {
  return required("DRIGODB_API_TOKEN");
}
