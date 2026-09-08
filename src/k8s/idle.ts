// Whether anybody is using a database.
//
// The question drigodb needs answered before it can put a database to sleep,
// and the awkward one: connection counts live in `pg_stat_activity`, and the
// control plane deliberately never connects to a hosted database. It holds
// every credential and has no route to use one, which is the property issue #29
// records and the NetworkPolicy enforces.
//
// So this reads the metrics CloudNativePG's instance manager already exports,
// over HTTP, on a port that is not PostgreSQL. drigodb learns THAT there are
// connections, never what they are, and still cannot authenticate to a
// database. That is a narrower thing to grant than a database credential, and
// it is worth being explicit that it is a change at all: the policy now admits
// the control plane to one port on each instance.
//
// The exporter's own backend is always there — `usename="postgres"`,
// `application_name="cnpg_metrics_exporter"` — so counting every backend would
// find no database ever idle. Measured on a cluster before this was written.

import { DB_USER } from "./manifests.js";

// cnpg_backends_total{application_name="psql",datname="app",state="active",usename="appuser"} 1
const BACKENDS = /^cnpg_backends_total\{([^}]*)\}\s+([0-9.eE+-]+)/;

function labels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/(\w+)="([^"]*)"/g)) out[m[1] as string] = m[2] as string;
  return out;
}

// How many connections the APPLICATION has open. Not how many connections
// exist: the exporter holds one permanently, and a database counted as busy
// because something is watching it would never sleep.
export function appBackends(metrics: string): number {
  let total = 0;
  for (const line of metrics.split("\n")) {
    const m = BACKENDS.exec(line);
    if (!m) continue;
    if (labels(m[1] as string).usename !== DB_USER) continue;
    const n = Number(m[2]);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

// Fetch and count, or undefined when the instance could not be reached.
//
// Undefined is not zero, and the difference decides whether a database gets
// hibernated. A pod mid-restart, a scrape that times out, a policy someone
// tightened — all of those look like silence, and treating silence as "nobody
// is connected" would put a busy database to sleep.
export async function appBackendsOf(
  podIp: string,
  port: number,
  timeoutMs = 3000,
): Promise<number | undefined> {
  try {
    const res = await fetch(`http://${podIp}:${port}/metrics`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    return appBackends(await res.text());
  } catch {
    return undefined;
  }
}
