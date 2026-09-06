---
date: 2026-09-06
status: decided
topic: interface
related:
  - docs/decisions/0002-gitops-for-the-control-plane.md
  - docs/decisions/0004-cloudnativepg-for-the-data-plane.md
  - docs/consuming-drigodb.md
---

# An HTTP API, not a CRD

**Decision: desired state reaches drigodb over HTTP.** A `Database` custom
resource is not built, and the label-based state that stands in for one is
accepted rather than replaced.

**Because OpenVoid is the consumer drigodb is for.** Others installing it into
their own cluster are a welcome side effect and do not get a vote on this.

## The question

drigodb stores its state in labels on the objects it creates —
`drigodb.io/tier`, `drigodb.io/external-id`, `drigodb.io/template-hash`,
`drigodb.io/hibernated`. That is an ad-hoc custom resource written in label
soup, and [0004](0004-cloudnativepg-for-the-data-plane.md) makes it more
obviously so: once CloudNativePG owns the `Cluster`, drigodb's own object has no
home but someone else's spec.

The alternative posture is a `Database` CRD as the source of truth with the HTTP
API as a client of it. It is the conventional answer and it is genuinely better
for a certain consumer.

## Why the conventional answer loses here

A CRD's advantages are all advantages *for a cluster operator*, and they
evaporate under a single sophisticated consumer calling an API from a backend:

| the CRD would buy | under OpenVoid |
|---|---|
| a Secret in the consumer's namespace, ending "store the URI or lose it" | OpenVoid has its own database and writes the URI down. The hazard is real for a crowd of app teams and not for one backend. |
| namespace RBAC deciding who may create a database | one consumer, one token. There is nothing to decide. |
| declaring a database in git, consistent with [0002](0002-gitops-for-the-control-plane.md) | OpenVoid provisions at runtime, for a tenant who signed up ninety seconds ago. There is no git commit to make. |
| level-triggered reconciliation | worth having, and reachable without a CRD. |

Against that, a CRD costs a controller-shaped component in TypeScript, a second
interface with its own failure modes, and the legibility this repository is
built on.

## What this decides about #72

[#72](https://github.com/drigolabs/drigodb/issues/72) — a database belonging to
the token that created it — was filed as the control that makes drigodb
multi-tenant. With one consumer holding one token it is close to a no-op: **the
tenancy that matters is OpenVoid's tenants, and they are separated by
`external_id`, not by token.** It drops down the backlog rather than out of it.

That leaves a real exposure stated wrongly elsewhere.
[#76](https://github.com/drigolabs/drigodb/pull/76) made database ids derivable
from `external_id` and named #72 as the control that would replace the
NetworkPolicy's contribution. It is not, and now it is not coming either. **If
App Maker runs generated tenant workloads in this cluster, one tenant's pod can
label itself with another tenant's database id and reach it.** The password
still holds; the network layer no longer does. A namespace per tenant is the
fix, and whether it is urgent depends on where generated apps run.

## What would reverse this

- drigodb being installed by people who are not OpenVoid, in numbers, asking to
  declare databases rather than call them. The side effect becoming the point.
- The label-based state becoming genuinely unworkable under
  [0004](0004-cloudnativepg-for-the-data-plane.md) rather than merely inelegant.

Neither is true today. Revisit rather than assume.

## The ambition this serves, and where it falls short

The target is Neon's ergonomics without a vendor in the middle. Two things make
Neon what it is for an application builder, and drigodb has half of one:

**Scale to zero by default.** Neon hibernates an idle database and wakes it on
connection. drigodb hibernates only when asked —
`docs/consuming-drigodb.md` says so outright. For a consumer whose output is
mostly abandoned within a week, automatic hibernation is not a feature, it is
the economic model.

**Branching.** An instant copy-on-write database per preview, per agent run.
[#42](https://github.com/drigolabs/drigodb/issues/42) already provisions a
database from a backup, which is the slow relative. A CSI `VolumeSnapshot` plus
a cluster bootstrapped from it is plausibly the fast one — an argument for
[0004](0004-cloudnativepg-for-the-data-plane.md) that has nothing to do with
high availability.

## The collision this record does not resolve

Automatic hibernation asks for wake-on-connect, and **wake-on-connect needs
something in the connection path.**

drigodb's defining property is that consumers connect straight to their database
and never through the control plane. It is the blast-radius argument in
[#11](https://github.com/drigolabs/drigodb/issues/11) and the substance of
`docs/service-boundary.md`: an API outage stops provisioning, not serving. Neon
puts a proxy there, which is how a cold database wakes because a request
arrived rather than because a client remembered to ask.

Without one, every application OpenVoid generates carries wake-and-retry logic —
possible, since OpenVoid writes that code, but it makes the app maker
responsible for a lifecycle Neon's users never see.

This is left open deliberately. It should be decided after the hibernation spike
says what a wake costs under CloudNativePG, and not by accident afterwards.
