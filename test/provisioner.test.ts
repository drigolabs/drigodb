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
  const net = { createNamespacedNetworkPolicy: async () => ({}) };
  const batch = { readNamespacedJob: async () => { throw notFound(); } };

  return {
    created,
    objects,
    pvcs,
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
