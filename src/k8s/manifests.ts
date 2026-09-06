// Kubernetes objects for one hosted database.
//
// A database is a plain PostgreSQL instance in its own pod, with its own volume,
// its own credentials and its own NetworkPolicy. Applications connect over TCP
// with an ordinary PostgreSQL driver.
//
// One instance per database was forced by DocumentDB, which cannot isolate
// tenants within an instance (docs/documentdb-multitenancy-spike.md). That
// constraint is gone, and the topology is now a choice: a shared tier is
// possible and not yet built. See docs/leaving-documentdb.md.

import { createHash } from "node:crypto";

import type {
  V1Job,
  V1NetworkPolicy,
  V1PodTemplateSpec,
  V1Secret,
  V1Service,
  V1StatefulSet,
} from "@kubernetes/client-node";

import { backupsEnabled, config, serverAuthEnabled } from "../config.js";

export const DB_ID_LABEL = "drigodb.io/database-id";
export const EXTERNAL_ID_LABEL = "drigodb.io/external-id";
export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
export const MANAGED_BY_VALUE = "drigodb";

// A consumer pod carrying this label may reach the named database. It works
// across namespaces, so consumers need not live anywhere in particular.
export const ALLOW_LABEL = "drigodb.io/allow-database";

// Which generation of the pod template a database was last built from. Wake
// compares it against the template this build renders and reconciles when they
// differ, which is how a patched data-plane image reaches a database that
// already exists.
//
// On the StatefulSet's own metadata, deliberately — never the pod template's.
// An annotation inside the template is part of the template, so writing it
// would change the hash it records, and every wake would roll the pod forever.
export const TEMPLATE_HASH_ANNOTATION = "drigodb.io/template-hash";

// Which tier a database is on. On the StatefulSet, because the live PVC is the
// truth and reading a PVC to answer "how big is this database" is a second API
// call for something a label already knows.
//
// A StatefulSet's volumeClaimTemplates is immutable, so after a resize the
// template permanently disagrees with the PVC. That is not drift to reconcile,
// it is Kubernetes — and the label is how the API reports size without anyone
// having to know that.
export const TIER_LABEL = "drigodb.io/tier";

// Whether a database is at zero replicas on purpose.
//
// Zero replicas alone cannot answer that. It is also what a create looks like
// in the window between the StatefulSet — which is the lock, so it is written
// first — and the wake that follows it, and with two API replicas that window
// is not rare: it is precisely where a concurrent caller lands. Before this
// label, those callers were told a database being built was hibernated.
//
// Written with the scale rather than derived from it, so it records the intent
// that caused the number rather than the number itself. Absent on databases
// created before it existed, which is why the replica count is still the
// fallback.
export const HIBERNATED_LABEL = "drigodb.io/hibernated";

// CloudNativePG's API group. A hosted database is a Cluster in it — decision
// 0004 — and preflight checks that this cluster can list them before drigodb
// reports itself able to work.
export const CNPG_GROUP = "postgresql.cnpg.io";
export const CLUSTERS_PLURAL = "clusters";

// How CloudNativePG is told to put a database down. An annotation rather than a
// replica count, and drigodb keeps its own HIBERNATED_LABEL beside it: this one
// says what the operator was asked to do, the label says what drigodb meant.
export const CNPG_HIBERNATION_ANNOTATION = "cnpg.io/hibernation";

// The key CNPG reads a username from when it is handed a credential Secret. It
// wants a kubernetes.io/basic-auth Secret, so the password alone is not enough.
export const USERNAME_SECRET_KEY = "username";

// A tier is a floor, not a quota. Nothing stops a database filling its volume.
//
// max_wal_size scales with the tier for performance rather than correctness: it
// is a checkpoint trigger, not a cap on database size. A 20Gi database runs
// correctly at 256MB, it simply checkpoints more often than it needs to.
export const TIERS = {
  small: { storage: "1Gi", maxWalSize: "256MB" },
  medium: { storage: "5Gi", maxWalSize: "1GB" },
  large: { storage: "20Gi", maxWalSize: "2GB" },
} as const;

export type Tier = keyof typeof TIERS;
export const TIER_ORDER: Tier[] = ["small", "medium", "large"];

// Databases provisioned before tiers existed carry no label. They are small:
// that is what they were given, and it is what their PVC still says.
export function tierOf(labels: Record<string, string> | undefined): Tier {
  const t = labels?.[TIER_LABEL];
  return t && t in TIERS ? (t as Tier) : "small";
}

export function pvcName(id: string): string {
  return `${DATA_VOLUME}-${statefulSetName(id)}-0`;
}

