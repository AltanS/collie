# 0159: the sign-in box is known by its shape and place, and its title is a label

- **Status:** Accepted
- **Date:** 2026-11-19
- **Trail:** Issue 816 (`@cooldaemon`): Claude Code 2.1.328 renamed the box from "Authentication" to
  "Sign-in", the exact-title list missed it, and the sign-in link was only in the terminal view. The quick
  fix added the second title to the list; the road this record turns down is that list, kept as the
  identity and grown one word per rename. The other road turned down: any box in that place lifts, link or
  not. Files: `web/src/lib/harness/claude/auth-box.ts`, `web/src/lib/harness/claude/index.ts` (reader
  order), `web/src/components/box-text-block.tsx`, `web/src/lib/links.ts`, `web/src/lib/report/signal.ts`
  and `bridge/telemetry.ts` (the trouble kinds, unchanged). Beside [ADR 0109](./0109-an-above-prompt-notice-is-not-a-modal.md)
  and [ADR 0151](./0151-a-dialog-becomes-a-card-by-its-own-words-and-a-tap-sends-what-the-screen-printed.md):
  this card is not a dialog and sends nothing.

## Context

While `awsAuthRefresh` runs, Claude Code draws a rounded box over its live input box. Collie lifts it as a
`box-text` card: the box's title, its rows, and its links. The card prints no key, owns no keyboard and
binds nothing (dialog-contract.ts has no row for it).

The reader knew the box by three things: its shape, its place, and an exact title from a list. The title
is the part Claude Code changed.

The cost is not the same in both directions. A missed box hides the sign-in link from Chat, which is the
bug of issue 816. A box lifted by mistake shows text and a link that are on the terminal screen anyway,
and sends no keystroke. The risk left is a hostile drawing that makes a link look like Claude's own
sign-in prompt.

What was measured, on the 191 Claude fixtures with a live input box:

- Claude draws its transcript indented: agent text under `● ` and two cells, tool output under `⎿`, the
  prompt echo under `❯`. No fixture holds a box at column 0 directly over the live input box except the
  auth box and Claude's own welcome box (a word in its top edge, a blank first row).
- A title list never stood against a hostile drawing. Whatever can draw the box can print "Sign-in".
- Two things can still put a column-0 box in that place, and both beat the list as well. A process that
  holds the pane's terminal can paint anywhere. And after a pane gets narrower, the terminal re-wraps a
  long transcript row, so its tail starts at column 0 (fixtures `claude-lab--permission-write--w82.txt`,
  `claude--menu-effort-slider.txt`). One row at least five times the new width can come out as a whole box.

## Decision

**Identity is shape and place.** This is unchanged: a rounded box at column 0 whose edges and sides
match, directly over Claude's live input box, with only blank rows and at most one spinner or retry row
between. The input box has the statusline tail and no strong dialog cue.

**The title is a label.** A known title ("Authentication", "Sign-in") behaves as before, the waiting card
included. Any other title lifts the same card, headed by the title the box prints, only when all of these
are true:

- the top edge is `─` alone;
- the title row holds one run of at most four words, at most 32 characters, with no key hint;
- a blank row stands under the title row;
- no row prints a key hint (`Esc to cancel`) or an option (`1. Yes`, a `❯` pointer);
- the rows hold at least one link.

An unknown title over a box with no link lifts nothing.

**No keys under an unknown title.** With a live input box under it, no menu reader claims a box that
prints keys, so this reader refuses it itself, and the rows stay in the mirror. The reader runs after
every dialog and notice reader in `claude/index.ts`. A known title keeps exactly the guards it had: the
statusline tail, the gap rule and the strong-cue check. Its box holds the output of the person's own
`awsAuthRefresh` command, which may print "1. Open the address" or "Press Enter after you signed in", and
a keys rule there would hide the link again, which is the bug of issue 816.

**The link is an address a person can read.** The reader makes a run a link only for an `https:` address
to any host, or an `http:` address to a loopback host (`localhost`, `127.0.0.1`, `[::1]`, any port), that
is printable ASCII from end to end and carries no user name or password. Any other plain-http address,
and a look-alike, bidi or `user@host` address, stays text. The card applies the same scheme rule for
every `box-text` reader, so omp's `http://localhost:<port>/launch` shortcut stays a link: a desktop
browser on the same machine opens it, and on a phone it fails harmlessly. There is no host allow-list, because the login host is the person's own identity
provider. The link's text is its href, so the card shows the whole host it opens.

**No drift signal.** A box in that place with an unknown title would be worth a count. The trouble tally
takes only the two card kinds, `dialog` and `send`, on the phone and on the bridge. Both refuse any other
kind. A third kind would widen the tally's shape and the ping, and an older bridge would refuse it. So
the reader records nothing. The way to catch a rename early is the harness lab, not the phone.

## Consequences

- The next rename of the title lifts the card with its new title, as long as the box keeps its shape and
  prints a link. The waiting phase of a new title shows no card until the link prints.
- A new Claude Code box over the input box that has a plain top edge, a short title, a blank row and a
  link would lift as this card. It shows only what the screen shows, keyless.
- What stays possible: a process that writes to the pane's terminal, or a transcript row the terminal
  re-wrapped to column 0, can draw a box that lifts. This was true under the title list too. Against it
  stand the place (only over the live input box), the https rule, and the full address in the card.
- Revisit when Claude Code draws a different box in this place, or when the trouble tally gains a kind
  for a reader's drift by its own decision.
