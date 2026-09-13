---
date: 2026-09-13
topic: delivery
status: current — describes the pipeline as it runs
related:
  - docs/decisions/0002-gitops-for-the-control-plane.md
  - docs/diagrams/deploy-flow.md
---

# How a merge becomes a release

Moved out of the README when that became a landing page. This is the part nobody needs
until they are setting the pipeline up or wondering why a merge shipped nothing.

Merging to `main` is the whole release process. The flow end to end, and which credential each step
holds, is in [docs/diagrams/deploy-flow.md](diagrams/deploy-flow.md) — which describes the
target in [decision 0002](decisions/0002-gitops-for-the-control-plane.md), not what runs today.
What runs today is the push path below. `.github/workflows/release.yml` reads the
Conventional Commit subjects since the last tag, and if they earned a version it builds the API image
for both architectures, publishes it under an immutable tag, tags the merged commit, cuts a GitHub
release, and rolls it out to DOKS — then reads `/healthz` back to confirm the cluster is serving the
build the run just made.

Nothing in the pipeline writes to `main`. It creates a tag, and a tag is not a branch, so `main` stays
protected against everyone. That tag is the record of what shipped: `scripts/next-version.sh` computes
the next version from it.

**A release does not deploy itself.** The chart's `appVersion` is what is deployed, read as written — the
commit being released cannot name the image the release is about to build. So publishing and shipping
are two merges: CI publishes, then rewrites a standing issue carrying the one-line diff that moves the
pin, and merging that is what ships it. The alternative is a pipeline pushing to `main`, and a `main`
no one can push to is worth more than the bookkeeping.

This used to resolve the newest tag at apply time instead, which made the manifest a decoy: two
clusters applying the same commit a week apart ran different images. The pin had sat stale at `0.0.1`
for seven releases without anyone noticing, because nothing read it.

A merge of only `docs:` or `chore:` commits releases nothing. That is the intended amount of ceremony
for a README fix.

| commits since the last tag | 0.x today | once past 1.0.0 |
|---|---|---|
| `feat:`, `feat!:`, `BREAKING CHANGE:` | minor — `0.1.0` | minor, or major for a breaking one |
| `fix:`, `perf:`, `revert:` | patch — `0.0.2` | patch |
| anything else | no release | no release |

Below 1.0.0 the minor position is the one allowed to break, so a `!` bumps the minor rather than
declaring a 1.0.0 nobody decided on. Reaching 1.0.0 is a deliberate `git tag`. Preview any of this
before pushing:

```bash
scripts/next-version.sh --why
```

**The cluster being gone is not a failure.** DOKS bills whether or not anyone is connected, so it gets
torn down between sessions. A merge with no cluster running publishes the image, says so, and stops —
`scripts/doks-up.sh && scripts/deploy.sh` picks it up later.

The pipeline decides that by **asking whether the cluster answers**, using the credential it is about
to deploy with. It used to ask DigitalOcean whether the cluster existed, which a read-scoped token
could do — so the check passed while the very next call failed `403`, and seven releases reported a
successful deploy without ever deploying. A check that does not exercise the credential it is checking
is not a check. See [#15](https://github.com/drigolabs/drigodb/issues/15).

### There is no data-plane image

drigodb built and published one — `drigodb-backup`, a sidecar — and it went with
the pod template it lived in ([decision 0004](decisions/0004-cloudnativepg-for-the-data-plane.md)).
Databases run `ghcr.io/cloudnative-pg/postgresql:18` directly, which CloudNativePG
rebuilds and drigodb inherits, so there is nothing here to publish and no weekly
rebuild to run. The API image is the only image this repository makes.

Backups return with [#95](https://github.com/drigolabs/drigodb/issues/95), on the
operator's own machinery rather than an image of drigodb's.

### Setting it up

The pipeline needs two things arranged once, and neither is a token you create by hand:

1. **Nothing, for the deploy credential.** `scripts/doks-up.sh` mints it and pushes it to the
   repository itself, because that script already runs as an administrator — creating a cluster
   requires one — and that is the right place for the privileged step.

   It creates a `drigodb-deployer` ServiceAccount scoped to what deploying actually does, and sets
   `DRIGODB_DEPLOY_TOKEN`, `DRIGODB_CLUSTER_SERVER` and `DRIGODB_CLUSTER_CA`. CI never calls the
   DigitalOcean API. The credential dies with the cluster, which is the point: one that outlives what
   it grants access to is one nobody remembers to revoke.

   This replaces a `DIGITALOCEAN_ACCESS_TOKEN` that the pipeline used to exchange for a kubeconfig at
   deploy time. That kubeconfig authenticates as the **account owner** and is cluster-admin — verified,
   it can delete nodes and read every Secret in the cluster — because DigitalOcean has no lesser
   kubeconfig to issue. A leaked repository secret reached the whole account rather than one
   deployment. **If `DIGITALOCEAN_ACCESS_TOKEN` is still set on the repository, delete it**; nothing
   reads it any more.

   Without the secrets the pipeline still builds and publishes; it just reports the deploy as skipped.

2. **Write access from this repo to the GHCR packages.** The three packages were first pushed by hand
   with a personal token, so they are not yet linked to the repository. On each package's page →
   *Package settings* → *Manage Actions access* → add `drigolabs/drigodb` with **Write**, or the
   workflow's token cannot push.
3. **Nothing else.** `main` is protected and no one — the pipeline included — pushes to it. The
   release writes a tag, and a tag is not a branch, so protection and automated releases do not
   trade off against each other.

The repository's default token is read-only, which is correct and needs no change — each job asks for
exactly the access it needs. Nothing asks for `pull-requests: write`, so *Allow GitHub Actions to
create and approve pull requests* stays off.

`scripts/deploy.sh` still works by hand — for standing a cluster up outside the
reconciler, or bootstrapping one. It is the escape hatch, not the route.
