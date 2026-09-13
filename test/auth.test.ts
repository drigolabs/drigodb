// Who is calling, and whether they may (#62).
//
// The dangerous direction here is admission, not refusal: a bug that rejects a
// valid token is loud and a bug that accepts an invalid one is silent. So most of
// what follows is about the second, and about the two facts a token now has that a
// static string never did — an expiry and a tier.

import { afterEach, describe, expect, it, vi } from "vitest";

const NS = "drigodb-databases";

// A namespace holding token Secrets, shaped the way the API server returns them:
// `data` base64-encoded, labels and annotations where buildTokenSecret puts them.
function fakeCore(secrets: Array<Record<string, unknown>> = []) {
  const created: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const notFound = () => Object.assign(new Error("not found"), { code: 404 });
  return {
    created,
    deleted,
    secrets,
    core: {
      listNamespacedSecret: async (req: { namespace: string; labelSelector?: string }) => {
        expect(req.namespace).toBe(NS);
        // The label, and nothing that could sweep up a database's password Secret.
        expect(req.labelSelector).toBe("drigodb.io/token-id");
        return { items: secrets };
      },
      createNamespacedSecret: async (req: { body: Record<string, unknown> }) => {
        created.push(req.body);
        // stringData is WRITE ONLY. The API server base64-encodes it into `data` and
        // never returns stringData, so a fake that stored the object verbatim would
        // be a fake nothing could read a hash back out of — and would have made
        // "the token it just issued is admitted" fail against correct code.
        const { stringData, ...rest } = req.body as { stringData?: Record<string, string> };
        secrets.push({
          ...rest,
          data: Object.fromEntries(
            Object.entries(stringData ?? {}).map(([k, v]) => [k, Buffer.from(v, "utf8").toString("base64")]),
          ),
        });
        return req.body;
      },
      deleteNamespacedSecret: async (req: { name: string }) => {
        deleted.push(req.name);
        const before = secrets.length;
        for (let i = secrets.length - 1; i >= 0; i--) {
          const meta = secrets[i]!["metadata"] as { name?: string };
          if (meta?.name === req.name) secrets.splice(i, 1);
        }
        if (secrets.length === before) throw notFound();
        return {};
      },
    },
  };
}

async function auth() {
  vi.resetModules();
  vi.stubEnv("DRIGODB_DATABASE_NAMESPACE", NS);
  return await import("../src/auth.js");
}

// A Secret as the API server would hand it back for a token with this hash.
function tokenSecret(
  a: typeof import("../src/auth.js"),
  opts: { id: string; hash: string; tier?: string; name?: string; expiresAt?: string; createdAt?: string },
) {
  return {
    metadata: {
      name: `token-${opts.id}`,
      namespace: NS,
      creationTimestamp: opts.createdAt ?? "2026-09-13T10:00:00.000Z",
      labels: {
        [a.TOKEN_ID_LABEL]: opts.id,
        [a.TOKEN_TIER_LABEL]: opts.tier ?? "tenant",
      },
      annotations: {
        [a.TOKEN_NAME_ANNOTATION]: opts.name ?? opts.id,
        ...(opts.expiresAt ? { [a.TOKEN_EXPIRES_ANNOTATION]: opts.expiresAt } : {}),
      },
    },
    data: { hash: Buffer.from(opts.hash, "utf8").toString("base64") },
  };
}

