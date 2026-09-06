// Provisioning operations against Kubernetes.
//
// Kubernetes is the source of truth. There is no control-plane database: a
// hosted database *is* its StatefulSet, and the caller's own identifier lives on
// it as a label. That keeps v0.0.1 to one moving part, and makes idempotency a
// label lookup rather than a transaction.

import { createHash, randomBytes } from "node:crypto";
import {
  AppsV1Api,
  BatchV1Api,
  CustomObjectsApi,
  CoreV1Api,
  KubeConfig,
  NetworkingV1Api,
  PatchStrategy,
  setHeaderOptions,
} from "@kubernetes/client-node";
import type { V1Job, V1StatefulSet } from "@kubernetes/client-node";
import type { Tier } from "./manifests.js";

import { backupsEnabled, config, serverAuthEnabled } from "../config.js";
import type { BackupObject } from "../backups/s3.js";
import { BackupStorageError, listObjects, regionFromEndpoint } from "../backups/s3.js";
import {
  BACKUP_KEY_SECRET_KEY,
  BACKUP_SECRET_SECRET_KEY,
  TIERS,
  TIER_LABEL,
  TIER_ORDER,
  DB_ID_LABEL,
  CLUSTERS_PLURAL,
  CNPG_GROUP,
  CNPG_HIBERNATION_ANNOTATION,
  EXTERNAL_ID_LABEL,
  HIBERNATED_LABEL,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  POSTGRES_PORT,
  TEMPLATE_HASH_ANNOTATION,
  buildNetworkPolicy,
  buildPodTemplate,
  buildCertificate,
  buildRestoreJob,
  buildCluster,
  buildMigrationJob,
  buildMigratorSecret,
  buildSecret,
  buildService,
  buildStatefulSet,
  connectionUri,
  endpointHost,
  pvcName,
  restoreJobName,
  tierOf,
  tlsSecretName,
  secretName,
  serviceName,
  clusterName,
  migrationJobName,
  migratorSecretName,
  statefulSetName,
  templateHash,
} from "./manifests.js";

// "restoring" is deliberately NOT "ready". A restored database answers on its
// port before its data has landed, and a caller that connected then would see
// an empty database — and any write it made would leave the restore to find a
// non-empty target and skip. The status is what stops that race.
export type DatabaseStatus =
  | "provisioning"
  // Running, and not usable yet: the server accepts connections but drigodb's
  // migrations have not finished. Distinct from `restoring`, which is data
  // arriving, and from `failed`, which is a migration that will not finish.
  | "migrating"
  | "restoring"
  | "ready"
  | "hibernated"
  | "failed";

export type Database = {
  id: string;
  external_id: string;
  status: DatabaseStatus;
  tier: Tier;
  endpoint: string;
  port: number;
  created_at?: string;
};

// Kubernetes label values: alphanumeric, with dashes, underscores and dots
// permitted inside. Callers get a 400 rather than a confusing API-server error.
const EXTERNAL_ID_RE = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;

// The slice of a CloudNativePG Cluster drigodb reads.
//
// Deliberately not the operator's full type. drigodb depends on four fields, and
// writing them down is what keeps a CNPG upgrade from being able to change
// something this code silently relied on.
interface CnpgCluster {
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
  };
  spec?: { instances?: number; storage?: { size?: string } };
  status?: { readyInstances?: number; phase?: string };
}

export class ValidationError extends Error {}
export class NotFoundError extends Error {}
// "Backups are off" is a different answer from "there are none", and a caller
// acting on the second when the first is true would be wrong.
export class BackupsDisabledError extends Error {}
// The storage layer refused to grow the volume. Almost always a StorageClass
// with allowVolumeExpansion: false, which is the operator's to change and not
// something drigodb can work around.
export class ResizeRefusedError extends Error {}

// A create landed on an id whose previous database is still being deleted.
//
// Only reachable because ids are derived from external_id: delete-then-recreate
// now lands on the same StatefulSet name and the same volume name, where random
// ids gave it a fresh one every time. Retryable, and a caller that waits a few
// seconds gets a clean database.
export class DeletionInFlightError extends Error {}

// Object keys are written by this service, so anything that is not one of ours
// is a caller mistake or an attempt to read another prefix. Both are 400s.
const RESTORE_KEY_RE = /^\d{8}T\d{6}Z\.sql\.gz$/;
const DB_ID_RE = /^[0-9a-f]{12}$/;

