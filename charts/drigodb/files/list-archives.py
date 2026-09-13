#!/usr/bin/env python3
"""List what is actually in the backup bucket, one top-level prefix at a time.

The other half of the purge (#23). `POST /v1/archives/{id}/purge` takes an id;
nothing told anyone which ids to give it. An archive whose database was deleted has
no Cluster, no Backup objects and no drigodb record of any kind — `GET /v1/databases`
and `GET /v1/databases/{id}/backups` both read Kubernetes objects, and those went
with the database. The bucket is the only place the answer exists.

Runs as a Job on the barman-cloud sidecar image for the same reason purge-archive.py
does: the control plane holds no object-storage credential and no S3 client, and this
needs both. It is READ ONLY — no delete of any kind, and nothing in it takes a prefix
from outside.

It classifies nothing. That happens in the control plane, which is the only place
that knows which Clusters exist; this reports what is there and how big it is. Keeping
the split means the thing holding a bucket credential holds no opinions about which
archives are expendable.

A separate file from purge-archive.py rather than a mode flag on it. The overlap is
five lines that build an S3 interface out of three environment variables; the parts
that matter — a per-id prefix with a generation suffix against a delimiter-ed listing
of the top level — have nothing in common. One program per verb, and the one that can
delete stays as small as it can be.
"""

import json
import os
import sys

from barman.cloud_providers.aws_s3 import S3CloudInterface


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def env(name, default=None):
    value = os.environ.get(name, "")
    if value == "" and default is None:
        fail("%s is not set" % name)
    return value or default


def main():
    destination = env("DRIGODB_DESTINATION_PATH")
    endpoint = env("DRIGODB_ENDPOINT_URL", "")
    region = env("AWS_REGION", "")
    # A ceiling on the answer rather than on the work: a bucket with more prefixes
    # than this returns the first N and says it was truncated, instead of building a
    # response nothing can read and a log nothing can hold.
    limit = int(env("DRIGODB_ARCHIVE_LIST_LIMIT", "500"))

    iface = S3CloudInterface(
        url=destination,
        endpoint_url=endpoint or None,
        region=region or None,
    )

    # Normalised the same way purge-archive.py does, and for the same reason: a
    # destinationPath may or may not end in a slash, barman's parsed path may or may
    # not begin with one, and a prefix with a leading slash matches nothing on S3 —
    # silently, reporting an empty bucket.
    base = iface.path.strip("/")
    root = "%s/" % base if base else ""

    client = iface.s3.meta.client
    paginator = client.get_paginator("list_objects_v2")

    # Delimiter='/' asks S3 for the "directories" under root rather than every key in
    # the bucket. One request per thousand prefixes instead of one per thousand
    # objects, which for an archive of 16 MiB WAL segments is a difference of orders
    # of magnitude.
    prefixes = []
    truncated = False
    for page in paginator.paginate(Bucket=iface.bucket_name, Prefix=root, Delimiter="/"):
        for cp in page.get("CommonPrefixes", []):
            full = cp["Prefix"]
            name = full[len(root):].rstrip("/")
            if not name:
                continue
            if len(prefixes) >= limit:
                truncated = True
                break
            prefixes.append({"name": name, "prefix": full})
        if truncated:
            break

    # Then size each one. A second pass, and it is the expensive part — every object
    # under every prefix — so it is worth knowing why it is here: "which archives
    # exist" without "how much they cost" does not answer the question this was built
    # for, which is what is being paid for and what can be reclaimed.
    for entry in prefixes:
        count = 0
        size = 0
        for page in paginator.paginate(Bucket=iface.bucket_name, Prefix=entry["prefix"]):
            for obj in page.get("Contents", []):
                count += 1
                size += obj["Size"]
        entry["objects"] = count
        entry["bytes"] = size

    print(
        json.dumps(
            {
                "destination": destination,
                "root": root,
                "archives": prefixes,
                "objects": sum(e["objects"] for e in prefixes),
                "bytes": sum(e["bytes"] for e in prefixes),
                "truncated": truncated,
            }
        )
    )


if __name__ == "__main__":
    main()
