# Contributing

Patches are welcome. This document is short because most of what a contributor needs to
know lives in [`CLAUDE.md`](CLAUDE.md) — the working notes for this repository, which
explain *why* things are shaped the way they are and which mistakes have already been
paid for.

Read that first. It will save you a review round.

## Getting a change in

```bash
git clone https://github.com/drigolabs/drigodb && cd drigodb
npm ci
npm test            # no cluster needed
npm run typecheck
```

Then, for anything that touches Kubernetes:

```bash
bash scripts/kind-up.sh --local --with-backups   # a real cluster on your laptop
KUBE_CONTEXT=kind-drigodb bash scripts/smoke.sh
bash scripts/kind-down.sh                        # kind clusters are not free RAM
```

Branch from `main`, open a pull request, and let CI run. Five checks; all five should be
green before review.

## What gets a change rejected

Not style. These:

**A test that cannot fail.** The recurring defect in this repository, and it has taken
several shapes: an assertion whose inputs were both empty, a `kubectl` selector that read
the wrong pod during a rollout, a leaked `port-forward` that answered from a stale pod. If
you add a test, break the code and watch it fail. If it passes, the test is decoration.

**A mocked Kubernetes client standing in for a cluster.** A mock agrees with any selector,
any content type and any pod template. Three bugs shipped past green unit tests and were
caught on a real cluster: a hibernation that silently did nothing, a credential rotation
that left the old password working, and a `resize` that returned 500 everywhere for four
releases. Unit tests pin the logic; `scripts/kind-up.sh` is how you find out whether it is
true. Anything touching the Kubernetes API gets both.

**A comment that restates the line below it.** Comments here record the failure that made
the code this shape — the thing that breaks if it is changed back. Match the density of
the file you are in.

**A decision without a record.** If your change had alternatives worth weighing, it needs
an ADR in [`docs/decisions/`](docs/decisions/) in the same pull request, with the options
you rejected and the trade you accepted. `CLAUDE.md` has the standard.

**A chart that does not render identically twice.** No `lookup`, no `randAlphaNum`, no
clock. One `lookup` rotated every consumer's bearer token on every Argo sync while
reporting Synced. `scripts/chart-determinism-test.sh` enforces it.

## Pull request shape

Two named lists, then the evidence. The template is in
[`.github/pull_request_template.md`](.github/pull_request_template.md):

- **Ships** — the capabilities, one line each
- **Failure modes covered** — the failure first, the mitigation second
- **Trade** — what got worse
- **Verified** — what you actually ran, and where

Write it from the diff rather than from how the work went. The causal story belongs in
code comments and the commit message.

## Becoming a maintainer

There is no committee. Land a few changes that hold up — ideally including one where you
found a problem nobody had filed — and ask. Review access follows demonstrated care about
the failure modes above, not volume.

Issues labelled `good first issue` are a reasonable entry point when they exist; if none
do, [the open backlog](https://github.com/drigolabs/drigodb/issues) is small enough to
read in one sitting and most items say what is actually missing.

## Reporting something security-relevant

Open a private security advisory through GitHub's **Security → Advisories** tab rather than
a public issue, and give it a few days before disclosing. drigodb provisions databases and
holds credentials for them; a report that arrives publicly is a report an attacker reads
at the same time as a maintainer.
