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
