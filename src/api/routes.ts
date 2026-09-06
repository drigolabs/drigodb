// HTTP surface. Nine operations, designed against one real consumer.

import { Hono } from "hono";

import {
  NotFoundError,
  ResizeRefusedError,
  Provisioner,
  DeletionInFlightError,
  NotConfiguredError,
  ValidationError,
  validateExternalId,
  validateTier,
} from "../k8s/provisioner.js";
import type { Tier } from "../k8s/manifests.js";

export function buildRoutes(provisioner: Provisioner): Hono {
  const app = new Hono();


  app.post("/v1/databases", async (c) => {
    let externalId: string;
    try {
      const body = await c.req.json().catch(() => ({}));
      externalId = validateExternalId((body as { external_id?: unknown }).external_id);
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }

    const { database, uri, created } = await provisioner.create(externalId);
    // 202 on create because provisioning is asynchronous — roughly 12 seconds,
    // too long to hold a request open. 200 on a repeat, which returns the
    // existing database without its credentials.
    return c.json(created ? { ...database, connection_uri: uri } : database, created ? 202 : 200);
  });

  app.get("/v1/databases", async (c) => c.json({ databases: await provisioner.list() }));

  app.get("/v1/databases/:id", async (c) => c.json(await provisioner.get(c.req.param("id"))));

  // wake(), not scale(id, 1): waking is also when a database picks up the
  // pod template this build renders, including a rebuilt data-plane image.
  app.post("/v1/databases/:id/wake", async (c) =>
    c.json(await provisioner.wake(c.req.param("id")), 202),
  );

  app.post("/v1/databases/:id/hibernate", async (c) =>
    c.json(await provisioner.scale(c.req.param("id"), 0), 202),
  );

  // 200, not 202: the URI in this response is the point of the call, and it is
  // returned here and on creation only. For a running database the rotation has
  // already been applied by the time this returns; for a hibernated one it
  // applies on the next wake, which is the first moment the URI is usable.
  app.post("/v1/databases/:id/credentials", async (c) => {
    const { database, uri } = await provisioner.rotateCredentials(c.req.param("id"));
    return c.json({ ...database, connection_uri: uri });
  });

  // Growing is owner-initiated and automatically granted, provided the target
  // is a real tier no larger than the installation's ceiling. 202, because the
  // volume grows online but the WAL change needs the pod cycled behind it.
  app.post("/v1/databases/:id/resize", async (c) => {
    let tier: Tier;
    try {
      const body = await c.req.json().catch(() => ({}));
      tier = validateTier((body as { tier?: unknown }).tier);
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
    return c.json(await provisioner.resize(c.req.param("id"), tier), 202);
  });

  // The CA a consumer needs to verify a database, as PEM.
  //
  // Not secret — a CA certificate is what a server proves a chain against, and
  // withholding it would only mean every consumer turning verification off.
  // 409 when server authentication is not configured, because handing back
  // nothing would look like an empty CA rather than a feature that is off.
  app.get("/v1/ca", async (c) =>
    c.text(await provisioner.caCertificate(), 200, { "content-type": "application/x-pem-file" }),
  );


  app.delete("/v1/databases/:id", async (c) => {
    await provisioner.delete(c.req.param("id"));
    return c.body(null, 204);
  });

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    // 409, not 500: the volume could not grow, the caller can read why, and an
    // operator can fix it by choosing a StorageClass that allows expansion.
    if (err instanceof ResizeRefusedError) return c.json({ error: err.message }, 409);
    // 409, not 404: the feature exists and this installation has not enabled it,
    // which is a different fact from the thing not being there.
    if (err instanceof NotConfiguredError) return c.json({ error: err.message }, 409);
    // 409, not 500: the id is briefly taken by a database on its way out. The
    // caller has done nothing wrong and a retry in a few seconds succeeds.
    if (err instanceof DeletionInFlightError) return c.json({ error: err.message }, 409);
    console.error("[drigodb] unhandled error:", err);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
