---
date: 2026-09-05
topic: local-development
status: current
related:
  - scripts/kind-up.sh
  - Tiltfile
  - charts/drigodb/README.md
---

# Running drigodb on a laptop

For the step-by-step, including every other way to install drigodb, start at
[getting-started.md](getting-started.md). This page is the *why* behind the
local path: which loop to use, and the four things a laptop cannot tell you.

```bash
bash scripts/kind-up.sh
KUBE_CONTEXT=kind-drigodb bash scripts/smoke.sh
```

That provisions a real database on a kind cluster, connects to it over TLS with
the connection URI the API issued, hibernates and wakes it, and rotates its
credentials. No cloud account, nothing billed.

Until this existed, the only way to run drigodb was to pay DigitalOcean, which
is why four issues sat under `needs-cluster` until they could be batched into a
single session.

## Two loops, and they want opposite things

**The inner loop** — `scripts/kind-up.sh --local`, or `tilt up` for continuous
rebuilds. Builds the API from this tree and loads it straight into the kind node.
No registry, no push, seconds per change. Correctness of the *deployment path*
is not the point here; speed is.

**Verification** — `scripts/kind-up.sh` with no flags. Pulls the **published**
image, the one a consumer gets, and installs the same chart with the same
`scripts/deploy.sh` that DOKS uses. Nothing local except the cluster.

That sameness is deliberate. A second deploy path for local work would drift
from the real one, and this repository has already been bitten by exactly that:
a stand-down check that asked a provider API instead of using the credential it
was checking passed for seven consecutive releases without ever deploying.

## Backups

```bash
bash scripts/kind-up.sh --with-backups
```

Adds MinIO and points drigodb at it. MinIO is what the backup image's own
integration test already runs against, so this is the same substitution the
tests make rather than a new one. Backups, listing and restore all work.

## What a laptop can tell you now

The network layer, in full — see below. That leaves storage behaviour, timings
and scheduling pressure as the things a cluster session is still for.

## What a laptop cannot tell you

Worth knowing before trusting a green run.

**NetworkPolicy is no longer one of these — the warning that used to be here was
wrong.** kindnet did not implement NetworkPolicy for years, so this page said one
of drigodb's three isolation layers was silently absent locally. As of the
kindnet that kind v0.33 ships, the whole contract holds on a laptop. Measured
with one pod, relabelled between attempts:

| from | label | |
|---|---|---|
| another namespace | none | blocked |
| another namespace | this database's id | **connects** |
| another namespace | a different database's id | blocked |
| another database's pod | — | blocked |

The third row is the one worth having. A policy that admitted any drigodb
consumer at all would pass a naive test and still be broken in the way that
matters. The fourth says a compromised database cannot reach its neighbour.

Which is a better outcome and a worse habit. The claim had never been tested, and
a stale "this does not work locally" is how a real policy bug gets dismissed as a
known limitation. `scripts/smoke.sh` now checks rather than anyone assuming, from
`default` rather than from inside the database namespace — the policy pairs
`namespaceSelector: {}` with a podSelector, so probing from within would never
exercise the part that admits a consumer from anywhere.

**Volumes cannot be expanded.** kind's `local-path` provisioner reports
`allowVolumeExpansion: false`, so storage resize is untestable. That question
was answered on DigitalOcean block storage precisely because expansion belongs
to the CSI driver rather than to Kubernetes.

**Timings mean nothing.** Provision and wake numbers on a laptop are not the
numbers in the README's Measured section, which were taken on
`s-1vcpu-2gb` in `fra1`.

**Scheduling headroom is different.** The measured limit of two databases per
node came from a 1500 MiB node. A laptop has more, so a local cluster will not
reproduce the pressure that made a third database refuse to schedule.

A local cluster makes cluster sessions **rarer, not unnecessary**.

## Tearing down

```bash
bash scripts/kind-down.sh
```

Nothing to sweep afterwards, unlike `doks-down.sh`: kind's volumes are
directories inside the node container and go when it does.
