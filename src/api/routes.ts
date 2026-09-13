// HTTP surface. Nine operations, designed against one real consumer.

import { Hono } from "hono";

import {
  NotFoundError,
  ResizeRefusedError,
  Provisioner,
  DeletionInFlightError,
  NotConfiguredError,
  validateHighAvailability,
  validateHighAvailabilityChange,
  validateRestoreFrom,
  validateRestoreInPlace,
  ValidationError,
  validateExternalId,
  validateTier,
} from "../k8s/provisioner.js";
import type { Tier } from "../k8s/manifests.js";

export function buildRoutes(provisioner: Provisioner): Hono {
  const app = new Hono();


  // `restore_from` makes this a provision with a source rather than a separate
  // verb: a restored database is a NEW database, with a new id, its own volume
  // and its own credentials. The one it was restored from is untouched, which
  // is what makes this the safe shape — an undo that cannot damage the thing
  // being undone.
  //
  // `target_time` recovers to an instant rather than to a backup (#19). WAL has
  // been archived for every database since backups shipped, so this asks for
  // something drigodb was already paying to keep and could not previously
  // offer. Which instant is the caller's decision, which is the whole of
  // drigodb's part in it (decision 0008).
  app.post("/v1/databases", async (c) => {
    let externalId: string;
    let restoreFrom: { databaseId: string; backupId?: string; targetTime?: string } | undefined;
    let highAvailability = false;
    try {
      const body = await c.req.json().catch(() => ({}));
      externalId = validateExternalId((body as { external_id?: unknown }).external_id);
      restoreFrom = validateRestoreFrom((body as { restore_from?: unknown }).restore_from);
      highAvailability = validateHighAvailability(
        (body as { high_availability?: unknown }).high_availability,
      );
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }

    // Only on the request that creates the database. A repeat returns what
    // exists, `high_availability` included, and does not act on the flag —
    // adding a standby to a live database is a different operation with its own
    // failure modes, and it is deliberately not built (#81). A caller that gets
    // a 200 should read the field rather than assume the request took effect.
    const { database, uri, created } = await provisioner.create(
      externalId,
      restoreFrom,
      highAvailability,
    );
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


  // Take a backup now. 202, because the operator does the work — this returns
  // once the request exists, which is the only thing that has actually happened.
  // Adding a standby to a database that already exists, or removing one.
  //
  // The decision to want high availability usually arrives after the database
  // does — an application gets real users, and by then its database exists
  // (#110). Both directions, because removing a standby destroys only the
  // standby's volume: the primary holds everything, so nothing is lost, and a
  // caller who could turn it on but not off would rightly ask why.
  app.post("/v1/databases/:id/high-availability", async (c) => {
    let enabled: boolean;
    try {
      enabled = validateHighAvailabilityChange(await c.req.json().catch(() => null));
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
    // 202: turning it ON clones the standby from the live primary, which takes as
    // long as a base backup of the database. Poll `standby` — it reads
    // `provisioning` for the duration, which is the whole reason that value
    // exists.
    return c.json(await provisioner.setHighAvailability(c.req.param("id"), enabled), 202);
  });

  // Restoring OVER a database, keeping its id and its URI.
  //
  // The destructive twin of `restore_from` on create, which makes a new database
  // and leaves the source alone. This one discards everything written since the
  // target and cannot be undone — see docs/restore-in-place.md, and note that
  // drigodb takes no safety backup: a caller who wants one calls POST /backups
  // first (decision 0008).
  app.post("/v1/databases/:id/restore", async (c) => {
    const id = c.req.param("id");
    let target: { backupId?: string; targetTime?: string };
    try {
      const body = await c.req.json().catch(() => null);
      target = validateRestoreInPlace(id, body);
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
    // 202: the database is down for as long as the recovery takes, which is
    // minutes rather than the seconds a wake takes. A caller polls status.
    return c.json(await provisioner.restoreInPlace(id, target), 202);
  });

  app.post("/v1/databases/:id/backups", async (c) =>
    c.json(await provisioner.createBackup(c.req.param("id")), 202),
  );

  // What can be restored. Never a credential, and an empty list for a database
  // that has never been backed up — an answer rather than an error.
  //
  // Answers for a hibernated database too, which is the point: that is when the
  // question gets asked, and when there is no pod to ask. drigodb reads the
  // operator's Backup objects, so it needs neither the pod nor the bucket.
  app.get("/v1/databases/:id/backups", async (c) =>
    c.json({ backups: await provisioner.listBackups(c.req.param("id")) }),
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
