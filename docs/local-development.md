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

## What a laptop cannot tell you

Worth knowing before trusting a green run.

**NetworkPolicy is a silent no-op.** kind's default CNI does not implement it,
so one of drigodb's three isolation layers is simply absent — and absent
quietly, which is the dangerous kind. `scripts/smoke.sh` still labels its client
pod with `drigodb.io/allow-database`, so the test stays honest about what a real
consumer must do, but nothing here is enforcing it. Install Calico if that is
what you are testing.

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
