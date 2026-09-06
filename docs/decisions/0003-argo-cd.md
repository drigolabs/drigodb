---
date: 2026-09-06
status: decided
topic: reconciler
related:
  - docs/decisions/0002-gitops-for-the-control-plane.md
  - scripts/chart-determinism-test.sh
---

# Argo CD, for drigodb's own cluster

**Decision: Argo CD.** For reconciling drigodb's own deployment, not as a
requirement on anyone else.

## The distinction that took a wrong turn to find

An earlier draft of this record chose Flux, on the strength of a measurement:
Argo CD regenerated the API token on every sync while reporting `Synced` and
every resource healthy. Three hard refreshes on kind, three different tokens,
green throughout.

That measurement was real. The conclusion was wrong, because it conflated two
questions:

| | Whose call |
|---|---|
| Which reconciler does **drigodb's own deployment** use? | ours — this record |
| Which reconcilers must **the chart** work under? | all of them; a requirement, not a decision |

The token behaviour was a **bug in this repository's chart**, not a property of
Argo CD. `charts/drigodb/templates/secret-api-token.yaml` called Helm's `lookup`
to preserve the token, and `lookup` only resolves against a live cluster. Argo
renders with `helm template`, which has none — so it took the `randAlphaNum`
fallback every time. `helm diff`, `helm template` in CI and kustomize's Helm
inflator would all have done the same.

drigodb is installed by people who chose their reconciler before they had heard
of it. Requiring Flux for compatibility would have been an imposition, and a
chart that behaves correctly under only one renderer is simply broken. #63 fixed
the chart; `scripts/chart-determinism-test.sh` renders it twice and asserts
identical bytes on every CI run, so it cannot regress quietly.

With the chart renderer-agnostic, both tools became viable and the decision
became a small one about drigodb's own cluster.

## What it comes down to

**Familiarity.** drigodb has one operator, who uses Argo CD at work. That is
worth more than the alternatives here offer, and it is worth more precisely
because it is not a technical property: the cost of an unfamiliar tool is paid
at the worst possible moment, repeatedly, by the person least able to afford it
at the time.

**Memory, measured on a kind node** — actual cgroup usage rather than chart
defaults:

| | pods | memory |
|---|---|---|
| Flux, `source` + `helm` controllers | 2 | 49 MiB |
| Flux, full install | 7 | 131 MiB |
| **Argo CD, core mode — no UI, no API server** | 4 | **151 MiB** |

Against [0001](0001-instance-per-database-over-a-shared-cluster.md)'s measured
1500 MiB node that fits two databases at 192Mi each, Argo core costs most of one
database and Flux costs a quarter of one.

**That is a real cost and it is not what should decide this.** The node size is
a variable and the operator is not; a larger node is a line in `doks-up.sh`,
while learning a second reconciler well enough to debug it under pressure is
not. If databases per node ever becomes the binding constraint, Flux is a
migration rather than a rewrite — both reconcile the same chart.

**Argo also brings a UI and `AppProject`.** Neither is needed at one operator,
but a UI that shows what is out of sync is worth something on a bad day, and
`AppProject` is a real multi-tenancy model if this ever grows past one person.

## Practical notes, measured rather than read

- **`core-install.yaml` ships no `default` AppProject.** The first `Application`
  fails with `Application referencing project default which does not exist`
  until one is created. Not documented prominently; it cost a confused ten
  minutes.
- **Core mode is the right install here.** The full one adds a UI, an API server
  and Dex. Core is the headless reconciler, and it is the fair comparison
  against Flux's two controllers.
- **The chart installs cleanly from a git path** — `repoURL` plus
  `path: charts/drigodb` — needing no chart repository, no OCI registry, and no
  packaging step.

## Left open, and #51 must not assume it

[#51](https://github.com/drigolabs/drigodb/issues/51) needs the reconciler
suspended while Tilt drives the inner loop, so the two are not both writing the
same objects.

That was verified against **Flux**, not Argo: `spec.suspend: true` held a
Tilt-style patch, and resume did not revert it — nor did
`driftDetection.mode: enabled` within a 40-second window. Argo's equivalent is
disabling auto-sync or `argocd app set --sync-policy none`, and **it has not been
tested at all.**

#51 has to establish that the suspend and resume path actually round-trips.
A development loop that silently leaves locally-patched state behind after
resume is a worse failure than one that never suspended, because it looks like
it worked.
