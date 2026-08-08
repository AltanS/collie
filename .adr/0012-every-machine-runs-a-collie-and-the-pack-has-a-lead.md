# 0012 — Every machine runs a collie; the pack has a lead

Status: **Accepted** (2026-08-06)

Related: [ADR 0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md) (what the protocol is) ·
[ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) (what a peer may do) ·
[ADR 0006](./0006-update-advances-the-checkout-herdr-installed.md) (why action ids are frozen)

## Context

**"Bridge" already means three different things**, and a second machine makes all three ambiguous at
once:

- the **directory** `bridge/`,
- the **process** — though the `systemd --user` unit has always been called `collie`,
- the **concept** — `ARCHITECTURE.md` §2 calls Collie "a Herdr web bridge", and every
  `herdr-plugin.toml` action title says it out loud: *Start web bridge*, *Stop web bridge*, *Show
  bridge URL*, *Bridge status*, *Uninstall web bridge (remove service)*.

It is also **on the wire**: `SnapshotResponse.bridge` (`bridge/types.ts:165`) carries a
`BridgeStatus` meaning *this instance's link to its own mux is connected*.

Two things break it. First, a compiled `collie` binary makes the operator's word for the thing the
**command**, not the directory. Second, once there are N machines, "the bridge" does not say *which*
one — and the one distinction that has to survive every future reader is which machine holds the
front door, because that is a security fact ([ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md)).

Naming was explored three times independently. All three converged on **collie** for the instance and
**pack** for the group. The role names were the contested part.

**Themed role names were considered and rejected**: *alpha*, *shepherd*, *outrider*, *whistle*, and
their relatives. Two reasons, in order of weight:

1. **Plain English wins on the security-relevant surface.** Role names are not decoration here — they
   appear in `collie join`, in `pack status`, in the error a peer returns when it refuses a request,
   and in the paragraph an operator reads while deciding whether to trust a machine with a link that
   types into terminals. A reader who has to learn a metaphor before they know which machine is
   publicly reachable will get it wrong, and getting it wrong is expensive. "Lead" needs no gloss.
2. **"Alpha" carries a dated dominance-hierarchy connotation** — the wolf-pack framing whose original
   research its own author spent years retracting — and it is *also* overloaded in a versioned
   product, where "the alpha" should mean a release.

**"Herd" and "flock" stay reserved for the agents.** That is the existing product frame — Collie is a
phone UI for *your agent herd* — and reusing it for machines would collide the two most important
plurals in the product.

The repo's versioning rule makes vocabulary a **release** concern, not a taste one: renaming a config
key or an action id is MAJOR ("the operator must change something"), renaming an internal identifier
is PATCH. So the ADR's real job is not choosing pretty words — it is recording which surfaces are
frozen, which are free, and how a rename lands.

## Decision

**Every machine runs *a collie*. The group is a *pack*. Its roles are *lead* and *peer*. The verbs
are *join*, *leave* and *promote*. The credential is the *pack secret*.**

**"Bridge" is retired as vocabulary the release the `collie` CLI ships.** From that release, docs and
new code say *a collie* for the instance, *the lead* / *a peer* for roles, *the pack* for the group.
"Bridge" survives only where it names the directory or is quoting history.

**The working placeholders are superseded here.** The M2 tracker specs were written against
*alpha* / *peer* / *pack*; **alpha is out** — read every remaining "alpha" in that milestone as
"lead". No placeholder ever reaches an operator-visible surface (env key, action id, CLI verb, UI
string).

### Surface classification

