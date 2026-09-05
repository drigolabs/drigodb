// Listing a database's backups.
//
// The XML fixtures below are REAL responses, captured from MinIO with objects
// seeded under two prefixes. A hand-written fixture would only prove the parser
// agrees with whoever wrote it — these prove it agrees with a server.

import { describe, expect, it, vi } from "vitest";

import { listObjects, parseListResponse, regionFromEndpoint } from "../src/backups/s3.js";

// Two backups for database a1b2c3. A third object exists in the bucket under
// a1b2c3d4/, and the server did not return it — which is the prefix isolation
// this depends on, since "a1b2c3" is a prefix of "a1b2c3d4".
const REAL_LIST = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>drigodb-test</Name><Prefix>a1b2c3/</Prefix><KeyCount>2</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated><Contents><Key>a1b2c3/20260901T040000Z.sql.gz</Key><LastModified>2026-09-05T09:56:50.724Z</LastModified><ETag>&#34;5362a0f51fd101f25030f1d14abd3993&#34;</ETag><Size>9</Size><StorageClass>STANDARD</StorageClass></Contents><Contents><Key>a1b2c3/20260905T040000Z.sql.gz</Key><LastModified>2026-09-05T09:56:50.738Z</LastModified><ETag>&#34;57e560dfec454ccb6c6412f7ae448f3a&#34;</ETag><Size>11</Size><StorageClass>STANDARD</StorageClass></Contents></ListBucketResult>`;

// The same listing with max-keys=1, so the server truncated it.
const REAL_TRUNCATED = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>drigodb-test</Name><Prefix>a1b2c3/</Prefix><NextContinuationToken>YTFiMmMzLzIwMjYwOTAxVDA0MDAwMFouc3FsLmd6W21pbmlvX2NhY2hlOnYyLHJldHVybjpd</NextContinuationToken><KeyCount>1</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>true</IsTruncated><Contents><Key>a1b2c3/20260901T040000Z.sql.gz</Key><LastModified>2026-09-05T09:56:50.724Z</LastModified><ETag>&#34;5362a0f51fd101f25030f1d14abd3993&#34;</ETag><Size>9</Size><StorageClass>STANDARD</StorageClass></Contents></ListBucketResult>`;

const EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>drigodb-test</Name><Prefix>never/</Prefix><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`;

const CREDS = {
  endpoint: "http://minio.example:9000",
  bucket: "drigodb-test",
  accessKeyId: "k",
  secretAccessKey: "s",
  region: "us-east-1",
};

const respond = (body: string, ok = true, status = 200) =>
  ({ ok, status, text: async () => body }) as Response;

describe("parsing a real listing", () => {
  it("extracts key, size and timestamp from every Contents element", () => {
    const { objects, nextToken } = parseListResponse(REAL_LIST);
    expect(objects).toEqual([
      { key: "a1b2c3/20260901T040000Z.sql.gz", size: 9, lastModified: "2026-09-05T09:56:50.724Z" },
      { key: "a1b2c3/20260905T040000Z.sql.gz", size: 11, lastModified: "2026-09-05T09:56:50.738Z" },
    ]);
    expect(nextToken).toBeUndefined();
  });

  it("returns one tenant's backups and not a tenant whose id extends it", () => {
    // The bucket also held a1b2c3d4/20260905T050000Z.sql.gz when this was
    // captured. It is absent because the request asked for "a1b2c3/" with the
    // trailing slash — without it, one tenant would list another's backups.
    const keys = parseListResponse(REAL_LIST).objects.map((o) => o.key);
    expect(keys.some((k) => k.startsWith("a1b2c3d4/"))).toBe(false);
  });

  it("reads the continuation token out of a truncated listing", () => {
    const { objects, nextToken } = parseListResponse(REAL_TRUNCATED);
    expect(objects).toHaveLength(1);
    expect(nextToken).toBe(
      "YTFiMmMzLzIwMjYwOTAxVDA0MDAwMFouc3FsLmd6W21pbmlvX2NhY2hlOnYyLHJldHVybjpd",
    );
  });

  it("treats an empty listing as an empty list, not an error", () => {
    // A database that has never been backed up is a fact, not a failure.
    expect(parseListResponse(EMPTY).objects).toEqual([]);
  });

  it("yields nothing rather than something wrong for an unrecognised body", () => {
    expect(parseListResponse("<html>502 Bad Gateway</html>").objects).toEqual([]);
  });
});

describe("listObjects", () => {
  it("follows the continuation token until the listing ends", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(respond(REAL_TRUNCATED))
      .mockResolvedValueOnce(respond(REAL_LIST));
    const objects = await listObjects({ ...CREDS, prefix: "a1b2c3/", fetchImpl: fetchImpl as never });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Page one carries no token; page two carries the one page one returned.
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain("continuation-token");
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("continuation-token=YTFiMmMz");
    expect(objects).toHaveLength(3);
  });

  it("asks for the prefix with its trailing slash and signs the request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(EMPTY));
    await listObjects({ ...CREDS, prefix: "a1b2c3/", fetchImpl: fetchImpl as never });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("prefix=a1b2c3%2F");
    expect(String(url)).toContain("list-type=2");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=k\//);
    expect(headers["x-amz-content-sha256"]).toBeDefined();
  });

  it("surfaces S3's own error code, which the status alone does not give", async () => {
    // SignatureDoesNotMatch and AccessDenied are both 403 and mean entirely
    // different things — a bad clock versus a bad policy.
    const body = `<Error><Code>SignatureDoesNotMatch</Code></Error>`;
    const fetchImpl = vi.fn().mockResolvedValue(respond(body, false, 403));
    await expect(
      listObjects({ ...CREDS, prefix: "a1b2c3/", fetchImpl: fetchImpl as never }),
    ).rejects.toThrow(/SignatureDoesNotMatch/);
  });

  it("stops rather than looping forever on a server that always truncates", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(REAL_TRUNCATED));
    await expect(
      listObjects({ ...CREDS, prefix: "a1b2c3/", fetchImpl: fetchImpl as never }),
    ).rejects.toThrow(/did not terminate/);
  });
});

describe("region", () => {
  it("takes the region out of a Spaces hostname", () => {
    // SigV4 signs the region and the server checks it, so a wrong guess fails
    // the signature rather than being ignored.
    expect(regionFromEndpoint("https://fra1.digitaloceanspaces.com")).toBe("fra1");
    expect(regionFromEndpoint("https://my-bucket.nyc3.digitaloceanspaces.com")).toBe("nyc3");
  });

  it("falls back to us-east-1 for anything else", () => {
    expect(regionFromEndpoint("http://localhost:9000")).toBe("us-east-1");
    expect(regionFromEndpoint("not a url")).toBe("us-east-1");
  });
});
