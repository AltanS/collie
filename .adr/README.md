# Architecture decision records

Decisions with a **blast radius wider than the diff that made them** — the ones a future
contributor (or a future agent) would otherwise re-derive from scratch, or quietly reverse because
the reasoning lived only in a PR thread.

One file per decision, numbered in the order they were accepted:

```
.adr/NNNN-kebab-case-title.md
```

Format is [Michael Nygard's](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions):
**Context** (the forces, including what was actually measured), **Decision** (what we do, in the
imperative), **Consequences** (what this costs, and what would justify revisiting it).

## When to write one

Write an ADR when a decision **closes off an option someone will reasonably propose again**. The
signal is that you find yourself explaining *why not* rather than *how*.

- ✅ "We manage exactly one front door" — a NetBird PR, then a Cloudflare Tunnel PR, then a ZeroTier PR
- ✅ "Polling, not an event stream" — perennial, and the reasoning isn't obvious from the code
- ❌ "Use Vitest for the web suite" — that's just what the repo does; `CLAUDE.md` covers it
- ❌ Anything already legible from the code, a test name, or a commit message

**The bar is high, and it is meant to be.** These are for the handful of decisions that shape the
system, not a record of work done. A merged PR is not an occasion for an ADR; neither is a decision
that merely took some thought, nor one you'd like on the record because it was hard-won. If a
directory of ADRs reads like a changelog, it has stopped being useful — the signal drowns, and the
few entries that genuinely close off a road get skimmed past with the rest.

Before adding one, both of these must be true:

1. **Someone has actually argued for the other road, or demonstrably will.** A real PR, a real issue,
   a proposal you had to talk someone out of. "A future contributor might wonder" is not enough — that
   is what a comment is for.
2. **The argument has nowhere better to live.** If it fits at the line that would change, put it
   there: whoever reopens the question is reading that code, not this directory. An ADR is for
   reasoning that spans files, or that argues against a road with no single line to attach to.

When in doubt, don't. A comment at the point of change costs nothing and is read by exactly the
person who needs it; an ADR that didn't need writing dilutes the ones that did. Two candidates were
turned down on this basis in one day (bundled-font laziness, and the direct-typing lifecycle) — both
became file-header comments, and both are better for it.

## Relationship to the other docs

Nothing here restates what lives elsewhere; the point is the *reasoning*, once.

| Where | What belongs there |
| --- | --- |
| [`CLAUDE.md`](../CLAUDE.md) | The **rule** — short, normative, linking here for why |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | How the system is **built**, as it stands today |
| [`README.md`](../README.md) | How an operator **runs** it |
| `.adr/` | Why a road **wasn't** taken |

A superseded ADR is never deleted or edited into agreement with the present. Mark it
`Superseded by NNNN` and write the new one — the wrong turn is the useful part.

A decision that is still correct but whose **scope** later changes is *amended*, not superseded: the
new ADR says what it amends, the old one gains an `Amended in scope by NNNN` pointer at the top, and
**nothing in its body is rewritten**. If you find yourself editing the argument rather than adding
the pointer, it was a supersede.

## Index

| # | Decision | Status |
| --- | --- | --- |
| [0001](./0001-one-managed-front-door.md) | Collie manages exactly one front door | Accepted |
| [0002](./0002-invert-the-light-terminal-mirror.md) | The light terminal mirror is inverted, not re-themed | Accepted |
| [0003](./0003-one-shared-seen.md) | "Seen" is one shared fact, and only Collie's own reads count | Accepted |
| [0004](./0004-the-statusline-run-is-bounded.md) | The statusline run is bounded, but the bound guards less than it looks | Accepted |
| [0005](./0005-a-composed-key-queue-never-outlives-its-dock.md) | A composed key queue never outlives its dock | Accepted |
| [0006](./0006-update-advances-the-checkout-herdr-installed.md) | `update` advances the checkout Herdr installed, and never re-links it | Accepted |
| [0007](./0007-the-idle-lock-is-a-pause-not-a-gate.md) | The idle lock is a pause, not a gate | Accepted |
| [0008](./0008-collie-does-not-run-a-terminal-emulator.md) | Collie does not run a terminal emulator | Accepted |
| [0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) | A generic menu is driven by the keys it names, never by digits | Accepted |
| [0010](./0010-long-sends-are-verified-via-the-paste-placeholder.md) | Long sends are verified via the paste placeholder, not by chunking them | Accepted |
| [0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md) | The pack protocol is the mux-driver seam, and peers are full collies | Accepted |
| [0012](./0012-every-machine-runs-a-collie-and-the-pack-has-a-lead.md) | Every machine runs a collie; the pack has a lead | Accepted |
| [0013](./0013-a-peer-listens-without-becoming-a-front-door.md) | A peer listens without becoming a front door (amends 0001) | Accepted |
| [0014](./0014-promote-is-a-confirm-on-the-lead.md) | Promotion is a confirm on the receiver, not a command from the claimant | Accepted |
| [0015](./0015-pack-add-pushes-over-the-operators-ssh.md) | `pack add` pushes the lead's own commit over the operator's SSH | Accepted |
| [0016](./0016-updates-ride-the-operators-ssh.md) | Updates ride the operator's SSH, never the pack wire | Accepted |
| [0017](./0017-recognising-a-password-prompt-changes-what-collie-says.md) | Recognising a password prompt changes what Collie says, never what it sends | Accepted |
| [0018](./0018-operator-command-rows-replace-the-catalog.md) | The operator's command rows replace the catalog, never merge into it | Accepted |
| [0019](./0019-oxlint-and-vendored-anti-slop-are-the-lint-gate.md) | oxlint + vendored anti-slop is the lint gate; one linter; TypeScript 7 | Accepted |
| [0020](./0020-a-major-upgrade-is-consented-by-flag.md) | A major upgrade is consented by flag; routine update follows tags within the major | Accepted |
| [0021](./0021-the-path-name-is-a-pointer-never-a-copy.md) | The name on PATH is a pointer, never a copy | Accepted |
| [0022](./0022-the-mux-seam-is-a-port-collie-owns.md) | The multiplexer is a port Collie owns, not a relocated Herdr client | Accepted |
| [0023](./0023-compression-is-hop-local-on-the-pack-link.md) | Compression is hop-local on the pack link; the ETag names the identity bytes | Accepted |
| [0024](./0024-a-beacon-is-a-hint-never-a-control-channel.md) | A beacon is a hint, never a control channel | Accepted |
| [0025](./0025-the-wire-guard-forces-a-decision-never-a-bump.md) | The pack-wire guard forces a decision, never a bump | Accepted |
| [0026](./0026-the-operator-is-the-quorum.md) | The operator is the quorum | Accepted |
| [0027](./0027-the-deputy-is-named-ahead-of-time.md) | The deputy is named ahead of time, and takes over on the operator's word | Accepted |
| [0028](./0028-the-standby-door-is-a-second-listener.md) | The standby door is a second listener that arms on silence (amends 0013) | Accepted |

Numbers are claimed across **both** branches: 0011–0016 were accepted here on `v1` while `main` was
still at 0010, so a new ADR continues from the highest number in use anywhere, not the highest one on
the branch you happen to be on.
