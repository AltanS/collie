# PI CHOREOGRAPHY NOTES

Measured ground truth for the pi adapter (`agent: "pi"`) against **pi 1.1.0** with the pi question extension
loaded, pinned by the fixture corpus `web/src/fixtures/panes/pi--v110-*.txt`.

## TUI Layout & Tail Anchoring

pi paints its interactive frames at the terminal buffer tail:

### 1. The Composer
- Bounded by horizontal rule rows (`─{8,}`) at top and bottom.
- Draft rows sit between the top and bottom rules.
- Optional slash command palette (`/` commands with `→` pointer) may appear between bottom rule and footer.
- Tail footer: 1 to 4 non-blank lines (default 2 lines: cwd + stats; an extension footer such as a 1-line powerbar).
- Narrow terminal (50 columns) preserves the same frame geometry.

### 2. The pi Question Dialog Frame
- Tail-anchored with at most 2 status rows below its bottom rule.
- Bounded by accent-colored horizontal rules (`─{8,}`) of matching length and foreground color.
- Optional questionnaire tab bar sits on the row immediately following the top rule:
  `← ▢ Q1  ▣ Q2  ✓ Review →` (or compact `← 1  2  ✓ →`).
- Active tab chip carries background styling (`seg.bg`). Answering a question turns `▢` into `▣`.
- Body contains question text, option rows, optional description blocks, or inner editor box.
- Footer hint row sits above bottom rule (preceded by a blank line), separated by bullets (`•`),
  ending in `Esc to cancel` or `Esc to go back`.

### 3. The Free-Answer Editor
- When the user presses Tab or types a free answer, pi opens an inline editor bounded by inner rules:
  ```
  Your answer (an option number or label picks that option):
  ────────────────────────────────────────────────────────────
  hello world▏
  ────────────────────────────────────────────────────────────

  Enter to submit • Esc to go back
  ────────────────────────────────────────────────────────────
  ```
- Submits on raw `Enter` (`newlineSubmits: true`).
- Draft is extracted by stripping leading indentation, software caret (`▏`), and whitespace.

## Dialog Lifts & Key Plans

| pi Dialog State | Collie Block Kind | Key Plan | Guard / Refusals |
|---|---|---|---|
| Single Question (standalone) | `prompt-select`, family `"select"` | Typed digits `["1", "Enter"]`, `["2", "Enter"]`... | Free-answer editor open; tab bar present; >9 options; `Type something.` row omitted from options |
| Questionnaire Single Page | `wizard`, phase `"question"` | Typed digits `["1", "Enter"]`, `["2", "Enter"]`...; nav `Left`/`Right` | Free-answer editor open; unknown/corrupt tab bar; ≠1 active chip; >9 options/tabs |
| Questionnaire Review | `wizard`, phase `"review"` | `submitKeys: ["Enter"]`, `cancelKeys: ["Escape"]` | Answers not matching tab count; rows not numbered 1..n |
| Multi-Select (standalone or tab page) | `multi-select`, phase `"checkbox"` | `toggle: "walkSpace"`, `advanceKeys: ["Enter"]`, `advanceLabel: "Confirm"` | Free-answer editor open; Review active; zero checked options (`advanceNeedsChecked: true`); pointer on other |

### Key Plan Mechanics (`["N", "Enter"]`)
- In pi question dialogs (per `pi--v110` captures, footers `type a number or an answer` and `Enter to select`), typing a digit places the number in the prompt/answer buffer without auto-submitting. The trailing `Enter` in the `["N", "Enter"]` plan commits the selection for that question only.
- When advancing to the next step of a questionnaire, the subsequent question opens in an unanswered state awaiting fresh input; the commit Enter does not bleed into the next question.
- Extensions or dialogs that ignore typed digits fall outside the scope of this adapter.

### Multi-Select Choreography (`walkSpace`)
- pi's multi-select toggles options with `Space`, moves selection with arrow keys (`Up`/`Down`), and confirms with `Enter`.
- Collie uses `walkSpace`: walks the pointer to target row with arrows, verifies position on fresh read, then sends `Space`.
- Confirm (`Enter`) is gated by `advanceNeedsChecked: true`: requires at least 1 checked box AND pointer on an option row.
- If the pointer rests on `Type something.` (`pointer: "other"`), Confirm is refused to avoid triggering free-text editor.

