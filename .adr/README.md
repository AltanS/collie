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

**Write the `Trail:` line first, and make it name the opponent.** Every ADR opens with a `Trail:`
header naming the PR, the issue or the thread where somebody argued for the other road, beside the
files the decision reaches. Write that line before the body. If you cannot fill it, condition 1 has
not been met and what you have is a header comment — put it at the line and stop. This is the whole
bar above, reduced to something answerable in the moment: 0049 has issue #243; the two candidates
turned down below had nothing to put there, and neither did the update-screen write-up that became
0044, which is the one entry in this directory no source file cites.

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
| [0002](./0002-invert-the-light-terminal-mirror.md) | The light terminal mirror is inverted, not re-themed (addendum 2026-09-21: a per-pane override lands) | Accepted |
| [0003](./0003-one-shared-seen.md) | "Seen" is one shared fact, and only Collie's own reads count | Accepted |
| [0004](./0004-the-statusline-run-is-bounded.md) | The statusline run is bounded, but the bound guards less than it looks | Amended in scope by 0048 |
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
| [0015](./0015-pack-add-pushes-over-the-operators-ssh.md) | `pack add` pushes the lead's own commit over the operator's SSH (addendum 2026-09-21: a commitless lead installs from the release) | Accepted |
| [0016](./0016-updates-ride-the-operators-ssh.md) | Updates ride the operator's SSH, never the pack wire (addendum 2026-09-04: peers follow) | Amended in scope by 0062 |
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
| [0029](./0029-speech-to-text-is-a-provider-seam-collie-owns.md) | Speech-to-text is a provider seam Collie owns; Codex auth rides the operator's own binary | Accepted |
| [0030](./0030-the-ui-is-translated-by-a-typed-dictionary-not-a-library.md) | The UI is translated by a typed dictionary, not an i18n library | Accepted |
| [0031](./0031-freshness-is-a-declared-promise.md) | Freshness, focus and shape are contract promises, not adapter folklore | Accepted |
| [0032](./0032-a-worktree-is-opened-by-the-multiplexer-not-by-git.md) | A worktree is opened by the multiplexer, not by Git | Accepted |
| [0033](./0033-the-app-face-is-a-device-preference.md) | The app's face is a device preference; an operator's fonts add to the list (differs from 0018) | Accepted |
| [0034](./0034-collie-collects-nothing-and-opt-in-is-the-ceiling.md) | Collie collects nothing, and opt-in is the ceiling | Accepted |
| [0035](./0035-a-packaged-install-is-not-ours-to-update.md) | A packaged install is not ours to update | Accepted |
| [0036](./0036-the-map-of-machines-is-collies-a-mux-reports-one-machine.md) | The map of machines is Collie's, a mux reports one machine | Accepted |
| [0037](./0037-a-staged-update-confirms-its-runner-before-it-exits.md) | A staged update confirms its runner before it exits | Accepted |
| [0038](./0038-the-group-is-a-crew-the-wire-keeps-pack.md) | The group is a crew; the wire keeps "pack" (supersedes the word in 0012) | Superseded in part by 0039 |
| [0039](./0039-the-machine-says-crew-too.md) | The machine says "crew" too: protocol version 2, one release of overlap (supersedes the machine names in 0038) | Accepted |
| [0040](./0040-configuration-precedence-and-the-config-file.md) | Configuration precedence, and the config file under it | Accepted |
| [0041](./0041-cache-rules-are-sourced-claims.md) | Cache rules are sourced claims | Accepted |
| [0042](./0042-notification-kinds-and-the-cache-watch.md) | Notification kinds, and the cache watch: global OR per-pane, keyed by session ref | Accepted |
| [0043](./0043-operator-bar-rows-replace-the-bar-not-the-palette.md) | Operator bar rows replace the bar, not the palette (applies 0018 per surface) | Accepted |
| [0044](./0044-the-update-screen-is-one-reducer-and-one-shared-poll.md) | The update screen is one reducer and one shared poll | Amended in scope by 0064 |
| [0045](./0045-a-build-below-the-protocol-floor-is-a-red-preflight.md) | A build below the protocol floor is a red preflight, never a silent link | Accepted |
| [0046](./0046-an-urgent-patch-keeps-the-daily-cadence.md) | An urgent patch keeps the daily cadence | Accepted |
| [0047](./0047-muse-panes-render-natively.md) | Muse panes render natively: no light-theme inversion (addendum 2026-09-21: the bit's own limit) | Accepted |
| [0048](./0048-the-input-box-is-found-by-its-own-frame.md) | The input box is found by its own frame; the statusline bound only bounds what is stripped (amends 0004) | Accepted |
| [0049](./0049-no-child-inherits-a-relocated-repository.md) | No child of Collie inherits a variable that relocates a git repository | Accepted |
| [0050](./0050-a-crew-fault-blocks-an-update-only-when-the-update-makes-it-worse.md) | A crew fault blocks an update only when the update would make it worse (distinguishes 0045) | Accepted |
| [0051](./0051-the-phone-app-runs-react-router-in-library-mode.md) | The phone app runs React Router in library mode; four build seams framework mode would take | Accepted |
| [0052](./0052-one-build-serves-any-mount.md) | One build serves any mount: `COLLIE_BASE_PATH` is a runtime setting the bridge applies when it serves the shell | Accepted |
| [0053](./0053-an-unread-dialog-still-has-a-way-out.md) | An unread dialog still has a way out: a footer phrase never silences a grammar, and a raw-only modal gets its adapter's declared cancel key | Accepted |
| [0054](./0054-a-printed-scale-is-tappable.md) | A printed scale is tappable: when the screen names every value the arrows move along, the card shows them all and a tap sends the delta as repeated arrow presses | Accepted |
| [0055](./0055-a-pointed-list-is-walked-then-confirmed.md) | A pointed list is walked, then confirmed: an unnumbered list with a `❯` on one row is tapped as the arrow delta plus the commit key the footer named, and never a synthesised digit (applies 0054 to a list) | Accepted |
| [0056](./0056-a-card-can-be-put-down.md) | A lifted card can be put down: every card carries a Terminal control that shows the rows it replaced, lasting only as long as that dialog | Accepted |
| [0057](./0057-the-composer-is-one-box.md) | The composer is one box: the field, the attach control and Send share one bordered container with a toolbar row, the prompt-input pattern ported by hand | Accepted |
| [0058](./0058-the-resume-picker-commits-with-enter.md) | The resume picker commits with Enter: the `/resume` session picker, recognised by its own title, search box and footer, lifts as a pointed list whose tap is the walk plus an unprinted Enter, a narrow exception to 0009 for this one dialog | Accepted |
| [0059](./0059-a-card-docks-above-the-belt.md) | A card docks above the belt: every lifted card renders in one slot outside the mirror's scroller, directly above the actions belt, capped and scrolled inside (moves where 0056's card renders) | Accepted |
| [0060](./0060-an-attachment-is-a-chip-not-a-path.md) | An attachment is a chip, not a path: an upload shows as a chip above the field and a `[Image #N]` marker in the draft, and Send swaps in the path where the marker stands | Accepted |
| [0061](./0061-the-terminal-draft-notice-floats.md) | The terminal draft notice floats: it leaves the layout for an absolute slot at the mirror's bottom edge, above the card dock or the belt, and an x hides it until that draft is gone | Accepted |
| [0062](./0062-a-crew-run-levels-to-its-target-and-its-second-step-is-not-a-new-attempt.md) | A crew run levels to its target, and its second step is not a new attempt: no turn below the target, the hourly limit exempts a step inside the same run, the lead names the limit (amends 0016) | Accepted |
| [0063](./0063-a-pane-keeps-its-place-when-its-state-changes.md) | A pane keeps its place when its state changes: no list is ordered by status, the bridge and the crew merge send place order, every surface recomputes it, and urgency is a mark plus one summary line | Accepted |
| [0064](./0064-an-update-puts-the-phone-in-update-mode.md) | An update puts the phone in update mode: a locked app, a docked panel, seven steps that end only on Done, Rolled back or Stuck, the phone's own reload last and once, and a panel that never moves (amends 0044) | Accepted |

Numbers are claimed across **both** branches: 0011–0016 were accepted here on `v1` while `main` was
still at 0010, so a new ADR continues from the highest number in use anywhere, not the highest one on
the branch you happen to be on.
