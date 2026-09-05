---
date: 2026-09-05
status: accepted, not built
topic: gitops
related:
  - docs/diagrams/deploy-flow.md
  - docs/decisions/0001-instance-per-database-over-a-shared-cluster.md
---

# GitOps for the control plane, and not for the data plane

**"Reconciler" below means a Kubernetes controller — Flux or Argo CD — running inside the cluster,
pulling desired state from this repository and applying it. The OpenGitOps principles call it a
"software agent"; that word has since been taken.**

**Decision:** adopt pull-based reconciliation for the control plane, with **manual pin promotion** and
**no image automation writing to the repository**. The data plane stays API-provisioned, because it
cannot be anything else.

Nothing here is built. It is recorded now because the alternative is re-arguing it every time the
deploy path is touched, and because one thing shipping today quietly contradicts it.

## What is already true

Half of what people mean by GitOps is in place, and it is worth naming before deciding to "adopt" it.

The chart pins the data-plane images in Git. The control plane reads them and stamps them
into every StatefulSet it renders, so provisioning or waking a database pulls the image Git names. The
template-hash reconcile in `src/k8s/provisioner.ts` converges *existing* databases onto it at their next
wake. Desired state in Git, observed state in the cluster, a loop closing the gap.

The promotion path is GitOps-shaped too. CI publishes a build, files a standing issue carrying the exact
diff, and a human merges the pin. That is the promotion model with an issue standing in for a bot pull
request.

What is missing is not the idea. It is that the loop runs inside the API process rather than a reconciler,
fires on wake rather than continuously, and covers the data plane rather than the control plane.

## The contradiction shipping today

`scripts/deploy.sh` resolves the newest `v` tag **at apply time** and substitutes it into the manifest.

That is the one thing GitOps genuinely forbids: two clusters applying the same commit a week apart get
different images, so a commit does not describe a deployment. Everything else here is a matter of
mechanism; this is a matter of whether Git is the source of truth at all, and today it is not — for the
control plane's own image.

Adopting this decision means removing that resolution and pinning the API image in Git like every other
image.

## Why the data plane cannot follow

Tenant databases are created at runtime by customer API calls. Representing them in Git would mean a
commit per signup, and `README.md` already states the opposing position outright: *Kubernetes is the
source of truth. There is no control-plane database: a hosted database is its StatefulSet.*

So the end state has two reconcilers with two sources of truth:

| | Desired state lives in | Reconciled by |
|---|---|---|
| Control plane (`drigodb-system`) | Git | a reconciler in the cluster |
| Hosted databases (`drigodb-databases`) | the cluster, by design | the control plane, on wake |

That is coherent, and it is worth stating plainly because it looks like an inconsistency until you ask
where a database's existence could otherwise be recorded.

It also caps the payoff honestly: the reconciler would manage one Deployment, one Service, two ConfigMaps and
some RBAC, while the component managing hundreds of objects stays imperative because it must.

## Why adopt it anyway

**The push credential disappears.** A reconciler pulling from inside the cluster holds no credential outside
it. That is strictly better than the scoped ServiceAccount token in
[docs/diagrams/deploy-flow.md](../diagrams/deploy-flow.md), which is itself a large improvement on the
account-owner kubeconfig it replaced. The direction of travel is the same one twice.

**Cluster recreation gets simpler, not harder.** Today `doks-up.sh` creates a cluster, mints a
ServiceAccount, pushes three repository secrets, and then someone runs `deploy.sh`. With a reconciler it
installs that and stops; the control plane arrives from Git. Fewer moving parts, and no secrets to
go stale when the cluster is deleted.

**Local verification stops being a parallel path.** The intended development loop ends with a local
cluster pulling published images "as it would remotely". Today that means running `deploy.sh` locally
and trusting it matches what CI does — two code paths pretending to be one. Under a reconciler, a kind
cluster reconciles the same repository with the same controller, and "as it would remotely" becomes true
rather than approximate.

**Drift becomes visible.** Nothing currently notices a hand-edited Deployment.

## Why not image automation

Flux's image-automation controllers close the loop by committing new tags back to the repository. That
reverses a decision already made and load-bearing, stated in `scripts/deploy.sh`:

> Nothing writes the released version back into `deploy/20-api.yaml` any more — that would mean a
> pipeline pushing to main, and a main no one can push to is worth more than the bookkeeping.

The release pipeline creates a tag, and a tag is not a branch, which is what keeps `main` protected
against everything including itself. Trading that for automatic tag bumps is a bad trade at this size.

Manual promotion keeps both properties: Git describes the deployment, and nothing pushes to `main`. The
cost is one merge per release — which the data-plane images already pay, through the standing issue.

## Packaging: a Helm chart, because drigodb is software other people install

Amended 2026-09-05. This originally said `kustomize`, on the grounds that it keeps `deploy/*.yaml` as
valid manifests anyone can read, diff and `kubectl apply -f` by hand — the property the `sed` approach
was written to preserve.

That reasoning holds and is now outweighed. **drigodb is intended to be installed by others on their own
clusters**, and a chart is what people expect to install. `kustomize` overlays are for composing
manifests you own; Helm is for distributing an application you do not run.

The cost is real and worth naming: **templates are not valid YAML until rendered**, so the
read-diff-apply-by-hand property goes. `helm template` recovers most of it, but not the ability to point
`kubectl` at a file in the repository.

What it buys beyond distribution is that **drigodb's own deployment becomes the chart with drigodb's own
values**. One artefact rather than two, and no risk of the packaging others use drifting from the
packaging that is actually exercised — which is the same class of problem as a stand-down check that
never used the credential it was checking.

It also fits the reconciler better than the overlay would have. Flux and Argo CD both reconcile a
`HelmRelease` natively, so per-environment values replace per-environment overlays.

Things that stop being defaults and become values someone must set:

- `DRIGODB_STORAGE_CLASS`, which defaults to `do-block-storage` and is meaningless anywhere else
- the namespace names, which were hardcoded in the manifests the chart replaced
- the image pins, the backup destination, and the API token

`src/config.ts` is already thirteen environment variables with fallbacks, so the configurable surface
exists — this exposes it rather than inventing it.

**Not decided here:** whether the published images are public. Nobody can install a chart whose images
they cannot pull, so that is a prerequisite to distribution rather than a consequence of it.

## Prerequisites

Nothing can reconcile a shell script, so `deploy.sh`'s imperative parts have to go first. That work
is worth doing on its own merits and does not commit anyone to this decision:

- the API image pinned in Git, not resolved from the newest tag at apply time
- a Helm chart instead of `sed` substitution — see below
- the API token as a Secret that already exists, rather than one generated from `/dev/urandom` at deploy
  time — a reconciler would fight a token that is regenerated on every apply
- ConfigMaps as manifests rather than `kubectl create --dry-run | apply`

## What this does not decide

Which reconciler. Flux's source and helm controllers are the smaller fit — Argo CD brings a UI and an
account model that one operator and one consumer do not need — but that comparison should be made
against a prerequisite branch that actually exists, not in the abstract. Both handle Helm natively, so
the packaging decision below does not constrain it.

**And it does not decide when.** The measured constraint from
[0001](0001-instance-per-database-over-a-shared-cluster.md) applies: a `s-1vcpu-2gb` node fits two
databases, and a controller set costs roughly one of them. That is an argument about the deliberately
cheap test cluster rather than about the design, and it is a real cost to weigh on the day, not a reason
to reject the direction.
