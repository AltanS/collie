# 0092 — The Keys pad is a board each device arranges, and the operator's Presets stay the operator's

Status: **Accepted** (2026-10-09)

Related: [ADR 0018](./0018-operator-command-rows-replace-the-catalog.md) (the `keys.toml` rows replace
the shipped Presets, and are not touched here) ·
[ADR 0033](./0033-the-app-face-is-a-device-preference.md) (the store shape, and why a per-device
preference is one module-scope value) · [ADR 0005](./0005-a-composed-key-queue-never-outlives-its-dock.md)
(the staged key queue that every board key still feeds).

## Context

The Keys dock drew a fixed pad: Esc, Tab, three sticky modifiers, Up, a quick `^C`, a four-wide Space,
the arrows, and a tall Enter. `bridge/operator-keys.ts` said why it was fixed: "a phone with no Escape
key has no other route to one". Only the Presets under it (`keys.toml`, ADR 0018) could change, and
they belong to the operator and reach every phone.

People asked for the other half: their own keys, in their own places, on their own phone. A tmux user
wants `Ctrl+B, c` in one tap. A Claude Code user wants `Shift+Tab` and `Esc Esc` where a thumb falls.
The 2026-10-09 decision round banked the shape: the whole pad editable, free cells, a chord builder
with no layout shifts, per device, with a pencil beside the label and a tall sheet for the editor.

Two questions have a blast radius, because someone will reasonably propose the other answer.

**Where does a layout live?** In the bridge, so one edit reaches every phone? That is the operator's
`keys.toml` again, and it would make two files fight over one pad. Or on the device?

**What stops a person locking themselves out of Esc?** The old answer was "the pad is fixed". That
answer costs everyone the editor to protect against one mistake.

## Decision

**The pad is data: a board of 7 columns where each cell holds one key or nothing.** It starts as
today's pad (the Default). `web/src/lib/key-board.ts` is the pure model: the chord grammar, the moves,
the five presets and the code. `web/src/lib/key-board-store.ts` keeps this device's copy under
`collie:key-board:v1`, in `localStorage`, as JSON with `v: 1`. A value that is missing, cut off, hand
edited, from a newer schema, or wrong in one chord is the Default, never an exception and never half a
board. The Default is not stored; Restore removes the key. At unpair the key is KEPT: it names chords,
not content.

**A layout belongs to the device, and the operator's Presets stay the operator's.** `keys.toml` and
`GET /api/config` are unchanged. The Presets row (the chips under the pad) is still replaced by the
operator's rows for a pane they address. The board is a person's own keys on one phone. They do not
merge and neither replaces the other. A layout never reaches the bridge, so there is no endpoint, no
file, no sync, and nothing for the bridge to trust.

**A key is one of two kinds.** A sticky modifier (Shift, Ctrl, Alt) arms the next key as the fixed pad
always did. A chord key sends one to four STEPS in order, each step up to three modifiers plus one
key, spelled in the bridge's neutral alphabet (`bridge/mux/keys.ts`). `Ctrl+Alt+Shift+T` is four keys
at once. `Ctrl+B` then `c` is a two-step sequence. A step is a literal printable character, a named
key, or `F1` to `F12`; anything else is refused where it is read, never on the wire.

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

**A layout moves between devices as a code.** `collie-keys:1:` plus base64url of the same JSON that
storage holds. The importer checks the length (4,096 characters), the prefix, the alphabet, UTF-8, the
schema number, the key count (at most 56), every chord through the same reader storage uses, and every
label (at most 12 characters, no control or line-break characters), before it believes a byte. On
plain http the clipboard API is missing, so the code sits in a selectable field and the line under it
says to copy by hand.

**The Default changes shape slightly.** A key sits in one cell, so the tall Enter and the four-wide
Space become single cells. Enter sits beside Space, two empty cells from Left, so the reasoning of
issue 263 (a miss on an arrow is reversible, a miss on Enter confirms a prompt) still holds.

## Consequences

- The editor is a surface to keep honest: a fixed-height toolbar, a fixed-height builder and a reserved
  quiet line, so selecting, building and removing move nothing (DESIGN.md §2). Eleven locale files carry
  its strings.
- A board does not follow a person to a second device by itself. The code is the way across. A bridge
  store would fix that, and would be the moment to revisit this decision: it would need an endpoint,
  a trust rule for what one device may write for another, and an answer for the Presets overlap.
- Sticky modifier keys come from the Default and the presets. The chord builder makes chord keys only.
  A board that dropped Shift can get it back from a preset or Restore.
- The tmux preset sends `Ctrl+B` sequences. They reach a tmux running INSIDE the pane. A tmux mirror
  sends keys straight to the pane's program and never reads its own prefix, so on a tmux install the
  sequences are for a nested session, which the preset's line says.
- Reopen this if a second per-device surface wants the same code format (it carries a version in its
  prefix and in its JSON for that reason), or if the operator asks to ship a default board to every
  phone: that is a `keys.toml` question and ADR 0018's replace rule would decide it.
