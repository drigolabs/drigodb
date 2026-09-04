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
  PatchStrategy,
  setHeaderOptions,
} from "@kubernetes/client-node";
import type { V1StatefulSet } from "@kubernetes/client-node";

import { config } from "../config.js";
import {
  DB_ID_LABEL,
  EXTERNAL_ID_LABEL,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  POSTGRES_PORT,
  TEMPLATE_HASH_ANNOTATION,
  buildNetworkPolicy,
  buildPodTemplate,
  buildSecret,
  buildService,
  buildStatefulSet,
  connectionUri,
  endpointHost,
  secretName,
  serviceName,
  statefulSetName,
  templateHash,
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
      port: POSTGRES_PORT,
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
    // path, so the wake path is exercised on every single create — including
    // its reconcile, which lands on the no-op branch because the StatefulSet
    // was just built from the template it is about to be compared against.
    await this.wake(id);

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
    const sts = await this.statefulSetFor(id);
    // Read first, so waking something that does not exist is a 404 rather than
    // a 500 from the scale subresource.
    if (!sts) throw new NotFoundError(`no database with id ${id}`);

    await this.reconcile(sts);
    return this.scale(id, 1);
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

    // Only on the way up from hibernation. Callers wake speculatively — that is
    // what the endpoint is for — and a wake on a database that is already
    // serving must not touch it: rewriting the template of a running
    // StatefulSet rolls the pod and drops every live connection. A database
    // that is already awake reconciles on its next hibernate/wake cycle.
    if ((sts.spec?.replicas ?? 0) > 0) return;

    const want = templateHash(id, externalId);
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
          spec: { template: buildPodTemplate(id, externalId) },
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
    const sts = await this.statefulSetFor(id);
    if (!sts) throw new NotFoundError(`no database with id ${id}`);

    const externalId = sts.metadata?.labels?.[EXTERNAL_ID_LABEL] ?? "";
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
    if ((sts.spec?.replicas ?? 0) > 0) {
      await this.scale(id, 0);
      await this.waitForPodsGone(id);
      await this.wake(id);
      await this.waitForReady(id);
    }

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
    const name = statefulSetName(id);
    const namespace = config.databaseNamespace;
    let lastErr: unknown;

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const scale = await this.apps.readNamespacedStatefulSetScale({ name, namespace });
        scale.spec = { ...(scale.spec ?? {}), replicas };
        await this.apps.replaceNamespacedStatefulSetScale({ name, namespace, body: scale });
        return await this.get(id);
      } catch (err) {
        const code = (err as { code?: number })?.code;
        if (code !== 409) throw err;
        lastErr = err;
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
    }
    throw lastErr;
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
