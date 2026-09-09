// What survives the move to CloudNativePG.
//
// The wake tests that used to open this file pinned a pod-template reconcile
// drigodb no longer performs: the operator owns the template and rolls it
// itself. What is left is the part that is still drigodb's — idempotent create,
// the lock, and the statuses a consumer polls.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DB_ID_LABEL,
  EXTERNAL_ID_LABEL,
  PASSWORD_SECRET_KEY,
} from "../src/k8s/manifests.js";
import {
  DeletionInFlightError,
  NotFoundError,
  Provisioner,
  ValidationError,
  validateHighAvailability,
  validateRestoreFrom,
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
