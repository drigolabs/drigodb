import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { buildRoutes } from "./api/routes.js";
import { apiToken, config } from "./config.js";
import { Provisioner } from "./k8s/provisioner.js";

function main(): void {
  // Read the token at boot so a missing one is a startup failure, not a
  // surprise on the first request.
  const token = apiToken();

  const app = new Hono();

  // Unauthenticated: probes must not need a credential.
  app.get("/healthz", (c) => c.json({ status: "ok", version: "0.0.1" }));

  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    // Length check first: timingSafeEqual throws on a length mismatch, and the
    // length of a bearer token is not a secret worth protecting.
    if (provided.length !== token.length || provided !== token) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.route("/", buildRoutes(Provisioner.fromCluster()));

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[drigodb] listening on :${info.port}`);
    console.log(`[drigodb] provisioning into namespace ${config.databaseNamespace}`);
    console.log(`[drigodb] postgres image ${config.pgImage}`);
    console.log(`[drigodb] gateway image  ${config.gatewayImage}`);
    console.log(`[drigodb] storage class  ${config.storageClass} @ ${config.storageSize}`);
  });
}

main();
