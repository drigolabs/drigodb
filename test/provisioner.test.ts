// What survives the move to CloudNativePG.
//
// The wake tests that used to open this file pinned a pod-template reconcile
// drigodb no longer performs: the operator owns the template and rolls it
// itself. What is left is the part that is still drigodb's — idempotent create,
// the lock, and the statuses a consumer polls.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DB_ID_LABEL,
  EXTERNAL_ID_LABEL,
  PASSWORD_SECRET_KEY,
} from "../src/k8s/manifests.js";
import {
  DeletionInFlightError,
  NotFoundError,
  Provisioner,
  ResizeRefusedError,
  ValidationError,
  validateHighAvailability,
  validateHighAvailabilityChange,
  validateRestoreFrom,
  validateRestoreInPlace,
  validateTier,
} from "../src/k8s/provisioner.js";

const ID = "a1b2c3d4e5f6";
const EXT = "openvoid-app-01JQ";

// A cluster made of CloudNativePG Clusters, kept honest about the two things
// these tests turn on: object names are unique within a namespace, and a
// Cluster reports its own readiness.
function racingCluster() {
  const created: string[] = [];
  const objects = new Map<string, { labels: Record<string, string>; ready: number }>();
  const pvcs: Array<{ metadata: { name: string } }> = [];
  const conflict = () => Object.assign(new Error("already exists"), { code: 409 });
  const notFound = () => Object.assign(new Error("not found"), { code: 404 });

  type Body = { metadata: { name: string; labels: Record<string, string> } };
  const objectsApi = {
    // The lock. Kubernetes refuses a second object with the same name, and that
    // refusal is the whole of drigodb's idempotency.
    createNamespacedCustomObject: async (req: { body: Body }) => {
      const name = req.body.metadata.name;
      if (objects.has(name)) throw conflict();
      // Ready immediately: these tests are about the race, not about waiting.
      objects.set(name, { labels: { ...req.body.metadata.labels }, ready: 1 });
      created.push(name);
      return req.body;
    },
    getNamespacedCustomObject: async (req: { name: string }) => {
      const o = objects.get(req.name);
      if (!o) throw notFound();
      return { metadata: { name: req.name, labels: o.labels }, status: { readyInstances: o.ready } };
    },
    listNamespacedCustomObject: async () => ({
      items: [...objects.entries()].map(([name, o]) => ({
        metadata: { name, labels: o.labels },
        status: { readyInstances: o.ready },
      })),
    }),
    patchNamespacedCustomObject: async (req: {
      name: string;
      body: { metadata?: { labels?: Record<string, string> } };
    }) => {
      const o = objects.get(req.name);
      if (o) Object.assign(o.labels, req.body.metadata?.labels ?? {});
      return {};
    },
  };
  const core = {
    createNamespacedSecret: async () => ({}),
    createNamespacedService: async () => ({}),
    // Readiness is counted from pods now, because a hibernated Cluster still
    // reports readyInstances: 1 with nothing running. The fake has to serve
    // pods or every database looks like it is still provisioning.
    listNamespacedPod: async () => ({
      items: [...objects.values()]
        .filter((o) => o.ready > 0)
        .map(() => ({ status: { conditions: [{ type: "Ready", status: "True" }] } })),
    }),
    listNamespacedPersistentVolumeClaim: async () => ({ items: pvcs }),
  };
  // wake() rewrites the policy rather than leaving whatever is there, so the
  // fake records the call: a database provisioned by an older drigodb is the
  // only way an out-of-date policy exists, and nothing else repairs one.
  const netCalls: Array<{ name: string; ingress: unknown[] }> = [];
  const net = {
    createNamespacedNetworkPolicy: async () => ({}),
    replaceNamespacedNetworkPolicy: async (req: {
      name: string;
      body: { spec?: { ingress?: unknown[] } };
    }) => {
      netCalls.push({ name: req.name, ingress: req.body.spec?.ingress ?? [] });
      return {};
    },
  };
  const batch = { readNamespacedJob: async () => { throw notFound(); } };

  return {
    created,
    objects,
    pvcs,
    netCalls,
    provisioner: new Provisioner(
      {} as never, core as never, net as never, batch as never, objectsApi as never,
    ),
  };
}

describe("tier validation", () => {
  it("accepts the three tiers", () => {
    for (const t of ["small", "medium", "large"]) expect(validateTier(t)).toBe(t);
  });

  it("rejects anything else", () => {
    for (const t of ["", "huge", "SMALL", 1, null, undefined, {}]) {
      expect(() => validateTier(t)).toThrow(ValidationError);
    }
  });
});

// Growing a database. The assertion that earns its place is the ORDER: the
// volume must grow before max_wal_size rises, because raising the WAL ceiling on
// a volume that has not grown is how PostgreSQL PANICs on a full disk.

// Two replicas handling the same external_id at the same moment. Before the
// StatefulSet's name became the lock, both found nothing and both created —
// which is exactly the failure idempotency exists to prevent, and it only became
// reachable with more than one replica.
describe("concurrent create", () => {


  it("creates one database when two replicas race on the same external_id", async () => {
    const { provisioner, created } = racingCluster();
    const [a, b] = await Promise.all([
      provisioner.create("same-app"),
      provisioner.create("same-app"),
    ]);
    expect(created).toHaveLength(1);
    expect(a.database.id).toBe(b.database.id);
    // Exactly one of them owns the password, and only that one may hand back a URI.
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect([a.uri, b.uri].filter((u) => u !== "")).toHaveLength(1);
  });

  it("gives the same id for the same external_id, and different ids for different ones", async () => {
    const { provisioner } = racingCluster();
    const first = await provisioner.create("app-one");
    const { provisioner: other } = racingCluster();
    const again = await other.create("app-one");
    const different = await other.create("app-two");
    expect(again.database.id).toBe(first.database.id);
    expect(different.database.id).not.toBe(first.database.id);
    expect(first.database.id).toMatch(/^[0-9a-f]{12}$/);
  });

  // Found on a kind cluster running two API replicas, not in a mock: eight
  // simultaneous creates of one external_id produced one database, and seven of
  // the eight callers were told it was hibernated. Zero replicas is what a
  // create looks like between the StatefulSet and the wake that follows it, and
  // the losing caller lands in exactly that window every time.
  it("tells a losing caller the database is provisioning, not hibernated", async () => {
    const { provisioner, objects } = racingCluster();
    const { database } = await provisioner.create("mid-create");

    // Back to the state the winner leaves behind: the Cluster exists and the
    // operator has not brought an instance up yet.
    objects.get(`db-${database.id}`)!.ready = 0;

    expect((await provisioner.get(database.id)).status).toBe("provisioning");
  });

  it("reports hibernated once something asked for it", async () => {
    const { provisioner } = racingCluster();
    const { database } = await provisioner.create("put-me-down");

    expect(database.status).toBe("ready");
    expect((await provisioner.scale(database.id, 0)).status).toBe("hibernated");
    expect((await provisioner.wake(database.id)).status).toBe("ready");
  });

  // The "no hibernation label" fallback that used to be tested here is gone
  // with the data plane that needed it. Every Cluster drigodb creates carries
  // the label from birth, so there is no database whose intent has to be
  // guessed from a replica count.



  // The other edge of a derived id: the name is reused, so the volume name is
  // reused too. PVC deletion is not instant, and a database created into a
  // surviving volume comes up on the deleted database's rows behind a password
  // that does not match the URI just handed out.
  it("refuses a create landing on a volume that has not finished going", async () => {
    const { provisioner, objects, pvcs } = racingCluster();
    const { database } = await provisioner.create("delete-then-recreate");

    objects.delete(`db-${database.id}`);
    pvcs.push({ metadata: { name: `data-db-${database.id}-0` } });

    await expect(provisioner.create("delete-then-recreate")).rejects.toThrow(DeletionInFlightError);

    // And succeeds once the volume is actually gone.
    pvcs.length = 0;
    await expect(provisioner.create("delete-then-recreate")).resolves.toMatchObject({ created: true });
  });

  it("does not mistake a live database's own volume for one being deleted", async () => {
    const { provisioner, pvcs } = racingCluster();
    const { database } = await provisioner.create("still-here");
    pvcs.push({ metadata: { name: `data-db-${database.id}-0` } });

    const again = await provisioner.create("still-here");
    expect(again.created).toBe(false);
    expect(again.database.id).toBe(database.id);
  });

  it("refuses rather than handing over a database belonging to another external_id", async () => {
    // A hash collision needs millions of external_ids, and handing one caller
    // another's database with its credentials is not a failure to find in
    // production.
    const { provisioner, objects } = racingCluster();
    const { database } = await provisioner.create("app-one");
    // Simulate the collision by making the live Cluster claim a different
    // owner, which is what a genuine hash collision would look like from here.
    objects.get(`db-${database.id}`)!.labels["drigodb.io/external-id"] = "someone-else";
    await expect(provisioner.create("app-one")).rejects.toThrow(ValidationError);
  });
});