export const CONFIG_MAP_NAME = "drigodb-config";
export const CONFIG_MOUNT_PATH = "/drigodb-config";

// Schema, separate from configuration and on its own ConfigMap deliberately:
// `kubectl create configmap --from-file=<dir>` flattens a directory into keys,
// so migrations sharing drigodb-config would land beside postgresql.conf with
// nothing but a naming convention keeping them apart.
//
// Adding a migration changes this template's hash, so an existing database
// picks it up on its next wake through the same reconcile that carries an image
// update — which is the whole reason schema ships this way rather than from the
// control plane. See issue #29.
export const MIGRATIONS_CONFIG_MAP_NAME = "drigodb-migrations";
export const MIGRATIONS_MOUNT_PATH = "/drigodb-migrations";

// PostgreSQL's UID and GID in CNPG's image: `uid=26(postgres) gid=102(postgres)`.
//
// The GID is not 26. It was under our own image, and carrying that assumption
// across would leave PGDATA group-owned by a group the server does not belong
// to. The backup sidecar must run as the same UID, because peer auth over the
// shared socket resolves the caller's UID against the server's passwd database
// and a mismatch fails every connection.
//
// Group 101 (ssl-cert) is deliberately NOT requested. It is how the image's
// snakeoil TLS key is readable, but Kubernetes does not grant a pod the image's
// group memberships, so using that key would mean pinning supplementalGroups to
// an image-specific gid. bootstrap.sh generates a certificate instead.
export const RUN_AS_USER = 26;
export const RUN_AS_GROUP = 102;

// Shared with the backup sidecar, which reaches the server over this socket and
// authenticates by peer. It outlived the gateway it was introduced for: a
// socket is still how a backup runs without a credential or a network path.
export const SOCKET_VOLUME = "socket";
export const SOCKET_MOUNT_PATH = "/sockets";
export const DATA_VOLUME = "data";
export const DATA_MOUNT_PATH = "/var/lib/postgresql/data";
export const PGDATA = `${DATA_MOUNT_PATH}/pgdata`;

// Where cert-manager's Secret is mounted, and what bootstrap.sh looks for.
// Read-only and owned by root, so bootstrap.sh copies rather than points
// PostgreSQL at it: a server key must be 0600 and owned by the running user,
// which a projected Secret cannot be.
export const TLS_VOLUME = "server-tls";
export const TLS_MOUNT_PATH = "/drigodb-tls";

export function tlsSecretName(id: string): string {
  return `db-${id}-tls`;
}

export const POSTGRES_PORT = 5432;
export const POSTGRES_PORT_NAME = "postgres";

export const BACKUP_KEY_SECRET_KEY = "access_key";
export const BACKUP_SECRET_SECRET_KEY = "secret_key";

export const DB_USER = "appuser";

// The role that owns _drigodb and applies migrations. Separate from the
// application, and that separation is the whole point.
//
// bootstrap.sh ran as postgres over a Unix socket, so the migration ledger was
// owned by a superuser and the application could read it but not write it —
// which stopped an application from claiming a migration had already run when it
// had not. Under CloudNativePG there is no entrypoint of ours to run as
// postgres, so the runner authenticates over TCP like anything else.
//
// Running it as the application would have handed the application ownership of
// its own ledger. That is not merely untidy: dropping the schema is loud and
// self-correcting, but forging a row is silent and lets a tenant DECLINE a
// migration aimed at them — including one that tightens a permission.
//
// Running it as postgres would have meant enabling CNPG superuser access, which
// puts a superuser password in the database namespace beside every application
// password. PostgreSQL superuser is COPY TO PROGRAM, so that trades a ledger
// integrity problem for code execution in every database pod.
//
// A third role costs one credential and neither of those.
export const MIGRATOR_USER = "drigodb_migrator";
export const DB_NAME = "app";
export const PASSWORD_SECRET_KEY = "password";

// The request is what the scheduler reserves, so it — not usage — decides how
// many databases fit on a node.
//
// Measured on DigitalOcean 2026-09-05 (#32): an idle database holds 102 MiB
// resident, of which 30 MiB is unshared. At 256Mi the scheduler was reserving
// ~2.5x that, and a 1500 MiB node fit two databases beside the control plane
// while a third would not schedule at all. The block-volume ceiling is 15 per
// node, so memory was binding at two — nowhere near it.
//
// 192Mi is measured idle plus ~90 MiB of headroom, and it moves the same node
// from two databases to three. The LIMIT is unchanged at 1Gi: this changes what
// is reserved for a database, never what it is allowed to use, so a busy one
// has exactly the room it had before.
const PG_CPU_REQUEST = "100m";
const PG_MEMORY_REQUEST = "192Mi";
const PG_MEMORY_LIMIT = "1Gi";
// Idle almost all the time; it streams a backup out on an interval and holds
// nothing between them. Requests are what the scheduler reserves, so keeping
// them small is what stops backups halving how many databases fit on a node.
const BACKUP_CPU_REQUEST = "10m";
const BACKUP_MEMORY_REQUEST = "32Mi";
const BACKUP_MEMORY_LIMIT = "256Mi";

