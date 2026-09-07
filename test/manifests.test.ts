// Pins the contract that was expensive to discover, where every failure mode is
// silent rather than loud.
//
// A hosted database is a CloudNativePG Cluster now (decision 0004), so most of
// what this file used to assert about a pod template has gone with the pod
// template. What is left is the part drigodb still owns — and the parts of the
// Cluster spec that were established against a live cluster because a plausible
// spelling does nothing.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALLOW_LABEL,
  DB_ID_LABEL,
  EXTERNAL_ID_LABEL,
  POSTGRES_PORT,
  buildNetworkPolicy,
  buildSecret,
  buildService,
  buildCluster,
  connectionUri,
} from "../src/k8s/manifests.js";
import { ValidationError, validateExternalId } from "../src/k8s/provisioner.js";

const ID = "a1b2c3d4e5f6";
const EXT = "openvoid-app-01JQ";


describe("network policy", () => {
  it("uses `_from`, which serializes to `from`", () => {
    // A plain `from` is dropped by the client, leaving a rule that matches no
    // sources — indistinguishable from working isolation.
    const rule = buildNetworkPolicy(ID, EXT).spec?.ingress?.[0] as Record<string, unknown>;
    expect(rule).toHaveProperty("_from");
    expect(Array.isArray(rule._from)).toBe(true);
  });

  it("admits only pods opted in to this database, on PostgreSQL's port", () => {
    const rule = buildNetworkPolicy(ID, EXT).spec?.ingress?.[0];
    expect(rule?._from?.[0]?.podSelector?.matchLabels?.[ALLOW_LABEL]).toBe(ID);
    expect(rule?.ports?.[0]?.port).toBe(POSTGRES_PORT);
  });
});

describe("service and identity", () => {
  it("selects whichever instance is primary, by number not by port name", () => {
    const svc = buildService(ID, EXT);
    // CloudNativePG's labels, so the endpoint follows a failover rather than
    // pinning to one pod.
    expect(svc.spec?.selector).toEqual({
      "cnpg.io/cluster": `db-${ID}`,
      "cnpg.io/instanceRole": "primary",
    });
    // The NUMBER. CNPG names the container port `postgresql`; a targetPort of
    // "postgres" resolves to nothing, and a Service with no endpoints hangs
    // every connection until TCP gives up rather than refusing it.
    expect(svc.spec?.ports?.[0]?.targetPort).toBe(POSTGRES_PORT);
    expect(svc.spec?.ports?.[0]?.port).toBe(POSTGRES_PORT);
  });

  it("labels objects with both ids so lookups and idempotency work", () => {
    for (const obj of [buildCluster(ID, EXT), buildService(ID, EXT), buildSecret(ID, EXT, "pw")]) {
      expect(obj.metadata?.labels?.[DB_ID_LABEL]).toBe(ID);
      expect(obj.metadata?.labels?.[EXTERNAL_ID_LABEL]).toBe(EXT);
    }
  });

  it("percent-encodes the password in the connection URI", () => {
    expect(connectionUri(ID, "p@ss:w/rd")).toContain("p%40ss%3Aw%2Frd");
  });

  it("hands out a PostgreSQL URI, naming the database and requiring TLS", () => {
    // The contract consumers hold. sslmode=require rather than verify-full,
    // because bootstrap.sh self-signs; issue #9 is what upgrades it.
    const uri = connectionUri(ID, "pw");
    expect(uri.startsWith("postgres://appuser:pw@")).toBe(true);
    expect(uri).toContain(`:${POSTGRES_PORT}/app`);
    expect(uri).toContain("sslmode=require");
    expect(uri).not.toContain("mongodb://");
  });
});

describe("external_id validation", () => {
  it("accepts label-safe identifiers", () => {
    for (const v of ["abc", "openvoid-app-01JQ", "a.b_c-1"]) {
      expect(validateExternalId(v)).toBe(v);
    }
  });

  it("rejects what Kubernetes would reject anyway", () => {
    // Better a 400 than a confusing API-server error later.
    for (const v of ["", "-leading", "trailing-", "has space", "a".repeat(64), 42, null]) {
      expect(() => validateExternalId(v)).toThrow(ValidationError);
    }
  });
});

// Backups are opt-in, and the shape of the opt-out matters as much as the
// opt-in: with no destination configured a database must be exactly what it was
// before, not a pod carrying a container that cannot do its job.

// Restoring into a new database. The Job is deliberately unprivileged: it holds
// the app's own credential and reaches the database the way any consumer does.