describe("restore_from validation", () => {
  it("is absent when not asked for", () => {
    expect(validateRestoreFrom(undefined)).toBeUndefined();
    expect(validateRestoreFrom(null)).toBeUndefined();
  });

  it("accepts a database id, with or without a backup", () => {
    expect(validateRestoreFrom({ database_id: "a1b2c3d4e5f6" })).toEqual({
      databaseId: "a1b2c3d4e5f6",
    });
    expect(
      validateRestoreFrom({ database_id: "a1b2c3d4e5f6", backup_id: "bk-a1b2c3d4e5f6-20260907" }),
    ).toEqual({ databaseId: "a1b2c3d4e5f6", backupId: "bk-a1b2c3d4e5f6-20260907" });
  });

  it("refuses anything that is not a database id", () => {
    // Both fields end up in a Kubernetes object name. The old shape took a
    // bucket key and had to be checked for `..` to stop one caller reading
    // another's prefix; there is no path here now, only ids this service issued.
    for (const bad of ["", "nope", "../../etc", "A1B2C3D4E5F6", "a1b2c3d4e5f", 12]) {
      expect(() => validateRestoreFrom({ database_id: bad })).toThrow(ValidationError);
    }
  });

  it("refuses a backup id that is not a name", () => {
    for (const bad of ["../secret", "Bk-Upper", "with spaces", ""]) {
      expect(() =>
        validateRestoreFrom({ database_id: "a1b2c3d4e5f6", backup_id: bad }),
      ).toThrow(ValidationError);
    }
  });

  it("refuses a malformed body", () => {
    expect(() => validateRestoreFrom("a1b2c3d4e5f6")).toThrow(ValidationError);
    expect(() => validateRestoreFrom({})).toThrow(ValidationError);
  });
});

// Recovering to an instant rather than to a backup (#19). WAL has been archived
// for every database since backups shipped; this is what makes it reachable.
describe("restore_from target_time", () => {
  const NOW = new Date("2026-09-09T12:00:00.000Z");

  it("sends PostgreSQL's timestamp format, which is the only spelling that survives", () => {
    // Not cosmetic and not RFC3339 by mistake. CloudNativePG rewrites an
    // RFC3339 value with a Go layout whose zero-offset form is a literal `Z`,
    // and PostgreSQL refuses `recovery_target_time = '... .389000Z'` outright —
    // the instance never starts. A space-separated timestamp is not RFC3339, so
    // the rewrite cannot parse it and passes it through untouched.
    //
    // Every spelling below names the same instant and must produce one value.
    for (const sent of [
      "2026-09-09T09:30:00+02:00",
      "2026-09-09T07:30:00Z",
      "2026-09-09T07:30:00.000Z",
      "2026-09-09T07:30:00.000+00:00",
    ]) {
      expect(
        validateRestoreFrom({ database_id: "a1b2c3d4e5f6", target_time: sent }, NOW),
      ).toEqual({ databaseId: "a1b2c3d4e5f6", targetTime: "2026-09-09 07:30:00.000000+00:00" });
    }
  });

  it("refuses a timestamp with no UTC offset", () => {
    // The failure this prevents is silent: every one of these parses, and each
    // resolves against the control plane's own timezone rather than against
    // anything the caller said. A restore then lands hours from the instant
    // asked for and reports success.
    for (const bad of ["2026-09-09", "2026-09-09T09:30:00", "2026-09-09 09:30:00"]) {
      expect(() =>
        validateRestoreFrom({ database_id: "a1b2c3d4e5f6", target_time: bad }, NOW),
      ).toThrow(ValidationError);
    }
  });

  it("refuses a target in the future", () => {
    expect(() =>
      validateRestoreFrom({ database_id: "a1b2c3d4e5f6", target_time: "2026-09-09T12:00:01Z" }, NOW),
    ).toThrow(ValidationError);
  });

  it("refuses a target that is not a timestamp at all", () => {
    for (const bad of ["yesterday", "", 1757419200, {}]) {
      expect(() =>
        validateRestoreFrom({ database_id: "a1b2c3d4e5f6", target_time: bad }, NOW),
      ).toThrow(ValidationError);
    }
  });

  it("refuses a backup id and a target time together", () => {
    // CloudNativePG would take both — a backup id narrows which base backup the
    // replay starts from — but a caller sending both usually means one of them,
    // and guessing which is how a restore lands somewhere nobody asked for.
    expect(() =>
      validateRestoreFrom(
        {
          database_id: "a1b2c3d4e5f6",
          backup_id: "bk-a1b2c3d4e5f6-20260907",
          target_time: "2026-09-09T09:30:00Z",
        },
        NOW,
      ),
    ).toThrow(ValidationError);
  });
});

// A rule added after a database was provisioned reaches that database only if
// something rewrites its policy. Nothing did: the policy was written once at
// create and never looked at again, so every existing database kept the rules
// it was born with while new ones got the current set.
//
// Waking is where the repair happens, which makes the limit worth stating in a
// test too: a database that never sleeps never wakes, and so never gains one.
describe("wake reconciles the NetworkPolicy", () => {
  it("rewrites the policy to what this build renders", async () => {
    const { provisioner, netCalls } = racingCluster();
    const { database } = await provisioner.create(EXT);

    expect(netCalls).toHaveLength(0);
    await provisioner.wake(database.id);

    expect(netCalls).toHaveLength(1);
    expect(netCalls[0]?.name).toBe(`db-${database.id}`);
    // Non-empty, because the failure this prevents is a database coming back
    // with a policy that admits everything or nothing.
    expect(netCalls[0]?.ingress.length).toBeGreaterThan(0);
  });
});

