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
  V1NetworkPolicy,
  V1PodTemplateSpec,
  V1Secret,
  V1Service,
  V1StatefulSet,
} from "@kubernetes/client-node";

import { backupsEnabled, config } from "../config.js";

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

export const POSTGRES_PORT = 5432;
export const POSTGRES_PORT_NAME = "postgres";

export const BACKUP_KEY_SECRET_KEY = "access_key";
export const BACKUP_SECRET_SECRET_KEY = "secret_key";

export const DB_USER = "appuser";
export const DB_NAME = "app";
export const PASSWORD_SECRET_KEY = "password";

// Sized from measurement on an idle, freshly initialised database: PostgreSQL
// settled at 110 MiB. Requests keep headroom because that workload was empty.
// Re-measurement after the migration is issue #32.
const PG_CPU_REQUEST = "100m";
const PG_MEMORY_REQUEST = "256Mi";
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
  return (
    `postgres://${DB_USER}:${encodeURIComponent(password)}@${endpointHost(id)}:${POSTGRES_PORT}/${DB_NAME}` +
    // require, not verify-full: bootstrap.sh generates a self-signed
    // certificate, so a client can encrypt but cannot verify. A real issuer is
    // issue #9, and it is what turns this into verify-full.
    `?sslmode=require`
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
    type: "Opaque",
    stringData: { [PASSWORD_SECRET_KEY]: password },
  };
}

// The pod one database runs in. Split out from the StatefulSet because wake
// reconciles exactly this — it is the only part of a StatefulSet's spec that is
// mutable in a way that matters here, and the only part that carries the
// data-plane images.
export function buildPodTemplate(id: string, externalId: string): V1PodTemplateSpec {
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
export function templateHash(id: string, externalId: string): string {
  return createHash("sha256").update(canonical(buildPodTemplate(id, externalId))).digest("hex").slice(0, 16);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function buildStatefulSet(id: string, externalId: string): V1StatefulSet {
  const labels = labelsFor(id, externalId);
  return {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: {
      name: statefulSetName(id),
      namespace: config.databaseNamespace,
      labels,
      // Stamped at birth so a database created by this build is already
      // current, and its first wake reconciles nothing.
      annotations: { [TEMPLATE_HASH_ANNOTATION]: templateHash(id, externalId) },
    },
    spec: {
      serviceName: serviceName(id),
      // Zero is hibernation: pods go, the volume stays.
      replicas: 0,
      selector: { matchLabels: { [DB_ID_LABEL]: id } },
      // Stated explicitly: the alternative silently deletes a customer's data.
      persistentVolumeClaimRetentionPolicy: { whenScaled: "Retain", whenDeleted: "Retain" },
      template: buildPodTemplate(id, externalId),
      volumeClaimTemplates: [
        {
          metadata: { name: DATA_VOLUME, labels },
          spec: {
            accessModes: ["ReadWriteOnce"],
            storageClassName: config.storageClass,
            resources: { requests: { storage: config.storageSize } },
          },
        },
      ],
    },
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
      selector: { [DB_ID_LABEL]: id },
      ports: [
        {
          name: POSTGRES_PORT_NAME,
          port: POSTGRES_PORT,
          targetPort: POSTGRES_PORT_NAME,
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
