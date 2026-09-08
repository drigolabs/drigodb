# Spike: a proxy in the connection path

Throwaway code, kept as evidence for
[decision 0007](../../decisions/0007-a-proxy-in-the-connection-path.md). Not a
component, not built, not maintained.

`proxy.mjs` is the smallest thing that could answer four questions the record
asserted and had not shown. Run on kind in front of a real CloudNativePG
database, with drigodb's Service repointed at it:

| | |
|---|---|
| Does splicing work at all? | Yes — `psql` through it at the unmodified URI |
| Does a client tolerate a wake mid-connection? | Yes — 11s, **no retry logic and no wake call** |
| Does `verify-full` survive a spliced handshake? | Yes — the client validates the database's certificate through a proxy holding none |
| Does a shared proxy collapse the NetworkPolicy? | **Yes** — an unlabelled pod reached a database it is meant to be refused |

It deliberately lacks everything a real one would need: pooling, backpressure,
timeouts, metrics, cancellation, graceful shutdown, and any notion of who the
client is. That last one is the interesting absence — re-implementing the
`drigodb.io/allow-database` check means resolving a source IP to a pod and
reading its labels on every connection, and it is the difference between this
being a hundred lines and being a component.

## Running it

Needs a kind cluster with drigodb, a provisioned database, and the proxy
deployed with `DRIGODB_API` and `DRIGODB_TOKEN` set. Then repoint the database's
Service at it:

```bash
kubectl -n drigodb-databases patch svc db-<id> --type=json \
  -p '[{"op":"replace","path":"/spec/selector","value":{"app":"spike-proxy"}}]'
```

A merge patch will not do: it merges the selector rather than replacing it, and
the Service ends up selecting nothing.
