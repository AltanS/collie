# omp model picker: keystroke recipe

The choreography notes file the Tier-2 bar asks for (`HARNESS_CONTRIBUTING.md`), for the fourth omp
screen the adapter lifts ([ADR 0079](../../../../../.adr/0079-the-omp-model-picker-is-lifted-as-its-visible-window.md)).
Grammar: `switch.ts`. Corpus: `omp--v18-4-switch*.txt`, 23 captures, omp 18.4.10, 2026-10-02, in a
sandbox home with dummy provider keys. Behaviour below is read from pi-tui's
`overlays/model-picker.ts` and `overlays/model-browser.ts` and the coding agent's
`modes/controllers/selector-controller.ts` and `session/model-controls.ts` in the published omp
18.4.10 packages, and checked against those captures.

## What the screen prints

`/switch` with no argument, or Alt+P, opens a box anchored to the bottom of the pane, over the
transcript (`omp--v18-4-switch.txt`, 219 columns, shortened here):

```
╭─ Switch Model ────────────────────────────────────────────────────╮
│  Session-only switch — role models stay unchanged                  │   status row
│  🔍 >                                                              │   search row
│                                                                    │
│   openrouter/google/gemini-3.8-flash   🧠 59  ~327t/s  1m ◫ $0.75/3.75█ │   recents
│   anthropic/claude-sonnet-5-5          🧠 56  ~139t/s  1m ◫    $2/10│ │
│   ────────────────────────────────────────────────────────────  │ │   the rule
│ ❯ anthropic/claude-opus-5-5 ●          🧠 58   ~95t/s  1m ◫    $4/20│ │   pointer, current
│   openai/gpt-4 ⦸ context>8.2k          🧠 7          8.2k ◫   $30/60│ │   over-context
│   …                                                                │
│                                                                    │
│   Claude Opus 5.5 · 1m ctx · 128k out · $4/20 per M · reasoning     │   facts row
│   ● current · ● default ◒                                          │   chips row
│ ↑/↓ models · ⏎ use for this session · type to search · @ quick roles · ⎋ close · Alt+P task model │
╰────────────────────────────────────────────────────────────────────╯
```

- **The window** shows `max(5, floor(rows × 0.4) − 9)` rows. The captures hold 16 (63-row pane), 15
  (61 rows) and 5 (30 rows). A list longer than the window draws a scrollbar column: `█` for the
  thumb, `│` for the track. A shorter list pads the window with blank rows and draws no scrollbar.
- **A model row** is the pointer column (`❯ ` or two spaces), the `provider/id`, ` ●` on the
  current model, ` ⦸ context>N` on a model whose window the transcript no longer fits, then badge
  columns: intelligence `🧠 N`, speed (`~95t/s` estimated; measured `118t/s` or `0.9s 118t/s`, from
  76 columns), context `1m ◫`, price (`$4/20`, `free`, `included`, `varies`, `unknown`, or a credit
  multiplier `N×`).
- **The rule** separates the recent models from the rest. omp's list skips it: Up and Down never
  stop on it.
- **A narrow pane** shortens a row with `…` (`omp--v18-4-switch-truncated.txt`, 103 columns).
- **The chips row** is `● current` on the current model, then the roles that use the pointed model
  (`● default ◒`, `○ advisor ◒`). On an over-context model it is the warning instead:
  `⦸ context 157k exceeds 128k limit · compacts with current model, then switches`.

## What a tap sends

| Tap | Keys |
|---|---|
| the pointed row (not the current model) | `Enter` |
| a row `n` models below the pointer | `Down` × n, then `Enter` |
| a row `n` models above the pointer | `Up` × n, then `Enter` |
| the card's last row, `Close` (no search typed) | `Escape` |
| the card's last row, `Clear search` (a search typed) | `Escape` |

The plan is not sent as one batch. The action layer walks, verifies, then commits ([ADR 0080](../../../../../.adr/0080-a-pointed-list-is-walked-verified-then-confirmed.md)): it
sends the arrows first, bound to the tapped screen, reads the pointer back, and sends `Enter` only
bound to that read, when it shows the pointer on the tapped row. A timeout or a drift sends nothing.
A pointed row has no arrows, so its `Enter` goes out bound to the tapped screen. `n` counts model rows
only, because Up and Down skip the rule. No digit: the screen prints none.

What each key does, from omp 18.4.10:

