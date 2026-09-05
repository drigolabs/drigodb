# Decision records

Decisions that shaped drigodb, with the reasoning that produced them and the evidence behind it —
recorded so that a later reader can tell a deliberate choice from an accident, and so that reversing one
means arguing with the reasoning rather than guessing at it.

| Record | Decision |
|---|---|
| [Leaving DocumentDB](../leaving-documentdb.md) | Drop MongoDB wire-protocol compatibility, the extension and the gateway; applications speak PostgreSQL |
| [0001 — Instance per database over a shared cluster](0001-instance-per-database-over-a-shared-cluster.md) | Keep one PostgreSQL instance per hosted database; the shared tier is possible but not built |
| [0002 — GitOps for the control plane](0002-gitops-for-the-control-plane.md) | Pull-based reconciliation for the control plane, manual pin promotion, nothing writing to `main`; the data plane stays API-provisioned |

`leaving-documentdb.md` predates this folder and stays where it is: the README, several issues and a
merged pull request link to it by path. Worth consolidating the next time something else moves.

[deploy-flow.md](../diagrams/deploy-flow.md) draws where the second of those decisions leads — how a merge
should reach a cluster, and which credential each step holds. It is a target, and it names the issues
that close the gap.

Supporting material lives alongside rather than inside: [the multitenancy
spike](../documentdb-multitenancy-spike.md) is the evidence both records rest on, and
[storage-tiers.md](../storage-tiers.md) is design rather than decision.
