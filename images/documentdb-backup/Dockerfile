# Logical backups for a drigodb database, as a sidecar in its pod.
#
# WHY THIS RUNS INSIDE THE DATABASE POD
#
# config/pg_hba.conf admits TCP from 127.0.0.1 and ::1 only, and the Service
# publishes the gateway's port rather than PostgreSQL's. Nothing outside the pod
# can reach the server. A backup Job would therefore need a pg_hba rule, a
# NetworkPolicy hole and a credential of its own — reopening the network path to
# PostgreSQL that the isolation model deliberately closes.
#
# As a sidecar it reaches the server over the Unix socket the gateway already
# uses, authenticating by peer as the same UID. No new auth, no new route.
#
# WHY IT IS BUILT FROM THE POSTGRES IMAGE
#
# pg_dump must not be older than the server it dumps. Deriving from the exact
# image the database runs makes that true by construction rather than by
# remembering to bump two versions together. It is also nearly free at runtime:
# the pod already pulls this image for its postgres container, so every layer
# below rclone is shared and nothing extra is downloaded onto the node.
ARG POSTGRES_IMAGE=ghcr.io/drigolabs/drigodb-postgres:18-0.116-0-20260831-b1

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

# The PostgreSQL server's UID. Peer auth resolves the caller's UID against the
# server's own passwd database, so this must match or every connection fails —
# the same constraint the gateway image documents.
USER 26

ENTRYPOINT ["/usr/local/bin/drigodb-backup"]
CMD ["run"]