// The guard in front of a recovery that cannot succeed.
//
// Without it the failure is a Cluster that bootstraps, replays, gives up and
// says so minutes later — after the caller has a 202, a database id and a URI
// for something that will never come up.
describe("recovering to an instant", () => {
  // Backups configured, which resolveRestore requires before it will look at
  // anything, and a source database that no longer exists — the case a restore
  // is most often for.
  async function withBackups(backups: Array<{ phase: string; started: string; stopped?: string }>) {
    vi.resetModules();
    vi.stubEnv("DRIGODB_BACKUP_OBJECT_STORE", "drigodb-api-backups");
    const { Provisioner: P, ValidationError: VE } = await import("../src/k8s/provisioner.js");
    const notFound = () => Object.assign(new Error("not found"), { code: 404 });
    // Only what this test creates exists. The SOURCE database is deliberately
    // never in here: it was deleted, and its backups outlived it.
    const clusters = new Map<string, { metadata: { name: string; labels: Record<string, string> } }>();
    const objectsApi = {
      getNamespacedCustomObject: async (req: { name: string }) => {
        const c = clusters.get(req.name);
        if (!c) throw notFound();
        return { ...c, status: { readyInstances: 1 } };
      },
      listNamespacedCustomObject: async () => ({
        items: backups.map((b, i) => ({
          metadata: { name: `bk-${i}` },
          status: {
            phase: b.phase,
            backupId: `2026090${i}T000000`,
            startedAt: b.started,
            stoppedAt: b.stopped,
          },
        })),
      }),
      createNamespacedCustomObject: async (req: {
        body: { metadata: { name: string; labels: Record<string, string> } };
      }) => {
        clusters.set(req.body.metadata.name, req.body);
        return req.body;
      },
    };
    const core = {
      listNamespacedPersistentVolumeClaim: async () => ({ items: [] }),
      createNamespacedSecret: async () => ({}),
      createNamespacedService: async () => ({}),
      listNamespacedPod: async () => ({
        items: [...clusters.keys()].map(() => ({
          status: { conditions: [{ type: "Ready", status: "True" }] },
        })),
      }),
    };
    const net = { createNamespacedNetworkPolicy: async () => ({}) };
    const batch = { readNamespacedJob: async () => { throw notFound(); } };
    return {
      ValidationError: VE,
      provisioner: new P(
        {} as never, core as never, net as never, batch as never, objectsApi as never,
      ),
    };
  }

  const SOURCE = "0123456789ab";

  it("refuses a target before the earliest backup finished", async () => {
    const { provisioner, ValidationError: VE } = await withBackups([
      { phase: "completed", started: "2026-09-08T10:00:00Z", stopped: "2026-09-08T10:05:00Z" },
    ]);
    await expect(
      provisioner.create("app", { databaseId: SOURCE, targetTime: "2026-09-08T09:00:00Z" }),
    ).rejects.toThrow(VE);
  });

  it("refuses a target inside the backup that has not finished yet", async () => {
    // A base backup is consistent at its END. A target between start and stop
    // is in a window nothing can replay from, and checking against started_at
    // would call it satisfiable.
    const { provisioner, ValidationError: VE } = await withBackups([
      { phase: "completed", started: "2026-09-08T10:00:00Z", stopped: "2026-09-08T10:05:00Z" },
    ]);
    await expect(
      provisioner.create("app", { databaseId: SOURCE, targetTime: "2026-09-08T10:02:00Z" }),
    ).rejects.toThrow(VE);
  });

  it("refuses when no backup ever completed", async () => {
    const { provisioner, ValidationError: VE } = await withBackups([
      { phase: "running", started: "2026-09-08T10:00:00Z" },
    ]);
    await expect(
      provisioner.create("app", { databaseId: SOURCE, targetTime: "2026-09-08T11:00:00Z" }),
    ).rejects.toThrow(VE);
  });

  it("allows a target after a backup finished, from a database that is gone", async () => {
    // No upper bound to check: WAL beyond the newest backup is the whole point,
    // and the source Cluster being absent must not turn this into a 404.
    const { provisioner } = await withBackups([
      { phase: "completed", started: "2026-09-08T10:00:00Z", stopped: "2026-09-08T10:05:00Z" },
    ]);
    await expect(
      provisioner.create("app", { databaseId: SOURCE, targetTime: "2026-09-09T11:00:00Z" }),
    ).resolves.toBeDefined();
  });
});

describe("high_availability validation", () => {
  it("defaults to off when not asked for", () => {
    expect(validateHighAvailability(undefined)).toBe(false);
    expect(validateHighAvailability(null)).toBe(false);
    expect(validateHighAvailability(false)).toBe(false);
  });

  it("accepts a boolean", () => {
    expect(validateHighAvailability(true)).toBe(true);
  });

  it("refuses anything that merely looks like one", () => {
    // "false" is truthy, and a caller sending the string would otherwise get a
    // standby, a doubled volume count and a bill for both.
    for (const bad of ["true", "false", 1, 0, "", "yes", {}, []]) {
      expect(() => validateHighAvailability(bad)).toThrow(ValidationError);
    }
  });
});

// What a caller is told about redundancy. A database that believes it is
// protected while its standby is gone is the worst of the three states, so the
// intent and the current truth are reported separately.
describe("reporting a standby", () => {
  function clusterWith(instances: number, readyPods: number, hibernated = false) {
    const notFound = () => Object.assign(new Error("not found"), { code: 404 });
    const labels: Record<string, string> = {
      "drigodb.io/database-id": ID,
      "drigodb.io/external-id": EXT,
      ...(hibernated ? { "drigodb.io/hibernated": "true" } : {}),
    };
    const objectsApi = {
      getNamespacedCustomObject: async () => ({
        metadata: { name: `db-${ID}`, labels },
        spec: { instances },
        status: { readyInstances: readyPods },
      }),
      listNamespacedCustomObject: async () => ({ items: [] }),
    };
    const core = {
      listNamespacedPod: async () => ({
        items: Array.from({ length: readyPods }, () => ({
          status: { conditions: [{ type: "Ready", status: "True" }] },
        })),
      }),
      listNamespacedPersistentVolumeClaim: async () => ({ items: [] }),
    };
    const net = { createNamespacedNetworkPolicy: async () => ({}) };
    const batch = { readNamespacedJob: async () => { throw notFound(); } };
    return new Provisioner(
      {} as never, core as never, net as never, batch as never, objectsApi as never,
    );
  }

  it("says nothing about a standby on a single-instance database", async () => {
    const db = await clusterWith(1, 1).get(ID);
    expect(db.high_availability).toBe(false);
    expect(db).not.toHaveProperty("standby");
  });

  it("reports a standby that is there", async () => {
    const db = await clusterWith(2, 2).get(ID);
    expect(db.high_availability).toBe(true);
    expect(db.standby).toBe("ready");
  });

  it("reports a standby that is missing, while the database is still up", async () => {
    // The state the feature is meant to make visible: one pod ready out of two,
    // so the database serves and is no longer protected. `ready` and
    // `unavailable` together, not one or the other.
    const db = await clusterWith(2, 1).get(ID);
    expect(db.status).toBe("ready");
    expect(db.high_availability).toBe(true);
    expect(db.standby).toBe("unavailable");
  });

  it("does not call a hibernated database's standby unhealthy", async () => {
    // Nothing is running because nothing should be. Reporting `unavailable`
    // here sends somebody looking for a fault that is not there.
    const db = await clusterWith(2, 0, true).get(ID);
    expect(db.status).toBe("hibernated");
    expect(db.high_availability).toBe(true);
    expect(db).not.toHaveProperty("standby");
  });
});