export function statefulSetName(id: string): string {
  return `db-${id}`;
}

export function serviceName(id: string): string {
  return `db-${id}`;
}

export function secretName(id: string): string {
  return `db-${id}-credentials`;
}

export function migratorSecretName(id: string): string {
  return `db-${id}-migrator`;
}

export function restoreJobName(id: string): string {
  return `restore-${id}`;
}

// The Cluster carries the name a StatefulSet used to, so nothing that derives a
// hostname, a Secret name or an id from it has to change — and idempotent create
// keeps working the same way, because the name is still the lock.
export function clusterName(id: string): string {
  return `db-${id}`;
}

export function migrationJobName(id: string): string {
  return `migrate-${id}`;
}

export function labelsFor(id: string, externalId: string): Record<string, string> {
  return {
    [DB_ID_LABEL]: id,
    [EXTERNAL_ID_LABEL]: externalId,
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
  };
}

export function endpointHost(id: string): string {
  return `${serviceName(id)}.${config.databaseNamespace}.${config.endpointSuffix}`;
}

export function connectionUri(id: string, password: string): string {
  // The URI has to tell the truth about what the client can verify. With an
  // issuer configured each database serves a certificate for its own Service
  // name, so verify-full is honest; without one bootstrap.sh self-signs, and
  // promising verification a client cannot perform would only teach it to turn
  // verification off.
  const sslmode = serverAuthEnabled() ? "verify-full" : "require";
  return (
    `postgres://${DB_USER}:${encodeURIComponent(password)}@${endpointHost(id)}:${POSTGRES_PORT}/${DB_NAME}` +
    `?sslmode=${sslmode}`
  );
}

export function buildSecret(id: string, externalId: string, password: string): V1Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secretName(id),
      namespace: config.databaseNamespace,
      labels: labelsFor(id, externalId),
    },
    // basic-auth rather than Opaque, and it carries the username as well as the
    // password. CloudNativePG will not accept a credential Secret in any other
    // shape — bootstrap.initdb.secret and managed.roles both read `username`
    // and `password` from a kubernetes.io/basic-auth Secret.
    //
    // The username never varies. It is written anyway, because the alternative
    // is a Secret that is correct only because something else agrees about a
    // value it cannot see.
    type: "kubernetes.io/basic-auth",
    stringData: { [USERNAME_SECRET_KEY]: DB_USER, [PASSWORD_SECRET_KEY]: password },
  };
}

