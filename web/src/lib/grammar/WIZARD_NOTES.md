# Multi-question AskUserQuestion — TUI choreography notes (T7)

Empirical findings from driving a live Claude Code multi-question `AskUserQuestion` dialog in a
sandbox pane through the bridge (`/api/pane/:id/keys` + `pane.read`), 2026-07-05, Claude Code TUI as
of that date. These are the ground truth behind `wizard.ts` and the fixture set
`web/src/fixtures/panes/claude--wizard-*.txt`.

## Screen anatomy

A multi-question dialog (N questions in ONE tool call) renders a **stepper header** above the
current step, then the current step's body, e.g.:

```
←  ☒ Focus area  ☐ Scope  ☐ Workflow  ✔ Submit  →

What scope should this work have?

❯ 1. Small
     A focused, minimal change touching little surface area.
  2. Medium
  …
  4. Type something.
─────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
```

- **Chips**: one per question, in order, plus a fixed final `✔ Submit` chip, wrapped in `←`/`→`.
- **Glyphs are answered-state only**: `☐` unanswered, `☒` answered. `✔` is the Submit chip always.
- **The CURRENT step is marked by STYLING, not a glyph**: its chip is the one segment on the line
  with a background colour (observed SGR `38;2;0;0;0` + `48;2;177;185;249` — black on light
  purple). Everything else on the line has no background. So "which step am I on" requires the
  parsed SEGMENTS (`AnsiSegment.bg`), not just line text — the only grammar so far that does.
- Only the CURRENT question's options are on screen. Other questions appear only as you navigate.
- A **single-question** AskUserQuestion shows a lone chip (e.g. `☐ Color Theme`) with **no Submit
  chip and no ←/→** — that stays prompt-select territory (T2). The wizard grammar requires ≥2
  question chips AND the Submit chip.

## Navigation model (all verified live)

| Key | Effect |
|---|---|
| `1`…`9` (digit) | **Instantly selects that option AND advances one step right.** No Enter needed — unlike the single-question select ("digit then Enter"). |
| `Up` / `Down` | Move the `❯` pointer within the current question's options. |
| `Enter` | Select the pointed option and advance one step right. |
| `Tab` / `Right` | Next step **without answering** (you can skip past unanswered questions). Clamps at Submit — no wraparound. |
| `Left` | Previous step. |
| `Esc` | Cancels the whole dialog (per footer; not exercised — it aborts the tool call). |

- Answering ALWAYS advances exactly **one step right** — even when re-answering an earlier
  question it advances to the next question in sequence, not to the next unanswered one.
- Answering the LAST question advances to the **Submit review step**.
- Revisiting an answered question: the chosen row gains a trailing ` ✔` (`2. UI ✔`) and the `❯`
  pointer RESETS to row 1 (it does not point at the chosen row).
- `N. Type something.` — free-text answer for the current question (typed via composer, not a
  button). `N. Chat about this` — **aborts the ENTIRE wizard**: the tool call resolves as
  "User declined to answer questions" immediately (verified). It is an escape, not an answer.

## The Submit review step

```
←  ☒ Focus area  ☒ Scope  ☒ Workflow  ✔ Submit  →

Review your answers

 ● Which focus area should we work on?
   → UI
 ● What scope should this work have?
   → Medium
 …

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
```

- **There is NO hint footer** — the buffer's last non-blank line is `2. Cancel`. T2's tail-footer
  anchor (`classifyFooter` on the last line) can never match this state; the wizard grammar anchors
  the review phase on the `1. Submit answers` / `2. Cancel` pair at the tail instead.
- Digit `1` **or** Enter fires the submit (verified both); `2` cancels.
- Reaching Submit with unanswered questions is allowed: the review shows
  `⚠ You have not answered all questions` (and lists only the answered pairs) but still offers
  `1. Submit answers`.

## Round-trip model: INCREMENTAL (decided)

Two candidate models for the phone wizard:

1. **Pre-walk + batch**: on detection, drive `Right`×N reading the buffer after each step to
   collect every question's options, walk back, render the full form offline, then replay
   `digit, digit, …, Enter` on Submit.
2. **Incremental mirror** *(chosen)*: render only what the TUI currently shows — the stepper
   (parsed per-question answered/current state) + the current step's body. Every tap sends exactly
   ONE keystroke (an option's digit; `Left`/`Right` for nav; `1` on the review step to submit),
   then revalidates; the TUI advances itself and the next poll re-derives the next step.

Why incremental wins here:

- **Detection stays passive.** A socket call types into a real terminal (CLAUDE.md security
  posture); the pre-walk would send keystrokes as a side effect of merely RENDERING a pane —
  racing a possibly-active terminal user and mutating pointer state with no user intent.
- **Each tap is atomic and race-guardable** exactly like T2: re-fetch, re-derive the wizard from
  the FRESH buffer, compare against what the user tapped, send one key. A batch replay of
  N digits has no such per-key guard — one drifted step mis-answers everything after it.
- **No client-side form state to drift.** The TUI is the single source of truth for selections;
  the stepper glyphs and the review step echo it back. Collie never has to reconcile "what I think
  you picked" against "what the terminal thinks".
- Cost: one poll round-trip between steps (~1 revalidation; the post-send revalidate makes it
  feel immediate). Acceptable on the phone; correctness beats latency here.

## Fixture corpus (all sandbox-captured, PII-scrubbed)

| Fixture | State |
|---|---|
| `claude--wizard-q1.txt` | Fresh wizard: all `☐`, Q1 current (bg chip on `☐ Focus area`) |
| `claude--wizard-q2.txt` | Q1 answered (`☒`), Q2 current (bg chip on `☐ Scope`) |
| `claude--wizard-q1-revisit.txt` | Navigated back to answered Q1: `2. UI ✔` row, pointer on row 1 |
| `claude--wizard-submit.txt` | Review step, all answered — NO footer, bg chip on `✔ Submit` |
| `claude--wizard-submit-unanswered.txt` | Review step reached via Right-skips: `⚠ You have not answered all questions` |

Plus T2's `claude--select-multi.txt` (a mid-flight question phase) and `claude--select-menu.txt`
(single-question — must keep detecting as prompt-select, never as wizard).
