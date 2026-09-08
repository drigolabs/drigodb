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
import {
  TIERS,
  TIER_LABEL,
  TIER_ORDER,
  DB_ID_LABEL,
  BACKUPS_PLURAL,
  CLUSTERS_PLURAL,
  DB_USER,
  CNPG_GROUP,
  CNPG_HIBERNATION_ANNOTATION,
  CREDENTIAL_VERSION_ANNOTATION,
  EXTERNAL_ID_LABEL,
  HIBERNATED_LABEL,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  POSTGRES_PORT,
  buildNetworkPolicy,
  buildCertificate,
  type RestoreSource,
  buildBackup,
  buildCluster,
  buildSecret,
  buildService,
  connectionUri,
  endpointHost,
  tierOf,
  tlsSecretName,
  secretName,
  serviceName,
  clusterName,
} from "./manifests.js";

export type DatabaseStatus =
  | "provisioning"
  // Running, and not usable yet: the server accepts connections but drigodb's
  // migrations have not finished. Distinct from `restoring`, which is data
  // arriving, and from `failed`, which is a migration that will not finish.
  | "migrating"
  | "ready"
  | "hibernated"
  | "failed";

export type Database = {
  id: string;
  external_id: string;
  status: DatabaseStatus;
  // Not a lifecycle state, and deliberately on every database rather than only
  // the unprotected ones: right now that is all of them.
  //
  // The backup sidecar lived in a pod template drigodb no longer owns
  // (decision 0004), so it went with it, and CloudNativePG's own backups are
  // #95. Until that lands a hosted database has no backup at all, and a
  // consumer polling this endpoint should be told rather than left to infer it
  // from an endpoint that no longer exists.
  // "unavailable" when this installation has nowhere to put a backup, which is
  // an honest answer rather than an empty list — a consumer that sees no
  // backups should be able to tell "none taken yet" from "none possible".
  backups: "unavailable" | "enabled";
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
  status?: {
    readyInstances?: number;
    phase?: string;
    managedRolesStatus?: {
      passwordStatus?: Record<string, { resourceVersion?: string }>;
    };
  };
}

export class ValidationError extends Error {}
export class NotFoundError extends Error {}
// "Backups are off" is a different answer from "there are none", and a caller
// acting on the second when the first is true would be wrong.
// The storage layer refused to grow the volume. Almost always a StorageClass
// with allowVolumeExpansion: false, which is the operator's to change and not
// something drigodb can work around.
export class ResizeRefusedError extends Error {}

