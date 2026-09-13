// Who is calling, and whether they may.
//
// drigodb had ONE bearer token for an entire installation: a static string in an
// environment variable, with no identity, no expiry, no revocation and no way to
// rotate without an outage (#62). That was fine while there was one consumer and
// the token came from a shell script. It stops being fine the moment drigodb is
// something other people install, which decision 0002 commits to.
//
// A token is now a Kubernetes Secret, the way a hosted database is a Cluster.
// There is still no control-plane database.
//
// WHAT IS STORED IS A HASH, NEVER THE TOKEN. The raw value is returned exactly
// once, by the request that creates it, and is then unrecoverable — the same
// contract `connection_uri` already has, for the same reason. It matters more
// here than it looks: drigodb can already list Secrets in the database namespace,
// so a token stored raw would mean anything able to read one Secret holds every
// credential to the control plane rather than one.
//
// The Secrets live in the DATABASE namespace, beside the per-database password
// Secrets, and that is deliberate. The API's Role is namespaced there and grants
// secrets already, so this adds no grant and no reach: the invariant that drigodb
// cannot read a Secret anywhere else in the cluster survives untouched. Putting
// control-plane auth material in the database namespace is the trade, and a
// SHA-256 hash is not a credential, so what lands there is not reachable material.

import { createHash, randomBytes } from "node:crypto";
import type { CoreV1Api, V1Secret } from "@kubernetes/client-node";

import { config } from "./config.js";

export const TOKEN_ID_LABEL = "drigodb.io/token-id";
export const TOKEN_TIER_LABEL = "drigodb.io/token-tier";
export const TOKEN_NAME_ANNOTATION = "drigodb.io/token-name";
// Whose databases this token may reach (#72). Usually the token's own id, which is
// what makes "a database belongs to the token that created it" the default.
export const TOKEN_OWNER_LABEL = "drigodb.io/owner";
export const TOKEN_EXPIRES_ANNOTATION = "drigodb.io/token-expires-at";
export const HASH_SECRET_KEY = "hash";

// Two tiers, which is the smallest split that works: someone has to be able to
// issue tokens, and a consumer must not be able to issue itself more. Anything
// richer — read-only tokens, per-database grants, roles — is a real feature and
// genuinely a later one (#72 builds ownership on top of this).
export type Tier = "admin" | "tenant";

// The id of the caller the static environment token authenticates as.
//
// Not a Secret and not revocable through the API, because drigodb did not create
// it — whoever installed drigodb did. It is the only pre-existing trust there is,
// and its whole job is to mint the tokens that replace it.
export const BOOTSTRAP_TOKEN_ID = "bootstrap";

// `ddb_` so a leaked token is recognisable as one. Secret scanners match on
// prefixes, and a 64-character hex string with no prefix looks like a hash, a
// commit, or nothing at all — which is how a credential ends up in a repository
// and stays there.
const TOKEN_PREFIX = "ddb_";

export interface Caller {
  id: string;
  name: string;
  tier: Tier;
  // The identity that OWNS databases, which is not always the token's own id.
  //
  // #72 says "a database belongs to the token that created it", and that is the
  // default: a token issued with no owner owns as itself. But #72 was written before
  // #62 gave tokens an expiry, and the two together are a trap — a consumer whose
  // token expires gets a new token with a new id, and every database it owned becomes
  // unreachable by the only name it knows.
  //
  // So an owner is a thing a token CARRIES rather than a thing a token IS, and a
  // rotation is: issue a new token naming the retiring one's owner. One optional
  // field, and the failure mode it removes is a consumer losing its fleet by doing
  // the responsible thing with its credential.
  owner: string;
}

export interface TokenRecord {
  id: string;
  name: string;
  tier: Tier;
  owner: string;
  created_at?: string;
  expires_at?: string;
  // True for the static environment token. Reported so an operator can see that
  // an unrevocable credential exists, which is a fact worth surfacing rather
  // than hiding: it is the one token no API call can take away.
  bootstrap?: boolean;
}