describe("storage class portability", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("omits storageClassName when none is set, rather than sending an empty string", async () => {
    // "" and absent mean opposite things to Kubernetes: the first says use NO
    // storage class and bind a pre-provisioned volume, the second says use the
    // cluster's default. Only the second installs on kind, EKS or GKE without
    // being told which.
    vi.resetModules();
    const m = await import("../src/k8s/manifests.js");
    expect(m.buildCluster(ID, EXT).spec.storage).not.toHaveProperty("storageClass");
  });

  it("sets it when someone names one", async () => {
    vi.resetModules();
    vi.stubEnv("DRIGODB_STORAGE_CLASS", "do-block-storage");
    const m = await import("../src/k8s/manifests.js");
    expect(m.buildCluster(ID, EXT).spec.storage.storageClass).toBe("do-block-storage");
  });
});

describe("storage tiers", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("only ever goes up, and the sizes are the tiers", async () => {
    const m = await import("../src/k8s/manifests.js");
    expect(m.TIER_ORDER).toEqual(["small", "medium", "large"]);
    const sizes = m.TIER_ORDER.map((t) => m.TIERS[t].storage);
    expect(sizes).toEqual(["1Gi", "5Gi", "20Gi"]);
  });

  it("treats a database with no tier label as small", async () => {
    // Every database provisioned before tiers existed. It is what they were
    // given and what their PVC still says.
    const m = await import("../src/k8s/manifests.js");
    expect(m.tierOf(undefined)).toBe("small");
    expect(m.tierOf({})).toBe("small");
    expect(m.tierOf({ [m.TIER_LABEL]: "nonsense" })).toBe("small");
    expect(m.tierOf({ [m.TIER_LABEL]: "large" })).toBe("large");
  });

  it("carries max_wal_size per database, on the Cluster the operator reads", async () => {
    const m = await import("../src/k8s/manifests.js");
    const walOf = (t: "small" | "medium" | "large") =>
      m.buildCluster(ID, EXT, t).spec.postgresql.parameters.max_wal_size;
    expect(walOf("small")).toBe("256MB");
    expect(walOf("medium")).toBe("1GB");
    expect(walOf("large")).toBe("2GB");
  });

  it("keeps min_wal_size, which the deleted postgresql.conf used to carry", async () => {
    // The rest of that file was the operator's business. This one setting was
    // not, and dropping it silently would have changed checkpoint behaviour on
    // every database with nothing to notice it.
    const m = await import("../src/k8s/manifests.js");
    expect(m.buildCluster(ID, EXT).spec.postgresql.parameters.min_wal_size).toBe("64MB");
  });

  it("labels the Cluster, because the volume is the truth and reading it is a second call", async () => {
    const m = await import("../src/k8s/manifests.js");
    const cluster = m.buildCluster(ID, EXT, "medium");
    expect(cluster.metadata.labels[m.TIER_LABEL]).toBe("medium");
    expect(cluster.spec.storage.size).toBe("5Gi");
  });


});

describe("server authentication", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  async function withIssuer() {
    vi.resetModules();
    vi.stubEnv("DRIGODB_TLS_ISSUER", "drigodb-api-issuer");
    return await import("../src/k8s/manifests.js");
  }

  it("promises only what a client can actually verify", async () => {
    // Without an issuer the certificate is self-signed, so verify-full would be
    // a promise the client cannot keep — and the only thing it could do about it
    // is turn verification off, which is the habit this exists to break.
    vi.resetModules();
    const off = await import("../src/k8s/manifests.js");
    expect(off.connectionUri(ID, "pw")).toContain("sslmode=require");

    const on = await withIssuer();
    expect(on.connectionUri(ID, "pw")).toContain("sslmode=verify-full");
  });

  it("signs the name the connection URI actually names", async () => {
    // A certificate for the pod or the StatefulSet would validate against
    // nothing a consumer ever connects to.
    const m = await withIssuer();
    const cert = m.buildCertificate(ID, EXT) as { spec: { commonName: string; dnsNames: string[] } };
    expect(cert.spec.commonName).toBe(m.endpointHost(ID));
    expect(cert.spec.dnsNames).toContain(m.endpointHost(ID));
  });

  // The certificate tests that used to live here asserted a volume mount on a
  // pod template drigodb no longer builds. CloudNativePG owns the pod and
  // manages its own TLS, and how drigodb's cert-manager Certificate meets that
  // is the one part of decision 0004 still unestablished — see #80. Deleted
  // rather than adapted, because a test asserting the wrong mechanism passes
  // while the feature is broken.
});