- **`Up` and `Down` wrap** at both ends of the list (captured: `omp--v18-4-switch-wrapped.txt`, Up on
  the first model landed on the last of about 840). The card only walks between two rows that are
  both on screen, so a walk never reaches an end and never wraps. The window scrolls only when the
  pointer leaves it, and a walk inside the window never does.
- **`Enter` on a model** switches the live session to it for this session only (`onPick` →
  `#applySessionModel` → `setModelTemporary`). No config file is written. omp still records the pick
  in its recent-models list, appends a model change to the session log, resets the provider session
  and re-applies the thinking level. It prints `Session-only model: <id>` in the status line.
- **`Enter` on the current model** runs the same path with the same model. Nothing changes the model,
  but the side effects above still run, and the provider session reset loses the prompt cache. The
  card never offers it. The picker opens with the pointer on that row, so a desk Enter hits it by
  habit, and a phone tap is a deliberate act, so the card does not invite it.
- **`Enter` on an over-context model** compacts the session with the current model FIRST, then
  switches. A cancelled or failed compaction keeps the current model. That is not a model switch, so
  the card never offers these rows.
- **`Escape`** clears the search when one is typed, and closes the picker when the search is empty.
  So the card labels its last row for what the one tap does: `Clear search` while the search row holds
  text (the card then re-renders as the full list), `Close` while it is empty.

## What the card shows

- **One row per model omp printed in full.** The label is the whole `provider/id`, which may hold
  dots, colons and more slashes (`openrouter/anthropic/claude-opus-5.5:batch`). The session state
  always prints the provider; only the quick-roles state drops it, and that state is declined.
- **The description** is the badges omp printed, joined by ` · `. They are labels. The grammar checks
  that each one reads as a badge, but it never reads an id or a price out of them. It no longer
  starts with `● current`: the current model has no row on the card.
- **The badge column** shows `❯` on the pointed row, nothing on the other models, and `Esc` on the
  last row.
- **Rows the card leaves out, and still counts:** a row shortened with `…` (its id is not all on
  screen), an over-context row (above) and the current model. When the pointer sits on one of them,
  no card row carries `❯`. Each of the three still takes its place in every other row's walk, because
  Up and Down stop on it.
- **The current model is named in the accessible name.** When a row marked `●` is on screen with its
  full id, the card's `question` gains a last line, `● current: <id>`. Without a marked row in the
  window, or with a shortened one, there is no such line.
- **The last row says how to reach the rest.** Its description is the footer's own segment,
  `type to search`, so a card of a dozen rows out of about 840 models tells the person how to go
  further. The footer always prints it in the lifted state, so the description is always there. The
  label is the footer's verb, `Close`, while the search row is empty, and `Clear search` while it holds
  text. The grammar already parses the search row (`🔍 >` and the typed text), and the typed text is in
  the signature, so a search typed or cleared between render and tap refuses the tap.
- **The card starts at the window.** The title, the status sentence and the search row as typed stay
  in the raw mirror above it, verbatim. The card's accessible name carries the same three rows, then
  the current line.

### Why the current model is not offered, and what is still open

An Enter on the current model switches nothing. It resets omp's provider session and loses the prompt
cache, so the one tap that looks safest costs the most. A screen whose only offerable row was the
current model therefore declines (the grammar still needs one offered model row), and the Escape card
stands in for it.

Residual risks, named in review, and where each stands now:

- **A streaming agent can push a row over the context limit between the poll and the tap.** Enter on
  an over-context row compacts the session instead of switching. This is covered by the verified
  commit of [ADR 0080](../../../../../.adr/0080-a-pointed-list-is-walked-verified-then-confirmed.md): the walk is sent first, the pointer is read back, and `Enter` is bound to
  that read, so a row that turned over-context is no longer offered by the fresh read, and no `Enter`
  is sent. The residual window is the bridge's own read-to-send gap, a few
  milliseconds, closable only by a conditional send in the multiplexer, which does not exist.
- **A key typed at the desk between two keys of the walk lands in the picker.** Same cover: the
  walk's arrows are sent first, the fresh read must show the pointer on the tapped row, and a desk
  keystroke that moved the pointer elsewhere or typed into the search makes that read fail the check,
  so `Enter` is not sent. The same residual window applies.
- **A typed search makes the first Escape clear the search.** Resolved by the label: the last row says
  `Clear search` while a search is typed and `Close` when it is empty, so each tap does what its label
  says. The person taps twice only to leave a searched picker, and the second tap reads `Close`.