export class TokenError extends Error {}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function newToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

export function tokenSecretName(id: string): string {
  // Not db-<id>-credentials, which is a database's password Secret in the same
  // namespace. Distinct prefixes AND a distinct label, so neither listing can
  // ever pick up the other's objects.
  return `token-${id}`;
}

export function newTokenId(): string {
  return randomBytes(8).toString("hex");
}

export function buildTokenSecret(
  id: string,
  name: string,
  tier: Tier,
  owner: string,
  hash: string,
  createdAt: Date,
  expiresAt?: Date,
): V1Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: tokenSecretName(id),
      namespace: config.databaseNamespace,
      labels: {
        [TOKEN_ID_LABEL]: id,
        [TOKEN_TIER_LABEL]: tier,
        // A LABEL, not an annotation, because revoking a token has to ask "does any
        // other token still carry this owner" — and that is a selector.
        [TOKEN_OWNER_LABEL]: owner,
        "app.kubernetes.io/managed-by": "drigodb",
      },
      annotations: {
        [TOKEN_NAME_ANNOTATION]: name,
        ...(expiresAt ? { [TOKEN_EXPIRES_ANNOTATION]: expiresAt.toISOString() } : {}),
      },
      // Kubernetes sets creationTimestamp itself, so created_at is read from the
      // object rather than written into it. One less field that can disagree with
      // the thing it describes.
    },
    type: "Opaque",
    stringData: { [HASH_SECRET_KEY]: hash },
  };
}

function recordOf(secret: V1Secret): { record: TokenRecord; hash: string } | undefined {
  const id = secret.metadata?.labels?.[TOKEN_ID_LABEL];
  const raw = secret.data?.[HASH_SECRET_KEY];
  if (!id || !raw) return undefined;
  const tier = secret.metadata?.labels?.[TOKEN_TIER_LABEL] === "admin" ? "admin" : "tenant";
  return {
    hash: Buffer.from(raw, "base64").toString("utf8").trim(),
    record: {
      id,
      name: secret.metadata?.annotations?.[TOKEN_NAME_ANNOTATION] ?? id,
      tier,
      // Falls back to the token's own id, which is what a token issued before this
      // existed means — and what a token issued without an owner means now.
      owner: secret.metadata?.labels?.[TOKEN_OWNER_LABEL] ?? id,
      ...(secret.metadata?.creationTimestamp
        ? { created_at: new Date(secret.metadata.creationTimestamp).toISOString() }
        : {}),
      ...(secret.metadata?.annotations?.[TOKEN_EXPIRES_ANNOTATION]
        ? { expires_at: secret.metadata.annotations[TOKEN_EXPIRES_ANNOTATION] }
        : {}),
    },
  };
}

export class TokenStore {
  private cached?: { at: number; byHash: Map<string, TokenRecord> };
  private readonly bootstrapHash?: string;

