import { serve } from "@hono/node-server";
import { CoreV1Api, CustomObjectsApi, KubeConfig, StorageV1Api } from "@kubernetes/client-node";
import { Hono } from "hono";

import { buildRoutes } from "./api/routes.js";
import { buildTokenRoutes } from "./api/tokens.js";
import { TokenStore } from "./auth.js";
import type { Caller } from "./auth.js";
import { bootstrapToken, config } from "./config.js";
import { PreflightCache, logPreflight } from "./k8s/preflight.js";
import { Provisioner } from "./k8s/provisioner.js";

type Env = { Variables: { caller: Caller } };

function main(): void {
  // Optional now, where it used to be required at boot.
  //
  // It is the BOOTSTRAP credential rather than the credential: an admin token whose
  // job is to mint the ones consumers actually use (#62). An installation may run
  // without it once it has issued its own, and the chart still requires one, so
  // nothing that installs drigodb today changes.
  //
  // Not a startup failure any more, because "there is at least one usable token"
  // cannot be answered at boot — a token Secret can be created a minute later, and
  // refusing to start would make that impossible to do.
  const bootstrap = bootstrapToken();

  const kc = new KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
  else kc.loadFromDefault();

  const app = new Hono<Env>();

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
  const preflight = new PreflightCache(kc.makeApiClient(CustomObjectsApi), kc.makeApiClient(StorageV1Api));
  app.get("/readyz", async (c) => {
    const result = await preflight.get();
    return c.json(result, result.ready ? 200 : 503);
  });

  // Every /v1 request resolves to a CALLER now, not to a yes/no on one string.
  // src/auth.ts has the storage and the five-second revocation window.
  const tokens = new TokenStore(kc.makeApiClient(CoreV1Api), bootstrap);
  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    const caller = await tokens.callerFor(provided);
    // The same answer for a wrong token, an expired one, a revoked one and none at
    // all. Which of those it was is the caller's business to work out, not
    // drigodb's to narrate.
    if (!caller) return c.json({ error: "unauthorized" }, 401);
    c.set("caller", caller);
    await next();
  });

  app.route("/", buildTokenRoutes(tokens));
  app.route("/", buildRoutes(Provisioner.fromCluster()));

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[drigodb] listening on :${info.port}`);
    console.log(`[drigodb] provisioning into namespace ${config.databaseNamespace}`);
    console.log(`[drigodb] postgres image ${config.pgImage}`);
    console.log(`[drigodb] storage class  ${config.storageClass || "cluster default"}`);
    console.log(`[drigodb] tiers         default ${config.defaultTier}, up to ${config.maxTier}`);
    // Loud, because an installation with no bootstrap token and no issued tokens
    // answers 401 to everything and looks broken rather than locked.
    if (bootstrap) {
      console.log("[drigodb] auth          bootstrap admin token set, plus any issued tokens");
    } else {
      console.warn(
        "[drigodb] auth          NO bootstrap token. Only tokens already issued will work — " +
          "if none exist, every /v1 request answers 401 until a token Secret is created",
      );
    }

    // Once at boot, so the reason is in the logs before anyone goes looking for
    // it. The readiness probe keeps asking after this.
    void preflight.get().then(logPreflight);
  });
}

main();
