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
npm run test:coverage             the same, with a coverage summary
npm run typecheck                 tsc --noEmit
bash scripts/kind-up.sh           a real cluster on a laptop, via scripts/deploy.sh
bash scripts/kind-down.sh         tear it down — do this, kind clusters are not free RAM
bash scripts/smoke.sh             end-to-end against a running installation
bash scripts/chart-determinism-test.sh    renders the chart twice, asserts identical
bash scripts/diagram-render-test.sh       every mermaid block in docs/ actually renders
bash scripts/install-failure-test.sh      its own kind cluster, deliberately broken
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

## Decision records

**A feature whose shape was a choice gets an ADR in `docs/decisions/`, in the same pull
request.** Not after, and not only for the big ones — the record is cheapest to write
while the alternatives are still in mind, and worthless once the reasoning has to be
reconstructed from the diff.

What makes a record worth having is the part that is hardest to recover later:

- **The alternatives, each with why not.** A table. A record that states only what was
  decided is a changelog entry; the value is in the options that were live at the time,
  because those are exactly what the next person will propose.
- **The trade, named.** Every decision here costs something — `0009` shares one id space
  between admin tokens, `0007` puts a hop in the connection path. A record that lists no
  cost has not finished thinking.
- **What prompted it**, concretely, with the measurement if there was one. `0008` exists
  because automatic hibernation had a 67% chance of hibernating a database in use.
- **What it does NOT protect or promise.** `0009` does not change the network layer, and
  saying so stops it being read as more than it is.

One record per decision, not per feature: `0009` covers two issues because identity and
ownership are one choice, and neither is coherent alone. Two features that made no real
choice need no record between them.

Index it in `docs/decisions/README.md` under the right grouping, and draw it if the
sequence is where the subtlety lives — `docs/diagrams/` is part of the record, not
decoration.

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

## Pins

Every upstream version lives in `scripts/versions.env`, and the chart's
`appVersion` is the API image a default install pulls. **Renovate proposes the
bumps; a person merges them.** `renovate.json` names a datasource per pin, one
pull request each — a batched bump is a batched revert, and these fail in
unrelated ways.

Nothing automated writes to `main`. Renovate runs as an app and opens a pull
request, which is the whole reason it was chosen over Flux's image automation:
that commits tags back to the repository.

A release cannot pin itself — the commit being released cannot name the image the
release is about to build (`docs/decisions/0002`) — so publishing and promoting
are two merges, and the second one is a Renovate pull request.

Two pins have bitten already, which is why this exists: MinIO was referenced with
no tag at all and its repositories vanished from Docker Hub, breaking every
branch; and `appVersion` sat four releases behind its own chart, so a documented
install could never become ready.

**It then did it again, and the cause is worth knowing: `prConcurrentLimit` is
global.** With three ordinary dependency bumps open, Renovate planned the promotion
branch and never created its pull request — so `appVersion` sat SIX releases behind
while every other pin moved, and the install instructions pointed at a build with none
of that work in it. Nothing reported a problem, because nothing was broken: a PR that
was never opened looks exactly like a pin that is up to date.

The promotion rule carries `prPriority: 10` for that reason. If this recurs, the
question to ask is not whether Renovate is working — it was, and a local
`renovate --platform=local --dry-run=lookup` shows the update in the flattened list —
but whether its pull request can be created at all.

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

A cluster test that reads the wrong pod is the same hazard in a new place, and it
passes. Every `helm upgrade` that changes an environment variable rolls a new
ReplicaSet, so mid-rollout there are three pods — the old one still Ready with the
old configuration, the new one starting, one terminating. `{.items[0]}` picked the
old one and an assertion about a broken configuration read the working one's
answer.

This applies to **`kubectl logs -l …` too**, which is where it recurred a third time:
grepping the API's log for a message that only the NEW configuration prints, with a
selector that also matched the terminating pod, read the old pod's log and asserted
the opposite of the truth. Any `kubectl` call in a test that names pods by app label
alone is this bug waiting to happen.

Select the ReplicaSet by the Deployment's `deployment.kubernetes.io/revision`
annotation, which is what `kubectl rollout` matches on. **Not the newest
`creationTimestamp`**: reverting a value to empty makes the pod template byte
identical to an earlier one, because Kubernetes drops an env var whose value is
`""` — so no new ReplicaSet is created, the FIRST one is scaled back up and its
revision bumped, and the newest by timestamp is a stale one scaled to zero with no
pods in it at all.

A test whose name claims more than its body checks is the same hazard wearing a
better disguise. "Keeps the owner across an in-place restore" tested `buildCluster`
directly — it proved the parameter works, not that `restoreInPlace` passes the right
thing, and the mutation that made it pass the *caller's* owner (an admin silently
taking a tenant's database) went undetected. If an assertion is about what a method
does, call the method.

A cluster assertion whose inputs are empty passes and means nothing. "No Secret
carries both labels" reported success against **zero Secrets of either kind**, because
it ran before any database was provisioned and after its own tokens were revoked. If
an assertion compares or counts two populations, assert each is non-empty first and
fail if it is not — the check that cannot fail is the one that will be trusted.

And do not reach a pod through `kubectl port-forward` in a test. A forward that
outlives its caller keeps the local port, the next one cannot bind it, and reads go
to whichever pod the stale forward points at — silently, and it has already turned
one assertion green while the thing it asserted was untrue. `kubectl exec` into the
pod instead: the API image is node:22-alpine, so `node -e "fetch(...)"` needs no
port, no background process and no curl.

## Do not change silently

- The CI job names `typecheck and test`, `drigodb works end to end` and
  `api image builds` — branch protection on `main` requires them by those exact
  strings, and renaming one blocks every PR on a check that never reports.
  `diagrams render` and `a broken cluster is a loud failure` are not required yet
  and their names are already permanent for the same reason.
- The chart must render identically every time: no `lookup`, no `randAlphaNum`,
  no clock. One `lookup` rotated every consumer's bearer token on every Argo sync
  while reporting Synced. `scripts/chart-determinism-test.sh` enforces it.
- A mermaid diagram must render. `;` is a statement separator inside a sequence
  diagram, so a semicolon in note text — or an HTML entity like `&lt;`, which
  contains one — truncates the statement and the rest is parsed as a diagram
  instruction. The error names a comma several words away, not the cause.
  `scripts/diagram-render-test.sh` catches it and says which line to look at.

- `DELETE` removes a database's `Backup` records and never the bucket contents.
  Barman's retention policy owns the data, which is the split that keeps drigodb
  from destroying a customer's backups by deleting a Kubernetes object. Read that
  last clause: it forbids destroying backups *implicitly*. The explicit,
  separately-confirmed `POST /v1/archives/{id}/purge` is the mechanism that does it
  on purpose, and it refuses any id that still has a `Cluster`.
- The control plane holds no object-storage credential and no S3 client. Anything
  that must touch the bucket runs as a Job with the Secret mounted into the pod,
  which is how drigodb already causes writes it cannot perform
  (`docs/archive-purge.md`).