// A feature this installation has not turned on was asked for.
//
// caCertificate used to throw BackupsDisabledError for "server authentication is
// off", which was true of the HTTP status and a lie about everything else. An
// error class is read by whoever is debugging at 3am; naming it after a
// different feature costs them the first ten minutes.
export class NotConfiguredError extends Error {}

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
// What `restore_from` is allowed to say.
//
// Both fields are names that end up in a Kubernetes object and in a path inside
// a bucket, so they are checked rather than trusted. The old shape took a bucket
// KEY, which had to be checked for `..` to stop one caller reading another
// database's prefix; there is no path here any more, only two identifiers this
// service issued itself.
export function validateRestoreFrom(
  value: unknown,
  now: Date = new Date(),
): { databaseId: string; backupId?: string; targetTime?: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") {
    throw new ValidationError("restore_from must be an object");
  }
  const v = value as { database_id?: unknown; backup_id?: unknown; target_time?: unknown };
  if (typeof v.database_id !== "string" || !/^[0-9a-f]{12}$/.test(v.database_id)) {
    throw new ValidationError("restore_from.database_id must be a database id");
  }
  if (v.backup_id !== undefined) {
    if (typeof v.backup_id !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(v.backup_id)) {
      throw new ValidationError("restore_from.backup_id must be a backup id from GET /backups");
    }
  }

  // Two ways of saying where to stop, and asking for both is a mistake rather
  // than a combination. CloudNativePG would accept it — a backup id narrows
  // which base backup the replay starts from — but a caller sending both
  // usually means one of them, and guessing which is how a restore silently
  // lands somewhere nobody asked for.
  if (v.target_time !== undefined && v.backup_id !== undefined) {
    throw new ValidationError(
      "restore_from takes backup_id or target_time, not both: a backup id restores to that backup, a target time restores to that instant",
    );
  }

  let targetTime: string | undefined;
  if (v.target_time !== undefined) {
    if (typeof v.target_time !== "string") {
      throw new ValidationError("restore_from.target_time must be an RFC3339 timestamp");
    }
    const at = new Date(v.target_time);
    if (Number.isNaN(at.getTime())) {
      throw new ValidationError(
        `restore_from.target_time is not a timestamp: ${v.target_time}`,
      );
    }
    // A bare date, or a time with no zone, is the mistake worth catching here.
    // `new Date("2026-09-09")` parses as midnight UTC and `new Date("2026-09-09
    // 10:00")` as local time on whichever machine the control plane runs on —
    // both succeed and both recover to an instant the caller did not name.
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(v.target_time)) {
      throw new ValidationError(
        `restore_from.target_time must carry a UTC offset (RFC3339), so the instant does not depend on the server's timezone: ${v.target_time}`,
      );
    }
    if (at.getTime() > now.getTime()) {
      throw new ValidationError(
        `restore_from.target_time is in the future: ${v.target_time}`,
      );
    }
    // Re-serialised rather than passed through, so what reaches the Cluster is
    // one format regardless of which legal RFC3339 spelling arrived.
    targetTime = at.toISOString();
  }

  return {
    databaseId: v.database_id,
    ...(v.backup_id ? { backupId: v.backup_id } : {}),
    ...(targetTime ? { targetTime } : {}),
  };
}

function idFor(externalId: string): string {
  return createHash("sha256").update(externalId).digest("hex").slice(0, 12);
}

function newPassword(): string {
  return randomBytes(24).toString("base64url");
}

function isAlreadyExists(err: unknown): boolean {
  const code =
    (err as { code?: number; statusCode?: number })?.code ??
    (err as { statusCode?: number })?.statusCode;
  return code === 409;
}

function isNotFound(err: unknown): boolean {
  const code =
    (err as { code?: number; statusCode?: number })?.code ??
    (err as { statusCode?: number })?.statusCode;
  return code === 404;
}

// What a caller can restore from. Read from Backup objects rather than from the
// bucket, so drigodb answers this without a credential for object storage and
// without the bucket having to be reachable from the control plane at all.
//
// Answers for a hibernated database too, which is the point: that is exactly
// when someone asks what they can restore, and exactly when there is no pod to
// ask. The old implementation listed the bucket and could not answer it.
export interface DatabaseBackup {
  id: string;
  status: string;
  started_at?: string;
  // Barman's own identifier, once the backup has completed. Reported because it
  // is what appears in the bucket and in barman's own tooling, and someone
  // debugging will be looking at both.
  backup_id?: string;
  completed_at?: string;
  error?: string;
}

interface CnpgBackup {
  metadata?: { name?: string; creationTimestamp?: string };
  status?: {
    phase?: string;
    backupId?: string;
    startedAt?: string;
    stoppedAt?: string;
    error?: string;
  };
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

    // Counted from the pods, not read from status.readyInstances.
    //
    // A hibernated Cluster reports readyInstances: 1 with zero pods running —
    // CloudNativePG does not zero it on the way down. The hibernation label
    // covers a database that is deliberately down, but a database on its way
    // BACK up would have reported `ready` the instant the annotation flipped,
    // before anything was listening. Measured: "woke in 0s", with no pod.
    // `cnpg.io/podRole=instance` as well as drigodb's own id, because
    // inheritedMetadata puts drigodb's labels on EVERY pod the operator makes
    // for this database — including the initdb Job's. Selecting on the id alone
    // counted that job pod as a ready instance and reported the database ready
    // seven seconds in, while nothing was listening yet. Measured: "ready in
    // 7s", then connection refused.
    const pods = await this.core.listNamespacedPod({
      namespace: config.databaseNamespace,
      labelSelector: `${DB_ID_LABEL}=${id},cnpg.io/podRole=instance`,
    });
    const ready = (pods.items ?? []).filter((p) =>
      (p.status?.conditions ?? []).some(
        (c) => c.type === "Ready" && c.status === "True",
      ),
    ).length;