// The pod one database runs in. Split out from the StatefulSet because wake
// reconciles exactly this — it is the only part of a StatefulSet's spec that is
// mutable in a way that matters here, and the only part that carries the
// data-plane images.
export function buildPodTemplate(
  id: string,
  externalId: string,
  tier: Tier = "small",
): V1PodTemplateSpec {
  const labels = labelsFor(id, externalId);
  return {
    metadata: { labels },
    spec: {
      securityContext: {
        runAsUser: RUN_AS_USER,
        runAsGroup: RUN_AS_GROUP,
        fsGroup: RUN_AS_GROUP,
        // Without this, Kubernetes recursively chmods g+rwX on every mount.
        // initdb creates PGDATA as 0700 on first boot, and the next mount
        // turns it group-writable — which PostgreSQL refuses to start on
        // ("data directory has invalid permissions"). The database comes up
        // once and never wakes again. OnRootMismatch skips the recursion
        // when the volume root already has the right ownership.
        fsGroupChangePolicy: "OnRootMismatch",
      },
      automountServiceAccountToken: false,
      containers: [
        {
          name: "postgres",
          image: config.pgImage,
          // The image is a bare operand with no initialising entrypoint.
          command: ["bash", `${CONFIG_MOUNT_PATH}/bootstrap.sh`],
          env: [
            { name: "PGDATA", value: PGDATA },
            { name: "APP_DB_NAME", value: DB_NAME },
            { name: "APP_DB_USER", value: DB_USER },
            { name: "APP_DB_CONF_DIR", value: CONFIG_MOUNT_PATH },
            { name: "APP_DB_MIGRATIONS_DIR", value: MIGRATIONS_MOUNT_PATH },
            // Per-database, so it cannot come from drigodb-config — that is one
            // ConfigMap mounted by every database. bootstrap.sh writes it into
            // an include file inside PGDATA, ordered after the mounted config so
            // it wins.
            { name: "DRIGODB_MAX_WAL_SIZE", value: TIERS[tier].maxWalSize },
            {
              name: "APP_DB_PASSWORD",
              valueFrom: {
                secretKeyRef: { name: secretName(id), key: PASSWORD_SECRET_KEY },
              },
            },
          ],
          // Applications reach this directly now; there is no proxy in front.
          ports: [{ name: POSTGRES_PORT_NAME, containerPort: POSTGRES_PORT }],
          volumeMounts: [
            { name: DATA_VOLUME, mountPath: DATA_MOUNT_PATH },
            { name: SOCKET_VOLUME, mountPath: SOCKET_MOUNT_PATH },
            { name: "config", mountPath: CONFIG_MOUNT_PATH, readOnly: true },
            { name: "migrations", mountPath: MIGRATIONS_MOUNT_PATH, readOnly: true },
            ...(serverAuthEnabled()
              ? [{ name: TLS_VOLUME, mountPath: TLS_MOUNT_PATH, readOnly: true }]
              : []),
          ],
          readinessProbe: {
            exec: { command: ["pg_isready", "-U", "postgres", "-d", DB_NAME] },
            initialDelaySeconds: 5,
            periodSeconds: 5,
            failureThreshold: 12,
          },
          resources: {
            requests: { cpu: PG_CPU_REQUEST, memory: PG_MEMORY_REQUEST },
            limits: { memory: PG_MEMORY_LIMIT },
          },
        },
        // Only when there is somewhere to put a backup. With no bucket
        // configured the pod is exactly what it was before, rather than
        // carrying a container that cannot do its job.
        ...(backupsEnabled()
          ? [
              {
                // Backups run in the pod so that they need no credential and
                // no network path. The Service does now publish PostgreSQL's
                // port, but pg_hba admits only appuser over TLS into its own
                // database — a backup connecting that way would need a
                // credential of its own. Over the shared socket it authenticates
                // by peer as the pod's UID, which is the connection that already
                // works.
                //
                // No data volume. pg_dump streams over that socket, so mounting
                // the volume would only add a second path to the same bytes.
                name: "backup",
                image: config.backup.image,
                env: [
                  { name: "DRIGODB_DATABASE_ID", value: id },
                  { name: "DRIGODB_BACKUP_BUCKET", value: config.backup.bucket },
                  { name: "DRIGODB_BACKUP_ENDPOINT", value: config.backup.endpoint },
                  { name: "DRIGODB_BACKUP_INTERVAL", value: config.backup.intervalSeconds },
                  { name: "PGHOST", value: SOCKET_MOUNT_PATH },
                  { name: "APP_DB_NAME", value: DB_NAME },
                  {
                    name: "DRIGODB_BACKUP_KEY",
                    valueFrom: {
                      secretKeyRef: { name: config.backup.secretName, key: BACKUP_KEY_SECRET_KEY },
                    },
                  },
                  {
                    name: "DRIGODB_BACKUP_SECRET",
                    valueFrom: {
                      secretKeyRef: { name: config.backup.secretName, key: BACKUP_SECRET_SECRET_KEY },
                    },
                  },
                ],
                volumeMounts: [{ name: SOCKET_VOLUME, mountPath: SOCKET_MOUNT_PATH }],
                // Deliberately no probes. A readiness probe here would put
                // backups on the pod's Ready condition, and an unreachable
                // bucket would then take a working database out of its Service.
                // Backups must never be why a database is unreachable — the
                // container absorbs its own failures and logs them instead.
                resources: {
                  requests: { cpu: BACKUP_CPU_REQUEST, memory: BACKUP_MEMORY_REQUEST },
                  limits: { memory: BACKUP_MEMORY_LIMIT },
                },
              },
            ]
          : []),
      ],
      volumes: [
        { name: SOCKET_VOLUME, emptyDir: {} },
        // optional: the pod must start before cert-manager has issued anything,
        // or a database would wait on a certificate to serve traffic it could
        // serve without one. bootstrap.sh falls back to self-signing.
        ...(serverAuthEnabled()
          ? [{ name: TLS_VOLUME, secret: { secretName: tlsSecretName(id), optional: true, defaultMode: 0o640 } }]
          : []),
        {
          name: "config",
          // 0640 rather than 0644: these files are read by the pod's own UID
          // and group, and nothing else needs them.
          configMap: { name: CONFIG_MAP_NAME, defaultMode: 0o640 },
        },
        {
          name: "migrations",
          configMap: { name: MIGRATIONS_CONFIG_MAP_NAME, defaultMode: 0o640 },
        },
      ],
    },
  };
}