describe("server certificates", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("adds nothing when this installation issues no certificates", async () => {
    vi.resetModules();
    const m = await import("../src/k8s/manifests.js");
    expect(m.buildCluster(ID, EXT).spec).not.toHaveProperty("certificates");
  });

  it("hands CloudNativePG drigodb's own CA and server certificate", async () => {
    // Without this the operator signs its own, from a CA it generates PER
    // CLUSTER, naming only its own -rw/-ro/-r Services. The connection URI names
    // drigodb's Service, which is not among them, so verify-full fails hostname
    // verification on every database — while sslmode=require goes on passing,
    // which is how nobody would notice. Measured against CNPG 1.27.
    vi.resetModules();
    vi.stubEnv("DRIGODB_TLS_ISSUER", "drigodb-ca");
    const m = await import("../src/k8s/manifests.js");
    const certs = m.buildCluster(ID, EXT).spec.certificates;
    expect(certs?.serverTLSSecret).toBe(m.tlsSecretName(ID));
    expect(certs?.serverCASecret).toBe("drigodb-api-ca");
  });

  it("never names the CA secret after the cluster", async () => {
    // `<cluster>-ca` is where CloudNativePG keeps its own CLIENT CA. Taking the
    // name leaves the operator looking for a private key nobody put there, and
    // the cluster fails to reconcile with "missing ca.key secret data" — which
    // reads like a refusal to accept an external CA and is not one.
    vi.resetModules();
    vi.stubEnv("DRIGODB_TLS_ISSUER", "drigodb-ca");
    const m = await import("../src/k8s/manifests.js");
    const certs = m.buildCluster(ID, EXT).spec.certificates;
    expect(certs?.serverCASecret).not.toBe(`db-${ID}-ca`);
    expect(certs?.serverTLSSecret).not.toBe(`db-${ID}-server`);
  });

  it("names drigodb's Service in the certificate, which is what the URI points at", async () => {
    vi.resetModules();
    vi.stubEnv("DRIGODB_TLS_ISSUER", "drigodb-ca");
    const m = await import("../src/k8s/manifests.js");
    const spec = (m.buildCertificate(ID, EXT) as { spec: { dnsNames: string[]; commonName: string } }).spec;
    expect(spec.commonName).toBe(m.endpointHost(ID));
    expect(spec.dnsNames).toContain(m.endpointHost(ID));
  });
});

describe("backups", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  async function withBackups() {
    vi.resetModules();
    vi.stubEnv("DRIGODB_BACKUP_OBJECT_STORE", "drigodb-api-backups");
    return await import("../src/k8s/manifests.js");
  }

  it("adds no plugin when the installation has nowhere to put a backup", async () => {
    vi.resetModules();
    const m = await import("../src/k8s/manifests.js");
    expect(m.buildCluster(ID, EXT).spec).not.toHaveProperty("plugins");
  });

  it("points the database at the installation's one ObjectStore", async () => {
    // One store for every database. CloudNativePG separates them inside the
    // bucket by serverName, which defaults to the Cluster name — and those are
    // derived from external_id, so they are distinct without drigodb passing
    // anything to make them so.
    const m = await withBackups();
    const p = m.buildCluster(ID, EXT).spec.plugins?.[0];
    expect(p?.name).toBe("barman-cloud.cloudnative-pg.io");
    expect(p?.parameters.barmanObjectName).toBe("drigodb-api-backups");
  });

  it("archives WAL, which is what makes a backup more than a snapshot", async () => {
    // Without isWALArchiver the plugin takes base backups and archives nothing,
    // so a restore can only reach the moment the backup was taken. Point-in-time
    // recovery is the archive, not the backup.
    const m = await withBackups();
    expect(m.buildCluster(ID, EXT).spec.plugins?.[0]?.isWALArchiver).toBe(true);
  });

  it("asks the operator for a backup rather than reaching for the bucket", async () => {
    const m = await withBackups();
    const b = m.buildBackup(ID, EXT, new Date("2026-09-07T07:18:16Z")) as {
      metadata: { name: string; labels: Record<string, string> };
      spec: { cluster: { name: string }; method: string; pluginConfiguration: { name: string } };
    };
    expect(b.spec.cluster.name).toBe(`db-${ID}`);
    expect(b.spec.method).toBe("plugin");
    expect(b.spec.pluginConfiguration.name).toBe("barman-cloud.cloudnative-pg.io");
    // Labelled with the database id, because listing is a label selector and a
    // backup that carries no id belongs to no database anyone can find.
    expect(b.metadata.labels["drigodb.io/database-id"]).toBe(ID);
  });

  it("names a backup so that a plain listing sorts into the order it happened", async () => {
    const m = await withBackups();
    const early = (m.buildBackup(ID, EXT, new Date("2026-01-02T03:04:05Z")) as { metadata: { name: string } }).metadata.name;
    const late = (m.buildBackup(ID, EXT, new Date("2026-11-12T13:14:15Z")) as { metadata: { name: string } }).metadata.name;
    expect([late, early].sort()).toEqual([early, late]);
    expect(early).toMatch(/^bk-[0-9a-f]{12}-\d{14}$/);
  });
});