// `ready` has to mean "the endpoint reaches a database", not "some pod is up".
//
// drigodb's Service selects cnpg.io/instanceRole=primary, so a pod that is Ready
// but not yet primary leaves the Service with no endpoints and the ClusterIP
// refusing connections. Two ways to be in that state: a restored database
// replaying WAL before promotion, and a database whose standby is up while its
// primary is not.
describe("ready means connectable", () => {
  function clusterWithPods(pods: Record<string, number>, instances = 1) {
    const notFound = () => Object.assign(new Error("not found"), { code: 404 });
    const objectsApi = {
      getNamespacedCustomObject: async () => ({
        metadata: {
          name: `db-${ID}`,
          labels: { "drigodb.io/database-id": ID, "drigodb.io/external-id": EXT },
        },
        spec: { instances },
        status: { readyInstances: 1, phase: "Cluster in healthy state" },
      }),
      listNamespacedCustomObject: async () => ({ items: [] }),
    };
    const core = {
      // Honours the selector, unlike the other fakes here — which is the whole
      // point: the bug this pins is a wrong selector, and a mock that ignores
      // selectors agrees with every one of them.
      listNamespacedPod: async (req: { labelSelector: string }) => {
        const role = req.labelSelector.includes("instanceRole=primary")
          ? "primary"
          : "instance";
        return {
          items: Array.from({ length: pods[role] ?? 0 }, () => ({
            status: { conditions: [{ type: "Ready", status: "True" }] },
          })),
        };
      },
      listNamespacedPersistentVolumeClaim: async () => ({ items: [] }),
    };
    const net = { createNamespacedNetworkPolicy: async () => ({}) };
    const batch = { readNamespacedJob: async () => { throw notFound(); } };
    return new Provisioner(
      {} as never, core as never, net as never, batch as never, objectsApi as never,
    );
  }

  it("is not ready while a restored instance is up but not yet promoted", async () => {
    // One instance pod, Ready, and no primary: recovery has replayed enough to
    // pass the probe and CloudNativePG has not promoted it. Reporting `ready`
    // here is what made a restore hand back a URI that refused connections.
    const db = await clusterWithPods({ instance: 1, primary: 0 }).get(ID);
    expect(db.status).toBe("provisioning");
  });

  it("is ready once a primary exists", async () => {
    const db = await clusterWithPods({ instance: 1, primary: 1 }).get(ID);
    expect(db.status).toBe("ready");
  });

  it("is not ready when only the standby is up", async () => {
    // Not a race: a standby is podRole=instance forever. Counting those made a
    // database with a dead primary report ready while its endpoint pointed at
    // nothing.
    const db = await clusterWithPods({ instance: 1, primary: 0 }, 2).get(ID);
    expect(db.status).toBe("provisioning");
  });

  it("still counts both instances when reporting the standby", async () => {
    // The standby's health is a different question from connectability and
    // still uses every instance pod.
    const db = await clusterWithPods({ instance: 2, primary: 1 }, 2).get(ID);
    expect(db.status).toBe("ready");
    expect(db.standby).toBe("ready");
  });
});

// Every patch this service sends needs the merge-patch content type, and a
// mocked client will accept any of them — which is how resize shipped broken.
//
// The fake below records the OPTIONS argument, because that is where the bug
// was: the request body was right, the URL was right, and the API server
// rejected it for its content type alone.
describe("patches declare their content type", () => {
  function recordingProvisioner() {
    const patches: Array<{ name?: string; options: unknown }> = [];
    const notFound = () => Object.assign(new Error("not found"), { code: 404 });
    const cluster = {
      metadata: {
        name: `db-${ID}`,
        labels: { "drigodb.io/database-id": ID, "drigodb.io/external-id": EXT, "drigodb.io/tier": "small" },
      },
      spec: { instances: 1, storage: { size: "1Gi" } },
      status: { readyInstances: 1 },
    };
    const objectsApi = {
      getNamespacedCustomObject: async () => cluster,
      listNamespacedCustomObject: async () => ({ items: [] }),
      patchNamespacedCustomObject: async (req: { name?: string }, options: unknown) => {
        patches.push({ name: req.name, options });
        return {};
      },
    };
    const core = {
      listNamespacedPod: async () => ({
        items: [{ status: { conditions: [{ type: "Ready", status: "True" }] } }],
      }),
      listNamespacedPersistentVolumeClaim: async () => ({ items: [] }),
    };
    const net = { createNamespacedNetworkPolicy: async () => ({}) };
    const batch = { readNamespacedJob: async () => { throw notFound(); } };
    return {
      patches,
      provisioner: new Provisioner(
        {} as never, core as never, net as never, batch as never, objectsApi as never,
      ),
    };
  }

  // setHeaderOptions does not return a headers map — it returns middleware whose
  // `pre` calls request.setHeaderParam. Running it against a stub request is the
  // only way to assert the header that actually goes on the wire, rather than
  // asserting that some options object was passed.
  function contentType(options: unknown): string | undefined {
    const middleware =
      (options as { middleware?: Array<{ pre: (r: unknown) => unknown }> })?.middleware ?? [];
    const headers: Record<string, string> = {};
    const request = {
      setHeaderParam: (k: string, v: string) => {
        headers[k] = v;
      },
    };
    for (const m of middleware) m.pre(request);
    return headers["Content-Type"];
  }

  it("resize patches the Cluster as a merge patch", async () => {
    // Without this, every resize on every cluster returned:
    //   error decoding patch: json: cannot unmarshal object into Go value of
    //   type []handlers.jsonPatchOp
    const { provisioner, patches } = recordingProvisioner();
    await provisioner.resize(ID, "medium");
    expect(patches.length).toBeGreaterThan(0);
    for (const p of patches) {
      expect(contentType(p.options)).toBe("application/merge-patch+json");
    }
  });

  it("scale patches the Cluster as a merge patch", async () => {
    const { provisioner, patches } = recordingProvisioner();
    await provisioner.scale(ID, 0);
    expect(patches.length).toBeGreaterThan(0);
    for (const p of patches) {
      expect(contentType(p.options)).toBe("application/merge-patch+json");
    }
  });
});

