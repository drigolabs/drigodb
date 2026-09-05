---
date: 2026-09-05
status: decided
topic: reconciler
related:
  - docs/decisions/0002-gitops-for-the-control-plane.md
  - charts/drigodb/templates/secret-api-token.yaml
---

# Flux over Argo CD

**Decision: Flux, using `source-controller` and `helm-controller` only.**

Not on reputation. Both were installed on a kind cluster and pointed at this
repository's chart, because [0002](0002-gitops-for-the-control-plane.md) said the
comparison should be made against a branch where the control plane is already
declarative, and it now is.

Argo CD was the favourite going in — it is what the author uses at work, and
familiarity is a real advantage that this decision gives up.

## What settled it

**Argo CD regenerates the API token on every refresh, and reports `Synced` while
doing it.**

```
before:           4XdI0CaPog4b...
hard refresh 1:   l6atY8ZrhOOO...
hard refresh 2:   z4t7sdIrDVtS...
hard refresh 3:   jFaKs7FM53vf...
```

Under Flux, across three forced reconciliations:

```
before:           iggxuGlMvjMM...
reconcile 1..3:   iggxuGlMvjMM...   PRESERVED
```

### Why

`charts/drigodb/templates/secret-api-token.yaml` generates the bearer token once
and preserves it, by reading the live Secret with Helm's `lookup`. Without that,
every upgrade would mint a new token and invalidate every consumer's credential.

`lookup` needs a cluster to query. **Argo CD renders charts with `helm template`,
which has no cluster context**, so `lookup` returns nothing and the fallback —
`randAlphaNum` — runs every time. Verified independently of Argo: three
consecutive `helm template` renders of this chart produce three different tokens.

Flux's `helm-controller` runs the Helm SDK against the cluster, so `lookup`
resolves.

### The part that makes it disqualifying rather than annoying

Argo reported **`Synced`** and every resource healthy throughout, including the
Secret. After applying a new token, live matches desired, so there is nothing to
report. A tool whose job is to tell you when reality has drifted from git would
have been silently rotating the credential every consumer holds, while showing
green.

This is the same failure shape this project keeps finding — a stale pin nothing
read, a workflow trigger watching a deleted path, a stand-down check that never
used its credential, a smoke test that could not have passed — and it is the
reason to measure rather than assume.

## Memory, measured

On a kind node, actual cgroup usage rather than chart defaults:

| | pods | memory |
|---|---|---|
| **Flux, `source` + `helm` controllers** | 2 | **49 MiB** |
| Flux, full install | 7 | 131 MiB |
| Argo CD, **core** mode (no UI, no API server) | 4 | **151 MiB** |

Against the measurement in [0001](0001-instance-per-database-over-a-shared-cluster.md)
— a `s-1vcpu-2gb` node has 1500 MiB allocatable and fits two databases at 192Mi
each — Flux costs about a quarter of one database. Argo core costs most of one.

The full Flux install is not needed. `image-automation` and `image-reflector` are
explicitly out of scope: 0002 rejects anything that commits tags back to the
repository. `kustomize-controller` is unnecessary when the chart is a
`HelmRelease`, and `notification-controller` is optional.

## What Argo would have been better at

Recorded because this decision gives real things up.

**Familiarity.** The author uses Argo at work. That is worth more than a small
memory difference and would have won on its own.

**The UI.** Argo's is genuinely good, and Flux has nothing equivalent without
adding one.

**`AppProject`.** Argo has a real multi-tenancy model for the reconciler itself.
drigodb has one operator, so it is overhead here — but it would matter later.

The core install also needed one thing the documentation does not lead with: it
ships no `default` AppProject, so the first `Application` fails with
`Application referencing project default which does not exist` until one is
created.

## Not settled: suspend and resume

[#51](https://github.com/drigolabs/drigodb/issues/51) needs the reconciler
suspended while Tilt drives the inner loop. Half of that is verified:

- **Suspend works.** With `spec.suspend: true`, a Tilt-style patch to the
  Deployment survives.
- **Resume did not revert it**, and neither did `driftDetection.mode: enabled`
  within a 40-second window.

That is reported as measured rather than explained, because the explanation
would be a guess. It does not change the decision — the token behaviour settles
that on its own — but **#51 must verify the resume path properly rather than
assume `suspend` has a symmetric opposite.** A dev loop that silently leaves
locally-patched state behind after resume is a worse failure than one that never
suspended.

## Reproducing this

Both were installed on `kind`, pointed at `https://github.com/drigolabs/drigodb`
`main`, path `charts/drigodb`. Argo via `core-install.yaml` plus a `default`
AppProject; Flux via its release `install.yaml` with a `GitRepository` and a
`HelmRelease`. Tokens were read from the live Secret between forced refreshes.
