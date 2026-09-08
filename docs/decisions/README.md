# Decision records

Decisions that shaped drigodb, with the reasoning that produced them and the evidence behind it —
recorded so that a later reader can tell a deliberate choice from an accident, and so that reversing one
means arguing with the reasoning rather than guessing at it.

Most are `decided`. One — [0007](0007-a-proxy-in-the-connection-path.md) — is `proposed`: it reverses a
property three other records rest on, and is written down so the decision is made deliberately rather
than by whoever implements it first.

| Record | Decision |
|---|---|
| [Leaving DocumentDB](../leaving-documentdb.md) | Drop MongoDB wire-protocol compatibility, the extension and the gateway; applications speak PostgreSQL |
| [0001 — Instance per database over a shared cluster](0001-instance-per-database-over-a-shared-cluster.md) | Keep one PostgreSQL instance per hosted database; the shared tier is possible but not built |
| [0002 — GitOps for the control plane](0002-gitops-for-the-control-plane.md) | Pull-based reconciliation for the control plane, manual pin promotion, nothing writing to `main`; the data plane stays API-provisioned |
| [0003 — Argo CD](0003-argo-cd.md) | Argo CD reconciles drigodb's own cluster, chosen on familiarity; the chart stays renderer-agnostic and requires nothing of anyone else |
| [0004 — CloudNativePG for the data plane](0004-cloudnativepg-for-the-data-plane.md) | A hosted database becomes a CNPG `Cluster` rather than a StatefulSet drigodb assembles; high availability is opt-in per database |
| [0005 — An HTTP API, not a CRD](0005-an-http-api-not-a-crd.md) | Desired state arrives over HTTP because OpenVoid is the consumer; the CRD is shelved with the trigger that would revive it |
| [0006 — Nothing inside a hosted database](0006-nothing-inside-a-hosted-database.md) | drigodb owns the database, the role and the volume and puts no schema of its own inside; the migration runner and its ledger are removed |
| [0007 — A proxy in the connection path](0007-a-proxy-in-the-connection-path.md) | **Proposed.** Whether a client's connection should pass through drigodb, which would buy wake-on-connect and an exact idleness signal at the cost of serving no longer being independent of the control plane |
| [0008 — Mechanism in the core, policy outside](0008-mechanism-in-the-core-policy-outside.md) | drigodb provides hibernate, wake, backup and the rest; deciding *when* belongs to a layer above it, built after the core is stable |

`leaving-documentdb.md` predates this folder and stays where it is: the README, several issues and a
merged pull request link to it by path. Worth consolidating the next time something else moves.

[deploy-flow.md](../diagrams/deploy-flow.md) draws where the second of those decisions leads — how a merge
should reach a cluster, and which credential each step holds. It is a target, and it names the issues
that close the gap.

Supporting material lives alongside rather than inside: [the multitenancy
spike](../documentdb-multitenancy-spike.md) is the evidence both records rest on, and
[storage-tiers.md](../storage-tiers.md) is design rather than decision.