## Searching from the phone

The card types nothing into the search box. To search:

1. Open the Keys drawer and type the letters there, or long-press Send and pick "Type into terminal".
2. Each keystroke redraws the window. The signature changes, so a tap from the old render is refused
   (the bridge answers 409) and the card re-derives on the next poll.
3. Tap a row of the new window, or `Clear search` to clear the search. With the search empty again the
   same row reads `Close` and closes the picker.

A leading `@` switches the picker to its quick-roles state. The grammar declines that state, and the
Escape card stands in for it.

## What the grammar requires, all of it

1. The bottom border is the last non-blank row.
2. The footer above it is exactly the session footer, character for character:
   `↑/↓ models · ⏎ use for this session · type to search · @ quick roles · ⎋ close · Alt+P task model`.
3. Above the footer: the chips row, the facts row (non-empty), a blank row.
4. The title `╭─ Switch Model ─╮`, then the status row `Session-only switch — role models stay
   unchanged`, then the search row `🔍 >`, then a blank row.
5. A window of 5 to 60 rows between them. Each row is a model row or the rule. With a scrollbar,
   every row carries a scrollbar cell, one of them is the thumb `█`, and none is blank. Without one,
   blank rows may pad the window after the last model row, and nowhere else.
6. Each model row reads whole: the pointer column, an id with a `/`, the optional ` ●` and
   ` ⦸ context>N`, then badges that each match one of the columns above. A shortened row is accepted
   as a row the arrows stop on and is not offered.
7. Exactly one pointer, at most one `●`, at most one rule.
8. The chips row is blank, a list of chips that each open with `●` or `○`, or the over-context
   warning. It agrees with the pointed row: the warning exactly when that row carries `⦸`, otherwise
   `● current` exactly when it carries `●`.
9. At least one row the card can offer. The current model is never one, so a window whose only
   offerable row is the current model declines.
10. A signature no longer than the bridge accepts as a bound region (32000 characters here).

Anything missing returns null. The screen then stays raw, with the unread-dialog card's Escape over
it when the footer still names its way out.

## Declined on purpose

| Screen | Capture | Why |
|---|---|---|
| a search with no match | `-nomatch` | `No matching models`: no row to walk from |
| the `@` quick-roles state | `-quick-roles` | another action: it applies a role's model AND its thinking level |
| the task-model state (Alt+P) | `-task` | another action: it sets the model spawned task agents use |
| the Nerd Font preset | `-nerd` | other glyphs in the footer, pointer, search row and marks; not captured as a lift |
| a 74-column pane | `-clipped` | omp clips the footer to `… @ quick roles …`, so no way out is on screen |

The first four keep the Escape card: the modal gate (`modal.ts`) accepts one task-mode segment,
`Alt+P task model` or `Alt+P session model`, after the way out. The clipped picker gets no card,
like `/tree`: nothing on screen names a key that closes it.

Also declined, read from source and not captured: the `ascii` preset (`>` pointer, `[/]` search,
`[x]` mark), a config error in place of the status row, a rebound key in the footer, and a row with
a word or badge the grammar does not know.

## Not proven by the captures

- **Walks checked live without Enter, 2026-10-02 (omp 18.4.10, Herdr, sandbox pane), made before
  the walk, verify, commit of [ADR 0080](../../../../../.adr/0080-a-pointed-list-is-walked-verified-then-confirmed.md).** The grammar
  read a fresh bridge capture, the walk minus its `Enter` was sent, and a second capture showed the
  pointer on the target row, for every walk tried. That is the same check the action layer now makes
  on every tap, by hand and with the one-batch plan: Down and Up across the rule in the full list,
  Down past three over-context rows and two shortened rows in a `nemotron` search, and Up and Down
  across a window scrolled to the list's end. No `Enter` was sent, so no model was switched.
- **Not probed:** a tap through the paired card (the bridge's signature check on this screen, and
  now the split walk of ADR 0080 on it; the live walk checks above were made with the one-batch
  plan), the Close and `Clear search` rows, a desk keystroke between render and tap, and the Nerd Font
  preset.
- **Shapes read from source, none captured:** measured speed badges (`118t/s`, `0.9s 118t/s`), the
  credit price `N×`, the `included`, `varies` and `unknown` prices. The grammar accepts their
  spellings from the source. A badge it does not know declines the screen.
