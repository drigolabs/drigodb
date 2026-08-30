# CloudNativePG-compatible PostgreSQL image carrying the DocumentDB extension.
#
# DocumentDB publishes no CNPG-compatible image of its own — only an all-in-one
# emulator container and OS packages — so this image is drigodb's to maintain.
# See docs/service-boundary.md U1.
#
# WHY UBUNTU RATHER THAN CNPG'S OWN IMAGE
#
# Building FROM ghcr.io/cloudnative-pg/postgresql (Debian trixie) was tried
# first, to inherit CNPG's weekly security rebuilds. The package installs
# cleanly there — its declared `libc6 (>= 2.38)` is satisfied and its other
# dependencies are PGDG packages published for both distributions — but the
# server then refuses to start:
#
#   FATAL: could not load library ".../pg_documentdb_core.so":
#          undefined symbol: ucol_getSortKey_74
#
# ICU exports version-suffixed symbols. Upstream builds against Ubuntu 24.04's
# libicu74; Debian trixie ships libicu76, so the symbol does not exist. No
# symlink or compatibility shim fixes that.
#
# This image therefore mirrors CNPG's own Dockerfile structure (PGDG apt,
# postgresql-$PG_MAJOR, uid 26, locales-all, required binaries on PATH) on
# Ubuntu 24.04 — upstream DocumentDB's Tier 1 build target, the one combination
# their CI builds, tests, and runs an install-and-start E2E against.
#
# The cost is that drigodb owns base-image patching for this image rather than
# inheriting CNPG's weekly rebuild, which is why the plan calls for a scheduled
# CI rebuild.

ARG PG_MAJOR=18
ARG DOCUMENTDB_VERSION=0.116-0
ARG BASE=ubuntu:24.04

FROM ${BASE}

ARG PG_MAJOR
ARG DOCUMENTDB_VERSION
# Set by buildx; defaulted so a plain `docker build` still works.
ARG TARGETARCH=amd64

ENV PATH=$PATH:/usr/lib/postgresql/${PG_MAJOR}/bin
ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-common ca-certificates gnupg curl; \
    /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y -c "${PG_MAJOR}"; \
    # CNPG creates and owns the cluster itself; the packaging must not make one.
    sed -ri 's/#(create_main_cluster) .*$/\1 = false/' /etc/postgresql-common/createcluster.conf; \
    apt-get install -y --no-install-recommends \
      libsasl2-modules libldap-common locales-all \
      "postgresql-${PG_MAJOR}"; \
    \
    deb="ubuntu24.04-postgresql-${PG_MAJOR}-documentdb_${DOCUMENTDB_VERSION}_${TARGETARCH}.deb"; \
    base="https://github.com/documentdb/documentdb/releases/download/v${DOCUMENTDB_VERSION}"; \
    curl -fsSL -o "/tmp/${deb}" "${base}/${deb}"; \
    curl -fsSL -o /tmp/SHA256SUMS "${base}/SHA256SUMS"; \
    # Upstream's SHA256SUMS covers every asset; check only the one we fetched.
    (cd /tmp && grep " ${deb}\$" SHA256SUMS | sha256sum -c -); \
    \
    # Declared dependencies of the extension package, all from PGDG.
    apt-get install -y --no-install-recommends \
      "postgresql-${PG_MAJOR}-cron" \
      "postgresql-${PG_MAJOR}-pgvector" \
      "postgresql-${PG_MAJOR}-postgis-3"; \
    apt-get install -y --no-install-recommends "/tmp/${deb}"; \
    \
    apt-get purge -y --auto-remove curl gnupg; \
    rm -rf /tmp/*.deb /tmp/SHA256SUMS /var/lib/apt/lists/* /var/cache/* /var/log/*

# CNPG runs PostgreSQL as uid 26 and mounts volumes owned by it.
RUN usermod -u 26 postgres && chown -R 26:postgres /var/lib/postgresql /var/run/postgresql
USER 26
