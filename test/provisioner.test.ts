// Wake reconciles the pod template before it scales.
//
// Pins the behaviour that lets a rebuilt data-plane image reach a database that
// already exists — and, just as importantly, the three cases where wake must
// leave the template alone. Every failure here is silent in production: a
// database that quietly never updates, or one that restarts when a caller only
// asked whether it was awake.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DB_ID_LABEL,
  EXTERNAL_ID_LABEL,
  PASSWORD_SECRET_KEY,
  TEMPLATE_HASH_ANNOTATION,
  templateHash,
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

// Every call the provisioner makes, in the order it made them. Ordering is the
// assertion that matters most: a patch after the scale would roll a pod that
// had just started.
let calls: string[];

function statefulSet(replicas: number, hash?: string) {
  return {
    metadata: {
      name: `db-${ID}`,
      labels: { [DB_ID_LABEL]: ID, [EXTERNAL_ID_LABEL]: EXT },
      ...(hash ? { annotations: { [TEMPLATE_HASH_ANNOTATION]: hash } } : {}),
    },
    spec: { replicas },
    status: { readyReplicas: replicas },
  };
}

// The two shapes the patch call is asserted against. Typed rather than `any`
// so a change to what the provisioner sends fails at compile time here.
type PatchRequest = {
  body: {
    metadata: { annotations?: Record<string, string>; labels?: Record<string, string> };
    spec?: Record<string, unknown>;
  };
};
type PatchOptions = {
  middleware?: Array<{ pre: (ctx: { setHeaderParam: (k: string, v: string) => void }) => unknown }>;
};

function provisionerFor(sts: ReturnType<typeof statefulSet>) {
  // Two different patches reach this mock and they must not be confused. The
  // template rewrite is the one these tests are about; scale also patches the
  // hibernation label, which is metadata only and rolls nothing.
  const patch = vi.fn(async (req: PatchRequest, _opts?: PatchOptions) => {
    calls.push(req.body.spec ? "patch" : "label");
    return sts;
  });

  const apps = {
    readNamespacedStatefulSet: async () => {
      calls.push("read");
      return sts;
    },
    patchNamespacedStatefulSet: patch,
    readNamespacedStatefulSetScale: async () => {
      calls.push("readScale");
      return { spec: { replicas: sts.spec.replicas } };
    },
    replaceNamespacedStatefulSetScale: async () => {
      calls.push("scale");
      return {};
    },
  };
  const core = { listNamespacedPod: async () => ({ items: [] }) };

  // The constructor takes its clients, so the whole path is exercisable without
  // a cluster.
  const provisioner = new Provisioner(apps as never, core as never, {} as never, noRestoreJob as never, noCertificates as never);
  const templatePatches = () => patch.mock.calls.filter(([req]) => req.body.spec);
  return { provisioner, patch, templatePatches };
}

// Most databases were never restored into, so "no such Job" is the ordinary
// answer and the one every existing test wants.
// Server authentication is off in these tests, so nothing here is called — but
// the constructor takes the client, so it has to be handed one.
const noCertificates = {
  createNamespacedCustomObject: async () => ({}),
  deleteNamespacedCustomObject: async () => ({}),
};

const noRestoreJob = {
  readNamespacedJob: async () => {
    const err = new Error("not found") as Error & { code: number };
    err.code = 404;
    throw err;
  },
};

beforeEach(() => {
  calls = [];
});

