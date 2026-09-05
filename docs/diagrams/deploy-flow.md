---
date: 2026-09-05
topic: deploy-flow
status: current
related:
  - .github/workflows/release.yml
  - scripts/doks-up.sh
  - deploy/05-deployer-rbac.yaml
  - docs/decisions/0001-instance-per-database-over-a-shared-cluster.md
---

# How a merge reaches a cluster

Three separate flows, and the interesting part is which credential each one holds.

The short version: **the privileged step happens on a laptop, once per cluster. CI holds a credential
that can deploy drigodb and nothing else, and never talks to DigitalOcean at all.**

## 1. Bootstrap — `scripts/doks-up.sh`, run by a human

This is where every strong credential is used, and where the weak one CI gets is minted.

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant Up as doks-up.sh
    participant DO as DigitalOcean API
    participant K8s as Cluster (kube-apiserver)
    participant GH as GitHub repo secrets

    Dev->>Up: bash scripts/doks-up.sh
    Note over Up,DO: doctl is already authenticated<br/>with a personal token — account owner

    Up->>DO: create cluster (starts billing)
    DO-->>Up: cluster running
    Up->>DO: kubeconfig save
    Note right of DO: DigitalOcean has no lesser<br/>kubeconfig to issue. This one<br/>authenticates as the ACCOUNT OWNER<br/>and is cluster-admin.
    DO-->>Up: kubeconfig (cluster-admin)

    Up->>K8s: apply 00-namespaces.yaml
    Up->>K8s: apply 05-deployer-rbac.yaml
    Note right of K8s: ServiceAccount drigodb-deployer<br/>+ ClusterRole (namespaces only)<br/>+ Roles in the two namespaces
    K8s-->>Up: token Secret populated by the controller

    Up->>K8s: read drigodb-deployer-token
    K8s-->>Up: ServiceAccount token (scoped)
    Up->>GH: gh secret set DRIGODB_DEPLOY_TOKEN
    Up->>GH: gh secret set DRIGODB_CLUSTER_SERVER
    Up->>GH: gh secret set DRIGODB_CLUSTER_CA
    Note over Up,GH: gh is authenticated locally too.<br/>Both admin credentials stay on the laptop.
```

The cluster-admin kubeconfig never leaves the machine. Neither does the DigitalOcean token. What
reaches GitHub is a ServiceAccount token that cannot delete nodes, cannot read Secrets in
`kube-system`, and cannot create ClusterRoleBindings.

## 2. Release — `.github/workflows/release.yml`, on every merge to `main`

```mermaid
sequenceDiagram
    autonumber
    participant Main as main branch
    participant CI as GitHub Actions
    participant GHCR as ghcr.io
    participant GH as Repo secrets
    participant K8s as Cluster
    participant API as drigodb-api

    Main->>CI: push
    CI->>CI: decide the version<br/>(Conventional Commits since the last tag)
    Note over CI: docs: or chore: only → no release, and<br/>every job below is skipped

    CI->>CI: typecheck and test
    CI->>GHCR: build + push amd64, arm64
    Note right of GHCR: GITHUB_TOKEN, packages: write.<br/>Publishing never touches the cluster.
    CI->>GHCR: bind both architectures to one tag
    CI->>Main: tag vX.Y.Z + GitHub release
    Note right of Main: contents: write, for the tag only.<br/>Nothing pushes to main.

    rect rgba(128,128,128,0.12)
        Note over CI,API: deploy to DOKS — contents: read only
        CI->>GH: read DRIGODB_DEPLOY_TOKEN / _SERVER / _CA
        alt secrets absent
            GH-->>CI: nothing
            CI-->>Main: stand down — image published, deploy skipped
        else secrets present
            GH-->>CI: token, server URL, CA
            CI->>CI: build a kubeconfig from them
            CI->>K8s: get namespace drigodb-system (20s timeout)
            Note right of K8s: The check USES the deploy credential.<br/>Asking a provider API whether the cluster<br/>exists is not the same question.
            alt unreachable
                K8s-->>CI: timeout / refused
                CI-->>Main: stand down — cluster is gone, image published
            else reachable
                K8s-->>CI: ok
                CI->>K8s: scripts/deploy.sh<br/>(namespaces, RBAC, ConfigMaps, Secret, Deployment)
                CI->>K8s: kubectl rollout status
                K8s-->>CI: drigodb-api Ready
                CI->>API: port-forward → GET /healthz
                API-->>CI: {"status":"ok","version":"X.Y.Z"}
                CI->>CI: assert the version served == the version released
            end
        end
    end
```

The two stand-down branches are the normal state of the world, not failures: the cluster is torn down
between sessions because DOKS bills whether or not anyone is connected. A merge with no cluster
running publishes the image and says so.

## 3. Teardown — `scripts/doks-down.sh`

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant Down as doks-down.sh
    participant DO as DigitalOcean API
    participant GH as Repo secrets

    Dev->>Down: bash scripts/doks-down.sh
    Down->>Dev: type the cluster name to confirm
    Down->>DO: delete cluster
    Down->>DO: sweep volumes DOKS left behind
    Note right of DO: cluster delete does not remove the<br/>block volumes PVCs provisioned
    Note over GH: The secrets are now stale, and that is fine.<br/>The next release's reachability check fails<br/>and it stands down. doks-up.sh mints new ones.
```

## Which credential does what

| Credential | Held by | Reaches | Used for |
|---|---|---|---|
| DigitalOcean personal token | the laptop, via `doctl auth` | the whole DO account | creating and deleting the cluster |
| DO-issued kubeconfig | the laptop, transiently | cluster-admin — nodes, every Secret | bootstrapping the deployer |
| `gh` auth | the laptop | the repository | writing the three secrets |
| **`DRIGODB_DEPLOY_TOKEN`** | **GitHub Actions** | **two namespaces, no nodes, no `kube-system`** | **deploying** |
| `GITHUB_TOKEN` | GitHub Actions | GHCR packages, the repo's tags | publishing images, tagging |

Everything above the bold row stays local. The only long-lived credential outside the laptop is the
one that can deploy drigodb and nothing else.

## Why it is shaped this way

The pipeline used to hold a DigitalOcean token and exchange it for a kubeconfig on every deploy. That
kubeconfig is cluster-admin, because DigitalOcean has no other kind — so asking for one *is* asking for
cluster-admin, and a leaked repository secret reached the whole account rather than one deployment.

Moving the mint to `doks-up.sh` costs nothing, because that script already runs as an administrator:
creating a cluster requires one. The privileged step was always there. It just also used to happen in
CI, on every release, forever.

**The reachability check is the other half.** It used to ask DigitalOcean whether the cluster existed —
something a read-scoped token can do — so it passed while the very next call failed `403`, and seven
consecutive releases reported a successful deploy without ever deploying. A check that does not
exercise the credential it is checking is not a check. See
[#15](https://github.com/drigolabs/drigodb/issues/15).

## The credential dies with the cluster

Deliberately. `doks-down.sh` deletes the cluster and the ServiceAccount with it, leaving three secrets
that authenticate to nothing. That is the desired end state: a credential which outlives the thing it
grants access to is a credential nobody remembers to revoke.
