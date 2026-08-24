# Grok `ask_user_question` — keystroke recipe

Captured 2026-08-21 (base card) and 2026-08-22 (park states) on Grok Build 1.0.5 in sandbox
panes. Official keys (Grok user-guide *Keyboard Shortcuts* → Question card): `1`–`9` / `a`–`f`
pick an answer, `z` free-text, `Enter` submit, `Shift+X` dismiss.

Live card (composer replaced, Herdr `blocked`):

```
┃  Which color theme should the dashboard use?
┃  1 (○) Red    Warm red palette
┃  2 (○) Green  Calm green palette
┃  3 (○) Blue   Cool blue palette
┃  z (○) Type your answer here
Tab:next answer  │  Esc:scrollback  │  Shift+x:dismiss
```

Live-probed:

- Digit `2` on a radio card submitted immediately (no trailing Enter).
- `Right` on a two-question card moved `[1/2]` → `[2/2]`. Each step is the current question.
- `z` focused `z (●) ❯`; typing went into that row; footer became `Enter:submit │ Esc:back`.
- Esc parked the card; footer `Tab/Space:question`; the card stayed on screen.
- Checkbox cards (`[ ]`): digit `1` **submitted**; `Tab` then `Space` toggled. Digits are
  unsafe to emit, so checkbox asks stay raw (composerReady is still false — no box).

Park states, probed 2026-08-22 (each twice — once by a QA pass, once re-verified):

- **z-park** (Esc from a focused `z`): the z row repaints IDLE (`z (○) Type your answer here`)
  and the global footer returns to `Tab:next answer`, but the keyboard STAYS on the free-text
  field — a digit types into it (`2` became draft text, not an answer). The one grid-visible
  tell is the inner hint reading `Enter:edit` instead of `Enter:select|submit`. `Up` moved off
  the row and flipped the hint back to `Enter:submit`, after which the digit answered. The
  adapter therefore treats inner `Enter:edit` as focused: buttons lock behind the free-text
  banner. Fixture: `grok--ask-z-parked.txt`.
- **Scrollback-park** (Esc from an option row; footer `Tab/Space:question`): a bare digit is
  silently swallowed — no answer, no typed text, frame unchanged. `Tab` (the footer's own
  named key) re-entered the card and the digit then answered ("Winter" registered). The
  adapter emits `["Tab", "N"]` on this footer; the badge still shows the digit (`keyLabel`).

The adapter lifts a radio `prompt-select` with `keys: ["N"]` only on the complete captured
layout: consecutive 1..n radios, a `z` row, and an inner `Enter:select` / `Enter:submit` /
`Enter:edit` hint — as one contiguous `┃` run with nothing but a couple of blank rows between
the card and its footer (the capture shows exactly one). Wizard steps and Esc-park keep that layout. `z` is modelled as
`feedback` with `purpose: "free-text"` so a focused row locks the option buttons; Collie
does not type into it (the Claude plan-feedback send path is the wrong recipe). A card
missing `z` or the Enter hint, or painting an `a`–`f` option row, returns null. Checkbox
cards return null.
