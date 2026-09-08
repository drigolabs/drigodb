// Whether anybody is using a database.
//
// The subtlety these tests exist for: CloudNativePG's own metrics exporter
// holds a connection permanently, so counting every backend finds no database
// ever idle. Measured on a cluster before any of this was written — the scrape
// of a database nothing was using still reported one backend.

import { describe, expect, it } from "vitest";

import { appBackends } from "../src/k8s/idle.js";

// Real output, trimmed. The exporter's own line is the one that matters.
const EXPORTER_ONLY = `
# HELP cnpg_backends_total Number of backends
# TYPE cnpg_backends_total gauge
cnpg_backends_total{application_name="cnpg_metrics_exporter",datname="app",state="active",usename="postgres"} 1
cnpg_backends_waiting_total 0
`;

const WITH_CLIENT = `
cnpg_backends_total{application_name="cnpg_metrics_exporter",datname="app",state="active",usename="postgres"} 1
cnpg_backends_total{application_name="psql",datname="app",state="active",usename="appuser"} 1
`;

describe("counting who is connected", () => {
  it("does not count the metrics exporter, which is always there", () => {
    // The whole reason this is not `sum(cnpg_backends_total)`. Get this wrong
    // and automatic hibernation never fires for any database, silently, and
    // looks like a scheduling problem.
    expect(appBackends(EXPORTER_ONLY)).toBe(0);
  });

  it("counts the application's connections", () => {
    expect(appBackends(WITH_CLIENT)).toBe(1);
  });

  it("adds up backends across states and application names", () => {
    // pg_stat_activity splits by state, so one client with an idle connection
    // and one running a query are two lines rather than one.
    expect(
      appBackends(`
cnpg_backends_total{application_name="app",datname="app",state="idle",usename="appuser"} 3
cnpg_backends_total{application_name="app",datname="app",state="active",usename="appuser"} 2
cnpg_backends_total{application_name="cnpg_metrics_exporter",datname="app",state="active",usename="postgres"} 1
`),
    ).toBe(5);
  });

  it("reads nothing out of an empty or broken scrape", () => {
    // Zero here is a real answer meaning "no application connections". The
    // caller must not confuse it with a scrape that failed, which is why
    // appBackendsOf returns undefined rather than 0 for an unreachable pod.
    expect(appBackends("")).toBe(0);
    expect(appBackends("garbage\nnot metrics\n")).toBe(0);
    expect(appBackends("cnpg_backends_total{usename=\"appuser\"} notanumber")).toBe(0);
  });

  it("ignores other metrics that mention backends", () => {
    expect(
      appBackends(`
cnpg_backends_waiting_total 7
cnpg_backends_max_tx_duration_seconds{usename="appuser"} 42
`),
    ).toBe(0);
  });
});
