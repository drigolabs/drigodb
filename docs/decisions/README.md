# Decision records

Decisions that shaped drigodb, with the reasoning that produced them and the evidence behind it —
recorded so that a later reader can tell a deliberate choice from an accident, and so that reversing one
means arguing with the reasoning rather than guessing at it.

| Record | Decision |
|---|---|
| [Leaving DocumentDB](../leaving-documentdb.md) | Drop MongoDB wire-protocol compatibility, the extension and the gateway; applications speak PostgreSQL |
| [0001 — Instance per database over a shared cluster](0001-instance-per-database-over-a-shared-cluster.md) | Keep one PostgreSQL instance per hosted database; the shared tier is possible but not built |

`leaving-documentdb.md` predates this folder and stays where it is: the README, several issues and a
merged pull request link to it by path. Worth consolidating the next time something else moves.

Supporting material lives alongside rather than inside: [the multitenancy
spike](../documentdb-multitenancy-spike.md) is the evidence both records rest on, and
[storage-tiers.md](../storage-tiers.md) is design rather than decision.
