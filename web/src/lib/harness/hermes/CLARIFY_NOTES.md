# Hermes clarify panel — keystroke recipe

Captured 2026-10-16 on Hermes Agent v0.22.2 (`hermes --cli`, the classic prompt_toolkit CLI) in a
sandbox Herdr pane (Herdr 0.9.1, `agent: hermes`), 120 and 60 columns. The model was a local
zero-inference endpoint that answers a keyword with a scripted `clarify` tool call, so the panels
are Hermes's own rendering of real tool calls and no provider quota was spent. Read against the
source: `_get_clarify_display_fragments`, `_tui_make_clarify_number_handler` and
`_tui_bind_overlay_navigation` in `hermes_cli/cli_tui_mixin.py`, strings in `locales/en.yaml`.

The panel sits above the input, which stays on screen. The input's prompt names the state: `? ❯`
while a choice is awaited, `✎ ❯` while typed text is (`?` and `✎` alone below 64 columns).

```
╭─ Hermes Agent needs your input ────────────────╮
│ 2 questions                                    │
│ ✓ Which colour for the badge?                  │
│     Green                                      │
│ ▸ Which size for the badge?                    │
│   ❯ 1. Small (Recommended)                     │
│     2. Large                                   │
│     3. Other (type your answer)                │
╰────────────────────────────────────────────────╯

  ❓ Which colour for the badge?  (  8.2s · ↓ 40 tok)
  ↑/↓ to select, Enter to lock, Tab next question  (3591s)
 ☤ lab-model │ 1.24K/128K pinned │ … │ 2m │ ⏱ 8s          ─ Lab session
────────────────────────────────────────────────────────
? ❯
────────────────────────────────────────────────────────
```

Every row under the panel ticks: the spinner's elapsed time, the hint's countdown (the clarify
timeout, 3600 s by default, repainted about once a second), and the status bar's clocks. Below 64
columns the spinner row and the rule under the input are not drawn.

Live-probed:

| Key | Panel | Effect |
|---|---|---|
| `Down` | one question | Moves `❯` to the next choice. Locks nothing. |
| `2` | two questions, first active | Locks `Green` for the first question at once (no Enter) and makes the second active. |
| `2` | two questions, second active | Locks `Large`; every question locked, so the panel closes and the turn goes on. |
| `1`, `2` | four choices; two wrapped choices | Lock the choice at once. |
| `4` | one question, three choices | The digit after the last choice is **Other**: the row reads `Other (type below)`, the prompt `✎ ❯`, the hint `type your answer and press Enter`. Locks nothing. |
| text, then `Enter` | `✎` | Locks the typed text as the answer (`? Clarify: … → CockroachDB 23.2`). An `Enter` sent within 50 ms of the text is a newline (`_RAPID_INPUT_ENTER_WINDOW_S`). |
| `Enter` | open-ended (no choices) | The panel opens straight in `✎`; text then `Enter` answers it. |
| `2` | multi-select | Toggles `[x] 2. Tests`. The pointer stays. |
| `Enter` | multi-select, `Tests` toggled, `❯` on `Lint` | Locks the toggled set (`["Tests"]`), not the pointed row. |
| `Ctrl+C` | one question | Cancels the clarify; the turn ends; Hermes keeps running. |

From the source, not probed: `Tab` and `Shift+Tab` move between questions; an empty `Enter` in `✎`
skips the question; `Esc Esc` clears the input; Hermes binds no Escape to the panel.

What the adapter emits (`clarify.ts`):

- A `prompt-select` for a panel waiting for a choice: the prompt is `?`, the hint row is
  `↑/↓ to select, Enter to lock, Tab next question`, and every row from the panel down to the input
  is accounted for: blank rows, the spinner (at most four rows, opening two spaces in and ending in
  its `( 52.6s · ↓ 40 tok)` timer group), the hint, and the status bar, recognised by its `☤`
  marker, when the operator has not turned it off. Any other row there refuses the panel.
- One button per choice of the active question, sending its digit alone, Other included: Other
  only opens the typed answer.
- Nothing for the `✎` screen. There the input is the answer: the Hermes profile reads `✎` as an
  input row, so a send from the phone types the answer there and presses Enter (live, 2026-10-17).
  If the question closes while the text goes in, the panel above the box goes with it, and the Send
  Protocol's check that nothing outside the box moved stops the send before Enter: the panel's rows
  sit above the seven rows the profile lets change.
- Nothing for a question revisited after an Other answer, whose Other row reads
  `Other: <earlier answer>`: its digit opens an empty editor (the earlier text is prefilled only on
  Enter, `_clarify_batch_enter`), so a button with that label would promise a resend it does not do.
- Nothing for a multi-select question (a digit toggles, `Enter` submits) and nothing for a panel
  clipped to a short terminal so that the active question's own row is off the top. Both stay raw
  with the Keys pad, as before this adapter, and get no unread-dialog card: the rows that card binds
  to are the ticking ones under the panel, so live its Ctrl+C tap was refused as "changed" every
  time. The pickers, which tick nothing, do get the card.

The bound region is the panel alone (`signature`), and the model declares `bindTail`
(`lib/tail-lines.ts`): eight rows on a wide pane, where six or seven ticking rows sit under it,
none on a narrow one. Binding the ticking rows is what issue #354's local attempt did; every tap
there answered "Menu changed".
