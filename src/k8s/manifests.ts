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

import { config, serverAuthEnabled } from "../config.js";

export const DB_ID_LABEL = "drigodb.io/database-id";
export const EXTERNAL_ID_LABEL = "drigodb.io/external-id";
export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
export const MANAGED_BY_VALUE = "drigodb";

// A consumer pod carrying this label may reach the named database. It works
// across namespaces, so consumers need not live anywhere in particular.
export const ALLOW_LABEL = "drigodb.io/allow-database";


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
  return `${DATA_VOLUME}-${clusterName(id)}-0`;
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

// PostgreSQL's UID and GID in CNPG's image: `uid=26(postgres) gid=102(postgres)`.
//
// The GID is not 26. It was under our own image, and carrying that assumption
// across would leave PGDATA group-owned by a group the server does not belong
// to. Kept because the UID and GID a database runs as are a property of the
// shared socket resolves the caller's UID against the server's passwd database
// and a mismatch fails every connection.
//
// Group 101 (ssl-cert) is deliberately NOT requested. It is how the image's
// snakeoil TLS key is readable, but Kubernetes does not grant a pod the image's
// group memberships, so using that key would mean pinning supplementalGroups to
// an image-specific gid. bootstrap.sh generates a certificate instead.
export const RUN_AS_USER = 26;
export const RUN_AS_GROUP = 102;

// A Unix socket directory on the pod. CloudNativePG mounts its own; this
// authenticates by peer. It outlived the gateway it was introduced for: a
// constant survives only because the NetworkPolicy tests name it.
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


export const DB_USER = "appuser";

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
// The floor for WAL, carried from the postgresql.conf that used to be mounted.
// Unlike max_wal_size it does not vary by tier: it is a floor on checkpoint
// churn, not a ceiling on volume.
const MIN_WAL_SIZE = "64MB";

const PG_CPU_REQUEST = "100m";
const PG_MEMORY_REQUEST = "192Mi";
const PG_MEMORY_LIMIT = "1Gi";


export function serviceName(id: string): string {
  return `db-${id}`;
}

export function secretName(id: string): string {
  return `db-${id}-credentials`;
}



// The Cluster carries the name a StatefulSet used to, so nothing that derives a
// hostname, a Secret name or an id from it has to change — and idempotent create
// keeps working the same way, because the name is still the lock.
export function clusterName(id: string): string {
  return `db-${id}`;
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
export interface CnpgClusterSpec {
  instances: number;
  imageName: string;
  inheritedMetadata: { labels: Record<string, string> };
  storage: { size: string; storageClass?: string };
  postgresql: { parameters: Record<string, string>; pg_hba: string[] };
  certificates?: { serverCASecret: string; serverTLSSecret: string };
  resources: object;
  bootstrap: { initdb: { database: string; owner: string; secret: { name: string } } };
  managed: { roles: Array<{ name: string; login: boolean; passwordSecret: { name: string } }> };
}

// Typed rather than `object`, so a field renamed here fails at compile time in
// the tests that assert it. Several of these were established against a live
// cluster because a plausible-looking spelling silently does nothing.
export interface CnpgClusterManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  spec: CnpgClusterSpec;
}

export function buildCluster(
  id: string,
  externalId: string,
  tier: Tier = "small",
): CnpgClusterManifest {
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

      // The server identity a consumer verifies, when this installation issues
      // one. Measured against CNPG 1.27, including the two negatives:
      //
      //   verify-full, drigodb's Service name, drigodb's CA   →  connects
      //   the same URI with no CA supplied                    →  refused
      //   CNPG's own -rw name against drigodb's CA            →  refused
      //
      // Without this, CloudNativePG signs its own certificate from a CA it
      // generates PER CLUSTER, naming only its own -rw/-ro/-r Services. The
      // connection URI names drigodb's Service, which is not among them — so
      // verify-full would fail hostname verification on every database while
      // sslmode=require went on passing, which is how nobody would notice.
      //
      // The CA secret must NOT be named `<cluster>-ca`: that is where
      // CloudNativePG keeps its own CLIENT CA, and taking the name leaves it
      // looking for a private key that was never put there. drigodb owns the
      // server identity, the operator keeps its internal ones, and the fleet
      // CA's private key never has to reach this namespace.
      ...(serverAuthEnabled()
        ? {
            certificates: {
              serverCASecret: config.tls.caSecret,
              serverTLSSecret: tlsSecretName(id),
            },
          }
        : {}),

      postgresql: {
        parameters: {
          max_wal_size: TIERS[tier].maxWalSize,
          // Carried over from the postgresql.conf drigodb used to mount. The
          // rest of that file — listen_addresses, the socket directory, the ssl
          // settings — is the operator's business now and it sets them itself.
          min_wal_size: MIN_WAL_SIZE,
        },
        // TLS or nothing, for the one route a consumer can take.
        //
        // CloudNativePG's default pg_hba ends `host all all all scram-sha-256`
        // — plain `host`, so a client passing sslmode=disable connects in the
        // clear. drigodb's own pg_hba was `hostssl` and had no such path.
        // Measured on kind: without these two lines, a plaintext connection to a
        // hosted database is accepted.
        //
        // It would have shipped silently. Every test connects with
        // sslmode=require and passes whether or not plaintext is also allowed;
        // nothing asks the opposite question.
        //
        // Scoped to the application database and role rather than `all`, because
        // a blanket reject would sit in front of the rules CloudNativePG writes
        // for its own instance manager and for streaming replication.
        pg_hba: [
          `hostssl ${DB_NAME} ${DB_USER} all scram-sha-256`,
          `host ${DB_NAME} ${DB_USER} all reject`,
        ],
      },

      resources: {
        requests: { cpu: PG_CPU_REQUEST, memory: PG_MEMORY_REQUEST },
        limits: { memory: PG_MEMORY_LIMIT },
      },

      bootstrap: {
        initdb: {
          database: DB_NAME,
          owner: DB_USER,
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
        ],
      },
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
      name: clusterName(id),
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
