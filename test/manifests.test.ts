// Pins the contract that was expensive to discover, where every failure mode is
// silent rather than loud. See docs/documentdb-multitenancy-spike.md.

import { describe, expect, it } from "vitest";

import {
  ALLOW_LABEL,
  DB_ID_LABEL,
  EXTERNAL_ID_LABEL,
  GATEWAY_PORT,
  MONGO_PORT,
  RUN_AS_USER,
  SOCKET_MOUNT_PATH,
  buildNetworkPolicy,
  buildSecret,
  buildService,
  buildStatefulSet,
  connectionUri,
} from "../src/k8s/manifests.js";
import { ValidationError, validateExternalId } from "../src/k8s/provisioner.js";

const ID = "a1b2c3d4e5f6";
const EXT = "openvoid-app-01JQ";

describe("statefulset", () => {
  it("runs both containers as the PostgreSQL UID", () => {
    // PostgreSQL resolves the gateway's peer UID against its own passwd
    // database; a mismatch fails every connection.
    expect(buildStatefulSet(ID, EXT).spec?.template.spec?.securityContext?.runAsUser).toBe(RUN_AS_USER);
  });

  it("mounts the shared socket into both containers", () => {
    const containers = buildStatefulSet(ID, EXT).spec?.template.spec?.containers ?? [];
    expect(containers.map((c) => c.name).sort()).toEqual(["gateway", "postgres"]);
    for (const c of containers) {
      expect((c.volumeMounts ?? []).map((m) => m.mountPath)).toContain(SOCKET_MOUNT_PATH);
    }
  });

  it("starts hibernated and retains its volume", () => {
    const spec = buildStatefulSet(ID, EXT).spec;
    expect(spec?.replicas).toBe(0);
    // The alternative silently deletes a customer's data.
    expect(spec?.persistentVolumeClaimRetentionPolicy?.whenScaled).toBe("Retain");
    expect(spec?.persistentVolumeClaimRetentionPolicy?.whenDeleted).toBe("Retain");
  });

  it("mounts the gateway's state volume over the parent directory", () => {
    // The image ships /var/lib/documentdb-gateway as drwxrwx--- owned by its
    // packaged user, which the pod's UID cannot traverse. fsGroup fixes a
    // mounted volume, not the image directory above it.
    const gw = buildStatefulSet(ID, EXT).spec?.template.spec?.containers?.find(
      (c) => c.name === "gateway",
    );
    const mount = (gw?.volumeMounts ?? []).find((m) => m.name === "gateway-state");
    expect(mount?.mountPath).toBe("/var/lib/documentdb-gateway");
  });

  it("separates 'backend works' from 'listener accepts'", () => {
    // `check` passes while the gateway's socket is still closed, so using it
    // for readiness reports Ready before a client can connect.
    const gw = buildStatefulSet(ID, EXT).spec?.template.spec?.containers?.find(
      (c) => c.name === "gateway",
    );
    expect(gw?.startupProbe?.exec?.command).toEqual(["/usr/bin/documentdb-gateway", "check"]);
    expect(gw?.readinessProbe?.tcpSocket?.port).toBe("mongo");
    expect(gw?.readinessProbe?.exec).toBeUndefined();
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

  it("admits only pods opted in to this database, on the gateway port", () => {
    const rule = buildNetworkPolicy(ID, EXT).spec?.ingress?.[0];
    expect(rule?._from?.[0]?.podSelector?.matchLabels?.[ALLOW_LABEL]).toBe(ID);
    expect(rule?.ports?.[0]?.port).toBe(GATEWAY_PORT);
  });
});

describe("service and identity", () => {
  it("exposes the Mongo port and selects only this database", () => {
    const svc = buildService(ID, EXT);
    expect(svc.spec?.ports?.[0]?.port).toBe(MONGO_PORT);
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