export function validateRestoreFrom(
  value: unknown,
): { databaseId: string; key: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new ValidationError("restore_from must be an object");
  const { database_id: dbId, key } = value as { database_id?: unknown; key?: unknown };

  if (typeof dbId !== "string" || !DB_ID_RE.test(dbId)) {
    throw new ValidationError("restore_from.database_id must be a database id");
  }
  // A key is joined onto a bucket prefix, so a traversal here would read
  // another database's backups. Matching the exact shape this service writes is
  // a tighter check than rejecting "..", and needs no reasoning about encoding.
  if (typeof key !== "string" || !RESTORE_KEY_RE.test(key)) {
    throw new ValidationError("restore_from.key must be a backup key, e.g. 20260905T040000Z.sql.gz");
  }
  return { databaseId: dbId, key };
}

// Falls back rather than throwing on a bad value: a typo in an operator's env
// must not stop every provision, and small is the safe direction to be wrong in.
function defaultTier(): Tier {
  const t = config.defaultTier;
  return TIER_ORDER.includes(t as Tier) ? (t as Tier) : "small";
}

export function validateTier(value: unknown): Tier {
  if (typeof value !== "string" || !TIER_ORDER.includes(value as Tier)) {
    throw new ValidationError(`tier must be one of ${TIER_ORDER.join(", ")}`);
  }
  return value as Tier;
}

export function validateExternalId(value: unknown): string {
  if (typeof value !== "string" || !EXTERNAL_ID_RE.test(value)) {
    throw new ValidationError(
      "external_id must be 1-63 characters of letters, digits, '-', '_' or '.', " +
        "starting and ending alphanumeric",
    );
  }
  return value;
}

// Derived from external_id rather than random, and that is what makes create
// safe on more than one replica.
//
// Idempotency was a read-then-create with no lock: two replicas handling the
// same external_id both find nothing and both create, which is precisely the
// failure idempotency exists to prevent. There is no lock to take — so the
// StatefulSet's NAME becomes one, because Kubernetes will not create two objects
// with the same name and tells the loser so.
//
// Twelve hex characters, the same shape the random id had, so nothing that
// consumes an id can tell the difference.
//
// THE TRADE: an id is now derivable by anyone who knows the external_id, where
// before it was unguessable. That weakens the NetworkPolicy layer against
// someone who knows both — they could label a pod and reach the Service. It does
// not get them in: the password is the real gate, and the README already records
// the network layer as the one trusted least. #72, which makes a database belong
// to the token that created it, is the control that actually replaces this.
function idFor(externalId: string): string {
  return createHash("sha256").update(externalId).digest("hex").slice(0, 12);
}

function newPassword(): string {
  return randomBytes(24).toString("base64url");
}

function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: number; statusCode?: number })?.code
    ?? (err as { statusCode?: number })?.statusCode;
  return code === 409;
}

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: number; statusCode?: number })?.code
    ?? (err as { statusCode?: number })?.statusCode;
  return code === 404;
}

export class Provisioner {
  constructor(
    private readonly apps: AppsV1Api,
    private readonly core: CoreV1Api,
    private readonly net: NetworkingV1Api,
    private readonly batch: BatchV1Api,
    private readonly objects: CustomObjectsApi,
  ) {}

  static fromCluster(): Provisioner {
    const kc = new KubeConfig();
    // Detect in-cluster by the environment the kubelet injects, rather than by
    // catching a failure: loadFromCluster() does not throw outside a cluster,
    // it silently yields a config whose server is undefined, and the first API
    // call then fails with `Invalid URL: https://undefined:undefined/...`.
    if (process.env.KUBERNETES_SERVICE_HOST) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }

    const cluster = kc.getCurrentCluster();
    if (!cluster?.server) {
      throw new Error(
        "no Kubernetes cluster in context — set KUBECONFIG, or run inside a pod with a service account",
      );
    }
    return new Provisioner(
      kc.makeApiClient(AppsV1Api),
      kc.makeApiClient(CoreV1Api),
      kc.makeApiClient(NetworkingV1Api),
      kc.makeApiClient(BatchV1Api),
      kc.makeApiClient(CustomObjectsApi),
    );
  }

  // The shape drigodb reads out of a CNPG Cluster. Narrow on purpose: the
  // operator's status has a great deal in it and depending on more of it than
  // this would make every CNPG upgrade a risk.
  private async clusterFor(id: string): Promise<CnpgCluster | undefined> {
    try {
      return (await this.objects.getNamespacedCustomObject({
        group: CNPG_GROUP,
        version: "v1",
        namespace: config.databaseNamespace,
        plural: CLUSTERS_PLURAL,
        name: clusterName(id),
      })) as CnpgCluster;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  private async statusOf(
    id: string,
    labels: Record<string, string>,
    cluster: CnpgCluster,
  ): Promise<DatabaseStatus> {
    // Hibernation is an intent, so it is read from the label that records the
    // intent rather than from what the operator has done about it yet. A create
    // is also "no instances running", and telling a concurrent caller its
    // database was hibernated was wrong in exactly the case this distinguishes.
    if (labels[HIBERNATED_LABEL] === "true") return "hibernated";

    const ready = cluster.status?.readyInstances ?? 0;

    // Before the ready check, not after: a database whose migrations failed has
    // a running server and an unusable schema, which is the whole reason this
    // status exists. It is also why no URI is issued for one — see create().
    const migration = await this.jobFor(migrationJobName(id));
    if (migration) {
      // The Job's own verdict, not its failed-pod count. A Job with a
      // backoffLimit has failed pods on the way to succeeding — the migration
      // runner's first attempt routinely fails because it starts before the
      // server is accepting connections — and reading the count would mark a
      // database permanently `failed` for a retry that then worked.
      const givenUp = (migration.status?.conditions ?? []).some(
        (c) => c.type === "Failed" && c.status === "True",
      );
      if (givenUp) return "failed";
      if ((migration.status?.succeeded ?? 0) === 0) return ready > 0 ? "migrating" : "provisioning";
    }

    const restore = await this.restoreJobFor(id);
    if (restore) {
      if ((restore.status?.succeeded ?? 0) > 0) return ready > 0 ? "ready" : "provisioning";
      if ((restore.status?.failed ?? 0) > 0) return "failed";
      return "restoring";
    }

    if (ready > 0) return "ready";

    // The operator's own verdict, for the cases it can see and drigodb cannot:
    // an image that will not pull, a volume that will not bind, a cluster that
    // has given up. A caller polling forever is worse than an error.
    const phase = cluster.status?.phase ?? "";
    if (/failure|failed|unrecoverable/i.test(phase)) return "failed";

    return "provisioning";
  }

  private async toDatabase(cluster: CnpgCluster): Promise<Database> {
    const labels = cluster.metadata?.labels ?? {};
    const id = labels[DB_ID_LABEL] ?? "";
    return {
      id,
      external_id: labels[EXTERNAL_ID_LABEL] ?? "",
      status: await this.statusOf(id, labels, cluster),
      tier: tierOf(labels),
      endpoint: endpointHost(id),
      port: POSTGRES_PORT,
      created_at: cluster.metadata?.creationTimestamp
        ? new Date(cluster.metadata.creationTimestamp).toISOString()
        : undefined,
    };
  }

  // Run drigodb's migrations against a database that is up.
  //
  // Deleted and recreated rather than reused: a Job's pod template is immutable,
  // so a second wake cannot re-run an existing one, and a Job left behind from
  // the last wake would make statusOf report a stale verdict about the current
  // one. Deleting first is what makes "the Job for this database" mean the run
  // that is happening now.
  private async runMigrations(id: string, externalId: string): Promise<void> {
    await this.ignoreMissing(() =>
      this.batch.deleteNamespacedJob({
        name: migrationJobName(id),
        namespace: config.databaseNamespace,
        propagationPolicy: "Background",
      }),
    );
    await this.ensure(() =>
      this.batch.createNamespacedJob({
        namespace: config.databaseNamespace,
        body: buildMigrationJob(id, externalId),
      }),
    );
  }

  private async ignoreMissing(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  private async jobFor(name: string): Promise<V1Job | undefined> {
    try {
      return await this.batch.readNamespacedJob({ name, namespace: config.databaseNamespace });
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  // Missing is the ordinary case: most databases were never restored into, and
  // a succeeded Job removes itself after an hour.
  private async restoreJobFor(id: string): Promise<V1Job | undefined> {
    try {
      return await this.batch.readNamespacedJob({
        name: restoreJobName(id),
        namespace: config.databaseNamespace,
      });
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  private async listClusters(selector: string): Promise<CnpgCluster[]> {
    const list = (await this.objects.listNamespacedCustomObject({
      group: CNPG_GROUP,
      version: "v1",
      namespace: config.databaseNamespace,
      plural: CLUSTERS_PLURAL,
      labelSelector: selector,
    })) as { items?: CnpgCluster[] };
    return list.items ?? [];
  }

  async findByExternalId(externalId: string): Promise<Database | undefined> {
    const found = (
      await this.listClusters(
        `${EXTERNAL_ID_LABEL}=${externalId},${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
      )
    )[0];
    return found ? await this.toDatabase(found) : undefined;
  }

  async get(id: string): Promise<Database> {
    const cluster = await this.clusterFor(id);
    if (!cluster) throw new NotFoundError(`no database with id ${id}`);
    return this.toDatabase(cluster);
  }

  async list(): Promise<Database[]> {
    const clusters = await this.listClusters(`${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`);
    return Promise.all(clusters.map((c) => this.toDatabase(c)));
  }

  // Returns the database and its connection URI. The URI is returned here and
  // on rotation only — never from a plain GET — so a leaked read token does not
  // leak database credentials.
  async create(
    externalId: string,
    restoreFrom?: { databaseId: string; key: string },
  ): Promise<{ database: Database; uri: string; created: boolean }> {
    const id = idFor(externalId);
    const password = newPassword();
    const ns = config.databaseNamespace;

    // A volume outliving its database is the one way a derived id can hand a
    // caller someone else's data. DELETE removes the PVC, but removal is not
    // instant — it waits for the pod — so for a few seconds after a delete the
    // volume is still there under a name the next create would reuse. PostgreSQL
    // would find an initialised PGDATA, skip initdb, and come up holding the
    // deleted database's rows behind a password that no longer matches the URI
    // just issued. Refusing is the whole fix: a retry moments later is clean.
    //
    // Only when the StatefulSet is gone. A PVC beside a live StatefulSet is an
    // ordinary database being created again, which is the idempotent path below.
    const leftover = await this.core.listNamespacedPersistentVolumeClaim({
      namespace: ns,
      labelSelector: `${DB_ID_LABEL}=${id}`,
    });
    if ((leftover.items ?? []).length > 0 && !(await this.clusterFor(id))) {
      throw new DeletionInFlightError(
        `a database for external_id ${externalId} is still being deleted; retry in a moment`,
      );
    }

    // The Secret BEFORE the Cluster, which is the one ordering CloudNativePG
    // forces and the old data plane did not. bootstrap.initdb.secret is read
    // during initdb, so a Cluster created first would bootstrap against a Secret
    // that does not exist yet.
    //
    // Safe to write before the lock is taken, unlike the Cluster: a Secret for a
    // database that never gets created is an orphan, not a second database. The
    // loser of a race overwrites it with an identical-shaped Secret carrying a
    // password nobody will ever be told, and then returns without using it.
    await this.ensure(() =>
      this.core.createNamespacedSecret({ namespace: ns, body: buildSecret(id, externalId, password) }),
    );
    // The migration runner's own credential, never issued to anyone. Written
    // here for the same reason as the one above: managed.roles reconciles the
    // role against it, so it has to exist before the Cluster does.
    await this.ensure(() =>
      this.core.createNamespacedSecret({
        namespace: ns,
        body: buildMigratorSecret(id, externalId, newPassword()),
      }),
    );

    // The Cluster is the lock, exactly as the StatefulSet was: whichever caller
    // creates it wins, and the other is told AlreadyExists and handed the
    // database that now exists — the same answer a plain retry gets.
    try {
      await this.objects.createNamespacedCustomObject({
        group: CNPG_GROUP,
        version: "v1",
        namespace: ns,
        plural: CLUSTERS_PLURAL,
        body: buildCluster(id, externalId, defaultTier()),
      });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      const owner = (await this.clusterFor(id))?.metadata?.labels?.[EXTERNAL_ID_LABEL];
      // Twelve hex characters is 48 bits, so a collision needs millions of
      // external_ids — but handing one caller another's database, credentials
      // and all, is not a failure to discover in production.
      if (owner !== undefined && owner !== externalId) {
        throw new ValidationError(
          `external_id ${externalId} collides with an existing database; choose another`,
        );
      }
      return { database: await this.get(id), uri: "", created: false };
    }

    // Tolerating AlreadyExists on each: a create that failed partway leaves some
    // of these behind, and a retry has to be able to finish the job rather than
    // stall on the first object it already made.
    //
    // drigodb's own Service, not CloudNativePG's `-rw` one. Same reason the
    // Cluster carries the same name a StatefulSet did: the connection URI is
    // issued once and never reissued, so the hostname in it cannot move.
    await this.ensure(() =>
      this.core.createNamespacedService({ namespace: ns, body: buildService(id, externalId) }),
    );
    await this.ensure(() =>
      this.net.createNamespacedNetworkPolicy({ namespace: ns, body: buildNetworkPolicy(id, externalId) }),
    );

    // A Cluster comes up on its own — there is no hibernated-then-woken dance,
    // because the operator starts provisioning the moment the object exists.
    // Migrations are what the wake path used to carry, so they are run
    // explicitly here and again on every wake.
    await this.runMigrations(id, externalId);

    // After the wake, because the Job connects over TCP to a server that has to
    // be listening — and creating it earlier would only mean it crash-looped
    // through its backoff while the database initialised.
    if (restoreFrom) {
      await this.batch.createNamespacedJob({
        namespace: ns,
        body: buildRestoreJob(id, externalId, `${restoreFrom.databaseId}/${restoreFrom.key}`),
      });
    }

    return { database: await this.get(id), uri: connectionUri(id, password), created: true };
  }

  // Bring a database up, on the template this build renders rather than the one
  // it was created with.
  //
  // A hosted database is its StatefulSet, and nothing rewrites that StatefulSet
  // after create — so before this existed, a database kept its original
  // data-plane images forever, through any number of hibernate/wake cycles. A
  // rebuilt postgres image reached new databases only. So did every pod-template
  // fix: the fsGroupChangePolicy that stopped PostgreSQL waking landed for new
  // databases and never for existing ones. It is also how the plain-PostgreSQL
  // data plane reaches a database created before the migration.
  async wake(id: string): Promise<Database> {
    const cluster = await this.clusterFor(id);
    // Read first, so waking something that does not exist is a 404 rather than
    // whatever the patch below would have said.
    if (!cluster) throw new NotFoundError(`no database with id ${id}`);

    await this.scale(id, 1);
    // Waking is still how a change reaches an existing database, but the change
    // is no longer a pod template: the operator owns that and rolls it itself.
    // What is left is drigodb's own schema, so a wake re-runs the migration Job.
    await this.runMigrations(id, cluster.metadata?.labels?.[EXTERNAL_ID_LABEL] ?? "");
    return this.get(id);
  }

  // Rewrite the pod template if this build renders a different one.
  //
  // Ordering is the point: this runs BEFORE the scale, while the StatefulSet is
  // still at zero replicas. With no pods there is nothing to roll, so the
  // rewrite costs nothing and the pod that follows starts once, on the new
  // template. Reconciling after the scale would start it on the old template
  // and then roll it — two starts, and roughly twice the eight seconds a wake
  // is supposed to take.
  private async reconcile(sts: V1StatefulSet): Promise<void> {
    const labels = sts.metadata?.labels ?? {};
    const id = labels[DB_ID_LABEL];
    const externalId = labels[EXTERNAL_ID_LABEL];
    if (!id || !externalId) return;

    // Waking is how everything else reaches an existing database — a rebuilt
    // image, a new migration, a resized volume — and a certificate is no
    // different. Without this, turning server authentication on would give it
    // only to databases created afterwards, and the fleet would divide silently
    // into verifiable and not.
    if (serverAuthEnabled()) await this.ensureCertificate(id, externalId);

    // Only on the way up from hibernation. Callers wake speculatively — that is
    // what the endpoint is for — and a wake on a database that is already
    // serving must not touch it: rewriting the template of a running
    // StatefulSet rolls the pod and drops every live connection. A database
    // that is already awake reconciles on its next hibernate/wake cycle.
    if ((sts.spec?.replicas ?? 0) > 0) return;

    // From the StatefulSet's own label, not from configuration. A resized
    // database is on a tier this installation may not create by default, and
    // rebuilding its template from config.defaultTier would silently move it
    // back — undoing a resize on the next wake, with the PVC left large and
    // max_wal_size dropped underneath it.
    const tier = tierOf(labels);

    const want = templateHash(id, externalId, tier);
    if (sts.metadata?.annotations?.[TEMPLATE_HASH_ANNOTATION] === want) return;

    await this.apps.patchNamespacedStatefulSet(
      {
        name: statefulSetName(id),
        namespace: config.databaseNamespace,
        body: {
          metadata: { annotations: { [TEMPLATE_HASH_ANNOTATION]: want } },
          // Only the template. A StatefulSet's selector, serviceName and
          // volumeClaimTemplates are immutable, so anything wider than this is
          // rejected outright; replicas is left out so the patch cannot fight
          // the scale that follows it.
          spec: { template: buildPodTemplate(id, externalId, tier) },
        },
      },
      // A merge patch, not the strategic merge the client would otherwise send.
      // Strategic merge unions lists by key — containers by name, env by name —
      // so a field this build no longer renders would survive in the live
      // object indefinitely. Merge patch replaces lists wholesale, which is
      // what "make it match what we render" actually means.
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );

    console.log(`[drigodb] reconciled ${id} to template ${want}`);
  }

  // Issue a new password and return the URI that carries it.
  //
  // The second and only other time a connection URI leaves this service. That
  // is what makes this operation matter rather than merely complete the
  // contract: the URI is returned on creation and never from a GET, so without
  // rotation a caller that loses one has no way back into a live database. It
  // keeps its data, keeps its volume, keeps costing money, and is unreachable.
  //
  // The password is applied by bootstrap.sh on the next start, not from here.
  // The Service does publish PostgreSQL's port now, but pg_hba admits only
  // appuser over TLS into its own database. Rotating from here would mean a
  // pg_hba rule and a DDL-capable credential per database that the control
  // plane holds and can use — it already holds every credential; the point is
  // that it cannot use one from where it runs. See issue #29.
  async rotateCredentials(id: string): Promise<{ database: Database; uri: string }> {
    const cluster = await this.clusterFor(id);
    if (!cluster) throw new NotFoundError(`no database with id ${id}`);

    const externalId = cluster.metadata?.labels?.[EXTERNAL_ID_LABEL] ?? "";
    const password = newPassword();

    // The Secret first, always. The pod reads it at start, so a restart that
    // happened before this landed would come back on the old password. This
    // order also fails safe: if the restart below never happens, the database
    // still converges on the new password at its next wake.
    await this.core.replaceNamespacedSecret({
      name: secretName(id),
      namespace: config.databaseNamespace,
      body: buildSecret(id, externalId, password),
    });

    // A hibernated database has nothing to restart and nothing connected to it.
    // It picks the new password up when it next wakes, which is the first
    // moment the URI could be used anyway.
    // No restart. Under CloudNativePG the password is a managed role reconciled
    // against this Secret continuously, so replacing the Secret IS the rotation
    // — measured, including that the old password stops being accepted.
    //
    // The hibernate/wake cycle this used to perform was there because the old
    // data plane read the Secret only at start. Dropping it removes the one
    // operation that took a database offline to change a credential.

    return { database: await this.get(id), uri: connectionUri(id, password) };
  }

  // Scaling to zero is accepted long before the pod is gone — status reports
  // the desired replica count. Waking before the old pod has terminated would
  // hand the new one a name that is still taken.
  private async waitForPodsGone(id: string, attempts = 60): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const pods = await this.core.listNamespacedPod({
        namespace: config.databaseNamespace,
        labelSelector: `${DB_ID_LABEL}=${id}`,
      });
      if ((pods.items ?? []).length === 0) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Bounded, and deliberately not an error on timeout: by this point the new
  // password is already in the Secret, so the rotation has happened whether or
  // not the pod is back. The caller is told the truth through `status`.
  private async waitForReady(id: string, attempts = 90): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const db = await this.get(id);
      if (db.status === "ready" || db.status === "failed") return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Read-modify-replace on the scale subresource, retried on conflict. The
  // StatefulSet controller writes status continuously, so the resourceVersion
  // read a moment ago is routinely stale by the time the replace lands —
  // especially right after create, where the object is being actively
  // reconciled. A 409 here is normal, not exceptional.
  async scale(id: string, replicas: number): Promise<Database> {
    const want = replicas === 0 ? "true" : "false";

    // One patch, both fields, so the label recording the intent and the
    // annotation acting on it can never disagree. The previous data plane needed
    // two writes — a label patch and a scale subresource — and an ordering
    // argument about which lies less when the second one fails.
    await this.objects.patchNamespacedCustomObject({
      group: CNPG_GROUP,
      version: "v1",
      namespace: config.databaseNamespace,
      plural: CLUSTERS_PLURAL,
      name: clusterName(id),
      body: {
        metadata: {
          labels: { [HIBERNATED_LABEL]: want },
          annotations: { [CNPG_HIBERNATION_ANNOTATION]: replicas === 0 ? "on" : "off" },
        },
      },
    });

    return await this.get(id);
  }


  // Grow a database onto a bigger tier.
  //
  // Owner-initiated and automatically granted, provided the target is a real
  // tier no larger than the configured ceiling. Nothing watches usage and grows
  // a database on its own.
  //
  // ORDER MATTERS, and getting it wrong fills a disk. The volume grows first;
  // max_wal_size rises only after. Raising the WAL ceiling on a volume that has
  // not grown is how PostgreSQL PANICs on a full disk — and a full PVC is not a
  // quick recovery.
  async resize(id: string, target: Tier): Promise<Database> {
    const cluster = await this.clusterFor(id);
    if (!cluster) throw new NotFoundError(`no database with id ${id}`);

    const current = tierOf(cluster.metadata?.labels);
    const externalId = cluster.metadata?.labels?.[EXTERNAL_ID_LABEL] ?? "";
    const at = TIER_ORDER.indexOf(current);
    const to = TIER_ORDER.indexOf(target);
    const ceiling = TIER_ORDER.indexOf(config.maxTier as Tier);

    // A volume can be expanded in place and can never be shrunk. This is not a
    // policy choice; the storage layer refuses, and it refuses late.
    if (to < at) {
      throw new ValidationError(
        `cannot shrink: ${id} is on ${current} and volumes do not shrink`,
      );
    }
    if (to > ceiling) {
      throw new ValidationError(
        `${target} exceeds the maximum tier for this installation (${config.maxTier})`,
      );
    }
    if (to === at) return await this.get(id);

    const ns = config.databaseNamespace;

    // 1. The volume. Expansion is online — measured on DigitalOcean 2026-09-05,
    //    974M to 2.0G with the database serving and no restart — so this alone
    //    costs a tenant nothing.
    try {
      await this.core.patchNamespacedPersistentVolumeClaim(
        {
          name: pvcName(id),
          namespace: ns,
          body: { spec: { resources: { requests: { storage: TIERS[target].storage } } } },
        },
        // Same reason the StatefulSet patch sets this: without it the client
        // sends a JSON Patch, which expects an array of operations and rejects
        // this object outright with "cannot unmarshal object into Go value of
        // type []handlers.jsonPatchOp". A mocked client cannot notice that.
        setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
      );
    } catch (err) {
      // The common cause is a StorageClass with allowVolumeExpansion: false —
      // kind's local-path, and plenty of others. Kubernetes says so clearly and
      // the caller should hear it, rather than the "internal error" a 500 gives
      // them for something they can actually fix.
      // The client puts the API server's Status object in `body`, sometimes as
      // a string. Pull the message out of either — a caller who chose a
      // StorageClass without allowVolumeExpansion can act on that, and cannot
      // act on "internal error".
      const raw = (err as { body?: unknown })?.body;
      let detail: string | undefined;
      if (typeof raw === "string") {
        try { detail = (JSON.parse(raw) as { message?: string }).message; } catch { detail = raw; }
      } else if (raw && typeof raw === "object") {
        detail = (raw as { message?: string }).message;
      }
      if (detail) throw new ResizeRefusedError(`could not grow the volume: ${detail}`);
      throw err;
    }

    // 2. The template and the label, together. The pod template carries
    //    DRIGODB_MAX_WAL_SIZE, which bootstrap.sh writes into PGDATA at start —
    //    so this takes effect on the cycle below, after the volume has grown.
    await this.apps.patchNamespacedStatefulSet(
      {
        name: statefulSetName(id),
        namespace: ns,
        body: {
          metadata: {
            labels: { [TIER_LABEL]: target },
            annotations: { [TEMPLATE_HASH_ANNOTATION]: templateHash(id, externalId, target) },
          },
          spec: { template: buildPodTemplate(id, externalId, target) },
        },
      },
      // Every patch this service sends needs this. Without it the client sends a
      // JSON Patch, which wants an array of operations and rejects an object —
      // and a mocked client in a unit test cannot tell the difference, which is
      // why both of these got it wrong until a real cluster said so.
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );

    // There is no transaction across these two, and the order is what makes that
    // survivable: a failure between them leaves a LARGER volume still running
    // the old max_wal_size, which is merely wasteful. Reversed, it would leave a
    // raised WAL ceiling on a volume that never grew — and PostgreSQL on a full
    // disk does not degrade, it PANICs and will not restart until space is
    // freed. Observed exactly once during development, in the safe direction.

    // 3. The cycle, which is what the WAL change needs and the volume does not.
    //    Skipped for a hibernated database: it will pick both up when it wakes,
    //    and waking one to change a setting it is not using would be rude.
    // No cycle. The operator owns both halves: it expands the volume and it
    // decides whether max_wal_size needs a restart to take effect. Doing it by
    // hand would be racing the thing that is already doing it.

    return await this.get(id);
  }

  // Create, and treat "it is already there" as success.
  //
  // A create that failed partway leaves some of its objects behind, and the
  // retry has to be able to finish the job rather than stall on the first one it
  // already made. That is also the loser's path in a race: it never reaches
  // here, but a caller retrying after a partial failure does.
  private async ensure(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }

  // Ask cert-manager for a certificate naming this database's Service DNS.
  //
  // Never fatal. A database that cannot get a certificate must still provision:
  // bootstrap.sh self-signs, the URI still works with the sslmode it was issued
  // for, and the alternative is an installation where a broken cert-manager
  // stops anyone creating a database at all.
  private async ensureCertificate(id: string, externalId: string): Promise<void> {
    try {
      await this.objects.createNamespacedCustomObject({
        group: "cert-manager.io",
        version: "v1",
        namespace: config.tls.issuerNamespace,
        plural: "certificates",
        body: buildCertificate(id, externalId),
      });
    } catch (err) {
      if (isAlreadyExists(err)) return;
      console.error(`[drigodb] could not request a certificate for ${id}:`, err);
    }
  }

  async delete(id: string): Promise<void> {
    const ns = config.databaseNamespace;
    const cluster = await this.clusterFor(id);
    if (!cluster) throw new NotFoundError(`no database with id ${id}`);

    const ignoreMissing = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    };

    await ignoreMissing(() =>
      this.objects.deleteNamespacedCustomObject({
        group: CNPG_GROUP,
        version: "v1",
        namespace: ns,
        plural: CLUSTERS_PLURAL,
        name: clusterName(id),
      }),
    );
    await ignoreMissing(() => this.core.deleteNamespacedService({ name: serviceName(id), namespace: ns }));
    await ignoreMissing(() =>
      this.net.deleteNamespacedNetworkPolicy({ name: statefulSetName(id), namespace: ns }),
    );
    await ignoreMissing(() => this.core.deleteNamespacedSecret({ name: secretName(id), namespace: ns }));
    // The migrator's credential too. Left behind, it would be a live password
    // for a role in a database that no longer exists — and then get adopted by
    // the next database to take this id, since ids are derived from external_id
    // and therefore reused.
    await ignoreMissing(() =>
      this.core.deleteNamespacedSecret({ name: migratorSecretName(id), namespace: ns }),
    );
    // A failed restore Job outlives its TTL on purpose, so DELETE is what
    // finally removes it — along with the pod holding its logs.
    if (serverAuthEnabled()) {
      // The Certificate, not just its Secret: cert-manager would reissue the
      // Secret it owns, leaving a certificate for a database that no longer
      // exists renewing itself indefinitely.
      await ignoreMissing(() =>
        this.objects.deleteNamespacedCustomObject({
          group: "cert-manager.io",
          version: "v1",
          namespace: config.tls.issuerNamespace,
          plural: "certificates",
          name: tlsSecretName(id),
        }),
      );
    }
    await ignoreMissing(() =>
      this.batch.deleteNamespacedJob({
        name: restoreJobName(id),
        namespace: ns,
        propagationPolicy: "Background",
      }),
    );

    // The retention policy deliberately keeps volumes when a StatefulSet is
    // removed, so DELETE has to remove them explicitly. This is the point at
    // which the customer's data actually goes.
    const pvcs = await this.core.listNamespacedPersistentVolumeClaim({
      namespace: ns,
      labelSelector: `${DB_ID_LABEL}=${id}`,
    });
    for (const pvc of pvcs.items ?? []) {
      const name = pvc.metadata?.name;
      if (name) {
        await ignoreMissing(() =>
          this.core.deleteNamespacedPersistentVolumeClaim({ name, namespace: ns }),
        );
      }
    }
  }

  // The CA certificate consumers need to verify a database.
  //
  // A CA certificate is public by definition — it is what a server presents a
  // chain to, and every client that verifies anything already holds a pile of
  // them. Serving it over the API is the only path that does not require a
  // consumer to read a Secret in a namespace it has no business in.
  async caCertificate(): Promise<string> {
    if (!serverAuthEnabled()) {
      throw new BackupsDisabledError(
        "server authentication is not configured; connection URIs use sslmode=require",
      );
    }
    const secret = await this.core.readNamespacedSecret({
      name: config.tls.caSecret,
      namespace: config.tls.issuerNamespace,
    });
    // ca.crt on a CA Certificate's Secret; tls.crt is the same material for a
    // self-signed root, but ca.crt is the one that stays correct if the root is
    // ever replaced by an intermediate.
    const raw = secret.data?.["ca.crt"] ?? secret.data?.["tls.crt"];
    if (!raw) throw new NotFoundError("the CA secret holds no certificate yet");
    return Buffer.from(raw, "base64").toString("utf8");
  }

  // Every backup this database has, newest first.
  //
  // Answered from the control plane rather than from the pod, because the pod
  // is exactly what is missing when the question matters: a hibernated database
  // has no container to exec into, and "what can I restore?" is a question
  // people ask about idle databases. Reaching `drigodb-backup latest` instead
  // would need pods/exec RBAC, and a control plane that can exec into any
  // database pod can read every tenant's data — strictly worse than listing a
  // bucket, and still unable to answer while hibernated. See issue #39.
  async listBackups(id: string): Promise<BackupObject[]> {
    // 404 before 409: a database that does not exist is not a database whose
    // backups are disabled.
    const cluster = await this.clusterFor(id);
    if (!cluster) throw new NotFoundError(`no database with id ${id}`);
    if (!backupsEnabled()) {
      throw new BackupsDisabledError("backups are not configured for this installation");
    }

    const secret = await this.core.readNamespacedSecret({
      name: config.backup.secretName,
      namespace: config.databaseNamespace,
    });
    const read = (k: string): string => {
      const v = secret.data?.[k];
      if (!v) throw new BackupStorageError(`${config.backup.secretName} has no ${k}`);
      return Buffer.from(v, "base64").toString("utf8");
    };

    const objects = await listObjects({
      endpoint: config.backup.endpoint,
      bucket: config.backup.bucket,
      // The trailing slash matters: without it the prefix for "a1" would also
      // match "a1b2", which is another tenant's backups.
      prefix: `${id}/`,
      accessKeyId: read(BACKUP_KEY_SECRET_KEY),
      secretAccessKey: read(BACKUP_SECRET_SECRET_KEY),
      region: config.backup.region || regionFromEndpoint(config.backup.endpoint),
    });

    // Keys are ISO-8601 UTC timestamps, so this is chronological — but sorted
    // on lastModified rather than the name, because the name is what the writer
    // chose and the timestamp is what the store observed.
    return objects.sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
  }
}
