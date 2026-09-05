// Known-answer tests for the SigV4 signer.
//
// A signature bug fails opaquely — the server answers 403 SignatureDoesNotMatch
// and says nothing about whether the canonical request, the string to sign or
// the key derivation was wrong. "It worked against one bucket once" is not
// evidence, so these are AWS's own published vectors and the exact request
// drigodb actually sends.

import { describe, expect, it } from "vitest";

import { EMPTY_PAYLOAD_SHA256, amzDate, signRequest, uriEncode } from "../src/backups/sigv4.js";

describe("sigv4 primitives", () => {
  it("hashes the empty payload to the documented constant", () => {
    // Every request this signs has no body, so this value is in every signature.
    expect(EMPTY_PAYLOAD_SHA256).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("derives both timestamps from one instant", () => {
    // Taken separately they could disagree across a midnight boundary, which
    // produces a signature that is individually well-formed and still rejected.
    const { amzDate: d, dateStamp } = amzDate(new Date("2026-09-05T23:59:59.999Z"));
    expect(d).toBe("20260905T235959Z");
    expect(dateStamp).toBe("20260905");
    expect(d.startsWith(dateStamp)).toBe(true);
  });

  it("percent-encodes what encodeURIComponent leaves alone", () => {
    // !'()* are unreserved to encodeURIComponent and reserved to AWS.
    expect(uriEncode("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
    expect(uriEncode("a/b")).toBe("a%2Fb");
    expect(uriEncode("/my-bucket", false)).toBe("/my-bucket");
    expect(uriEncode("a b")).toBe("a%20b");
  });
});

describe("sigv4 known-answer vector", () => {
  // AWS SigV4 test suite, `get-vanilla-query-order-key-case`: a GET with two
  // query parameters, the canonical example for the case drigodb uses.
  const VECTOR = {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "service",
    host: "example.amazonaws.com",
    now: new Date("2015-08-30T12:36:00Z"),
  };

  it("reproduces the published signature exactly", () => {
    // This is the assertion that makes the rest of this file mean anything: the
    // exact bytes AWS say a correct implementation produces for this request.
    const headers = signRequest({
      method: "GET",
      host: VECTOR.host,
      path: "/",
      query: { Param2: "value2", Param1: "value1" },
      region: VECTOR.region,
      service: VECTOR.service,
      accessKeyId: VECTOR.accessKeyId,
      secretAccessKey: VECTOR.secretAccessKey,
      now: VECTOR.now,
    });

    expect(headers["x-amz-date"]).toBe("20150830T123600Z");
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });

  it("signs x-amz-content-sha256 when S3 asks for it", () => {
    const headers = signRequest({
      method: "GET",
      host: VECTOR.host,
      path: "/",
      query: {},
      region: VECTOR.region,
      service: "s3",
      accessKeyId: VECTOR.accessKeyId,
      secretAccessKey: VECTOR.secretAccessKey,
      now: VECTOR.now,
      extraSignedHeaders: { "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256 },
    });
    expect(headers.authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
    expect(headers["x-amz-content-sha256"]).toBe(EMPTY_PAYLOAD_SHA256);
  });

  it("sorts query parameters by their ENCODED form, not the order given", () => {
    // The server rebuilds the canonical query from what it received, so the two
    // orderings must sign identically or every other request fails at random.
    const base = {
      method: "GET",
      host: VECTOR.host,
      path: "/",
      region: VECTOR.region,
      service: VECTOR.service,
      accessKeyId: VECTOR.accessKeyId,
      secretAccessKey: VECTOR.secretAccessKey,
      now: VECTOR.now,
    };
    const a = signRequest({ ...base, query: { Param1: "value1", Param2: "value2" } });
    const b = signRequest({ ...base, query: { Param2: "value2", Param1: "value1" } });
    expect(a.authorization).toBe(b.authorization);
  });

  it("changes the signature when anything signed changes", () => {
    const base = {
      method: "GET",
      host: VECTOR.host,
      path: "/",
      query: { a: "1" },
      region: VECTOR.region,
      service: VECTOR.service,
      accessKeyId: VECTOR.accessKeyId,
      secretAccessKey: VECTOR.secretAccessKey,
      now: VECTOR.now,
    };
    const sig = (o: Partial<typeof base>) => signRequest({ ...base, ...o }).authorization;
    const original = sig({});
    expect(sig({ path: "/other" })).not.toBe(original);
    expect(sig({ query: { a: "2" } })).not.toBe(original);
    expect(sig({ host: "elsewhere.example.com" })).not.toBe(original);
    expect(sig({ region: "eu-west-1" })).not.toBe(original);
    expect(sig({ now: new Date("2015-08-31T12:36:00Z") })).not.toBe(original);
  });

  it("derives a key that is scoped to one date, region and service", () => {
    // The chained HMAC is what makes a leaked signing key useless tomorrow.
    // Same secret, different scope, different signature.
    const base = {
      method: "GET",
      host: VECTOR.host,
      path: "/",
      query: {},
      accessKeyId: VECTOR.accessKeyId,
      secretAccessKey: VECTOR.secretAccessKey,
      now: VECTOR.now,
      region: VECTOR.region,
      service: VECTOR.service,
    };
    const sigOf = (h: Record<string, string>) => h.authorization?.split("Signature=")[1] ?? "";
    const a = sigOf(signRequest(base));
    const b = sigOf(signRequest({ ...base, service: "s3" }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