// Loads a dump into a freshly provisioned database.
//
// A Job, and an ORDINARY CONSUMER of the database rather than a privileged path
// into it. It connects over TCP to the Service with the app's own credentials,
// carrying the same `drigodb.io/allow-database` label any consumer opts in
// with, and holds nothing the isolation model does not already hand out. There
// is no socket to share — a Job is its own pod — and that is the point: a
// logical restore is a client executing SQL, so it should look like one.
//
// The alternative, running it inside the database pod, would mean the restore
// path needed the pod template to carry a one-shot instruction that every later
// wake would have to reason about. This leaves the template alone.
//
// ttlSecondsAfterFinished so a succeeded Job removes itself. A failed one stays
// until the database is deleted, because its logs are the only account of why a
// restore did not happen.
export function buildRestoreJob(
  id: string,
  externalId: string,
  source: string,
): V1Job {
  const labels = {
    ...labelsFor(id, externalId),
    // Opts this pod through the database's own NetworkPolicy — the same way a
    // consumer does, rather than by widening the policy for restores.
    [ALLOW_LABEL]: id,
  };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: restoreJobName(id), namespace: config.databaseNamespace, labels },
    spec: {
      backoffLimit: 3,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "OnFailure",
          automountServiceAccountToken: false,
          containers: [
            {
              name: "restore",
              image: config.backup.image,
              args: ["restore-remote"],
              env: [
                { name: "DRIGODB_DATABASE_ID", value: id },
                { name: "DRIGODB_RESTORE_SOURCE", value: source },
                { name: "DRIGODB_BACKUP_BUCKET", value: config.backup.bucket },
                { name: "DRIGODB_BACKUP_ENDPOINT", value: config.backup.endpoint },
                { name: "PGHOST", value: endpointHost(id) },
                { name: "PGPORT", value: String(POSTGRES_PORT) },
                { name: "PGUSER", value: DB_USER },
                { name: "PGDATABASE", value: DB_NAME },
                // require, not verify-full: the server self-signs, exactly as
                // it does for any other client. Issue #9 changes both together.
                { name: "PGSSLMODE", value: "require" },
                {
                  name: "PGPASSWORD",
                  valueFrom: { secretKeyRef: { name: secretName(id), key: PASSWORD_SECRET_KEY } },
                },
                {
                  name: "DRIGODB_BACKUP_KEY",
                  valueFrom: {
                    secretKeyRef: { name: config.backup.secretName, key: BACKUP_KEY_SECRET_KEY },
                  },
                },
                {
                  name: "DRIGODB_BACKUP_SECRET",
                  valueFrom: {
                    secretKeyRef: { name: config.backup.secretName, key: BACKUP_SECRET_SECRET_KEY },
                  },
                },
              ],
              resources: {
                requests: { cpu: BACKUP_CPU_REQUEST, memory: BACKUP_MEMORY_REQUEST },
                limits: { memory: BACKUP_MEMORY_LIMIT },
              },
            },
          ],
        },
      },
    },
  };
}

// A cert-manager Certificate for one database.
//
// The name it signs is the Service DNS a consumer is handed in its connection
// URI, so verify-full compares like with like. Anything else — the pod name,
// the StatefulSet name — would produce a certificate that validates against
// nothing a client actually connects to.
//
// Lives beside the control plane rather than beside the database: a namespaced
// Issuer can only be used from its own namespace, and the alternative is a
// ClusterIssuer that anything in the cluster could ask for a certificate from.
// The Secret is then mirrored into the database namespace by the provisioner.
export function buildCertificate(id: string, externalId: string): Record<string, unknown> {
  return {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: {
      name: tlsSecretName(id),
      namespace: config.tls.issuerNamespace,
      labels: labelsFor(id, externalId),
    },
    spec: {
      secretName: tlsSecretName(id),
      commonName: endpointHost(id),
      // The Service DNS in full, plus the short forms Kubernetes also resolves
      // it by — a consumer that connects by the shorter name is still
      // connecting to the same Service and should not fail verification for it.
      dnsNames: [
        endpointHost(id),
        `${serviceName(id)}.${config.databaseNamespace}.svc`,
        `${serviceName(id)}.${config.databaseNamespace}`,
      ],
      duration: config.tls.duration,
      renewBefore: config.tls.renewBefore,
      privateKey: { algorithm: "ECDSA", size: 256 },
      usages: ["server auth"],
      issuerRef: {
        name: config.tls.issuer,
        kind: config.tls.issuerKind,
        group: "cert-manager.io",
      },
    },
  };
}

