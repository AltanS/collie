# AskUserQuestion option notes — TUI choreography notes

Empirical findings from driving live Claude Code `AskUserQuestion` dialogs in a sandbox pane
through the bridge (`/api/pane/:id/keys`, `/api/pane/:id/reply`, `pane.read`), 2026-07-05,
Claude Code **2.1.201** (also confirmed against the binary's bundled source). These are the ground
truth behind `preview-select.ts` and the fixture set `web/src/fixtures/panes/claude--*preview*.txt`.

## Where notes exist at all (the big surprise)

The "press `n` to add notes" feature is **NOT part of the standard AskUserQuestion dialog**. It
exists **only in the PREVIEW variant**: a question that is `!multiSelect` **and** has at least one
option carrying a `preview` field (the tool schema's optional per-option
"mockups, code snippets, or visual comparisons" content). Verified live:

- Standard single-question select (no previews): pressing `n` is a **no-op**; the footer never
  mentions notes.
- Standard wizard question (no previews): same — no notes affordance.
- Preview questions — **both** as a single-question dialog and as a step inside a multi-question
  wizard — show the notes UI.

The note is **PER QUESTION, not per option row**. It is attached to whatever the question's final
selection is (or to no selection at all), persists while the pointer moves between options, and is
delivered in the tool result as a per-question annotation.

## Screen anatomy of the preview variant

Completely different layout from the standard select (which is why the T2/T7 grammars must not and
do not match it — the footer sits ~14 lines below the last option row, failing `MAX_FOOTER_GAP`):

```
 ☐ Design                                            ← chip line (single) — or the ←/→ stepper (wizard)

Which widget design should we use?

❯ 1. Boxy                         ┌──────────────────────────────┐
  2. Rounded                      │ (preview pane of the POINTED │
  3. Minimal                      │  option — ASCII/box content) │
                                  └──────────────────────────────┘

                                  Notes: press n to add notes

────────────────────────────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel
```

- Option rows sit in a fixed-width (30-col) **left column with NO description sub-lines**; the
  right pane shows the **pointed** option's preview (or "No preview available").
- The `Notes:` line sits below the preview, **at the same column as the preview pane** — that
  column is the anchor `preview-select.ts` uses to split "option label" from "preview content".
- "Type something." does not appear (the note IS the free-text channel here). "Chat about this"
  appears **unnumbered** below the rule — and is NOT reachable with `Down` (Down clamps at the last
  option), so Collie doesn't up-level it; Esc on the keys pad still cancels.
- The footer is a `select`-family footer (`Enter to select`) **plus the discriminator
  `n to add notes`** — the single most specific anchor for this variant.

## The `Notes:` line — three states

| Buffer shows | Meaning |
|---|---|
| `Notes: press n to add notes` | no note (dim italic hint) |
| `Notes: Add notes on this design…` | note **input focused**, empty (the placeholder; `…` is U+2026) |
| `Notes: <text>` | note text — *focused or blurred* (see below) |

Focused-vs-blurred is discriminated by the **footer**: while the note input is focused the footer
gains `· ctrl+g to edit in nano ·`. (The footer still contains `Enter to select`, so
`classifyFooter` still says `select` — the ctrl+g/plan rule fires later and never sees it.)

The Notes display area is ~60 columns: a longer note is shown **truncated/windowed**, so the
buffer text is not a reliable readback of a long note.

## Key choreography (all verified live)

| Key | Input **blurred** | Input **focused** |
|---|---|---|
| `n` | opens/focuses the note input | types a literal `n` |
| printable chars | mostly no-ops (digits move pointer!) | insert at cursor (state syncs per keystroke) |
| `Escape` | **cancels the whole dialog** | **blurs the input, KEEPING the text** (empty text = note removed, hint returns) |
| `Enter` | selects the pointed row (single: submits the tool call; wizard: answers + advances one step) | **commits the note AND fires the dialog's Enter action** — single-question: submits the whole tool call immediately, *without selecting the pointed row* (resolves `→ (notes only)` if nothing was selected); wizard: advances one step |
| `ctrl+k` | — | kill from cursor to end (works) |
| `ctrl+u` / `ctrl+a` | — | **unsupported, no-ops** (not readline-complete) |
| `Backspace` | — | delete char before cursor; harmless no-op at position 0 |

Further hazards, all observed:

- **Focus is not instantaneous.** Keys sent in the SAME `send_keys` call as the opening `n` can be
  processed before the input takes focus and are swallowed/misrouted (a 67-key one-shot lost its
  first ~35 characters). The choreography must **confirm focus between calls** (poll until the
  footer shows `ctrl+g to edit`).
- **Cursor position on re-focus is unreliable** (a persisted `cursorOffset`; observed both 0 and
  end-of-text). The only deterministic clear is `ctrl+k` (kills the tail) **plus a sweep of
  Backspaces** (kills the head; surplus presses are no-ops).
- **`[digit, Enter]` in ONE `send_keys` call selects the WRONG row** in the preview variant: the
  digit's pointer-move is a queued state update and the Enter in the same input chunk still sees
  the old pointer (observed: sent `["1","Enter"]`, answer was the previously-pointed option 2).
  The standard no-preview select is NOT affected (`["3","Enter"]` re-verified live → picked 3).
  Preview option selection must therefore be **two calls with a pointer-verify poll between**.
- In a wizard, the preview step's digit does **not** instant-select (unlike the no-preview wizard
  step where a digit answers and advances) — it only moves the pointer; `Enter` answers+advances.