// A standby that is coming back, and one that never will, look identical from
// outside. Measured on a cluster: healthy archiving re-protects the pair in 21
// seconds; failing archiving never does, because the demoted instance cannot
// archive the WAL it wrote before demotion and cannot rejoin until it has.
describe("a standby that cannot return says so", () => {
  async function withBackupsAndCluster(opts: {
    instances: number;
    readyPods: number;
    archiving?: "True" | "False";
    hibernated?: boolean;
  }) {
    vi.resetModules();
    vi.stubEnv("DRIGODB_BACKUP_OBJECT_STORE", "drigodb-api-backups");
    const { Provisioner: P } = await import("../src/k8s/provisioner.js");
    const notFound = () => Object.assign(new Error("not found"), { code: 404 });
    const labels: Record<string, string> = {
      "drigodb.io/database-id": ID,
      "drigodb.io/external-id": EXT,
      ...(opts.hibernated ? { "drigodb.io/hibernated": "true" } : {}),
    };
    const objectsApi = {
      getNamespacedCustomObject: async () => ({
        metadata: { name: `db-${ID}`, labels },
        spec: { instances: opts.instances },
        status: {
          phase: "Cluster in healthy state",
          ...(opts.archiving
            ? { conditions: [{ type: "ContinuousArchiving", status: opts.archiving }] }
            : {}),
        },
      }),
      listNamespacedCustomObject: async () => ({ items: [] }),
    };
    const core = {
      // Honours the selector: readiness counts primaries, the standby count
      // counts every instance, and conflating them is its own bug.
      listNamespacedPod: async (req: { labelSelector: string }) => {
        const n = req.labelSelector.includes("instanceRole=primary")
          ? Math.min(opts.readyPods, 1)
          : opts.readyPods;
        return {
          items: Array.from({ length: n }, () => ({
            status: { conditions: [{ type: "Ready", status: "True" }] },
          })),
        };
      },
      listNamespacedPersistentVolumeClaim: async () => ({ items: [] }),
    };
    const net = { createNamespacedNetworkPolicy: async () => ({}) };
    const batch = { readNamespacedJob: async () => { throw notFound(); } };
    return new P(
      {} as never, core as never, net as never, batch as never, objectsApi as never,
    ).get(ID);
  }

  it("calls a missing standby `blocked` when WAL archiving is failing", async () => {
    // The state that never resolves. Reporting it as `unavailable` tells a
    // caller to wait for something that is not coming.
    const db = await withBackupsAndCluster({ instances: 2, readyPods: 1, archiving: "False" });
    expect(db.status).toBe("ready");
    expect(db.standby).toBe("blocked");
    expect(db.archiving).toBe("failing");
  });

  it("calls it `unavailable` when archiving is healthy", async () => {
    // The ordinary case: a standby being rebuilt, back on its own.
    const db = await withBackupsAndCluster({ instances: 2, readyPods: 1, archiving: "True" });
    expect(db.standby).toBe("unavailable");
    expect(db.archiving).toBe("healthy");
  });

  it("does not call a healthy pair blocked, whatever archiving says", async () => {
    const db = await withBackupsAndCluster({ instances: 2, readyPods: 2, archiving: "False" });
    expect(db.standby).toBe("ready");
  });

  it("says nothing about a hibernated database's standby", async () => {
    const db = await withBackupsAndCluster({
      instances: 2, readyPods: 0, archiving: "False", hibernated: true,
    });
    expect(db.status).toBe("hibernated");
    expect(db).not.toHaveProperty("standby");
  });

  it("reports no archiving state at all when the condition is absent", async () => {
    // Before the operator has looked. Reporting `healthy` here would be a guess.
    const db = await withBackupsAndCluster({ instances: 1, readyPods: 1 });
    expect(db).not.toHaveProperty("archiving");
  });

  it("reports no archiving state when the installation has nowhere to back up to", async () => {
    // unstub first: vi.stubEnv outlives the test that set it, so without this
    // the module reloads with the previous test's bucket still configured and
    // the assertion below passes or fails for the wrong reason.
    vi.unstubAllEnvs();
    vi.resetModules();
    const { Provisioner: P } = await import("../src/k8s/provisioner.js");
    const notFound = () => Object.assign(new Error("not found"), { code: 404 });
    const objectsApi = {
      getNamespacedCustomObject: async () => ({
        metadata: {
          name: `db-${ID}`,
          labels: { "drigodb.io/database-id": ID, "drigodb.io/external-id": EXT },
        },
        spec: { instances: 1 },
        status: { conditions: [{ type: "ContinuousArchiving", status: "True" }] },
      }),
      listNamespacedCustomObject: async () => ({ items: [] }),
    };
    const core = {
      listNamespacedPod: async () => ({
        items: [{ status: { conditions: [{ type: "Ready", status: "True" }] } }],
      }),
      listNamespacedPersistentVolumeClaim: async () => ({ items: [] }),
    };
    const net = { createNamespacedNetworkPolicy: async () => ({}) };
    const batch = { readNamespacedJob: async () => { throw notFound(); } };
    const db = await new P(
      {} as never, core as never, net as never, batch as never, objectsApi as never,
    ).get(ID);
    expect(db.backups).toBe("unavailable");
    expect(db).not.toHaveProperty("archiving");
  });
});

// A resize the storage cannot perform used to be reported as success.
//
// Expansion is asynchronous: the Cluster patch is accepted, the API returns the
// new tier, and the volume then stays the size it was — permanently, with no
// error anywhere. drigodb was left asserting a database is `medium` while it sits
// on a `small` volume, and the next thing to go wrong is a full disk on a
// database everyone believes has room.
describe("resize refuses what the storage cannot do", () => {
  function provisionerOn(opts: {
    className?: string;
    allowExpansion?: boolean;
    readable?: boolean;
  }) {
    const patches: string[] = [];
    const notFound = () => Object.assign(new Error("not found"), { code: 404 });
    const objectsApi = {
      getNamespacedCustomObject: async () => ({
        metadata: {
          name: `db-${ID}`,
          labels: {
            "drigodb.io/database-id": ID,
            "drigodb.io/external-id": EXT,
            "drigodb.io/tier": "small",
          },
        },
        spec: { instances: 1, storage: { size: "1Gi" } },
        status: { readyInstances: 1 },
      }),
      listNamespacedCustomObject: async () => ({ items: [] }),
      patchNamespacedCustomObject: async (req: { name?: string }) => {
        patches.push(req.name ?? "");
        return {};
      },
    };
    const core = {
      listNamespacedPod: async () => ({
        items: [{ status: { conditions: [{ type: "Ready", status: "True" }] } }],
      }),
      listNamespacedPersistentVolumeClaim: async () => ({
        items: opts.className
          ? [{ metadata: { name: `db-${ID}-1` }, spec: { storageClassName: opts.className } }]
          : [],
      }),
    };
    const storage = {
      readStorageClass: async () => {
        if (opts.readable === false) throw notFound();
        return { metadata: { name: opts.className }, allowVolumeExpansion: opts.allowExpansion };
      },
    };
    const net = { createNamespacedNetworkPolicy: async () => ({}) };
    const batch = { readNamespacedJob: async () => { throw notFound(); } };
    return {
      patches,
      provisioner: new Provisioner(
        storage as never, core as never, net as never, batch as never, objectsApi as never,
      ),
    };
  }

  it("refuses when the StorageClass does not allow expansion, and patches nothing", async () => {
    const { provisioner, patches } = provisionerOn({ className: "standard", allowExpansion: false });
    await expect(provisioner.resize(ID, "medium")).rejects.toThrow(ResizeRefusedError);
    // The database must be left exactly as it was. A refusal that already moved
    // the label would be worse than the silence it replaces.
    expect(patches).toHaveLength(0);
  });

  it("names the StorageClass, because that is the thing to change", async () => {
    const { provisioner } = provisionerOn({ className: "standard", allowExpansion: false });
    await expect(provisioner.resize(ID, "medium")).rejects.toThrow(/standard/);
    await expect(provisioner.resize(ID, "medium")).rejects.toThrow(/expansion/);
  });

  it("proceeds when the StorageClass allows expansion", async () => {
    const { provisioner, patches } = provisionerOn({
      className: "do-block-storage",
      allowExpansion: true,
    });
    await provisioner.resize(ID, "medium");
    expect(patches.length).toBeGreaterThan(0);
  });

  it("proceeds when the StorageClass cannot be read", async () => {
    // Unreadable is not the same as unable. A cluster that will not show drigodb
    // a StorageClass should not have its resizes blocked by that.
    const { provisioner, patches } = provisionerOn({ className: "opaque", readable: false });
    await provisioner.resize(ID, "medium");
    expect(patches.length).toBeGreaterThan(0);
  });

  it("proceeds when there is no PVC to check yet", async () => {
    const { provisioner, patches } = provisionerOn({});
    await provisioner.resize(ID, "medium");
    expect(patches.length).toBeGreaterThan(0);
  });
});

describe("restoring over a database", () => {
  const NOW = new Date("2026-09-13T12:00:00.000Z");

  it("refuses without a confirmation naming this database", () => {
    for (const body of [
      {},
      { backup_id: "bk-a1b2c3d4e5f6-20260907" },
      { confirm: true, backup_id: "bk-a1b2c3d4e5f6-20260907" },
      { confirm: "yes", backup_id: "bk-a1b2c3d4e5f6-20260907" },
      // The id of a DIFFERENT database, which a copied script would carry.
      { confirm: "0123456789ab", backup_id: "bk-a1b2c3d4e5f6-20260907" },
    ]) {
      expect(() => validateRestoreInPlace(ID, body, NOW)).toThrow(ValidationError);
    }
  });

  it("accepts a confirmation that is the database's own id", () => {
    expect(
      validateRestoreInPlace(ID, { confirm: ID, backup_id: "bk-a1b2c3d4e5f6-20260907" }, NOW),
    ).toEqual({ backupId: "bk-a1b2c3d4e5f6-20260907" });
  });

  it("takes a target time, with the same handling as restore_from", () => {
    // Not a second, subtly different implementation: #19's validation is reused,
    // including the PostgreSQL timestamp format CloudNativePG needs.
    expect(
      validateRestoreInPlace(ID, { confirm: ID, target_time: "2026-09-13T09:30:00Z" }, NOW),
    ).toEqual({ targetTime: "2026-09-13 09:30:00.000000+00:00" });
  });

  it("refuses a target that names nothing", () => {
    expect(() => validateRestoreInPlace(ID, { confirm: ID }, NOW)).toThrow(ValidationError);
  });

  it("refuses a backup_id and a target_time together, like restore_from", () => {
    expect(() =>
      validateRestoreInPlace(
        ID,
        { confirm: ID, backup_id: "bk-a1b2c3d4e5f6-20260907", target_time: "2026-09-13T09:30:00Z" },
        NOW,
      ),
    ).toThrow(ValidationError);
  });

  it("refuses a target time with no offset, like restore_from", () => {
    expect(() =>
      validateRestoreInPlace(ID, { confirm: ID, target_time: "2026-09-13T09:30:00" }, NOW),
    ).toThrow(ValidationError);
  });
});

