# 0134: The trouble tally names the dialog by a hash of its key-hint row

- **Status:** Accepted
- **Date:** 2026-11-08
- **Shipped in:** 1.27.4
- **Amends:** [ADR 0129](./0129-an-anonymous-install-count-on-by-default.md), its amendment of
  2026-11-06 (the trouble tally). 0129's Consequences ask a field added after 1.27.0 for its own
  ADR and its own notice: this is that ADR, and the notice is below.
- **Related:** [ADR 0133](./0133-the-omp-plan-review-is-lifted-and-its-tier-is-named-not-moved.md)
  is one of the three screens the evidence found. [ADR 0053](./0053-an-unread-dialog-still-has-a-way-out.md)
  is the "Cannot read a dialog" card the hash is taken on.
- **Trail:** Altan's go of 2026-11-08 for the 1.27.4 hotfix · `web/src/lib/report/screen.ts` (the
  row, the gate, the hash) · `web/src/lib/report/once.ts` (the once key) · `bridge/telemetry.ts`
  (`parseTroubleSignal`, `noteTrouble`, `buildPing`) · `telemetry/README.md` (the contract) ·
  `scripts/trouble-screens.ts` (the lookup)

## Context

The trouble tally of 1.27.0 counts a "Cannot read a dialog" card by kind, agent, version and
multiplexer. That cannot tell one agent's dialogs apart: an omp plan review and an omp settings
screen count as one row, `omp@18.16.0/herdr`, and the count cannot say which dialog to read next.

On 2026-11-08 the 87 card captures on 1.27.3 were read for the row an agent draws under its
dialog, the key hints. Three of the screens behind the field's counts were bugs: the omp plan
review, Codex's hooks review and Codex's folder trust. Each has a key-hint row no other capture
shares. Rows that many screens share stay one row: Codex's 11 pickers all draw
`enter select · esc back`, and omp's `/changelog`, `/hotkeys` and `/tools` all draw
`PgUp/PgDn scroll · ⎋ to close`. Every such row was the agent's own text.

## Decision

A `dialog` row of the trouble tally may carry a sixth field, `screen`: 8 lower-case hex
characters, FNV-1a 32 over the UTF-8 bytes of the dialog's key-hint row. The phone computes it
from the rows the card was drawn from, and only the hash leaves the phone. The row is the lowest
of the screen's last six non-blank rows that names a way out (`esc`, `escape`, `⎋`, the Nerd Font
escape glyph). Its box glyphs and spaces at both ends are stripped, and white space is collapsed.

**The gate.** The row is hashed only when it is a short list of key hints. All of these hold:

1. It is at most 160 characters.
2. It splits into at least two segments at ` · `, ` • `, ` | ` or `│`.
3. Each segment is at most 6 words and at most 40 characters.
4. At least two segments hold a key token.
5. At least one key token is a key and nothing else: `esc`, `escape`, `⎋`, the Nerd Font escape
   glyph, `⏎`, `⇥`, `␣`, the arrows, `pgup`, `pgdn`, `ctrl+x`, `alt+x`, `shift+x`, `^x`, `⌥`.
   The plain words `enter`, `tab`, `space`, `home` and `end` count toward point 4 only.

Otherwise the field is absent. The lists name keys, never an agent. The gate refuses a sentence
that names keys (`› press enter then esc to leave vim`), an agent's task title after `⎋`
(`⎋ Fixing the home page end-to-end tests`) and a row of plain words cut by a separator
(`Fixing the home page · end-to-end tests`). It also refuses a few real key-hint rows drawn with no
separator, such as omp's `↑/↓ navigate ⏎ select ⎋ cancel`. That loss is accepted.

**The wire.** The bridge accepts `screen` on a `dialog` signal only, in the shape `^[0-9a-f]{8}$`;
anything else is a 400. The tally is keyed by kind, harness, version, mux and screen; 20 rows and a
count of 999 stay the caps. An outgoing row carries `screen` only when it has one, so a row without
it is byte for byte the 1.27.3 row. The phone's once-a-day mark keys a dialog by its hash too, so two
dialogs on one pane in a day count apart. The receiver must accept the field before a bridge sends
it, so it ships first.

## Notice

Decided by Altan on 2026-11-08: the release notes of 1.27.4 carry the field, and the app shows a
soft, one-time update notice that leads to the docs. 0129 asked a later field for its own notice;
this is it, kept small.

The stored value of `collie.telemetryNotice.v1` is a revision. Nothing stored shows the 1.27.0
notice, and spending it writes `2`, because the docs it leads to already describe this field. `1`
(the 1.27.0 notice was read) shows the update notice once, under the same rule as the first: the
count is on by default. `2` shows nothing. The key keeps its name, so the unpair decision in
`storage-keys.test.ts` stands.

The update notice is the same box, tone and icon. Its body is: "Collie's daily count now also names
a dialog it could not read, by a short code made from the dialog's key hints, never from your
text." Its one button, "What is sent", opens
`https://colliepwa.dev/docs/security#what-leaves-your-machine` in a new tab and spends the notice;
the X spends it too. It has no Settings button, because the Settings card stays the permanent
surface.

## Consequences

- **A count names the dialog.** A hash from the stats is looked up with
  `bun scripts/trouble-screens.ts`, which hashes the key-hint row of every pane fixture. A hash no
  fixture has is a screen nobody captured yet.
- **The hash is of the agent's own text.** It is never taken over the screen, over a row with the
  person's text, or over what was typed. A 32-bit hash of a short row can be guessed by trying rows,
  so the gate, not the hash, is what keeps a person's text out.
- **A row the gate refuses counts as before.** The dialog still counts, without `screen`, on its
  agent's row.
