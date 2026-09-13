// Runtime configuration. Everything is environment-driven so the same image
// runs locally, in kind, and on DOKS.

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

// A positive integer from the environment, or the fallback. Nonsense falls back
// rather than propagating: a bad value here is an operator's typo, and every
// consumer of it is a bound whose only safe direction to be wrong in is the
// configured default.
function positiveOr(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

  // Empty means "the cluster's default StorageClass", which is what makes this
  // installable somewhere that is not DigitalOcean. The chart sets it only when
  // someone names one.
  storageClass: envOr("DRIGODB_STORAGE_CLASS", ""),
  // Which tier a database is created on, and how far an owner may grow it.
  //
  // storageSize is gone: a tier IS a size, and a second setting that no longer
  // decided anything would be a decoy — this repository has already had one pin
  // rot at 0.0.1 for seven releases because nothing read it.
  //
  // The ceiling is the approval. A resize is owner-initiated and automatically
  // granted, provided the target is a real tier no larger than this; nothing
  // watches usage and grows on its own.
  defaultTier: envOr("DRIGODB_DEFAULT_TIER", "small"),
  maxTier: envOr("DRIGODB_MAX_TIER", "large"),

  // The DNS suffix used to build connection endpoints. In-cluster for v0.0.1.
  endpointSuffix: envOr("DRIGODB_ENDPOINT_SUFFIX", "svc.cluster.local"),

  // Server authentication. Off unless an issuer is named, and drigodb works
  // without it — bootstrap.sh self-signs and the URI says sslmode=require.
  // What this adds is the client being able to tell it is talking to the
  // database it asked for.
  // Backups, through CloudNativePG's barman-cloud plugin.
  //
  // drigodb names an ObjectStore and the operator does the rest. There is no
  // bucket credential here and no S3 client: the control plane cannot reach
  // object storage and does not need to, which is a smaller blast radius than
  // the sidecar era managed with its own signing code.
  backup: {
    objectStore: envOr("DRIGODB_BACKUP_OBJECT_STORE", ""),

    // Purging an orphaned archive is the one operation that cannot go through
    // the operator, because there is no Cluster left for the operator to act on
    // (#135). It runs as a Job on the barman-cloud sidecar image with the
    // credential Secret mounted into the pod — so the control plane still holds
    // no credential and still has no S3 client, and the two things above are
    // names, not secrets.
    //
    // The image cannot be discovered: the plugin injects it into database pods,
    // and a purge happens when there is no pod. So it is configuration, pinned
    // by the chart to the plugin version in scripts/versions.env and bumped by
    // the Renovate manager that watches both. A pin nothing reads is how this
    // repository has been bitten before; this one is read on every purge, and
    // the script fails loudly naming this setting if the image is too old.
    purgeImage: envOr(
      "DRIGODB_BACKUP_PURGE_IMAGE",
      "ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar:v0.15.0",
    ),

    // Holds purge-archive.py, mounted into that Job. Release-named, so the chart
    // has to say which one rather than the code guessing.
    purgeScriptConfigMap: envOr("DRIGODB_ARCHIVE_PURGE_CONFIGMAP", ""),

    // How many archive generations a purge probes. An in-place restore adds one
    // (db-<id>, db-<id>-r1, …) and nothing else does, so 20 is a database
    // restored twenty times. The bound exists because the alternative is an
    // unbounded loop against object storage; a purge that hits it says so in its
    // result rather than reporting a clean sweep.
    //
    // Falls back rather than throwing, the same way defaultTier does. A typo in an
    // operator's env would otherwise reach the Job as the string "NaN" and fail
    // every purge on a Python traceback about an integer.
    purgeMaxGenerations: positiveOr("DRIGODB_ARCHIVE_PURGE_MAX_GENERATIONS", 20),
  },

  tls: {
    issuer: envOr("DRIGODB_TLS_ISSUER", ""),
    issuerKind: envOr("DRIGODB_TLS_ISSUER_KIND", "Issuer"),
    // The DATABASE namespace, because cert-manager writes a Certificate's Secret
    // beside the Certificate and the pod that mounts it lives there. An Issuer
    // beside the control plane would put every Secret one namespace away from
    // the only thing that needs it.
    issuerNamespace: envOr("DRIGODB_TLS_ISSUER_NAMESPACE", "drigodb-databases"),
    duration: envOr("DRIGODB_TLS_DURATION", "2160h"),
    renewBefore: envOr("DRIGODB_TLS_RENEW_BEFORE", "360h"),
    caSecret: envOr("DRIGODB_TLS_CA_SECRET", "drigodb-api-ca"),
  },

  // Backups. Off unless a bucket and an endpoint are configured — with neither,
  // no sidecar is added and a database is exactly what it was before. That

} as const;

// Backups are configured only when there is somewhere to put them.
// A named issuer is the switch. Without one there is nothing to ask for a
// certificate, so the URI must say require rather than promise verification a
// client cannot perform.
export function serverAuthEnabled(): boolean {
  return config.tls.issuer !== "";
}


// Read lazily so tests and `--help`-style invocations do not need a token.
export function apiToken(): string {
  return required("DRIGODB_API_TOKEN");
}

// Backups exist for this installation when the chart rendered an ObjectStore
// and told the API its name. Nothing else is required of the control plane.
export function backupsEnabled(): boolean {
  return config.backup.objectStore !== "";
}