// The ordering property this operation turns on: nothing is destroyed until the
// target has been validated. After the Cluster is deleted there is no database
// to put back, so a bad target has to fail before that or not at all.
describe("restore in place destroys nothing before it validates", () => {
  async function withBackups(backups: Array<{ name: string; phase: string; stopped?: string }>) {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.stubEnv("DRIGODB_BACKUP_OBJECT_STORE", "drigodb-api-backups");
    const { Provisioner: P, ValidationError: VE, NotFoundError: NFE } =
      await import("../src/k8s/provisioner.js");
    const notFound = () => Object.assign(new Error("not found"), { code: 404 });
    const acted: string[] = [];
    const created: Array<{
      metadata: { name: string; annotations?: Record<string, string> };
      spec?: { plugins?: Array<{ parameters?: Record<string, string> }> };
    }> = [];
    const clusters = new Map<string, unknown>([
      [
        `db-${ID}`,
        {
          metadata: {
            name: `db-${ID}`,
            labels: {
              "drigodb.io/database-id": ID,
              "drigodb.io/external-id": EXT,
              "drigodb.io/tier": "small",
            },
          },
          spec: { instances: 1 },
          status: { readyInstances: 1 },
        },
      ],
    ]);
    const objectsApi = {
      getNamespacedCustomObject: async (req: { name: string; plural: string }) => {
        if (req.plural === "backups") {
          const b = backups.find((x) => x.name === req.name);
          if (!b) throw notFound();
          return {
            metadata: { name: b.name, labels: { "drigodb.io/database-id": ID } },
            status: { phase: b.phase, backupId: "20260907T071816", stoppedAt: b.stopped },
          };
        }
        const c = clusters.get(req.name);
        if (!c) throw notFound();
        return c;
      },
      listNamespacedCustomObject: async () => ({
        items: backups.map((b) => ({
          metadata: { name: b.name, labels: { "drigodb.io/database-id": ID } },
          status: { phase: b.phase, backupId: "20260907T071816", stoppedAt: b.stopped },
        })),
      }),
      deleteNamespacedCustomObject: async (req: { name: string }) => {
        acted.push(`delete:${req.name}`);
        clusters.delete(req.name);
        return {};
      },
      createNamespacedCustomObject: async (req: {
        body: {
          metadata: { name: string; annotations?: Record<string, string> };
          spec?: { plugins?: Array<{ parameters?: Record<string, string> }> };
        };
      }) => {
        acted.push(`create:${req.body.metadata.name}`);
        created.push(req.body);
        clusters.set(req.body.metadata.name, req.body);
        return req.body;
      },
    };
    const core = {
      listNamespacedPod: async () => ({
        items: [{ status: { conditions: [{ type: "Ready", status: "True" }] } }],
      }),
      // Empty, so the wait for volumes to clear returns immediately.
      listNamespacedPersistentVolumeClaim: async () => ({ items: [] }),
    };
    const net = {
      createNamespacedNetworkPolicy: async () => ({}),
      replaceNamespacedNetworkPolicy: async () => ({}),
    };
    const batch = { readNamespacedJob: async () => { throw notFound(); } };
    return {
      acted,
      created,
      ValidationError: VE,
      NotFoundError: NFE,
      provisioner: new P(
        {} as never, core as never, net as never, batch as never, objectsApi as never,
      ),
    };
  }

  it("does not delete the Cluster when the backup does not exist", async () => {
    const { provisioner, acted, NotFoundError: NFE } = await withBackups([]);
    await expect(
      provisioner.restoreInPlace(ID, { backupId: "bk-nope" }),
    ).rejects.toThrow(NFE);
    expect(acted).toEqual([]);
  });

  it("does not delete the Cluster when the target predates every backup", async () => {
    const { provisioner, acted, ValidationError: VE } = await withBackups([
      { name: "bk-1", phase: "completed", stopped: "2026-09-13T10:00:00Z" },
    ]);
    await expect(
      provisioner.restoreInPlace(ID, { targetTime: "2026-09-13 09:00:00.000000+00:00" }),
    ).rejects.toThrow(VE);
    expect(acted).toEqual([]);
  });

  it("deletes then recreates under the SAME name when the target is good", async () => {
    // The same name is the whole feature: the Service selector and the Secret are
    // untouched, so the consumer's stored URI keeps working.
    const { provisioner, acted } = await withBackups([
      { name: "bk-1", phase: "completed", stopped: "2026-09-13T10:00:00Z" },
    ]);
    await provisioner.restoreInPlace(ID, { targetTime: "2026-09-13 11:00:00.000000+00:00" });
    expect(acted).toEqual([`delete:db-${ID}`, `create:db-${ID}`]);
  });

  it("archives the restored database to the NEXT generation", async () => {
    // The bug that took five failed recovery Jobs on a real cluster to find.
    // Keeping the prefix makes barman refuse outright — "WAL archive check failed
    // for server db-<id>: Expected empty archive" — because two timelines under
    // one serverName would corrupt the archive for both.
    const { provisioner, created } = await withBackups([
      { name: "bk-1", phase: "completed", stopped: "2026-09-13T10:00:00Z" },
    ]);
    await provisioner.restoreInPlace(ID, { backupId: "bk-1" });
    const c = created.at(-1);
    expect(c?.metadata.name).toBe(`db-${ID}`);
    expect(c?.metadata.annotations?.["drigodb.io/archive-generation"]).toBe("1");
    expect(c?.spec?.plugins?.[0]?.parameters?.serverName).toBe(`db-${ID}-r1`);
  });

  it("recovers FROM the prefix the backup was taken in, not the new one", async () => {
    // Restoring reads the source archive and writes the destination archive, and
    // after this change they are deliberately different prefixes.
    const { provisioner, created } = await withBackups([
      { name: "bk-1", phase: "completed", stopped: "2026-09-13T10:00:00Z" },
    ]);
    await provisioner.restoreInPlace(ID, { backupId: "bk-1" });
    const c = created.at(-1) as unknown as {
      spec: { externalClusters?: Array<{ plugin: { parameters: Record<string, string> } }> };
    };
    expect(c.spec.externalClusters?.[0]?.plugin.parameters.serverName).toBe(`db-${ID}`);
  });

  it("is a 404 for a database that does not exist, having done nothing", async () => {
    const { provisioner, acted, NotFoundError: NFE } = await withBackups([]);
    await expect(
      provisioner.restoreInPlace("ffffffffffff", { backupId: "bk-1" }),
    ).rejects.toThrow(NFE);
    expect(acted).toEqual([]);
  });
});