## Collie's choreography recipes (what `preview-action.ts` sends)

Select an option (race-guarded at step 1, verified at step 3):

1. fresh read → revision + full model re-derivation must equal the tapped model,
2. `send_keys ["<digit>"]` (pointer move only),
3. poll the pane until the model re-derives with the pointer on the tapped row (bounded),
4. `send_keys ["Enter"]`.

Add / edit / remove a note (race-guarded at step 1, then EVERY stage verified rendered before the
next fires — the render round-trip is what guarantees each write arrives as its own clean input
chunk):

1. fresh read → guard as above; additionally reject if the note input is already focused
   (our keystrokes would be typed into it),
2. `send_keys ["n"]`,
3. poll until the re-derived model shows `note.state === "editing"` (bounded; on timeout we STOP —
   sending Escape blind could cancel the dialog),
4. when replacing an existing note: `send_keys ["ctrl+k", Backspace × 320]` (deterministic clear),
   then poll until the input verifiably shows empty,
5. when the new text is non-empty: `POST reply {text, submit:false}` (one `agent.send` paste —
   immune to the per-key focus/chunking hazards), then poll until the text renders (the input
   windows long text around the trailing cursor, so accept when the typed text *ends with* the
   visible value),
6. `send_keys ["Escape"]` (blur, keep text; with empty text this removes the note) — **verified,
   with one retry**: an Escape written on the heels of the paste can glue onto the same input
   chunk, where the bare ESC byte is misparsed and swallowed (observed live: note text landed but
   the input stayed focused).

Never send `Enter` anywhere in the note flow — it submits the dialog / advances the wizard.
The whole engine was verified end-to-end against a live pane (production functions, real bridge):
replace-note → attached text confirmed → option select → tool call resolved with both the option
and the note.

## Result payload (from the bundled source, matches live behaviour)

Answers gain an `annotations` record keyed by question text:
`{ preview?: <selected option's preview>, notes?: <trimmed note> }`; the tool result text renders
`User notes: <text>` under the answer, and a notes-only submission shows `(notes only)` as the
answer. The wizard's Submit review step does **not** echo notes.

## Fixture corpus (sandbox-captured, PII-scrubbed)

| Fixture | State |
|---|---|
| `claude--select-preview.txt` | Single preview question, pointer on 1, no note (hint line) |
| `claude--select-preview-note-input.txt` | Note input focused, empty: placeholder line + `ctrl+g` footer |
| `claude--select-preview-note-attached.txt` | Note attached ("prefer subtle shadows"), input blurred |
| `claude--wizard-preview-q1.txt` | 2-question wizard, Q1 is a preview step (stepper + preview + hint Notes line) |
| `claude--wizard-preview-note-attached.txt` | Same step with a note attached ("keep cards compact") |
| `claude--v2302-preview-wrapped-rule--w141.txt` | Claude Code 2.1.302 beside a theme plugin's two-column gutter (theme hardening, not vanilla behaviour): the gutter narrows the dialog while Claude Code draws the rule between the `Notes:` line and `Chat about this` at the full pane width, so the rule wraps into a `──` stub row, which the Notes scan reads as part of the rule above it (`isRuleRow`) |
