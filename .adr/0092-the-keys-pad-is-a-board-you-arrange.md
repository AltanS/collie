# 0092 — The Keys pad is a board you arrange, and the operator's Presets stay the operator's

Status: **Accepted** (2026-10-09)

Related: [ADR 0018](./0018-operator-command-rows-replace-the-catalog.md) (the `keys.toml` rows replace
the shipped Presets, and are not touched here) ·
[ADR 0033](./0033-the-app-face-is-a-device-preference.md) (the store shape, and why a browser-side
preference is one module-scope value) · [ADR 0005](./0005-a-composed-key-queue-never-outlives-its-dock.md)
(the staged key queue that every board key still feeds).

## Context

The Keys dock drew a fixed pad: Esc, Tab, three sticky modifiers, Up, a quick `^C`, a four-wide Space,
the arrows, and a tall Enter. `bridge/operator-keys.ts` said why it was fixed: "a phone with no Escape
key has no other route to one". Only the Presets under it (`keys.toml`, ADR 0018) could change, and
they belong to the operator and reach every phone.

People asked for the other half: their own keys, in their own places. A tmux user wants `Ctrl+B, c` in
one tap. A Claude Code user wants `Shift+Tab` and `Esc Esc` where a thumb falls. The 2026-10-09
decision round banked the shape: the whole pad editable, free cells, a chord builder with no layout
shifts, with a pencil beside the label and a tall sheet for the editor. A first cut gave every key
one cell. The follow-up of the same day let a key be wider and taller, because a Space bar that is
one cell is not a Space bar, and because a person who builds a key should size it.

Two questions have a blast radius, because someone will reasonably propose the other answer.

**Where does a layout live?** In the bridge, so one edit reaches every phone? That is the operator's
`keys.toml` again, and it would make two files fight over one pad. Or in the browser?

**What stops a person locking themselves out of Esc?** The old answer was "the pad is fixed". That
answer costs everyone the editor to protect against one mistake.

## Decision

**The pad is data: a board of 7 columns where a key is anchored at one cell and spans 1 to 3 columns
and 1 or 2 rows.** It starts as today's pad (the Default). `web/src/lib/key-board.ts` is the pure
model: the chord grammar, the areas, the moves, the five presets and the code.
`web/src/lib/key-board-store.ts` keeps the stored copy under `collie:key-board:v1`, in `localStorage`,
as JSON with `v: 2`. A value that is missing, cut off, hand edited, from a newer schema, or wrong in
one chord or one area is the Default, never an exception and never half a board. The Default is not
stored; Restore removes the key. At unpair the key is KEPT: it names chords, not content.

**An area lies inside the board and overlaps no other key.** The key sits on its anchor, the top-left
cell; the cells it covers hold nothing of their own (`owners()` says who covers what). Every move
checks the whole area, and none of them moves a second key to make room:

- A drag or an arrow moves the whole area. A drop lands where the finger's grab point puts the key's
  corner (a wide key held by its right end lands with that end under the finger) and is pulled inside
  the board's edges.
- A drop onto a key of the SAME size swaps the two. Any other overlap is refused: the target outline
  turns dashed and grey, the status line says "Move ^W first, it is in the way", and the key goes back.
- An arrow skips keys in the way and lands on the next position where the area fits (or a same-size
  swap). With none, it stays off.
- The toolbar's Width 1 to 3 and Height 1 or 2 resize the selected key right and down. A size that would
  cover another key or leave the board looks off, and tapping it names the blocker on the same status
  line. Nothing moves.
- A "+" shows on free cells only, and a key added there is one cell. A key that is changed keeps its
  size.
- Both screens draw the board with CSS grid placement (`grid-column: n / span w`), so the dock and the
  editor cannot disagree. A lifted key leaves a placeholder over its area, so nothing shifts.

**A layout belongs to the browser, and the operator's Presets stay the operator's.** `keys.toml` and
`GET /api/config` are unchanged. The Presets row (the chips under the pad) is still replaced by the
operator's rows for a pane they address. The board is a person's own keys. They do not merge and
neither replaces the other. A layout never reaches the bridge, so there is no endpoint, no file, and
nothing for the bridge to trust. The sheet does not talk about devices or sync; a layout is shared by
its code (below), and the docs say in one plain sentence where it is stored.

