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
// WHY NOT A SIDECAR IN THE DATABASE POD, watching itself?
//
// It is the better shape on paper — observation over the Unix socket with peer
// auth, no network, no credential, and no path from the control plane into the
// data plane at all. It is what the backup sidecar did before decision 0004
// gave the pod template to CloudNativePG.
//
// It is not free, and the cost is the wrong way round. Hibernation is a
// Kubernetes operation: annotating a Cluster. A database pod today can do
// NOTHING to Kubernetes — measured, not assumed: its ServiceAccount cannot get
// or patch its own Cluster and cannot read a Secret. Self-hibernation means
// granting each database pod permission to patch its own Cluster, which trades
// a narrow READ path from the control plane for a WRITE credential in the data
// plane. Today a compromised database is a compromised database; then it would
// also hold a Kubernetes credential.
//
// It also needs a CNPG-I plugin to inject the sidecar at all — a Go gRPC
// service with its own image, deployment and version pin — for one annotation.
//
// If the cost that bites is instead scraping N databases from one process, the
// cheap answer is to query Prometheus rather than each pod: one endpoint, no
// direct path, no new credential.
//
// And issue #87 may delete the question. A proxy in the connection path sees
// connections arrive and leave directly, and nothing needs scraping at all.
// Worth settling that before investing further in how idleness is observed.
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