    // Before the ready check, not after: a database whose migrations failed has
    // a running server and an unusable schema, which is the whole reason this
    // status exists. It is also why no URI is issued for one — see create().
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
      backups: backupsEnabled() ? "enabled" : "unavailable",
      tier: tierOf(labels),
      endpoint: endpointHost(id),
      port: POSTGRES_PORT,
      created_at: cluster.metadata?.creationTimestamp
        ? new Date(cluster.metadata.creationTimestamp).toISOString()
        : undefined,
    };
  }

  // Make the rotation happen, then wait for the operator to say it has.
  //
  // Replacing the Secret is not enough on its own, and this is the trap:
  // CloudNativePG goes on reporting the role `reconciled` against the version it
  // last applied and does not re-read the Secret until something touches the
  // Cluster. Measured — the Secret at resourceVersion 6634, the operator
  // reporting 6176, `reconciled`, indefinitely.
  //
  // Which is the worst shape a failed rotation can take. The API returns a new
  // URI that does not work, and the OLD password goes on working — so a caller
  // rotating because a credential leaked would believe they had revoked it.
  //
  // The annotation is the nudge and the record: it names the Secret version
  // drigodb expects applied, so the two can be compared by anyone debugging.
  // Reconciles in about four seconds once written.
  private async applyCredentialVersion(
    id: string,
    version?: string,
    attempts = 60,
  ): Promise<void> {
    if (!version) return;
    await this.objects.patchNamespacedCustomObject(
      {
        group: CNPG_GROUP,
        version: "v1",
        namespace: config.databaseNamespace,
        plural: CLUSTERS_PLURAL,
        name: clusterName(id),
        body: {
          metadata: {
            annotations: { [CREDENTIAL_VERSION_ANNOTATION]: version },
          },
        },
      },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
    for (let i = 0; i < attempts; i++) {
      const cluster = await this.clusterFor(id);
      const applied =
        cluster?.status?.managedRolesStatus?.passwordStatus?.[DB_USER]
          ?.resourceVersion;
      if (applied === version) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Not fatal. The rotation HAS happened — the Secret is written and the
    // operator will converge — so refusing to return the URI would leave the
    // caller without a credential that is about to start working.
    console.warn(
      `[drigodb] ${id}: role password not confirmed applied after ${attempts}s`,
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
      return await this.batch.readNamespacedJob({
        name,
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
    const clusters = await this.listClusters(
      `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
    );
    return Promise.all(clusters.map((c) => this.toDatabase(c)));
  }

  // Returns the database and its connection URI. The URI is returned here and
  // on rotation only — never from a plain GET — so a leaked read token does not
  // leak database credentials.
  async create(
    externalId: string,
    restoreFrom?: { databaseId: string; backupId?: string; targetTime?: string },
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

    // Resolved BEFORE anything is created, so a restore naming a database or a
    // backup that does not exist fails without leaving a half-made database
    // behind for someone to find.
    const restore = restoreFrom ? await this.resolveRestore(restoreFrom) : undefined;

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
      this.core.createNamespacedSecret({
        namespace: ns,
        body: buildSecret(id, externalId, password),
      }),
    );

    // BEFORE the Cluster, not after, and that ordering is now load-bearing.
    //
    // The Cluster's spec names this Secret, so CloudNativePG waits for it —
    // a database whose certificate has not issued stays provisioning, visibly,
    // instead of coming up on a certificate that names the wrong host.
    //
    // That is a deliberate change. The old data plane self-signed as a fallback
    // so a slow cert-manager cost a database its certificate and not its
    // availability. There is no fallback to reach for now: the operator would
    // sign its own, naming its own Services, and every consumer's verify-full
    // would fail against a URI drigodb had already issued. Failing to start is
    // louder than failing to verify.
    if (serverAuthEnabled()) await this.ensureCertificate(id, externalId);

    // The Cluster is the lock, exactly as the StatefulSet was: whichever caller
    // creates it wins, and the other is told AlreadyExists and handed the
    // database that now exists — the same answer a plain retry gets.
    try {
      await this.objects.createNamespacedCustomObject({
        group: CNPG_GROUP,
        version: "v1",
        namespace: ns,
        plural: CLUSTERS_PLURAL,
        body: buildCluster(id, externalId, defaultTier(), restore),
      });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      const owner = (await this.clusterFor(id))?.metadata?.labels?.[
        EXTERNAL_ID_LABEL
      ];
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
      this.core.createNamespacedService({
        namespace: ns,
        body: buildService(id, externalId),
      }),
    );
    await this.ensure(() =>
      this.net.createNamespacedNetworkPolicy({
        namespace: ns,
        body: buildNetworkPolicy(id, externalId),
      }),
    );

    return {
      database: await this.get(id),
      uri: connectionUri(id, password),
      created: true,
    };
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

    // Bring the NetworkPolicy up to what this build renders, on the way up.
    //
    // Nothing else ever rewrites one. A database created by an older drigodb
    // keeps the policy it was born with, so every rule added after it was
    // provisioned reaches new databases and no existing one — silently, because
    // a policy that is merely out of date is still a valid policy and nothing
    // reconciles it. The instance-to-instance rule replication needs (#81) is
    // the next one that would have landed that way.
    //
    // A wake is where a database picks up changes, which is the shape the old
    // data plane used for pod templates. The limit is worth naming: a database
    // that never sleeps never wakes, and so never gains a new rule.
    await this.ensureNetworkPolicy(id, cluster.metadata?.labels?.[EXTERNAL_ID_LABEL] ?? "");

    await this.scale(id, 1);
    return this.get(id);
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
  async rotateCredentials(
    id: string,
  ): Promise<{ database: Database; uri: string }> {
    const cluster = await this.clusterFor(id);
    if (!cluster) throw new NotFoundError(`no database with id ${id}`);

    const externalId = cluster.metadata?.labels?.[EXTERNAL_ID_LABEL] ?? "";
    const password = newPassword();

    // The Secret first, always. The pod reads it at start, so a restart that
    // happened before this landed would come back on the old password. This
    // order also fails safe: if the restart below never happens, the database
    // still converges on the new password at its next wake.
    const written = await this.core.replaceNamespacedSecret({
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
    // But it is not instant, and this endpoint returns a URI a caller will use
    // immediately. Waiting for the operator to say it has adopted THIS version
    // of the Secret is what makes the returned credential true when it is
    // returned. Without it the caller gets "password authentication failed" on
    // a password drigodb has just told them is theirs — measured, not guessed.
    await this.applyCredentialVersion(id, written?.metadata?.resourceVersion);
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
    await this.objects.patchNamespacedCustomObject(
      {
        group: CNPG_GROUP,
        version: "v1",
        namespace: config.databaseNamespace,
        plural: CLUSTERS_PLURAL,
        name: clusterName(id),
        body: {
          metadata: {
            labels: { [HIBERNATED_LABEL]: want },
            annotations: {
              [CNPG_HIBERNATION_ANNOTATION]: replicas === 0 ? "on" : "off",
            },
          },
        },
      },
      // The merge-patch content type, which every patch this service sends
      // needs. Without it the client sends a JSON Patch — an array of
      // operations — and the API server rejects an object outright with
      // "cannot unmarshal object into Go value of type []handlers.jsonPatchOp".
      //
      // Written without it here, and hibernate returned 500 on a real cluster
      // while every unit test passed: a mocked client cannot notice a content
      // type. The same mistake, in the same shape, as the one the StatefulSet
      // patches carry a comment about.
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );

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

    // One patch, and the operator does both halves.
    //
    // The old data plane needed two: a PVC patch to grow the volume, then a pod
    // template rewrite for max_wal_size, ordered so that a failure between them
    // left a LARGER volume running the old ceiling rather than a raised ceiling
    // on a volume that never grew — PostgreSQL on a full disk PANICs.
    //
    // That ordering argument is gone. The Cluster carries the size and the
    // parameter, and the operator expands the volume and decides whether the
    // parameter needs a restart. It also means the PVC name is no longer
    // drigodb's business, which is just as well: CloudNativePG names it
    // `db-<id>-1`, not the `data-db-<id>-0` a StatefulSet would have.
    //
    // Expansion is online — measured on DigitalOcean 2026-09-05, 974M to 2.0G
    // with the database serving and no restart.
    try {
      await this.objects.patchNamespacedCustomObject({
        group: CNPG_GROUP,
        version: "v1",
        namespace: ns,
        plural: CLUSTERS_PLURAL,
        name: clusterName(id),
        body: {
          metadata: { labels: { [TIER_LABEL]: target } },
          spec: {
            storage: { size: TIERS[target].storage },
            postgresql: {
              parameters: { max_wal_size: TIERS[target].maxWalSize },
            },
          },
        },
      });
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
        try {
          detail = (JSON.parse(raw) as { message?: string }).message;
        } catch {
          detail = raw;
        }
      } else if (raw && typeof raw === "object") {
        detail = (raw as { message?: string }).message;
      }
      if (detail)
        throw new ResizeRefusedError(`could not grow the volume: ${detail}`);
      throw err;
    }

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
  // Replace, not create-if-missing: the point is to bring an EXISTING policy up
  // to what this build renders, which is exactly what create-if-missing skips.
  // The create is only the path where somebody deleted the policy by hand.
  private async ensureNetworkPolicy(id: string, externalId: string): Promise<void> {
    const body = buildNetworkPolicy(id, externalId);
    try {
      await this.net.replaceNamespacedNetworkPolicy({
        name: clusterName(id),
        namespace: config.databaseNamespace,
        body,
      });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.ensure(() =>
        this.net.createNamespacedNetworkPolicy({ namespace: config.databaseNamespace, body }),
      );
    }
  }

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
  private async ensureCertificate(
    id: string,
    externalId: string,
  ): Promise<void> {
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
      console.error(
        `[drigodb] could not request a certificate for ${id}:`,
        err,
      );
    }
  }

  // Take one now.
  //
  // 202, not 200: the operator does the work and reports it in the object's
  // status. This returns as soon as the request exists, which is the only thing
  // drigodb can honestly say has happened.
  // Turn what a caller was given into what CloudNativePG wants.
  //
  // A caller holds the id GET /backups handed them, which is the Backup object's
  // name. CloudNativePG's recoveryTarget wants BARMAN's id, which only exists
  // once the backup completed. Translating here means the two identifiers a
  // consumer sees are the ones drigodb issued, and the operator's is internal.
  // A target time with no completed backup before it cannot be recovered to.
  //
  // Checked here rather than left to the operator, because the failure is
  // otherwise a Cluster that bootstraps, replays, gives up and reports it
  // minutes later — by which point the caller has a database id, a 202 and a
  // URI for something that will never come up. A 400 naming the earliest
  // recoverable instant is the same information, at the moment it is useful.
  //
  // Only the base backups are consulted. WAL beyond the newest one is what
  // makes recovery to an arbitrary instant possible in the first place, so
  // there is no upper bound to check: a target time after the last backup is
  // the ordinary case this feature exists for.
  private async assertRecoverableTo(databaseId: string, targetTime: string): Promise<void> {
    const backups = (await this.backupObjects(databaseId)).map(toBackup);
    // When a backup FINISHED, not when it started. A base backup is only
    // consistent at its end — that is the earliest instant WAL can replay
    // forward from — so a target between a backup's start and stop is inside a
    // window nothing can recover to, and checking against started_at would call
    // it satisfiable.
    const completed = backups
      .filter((b) => b.status === "completed" && b.completed_at)
      .map((b) => new Date(b.completed_at as string))
      .filter((d) => !Number.isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());

    if (completed.length === 0) {
      throw new ValidationError(
        `database ${databaseId} has no completed backup, so there is no point for WAL to replay from`,
      );
    }
    const earliest = completed[0] as Date;
    if (new Date(targetTime).getTime() < earliest.getTime()) {
      throw new ValidationError(
        `target_time ${targetTime} is before database ${databaseId}'s earliest backup completed (${earliest.toISOString()}), so there is nothing to replay from`,
      );
    }
  }

  private async resolveRestore(from: {
    databaseId: string;
    backupId?: string;
    targetTime?: string;
  }): Promise<RestoreSource> {
    if (!backupsEnabled()) {
      throw new NotConfiguredError(
        "backups are not configured for this installation, so there is nothing to restore from",
      );
    }
    // The source database need not still exist — restoring from a database
    // somebody deleted is a legitimate thing to want, and its backups outlive
    // it in the bucket. What must exist is the backup, when one was named.
    if (!from.backupId) {
      if (from.targetTime) await this.assertRecoverableTo(from.databaseId, from.targetTime);
      return {
        sourceCluster: clusterName(from.databaseId),
        ...(from.targetTime ? { targetTime: from.targetTime } : {}),
      };
    }
    const backup = (await this.objects
      .getNamespacedCustomObject({
        group: CNPG_GROUP,
        version: "v1",
        namespace: config.databaseNamespace,
        plural: BACKUPS_PLURAL,
        name: from.backupId,
      })
      .catch((err: unknown) => {
        if (isNotFound(err)) throw new NotFoundError(`no backup with id ${from.backupId}`);
        throw err;
      })) as CnpgBackup;

    // Belongs to the database the caller says it does. Without this a caller
    // could restore any backup in the installation by naming it, which is
    // reading another tenant's data through an id they guessed.
    const owner = (backup as { metadata?: { labels?: Record<string, string> } }).metadata?.labels?.[
      DB_ID_LABEL
    ];
    if (owner !== from.databaseId) {
      throw new ValidationError(
        `backup ${from.backupId} does not belong to database ${from.databaseId}`,
      );
    }
    const barmanId = backup.status?.backupId;
    if (!barmanId) {
      throw new ValidationError(
        `backup ${from.backupId} has not completed, so there is nothing to restore from yet`,
      );
    }
    return { sourceCluster: clusterName(from.databaseId), barmanBackupId: barmanId };
  }

  async createBackup(id: string): Promise<DatabaseBackup> {
    const cluster = await this.clusterFor(id);
    if (!cluster) throw new NotFoundError(`no database with id ${id}`);
    if (!backupsEnabled()) {
      throw new NotConfiguredError(
        "backups are not configured for this installation; set backup.bucket and backup.endpoint",
      );
    }
    const externalId = cluster.metadata?.labels?.[EXTERNAL_ID_LABEL] ?? "";
    const created = (await this.objects.createNamespacedCustomObject({
      group: CNPG_GROUP,
      version: "v1",
      namespace: config.databaseNamespace,
      plural: BACKUPS_PLURAL,
      body: buildBackup(id, externalId),
    })) as CnpgBackup;
    return toBackup(created);
  }

  async listBackups(id: string): Promise<DatabaseBackup[]> {
    // 404 before the disabled check: a database that does not exist is not a
    // database whose backups are turned off.
    const cluster = await this.clusterFor(id);
    if (!cluster) throw new NotFoundError(`no database with id ${id}`);
    if (!backupsEnabled()) {
      throw new NotConfiguredError("backups are not configured for this installation");
    }
    return (await this.backupObjects(id))
      .map(toBackup)
      .sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
  }

  // The Backup objects for a database, with no check that the database still
  // exists. listBackups wants that check — asking for the backups of a database
  // that is not there is a 404 — but a restore does not: recovering from a
  // database somebody deleted is the case restore exists for, and its backups
  // outlive it in the bucket.
  private async backupObjects(id: string): Promise<CnpgBackup[]> {
    const list = (await this.objects.listNamespacedCustomObject({
      group: CNPG_GROUP,
      version: "v1",
      namespace: config.databaseNamespace,
      plural: BACKUPS_PLURAL,
      labelSelector: `${DB_ID_LABEL}=${id}`,
    })) as { items?: CnpgBackup[] };
    return list.items ?? [];
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

    // The Backup objects too. They name a Cluster, so leaving them behind
    // leaves a listing of backups belonging to a database that no longer
    // exists — and ids are derived from external_id, so the next database to
    // take this id would inherit them.
    //
    // This removes the RECORDS, not the data in the bucket. Barman's retention
    // policy owns that, which is the right split: drigodb should not be able to
    // delete a customer's backups by deleting a Kubernetes object.
    if (backupsEnabled()) {
      const backups = (await this.objects.listNamespacedCustomObject({
        group: CNPG_GROUP,
        version: "v1",
        namespace: ns,
        plural: BACKUPS_PLURAL,
        labelSelector: `${DB_ID_LABEL}=${id}`,
      })) as { items?: Array<{ metadata?: { name?: string } }> };
      for (const b of backups.items ?? []) {
        const name = b.metadata?.name;
        if (!name) continue;
        await ignoreMissing(() =>
          this.objects.deleteNamespacedCustomObject({
            group: CNPG_GROUP,
            version: "v1",
            namespace: ns,
            plural: BACKUPS_PLURAL,
            name,
          }),
        );
      }
    }
    await ignoreMissing(() =>
      this.core.deleteNamespacedService({
        name: serviceName(id),
        namespace: ns,
      }),
    );
    await ignoreMissing(() =>
      this.net.deleteNamespacedNetworkPolicy({
        name: clusterName(id),
        namespace: ns,
      }),
    );
    await ignoreMissing(() =>
      this.core.deleteNamespacedSecret({ name: secretName(id), namespace: ns }),
    );

    // The retention policy deliberately keeps volumes when a StatefulSet is
    // removed, so DELETE has to remove them explicitly. This is the point at
    // which the customer's data actually goes.
    const pvcs = await this.core.listNamespacedPersistentVolumeClaim(
      {
        namespace: ns,
        labelSelector: `${DB_ID_LABEL}=${id}`,
      },
      // The merge-patch content type, which every patch this service sends
      // needs. Without it the client sends a JSON Patch — an array of
      // operations — and the API server rejects an object outright with
      // "cannot unmarshal object into Go value of type []handlers.jsonPatchOp".
      //
      // Written without it here, and hibernate returned 500 on a real cluster
      // while every unit test passed: a mocked client cannot notice a content
      // type. The same mistake, in the same shape, as the one the StatefulSet
      // patches carry a comment about.
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
    for (const pvc of pvcs.items ?? []) {
      const name = pvc.metadata?.name;
      if (name) {
        await ignoreMissing(() =>
          this.core.deleteNamespacedPersistentVolumeClaim({
            name,
            namespace: ns,
          }),
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
      throw new NotConfiguredError(
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
}

// The operator's status, narrowed to what a consumer asked for.
//
// The id is the OBJECT NAME, not barman's `backupId`. Barman's is only set once
// the backup completes, so a POST returned one identifier and the listing
// returned another for the same backup — a caller storing what POST gave it
// would never find it again. Measured, on a cluster, immediately.
//
// The object name is also what a restore names, so the id a caller is handed is
// the id the restore path accepts.
function toBackup(b: CnpgBackup): DatabaseBackup {
  return {
    id: b.metadata?.name ?? "",
    status: b.status?.phase ?? "pending",
    started_at: b.status?.startedAt,
    completed_at: b.status?.stoppedAt,
    ...(b.status?.backupId ? { backup_id: b.status.backupId } : {}),
    ...(b.status?.error ? { error: b.status.error } : {}),
  };
}