describe("adding a standby to a database that already exists", () => {
  // readyPods defaults to instances: the states that matter here differ in how
  // many pods are actually up, not only in the phase string. A clone in progress
  // is instances: 2 with ONE ready pod — claiming two would be a state that
  // cannot exist, and the code is right to call that `ready` whatever the phase
  // says.
  function clusterAt(instances: number, phase = "Cluster in healthy state", readyPods = instances) {
    const notFound = () => Object.assign(new Error("not found"), { code: 404 });
    const patched: Array<Record<string, unknown>> = [];
    const spec: Record<string, unknown> = {
      instances,
      ...(instances > 1
        ? { postgresql: { synchronous: { method: "any", number: 1, dataDurability: "preferred" } } }
        : {}),
    };
    const objectsApi = {
      getNamespacedCustomObject: async () => ({
        metadata: {
          name: `db-${ID}`,
          labels: {
            "drigodb.io/database-id": ID,
            "drigodb.io/external-id": EXT,
            "drigodb.io/tier": "small",
          },
        },
        spec,
        status: { phase, readyInstances: instances },
      }),
      listNamespacedCustomObject: async () => ({ items: [] }),
      patchNamespacedCustomObject: async (req: { body: Record<string, unknown> }) => {
        patched.push(req.body);
        return {};
      },
    };
    const core = {
      listNamespacedPod: async (req: { labelSelector: string }) => ({
        items: Array.from(
          { length: req.labelSelector.includes("instanceRole=primary") ? 1 : readyPods },
          () => ({ status: { conditions: [{ type: "Ready", status: "True" }] } }),
        ),
      }),
      listNamespacedPersistentVolumeClaim: async () => ({ items: [] }),
    };
    const net = { createNamespacedNetworkPolicy: async () => ({}) };
    const batch = { readNamespacedJob: async () => { throw notFound(); } };
    return {
      patched,
      provisioner: new Provisioner(
        {} as never, core as never, net as never, batch as never, objectsApi as never,
      ),
    };
  }

  it("refuses a body that does not say which way", () => {
    for (const bad of [null, {}, { enabled: "true" }, { enabled: 1 }, "yes"]) {
      expect(() => validateHighAvailabilityChange(bad)).toThrow(ValidationError);
    }
    expect(validateHighAvailabilityChange({ enabled: true })).toBe(true);
    expect(validateHighAvailabilityChange({ enabled: false })).toBe(false);
  });

  it("patches instances and the synchronous posture when turning it on", async () => {
    const { provisioner, patched } = clusterAt(1);
    await provisioner.setHighAvailability(ID, true);
    expect(patched).toHaveLength(1);
    const spec = (patched[0] as { spec: { instances: number; postgresql: { synchronous: unknown } } }).spec;
    expect(spec.instances).toBe(2);
    // Rendered by buildCluster, so it cannot drift from what create() would set.
    expect(spec.postgresql.synchronous).toEqual({
      method: "any",
      number: 1,
      dataDurability: "preferred",
    });
  });

  it("sets synchronous to NULL when turning it off, not absent", async () => {
    // A merge patch only removes a key when it is explicitly null. Absent leaves
    // what is there — a primary waiting on a standby that no longer exists, which
    // is harmless under dataDurability `preferred` and a write outage the moment
    // anybody changes that to `required`.
    const { provisioner, patched } = clusterAt(2);
    await provisioner.setHighAvailability(ID, false);
    const spec = (patched[0] as { spec: { instances: number; postgresql: { synchronous: unknown } } }).spec;
    expect(spec.instances).toBe(1);
    expect(spec.postgresql.synchronous).toBeNull();
  });

  it("patches nothing when it is already in the state asked for", async () => {
    // Asking twice while a clone is running must not start a second one.
    const on = clusterAt(2);
    await on.provisioner.setHighAvailability(ID, true);
    expect(on.patched).toEqual([]);
    const off = clusterAt(1);
    await off.provisioner.setHighAvailability(ID, false);
    expect(off.patched).toEqual([]);
  });

  it("reports the standby as provisioning while the clone runs", async () => {
    // The distinction #110 turns on: being BUILT is not the same as having died,
    // and a clone of a real database takes minutes.
    // instances: 2 desired, one pod up, and CloudNativePG saying why.
    const { provisioner } = clusterAt(2, "Creating a new replica", 1);
    const db = await provisioner.setHighAvailability(ID, true);
    expect(db.standby).toBe("provisioning");
  });

  it("does not call it provisioning once the cluster is healthy again", async () => {
    const { provisioner } = clusterAt(2);
    const db = await provisioner.setHighAvailability(ID, true);
    expect(db.standby).toBe("ready");
  });

  it("does not call a standby that simply died provisioning", async () => {
    // One pod up and NO clone running. This is the `unavailable` case, and
    // calling it `provisioning` would tell a caller to wait for something nobody
    // is doing.
    const { provisioner } = clusterAt(2, "Cluster in healthy state", 1);
    const db = await provisioner.setHighAvailability(ID, true);
    expect(db.standby).toBe("unavailable");
  });
});

