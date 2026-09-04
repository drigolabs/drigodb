// Kubernetes objects for one hosted database.
//
// A database is a PostgreSQL instance running the DocumentDB extension, plus a
// MongoDB wire-protocol gateway, in a single pod. The two containers share a
// pod out of necessity: the gateway reaches PostgreSQL only over a Unix socket
// with peer auth, so they must share a filesystem.
//
// One instance per database is not a preference either — DocumentDB cannot
// isolate tenants within an instance. See docs/documentdb-multitenancy-spike.md.

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

// PostgreSQL's UID in the drigodb-postgres image. The gateway must run as the
// same UID: PostgreSQL resolves the peer's UID against its own passwd database,
// and a mismatch fails every connection.
export const RUN_AS_USER = 26;

export const SOCKET_VOLUME = "socket";
export const SOCKET_MOUNT_PATH = "/sockets";
export const DATA_VOLUME = "data";
export const DATA_MOUNT_PATH = "/var/lib/postgresql/data";
export const PGDATA = `${DATA_MOUNT_PATH}/pgdata`;

// The gateway writes a self-signed certificate at startup. The volume is
// mounted over its whole state directory, not the tls subdirectory: the image
// ships that directory drwxrwx--- owned by its packaged user, which the pod's
// UID cannot traverse, and fsGroup fixes a mounted volume rather than the image
// directory above it.
export const GATEWAY_STATE_VOLUME = "gateway-state";
export const GATEWAY_STATE_DIR = "/var/lib/documentdb-gateway";
export const GATEWAY_TLS_DIR = `${GATEWAY_STATE_DIR}/tls`;

export const MONGO_PORT = 27017;
export const GATEWAY_PORT = 10260;
export const GATEWAY_PORT_NAME = "mongo";

export const BACKUP_KEY_SECRET_KEY = "access_key";
export const BACKUP_SECRET_SECRET_KEY = "secret_key";

export const DB_USER = "appuser";
export const DB_NAME = "app";
export const PASSWORD_SECRET_KEY = "password";

// Sized from measurement on an idle, freshly initialised database: PostgreSQL
// settled at 110 MiB, the gateway at 4 MiB. Requests keep headroom because that
// workload was empty.
const PG_CPU_REQUEST = "100m";
const PG_MEMORY_REQUEST = "256Mi";
const PG_MEMORY_LIMIT = "1Gi";
const GATEWAY_CPU_REQUEST = "50m";
const GATEWAY_MEMORY_REQUEST = "32Mi";
const GATEWAY_MEMORY_LIMIT = "256Mi";
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
    `mongodb://${DB_USER}:${encodeURIComponent(password)}@${endpointHost(id)}:${MONGO_PORT}/` +
    // The gateway presents a self-signed certificate. A real issuer arrives
    // with public endpoints; until then clients must accept it.
    `?tls=true&tlsAllowInvalidCertificates=true&directConnection=true`
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
        runAsGroup: RUN_AS_USER,
        fsGroup: RUN_AS_USER,
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
            {
              name: "APP_DB_PASSWORD",
              valueFrom: {
                secretKeyRef: { name: secretName(id), key: PASSWORD_SECRET_KEY },
              },
            },
          ],
          volumeMounts: [
            { name: DATA_VOLUME, mountPath: DATA_MOUNT_PATH },
            { name: SOCKET_VOLUME, mountPath: SOCKET_MOUNT_PATH },
            { name: "config", mountPath: CONFIG_MOUNT_PATH, readOnly: true },
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
        {
          name: "gateway",
          image: config.gatewayImage,
          env: [
            { name: "DOCUMENTDB_PG_URL_FILE", value: `${CONFIG_MOUNT_PATH}/pg_url` },
            { name: "DOCUMENTDB_TLS_STATE_DIR", value: GATEWAY_TLS_DIR },
          ],
          ports: [{ name: GATEWAY_PORT_NAME, containerPort: GATEWAY_PORT }],
          volumeMounts: [
            { name: SOCKET_VOLUME, mountPath: SOCKET_MOUNT_PATH },
            { name: "config", mountPath: CONFIG_MOUNT_PATH, readOnly: true },
            { name: GATEWAY_STATE_VOLUME, mountPath: GATEWAY_STATE_DIR },
          ],
          // Two probes, because they answer different questions and only
          // both together mean "a client can connect".
          //
          // `check` verifies the backend is reachable and the extension is
          // loaded. It says nothing about whether the gateway has bound its
          // listener — it passes while the socket is still closed, which
          // showed up as `connection refused` from a client the moment the
          // pod reported Ready.
          startupProbe: {
            exec: { command: ["/usr/bin/documentdb-gateway", "check"] },
            periodSeconds: 3,
            failureThreshold: 40,
          },
          // Readiness is the listener actually accepting.
          readinessProbe: {
            tcpSocket: { port: GATEWAY_PORT_NAME },
            periodSeconds: 3,
            failureThreshold: 10,
          },
          resources: {
            requests: { cpu: GATEWAY_CPU_REQUEST, memory: GATEWAY_MEMORY_REQUEST },
            limits: { memory: GATEWAY_MEMORY_LIMIT },
          },
        },
        // Only when there is somewhere to put a backup. With no bucket
        // configured the pod is exactly what it was before, rather than
        // carrying a container that cannot do its job.
        ...(backupsEnabled()
          ? [
              {
                // Backups run in the pod because nothing outside it can reach
                // PostgreSQL: pg_hba admits TCP from localhost only, and the
                // Service publishes the gateway's port. Sharing the pod means
                // sharing the socket, which is the connection that already
                // works and needs no new credential.
                //
                // No data volume. pg_basebackup streams over that socket, so
                // mounting the volume would only add a second path to the bytes
                // being copied.
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
        { name: GATEWAY_STATE_VOLUME, emptyDir: {} },
        {
          name: "config",
          // 0640 rather than 0644: the gateway warns when its URL file is
          // world-readable.
          configMap: { name: CONFIG_MAP_NAME, defaultMode: 0o640 },
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
          name: GATEWAY_PORT_NAME,
          port: MONGO_PORT,
          targetPort: GATEWAY_PORT_NAME,
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
          ports: [{ protocol: "TCP", port: GATEWAY_PORT }],
        },
      ],
    },
  };
}
