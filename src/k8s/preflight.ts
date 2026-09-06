// What has to be true about a cluster before drigodb can do its job.
//
// Both of these fail SILENTLY when they are missing, which is the reason this
// file exists rather than a line in the README:
//
//   - With no CloudNativePG operator, `helm install` succeeds, the Deployment
//     goes Ready, and the Role happily grants rights over an API group that does
//     not exist — Kubernetes permits that without complaint. Nothing is wrong
//     until a consumer provisions, and then everything is.
//   - With no default StorageClass, every database sits `provisioning` forever
//     because its PVC is never bound. There is no error anywhere to find.
//
// The chart cannot check either one. `lookup` is banned by
// scripts/chart-determinism-test.sh and `.Capabilities.APIVersions` is the same
// mistake with a friendlier name, since it answers from the renderer rather than
// the cluster. The API can check, because it is IN the cluster — so it does, and
// reports itself unready until the answer is yes.
//
// Unready rather than a startup crash, deliberately: the pod stays up with its
// logs readable, `kubectl get pods` shows which one it is, `helm install --wait`
// fails honestly, and the moment somebody installs the missing piece it goes
// Ready on the next probe with nothing to restart.

import { CustomObjectsApi, StorageV1Api } from "@kubernetes/client-node";

import { config } from "../config.js";

export const CNPG_GROUP = "postgresql.cnpg.io";
const DEFAULT_CLASS_ANNOTATION = "storageclass.kubernetes.io/is-default-class";

export type CheckStatus = "ok" | "failed" | "unverified";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface Preflight {
  ready: boolean;
  checks: Check[];
}

// Only `failed` blocks. `unverified` means drigodb was not allowed to look,
// which is a different fact from the thing being absent — and refusing to serve
// because a cluster declined to answer a question would make a hardened
// installation unusable for a check that exists to help it.
function readyFrom(checks: Check[]): boolean {
  return checks.every((c) => c.status !== "failed");
}

// Ask the exact question provisioning asks: can Clusters be listed in the
// namespace databases are created in.
//
// An earlier version checked API discovery for the `postgresql.cnpg.io` GROUP,
// which is a weaker question wearing the same clothes. CloudNativePG installs
// nine CRDs in that group, so the group survives the loss of any one of them —
// deleting `clusters.postgresql.cnpg.io` outright left discovery still reporting
// the group as served, and drigodb still reporting itself ready. Found by trying
// to write a test for the check.
//
// Listing also covers the RBAC in the same call, which discovery never could: a
// correctly installed operator drigodb has no permission to drive fails here,
// where it used to pass and then fail at the first provision.
async function checkOperator(objects: CustomObjectsApi): Promise<Check> {
  try {
    await objects.listNamespacedCustomObject({
      group: CNPG_GROUP,
      version: "v1",
      namespace: config.databaseNamespace,
      plural: "clusters",
      limit: 1,
    });
    return {
      name: "cloudnativepg",
      status: "ok",
      detail: `Clusters are listable in ${config.databaseNamespace}`,
    };
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 403) {
      return {
        name: "cloudnativepg",
        status: "failed",
        detail:
          `not permitted to list ${CNPG_GROUP} Clusters in ${config.databaseNamespace}. ` +
          "The operator is installed but drigodb cannot drive it, so provisioning would fail",
      };
    }
    if (code === 404) {
      return {
        name: "cloudnativepg",
        status: "failed",
        detail:
          `no ${CNPG_GROUP}/v1 Clusters resource, or no ${config.databaseNamespace} namespace. ` +
          "A database is a CNPG Cluster, so provisioning would fail. " +
          "Install the operator with scripts/cnpg-install.sh, or see docs/getting-started.md",
      };
    }
    // Anything else is the cluster declining to answer rather than answering no.
    return {
      name: "cloudnativepg",
      status: "unverified",
      detail: `could not list Clusters: ${(err as Error)?.message ?? err}`,
    };
  }
}

