# Muse dialog choreography notes

Verified keystroke recipes for the four dialogs `harness/muse/` lifts, probed
keystroke-by-keystroke against Muse Code 1.3.0 (1.3.0-R3401.1) in a scratch
Herdr pane (`/tmp/collie-muse-sandbox`, `--approval-mode untrusted
--approval-judge off`) on 2026-09-18. Fixtures:
`web/src/fixtures/panes/muse--*.txt` (18 files, all CRLF, one
length-preserving email sanitization).

Every probe below names the key sent and the screen observed after it. Nothing
here is inferred from the docs or from another harness's recipe — Muse differs
from Claude in three load-bearing ways (digit-moves on questions, Enter-toggles
on checkbox, unnumbered review rows), and each difference was measured, not
assumed.

## The tail all four dialogs share

While any dialog below is up, the composer tail stays on screen (except trust,
which is pre-session): the `── Voice input (⌥ + v to start) ──` rule, the `❯`
row (bare — no placeholder while a dialog owns the keyboard), the full-width
`─` bottom rule, and the `muse-spark-1.3 · <plan> · <cwd> · <mode>` statusline.
So `composerReady` can never be "the box is there" alone: it is "the box is
there AND no dialog detector claims the screen" (the grok plan-menu pattern).

Muse pads every PTY row to full width and opens content rows with a 2-column
grey gutter. Detectors match on rstripped text with the gutter accounted for,
and on SHAPE, never colour: the palette answers OSC 10/11 (light/dark/none
responders, `harness/muse/display.ts`), so SGR values move between installs.

The `◇/◆/◈ Request user input <Id> — running (<timer>)` header carries a
live timer and spinner frames. It anchors detection (`Request user input` +
`— running`) but must never enter a signature.

## 1. Approval — "Would you like to run the following command?"

Fixtures: `muse--approval-ls.txt` (pointer on 1), `muse--approval-ls-moved.txt`
(pointer on 2, after one `Down`).

```
Would you like to run the following command?

  $ ls -la /private/tmp/collie-muse-sandbox
  Stage 1/1
  Current argv: ["ls","-la","/private/tmp/collie-muse-sandbox"]

› 1. Allow this stage once (y)
  2. Always allow in this workspace: ls ... (p)
  3. Abort the entire command (esc)
```

No footer hint row — the dialog ends at the last option. The option rows carry
parenthesised shortcut letters (`(y)`/`(p)`/`(esc)`) that are part of the
label, not separate keys Collie sends. The approval REPLACES the composer:
no `❯` row while it is up.

Probed recipe — digit alone (family `permission`):

- `Down` moves `›` 1 → 2 (the moved twin).
- `Up` moves it back (screen identical to the first capture).
- `1` ALONE approves: the command ran (`◆ Ran command · … · ✓`), no Enter
  needed. `keys: ["1"]` / `["2"]` / `["3"]`.

Option 2 ("Always allow …") persists a workspace rule. It is still a plain
digit answer — the persistence is Muse's own semantics for that row, and the
label says so on the button. No special-casing.

## 2. Single-select question — "Enter to select"

Fixtures: `muse--ask-color.txt` (pointer on 1), `muse--ask-color-moved.txt`
(pointer on 2, after one `Down`), `muse--ask-color-notes-open.txt` (empty
`Note (optional)` row after `Tab`), `muse--ask-color-notes-typed.txt` (note
holds `x` after typing it).

```
◇ Request user input Color — running (22s)

  Which color do you prefer?

  › 1. Red (Recommended)
    2. Green
    3. Blue
    4. None of the above  Optionally, add details in notes (tab).

  Enter to select · ↑/↓ to move · Tab for an optional note · Esc to interrupt
```

Muse appends its own `None of the above` escape as the last numbered row; it
is a regular answer row, not an abort. `(Recommended)` is a label suffix on
zero or one rows.

Probed recipe — digit moves, Enter selects (family `select`, default
`keys: [digit, "Enter"]`):

- `2` while the pointer sat on 2: NO-OP (dialog unchanged). Digits do not
  submit here.
- `3` MOVED the pointer 2 → 3. Digits are pointer jumps.
- `Enter` with the pointer on 3 submitted Blue
  (`Structured user input answered — Color: Blue`).

The notes row OWNS THE KEYBOARD while open, and it opens WITHOUT moving the
pointer or changing the footer — the `Note (optional):` row is the only
signal:

- `Tab` opens `Note (optional): ▌` under the pointed row (pointer stays).
- `x` TYPED into it (`Note (optional): x▌`). A digit would too.
- Second `Tab` closes it, discarding the text.

So prompt-select DECLINES any question region containing a `Note (optional):`
row (raw mirror, no buttons). There is no focus state to model: open means
owned.

## 3. Multi-select question — "Enter to toggle"

Fixtures: `muse--ask-toppings.txt` (3 options + None + Submit, nothing
checked), `muse--ask-toppings-checked.txt` (Pepperoni `[x]`, `1 checked`),
`muse--ask-toppings-notes-open.txt` (empty note row after `Tab`),
`muse--ask-toppings-review.txt` (the review phase), `muse--ask-drinks.txt`
(the 2-option geometry: options + None + Submit are rows 1–4, pinning that
nothing keys on a fixed option count or a fixed Submit digit).