### Questionnaire Review
- Review lists all answered questions. Pressing `Enter` confirms the questionnaire if all questions are answered,
  or jumps directly to the first unanswered tab if incomplete.
- Collie sets `submitAction: "goToFirstUnanswered"` on incomplete Review so the button accurately communicates
  that action to the operator without misleadingly offering to submit incomplete answers.

## Reply Path & Typing While Dialog Is Up

- **`composerReady`**: True when pi's composer is on screen, when the free-answer editor is open, or when a
  pi question dialog page (single, multi, questionnaire question tab) is active. Definitively false on Review
  and on pi core modals (`pi--v110-core-selector.txt`).
- **`dialogAcceptsTyping`**: Opt-in hook allowing phone composer sends while a dialog card is up. Returns `true`
  for single-choice questions (standalone and questionnaire question tabs); `false` on multi-select (where checkboxes
  own the keyboard and Space ticks/unticks), on Review, and on modals. Free-text input on multi-select is handled
  safely once the inline answer editor is open (`locateAnswerEditor`).
- **`customInput`**: Set when a single-choice dialog presents a `Type something.` row. The lifted card renders a
  dedicated action button that focuses the mobile composer with an answer-specific placeholder (`Type an answer…`).
- **`composerPrompt`**: Literal bottom rule line or answer editor last input row within bridge's 6-row tail window.
- **`newlineSubmits`**: True for the free-answer editor and for active question dialog pages where Enter confirms or
  selects, ensuring multiline drafts typed on the phone are refused in preflight before raw newlines can reach the terminal.

## Modal Evidence & Unread Dialog Card (ADR 0053)

- **`cancelKey: "Escape"`**: Citing pi 1.1.0 captures:
  - `pi--v110-core-selector.txt`: `↑/↓ navigate · Enter select · Escape/Ctrl+C to cancel`
  - `pi--v110-single.txt`: `• Esc to cancel`
  - `pi--v110-single-editor-open.txt`: `• Esc to go back`
- **`modalOnScreen`**: Tail-anchored positive evidence requiring bottom horizontal rule (`─{8,}`) followed by at most
  2 status lines, with an Esc-naming key-hint footer immediately above it. Prevents the Escape card from painting
  over plain shells or live composers.

## Live verification

Tested against live pi 1.1.0 with the pi question extension via the harness canary and an isolated second
Collie bridge instance (port 8788) driven by a headed mobile-sized Chrome (402×874@3x).

### 1. Canary Pass & Ledger Stamping
- Ran `bun run canary --agent pi`: all 6 default scenarios passed (`idle`, `drafts` 15/15, `sends` 4/4, `journal` 6/6, `narrow` 3/3, `start-exit` 4/4).
- Fixed composer scanner to tolerate sub-width horizontal rules pasted inside multi-line user drafts (`15-rule` scenario).
- Fixed canary harness liveness freshening during reader invocations.
- Executed `bun run canary --agent pi --record` to update `web/src/lib/harness/verified-versions.json` (`how: "canary"`).

### 2. Live Mobile Taps on Sandbox Panes
- **Single answer**: Tapped option 1 on single-choice dialog (`Which package manager do you use?`), sending `["1", "Enter"]` plan; turn completed immediately with selected answer recorded.
- **Questionnaire navigation & Review submit**: Navigated questionnaire tabs, answered questions Q1..Q9 with option 1 taps, reached Review screen with active `Submit answers` button, and confirmed submission; all 9 answers settled into session.
- **Multi-select toggles & Confirm gating**: Confirmed button was disabled at 0 ticked boxes; toggled option via Space (`walkSpace`) to enable; untoggled back to disabled; toggled two options and confirmed with Enter.
- **Escape card on Pi core modal**: Opened `/model` modal selector; positive evidence footer triggered unread dialog card with `Esc` button; two-tap arming sent `Escape`, cleanly closing the selector and returning to composer.
- **Typed answer while card is up (`dialogAcceptsTyping`)**: Verified `dialogAcceptsTyping` kept phone composer enabled while dialog card was visible; typed custom answer `PostgreSQL with pgvector extension` and sent through type-then-verify; the dialog's answer editor opened and accepted input.
- **Idle composer send**: Typed message into phone composer on idle pane; send verified and submitted; pi completed model turn and replied `OK`.
