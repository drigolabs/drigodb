# Working on drigodb

drigodb provisions PostgreSQL databases through an API on Kubernetes. One
StatefulSet per database (`docs/decisions/0001`), installed with the Helm chart
in `charts/drigodb`, reconciled by Argo CD (`docs/decisions/0002`, `0003`).

## Commands

```
npm test                          vitest, no cluster needed
npm run typecheck                 tsc --noEmit
bash scripts/kind-up.sh           a real cluster on a laptop, via scripts/deploy.sh
bash scripts/kind-down.sh         tear it down — do this, kind clusters are not free RAM
bash scripts/smoke.sh             end-to-end against a running installation
bash scripts/chart-determinism-test.sh    renders the chart twice, asserts identical
bash scripts/migrations-test.sh <pg-image>   the real bootstrap.sh, in a container
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
PR with nothing left to merge.

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

- The CI check named `data-plane images work` — branch protection on `main`
  requires it by that exact string, and renaming it blocks every PR on a check
  that never reports.
- The chart must render identically every time: no `lookup`, no `randAlphaNum`,
  no clock. One `lookup` rotated every consumer's bearer token on every Argo sync
  while reporting Synced. `scripts/chart-determinism-test.sh` enforces it.
- `persistentVolumeClaimRetentionPolicy` on the database StatefulSet. The
  alternative deletes a customer's data.
