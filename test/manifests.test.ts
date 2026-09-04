// Pins the contract that was expensive to discover, where every failure mode is
// silent rather than loud. See docs/leaving-documentdb.md for what changed when
// the extension and the gateway went, and docs/documentdb-multitenancy-spike.md
// for the isolation findings that shaped what stayed.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALLOW_LABEL,
  DATA_VOLUME,
  DB_ID_LABEL,
  EXTERNAL_ID_LABEL,
  POSTGRES_PORT,
  RUN_AS_GROUP,
  RUN_AS_USER,
  SOCKET_MOUNT_PATH,
  SOCKET_VOLUME,
  buildNetworkPolicy,
  buildSecret,
  buildService,
  buildStatefulSet,
  connectionUri,
  templateHash,
} from "../src/k8s/manifests.js";
import { ValidationError, validateExternalId } from "../src/k8s/provisioner.js";

const ID = "a1b2c3d4e5f6";
const EXT = "openvoid-app-01JQ";

describe("statefulset", () => {
  it("runs as the image's postgres UID and GID, which are not the same number", () => {
    // uid=26(postgres) gid=102(postgres) in CNPG's image. Carrying the old
    // assumption that both were 26 would leave PGDATA group-owned by a group
    // the server does not belong to.
    const ctx = buildStatefulSet(ID, EXT).spec?.template.spec?.securityContext;
    expect(ctx?.runAsUser).toBe(RUN_AS_USER);
    expect(ctx?.runAsGroup).toBe(RUN_AS_GROUP);
    expect(ctx?.fsGroup).toBe(RUN_AS_GROUP);
    expect(RUN_AS_GROUP).not.toBe(RUN_AS_USER);
  });

  it("runs postgres alone, with no proxy in front of it", () => {
    const containers = buildStatefulSet(ID, EXT).spec?.template.spec?.containers ?? [];
    expect(containers.map((c) => c.name)).toEqual(["postgres"]);
  });

  it("keeps the shared socket, which outlived the gateway", () => {
    // The backup sidecar reaches the server over it and authenticates by peer,
    // which is why backups need no credential and no network path.
    const pg = buildStatefulSet(ID, EXT).spec?.template.spec?.containers?.[0];
    expect((pg?.volumeMounts ?? []).map((m) => m.mountPath)).toContain(SOCKET_MOUNT_PATH);
  });

  it("publishes PostgreSQL's port from the container", () => {
    const pg = buildStatefulSet(ID, EXT).spec?.template.spec?.containers?.[0];
    expect(pg?.ports?.[0]?.containerPort).toBe(POSTGRES_PORT);
  });

  it("does not let fsGroup break PostgreSQL on remount", () => {
    // Recursive g+rwX on every mount turns PGDATA group-writable, which
    // PostgreSQL refuses to start on — so the database wakes exactly never.
    expect(buildStatefulSet(ID, EXT).spec?.template.spec?.securityContext?.fsGroupChangePolicy)
      .toBe("OnRootMismatch");
  });

  it("starts hibernated and retains its volume", () => {
    const spec = buildStatefulSet(ID, EXT).spec;
    expect(spec?.replicas).toBe(0);
    // The alternative silently deletes a customer's data.
    expect(spec?.persistentVolumeClaimRetentionPolicy?.whenScaled).toBe("Retain");
    expect(spec?.persistentVolumeClaimRetentionPolicy?.whenDeleted).toBe("Retain");
  });

  it("never inlines the password", () => {
    const pg = buildStatefulSet(ID, EXT).spec?.template.spec?.containers?.find(
      (c) => c.name === "postgres",
    );
    const pw = pg?.env?.find((e) => e.name === "APP_DB_PASSWORD");
    expect(pw?.value).toBeUndefined();
    expect(pw?.valueFrom?.secretKeyRef?.name).toBe(`db-${ID}-credentials`);
  });
});

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
  it("exposes PostgreSQL's port and selects only this database", () => {
    const svc = buildService(ID, EXT);
    expect(svc.spec?.ports?.[0]?.port).toBe(POSTGRES_PORT);
    expect(svc.spec?.selector).toEqual({ [DB_ID_LABEL]: ID });
  });

  it("labels objects with both ids so lookups and idempotency work", () => {
    for (const obj of [buildStatefulSet(ID, EXT), buildService(ID, EXT), buildSecret(ID, EXT, "pw")]) {
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
describe("backup sidecar", () => {
  async function withBackupEnv(env: Record<string, string>) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const m = await import("../src/k8s/manifests.js");
    return m;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("adds no sidecar when nothing is configured", () => {
    const containers = buildStatefulSet(ID, EXT).spec?.template.spec?.containers ?? [];
    expect(containers.map((c) => c.name)).toEqual(["postgres"]);
  });

  it("adds one when a bucket and an endpoint are set", async () => {
    const m = await withBackupEnv({
      DRIGODB_BACKUP_BUCKET: "drigodb-backups",
      DRIGODB_BACKUP_ENDPOINT: "https://fra1.digitaloceanspaces.com",
    });
    const containers = m.buildStatefulSet(ID, EXT).spec?.template.spec?.containers ?? [];
    expect(containers.map((c) => c.name).sort()).toEqual(["backup", "postgres"]);
  });

  it("stays off when only half of it is configured", async () => {
    // A bucket with nowhere to send it is a misconfiguration, and the safe
    // reading of a misconfiguration is "backups are off", not "add a container
    // that will fail".
    const m = await withBackupEnv({ DRIGODB_BACKUP_BUCKET: "drigodb-backups" });
    const containers = m.buildStatefulSet(ID, EXT).spec?.template.spec?.containers ?? [];
    expect(containers.map((c) => c.name)).not.toContain("backup");
  });

  it("carries no probe, so a broken bucket cannot take the database offline", async () => {
    // A readiness probe here would put backups on the pod's Ready condition,
    // and a NotReady pod is removed from its Service. An unreachable bucket
    // would then sever a database that is working perfectly well.
    const m = await withBackupEnv({
      DRIGODB_BACKUP_BUCKET: "drigodb-backups",
      DRIGODB_BACKUP_ENDPOINT: "https://fra1.digitaloceanspaces.com",
    });
    const backup = (m.buildStatefulSet(ID, EXT).spec?.template.spec?.containers ?? [])
      .find((c) => c.name === "backup");
    expect(backup?.readinessProbe).toBeUndefined();
    expect(backup?.livenessProbe).toBeUndefined();
    expect(backup?.startupProbe).toBeUndefined();
  });

  it("reaches PostgreSQL by socket and never mounts the data volume", async () => {
    const m = await withBackupEnv({
      DRIGODB_BACKUP_BUCKET: "drigodb-backups",
      DRIGODB_BACKUP_ENDPOINT: "https://fra1.digitaloceanspaces.com",
    });
    const backup = (m.buildStatefulSet(ID, EXT).spec?.template.spec?.containers ?? [])
      .find((c) => c.name === "backup");
    const mounts = (backup?.volumeMounts ?? []).map((v) => v.name);
    expect(mounts).toEqual([SOCKET_VOLUME]);
    expect(mounts).not.toContain(DATA_VOLUME);
  });

  it("changes the template hash, so existing databases gain it on their next wake", async () => {
    const before = templateHash(ID, EXT);
    const m = await withBackupEnv({
      DRIGODB_BACKUP_BUCKET: "drigodb-backups",
      DRIGODB_BACKUP_ENDPOINT: "https://fra1.digitaloceanspaces.com",
    });
    expect(m.templateHash(ID, EXT)).not.toBe(before);
  });
});