| Surface | Examples | Rename cost | Rule |
| --- | --- | --- | --- |
| **Wire** | `SnapshotResponse.bridge` / `BridgeStatus` (`bridge/types.ts:165`) | A compatibility event between a cached browser bundle and a running server — service workers serve stale clients after an update (`ARCHITECTURE.md` §5) | **Do not rename a wire field for vocabulary.** If a field must change, add the new name, keep the old one for one MINOR release, remove it in the next with a CHANGELOG note. |
| **Operator-visible** | `COLLIE_*` env keys; `herdr-plugin.toml` action **ids** (`start`, `stop`, `restart`, `update`, `url`, `status`, `uninstall`, `version`); the systemd unit name; CLI verb names | MAJOR — the operator must change something. Action ids carry a second freeze: Herdr <0.8.0 caches the action set at install, so a renamed `update`/`restart` breaks the installs that most need it ([ADR 0006](./0006-update-advances-the-checkout-herdr-installed.md)) | **Frozen.** Not renamed by this decision, now or later, without its own ADR. |
| **Operator-visible, cosmetic** | `herdr-plugin.toml` action **titles**, in-app strings, notification text | A title is not an id — nothing scripts against it | Free to reword; sweep them in the rename change. |
| **Free** | `bridge/` the directory, internal type names, doc prose, test names | Import churn only | Rename when it earns its keep, per the landing rule below. |

### Positions on the two open questions

- **`bridge/` the directory stays.** Renaming it churns every import in the repo for zero operator
  benefit, and the name is *accurate* for what that code is once ADR 0011 holds: the module that
  bridges Collie to a mux on this machine. Revisit only if it is being restructured for an
  independent reason.
- **The machine dimension is operator-visible** — a pack is something the operator builds by hand,
  member by member, with `collie join`. It cannot be an internal concept, so *lead* and *peer* are
  words the operator learns. That is precisely why they are plain English.

### Landing rule

- **A rename lands as one change with its own CHANGELOG entry**, never smeared through feature work.
- **No mass mechanical rename of existing identifiers ahead of the code they live in.** New code is
  born with the new vocabulary; an existing identifier is renamed when its file is being changed for
  another reason. A repo-wide sed against working code buys nothing and costs a diff nobody can
  review.
- **No aliases for free surfaces.** An alias is only for a frozen surface, and it ships with a stated
  removal release.
- **Already settled, not re-litigated here**: the `COLLIE_*` env prefix, the plugin id `herdr.collie`,
  the unit name `collie`.

## Consequences

- **Two vocabularies coexist for a while** — deliberately, and bounded by the landing rule. The
  alternative (rename everything the day the word changes) is a large unreviewable diff; the cost of
  *not* deciding is three vocabularies at once (bridge / the tracker's placeholders / whatever
  eventually ships) and docs that say "the bridge" in a world with five of them.
- **`SnapshotResponse.bridge` keeps a name the docs no longer use.** Accepted. It is arguably already
  misnamed — it reports the *mux link*, not the process — which makes it a candidate for a
  meaning-driven rename later, on the add-then-remove rule above. Vocabulary alone never justifies it.
- **"Lead" collides with nothing in Collie's namespace** — `session`, `space`, `tab`, `pane`, `agent`
  and `herd` are all taken and all untouched. In prose it is always *"the lead"*, never a bare verb.
- **The doc sweep is a list, not an excavation.** README, ARCHITECTURE, CLAUDE.md, HERDR_API.md,
  HARNESS_CONTRIBUTING.md, the plugin action titles, and the in-app strings. Anything not on that list
  is free surface and waits for its file.

### What would justify revisiting

- **A third role.** Two roles is what makes plain English sufficient; a third (an observer, a relay)
  would need the vocabulary re-checked as a set rather than extended by analogy.
- **Nesting.** If a pack ever contains a pack, "the lead" stops being unambiguous and this ADR is
  superseded rather than amended.
- **The rename shipping and hurting** — operators consistently mis-reading "lead" as a verb, or
  external tooling found to key off an action title. Both are observable, and neither is a reason to
  reopen the themed-names question.
- **A peer pinning more than its single lead** (added 2026-08-08). Two roles is also what makes a
  peer's roster hold **exactly one member** — its lead (§8.2 step 4) — and that "roster of one" is
  load-bearing beyond vocabulary: it lets `bridge/pack/transport.ts` attest the pinned client
  certificate to the admission gate as a lossless **boolean** (`transportPinned`) rather than
  per-member, and lets `PACK_PROTOCOL.md` §8.6 reason about a single possible signer per pinned link. A
  third role, a multi-lead topology, or any change that lets a peer pin more than one lead invalidates
  that boolean-attestation assumption — both `transport.ts` and §8.6 would have to move to per-member
  identity — so such a change reopens this ADR as a set, not by analogy.
