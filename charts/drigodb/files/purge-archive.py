#!/usr/bin/env python3
"""Remove every object one deleted database left behind in the backup bucket.

Runs as a Job on the barman-cloud sidecar image, which every installation with
backups already pulls. It is here rather than in the drigodb image because the
control plane holds no object-storage credential and no S3 client, and this needs
both -- so it runs somewhere else, once, with the credential mounted into the pod
and nothing else in reach.

Why not barman-cloud-backup-delete, which already exists and already has a
--dry-run? Because it cannot empty an archive, and this has to. Read
_remove_wals_for_backup in barman/clients/cloud_backup_delete.py: with no backup
left after the one being deleted, `remove_until` is the deleted backup itself and
the loop only deletes WAL where `wal_name < remove_until.begin_wal`. So every
segment archived from the last backup onwards survives, and so does every
.history file, which the same loop skips unconditionally. For a database that was
archiving right up to the moment it was deleted, that is the newest and largest
part of the archive -- the accumulation this is supposed to end. What empties a
prefix is delete_under_prefix, which barman implements and exposes to no CLI.

So the deletion itself is still barman's: delete_under_prefix refuses a prefix
that is empty, "/", or not slash-terminated, and it falls back to deleting one
object at a time when an S3-compatible store rejects a bulk delete for a missing
Content-MD5 -- which DigitalOcean Spaces, the store this was built against, does.
Reimplementing that on raw boto3 would be reimplementing the bug reports too.
"""

import json
import os
import re
import sys

from barman.cloud_providers.aws_s3 import S3CloudInterface

# The only prefixes this is allowed to touch. drigodb ids are 12 hex characters
# and a Cluster is db-<id>, so nothing else is an archive drigodb wrote.
#
# The guard is here and not only in the caller because this process holds the
# credential. An empty or wildcard server name arriving from a bug upstream would
# otherwise resolve to the bucket root, and delete_under_prefix would accept it.
SERVER_NAME_RE = re.compile(r"^db-[0-9a-f]{12}$")


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def env(name, default=None):
    value = os.environ.get(name, "")
    if value == "" and default is None:
        fail("%s is not set" % name)
    return value or default


def prefix_for(base_path, server_name, generation):
    """The object key prefix holding one archive generation.

    Generation 0 is `db-<id>`; an in-place restore leaves the one before it
    behind and archives to `db-<id>-rN`. See ARCHIVE_GENERATION_ANNOTATION in
    src/k8s/manifests.ts.
    """
    name = server_name if generation == 0 else "%s-r%d" % (server_name, generation)
    # Normalised deliberately: destinationPath may or may not end in a slash and
    # barman's own path may or may not start with one, and a prefix with a
    # leading slash matches nothing on S3. That failure is silent -- it reports
    # an empty archive and exits 0 having deleted nothing.
    base = base_path.strip("/")
    return "%s/%s/" % (base, name) if base else "%s/" % name


def objects_under(iface, prefix):
    """Count and total size of everything under a prefix.

    Listed rather than inferred from the delete, because delete_under_prefix
    reports nothing and a caller purging to reclaim storage wants to know how
    much came back. It is also what makes --dry-run mean something.
    """
    paginator = iface.s3.meta.client.get_paginator("list_objects_v2")
    count = 0
    size = 0
    for page in paginator.paginate(Bucket=iface.bucket_name, Prefix=prefix):
        for obj in page.get("Contents", []):
            count += 1
            size += obj["Size"]
    return count, size


def main():
    server_name = env("DRIGODB_SERVER_NAME")
    if not SERVER_NAME_RE.match(server_name):
        fail("refusing to purge %r: not a drigodb archive prefix" % server_name)

    destination = env("DRIGODB_DESTINATION_PATH")
    endpoint = env("DRIGODB_ENDPOINT_URL", "")
    region = env("AWS_REGION", "")
    dry_run = env("DRIGODB_DRY_RUN", "") == "1"
    max_generation = int(env("DRIGODB_MAX_GENERATIONS", "20"))

    iface = S3CloudInterface(
        url=destination,
        endpoint_url=endpoint or None,
        region=region or None,
    )
    if not hasattr(iface, "delete_under_prefix"):
        fail(
            "this barman-cloud sidecar image is too old to purge an archive: "
            "delete_under_prefix is missing. Set backup.purgeImage to the plugin "
            "version the chart pins."
        )

    generations = []
    truncated = False
    # EVERY generation up to the bound, never stopping at the first empty one.
    #
    # Stopping early was the first design and it is wrong: a purge that fails
    # part way through leaves holes, and the retry -- which is a caller re-POSTing
    # the same id -- would find generation 0 gone, conclude the archive is clean,
    # and leak precisely the generations the retry existed to collect.
    for generation in range(0, max_generation + 1):
        prefix = prefix_for(iface.path, server_name, generation)
        count, size = objects_under(iface, prefix)
        if count == 0:
            continue
        if not dry_run:
            iface.delete_under_prefix(prefix)
        generations.append(
            {"generation": generation, "prefix": prefix, "objects": count, "bytes": size}
        )
        # The highest generation probed still had something in it, so there may be
        # more above the bound. Say so rather than reporting a clean sweep: the
        # caller's move is to run again.
        if generation == max_generation:
            truncated = True

    # One line of JSON on stdout, last. The API reads the pod's log to answer the
    # request, and a summary it can parse beats barman's prose -- which for a
    # dry run over a large archive is megabytes of object keys.
    print(
        json.dumps(
            {
                "server_name": server_name,
                "dry_run": dry_run,
                "generations": generations,
                "objects": sum(g["objects"] for g in generations),
                "bytes": sum(g["bytes"] for g in generations),
                "truncated": truncated,
            }
        )
    )


if __name__ == "__main__":
    main()
