# Logical backups for a drigodb database, as a sidecar in its pod.
#
# WHY THIS RUNS INSIDE THE DATABASE POD
#
# The Service publishes PostgreSQL's port, but config/pg_hba.conf admits only
# appuser, over TLS, into its own database. A backup Job outside the pod would
# therefore need its own pg_hba rule, a NetworkPolicy hole and a credential of
# its own — reopening the network path the isolation model deliberately closes
# (issue #29).
#
# As a sidecar it reaches the server over a Unix socket on a shared volume,
# authenticating by peer as the same UID. No new auth, no new route.
#
# WHY IT IS BUILT FROM THE POSTGRES IMAGE
#
# pg_dump must not be older than the server it dumps. Deriving from the exact
# image the database runs makes that true by construction rather than by
# remembering to bump two versions together. It is also nearly free at runtime:
# the pod already pulls this image for its postgres container, so every layer
# below rclone is shared and nothing extra is downloaded onto the node.
# The same image the database runs, so pg_dump can never be older than the
# server it dumps. CNPG publish and patch it; drigodb no longer maintains a
# postgres base of its own. See docs/leaving-documentdb.md.
ARG POSTGRES_IMAGE=ghcr.io/cloudnative-pg/postgresql:18

FROM ${POSTGRES_IMAGE}

# The base ends on USER 26; installing needs root, and the final USER below puts
# it back. Nothing in this image runs as root.
USER 0

ENV DEBIAN_FRONTEND=noninteractive

# rclone from Ubuntu rather than upstream's release archive: it is reproducible,
# needs no download-and-verify step, and leaves no curl in the image. It is
# older than upstream but only S3 PUT, LIST and GET are used here.
#
# rclone and not mc, the MinIO client, despite MinIO being what the tests run
# against: mc is AGPL and this image is published, whereas the MinIO server
# stays a test-only container that is never distributed. rclone is MIT.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends rclone; \
    rm -rf /var/lib/apt/lists/* /var/cache/* /var/log/*

COPY backup.sh /usr/local/bin/drigodb-backup
RUN chmod 0755 /usr/local/bin/drigodb-backup

# The PostgreSQL server's UID in this image. Peer auth resolves the caller's UID
# against the server's own passwd database, so this must match or every
# connection fails.
USER 26

ENTRYPOINT ["/usr/local/bin/drigodb-backup"]
CMD ["run"]
