// The decision to put somebody's database to sleep.
//
// Every case here is one where being wrong costs something real: hibernating a
// busy database interrupts an application, and failing to hibernate an idle one
// is the bill this feature exists to stop.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { sweepIdleDatabases } from "../src/k8s/provisioner.js";

const ID = "a1b2c3d4e5f6";

function fakeProvisioner(opts: {
  status?: string;
  backends?: number | undefined;
  idleSince?: Date;
}) {
  const calls: string[] = [];
  return {
    calls,
    p: {
      list: async () => [{ id: ID, status: opts.status ?? "ready" }],
      appConnectionsOf: async () => opts.backends,
      idleSince: async () => opts.idleSince,
      markIdleSince: async () => { calls.push("mark"); },
      clearIdleSince: async () => { calls.push("clear"); },
      hibernateAutomatically: async () => { calls.push("hibernate"); },
    } as never,
  };
}

// The threshold has to be on for any of this to run.
beforeEach(() => {
  vi.stubEnv("DRIGODB_IDLE_AFTER_SECONDS", "900");
  vi.resetModules();
});

async function sweep(opts: Parameters<typeof fakeProvisioner>[0], now = new Date("2026-09-08T12:00:00Z")) {
  vi.resetModules();
  vi.stubEnv("DRIGODB_IDLE_AFTER_SECONDS", "900");
  const { sweepIdleDatabases: fresh } = await import("../src/k8s/provisioner.js");
  const f = fakeProvisioner(opts);
  await fresh(f.p, now);
  return f.calls;
}

describe("the idle sweep", () => {
  it("does nothing at all when nobody turned it on", async () => {
    vi.resetModules();
    vi.stubEnv("DRIGODB_IDLE_AFTER_SECONDS", "0");
    const { sweepIdleDatabases: off } = await import("../src/k8s/provisioner.js");
    const f = fakeProvisioner({ backends: 0, idleSince: new Date("2020-01-01") });
    await off(f.p, new Date());
    expect(f.calls).toEqual([]);
  });

  it("leaves a busy database alone and forgets it was ever quiet", async () => {
    expect(await sweep({ backends: 3, idleSince: new Date("2026-09-08T11:00:00Z") }))
      .toEqual(["clear"]);
  });

  it("starts the clock the first time it finds one quiet", async () => {
    expect(await sweep({ backends: 0 })).toEqual(["mark"]);
  });

  it("waits out the threshold rather than sleeping on the first quiet tick", async () => {
    // Fourteen minutes into a fifteen-minute threshold.
    expect(await sweep({ backends: 0, idleSince: new Date("2026-09-08T11:46:00Z") }))
      .toEqual([]);
  });

  it("hibernates once it has been quiet for long enough", async () => {
    expect(await sweep({ backends: 0, idleSince: new Date("2026-09-08T11:44:00Z") }))
      .toEqual(["hibernate"]);
  });

  it("does NOT hibernate a database it could not reach", async () => {
    // The case that would be a bug rather than a bill. A pod mid-restart or a
    // scrape that timed out looks exactly like nobody being connected, and
    // treating silence as idleness would stop a database because drigodb
    // briefly could not see it.
    expect(await sweep({ backends: undefined, idleSince: new Date("2020-01-01") }))
      .toEqual([]);
  });

  it("ignores a database that is not running", async () => {
    // Already hibernated, provisioning, failed — none of them are things to put
    // to sleep, and scraping a database with no pod would report unreachable
    // forever.
    for (const status of ["hibernated", "provisioning", "failed"]) {
      expect(await sweep({ status, backends: 0, idleSince: new Date("2020-01-01") }))
        .toEqual([]);
    }
  });

  it("keeps going when one database throws", async () => {
    vi.resetModules();
    vi.stubEnv("DRIGODB_IDLE_AFTER_SECONDS", "900");
    const { sweepIdleDatabases: fresh } = await import("../src/k8s/provisioner.js");
    const hibernated: string[] = [];
    const p = {
      list: async () => [{ id: "aaaaaaaaaaaa", status: "ready" }, { id: "bbbbbbbbbbbb", status: "ready" }],
      appConnectionsOf: async (id: string) => {
        if (id === "aaaaaaaaaaaa") throw new Error("boom");
        return 0;
      },
      idleSince: async () => new Date("2020-01-01"),
      markIdleSince: async () => undefined,
      clearIdleSince: async () => undefined,
      hibernateAutomatically: async (id: string) => { hibernated.push(id); },
    } as never;
    await expect(fresh(p, new Date())).resolves.toBeUndefined();
    expect(hibernated).toEqual(["bbbbbbbbbbbb"]);
  });
});
