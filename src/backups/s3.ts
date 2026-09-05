// The one S3 operation drigodb makes from the control plane: list a database's
// backups. No SDK — see src/backups/sigv4.ts for why.

import { EMPTY_PAYLOAD_SHA256, signRequest } from "./sigv4.js";

export interface BackupObject {
  key: string;
  size: number;
  lastModified: string;
}

export interface ListInput {
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * DigitalOcean Spaces puts the region in the hostname (fra1.digitaloceanspaces.com)
 * and MinIO does not have one at all. SigV4 needs *a* region string and the
 * server compares it against what it expects, so guessing wrong fails the
 * signature rather than being ignored. Pulling it out of the endpoint gets
 * Spaces right; us-east-1 is what MinIO and most S3-compatible servers accept
 * as the default.
 */
export function regionFromEndpoint(endpoint: string): string {
  try {
    const host = new URL(endpoint).hostname;
    const m = /^(?:.+\.)?([a-z]{2,4}\d)\.digitaloceanspaces\.com$/.exec(host);
    if (m?.[1]) return m[1];
  } catch {
    // A malformed endpoint is the caller's problem; the request will fail
    // loudly on its own rather than being masked by a thrown URL error here.
  }
  return "us-east-1";
}

// Extracts <Key>, <Size> and <LastModified> from each <Contents> element.
//
// Regex rather than an XML dependency: the shape is one well-specified response
// from one API, and adding a parser for it would be a bigger commitment than the
// signer. The narrowness is the safety — anything that does not match this exact
// shape yields no entries rather than a wrong one, and the integration test runs
// it against a real MinIO response instead of a hand-written string.
export function parseListResponse(xml: string): { objects: BackupObject[]; nextToken?: string } {
  const objects: BackupObject[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1] ?? "";
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(block)?.[1];
    const modified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1];
    if (key && size !== undefined && modified) {
      objects.push({ key, size: Number(size), lastModified: modified });
    }
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const nextToken = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { objects, nextToken: truncated ? nextToken : undefined };
}

export class BackupStorageError extends Error {}

/**
 * Every object under `prefix`, following continuation tokens.
 *
 * Path-style addressing (`https://endpoint/bucket?...`) rather than virtual
 * host style, which is what the sidecar's rclone already uses: MinIO needs it
 * and Spaces tolerates it, so one code path serves both.
 */
export async function listObjects(input: ListInput): Promise<BackupObject[]> {
  const doFetch = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const url = new URL(input.endpoint);
  const all: BackupObject[] = [];
  let token: string | undefined;

  // Bounded rather than `while (true)`: a server that kept returning a
  // continuation token would otherwise hang the request forever. 100 pages is
  // 100,000 objects, far past anything a per-database prefix should hold.
  for (let page = 0; page < 100; page++) {
    const query: Record<string, string> = {
      "list-type": "2",
      prefix: input.prefix,
      "max-keys": "1000",
    };
    if (token) query["continuation-token"] = token;

    const path = `/${input.bucket}`;
    const headers = signRequest({
      method: "GET",
      host: url.host,
      path,
      query,
      region: input.region,
      service: "s3",
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      now: now(),
      extraSignedHeaders: { "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256 },
    });

    const qs = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const res = await doFetch(`${url.origin}${path}?${qs}`, { method: "GET", headers });

    if (!res.ok) {
      // The body carries S3's own error code, which is the only useful thing
      // about a 403 here — SignatureDoesNotMatch and AccessDenied mean very
      // different things and neither is visible from the status alone.
      const body = await res.text().catch(() => "");
      const code = /<Code>([\s\S]*?)<\/Code>/.exec(body)?.[1] ?? `HTTP ${res.status}`;
      throw new BackupStorageError(`listing backups failed: ${code}`);
    }

    const { objects, nextToken } = parseListResponse(await res.text());
    all.push(...objects);
    if (!nextToken) return all;
    token = nextToken;
  }
  throw new BackupStorageError("listing backups did not terminate after 100 pages");
}
