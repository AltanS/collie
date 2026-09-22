# 0055 — A pointed list is walked, then confirmed

- **Status:** Accepted
- **Date:** 2026-09-22
- **Shipped in:** pending (target 1.12.0)
- **Trail:** `web/src/lib/harness/claude/prompt-select.ts` (`collectPointedRows`, `pointerWalk`,
  `detectPointedTrust`) · `web/src/lib/harness/claude/markers.ts` (`namesTrustDialog`) ·
  `web/src/fixtures/panes/claude--trust-prompt-unnumbered.txt` ·
  [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) ·
  [ADR 0053](./0053-an-unread-dialog-still-has-a-way-out.md) ·
  [ADR 0054](./0054-a-printed-scale-is-tappable.md)

## Context

**The folder trust prompt lost its numbers.** Claude Code 2.1.278 prints the first screen of an
untrusted directory like this:

```
 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
```

Every earlier release printed `❯ 1. Yes, I trust this folder` / `2. No, exit`, and the prompt-select
grammar's trust arm reads numbered rows. It therefore declined the new screen, the unread-dialog card
(ADR 0053) took over, and the operator was left with one Escape button on the one dialog that decides
whether Claude may read the folder at all.

**Two things about the new shape make it worse than a plain regression.** The pointer parks on
`No, exit`, which QUITS Claude, so a blind Enter is destructive. And the rows print no digit, so ADR
0009 forbids inventing one: in the `/model` picker a synthesised digit confirmed *and* rewrote the
user's default, and nothing here says this screen is kinder.

**The keys are on the screen anyway.** The pointer says where the highlight is. The footer names the
commit key. That is exactly the pair ADR 0054 turned into a tappable scale for the `/effort` slider,
where a chip tap is the delta in arrow presses plus nothing else. The same arithmetic works down a
column instead of across a row.

## Decision

**A pointed, unnumbered list is up-levelled as the SAME `prompt-select` block the numbered shape
lifts as, and a tap on a row is the arrow walk the pointer implies followed by the commit key the
footer named, sent as one batch.**

1. **The shape.** Two or more consecutive option rows directly above the footer (blank rows
   tolerated), exactly one carrying the `❯`, none numbered. A sibling row indents exactly past the
   pointer column (`"❯ "`, two cells), and that pair of columns is the whole discriminator — it is
   what keeps the paragraph above the options from reading as a third option.
2. **The evidence is still the dialog's own words.** The arm only runs when `classifyFooter` already
   claimed the `trust` family, which it does only when `namesTrustDialog` finds the dialog's own
   question or option row on screen. `Enter to confirm` alone claims nothing, per ADR 0053.
3. **The keys.** Option *i* sends `Down` repeated `i − pointed` times (or `Up` repeated
   `pointed − i`), then `Enter`. The pointed row's own option is `["Enter"]`. **No digit anywhere:**
   the screen printed none, so none is synthesised (ADR 0009).
4. **One batch per tap.** `sendGuardedKeys` hands the whole array to `pane.send_keys` in one call, so
   the guard runs once against the screen the operator actually tapped and no half-walked pointer is
   ever left behind.
5. **The default is visible.** The pointed row is the one a bare Enter takes, and on this dialog it
   quits Claude. `PromptOption` carries no highlighted flag, so the badge carries it: the pointed row
   shows the terminal's own `❯`, every other row shows the arrow its tap starts with.
6. **The pointer is part of the dialog's visible state.** The COMMITTING comparison
   (`promptsEqual`) checks the byte-faithful `signature`, which carries the `❯` column verbatim, so a
   pointer that moved between the render and the tap refuses the tap. The identity comparison also
   sees it, because the walk is baked into every option's `keys`.
7. **The numbered shape is untouched.** It is tried first and still wins; the pointed arm runs only
   where it declined. A numbered row anywhere in the block hands the screen straight back.

## Consequences

- **The trust prompt is two buttons again**, on the screen where the raw mirror is least usable and
  the wrong answer is least recoverable.
- **The count of arrows is a claim about where the pointer was.** That is why the committing guard
  must see the pointer row, and why a second device moving the highlight refuses the tap rather than
  overshooting it. A numbered tap never had this exposure; this one does, and the guard is what pays
  for it.
- **The badge column now mixes keys and a glyph.** `Enter`, `Down`, `❯` — honest, because each says
  what the row will do or where it stands, but it is the first prompt-select card whose badges are
  not all one kind of thing. A real highlighted/default field on `PromptOption` is the cleaner
  answer and is deliberately deferred until a second harness needs it.
- **Only the trust family takes this path today.** The shape is general and the helpers are written
  as such, but widening it to another family means widening what evidence is required first, not
  loosening the row test.
- **Revisit** when a harness prints a pointed list whose arrows wrap at the ends, where a delta is
  no longer the shortest path, or when a second dialog family prints one — at which point the
  default belongs on the model, not in the badge.
