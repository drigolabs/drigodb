// HTTP surface. Six operations, designed against one real consumer.

import { Hono } from "hono";

import {
  NotFoundError,
  Provisioner,
  ValidationError,
  validateExternalId,
} from "../k8s/provisioner.js";

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

  app.post("/v1/databases/:id/wake", async (c) =>
    c.json(await provisioner.scale(c.req.param("id"), 1), 202),
  );

  app.post("/v1/databases/:id/hibernate", async (c) =>
    c.json(await provisioner.scale(c.req.param("id"), 0), 202),
  );

  app.delete("/v1/databases/:id", async (c) => {
    await provisioner.delete(c.req.param("id"));
    return c.body(null, 204);
  });

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    console.error("[drigodb] unhandled error:", err);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
