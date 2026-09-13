// The token endpoints. Admin only, all three of them.
//
// A consumer that could issue itself a token could issue itself an admin one, and
// the tier split would mean nothing (#62). So the gate is here rather than
// anywhere a caller can reach.

import { Hono } from "hono";

import { BOOTSTRAP_TOKEN_ID, TokenError, TokenStore, validateTokenRequest } from "../auth.js";
import type { Caller } from "../auth.js";

// Set by the authentication middleware in src/server.ts. Typed here because this
// is the only router that reads it; #72 will make it every router's business.
type Env = { Variables: { caller: Caller } };

export function buildTokenRoutes(store: TokenStore): Hono<Env> {
  // basePath, and the admin gate below is the reason.
  //
  // Written first as `new Hono()` with `app.use("*", adminOnly)` and mounted at "/",
  // where `*` matches every path in the whole application — so a tenant token got
  // 403 from `GET /v1/databases`. Caught by smoke.sh on a cluster, which is the only
  // place it was visible: every unit test passed, because nothing assembled the two
  // routers together.
  //
  // Two other spellings, measured rather than assumed, because I guessed wrong about
  // one of them and wrote the guess down:
  //
  //   use("/v1/tokens/*")  gates /v1/tokens AND /v1/tokens/{id}, and nothing else.
  //                        Safe — Hono matches the bare path too, which is not what
  //                        the trailing /* suggests.
  //   use("/v1/tokens")    gates the collection ONLY. DELETE /v1/tokens/{id} is wide
  //                        open, so any tenant token can revoke any token including
  //                        every admin one. This is the spelling to fear.
  //
  // A basePath is preferred over the safe one of those because the wildcard cannot
  // reach outside the subtree by construction rather than by a routing detail, and
  // because there is no path pattern to keep in step with the handlers below.
  const app = new Hono<Env>().basePath("/v1/tokens");

  // 403, not 404, and this is the one place that is right.
  //
  // Elsewhere #72 will use 404 so one tenant cannot learn another's ids. Here
  // there is no id space to protect and the caller is asking about the
  // installation's own administration: telling a tenant token "you may not" is
  // the useful answer, and pretending the endpoint does not exist would send
  // someone hunting for a version of drigodb that has it.
  app.use("*", async (c, next) => {
    if (c.get("caller").tier !== "admin") {
      return c.json({ error: "issuing and revoking tokens requires an admin token" }, 403);
    }
    await next();
  });

  // The token is in this response and nowhere else, ever again. Same contract as
  // `connection_uri`, for the same reason — drigodb stores a hash, so it could not
  // show it to you a second time even if it wanted to.
  app.post("/", async (c) => {
    let req: { name: string; tier: "admin" | "tenant"; expiresIn?: number };
    try {
      req = validateTokenRequest(await c.req.json().catch(() => null));
    } catch (err) {
      if (err instanceof TokenError) return c.json({ error: err.message }, 400);
      throw err;
    }
    const { record, token } = await store.issue(req.name, req.tier, req.expiresIn);
    return c.json({ ...record, token }, 201);
  });

  // Metadata only. There is no endpoint that returns a token value, including
  // this one, including for the caller's own token.
  app.get("/", async (c) => c.json({ tokens: await store.list() }));

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    // Revoking the credential you are presenting is allowed. It is a legitimate
    // thing to want — it is how a leaked token is dealt with by whoever leaked it
    // — and refusing would mean the only way out is kubectl.
    if (id === BOOTSTRAP_TOKEN_ID) {
      return c.json(
        {
          error:
            "the bootstrap token is not drigodb's to revoke — it is the installation's. " +
            "Remove it from the deployment's environment, or delete the Secret the chart reads it from",
        },
        409,
      );
    }
    try {
      await store.revoke(id);
    } catch (err) {
      const code = (err as { code?: number })?.code;
      // A token that is already gone is the state the caller asked for.
      if (code !== 404) throw err;
    }
    return c.body(null, 204);
  });

  return app;
}