describe("wake", () => {
  it("rewrites a stale template before scaling, not after", async () => {
    const sts = statefulSet(0, "0000000000000000");
    const { provisioner, templatePatches } = provisionerFor(sts);

    await provisioner.wake(ID);

    // The pod must start once, on the new template. Patching after the scale
    // would start it on the old one and then roll it.
    expect(calls.indexOf("patch")).toBeLessThan(calls.indexOf("scale"));
    expect(templatePatches()).toHaveLength(1);
  });

  it("patches only the template, and stamps the hash it rendered", async () => {
    const sts = statefulSet(0, "0000000000000000");
    const { provisioner, templatePatches } = provisionerFor(sts);

    await provisioner.wake(ID);

    const body = templatePatches()[0]?.[0].body;
    if (!body?.spec) throw new Error("the template was never patched");
    // selector, serviceName and volumeClaimTemplates are immutable on a
    // StatefulSet; replicas is left out so the patch cannot fight the scale.
    expect(Object.keys(body.spec)).toEqual(["template"]);
    expect(body.metadata.annotations?.[TEMPLATE_HASH_ANNOTATION]).toBe(templateHash(ID, EXT));
  });

  it("sends a merge patch, so lists are replaced rather than unioned", async () => {
    const sts = statefulSet(0, "0000000000000000");
    const { provisioner, templatePatches } = provisionerFor(sts);

    await provisioner.wake(ID);

    // The content type rides in a closure inside the client's middleware, not
    // in any inspectable field, so drive the middleware and see what it sets.
    // Worth the awkwardness: the client's default here is a *strategic* merge,
    // which unions containers by name and env by name — a field this build no
    // longer renders would then survive in the live object forever.
    const headers: Record<string, string> = {};
    const middleware = templatePatches()[0]?.[1]?.middleware ?? [];
    expect(middleware.length).toBeGreaterThan(0);
    for (const m of middleware) {
      m.pre({ setHeaderParam: (k: string, v: string) => { headers[k] = v; } });
    }

    expect(headers["Content-Type"]).toBe("application/merge-patch+json");
  });

  it("does not patch when the live template is already current", async () => {
    const sts = statefulSet(0, templateHash(ID, EXT));
    const { provisioner, templatePatches } = provisionerFor(sts);

    await provisioner.wake(ID);

    expect(templatePatches()).toHaveLength(0);
    expect(calls).toContain("scale");
  });

  it("never touches a database that is already running", async () => {
    // Callers wake speculatively. Rewriting the template of a running
    // StatefulSet rolls the pod and drops every live connection, so a stale
    // hash must still be left alone until the next hibernate/wake cycle.
    const sts = statefulSet(1, "0000000000000000");
    const { provisioner, templatePatches } = provisionerFor(sts);

    await provisioner.wake(ID);

    expect(templatePatches()).toHaveLength(0);
  });

  it("is a 404 rather than a 500 when there is no such database", async () => {
    const apps = {
      readNamespacedStatefulSet: async () => {
        throw Object.assign(new Error("not found"), { code: 404 });
      },
    };
    const provisioner = new Provisioner(apps as never, {} as never, {} as never, noRestoreJob as never, noCertificates as never);

    await expect(provisioner.wake(ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("templateHash", () => {
  it("moves when the data-plane image moves", async () => {
    // config is read once at import, so the image has to change before the
    // module graph is built.
    vi.resetModules();
    vi.stubEnv("DRIGODB_PG_IMAGE", "ghcr.io/drigolabs/drigodb-postgres:18-0.116-0-patched");
    const patched = await import("../src/k8s/manifests.js");

    expect(patched.templateHash(ID, EXT)).not.toBe(templateHash(ID, EXT));

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});


// Rotation is the recovery path for a lost connection URI: without it a caller
// that loses one can never reach its database again. The ordering is the part
// that fails silently — restarting before the Secret is written brings the pod
// back on the old password and the returned URI is simply wrong.

type SecretBody = { body: { stringData: Record<string, string> } };

function rotatableFor(sts: ReturnType<typeof statefulSet>) {
  const replaceSecret = vi.fn(async (_r: SecretBody) => {
    calls.push("secret");
    return {};
  });
  const apps = {
    readNamespacedStatefulSet: async () => {
      calls.push("read");
      return sts;
    },
    patchNamespacedStatefulSet: async () => {
      calls.push("patch");
      return sts;
    },
    readNamespacedStatefulSetScale: async () => ({ spec: { replicas: sts.spec.replicas } }),
    replaceNamespacedStatefulSetScale: async (r: { body: { spec: { replicas: number } } }) => {
      calls.push(`scale:${r.body.spec.replicas}`);
      sts.spec.replicas = r.body.spec.replicas;
      sts.status.readyReplicas = r.body.spec.replicas;
      return {};
    },
  };
  const core = {
    replaceNamespacedSecret: replaceSecret,
    listNamespacedPod: async () => ({ items: sts.spec.replicas > 0 ? [{}] : [] }),
  };
  const provisioner = new Provisioner(apps as never, core as never, {} as never, noRestoreJob as never, noCertificates as never);
  return { provisioner, replaceSecret };
}

describe("credential rotation", () => {
  it("writes the new Secret before restarting, never after", async () => {
    const { provisioner, replaceSecret } = rotatableFor(statefulSet(1, templateHash(ID, EXT)));

    const { uri } = await provisioner.rotateCredentials(ID);

    // A restart that happens first brings the pod back on the old password.
    expect(calls.indexOf("secret")).toBeLessThan(calls.indexOf("scale:0"));
    expect(calls).toContain("scale:1");

    // The URI must carry the password that was just written, not a stale one.
    const written = replaceSecret.mock.calls[0]?.[0].body.stringData[PASSWORD_SECRET_KEY];
    expect(written).toBeTruthy();
    expect(uri).toContain(encodeURIComponent(written as string));
  });

  it("issues a different password every time", async () => {
    const a = rotatableFor(statefulSet(1, templateHash(ID, EXT)));
    const first = (await a.provisioner.rotateCredentials(ID)).uri;
    calls = [];
    const b = rotatableFor(statefulSet(1, templateHash(ID, EXT)));
    const second = (await b.provisioner.rotateCredentials(ID)).uri;

    expect(first).not.toBe(second);
  });

  it("does not restart a hibernated database", async () => {
    // Nothing is connected and nothing is running, so there is nothing to
    // apply the password to yet — bootstrap.sh does it on the next wake, which
    // is the first moment the URI could be used.
    const { provisioner, replaceSecret } = rotatableFor(statefulSet(0, templateHash(ID, EXT)));

    await provisioner.rotateCredentials(ID);

    expect(replaceSecret).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain("scale:0");
    expect(calls).not.toContain("scale:1");
  });

  it("is a 404 rather than a 500 when there is no such database", async () => {
    const apps = {
      readNamespacedStatefulSet: async () => {
        throw Object.assign(new Error("not found"), { code: 404 });
      },
    };
    const provisioner = new Provisioner(apps as never, {} as never, {} as never, noRestoreJob as never, noCertificates as never);

    await expect(provisioner.rotateCredentials(ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("restore_from validation", () => {
  it("accepts a key of the shape this service writes", () => {
    expect(validateRestoreFrom({ database_id: "a1b2c3d4e5f6", key: "20260905T040000Z.sql.gz" }))
      .toEqual({ databaseId: "a1b2c3d4e5f6", key: "20260905T040000Z.sql.gz" });
  });

  it("is absent when not asked for", () => {
    expect(validateRestoreFrom(undefined)).toBeUndefined();
    expect(validateRestoreFrom(null)).toBeUndefined();
  });

  it("refuses a key that would read outside its own prefix", () => {
    // The key is joined onto a bucket prefix, so a traversal here would reach
    // another database's backups.
    for (const key of [
      "../other/20260905T040000Z.sql.gz",
      "../../etc/passwd",
      "sub/20260905T040000Z.sql.gz",
      "20260905T040000Z.sql.gz/../../x",
    ]) {
      expect(() => validateRestoreFrom({ database_id: "a1b2c3d4e5f6", key })).toThrow(ValidationError);
    }
  });

  it("refuses anything that is not a database id", () => {
    for (const id of ["", "../a", "A1B2C3D4E5F6", "a1b2c3", "a1b2c3d4e5f6g", 42, null]) {
      expect(() => validateRestoreFrom({ database_id: id, key: "20260905T040000Z.sql.gz" }))
        .toThrow(ValidationError);
    }
  });

  it("refuses a malformed body", () => {
    expect(() => validateRestoreFrom("nope")).toThrow(ValidationError);
    expect(() => validateRestoreFrom({})).toThrow(ValidationError);
  });
});

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
describe("resize", () => {
  function resizableProvisioner(tier: string, replicas = 1) {
    const order: string[] = [];
    const sts = {
      metadata: {
        name: "db-a1b2c3d4e5f6",
        labels: {
          "drigodb.io/database-id": "a1b2c3d4e5f6",
          "drigodb.io/external-id": "app",
          "drigodb.io/tier": tier,
        },
        annotations: {},
      },
      spec: { replicas },
      status: { readyReplicas: replicas },
    };
    const apps = {
      readNamespacedStatefulSet: async () => sts,
      patchNamespacedStatefulSet: async () => { order.push("statefulset"); return sts; },
      readNamespacedStatefulSetScale: async () => ({ spec: { replicas: sts.spec.replicas } }),
      replaceNamespacedStatefulSetScale: async () => { order.push("scale"); return {}; },
    };
    const core = {
      listNamespacedPod: async () => ({ items: [] }),
      patchNamespacedPersistentVolumeClaim: async () => { order.push("pvc"); return {}; },
    };
    return {
      order,
      provisioner: new Provisioner(apps as never, core as never, {} as never, noRestoreJob as never, noCertificates as never),
    };
  }

  it("grows the volume before it raises max_wal_size", async () => {
    const { provisioner, order } = resizableProvisioner("small");
    await provisioner.resize("a1b2c3d4e5f6", "medium");
    expect(order.indexOf("pvc")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("pvc")).toBeLessThan(order.indexOf("statefulset"));
  });

  it("cycles the pod, because the WAL change lands at start and not on a patch", async () => {
    const { provisioner, order } = resizableProvisioner("small");
    await provisioner.resize("a1b2c3d4e5f6", "medium");
    expect(order.filter((o) => o === "scale").length).toBeGreaterThan(0);
    expect(order.indexOf("statefulset")).toBeLessThan(order.lastIndexOf("scale"));
  });

  it("does not wake a hibernated database to change a setting it is not using", async () => {
    const { provisioner, order } = resizableProvisioner("small", 0);
    await provisioner.resize("a1b2c3d4e5f6", "large");
    expect(order).toContain("pvc");
    expect(order).toContain("statefulset");
    expect(order).not.toContain("scale");
  });

  it("refuses to shrink, because volumes do not", async () => {
    const { provisioner } = resizableProvisioner("large");
    await expect(provisioner.resize("a1b2c3d4e5f6", "small")).rejects.toThrow(ValidationError);
  });

  it("is a no-op at the same tier rather than a pointless pod cycle", async () => {
    const { provisioner, order } = resizableProvisioner("medium");
    await provisioner.resize("a1b2c3d4e5f6", "medium");
    expect(order).toEqual([]);
  });

  it("refuses a tier above the installation's ceiling — that ceiling is the approval", async () => {
    vi.resetModules();
    vi.stubEnv("DRIGODB_MAX_TIER", "medium");
    const m = await import("../src/k8s/provisioner.js");
    const sts = {
      metadata: { labels: { "drigodb.io/database-id": "a1b2c3d4e5f6", "drigodb.io/tier": "small" }, annotations: {} },
      spec: { replicas: 1 }, status: { readyReplicas: 1 },
    };
    const apps = {
      readNamespacedStatefulSet: async () => sts,
      patchNamespacedStatefulSet: async () => sts,
      readNamespacedStatefulSetScale: async () => ({ spec: { replicas: 1 } }),
      replaceNamespacedStatefulSetScale: async () => ({}),
    };
    const core = { listNamespacedPod: async () => ({ items: [] }), patchNamespacedPersistentVolumeClaim: async () => ({}) };
    const p = new m.Provisioner(apps as never, core as never, {} as never, noRestoreJob as never, noCertificates as never);
    await expect(p.resize("a1b2c3d4e5f6", "large")).rejects.toThrow(m.ValidationError);
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

// Two replicas handling the same external_id at the same moment. Before the
// StatefulSet's name became the lock, both found nothing and both created —
// which is exactly the failure idempotency exists to prevent, and it only became
// reachable with more than one replica.
describe("concurrent create", () => {
  function racingCluster() {
    const created: string[] = [];
    // Replicas and labels are tracked rather than answered with a constant:
    // the whole question here is what a caller sees while a create is midway
    // through, and a fake that always says "one replica, ready" cannot show it.
    const objects = new Map<string, { labels: Record<string, string>; replicas: number }>();
    const conflict = () => {
      const e = new Error("already exists") as Error & { code: number };
      e.code = 409;
      return e;
    };
    const apps = {
      createNamespacedStatefulSet: async (req: { body: { metadata: { name: string; labels: Record<string, string> }; spec: { replicas: number } } }) => {
        const name = req.body.metadata.name;
        if (objects.has(name)) throw conflict();
        objects.set(name, { labels: { ...req.body.metadata.labels }, replicas: req.body.spec.replicas });
        created.push(name);
        return req.body;
      },
      readNamespacedStatefulSet: async (req: { name: string }) => {
        const o = objects.get(req.name);
        if (!o) { const e = new Error("nf") as Error & { code: number }; e.code = 404; throw e; }
        return {
          metadata: { name: req.name, labels: o.labels },
          spec: { replicas: o.replicas },
          status: { readyReplicas: o.replicas },
        };
      },
      readNamespacedStatefulSetScale: async (req: { name: string }) => ({
        spec: { replicas: objects.get(req.name)?.replicas ?? 0 },
      }),
      replaceNamespacedStatefulSetScale: async (req: { name: string; body: { spec: { replicas: number } } }) => {
        const o = objects.get(req.name);
        if (o) o.replicas = req.body.spec.replicas;
        return {};
      },
      patchNamespacedStatefulSet: async (req: { name: string; body: { metadata?: { labels?: Record<string, string> } } }) => {
        const o = objects.get(req.name);
        if (o) Object.assign(o.labels, req.body.metadata?.labels ?? {});
        return {};
      },
    };
    // Volumes outlive their StatefulSet by design (the retention policy keeps
    // them), so a create has to be able to see one left behind by a delete.
    const pvcs: Array<{ metadata: { name: string } }> = [];
    const core = {
      createNamespacedSecret: async () => ({}),
      createNamespacedService: async () => ({}),
      listNamespacedPod: async () => ({ items: [] }),
      listNamespacedPersistentVolumeClaim: async () => ({ items: pvcs }),
    };
    const net = { createNamespacedNetworkPolicy: async () => ({}) };
    return {
      created,
      objects,
      pvcs,
      provisioner: new Provisioner(apps as never, core as never, net as never, noRestoreJob as never, noCertificates as never),
    };
  }

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

    // Back to the state the winner leaves behind before it wakes.
    objects.get(`db-${database.id}`)!.replicas = 0;

    expect((await provisioner.get(database.id)).status).toBe("provisioning");
  });

  it("reports hibernated once something asked for it", async () => {
    const { provisioner } = racingCluster();
    const { database } = await provisioner.create("put-me-down");

    expect(database.status).toBe("ready");
    expect((await provisioner.scale(database.id, 0)).status).toBe("hibernated");
    expect((await provisioner.wake(database.id)).status).toBe("ready");
  });

  it("still reads a database created before the label as hibernated", async () => {
    // Nothing rewrites an existing StatefulSet on upgrade. One that predates
    // the label has no intent recorded, and the replica count is what it was
    // always judged by — so it must keep answering the way it did.
    const { provisioner, objects } = racingCluster();
    const { database } = await provisioner.create("older-than-the-label");
    const live = objects.get(`db-${database.id}`)!;
    delete live.labels["drigodb.io/hibernated"];
    live.replicas = 0;

    expect((await provisioner.get(database.id)).status).toBe("hibernated");
  });

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
    const { provisioner } = racingCluster();
    await provisioner.create("app-one");
    const sts = await (provisioner as never as { statefulSetFor: (id: string) => Promise<{ metadata: { labels: Record<string, string> } }> })
      .statefulSetFor((await provisioner.create("app-one")).database.id);
    sts.metadata.labels["drigodb.io/external-id"] = "someone-else";
    await expect(provisioner.create("app-one")).rejects.toThrow(ValidationError);
  });
});
