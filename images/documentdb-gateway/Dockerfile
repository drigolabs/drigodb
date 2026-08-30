# MongoDB wire-protocol gateway for drigodb.
#
# DocumentDB's gateway (pg_documentdb_gw) translates the MongoDB wire protocol
# into SQL against a PostgreSQL backend running the DocumentDB extension. It is
# stateless, so one runs per app alongside that app's CNPG cluster and scales to
# zero with it.
#
# Upstream ships this only as an OS package and inside the all-in-one emulator
# container, so the image is drigodb's to build. See
# docs/service-boundary.md U2.
#
# Ubuntu 24.04 for the same reason as the postgres-documentdb image: it is
# upstream's Tier 1 build target, and the package declares libc6 (>= 2.39).

ARG DOCUMENTDB_VERSION=0.116-0
ARG BASE=ubuntu:24.04

FROM ${BASE}

ARG DOCUMENTDB_VERSION
# Set by buildx; defaulted so a plain `docker build` still works.
ARG TARGETARCH=amd64

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    \
    # The release tag uses 0.116-0 while the gateway package version uses
    # 0.116.0 — same release, different separator.
    pkg_version="$(echo "${DOCUMENTDB_VERSION}" | tr '-' '.')"; \
    deb="ubuntu24.04-documentdb-gateway_${pkg_version}_${TARGETARCH}.deb"; \
    base="https://github.com/documentdb/documentdb/releases/download/v${DOCUMENTDB_VERSION}"; \
    curl -fsSL -o "/tmp/${deb}" "${base}/${deb}"; \
    curl -fsSL -o /tmp/SHA256SUMS "${base}/SHA256SUMS"; \
    (cd /tmp && grep " ${deb}\$" SHA256SUMS | sha256sum -c -); \
    \
    apt-get install -y --no-install-recommends "/tmp/${deb}"; \
    \
    # The package's postinst creates the documentdb-gateway user (uid 999); its
    # systemd unit is inert here and is left in place rather than deleted.
    #
    # The container must run as the PostgreSQL server's UID (see USER below), so
    # writable state is group-0 owned and group-writable — the standard pattern
    # for images that run under an arbitrary UID.
    install -d -o documentdb-gateway -g 0 -m 0770 \
      /var/lib/documentdb-gateway /var/lib/documentdb-gateway/tls; \
    \
    apt-get purge -y --auto-remove curl; \
    rm -rf /tmp/*.deb /tmp/SHA256SUMS /var/lib/apt/lists/* /var/cache/* /var/log/*

# Configuration is environment-first; the JSON config file is optional and unused
# here. DOCUMENTDB_PG_URL_FILE takes a *path*, not the URL itself, which is why
# the connection string is mounted as a file rather than passed as an env var —
# it keeps the credential out of the pod spec and out of `docker inspect`.
ENV DOCUMENTDB_LISTEN_ADDR=":10260" \
    DOCUMENTDB_TLS_AUTO_GENERATE="true" \
    DOCUMENTDB_TLS_STATE_DIR="/var/lib/documentdb-gateway/tls" \
    DOCUMENTDB_LOG_LEVEL="info"

WORKDIR /var/lib/documentdb-gateway

# Runs as the PostgreSQL server's UID, not the packaged documentdb-gateway user.
# The gateway reaches PostgreSQL only over a Unix socket with peer auth, and
# PostgreSQL resolves the peer's UID against its *own* passwd database — so this
# UID must match the one PostgreSQL runs as, or every connection fails with
# "provided user name ... and authenticated user name ... do not match".
# 26 is CloudNativePG's PostgreSQL UID; override at deploy time if that changes.
USER 26
EXPOSE 10260

# `check` probes the backend and verifies the extension is loaded, exiting 0/1 —
# it is the readiness probe for the per-app Deployment, not just a Docker nicety.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/bin/documentdb-gateway", "check"]

ENTRYPOINT ["/usr/bin/documentdb-gateway"]
CMD ["run"]
