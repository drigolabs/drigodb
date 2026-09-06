import { serve } from "@hono/node-server";
import { ApisApi, KubeConfig, StorageV1Api } from "@kubernetes/client-node";
import { Hono } from "hono";

import { buildRoutes } from "./api/routes.js";
import { apiToken, config } from "./config.js";
import { PreflightCache, logPreflight } from "./k8s/preflight.js";
import { Provisioner } from "./k8s/provisioner.js";

function main(): void {
  // Read the token at boot so a missing one is a startup failure, not a
  // surprise on the first request.
  const token = apiToken();

  const kc = new KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
  else kc.loadFromDefault();

  const app = new Hono();

  // Unauthenticated: probes must not need a credential.
  //
  // Liveness. "The process is running" and nothing more — restarting drigodb
  // because its cluster is missing an operator would help nobody.
  app.get("/healthz", (c) => c.json({ status: "ok", version: config.version }));

  // Readiness, which is a different question: can drigodb actually do its job
  // on THIS cluster. See src/k8s/preflight.ts — both things it checks fail
  // silently, and this is what stops a broken installation looking green.
  //
  // 503 rather than 500: the pod is fine, the cluster is not ready for it.
  const preflight = new PreflightCache(kc.makeApiClient(ApisApi), kc.makeApiClient(StorageV1Api));
  app.get("/readyz", async (c) => {
    const result = await preflight.get();
    return c.json(result, result.ready ? 200 : 503);
  });

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
    console.log(`[drigodb] storage class  ${config.storageClass || "cluster default"}`);
    console.log(`[drigodb] tiers         default ${config.defaultTier}, up to ${config.maxTier}`);

    // Once at boot, so the reason is in the logs before anyone goes looking for
    // it. The readiness probe keeps asking after this.
    void preflight.get().then(logPreflight);
  });
}

main();