```
◈ Request user input Toppings — running (23s)

  Which pizza toppings do you want?

  › 1. [ ] Cheese (Recommended)
    2. [ ] Pepperoni
    3. [ ] Mushrooms
    4. [ ] None of the above     Optionally, add details in notes (tab).
    5. Submit answer (0 checked)

  Enter to toggle · Submit row to continue · ↑/↓ to move · Tab for an optional note · Esc to
  interrupt
```

The footer WRAPS mid-phrase at this width (`Esc to` / `interrupt`), so the
footer match is a stable prefix over joined rows, never the full string. The
Submit row is numbered like an option (`5. Submit answer (N checked)`) and its
digit floats with the option count. `None of the above` is a plain checkbox
row here, not an escape: `3` + `Enter` on the drinks dialog checked it
(`[x]`, `1 checked`) exactly like any other row.

Probed recipe — navigate, Enter toggles, Submit row + Enter submits. This is
NOT the shared model's digit-toggles assumption (Claude), so the neutral model
carries the toggle recipe explicitly (see `multi-select-model.ts`):

- `2` MOVED the pointer 1 → 2. Nothing toggled (`0 checked`).
- `Enter` on row 2 toggled Pepperoni (`[x]`, `1 checked`). Checked glyph is
  `[x]`.
- `Down ×3` + `Enter` on the Submit row advanced to the REVIEW phase (below),
  it did not submit directly.

The notes row behaves exactly as in single-select (`Tab` toggles,
`Note (optional):` owns the keyboard) and declines the lift the same way.

### 3b. The review phase

```
  Review answers before submit · Enter to edit or submit · ↑/↓ to move · Esc to go back
    Toppings: Pepperoni
  > Submit answers
    Interrupt turn
```

Unnumbered pointer rows (`>` / two spaces), a bold `Review answers before
submit` lead, and one `Question: answer, …` summary row per question. `Esc`
goes BACK to the checkbox phase — it does not cancel. Cancelling is the
`Interrupt turn` row + `Enter`.

Probed: `1` on this screen is SWALLOWED (no change). The shared review recipe
(constant digits) does not apply; the neutral model's review phase carries its
own submit recipe (navigate + `Enter`), same extension as the toggle.

## 4. Trust — "Do you trust this workspace?"

Fixture: `muse--trust-prompt.txt`. Pre-session: no composer, no rules, no
statusline — the dialog is the whole screen.

```
Do you trust this workspace?
Workspace: /private/tmp/collie-muse-sandbox

Trusting allows project-local skills, rules, hooks, and plugin config to load before the model
runs.
Only trust this workspace when you trust its contents.



> 1  Trust and continue
  2  Quit

Use Up/Down or 1/2, then Enter. Esc quits.
```

Options take TWO SPACES after the digit and NO period (`1  Trust…`) — unlike
every other Muse dialog. Pointer is ASCII `>`. The footer names `1/2` ranges
rather than keys.

Probed recipe — digit alone (family `trust`): `1` submitted immediately
(session started, no Enter). `keys: ["1"]` / `["2"]`.

## Decisions the adapter rests on

- **The guarded reply path.** Registering the adapter moves Muse panes off one-shot sends onto
  type-then-verify against the `❯` box, with a paste-token supplement for the per-line
  `[Pasted Content N chars]` collapse (probed: N in code points, threshold in (1000, 1200]).
- **No transcript lookback in a signature.** The rows above a dialog carry live spinner timers, so
  a signature runs question to dialog end. Two consecutive byte-identical dialogs therefore share
  one, and a tap on the first may land on the second: the same command or answer already
  consented to.
- **The checkbox region ends at the footer, not at Submit.** The bridge binds a match only when it
  ends within 6 non-blank rows of the tail, and ending at Submit left 6 rows below it, so every
  first write returned 409 (`not_in_tail`, caught live). Muse's footer is static, so it is safe
  inside the identity span. Conformance pins the tail-window leg on every dialog region.
- **`digit | pointer` choreography in the shared multi-select model.** Muse digits move the pointer
  where Claude's toggle, so the model names the recipe. Claude's detector fills `digit`.
- **A lift needs a live dialog (added at merge, 2026-09-19).** A dialog quoted in the transcript
  can match a detector. So a question, checkbox or review lift also needs the box under it empty,
  and the review screen needs the live `Request user input … — running` header directly above it.
  A screen that fails stays raw. The detectors themselves stay broad.
- **Quoted shapes stay sendable (added 2026-09-22, #260).** Refusing sends on the broad match
  stalled every send once a reply quoted dialog rows, until the transcript moved. A live dialog
  owns the keyboard, so its `❯` is strictly bare (probed: no placeholder while a dialog is up);
  the same shapes above a placeholder or draft box are transcript. `composerReady` and the draft
  reader now refuse a question/checkbox/note match only above a bare box, and a review match only
  with its live header above. Approval and trust need no such check: a match structurally implies
  no live box beside it.
- **Every lift keeps the rows above it (added at merge).** The prompt panel shows neither the
  approval's command nor the trust prompt's folder, so those rows stay on screen as raw text.
- **The review cancel button says `Interrupt turn` (added at merge).** That row ends the whole
  turn, and the button carries the terminal's own words rather than "Cancel".

## What was deliberately NOT lifted

- The command palette, `/resume` picker, `/tasks` drawer and `/workflows`
  control room: out of this file's scope, no captures, no detectors.
- Network/peer approval variants: no capture showed them; they ride along only
  if a future capture shows the approval shape above.
- Plan approval: Muse 1.3.0 showed no plan-approval dialog shape to lift.
- The `!`-shell escape and voice-input rule: chrome/tips, never dialogs.
