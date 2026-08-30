// Provisioning operations against Kubernetes.
//
// Kubernetes is the source of truth. There is no control-plane database: a
// hosted database *is* its StatefulSet, and the caller's own identifier lives on
// it as a label. That keeps v0.0.1 to one moving part, and makes idempotency a
// label lookup rather than a transaction.

import { randomBytes } from "node:crypto";
import {
  AppsV1Api,
  CoreV1Api,
  KubeConfig,
  NetworkingV1Api,
} from "@kubernetes/client-node";

import { config } from "../config.js";
import {
  DB_ID_LABEL,
  EXTERNAL_ID_LABEL,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  MONGO_PORT,
  buildNetworkPolicy,
  buildSecret,
  buildService,
  buildStatefulSet,
  connectionUri,
  endpointHost,
  secretName,
  serviceName,
  statefulSetName,
} from "./manifests.js";

export type DatabaseStatus = "provisioning" | "ready" | "hibernated" | "failed";

export type Database = {
  id: string;
  external_id: string;
  status: DatabaseStatus;
  endpoint: string;
  port: number;
  created_at?: string;
};

// Kubernetes label values: alphanumeric, with dashes, underscores and dots
// permitted inside. Callers get a 400 rather than a confusing API-server error.
const EXTERNAL_ID_RE = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

export function validateExternalId(value: unknown): string {
  if (typeof value !== "string" || !EXTERNAL_ID_RE.test(value)) {
    throw new ValidationError(
      "external_id must be 1-63 characters of letters, digits, '-', '_' or '.', " +
        "starting and ending alphanumeric",
    );
  }
  return value;
}

function newId(): string {
  return randomBytes(6).toString("hex");
}

function newPassword(): string {
  return randomBytes(24).toString("base64url");
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
  ) {}

  static fromCluster(): Provisioner {
    const kc = new KubeConfig();
    // In-cluster when running as a pod; falls back to the local kubeconfig so
    // the same code path works in development.
    try {
      kc.loadFromCluster();
    } catch {
      kc.loadFromDefault();
    }
    return new Provisioner(
      kc.makeApiClient(AppsV1Api),
      kc.makeApiClient(CoreV1Api),
      kc.makeApiClient(NetworkingV1Api),
    );
  }

  private async statefulSetFor(id: string) {
    try {
      return await this.apps.readNamespacedStatefulSet({
        name: statefulSetName(id),
        namespace: config.databaseNamespace,
      });
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  private async statusOf(id: string, desiredReplicas: number, ready: number): Promise<DatabaseStatus> {
    if (desiredReplicas === 0) return "hibernated";
    if (ready > 0) return "ready";

    // Distinguish "still starting" from "stuck". A pod that cannot pull its
    // image or is crash-looping will never become ready on its own, and a
    // caller polling forever is worse than an error.
    const pods = await this.core.listNamespacedPod({
      namespace: config.databaseNamespace,
      labelSelector: `${DB_ID_LABEL}=${id}`,
    });
    for (const pod of pods.items ?? []) {
      for (const cs of pod.status?.containerStatuses ?? []) {
        const reason = cs.state?.waiting?.reason ?? "";
        if (reason === "CrashLoopBackOff" || reason.endsWith("ImagePullBackOff")) {
          return "failed";
        }
      }
    }
    return "provisioning";
  }

  private async toDatabase(sts: { metadata?: { labels?: Record<string, string>; creationTimestamp?: Date }; spec?: { replicas?: number }; status?: { readyReplicas?: number } }): Promise<Database> {
    const labels = sts.metadata?.labels ?? {};
    const id = labels[DB_ID_LABEL] ?? "";
    const status = await this.statusOf(id, sts.spec?.replicas ?? 0, sts.status?.readyReplicas ?? 0);
    return {
      id,
      external_id: labels[EXTERNAL_ID_LABEL] ?? "",
      status,
      endpoint: endpointHost(id),
      port: MONGO_PORT,
      created_at: sts.metadata?.creationTimestamp?.toISOString(),
    };
  }

  async findByExternalId(externalId: string): Promise<Database | undefined> {
    const list = await this.apps.listNamespacedStatefulSet({
      namespace: config.databaseNamespace,
      labelSelector: `${EXTERNAL_ID_LABEL}=${externalId},${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
    });
    const found = list.items?.[0];
    return found ? await this.toDatabase(found) : undefined;
  }

  async get(id: string): Promise<Database> {
    const sts = await this.statefulSetFor(id);
    if (!sts) throw new NotFoundError(`no database with id ${id}`);
    return this.toDatabase(sts);
  }

  async list(): Promise<Database[]> {
    const list = await this.apps.listNamespacedStatefulSet({
      namespace: config.databaseNamespace,
      labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
    });
    return Promise.all((list.items ?? []).map((s) => this.toDatabase(s)));
  }

  // Returns the database and its connection URI. The URI is returned here and
  // on rotation only — never from a plain GET — so a leaked read token does not
  // leak database credentials.
  async create(externalId: string): Promise<{ database: Database; uri: string; created: boolean }> {
    const existing = await this.findByExternalId(externalId);
    if (existing) {
      // Idempotent: a retry must not create a second database and split the
      // caller's data across two instances.
      return { database: existing, uri: "", created: false };
    }

    const id = newId();
    const password = newPassword();
    const ns = config.databaseNamespace;

    await this.core.createNamespacedSecret({ namespace: ns, body: buildSecret(id, externalId, password) });
    await this.core.createNamespacedService({ namespace: ns, body: buildService(id, externalId) });
    await this.net.createNamespacedNetworkPolicy({ namespace: ns, body: buildNetworkPolicy(id, externalId) });
    await this.apps.createNamespacedStatefulSet({ namespace: ns, body: buildStatefulSet(id, externalId) });

    // Created hibernated, then woken: provisioning and waking are the same code
    // path, so the wake path is exercised on every single create.
    await this.scale(id, 1);

    return { database: await this.get(id), uri: connectionUri(id, password), created: true };
  }

  async scale(id: string, replicas: number): Promise<Database> {
    const scale = await this.apps.readNamespacedStatefulSetScale({
      name: statefulSetName(id),
      namespace: config.databaseNamespace,
    });
    scale.spec = { ...(scale.spec ?? {}), replicas };
    await this.apps.replaceNamespacedStatefulSetScale({
      name: statefulSetName(id),
      namespace: config.databaseNamespace,
      body: scale,
    });
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    const ns = config.databaseNamespace;
    const sts = await this.statefulSetFor(id);
    if (!sts) throw new NotFoundError(`no database with id ${id}`);

    const ignoreMissing = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    };

    await ignoreMissing(() =>
      this.apps.deleteNamespacedStatefulSet({ name: statefulSetName(id), namespace: ns }),
    );
    await ignoreMissing(() => this.core.deleteNamespacedService({ name: serviceName(id), namespace: ns }));
    await ignoreMissing(() =>
      this.net.deleteNamespacedNetworkPolicy({ name: statefulSetName(id), namespace: ns }),
    );
    await ignoreMissing(() => this.core.deleteNamespacedSecret({ name: secretName(id), namespace: ns }));

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
}