describe("token validation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("never stores the token, only its hash", async () => {
    // The property the whole design rests on. drigodb can already list Secrets in
    // this namespace, so a token stored raw would mean anything able to read one
    // Secret holds every credential to the control plane rather than one.
    const a = await auth();
    const { core, created } = fakeCore();
    const store = new a.TokenStore(core as never, undefined);
    const { token } = await store.issue("ci", "tenant");
    const body = created[0] as { stringData: Record<string, string> };
    expect(Object.values(body.stringData)).not.toContain(token);
    expect(body.stringData.hash).toBe(a.hashToken(token));
    expect(JSON.stringify(created)).not.toContain(token);
  });

  it("admits the token it just issued, and nothing else", async () => {
    const a = await auth();
    const { core } = fakeCore();
    const store = new a.TokenStore(core as never, undefined);
    const { token, record } = await store.issue("ci", "tenant");
    const caller = await store.callerFor(token);
    expect(caller?.id).toBe(record.id);
    expect(caller?.tier).toBe("tenant");
    expect(await store.callerFor(`${token}x`)).toBeUndefined();
    expect(await store.callerFor("")).toBeUndefined();
    expect(await store.callerFor("ddb_" + "0".repeat(64))).toBeUndefined();
  });

  it("refuses an expired token", async () => {
    // A token with an expiry that has passed is still a Secret in the namespace, so
    // nothing removes it and only this check stops it working.
    const a = await auth();
    const raw = "ddb_expired";
    const { core } = fakeCore([
      tokenSecret(a, { id: "aaaa", hash: a.hashToken(raw), expiresAt: "2026-09-13T09:00:00.000Z" }),
    ]);
    const at = Date.parse("2026-09-13T10:00:00.000Z");
    const store = new a.TokenStore(core as never, undefined, 5_000, () => at);
    expect(await store.callerFor(raw)).toBeUndefined();
  });

  it("admits a token whose expiry is still ahead", async () => {
    // The other side of the same branch, because an off-by-one on the comparison
    // would lock out every token with an expiry set and look like a storage bug.
    const a = await auth();
    const raw = "ddb_valid";
    const { core } = fakeCore([
      tokenSecret(a, { id: "bbbb", hash: a.hashToken(raw), expiresAt: "2026-09-13T11:00:00.000Z" }),
    ]);
    const at = Date.parse("2026-09-13T10:00:00.000Z");
    const store = new a.TokenStore(core as never, undefined, 5_000, () => at);
    expect((await store.callerFor(raw))?.id).toBe("bbbb");
  });

  it("treats a token with no tier label as a tenant", async () => {
    // Anything hand-written, or written by an older drigodb. Defaulting the other
    // way would make a malformed Secret an administrator.
    const a = await auth();
    const raw = "ddb_untiered";
    const secret = tokenSecret(a, { id: "cccc", hash: a.hashToken(raw) });
    delete (secret.metadata.labels as Record<string, string>)[a.TOKEN_TIER_LABEL];
    const { core } = fakeCore([secret]);
    const store = new a.TokenStore(core as never, undefined);
    expect((await store.callerFor(raw))?.tier).toBe("tenant");
  });

  it("reads the bootstrap token from the environment as an admin", async () => {
    const a = await auth();
    const { core } = fakeCore();
    const store = new a.TokenStore(core as never, "static-installation-token");
    const caller = await store.callerFor("static-installation-token");
    expect(caller?.id).toBe(a.BOOTSTRAP_TOKEN_ID);
    expect(caller?.tier).toBe("admin");
  });

  it("serves nothing when there is no bootstrap token and no Secret", async () => {
    // An installation that removed its bootstrap token before issuing one. It must
    // answer 401, not admit everyone.
    const a = await auth();
    const { core } = fakeCore();
    const store = new a.TokenStore(core as never, undefined);
    expect(await store.callerFor("anything")).toBeUndefined();
    expect(await store.callerFor("")).toBeUndefined();
  });

  it("stops admitting a revoked token, and immediately for the caller who revoked it", async () => {
    // The five-second cache is for revocations made elsewhere. A caller that just
    // called DELETE must not see its own change lag.
    const a = await auth();
    const { core } = fakeCore();
    const at = Date.parse("2026-09-13T10:00:00.000Z");
    const store = new a.TokenStore(core as never, undefined, 5_000, () => at);
    const { token, record } = await store.issue("doomed", "tenant");
    expect(await store.callerFor(token)).toBeDefined();
    await store.revoke(record.id);
    // Same frozen clock: without the invalidate this would still be cached.
    expect(await store.callerFor(token)).toBeUndefined();
  });

  it("caches for the TTL, so a revocation elsewhere lags by that and no more", async () => {
    const a = await auth();
    const raw = "ddb_cached";
    const secrets = [tokenSecret(a, { id: "dddd", hash: a.hashToken(raw) })];
    const { core } = fakeCore(secrets);
    let at = Date.parse("2026-09-13T10:00:00.000Z");
    const store = new a.TokenStore(core as never, undefined, 5_000, () => at);
    expect(await store.callerFor(raw)).toBeDefined();
    // Deleted by somebody else, so the store is not told.
    secrets.length = 0;
    at += 4_000;
    expect(await store.callerFor(raw)).toBeDefined();
    at += 2_000;
    expect(await store.callerFor(raw)).toBeUndefined();
  });

  it("refuses to revoke the bootstrap token, because it is not drigodb's", async () => {
    const a = await auth();
    const { core, deleted } = fakeCore();
    const store = new a.TokenStore(core as never, "static");
    await expect(store.revoke(a.BOOTSTRAP_TOKEN_ID)).rejects.toThrow(a.TokenError);
    expect(deleted).toEqual([]);
  });

  it("lists metadata and never a token or a hash", async () => {
    const a = await auth();
    const { core } = fakeCore();
    const store = new a.TokenStore(core as never, "static");
    const { token } = await store.issue("ci", "admin");
    const listed = await store.list();
    const json = JSON.stringify(listed);
    expect(json).not.toContain(token);
    expect(json).not.toContain(a.hashToken(token));
    expect(listed.some((t) => t.bootstrap === true)).toBe(true);
    expect(listed.some((t) => t.name === "ci" && t.tier === "admin")).toBe(true);
  });
});

describe("token request validation", () => {
  afterEach(() => vi.resetModules());

  it("defaults to tenant, so nobody becomes an admin by omission", async () => {
    const a = await auth();
    expect(a.validateTokenRequest({ name: "ci" })).toEqual({ name: "ci", tier: "tenant" });
    expect(a.validateTokenRequest({ name: "ci", tier: "admin" }).tier).toBe("admin");
  });

  it("requires a name, because it is the only way to tell tokens apart later", async () => {
    const a = await auth();
    for (const bad of [null, undefined, {}, { name: "" }, { name: "  leading" }, { name: "a".repeat(64) }]) {
      expect(() => a.validateTokenRequest(bad)).toThrow(a.TokenError);
    }
  });

  it("bounds expires_in, and rejects anything that is not whole seconds", async () => {
    const a = await auth();
    expect(a.validateTokenRequest({ name: "ci", expires_in: 3600 }).expiresIn).toBe(3600);
    for (const bad of [0, -1, 1.5, "3600", 400 * 24 * 60 * 60]) {
      expect(() => a.validateTokenRequest({ name: "ci", expires_in: bad })).toThrow(a.TokenError);
    }
  });

  it("rejects a tier it does not have", async () => {
    const a = await auth();
    expect(() => a.validateTokenRequest({ name: "ci", tier: "root" })).toThrow(a.TokenError);
  });
});
