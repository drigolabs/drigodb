---
date: 2026-09-05
topic: deploy-flow
status: target — not built; see the transition at the end
related:
  - docs/decisions/0002-gitops-for-the-control-plane.md
  - .github/workflows/release.yml
  - scripts/doks-up.sh
---

# How a merge should reach a cluster

**This is the target, not what runs today.** Today CI pushes to the cluster with a ServiceAccount
token; [decision 0002](../decisions/0002-gitops-for-the-control-plane.md) chose pull-based
reconciliation instead, and issues #48–#51 are the distance between the two. The transition table at
the end says which piece moves when.

**"Reconciler" throughout means a Kubernetes controller — Flux or Argo CD — running inside the cluster,
pulling desired state from this repository and applying it.** The OpenGitOps principles call it a
"software agent", which was unambiguous when they were written and is not any more.

The shape it is aiming at: **CI never touches the cluster.** It publishes an image and says so. A
reconciler inside the cluster converges on what Git declares. The only credential that ever leaves a
laptop is one that can write to GHCR.

## 1. Bootstrap — `scripts/doks-up.sh`, run by a human

Every strong credential is used here, once per cluster, and none of it leaves the machine.

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant Up as doks-up.sh
    participant DO as DigitalOcean API
    participant K8s as Cluster
    participant Repo as Git repository

    Dev->>Up: bash scripts/doks-up.sh
    Note over Up,DO: doctl is authenticated locally<br/>with an account-owner token

    Up->>DO: create cluster (starts billing)
    DO-->>Up: cluster running
    Up->>DO: kubeconfig save
    Note right of DO: cluster-admin, because DigitalOcean<br/>has no lesser kubeconfig to issue
    DO-->>Up: kubeconfig

    Up->>K8s: install the reconciler, pointed at the repository
    Up->>K8s: create the API token Secret
    Note right of K8s: Created once, never regenerated.<br/>A manifest that MINTS a token would<br/>rotate every consumer's credential<br/>on each sync. See #49.

    K8s->>Repo: read (deploy key, or a public repo)
    Note over K8s,Repo: The reconciler pulls. Nothing is pushed to it,<br/>so no credential for this cluster exists<br/>anywhere outside it.
```

No ServiceAccount minted for CI, no repository secrets pushed, and nothing to go stale when the cluster
is deleted.

## 2. Release — `.github/workflows/release.yml`, on every merge to `main`

```mermaid
sequenceDiagram
    autonumber
    participant Main as main branch
    participant CI as GitHub Actions
    participant GHCR as ghcr.io
    participant Issue as Standing issue

    Main->>CI: push
    CI->>CI: decide the version<br/>(Conventional Commits since the last tag)
    Note over CI: docs: or chore: only → no release
    CI->>CI: typecheck and test
    CI->>GHCR: build + push amd64, arm64
    Note right of GHCR: GITHUB_TOKEN, packages: write.<br/>The only credential CI holds.
    CI->>Main: tag vX.Y.Z + GitHub release
    Note right of Main: contents: write, for the tag alone.<br/>Nothing pushes to main — not even this.
    CI->>Issue: rewrite with the diff that moves the pin
    Note over CI,Issue: There is no deploy job. CI has no<br/>kubeconfig, no token, and no route<br/>to any cluster.
```

The release ends at "published, and here is the one-line change that would ship it". It cannot deploy
what it just built, because the commit being released does not yet name the image it is about to
produce. That is the cost 0002 accepts: **publishing and promoting are two merges.**

## 3. Promotion and reconciliation

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant Repo as Git repository
    participant Recon as Reconciler (in cluster)
    participant K8s as Cluster
    participant API as drigodb-api

    Dev->>Repo: merge the pin bump (one line in the overlay)
    loop every sync interval
        Recon->>Repo: pull
        Recon->>Recon: render the chart with this cluster's values
        Recon->>K8s: apply what differs
    end
    K8s->>API: roll the Deployment onto the new image
    API-->>K8s: Ready

    Note over Recon,K8s: Drift is corrected the same way.<br/>A hand-edited Deployment is reverted<br/>on the next sync rather than surviving<br/>until someone notices.
```

A local `kind` cluster reconciling the same repository runs **this same loop with the same controller**
(#52). That is what makes "test locally as it would behave remotely" true rather than approximate —
today it means running `deploy.sh` by hand and trusting it matches CI.

## 4. How a database gets its image — unchanged

Worth showing because it is the part that is already reconciled, and it does not change.

```mermaid
sequenceDiagram
    autonumber
    participant Repo as Git (20-api.yaml)
    participant API as drigodb-api
    participant K8s as Cluster
    participant DB as A hosted database

    Note over Repo: DRIGODB_PG_IMAGE and<br/>DRIGODB_BACKUP_IMAGE are pinned here
    Repo->>API: the reconciler delivers them as env
    API->>API: render the pod template
    API->>K8s: create/patch the StatefulSet
    K8s->>DB: kubelet pulls the pinned image

    Note over API,DB: On wake, the API compares a hash of the<br/>rendered template against one recorded on<br/>the StatefulSet, and rewrites it while<br/>replicas are 0 — where there is no pod to<br/>roll and the change is free.
```

The data plane is **not** reconciled from Git and cannot be: a hosted database is created at runtime by
a customer's API call, and representing it in Git would mean a commit per signup. So there are two
reconcilers — the reconciler converging the control plane on Git, and the control plane converging databases
on its own compiled-in template. 0002 explains why that is coherent rather than inconsistent.

## Which credential does what

| Credential | Held by | Reaches | Used for |
|---|---|---|---|
| DigitalOcean personal token | the laptop, via `doctl auth` | the whole account | creating and deleting the cluster |
| DO-issued kubeconfig | the laptop, transiently | cluster-admin | installing the reconciler |
| `GITHUB_TOKEN` | GitHub Actions | GHCR packages, the repo's tags | publishing images, tagging |
| the reconciler's repository read | inside the cluster | one repository, read-only | pulling desired state |

**Nothing outside the cluster can write to the cluster.** That is the whole point, and it is the third
step in the same direction: an account-owner kubeconfig became a two-namespace ServiceAccount token in
#45, and becomes no external credential at all here.

## The transition

| Moves | Issue |
|---|---|
| API image pinned in Git, not resolved from the newest tag at apply time | [#48](https://github.com/drigolabs/drigodb/issues/48) |
| `deploy.sh`'s `sed`, generated token and `--dry-run \| apply` become a Helm chart | [#49](https://github.com/drigolabs/drigodb/issues/49) |
| Flux or Argo CD chosen, measured on a real node | [#50](https://github.com/drigolabs/drigodb/issues/50) |
| Reconciler installed by `doks-up.sh`; deploy job and its three secrets deleted | [#51](https://github.com/drigolabs/drigodb/issues/51) |
| A local cluster runs the same loop | [#52](https://github.com/drigolabs/drigodb/issues/52) |

Until #51, the flow that actually runs is a push from CI holding
`DRIGODB_DEPLOY_TOKEN` — a ServiceAccount scoped to two namespaces, created by `doks-up.sh` and
described in `deploy/05-deployer-rbac.yaml`.
