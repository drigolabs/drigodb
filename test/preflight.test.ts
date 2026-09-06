// The two ways a cluster can be missing something drigodb needs, and both of
// them are silent.
//
// Without these checks an installation with no CloudNativePG operator, or no
// default StorageClass, installs green and fails at the first database a
// consumer asks for. Every assertion here is about what the readiness probe
// says before that happens.

import { describe, expect, it } from "vitest";

import { CNPG_GROUP, PreflightCache, runPreflight } from "../src/k8s/preflight.js";

const withCnpg = { getAPIVersions: async () => ({ groups: [{ name: "apps" }, { name: CNPG_GROUP }] }) };
const withoutCnpg = { getAPIVersions: async () => ({ groups: [{ name: "apps" }] }) };

function storage(items: Array<{ name: string; isDefault?: boolean }>) {
  return {
    listStorageClass: async () => ({
      items: items.map((i) => ({
        metadata: {
          name: i.name,
          ...(i.isDefault
            ? { annotations: { "storageclass.kubernetes.io/is-default-class": "true" } }
            : {}),
        },
      })),
    }),
  };
}

const forbidden = {
  listStorageClass: async () => {
    throw Object.assign(new Error("forbidden"), { code: 403 });
  },
};

const check = (p: Awaited<ReturnType<typeof runPreflight>>, name: string) =>
  p.checks.find((c) => c.name === name);

describe("preflight", () => {
  it("is ready when the operator and a default StorageClass are both there", async () => {
    const p = await runPreflight(withCnpg as never, storage([{ name: "standard", isDefault: true }]) as never);
    expect(p.ready).toBe(true);
    expect(check(p, "cloudnativepg")?.status).toBe("ok");
    expect(check(p, "storageclass")?.status).toBe("ok");
  });

  it("is not ready without the CloudNativePG operator", async () => {
    // The failure this whole file exists for: helm reports success, the
    // Deployment goes Ready, and the Role grants rights over an API group that
    // does not exist — Kubernetes permits that without complaint.
    const p = await runPreflight(withoutCnpg as never, storage([{ name: "standard", isDefault: true }]) as never);
    expect(p.ready).toBe(false);
    expect(check(p, "cloudnativepg")?.status).toBe("failed");
    expect(check(p, "cloudnativepg")?.detail).toContain("not installed");
  });

  it("is not ready when no StorageClass is default and none was named", async () => {
    // Every database would sit in provisioning with an unbound volume, and
    // there is no error anywhere in the cluster to find.
    const p = await runPreflight(withCnpg as never, storage([{ name: "slow" }, { name: "fast" }]) as never);
    expect(p.ready).toBe(false);
    expect(check(p, "storageclass")?.status).toBe("failed");
    // Naming what IS there is the difference between a message and a fix.
    expect(check(p, "storageclass")?.detail).toContain("slow, fast");
  });

  it("is not ready when the named StorageClass does not exist", async () => {
    // A typo in database.storageClass is indistinguishable from a healthy
    // install until the first database never binds.
    const p = await runPreflight(
      withCnpg as never,
      storage([{ name: "standard", isDefault: true }]) as never,
      "do-block-storage",
    );
    expect(p.ready).toBe(false);
    expect(check(p, "storageclass")?.status).toBe("failed");
    expect(check(p, "storageclass")?.detail).toContain("do-block-storage");
  });

  it("is ready when the named StorageClass exists, default or not", async () => {
    // An explicitly named class need not be the cluster default — that is the
    // whole reason for naming one.
    const p = await runPreflight(
      withCnpg as never,
      storage([{ name: "standard", isDefault: true }, { name: "do-block-storage" }]) as never,
      "do-block-storage",
    );
    expect(p.ready).toBe(true);
  });

  it("reports both failures at once rather than the first one", async () => {
    // A cluster missing two things should say so in one go. Fixing one and
    // being told about the next is how a ten-minute setup becomes an hour.
    const p = await runPreflight(withoutCnpg as never, storage([]) as never);
    expect(p.ready).toBe(false);
    expect(p.checks.filter((c) => c.status === "failed")).toHaveLength(2);
  });

  it("stays ready when it is not allowed to look", async () => {
    // "Forbidden" is not "missing". A hardened cluster that declines the
    // ClusterRole must still be able to run drigodb — refusing to serve over a
    // check meant to help would break the installation it was protecting.
    const p = await runPreflight(withCnpg as never, forbidden as never);
    expect(p.ready).toBe(true);
    expect(check(p, "storageclass")?.status).toBe("unverified");
    expect(check(p, "storageclass")?.detail).toContain("not permitted");
  });

  it("tolerates more than one default StorageClass, and says so", async () => {
    const p = await runPreflight(
      withCnpg as never,
      storage([{ name: "a", isDefault: true }, { name: "b", isDefault: true }]) as never,
    );
    expect(p.ready).toBe(true);
    expect(check(p, "storageclass")?.detail).toContain("2 default");
  });

  it("caches, so a probe every five seconds is not two API calls every five seconds", async () => {
    let calls = 0;
    const counting = {
      getAPIVersions: async () => {
        calls++;
        return { groups: [{ name: CNPG_GROUP }] };
      },
    };
    let now = 0;
    const cache = new PreflightCache(
      counting as never,
      storage([{ name: "standard", isDefault: true }]) as never,
      () => now,
    );

    await cache.get();
    await cache.get();
    expect(calls).toBe(1);

    // And re-asks once the answer is stale, so installing the missing piece is
    // noticed within a probe interval rather than a redeploy.
    now = 11_000;
    await cache.get();
    expect(calls).toBe(2);
  });
});
