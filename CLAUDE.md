# Working on drigodb

drigodb provisions PostgreSQL databases through an API on Kubernetes. One
CloudNativePG `Cluster` per database (`docs/decisions/0001`, `0004`), installed
with the Helm chart in `charts/drigodb`, reconciled by Argo CD
(`docs/decisions/0002`, `0003`).

## Where things go

drigodb's core provides **mechanisms** — create, hibernate, wake, resize,
rotate, back up, restore. It holds no **policy**: it does not decide *when* any
of them should run. `docs/decisions/0008` is the record, and
`docs/decisions/README.md` groups every other record by which side it is on.

The test for a change is one question: **does it say what drigodb can do to a
database, or when to do it?**

- *What* — it belongs in `src/`, behind an endpoint a caller can drive.
- *When* — it does not belong in this repository. A component deciding when to
  hibernate a database calls `POST /v1/databases/{id}/hibernate` like any other
  consumer, and ships as its own deployable.

There is no `core/` directory because every line of `src/` is core, and no
`services/` directory because nothing lives there yet. When the first policy
component exists, it gets its own home; an empty folder reserving the future is
what `docs/decisions/0006` deleted.

The obligation this creates: a mechanism has to be complete enough to be driven
from outside. An endpoint an external scheduler cannot actually run a fleet on
is an unfinished mechanism, not a reason to move the decision inwards.

## Commands

```
npm test                          vitest, no cluster needed
npm run typecheck                 tsc --noEmit
bash scripts/kind-up.sh           a real cluster on a laptop, via scripts/deploy.sh
bash scripts/kind-down.sh         tear it down — do this, kind clusters are not free RAM
bash scripts/smoke.sh             end-to-end against a running installation
bash scripts/chart-determinism-test.sh    renders the chart twice, asserts identical
```

## Pull requests

Two named lists, then the evidence. See `.github/pull_request_template.md`.

- **Ships** — the capabilities, one line each.
- **Failure modes covered** — the failure first, the mitigation second, one line
  each. If a failure mode will not fit on a line, it is two failure modes. One
  the PR would have introduced and does not counts.
- **Trade** — what got worse, if anything.
- **Verified** — what was actually run, and where.

Write it from the diff, not from how the work went. The causal story belongs in
code comments and the commit message, where someone doing archaeology will be.

Never write `@` before a number in GitHub prose. `@20k` pinged a real user.

## Commits

Conventional Commits, and they are load-bearing: `scripts/next-version.sh` reads
the subjects since the last tag to mint the version, so a merge of only `docs:`
and `chore:` releases nothing and deploys nothing. Subjects say what changed for
someone using the thing, not which files moved — `fix: half the default volume
was reserved for WAL nobody chose`.

Branch from `main`, always. Branching from a feature branch has twice produced a
PR with nothing left to merge, and once left a decision record on no branch
`main` could see.

If a PR is ever stacked anyway, **check that its content reached `main` — not
that GitHub says merged.** A stacked PR merges into its base branch, so when the
base is squashed to `main` first, the squash is taken from the commit before the
stacked one landed. Both PRs then report `MERGED`, truthfully, and neither one
is on `main`:

```
git ls-tree origin/main <a path the PR added>
```

`--is-ancestor` will not tell you: every merge here is a squash, so the branch is
never an ancestor of `main` even when it landed. That is also why the branch
looks stale and deletable afterwards — both branches holding
`docs/decisions/0008` were on the delete list while it existed nowhere else.

## Comments

The repo is heavily commented and the comments explain *why* — the failure that
made this the shape it is, the thing that will break if it is changed back. A
comment restating the line below it is noise; a comment recording that
`include_if_exists` is there because a missing tier file broke startup is the
reason the file survives its next edit. Match the density of the file you are in.

## Testing

A mocked client will agree with anything. It cannot notice a wrong `Content-Type`,
a pod template that silently drops a label, or a StatefulSet that reports
`hibernated` when it is provisioning — all three shipped past green unit tests and
were caught on a cluster. Unit tests pin the logic; `scripts/kind-up.sh` is how
you find out whether it is true. Anything touching the Kubernetes API gets both.

Assert that a new test fails without the fix. A `str.replace` that silently
matched nothing once left `create()` ignoring the configured default tier.

## Do not change silently

- The CI job names `typecheck and test`, `drigodb works end to end` and
  `api image builds` — branch protection on `main` requires them by those exact
  strings, and renaming one blocks every PR on a check that never reports.
- The chart must render identically every time: no `lookup`, no `randAlphaNum`,
  no clock. One `lookup` rotated every consumer's bearer token on every Argo sync
  while reporting Synced. `scripts/chart-determinism-test.sh` enforces it.
- `DELETE` removes a database's `Backup` records and never the bucket contents.
  Barman's retention policy owns the data, which is the split that keeps drigodb
  from destroying a customer's backups by deleting a Kubernetes object.