// A stable fingerprint of the rendered pod template.
//
// Compared against the annotation on the live StatefulSet to decide whether a
// waking database needs its template rewritten. Deliberately not a comparison
// of the live spec against this one: the API server defaults dozens of fields
// the builder never sets — terminationMessagePath, dnsPolicy, schedulerName,
// imagePullPolicy — so live-versus-rendered always differs, and every wake
// would patch. Hashing compares desired against desired, which is the only
// comparison that holds still.
//
// Keys are sorted before hashing so the fingerprint tracks content rather than
// the order this file happens to declare things in. Reordering a field here
// would otherwise roll every database in the fleet for no reason.
export function templateHash(id: string, externalId: string, tier: Tier = "small"): string {
  return createHash("sha256")
    .update(canonical(buildPodTemplate(id, externalId, tier)))
    .digest("hex")
    .slice(0, 16);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function buildStatefulSet(id: string, externalId: string, tier: Tier = "small"): V1StatefulSet {
  const labels = { ...labelsFor(id, externalId), [TIER_LABEL]: tier };
  // On the StatefulSet only, never in labelsFor: a pod carrying a copy of
  // this would be stating something about its own StatefulSet that stopped
  // being true the moment it was scaled.
  const stsLabels = { ...labels, [HIBERNATED_LABEL]: "false" };
  return {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: {
      name: statefulSetName(id),
      namespace: config.databaseNamespace,
      labels: stsLabels,
      // Stamped at birth so a database created by this build is already
      // current, and its first wake reconciles nothing.
      annotations: { [TEMPLATE_HASH_ANNOTATION]: templateHash(id, externalId, tier) },
    },
    spec: {
      serviceName: serviceName(id),
      // Zero is hibernation: pods go, the volume stays.
      replicas: 0,
      selector: { matchLabels: { [DB_ID_LABEL]: id } },
      // Stated explicitly: the alternative silently deletes a customer's data.
      persistentVolumeClaimRetentionPolicy: { whenScaled: "Retain", whenDeleted: "Retain" },
      template: buildPodTemplate(id, externalId, tier),
      volumeClaimTemplates: [
        {
          metadata: { name: DATA_VOLUME, labels },
          spec: {
            accessModes: ["ReadWriteOnce"],
            // Omitted when unset, never sent as "". Those mean opposite things:
            // an empty string tells Kubernetes to use NO storage class and bind
            // a pre-provisioned volume, while an absent field means "use the
            // cluster's default". Portability depends on the second — kind,
            // EKS and GKE each have their own default, and drigodb should not
            // need to know which.
            ...(config.storageClass ? { storageClassName: config.storageClass } : {}),
            // The tier's size at creation. Immutable afterwards, which is why
            // a resize patches the PVC directly and this permanently disagrees
            // with it. The PVC is the truth.
            resources: { requests: { storage: TIERS[tier].storage } },
          },
        },
      ],
    },
  };
}

// A hosted database, as CloudNativePG sees it. Decision 0004.
//
// This replaces buildStatefulSet, and with it most of what drigodb used to
// assemble by hand — the pod template, the probes, the volume claim, the
// fsGroup, bootstrap.sh. The operator owns all of that now. What is left here is
// the part that is drigodb's product rather than PostgreSQL's mechanics: the
// tier, the credential, the labels the network boundary selects on, and the name
// that makes create idempotent.
//
// Every field below was verified against CNPG 1.27 on a real cluster before it
// was written, because several plausible-looking spellings do nothing.
export function buildCluster(id: string, externalId: string, tier: Tier = "small"): object {
  const labels = { ...labelsFor(id, externalId), [TIER_LABEL]: tier };
  return {
    apiVersion: `${CNPG_GROUP}/v1`,
    kind: "Cluster",
    metadata: {
      name: clusterName(id),
      namespace: config.databaseNamespace,
      // Hibernation is an intent, and it is read from this label rather than
      // from the annotation CNPG acts on, for the same reason it was read from a
      // label rather than a replica count before: a create is also "not
      // running", and telling a concurrent caller its database was hibernated
      // was wrong in exactly the case the label exists to distinguish.
      labels: { ...labels, [HIBERNATED_LABEL]: "false" },
    },
    spec: {
      instances: 1,
      imageName: config.pgImage,

      // What makes the NetworkPolicy keep working. Without this the pods carry
      // only CNPG's own labels, the policy's podSelector matches nothing, and
      // every database becomes unreachable — silently, because a NetworkPolicy
      // denies by dropping packets.
      inheritedMetadata: {
        labels: { [DB_ID_LABEL]: id, [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
      },

      storage: {
        size: TIERS[tier].storage,
        // Omitted when unset, never sent as "". Those mean opposite things: an
        // empty string binds a pre-provisioned volume with NO storage class,
        // while an absent field means the cluster default. Portability depends
        // on the second.
        ...(config.storageClass ? { storageClass: config.storageClass } : {}),
      },

      postgresql: { parameters: { max_wal_size: TIERS[tier].maxWalSize } },

      resources: {
        requests: { cpu: PG_CPU_REQUEST, memory: PG_MEMORY_REQUEST },
        limits: { memory: PG_MEMORY_LIMIT },
      },

      bootstrap: {
        initdb: {
          database: DB_NAME,
          owner: DB_USER,
          // Creates the migration role and gives it the one privilege it needs:
          // CREATE on the database, so it can own _drigodb. Its password is set
          // by managed.roles below, which reconciles after bootstrap.
          //
          // These run as postgres in the application database — verified, not
          // assumed; CNPG logs the user it used and it is not the owner.
          //
          // Dollar-quoted with a TAG. Plain `$$` arrives here as a single `$`
          // and fails to parse, which is the same mangling that stopped
          // migrations from being carried this way at all. A tag survives it.
          postInitApplicationSQL: [
            `DO $mig$ BEGIN
               IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${MIGRATOR_USER}') THEN
                 CREATE ROLE ${MIGRATOR_USER} LOGIN;
               END IF;
             END $mig$`,
            `GRANT CREATE ON DATABASE ${DB_NAME} TO ${MIGRATOR_USER}`,
          ],
          // drigodb's own credential, not one CNPG invents. The URI is issued
          // from this Secret, so the server has to be created with it.
          //
          // Read at initdb and never again — which is why managed.roles below
          // exists. Changing this Secret alone rotates nothing, and the old
          // password goes on working. Measured, not assumed.
          secret: { name: secretName(id) },
        },
      },

      // The rotation path. CNPG reconciles the role against this Secret
      // continuously, so replacing the Secret is what changes the password —
      // and the old one stops being accepted, which is the half that matters.
      //
      // postInitApplicationSQL is deliberately NOT used for migrations: it
      // mangles `$$`, arriving as a single `$`, and 001-core.sql contains a
      // dollar-quoted function body. That file is frozen by checksum and cannot
      // be rewritten to suit it. See buildMigrationJob.
      managed: {
        roles: [
          {
            name: DB_USER,
            login: true,
            passwordSecret: { name: secretName(id) },
          },
          // Declared as well as created above: bootstrap makes the role exist,
          // this is what gives it a password and keeps it in step with the
          // Secret. Neither alone is enough — a role with no password cannot log
          // in, and a declared role that does not exist yet cannot be granted to
          // at bootstrap.
          {
            name: MIGRATOR_USER,
            login: true,
            passwordSecret: { name: migratorSecretName(id) },
          },
        ],
      },
    },
  };
}

// Apply drigodb's migrations to a database that is already running.
//
// A Job rather than an init hook, because CNPG's hooks run once at creation and
// migrations have to reach databases that already exist — that is the whole
// point of a forward-only migration runner, and today it happens on every start
// of bootstrap.sh. One mechanism has to cover both.
//
// It connects over TCP as an ordinary consumer, carrying the allow-label like
// any other client, so the network boundary applies to drigodb's own tooling
// exactly as it does to a consumer.
export function buildMigrationJob(id: string, externalId: string): V1Job {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: migrationJobName(id),
      namespace: config.databaseNamespace,
      labels: labelsFor(id, externalId),
    },
    spec: {
      // Retried, because the database may not be accepting connections the
      // instant the Cluster reports ready.
      backoffLimit: 6,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: { ...labelsFor(id, externalId), [ALLOW_LABEL]: id } },
        spec: {
          restartPolicy: "Never",
          containers: [
            {
              name: "migrate",
              image: config.pgImage,
              env: [
                { name: "PGHOST", value: endpointHost(id) },
                { name: "PGPORT", value: String(POSTGRES_PORT) },
                { name: "PGDATABASE", value: DB_NAME },
                { name: "PGUSER", value: MIGRATOR_USER },
                // Who to hand read access to once the ledger exists. The runner
                // owns _drigodb; the application gets USAGE and SELECT and
                // nothing more, which is what it had before this moved.
                { name: "APP_USER", value: DB_USER },
                { name: "PGSSLMODE", value: "require" },
                {
                  name: "PGPASSWORD",
                  valueFrom: {
                    secretKeyRef: { name: migratorSecretName(id), key: PASSWORD_SECRET_KEY },
                  },
                },
                { name: "MIGRATIONS_DIR", value: MIGRATIONS_MOUNT_PATH },
              ],
              volumeMounts: [
                { name: "migrations", mountPath: MIGRATIONS_MOUNT_PATH, readOnly: true },
                { name: "runner", mountPath: "/drigodb-bin", readOnly: true },
              ],
              command: ["bash", "/drigodb-bin/migrate.sh"],
            },
          ],
          volumes: [
            { name: "migrations", configMap: { name: MIGRATIONS_CONFIG_MAP_NAME, defaultMode: 0o644 } },
            { name: "runner", configMap: { name: CONFIG_MAP_NAME, defaultMode: 0o755 } },
          ],
        },
      },
    },
  };
}

