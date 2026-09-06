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

import { ApisApi, StorageV1Api } from "@kubernetes/client-node";

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

// API discovery, not the CustomResourceDefinition API. Reading a CRD is a
// cluster-scoped permission drigodb would have to be granted; discovery is
// available to every authenticated account through the built-in
// `system:discovery` ClusterRole. Same answer, no new rights.
async function checkOperator(apis: ApisApi): Promise<Check> {
  try {
    const groups = await apis.getAPIVersions();
    const found = (groups.groups ?? []).some((g) => g.name === CNPG_GROUP);
    return found
      ? { name: "cloudnativepg", status: "ok", detail: `${CNPG_GROUP} is served by this cluster` }
      : {
          name: "cloudnativepg",
          status: "failed",
          detail:
            `the CloudNativePG operator is not installed: no ${CNPG_GROUP} API group. ` +
            "A database is a CNPG Cluster, so provisioning would fail. " +
            "Install it with scripts/cnpg-install.sh, or see docs/getting-started.md",
        };
  } catch (err) {
    return {
      name: "cloudnativepg",
      status: "unverified",
      detail: `could not read API discovery: ${(err as Error)?.message ?? err}`,
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
  apis: ApisApi,
  storage: StorageV1Api,
  wantedStorageClass: string = config.storageClass,
): Promise<Preflight> {
  const checks = await Promise.all([
    checkOperator(apis),
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
    private readonly apis: ApisApi,
    private readonly storage: StorageV1Api,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<Preflight> {
    if (this.last && this.now() - this.last.at < TTL_MS) return this.last.result;
    const result = await runPreflight(this.apis, this.storage, config.storageClass);
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
