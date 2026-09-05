// AWS Signature Version 4, for GET requests with query parameters.
//
// Written rather than depended on. @aws-sdk/client-s3 is a large tree for the
// one ListObjectsV2 call drigodb makes, against an endpoint that has to stay
// configurable for DigitalOcean Spaces and MinIO alike — and this repo has
// three runtime dependencies, each load-bearing.
//
// A GET with no body is the simplest case the algorithm has: the payload hash
// is the SHA-256 of the empty string, which is a constant. The risk is not
// complexity, it is that a signature bug fails opaquely — the server answers
// 403 SignatureDoesNotMatch and says nothing about which of the canonical
// request, the string to sign, or the key derivation was wrong. So this is
// covered by AWS's own published test vectors rather than by whether it
// happened to work against one bucket.
//
// Spec: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv4-signing-elements.html

import { createHash, createHmac } from "node:crypto";

// SHA-256 of the empty string. Every request signed here has no body.
export const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const sha256Hex = (v: string): string => createHash("sha256").update(v, "utf8").digest("hex");
const hmac = (key: Buffer | string, v: string): Buffer =>
  createHmac("sha256", key).update(v, "utf8").digest();

// RFC 3986 unreserved characters stay literal; everything else is percent-
// encoded uppercase. encodeURIComponent leaves !'()* alone and AWS does not, so
// those are escaped afterwards. The forward slash in a path segment is encoded
// too — canonical URIs here are built from already-split segments.
export function uriEncode(value: string, encodeSlash = true): string {
  const escaped = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return encodeSlash ? escaped : escaped.replace(/%2F/g, "/");
}

// yyyymmddThhmmssZ, which is ISO-8601 with the separators removed. Derived from
// the timestamp rather than taken separately so the date and the datetime in a
// signature can never disagree across a midnight boundary.
export function amzDate(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export interface SignInput {
  method: string;
  host: string;
  /** Already-decoded path, e.g. "/my-bucket". Encoded here, slashes preserved. */
  path: string;
  /** Query parameters, unencoded. Sorted and encoded here. */
  query: Record<string, string>;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
  payloadSha256?: string;
  /**
   * Headers to sign beyond `host` and `x-amz-date`. S3 requires
   * `x-amz-content-sha256`; the published AWS test vectors do not use it, which
   * is why this is a parameter rather than baked in — a signer that cannot
   * reproduce the vectors cannot be shown to be correct.
   */
  extraSignedHeaders?: Record<string, string>;
}

/** Returns the headers to send, including Authorization. */
export function signRequest(input: SignInput): Record<string, string> {
  const payloadHash = input.payloadSha256 ?? EMPTY_PAYLOAD_SHA256;
  const { amzDate: stamp, dateStamp } = amzDate(input.now);

  // Canonical query string: encoded, then sorted by encoded key. Sorting after
  // encoding matters — the byte order of the encoded form is what the server
  // compares against, and it differs from the raw order for anything escaped.
  const canonicalQuery = Object.entries(input.query)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  // Only the headers that are signed, lowercased and in order. The payload hash
  // goes into the canonical request either way; whether it is ALSO a signed
  // header is the caller's business, because S3 requires it and the generic
  // vectors do not.
  const headers: Record<string, string> = {
    host: input.host,
    "x-amz-date": stamp,
    ...(input.extraSignedHeaders ?? {}),
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.entries(headers)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([h, v]) => `${h}:${v.trim()}\n`)
    .join("");

  const canonicalRequest = [
    input.method,
    uriEncode(input.path, false),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    stamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  // The signing key is derived by chaining HMACs down the scope, so a key is
  // only ever valid for one date, region and service.
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), input.service),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
