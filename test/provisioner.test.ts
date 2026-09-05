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
  NotFoundError,
  Provisioner,
  ValidationError,
  validateRestoreFrom,
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
  body: { metadata: { annotations: Record<string, string> }; spec: Record<string, unknown> };
};
type PatchOptions = {
  middleware?: Array<{ pre: (ctx: { setHeaderParam: (k: string, v: string) => void }) => unknown }>;
};

function provisionerFor(sts: ReturnType<typeof statefulSet>) {
  const patch = vi.fn(async (_req: PatchRequest, _opts?: PatchOptions) => {
    calls.push("patch");
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
  const provisioner = new Provisioner(apps as never, core as never, {} as never, noRestoreJob as never);
  return { provisioner, patch };
}

// Most databases were never restored into, so "no such Job" is the ordinary
// answer and the one every existing test wants.
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
    const { provisioner, patch } = provisionerFor(sts);

    await provisioner.wake(ID);

    // The pod must start once, on the new template. Patching after the scale
    // would start it on the old one and then roll it.
    expect(calls.indexOf("patch")).toBeLessThan(calls.indexOf("scale"));
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("patches only the template, and stamps the hash it rendered", async () => {
    const sts = statefulSet(0, "0000000000000000");
    const { provisioner, patch } = provisionerFor(sts);

    await provisioner.wake(ID);

    const body = patch.mock.calls[0]?.[0].body;
    if (!body) throw new Error("patch was not called");
    // selector, serviceName and volumeClaimTemplates are immutable on a
    // StatefulSet; replicas is left out so the patch cannot fight the scale.
    expect(Object.keys(body.spec)).toEqual(["template"]);
    expect(body.metadata.annotations[TEMPLATE_HASH_ANNOTATION]).toBe(templateHash(ID, EXT));
  });

  it("sends a merge patch, so lists are replaced rather than unioned", async () => {
    const sts = statefulSet(0, "0000000000000000");
    const { provisioner, patch } = provisionerFor(sts);

    await provisioner.wake(ID);

    // The content type rides in a closure inside the client's middleware, not
    // in any inspectable field, so drive the middleware and see what it sets.
    // Worth the awkwardness: the client's default here is a *strategic* merge,
    // which unions containers by name and env by name — a field this build no
    // longer renders would then survive in the live object forever.
    const headers: Record<string, string> = {};
    const middleware = patch.mock.calls[0]?.[1]?.middleware ?? [];
    expect(middleware.length).toBeGreaterThan(0);
    for (const m of middleware) {
      m.pre({ setHeaderParam: (k: string, v: string) => { headers[k] = v; } });
    }

    expect(headers["Content-Type"]).toBe("application/merge-patch+json");
  });

  it("does not patch when the live template is already current", async () => {
    const sts = statefulSet(0, templateHash(ID, EXT));
    const { provisioner, patch } = provisionerFor(sts);

    await provisioner.wake(ID);

    expect(patch).not.toHaveBeenCalled();
    expect(calls).toContain("scale");
  });

  it("never touches a database that is already running", async () => {
    // Callers wake speculatively. Rewriting the template of a running
    // StatefulSet rolls the pod and drops every live connection, so a stale
    // hash must still be left alone until the next hibernate/wake cycle.
    const sts = statefulSet(1, "0000000000000000");
    const { provisioner, patch } = provisionerFor(sts);

    await provisioner.wake(ID);

    expect(patch).not.toHaveBeenCalled();
  });

  it("is a 404 rather than a 500 when there is no such database", async () => {
    const apps = {
      readNamespacedStatefulSet: async () => {
        throw Object.assign(new Error("not found"), { code: 404 });
      },
    };
    const provisioner = new Provisioner(apps as never, {} as never, {} as never, noRestoreJob as never);

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
  const provisioner = new Provisioner(apps as never, core as never, {} as never, noRestoreJob as never);
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
    const provisioner = new Provisioner(apps as never, {} as never, {} as never, noRestoreJob as never);

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