**A key is one of two kinds.** A sticky modifier (Shift, Ctrl, Alt) arms the next key as the fixed pad
always did: off, once, locked, and the queue strip opens. A chord key sends one to four STEPS in order,
each step up to three modifiers plus one key, spelled in the bridge's neutral alphabet
(`bridge/mux/keys.ts`). `Ctrl+Alt+Shift+T` is four keys at once. `Ctrl+B` then `c` is a two-step
sequence. A step is a literal printable character, a named key, or `F1` to `F12`; anything else is
refused where it is read, never on the wire. The chord builder makes both: its kind row reads
Character, Named, F keys and Modifier. A Modifier stands alone (it is the whole key, never a step), so
the Hold row goes inert and "Add step" goes off. A modifier key whose key leaves the board lets go of
its armed state, so nothing stays armed with no key to turn it off.

**There is one key path.** A board key hands its steps to the `onSend` the pad always had, which is
`pressKeys` in `composer.tsx`: the lock, the offline check, the echo, then `api.sendKeys`. A sequence
is one ordered array, so it is one call, and order within one `send_keys` is the only order the
transports promise. A key whose steps hold a danger chord (`isDangerKey`) asks a second tap on the
immediate path, with ONE exception: a key that is exactly `Ctrl+C`. The stock `^C` has always sent at
one tap, as the Presets row does, so the Default does not get slower. A sequence that holds `ctrl+c`
is not that key, and asks. While composing, the strip's Send is the review, as before. A step the
multiplexer refuses (`unsupportedKeys`) greys the whole key, as it greyed a pad button.

**Losing Esc is made loud, not impossible.** Removing Esc, Enter or an arrow shows one quiet reserved
line, "Esc is not on your pad. Put back". Restore default and every preset bring them back. Nothing
else is locked.

**Anything that replaces the whole layout goes through a confirm screen.** A preset, an imported code
and Restore default all show a picture of the new board, the key count and "This replaces your
layout". Single-key edits save at once.

**A layout is shared as a code.** `collie-keys:2:` plus base64url of the same JSON that storage holds.
The importer checks the length (4,096 characters), the prefix, the alphabet, UTF-8, the schema number,
the key count (at most 56), every chord through the same reader storage uses, every label (at most 12
characters, no control or line-break characters), and that every area lies inside the board and
overlaps no other, before it believes a byte. On plain http the clipboard API is missing, so the code
sits in a selectable field and the line under it says to copy by hand.

**Schema 2 adds the size; schema 1 is still read.** A key is `[cell, spec]`, `[cell, spec, label]`, or
`[cell, spec, label | null, w, h]`. A `collie-keys:1:` code and a stored `v: 1` board read as they
did, every key one cell. A build that stored `v: 1` and a build that wrote `v: 2` can share a browser
only forwards: the older build treats a `v: 2` value as the Default (a "newer schema" is not read),
which is the same fallback every other bad value gets.

**The Default changes shape slightly.** The old pad set a tall Enter apart on an eighth column. Seven
columns have no room for that without moving a key of row 1, so Enter takes the far left of row 2 and
a three-cell Space stands between it and the arrows (Left, Down, Right under Up). Issue 263's reasoning
holds: a miss on an arrow is reversible, a miss on Enter confirms a prompt, and no arrow is beside it.

```
Esc    Tab    Shift  Ctrl   Alt    Up     ^C
Enter  Space (3 wide)        Left   Down   Right
```

Every preset keeps that frame (Esc, Up, Enter, the wide Space and the arrows in the same cells), so
the thumb's places do not change when a preset does. Where a preset names more keys than three rows
hold, it takes a fourth row (Vim, Navigation), or leaves the sticky modifiers to the Default
(Claude Code keeps Ctrl, tmux drops all three).

## Consequences

- The editor is a surface to keep honest: a fixed-height toolbar (status line, arrows, sizes, Change
  and Remove), a fixed-height builder and a reserved quiet line, so selecting, building, resizing and
  removing move nothing (DESIGN.md §2). Eleven locale files carry its strings.
- A board does not follow a person to a second browser by itself. The code is the way across. A bridge
  store would fix that, and would be the moment to revisit this decision: it would need an endpoint,
  a trust rule for what one browser may write for another, and an answer for the Presets overlap.
- The tmux preset sends `Ctrl+B` sequences. They reach a tmux running INSIDE the pane. A tmux mirror
  sends keys straight to the pane's program and never reads its own prefix, so on a tmux install the
  sequences are for a nested session, which the preset's line says.
- The Hold row of the builder goes inert for a Modifier but keeps its place, so switching kind moves
  nothing.
- Reopen this if a second surface in the browser wants the same code format (it carries a version in
  its prefix and in its JSON for that reason), or if the operator asks to ship a default board to every
  phone: that is a `keys.toml` question and ADR 0018's replace rule would decide it.