// Purging the archive of a database that no longer exists (#135).
//
// Nothing here can see the bucket, and that is the point of the design rather
// than a limit of the test: the API process has no S3 client, so everything it
// gets wrong it gets wrong in the Job it builds or in how it reads the result.
// The part a mock cannot check — that the prefix is the one the objects are
// actually under — is in scripts/smoke.sh, against MinIO.
describe("archive purge", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const SUMMARY = JSON.stringify({
    server_name: `db-${ID}`,
    dry_run: false,
    generations: [
      { generation: 0, prefix: `db-${ID}/`, objects: 41, bytes: 700000000 },
      { generation: 1, prefix: `db-${ID}-r1/`, objects: 9, bytes: 150000000 },
    ],
    objects: 50,
    bytes: 850000000,
    truncated: false,
  });

  // A namespace holding an ObjectStore, no Cluster unless asked for, and a Job
  // that behaves the way the Job controller does: absent until created, and then
  // reporting a terminal status with one pod whose log is the answer.
  async function purgeCluster(
    opts: { clusterExists?: boolean; log?: string; fails?: boolean; store?: unknown } = {},
  ) {
    vi.resetModules();
    vi.stubEnv("DRIGODB_BACKUP_OBJECT_STORE", "drigodb-api-backups");
    vi.stubEnv("DRIGODB_ARCHIVE_PURGE_CONFIGMAP", "drigodb-api-archive-purge");
    const p = await import("../src/k8s/provisioner.js");

    const notFound = () => Object.assign(new Error("not found"), { code: 404 });
    const store =
      opts.store === undefined
        ? {
            spec: {
              configuration: {
                destinationPath: "s3://drigodb-backups-fra1/",
                endpointURL: "https://fra1.digitaloceanspaces.com",
                s3Credentials: {
                  accessKeyId: { name: "drigodb-backup-credentials", key: "access_key" },
                  secretAccessKey: { name: "drigodb-backup-credentials", key: "secret_key" },
                },
              },
            },
          }
        : opts.store;

    const created: Array<{ name: string; env: Record<string, unknown> }> = [];
    const deleted: string[] = [];
    let jobExists = false;

    const objects = {
      getNamespacedCustomObject: async (req: { plural: string; name: string }) => {
        if (req.plural === "clusters") {
          if (opts.clusterExists) return { metadata: { name: req.name, labels: {} } };
          throw notFound();
        }
        if (req.plural === "objectstores") {
          if (store === null) throw notFound();
          return store;
        }
        throw notFound();
      },
    };
    const batch = {
      createNamespacedJob: async (req: {
        body: {
          metadata: { name: string };
          spec: { template: { spec: { containers: Array<{ env: Array<{ name: string }> }> } } };
        };
      }) => {
        jobExists = true;
        created.push({
          name: req.body.metadata.name,
          env: Object.fromEntries(
            req.body.spec.template.spec.containers[0]!.env.map((e) => [e.name, e]),
          ),
        });
        return req.body;
      },
      readNamespacedJob: async (req: { name: string }) => {
        if (!jobExists) throw notFound();
        return {
          metadata: { name: req.name },
          status: opts.fails ? { failed: 1 } : { succeeded: 1 },
        };
      },
      deleteNamespacedJob: async (req: { name: string }) => {
        deleted.push(req.name);
        if (!jobExists) throw notFound();
        jobExists = false;
        return {};
      },
    };
    const core = {
      listNamespacedPod: async () => ({
        items: jobExists ? [{ metadata: { name: `purge-db-${ID}-abcde` } }] : [],
      }),
      readNamespacedPodLog: async () => opts.log ?? SUMMARY,
    };

    return {
      p,
      created,
      deleted,
      provisioner: new p.Provisioner(
        {} as never, core as never, {} as never, batch as never, objects as never,
      ),
    };
  }

  it("refuses an id that still has a Cluster, and starts nothing", async () => {
    // The entire safety model. A live database's archive is its backups and its
    // recovery window; there is no reason to reach it through this operation, and
    // the refusal has to happen before a Job with delete rights is created.
    const { provisioner, created, p } = await purgeCluster({ clusterExists: true });
    await expect(provisioner.purgeArchive(ID, { dryRun: false })).rejects.toThrow(
      p.ArchiveInUseError,
    );
    expect(created).toEqual([]);
  });

  it("builds the Job from the ObjectStore, not from its own environment", async () => {
    // One bucket declared twice is two things that can disagree, and the half
    // that is wrong here deletes objects.
    const { provisioner, created } = await purgeCluster();
    await provisioner.purgeArchive(ID, { dryRun: false });
    expect(created).toHaveLength(1);
    const job = created[0]!;
    expect(job.name).toBe(`purge-db-${ID}`);
    const env = job.env as Record<string, { value?: string; valueFrom?: unknown } | undefined>;
    expect(env.DRIGODB_DESTINATION_PATH?.value).toBe("s3://drigodb-backups-fra1/");
    expect(env.DRIGODB_ENDPOINT_URL?.value).toBe("https://fra1.digitaloceanspaces.com");
    expect(env.AWS_ACCESS_KEY_ID?.valueFrom).toEqual({
      secretKeyRef: { name: "drigodb-backup-credentials", key: "access_key" },
    });
  });

  it("returns what was removed, per generation", async () => {
    // The reason this waits instead of returning 202: a caller purging to reclaim
    // storage wants the number, and after the database is deleted there is no
    // resource left to poll for it.
    const { provisioner } = await purgeCluster();
    const result = await provisioner.purgeArchive(ID, { dryRun: false });
    expect(result.id).toBe(ID);
    expect(result.objects).toBe(50);
    expect(result.bytes).toBe(850000000);
    expect(result.generations.map((g) => g.generation)).toEqual([0, 1]);
    expect(result.truncated).toBe(false);
  });

  it("clears the previous attempt before starting another", async () => {
    // The Job name is derived from the id so a retry can find the attempt before
    // it. Without the delete, create would 409 and a failed purge could never be
    // retried through the API at all.
    const { provisioner, deleted } = await purgeCluster();
    await provisioner.purgeArchive(ID, { dryRun: false });
    await provisioner.purgeArchive(ID, { dryRun: false });
    expect(deleted).toEqual([`purge-db-${ID}`, `purge-db-${ID}`]);
  });

  it("finds the summary among log records that are themselves JSON", async () => {
    // barman and boto3 log to stderr, the container merges the streams, and
    // nothing puts the script's one line of stdout at either end of the result. So
    // the summary is identified by its own fields: neither "the last line" nor
    // "the first line that parses" is it, and structured log records parse fine.
    const noise = [
      '{"level":"info","msg":"starting"}',
      JSON.stringify({
        server_name: `db-${ID}`,
        dry_run: true,
        generations: [],
        objects: 0,
        bytes: 0,
        truncated: false,
      }),
      '{"level":"info","msg":"done","objects":9999}',
      "INFO: done",
    ].join("\n");
    const { provisioner } = await purgeCluster({ log: noise });
    const result = await provisioner.purgeArchive(ID, { dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.objects).toBe(0);
  });

  it("reports a success with no summary as a failure to know, not as an empty archive", async () => {
    // "There was nothing to purge" and "I cannot tell you what I deleted" are
    // different facts, and a caller acting on the first when the second is true
    // would believe an archive is gone.
    const { provisioner } = await purgeCluster({ log: "Traceback: something odd\n" });
    await expect(provisioner.purgeArchive(ID, { dryRun: false })).rejects.toThrow(
      /printed no summary/,
    );
  });

  it("puts the script's own words in the error when the Job fails", async () => {
    // A Job status says "failed". The script says which prefix it could not read
    // and why, which is the difference between a wrong credential and a bucket
    // that is not there.
    const { provisioner } = await purgeCluster({
      fails: true,
      log: "botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch)",
    });
    await expect(provisioner.purgeArchive(ID, { dryRun: false })).rejects.toThrow(
      /SignatureDoesNotMatch/,
    );
  });

  it("refuses when the installation has no ObjectStore to read the bucket from", async () => {
    const { provisioner, p, created } = await purgeCluster({ store: null });
    await expect(provisioner.purgeArchive(ID, { dryRun: false })).rejects.toThrow(
      p.NotConfiguredError,
    );
    expect(created).toEqual([]);
  });

  it("refuses an ObjectStore with no credential rather than running boto3 without one", async () => {
    // boto3 with no key falls back to looking for instance metadata and hangs
    // until the Job's deadline, which looks like a slow bucket rather than a
    // misconfiguration.
    const { provisioner, p, created } = await purgeCluster({
      store: { spec: { configuration: { destinationPath: "s3://b/" } } },
    });
    await expect(provisioner.purgeArchive(ID, { dryRun: false })).rejects.toThrow(
      p.NotConfiguredError,
    );
    expect(created).toEqual([]);
  });
});

describe("archive purge validation", () => {
  it("requires the id itself as confirmation", async () => {
    const p = await import("../src/k8s/provisioner.js");
    expect(() => p.validateArchivePurge(ID, {})).toThrow(p.ValidationError);
    expect(() => p.validateArchivePurge(ID, { confirm: true })).toThrow(p.ValidationError);
    expect(() => p.validateArchivePurge(ID, { confirm: "b2c3d4e5f6a1" })).toThrow(
      p.ValidationError,
    );
    expect(p.validateArchivePurge(ID, { confirm: ID })).toEqual({ dryRun: false });
  });

  it("rejects an id that is not a drigodb id, because the id becomes a bucket prefix", async () => {
    // Every other endpoint looks for a Cluster and 404s. This one's precondition
    // is that there is no Cluster, so the id goes straight into an object-storage
    // prefix and a malformed one is somebody else's data.
    const p = await import("../src/k8s/provisioner.js");
    for (const bad of ["", "..", "a1b2c3d4e5f", "A1B2C3D4E5F6", "a1b2c3d4e5f6x", "*"]) {
      expect(() => p.validateArchivePurge(bad, { confirm: bad })).toThrow(p.ValidationError);
    }
  });

  it("takes a dry run, and only as a boolean", async () => {
    const p = await import("../src/k8s/provisioner.js");
    expect(p.validateArchivePurge(ID, { confirm: ID, dry_run: true })).toEqual({ dryRun: true });
    expect(() => p.validateArchivePurge(ID, { confirm: ID, dry_run: "yes" })).toThrow(
      p.ValidationError,
    );
  });
});