// Named class or cluster default, whichever this installation asked for. Both
// are worth checking and they fail the same way: a PVC that is never bound and a
// database that never leaves `provisioning`.
async function checkStorageClass(storage: StorageV1Api, want: string): Promise<Check> {
  try {
    const list = await storage.listStorageClass();
    const items = list.items ?? [];

    if (want) {
      const found = items.some((c) => c.metadata?.name === want);
      return found
        ? { name: "storageclass", status: "ok", detail: `${want} exists` }
        : {
            name: "storageclass",
            status: "failed",
            detail:
              `database.storageClass is set to "${want}" and no such StorageClass exists. ` +
              `This cluster has: ${items.map((c) => c.metadata?.name).join(", ") || "none"}`,
          };
    }

    const defaults = items.filter(
      (c) => c.metadata?.annotations?.[DEFAULT_CLASS_ANNOTATION] === "true",
    );
    if (defaults.length === 1) {
      return {
        name: "storageclass",
        status: "ok",
        detail: `cluster default is ${defaults[0]?.metadata?.name}`,
      };
    }
    // More than one default is not a drigodb problem, but it is a coin toss over
    // which one a database lands on, and saying so costs nothing.
    if (defaults.length > 1) {
      return {
        name: "storageclass",
        status: "ok",
        detail:
          `this cluster has ${defaults.length} default StorageClasses ` +
          `(${defaults.map((c) => c.metadata?.name).join(", ")}); set database.storageClass to choose`,
      };
    }
    return {
      name: "storageclass",
      status: "failed",
      detail:
        "no default StorageClass and database.storageClass is unset, so every database " +
        `would sit in provisioning with an unbound volume. This cluster has: ${
          items.map((c) => c.metadata?.name).join(", ") || "no StorageClasses at all"
        }`,
    };
  } catch (err) {
    // 403 is the expected shape on a cluster that declined the ClusterRole.
    // "I was not allowed to look" is not "it is missing", and treating them the
    // same would make drigodb unusable exactly where it is most carefully run.
    const code = (err as { code?: number })?.code;
    return {
      name: "storageclass",
      status: "unverified",
      detail:
        code === 403
          ? "not permitted to list StorageClasses, so this could not be checked — " +
            "a database with an unbound volume will sit in provisioning"
          : `could not list StorageClasses: ${(err as Error)?.message ?? err}`,
    };
  }
}

// The wanted StorageClass is a parameter rather than read from config here, so
// the two branches — named class, cluster default — are both reachable from a
// test without reloading a module to change an environment variable.
export async function runPreflight(
  objects: CustomObjectsApi,
  storage: StorageV1Api,
  wantedStorageClass: string = config.storageClass,
): Promise<Preflight> {
  const checks = await Promise.all([
    checkOperator(objects),
    checkStorageClass(storage, wantedStorageClass),
  ]);
  return { ready: readyFrom(checks), checks };
}

// Cached, because the readiness probe runs every few seconds and neither answer
// changes often. Short enough that installing the missing piece is noticed
// within one probe interval rather than one deploy.
const TTL_MS = 10_000;

export class PreflightCache {
  private last?: { at: number; result: Preflight };

  constructor(
    private readonly objects: CustomObjectsApi,
    private readonly storage: StorageV1Api,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<Preflight> {
    if (this.last && this.now() - this.last.at < TTL_MS) return this.last.result;
    const result = await runPreflight(this.objects, this.storage, config.storageClass);
    this.last = { at: this.now(), result };
    return result;
  }
}

export function logPreflight(p: Preflight): void {
  for (const c of p.checks) {
    const mark = c.status === "ok" ? "✓" : c.status === "unverified" ? "?" : "✗";
    console.log(`[drigodb] preflight ${mark} ${c.name}: ${c.detail}`);
  }
  if (!p.ready) {
    console.error(
      "[drigodb] NOT READY — the cluster is missing something drigodb needs. " +
        "The pod stays up and will become ready on its own once this is fixed.",
    );
  }
}