  constructor(
    private readonly core: CoreV1Api,
    bootstrapToken: string | undefined,
    // Five seconds, which is how long a revoked token keeps working.
    //
    // A deliberate trade, and the number is the whole of it. The alternative to a
    // cache is an API call per request, which makes every authenticated call
    // depend on the API server being reachable — an availability problem waiting
    // for a bad afternoon. The alternative to a TTL is a watch, which revokes
    // instantly and silently stops updating when it dies; an auth path that has
    // quietly stopped learning about revocations is worse than one with a window
    // this short and written down.
    private readonly ttlMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {
    this.bootstrapHash = bootstrapToken ? hashToken(bootstrapToken) : undefined;
  }

  private async load(): Promise<Map<string, TokenRecord>> {
    const fresh = this.cached && this.now() - this.cached.at < this.ttlMs;
    if (fresh && this.cached) return this.cached.byHash;

    const byHash = new Map<string, TokenRecord>();
    // The bootstrap token first, so a token Secret cannot shadow it even if one
    // somehow carried the same hash.
    if (this.bootstrapHash) {
      byHash.set(this.bootstrapHash, {
        id: BOOTSTRAP_TOKEN_ID,
        name: "installation bootstrap token",
        tier: "admin",
        // The historical owner. Every database that existed before #72 was created by
        // this token, under an id derived from external_id alone — so making the
        // bootstrap owner the unsalted id space is not a special case invented for
        // convenience, it is the record of who actually made them.
        owner: BOOTSTRAP_TOKEN_ID,
        bootstrap: true,
      });
    }
    const list = await this.core.listNamespacedSecret({
      namespace: config.databaseNamespace,
      // The label, not a name prefix. A prefix match would be a guess about what
      // else lives in this namespace; the label is drigodb's own statement.
      labelSelector: TOKEN_ID_LABEL,
    });
    for (const secret of list.items ?? []) {
      const parsed = recordOf(secret);
      if (parsed) byHash.set(parsed.hash, parsed.record);
    }
    this.cached = { at: this.now(), byHash };
    return byHash;
  }

  // Whoever is calling, or undefined. Never throws on a bad token: a caller with
  // the wrong credential and a caller with none get the same answer.
  async callerFor(presented: string): Promise<Caller | undefined> {
    if (!presented) return undefined;
    const hash = hashToken(presented);
    const byHash = await this.load();
    // A lookup keyed on a SHA-256 digest, which is why there is no constant-time
    // comparison here and does not need to be one.
    //
    // #62 asked for `timingSafeEqual`, and the middleware this replaces did carry a
    // comment promising it over a raw `!==`. The fix is not to make that comparison
    // constant-time — it is that the comparison is gone. Nothing compares a secret
    // to a secret any more: the presented value is hashed first, and timing the map
    // lookup can at best reveal something about sha256(token), which is not a
    // credential. Authenticating still requires a preimage.
    //
    // The old length check went with it, and it deserves a note of its own: it was
    // justified as protecting nothing important, while comparing lengths first is
    // itself the disclosure it was worried about. Digests are all the same length.
    const record = byHash.get(hash);
    if (!record) return undefined;
    if (record.expires_at && Date.parse(record.expires_at) <= this.now()) return undefined;
    return { id: record.id, name: record.name, tier: record.tier, owner: record.owner };
  }

  // Forget the cache. Called after issuing or revoking, so the caller's own
  // change is visible to them immediately rather than in up to five seconds —
  // the window is for revocations made elsewhere, not for a round trip a caller
  // just completed.
  invalidate(): void {
    this.cached = undefined;
  }

  async list(): Promise<TokenRecord[]> {
    const byHash = await this.load();
    return [...byHash.values()].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  }

  async issue(
    name: string,
    tier: Tier,
    owner?: string,
    expiresIn?: number,
  ): Promise<{ record: TokenRecord; token: string }> {
    const id = newTokenId();
    const token = newToken();
    // Its own id unless told otherwise, which is #72's model as the default.
    const ownerId = owner ?? id;
    const createdAt = new Date(this.now());
    const expiresAt = expiresIn ? new Date(this.now() + expiresIn * 1000) : undefined;
    await this.core.createNamespacedSecret({
      namespace: config.databaseNamespace,
      body: buildTokenSecret(id, name, tier, ownerId, hashToken(token), createdAt, expiresAt),
    });
    this.invalidate();
    return {
      token,
      record: {
        id,
        name,
        tier,
        owner: ownerId,
        created_at: createdAt.toISOString(),
        ...(expiresAt ? { expires_at: expiresAt.toISOString() } : {}),
      },
    };
  }

  // Is there still a token carrying this owner, other than the one being revoked?
  //
  // Asked so revocation can say what it orphaned rather than leaving an operator to
  // find out. With two tokens sharing an owner — which is how a rotation works —
  // revoking one orphans nothing.
  async ownerStillReachable(owner: string, excludingTokenId: string): Promise<boolean> {
    if (this.bootstrapHash && owner === BOOTSTRAP_TOKEN_ID) return true;
    const list = await this.core.listNamespacedSecret({
      namespace: config.databaseNamespace,
      // And the token-id label, so this cannot match a database's password Secret:
      // those live in the same namespace and OWNER_LABEL is the same key on both.
      labelSelector: `${TOKEN_OWNER_LABEL}=${owner},${TOKEN_ID_LABEL}`,
    });
    return (list.items ?? []).some(
      (s) => s.metadata?.labels?.[TOKEN_ID_LABEL] !== excludingTokenId,
    );
  }

  async recordFor(id: string): Promise<TokenRecord | undefined> {
    return (await this.list()).find((t) => t.id === id);
  }

  async revoke(id: string): Promise<void> {
    if (id === BOOTSTRAP_TOKEN_ID) {
      throw new TokenError(
        "the bootstrap token is not drigodb's to revoke — it is the installation's. " +
          "Remove it from the deployment's environment, or delete the Secret the chart reads it from",
      );
    }
    await this.core.deleteNamespacedSecret({
      name: tokenSecretName(id),
      namespace: config.databaseNamespace,
    });
    this.invalidate();
  }
}

// What `POST /v1/tokens` is allowed to say.
const NAME_RE = /^[A-Za-z0-9]([-A-Za-z0-9_. ]{0,61}[A-Za-z0-9])?$/;
// A token id, or the bootstrap owner. Constrained because this value becomes a label
// value and a salt for a derived database id, and neither is a place for free text.
const OWNER_RE = /^([0-9a-f]{16}|bootstrap)$/;
// A year. Not a policy about how long a token should live — a bound on a number
// that goes into a date, so a typo'd expires_in cannot mint something that
// outlives the installation.
const MAX_EXPIRES_IN = 366 * 24 * 60 * 60;

export function validateTokenRequest(value: unknown): {
  name: string;
  tier: Tier;
  owner?: string;
  expiresIn?: number;
} {
  if (value === null || typeof value !== "object") {
    throw new TokenError('a token needs a body: {"name": "what this is for"}');
  }
  const v = value as { name?: unknown; tier?: unknown; owner?: unknown; expires_in?: unknown };
  if (typeof v.name !== "string" || !NAME_RE.test(v.name)) {
    throw new TokenError(
      "name must be 1-63 characters of letters, digits, spaces, dot, dash or underscore. " +
        "It is the only thing that will tell one token from another later",
    );
  }
  if (v.tier !== undefined && v.tier !== "admin" && v.tier !== "tenant") {
    throw new TokenError('tier must be "admin" or "tenant"');
  }
  // Naming an existing owner is how a token is ROTATED without the databases moving.
  // Shaped like a token id because that is what an owner defaults to, and because a
  // free-form string here would end up in a label value and a bucket prefix.
  if (v.owner !== undefined && (typeof v.owner !== "string" || !OWNER_RE.test(v.owner))) {
    throw new TokenError(
      "owner must be a token id — 16 hex characters, or \"bootstrap\". Omit it and the " +
        "token owns as itself, which is what a new consumer wants; name the retiring " +
        "token's owner to rotate a credential without moving its databases",
    );
  }
  let expiresIn: number | undefined;
  if (v.expires_in !== undefined) {
    if (typeof v.expires_in !== "number" || !Number.isInteger(v.expires_in) || v.expires_in <= 0) {
      throw new TokenError("expires_in must be a positive whole number of seconds");
    }
    if (v.expires_in > MAX_EXPIRES_IN) {
      throw new TokenError(`expires_in must be at most ${MAX_EXPIRES_IN} seconds (a year)`);
    }
    expiresIn = v.expires_in;
  }
  // tenant by default. A caller that does not say has not asked for the power to
  // mint more tokens, and defaulting the other way would make every consumer an
  // administrator by omission.
  return {
    name: v.name,
    tier: (v.tier as Tier) ?? "tenant",
    ...(v.owner ? { owner: v.owner as string } : {}),
    ...(expiresIn ? { expiresIn } : {}),
  };
}