// The migration runner's credential. Never leaves drigodb: it is not in any
// connection URI and no consumer is told it exists.
export function buildMigratorSecret(id: string, externalId: string, password: string): V1Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: migratorSecretName(id),
      namespace: config.databaseNamespace,
      labels: labelsFor(id, externalId),
    },
    type: "kubernetes.io/basic-auth",
    stringData: { [USERNAME_SECRET_KEY]: MIGRATOR_USER, [PASSWORD_SECRET_KEY]: password },
  };
}

export function buildService(id: string, externalId: string): V1Service {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: serviceName(id),
      namespace: config.databaseNamespace,
      labels: labelsFor(id, externalId),
    },
    spec: {
      type: "ClusterIP",
      // CNPG's labels, not drigodb's, and deliberately.
      //
      // The pods carry drigodb's database-id too (inheritedMetadata), but that
      // would match every instance. This matches only whichever pod is CURRENTLY
      // primary, which is what makes the connection URI survive a failover: the
      // hostname a consumer wrote down stays the same and the endpoint behind it
      // moves. It is also why opt-in HA (#81) needs nothing here.
      //
      // drigodb keeps its own Service rather than pointing the URI at CNPG's
      // `-rw` one, because the URI is issued once and never reissued. Adopting
      // their name would rename every consumer's endpoint.
      selector: {
        "cnpg.io/cluster": clusterName(id),
        "cnpg.io/instanceRole": "primary",
      },
      ports: [
        {
          name: POSTGRES_PORT_NAME,
          port: POSTGRES_PORT,
          // The NUMBER, not the name. drigodb used to own the pod template and
          // could rely on the port being called what it called it; CloudNativePG
          // owns it now and calls it `postgresql`. A named targetPort that does
          // not resolve produces no endpoints at all, so every connection to a
          // database hangs until TCP gives up — the same symptom as a
          // NetworkPolicy drop, and just as silent.
          //
          // CNPG's own -rw Service targets the number for the same reason: a
          // port name is somebody else's contract, and a number is not.
          targetPort: POSTGRES_PORT,
          protocol: "TCP",
        },
      ],
    },
  };
}

// Default-deny with an explicit opt-in: only pods labelled
// `drigodb.io/allow-database: <id>` may connect, in any namespace.
//
// Treated as the weakest of the three isolation layers. It fails open if its
// selector stops matching, `kubectl port-forward` bypasses it entirely, and a
// CNI that ignores NetworkPolicy makes it a silent no-op. The separate instance
// and the per-database credentials hold independently of it.
export function buildNetworkPolicy(id: string, externalId: string): V1NetworkPolicy {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: statefulSetName(id),
      namespace: config.databaseNamespace,
      labels: labelsFor(id, externalId),
    },
    spec: {
      podSelector: { matchLabels: { [DB_ID_LABEL]: id } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          // `_from`, not `from`: the generated client renames the field and maps
          // it back on serialization. A raw JSON.stringify emits `_from`, which
          // the API server ignores, leaving a rule that denies everything.
          _from: [
            {
              namespaceSelector: {},
              podSelector: { matchLabels: { [ALLOW_LABEL]: id } },
            },
          ],
          ports: [{ protocol: "TCP", port: POSTGRES_PORT }],
        },
      ],
    },
  };
}
