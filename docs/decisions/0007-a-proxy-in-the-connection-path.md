---
date: 2026-09-08
status: proposed
topic: connection path
related:
  - docs/service-boundary.md
  - docs/decisions/0004-cloudnativepg-for-the-data-plane.md
  - docs/decisions/0005-an-http-api-not-a-crd.md
---

# A proxy in the connection path

**Proposed, not decided.** Every other record here says `decided`; this one
asks for a decision, because it reverses a property three of them rest on and
should not be settled by whoever implements it.

**The question: should a client's connection to a hosted database pass through
something drigodb runs?**

## Why it comes up now

Automatic hibernation ([#85](https://github.com/drigolabs/drigodb/issues/85))
is the economic argument for drigodb's design — a fleet of mostly-abandoned
applications costs a running pod each until something sleeps them. Two things
stopped it shipping.

**Nothing wakes a database when a client connects.** A slept database refuses
the next connection, and every application has to call `wake` and retry. That is
tolerable when one party writes every client and wrong for anything else.

**Idleness was sampled, and sampling is the wrong shape.** drigodb counted open
connections on an interval, so a workload that connects, queries and disconnects
could be missed by every sample and hibernated while in use — measured at a 67%
chance for a database used once a minute, on the interval originally shipped.

The proper fix for the second is an activity *event* rather than a sample. The
only event source available today is PostgreSQL's own connection log, which
means turning on `log_connections` and streaming every database's pod log —
and a stream that breaks silently expires every deadline and sleeps the whole
fleet. It fails dangerous where the current design fails safe.

A proxy answers both. It sees every connection open and close, so activity is an
event; and it is in the path, so it can wake a database while the client waits.

## The mechanism, measured rather than assumed

Every drigodb database is `app`/`appuser`, so the PostgreSQL startup packet is
identical across the fleet and cannot say which database a connection wants.
The only discriminator is the hostname, and it arrives before any credential:

PostgreSQL's TLS is not TLS-first. The client sends an 8-byte `SSLRequest` in
the clear, the server answers `S`, and only then does the handshake begin — so
the ClientHello, and its SNI, are readable by anything sitting in front.

Confirmed against `libpq` in the CloudNativePG image:

```
psql "…?sslmode=require"            →  SNI=<the hostname>
psql "…?sslmode=require&sslsni=0"   →  SNI=(none)
```

So:

1. Client connects to `db-<id>.…svc.cluster.local:5432` — **the hostname it
   already holds**, because the URI is issued once and never reissued.
2. Proxy accepts, reads `SSLRequest`, answers `S`.
3. Proxy reads the ClientHello and takes the SNI. The id is in the hostname; no
   lookup table.
4. If that database is hibernated, the proxy wakes it **and waits**.
5. Proxy dials the database, sends its own `SSLRequest`, and from there splices
   raw bytes.

Two things follow from step 5 and they are why this shape and not another.

**The proxy never terminates TLS.** It relays ciphertext, so the handshake is
between client and database. No certificate lives in the proxy, and
`sslmode=verify-full` keeps meaning what it means today: the client validates
the database's own certificate, issued by drigodb's CA and naming that
database's Service.

**The wake happens inside connection establishment.** The client's socket is
already open and waiting on a handshake, so a twelve-second wake is a slow
connect rather than a failure. **No client needs retry logic.**

## What it buys

- Wake-on-connect, which is what makes automatic hibernation usable by anything
  other than a client its author controls.
- An exact activity signal, for free. No sampling, no `log_connections`, no log
  streaming, no shipper — and the queue design #85 wants gets its events from
  something already in the path.
- The connection URI is unchanged. The Service keeps its name and points at the
  proxy instead of the database.

## What it costs

**Serving stops being independent of drigodb.** This is the decision, and the
rest is detail. `docs/service-boundary.md` and
[#11](https://github.com/drigolabs/drigodb/issues/11) both rest on the same
sentence: an outage of the control plane stops provisioning, waking and
hibernating — **not serving**, because consumers connect to their database
directly. A proxy reverses that. drigodb becomes the most availability-critical
thing in the installation, needs to be highly available in a way it currently
does not, and a bad deploy takes every database with it rather than pausing
administration.

**The per-database NetworkPolicy collapses into the proxy.** Today each database
admits only pods labelled `drigodb.io/allow-database: <id>`, one of three
isolation layers. With a shared proxy, clients reach the proxy and the proxy
reaches everything. Unless it re-implements that check — resolving a source IP
to a pod and reading its labels, per connection — tenant isolation reduces to
the password alone. That is a real loss and it is invisible on a diagram.

**SNI is the client's to withhold.** `sslsni=0` disables it and an IP-literal
host sends nothing useful. Those connections cannot be routed and must be
refused loudly rather than guessed at.

**And it is a network proxy for a wire protocol**, which is a thing to own: a
long-lived, latency-sensitive component on the data path, with its own failure
modes, its own memory profile per connection, and its own release risk.

## The alternative

Do none of it. Clients call `wake` and retry; idleness stays sampled or
hibernation stays off.

This is not a bad answer for the consumer drigodb is actually for. App Maker
writes every generated application, so wake-and-retry can live in a template
rather than in a user's hands — [0005](0005-an-http-api-not-a-crd.md) makes the
same argument for choosing HTTP over a CRD, and it holds here.

What it forfeits is drigodb being usable by anyone who did not write their
client, and the ability to say the ergonomics match Neon's rather than
approximate them.

## Recommendation

**Not yet, and not never.** Ship nothing that depends on it until the
consumer is real: integrate App Maker against wake-and-retry, find out whether
the retry is actually a burden, and let that decide.

The reason to wait is not the work, it is that this trades a property away
permanently and the case for it is currently theoretical. Nobody has yet been
annoyed by a retry.

The reason it may still be right is that the property being traded is worth less
than it sounds once hibernation is on: a database that is asleep is already
unavailable until something wakes it, and today the only thing that can is a
control plane the consumer must reach anyway.

## What would change the answer

- App Maker's generated clients finding wake-and-retry genuinely awkward, or
  drigodb acquiring a consumer who did not write their own client.
- Automatic hibernation shipping and its sampling proving unacceptable, with no
  cheaper event source than the connection log.
- A decision that Neon-shaped ergonomics are a product requirement rather than a
  comparison.
