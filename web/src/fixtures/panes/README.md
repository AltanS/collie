# Pane-buffer fixtures

Byte-faithful captures of real pane buffers as returned by the bridge
(`GET /api/pane/:id?lines=N`, i.e. Herdr `pane.read` with `format:"ansi"`). They contain **real
ESC bytes** (SGR styling only — Herdr's contract) and are the ground truth for the block-renderer
grammars (tracker M1): line splitting, chrome detection, prompt-select extraction, and the
Claude Code transcript grammar are all developed and tested against these files.

Capture a new one on the deployment host with:

```sh
scripts/capture-fixture.sh <paneId> <name> [lines]   # paneIds: /api/snapshot
```

**⚠ This repo is public.** Pane buffers are real terminal output. Review every capture
(`less -R <file>`) for private content before `git add` — prefer generating states in a sandbox
pane over capturing real work sessions.

## Corpus (captured 2026-07-04, Claude Code TUI as of that date)

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `claude--working.txt` | Mid-turn: `●` text blocks, `⎿` results, `✻` spinner with elapsed/tokens, `※` recap line, `❯` user echo, statusline | `working` |
| `claude--fresh-idle.txt` | Fresh session: empty input box between rules, statusline, usage-limit banner, shell MOTD scrollback above | `idle` |
| `claude--done.txt` | Completed turn: `⏺ Write(hello.txt)` call, `⎿` result, `●` summary, idle input box | `done` |
| `claude--trust-prompt.txt` | Folder-trust dialog: `❯ 1. Yes… / 2. No…`, "Enter to confirm · Esc to cancel" | `blocked` |
| `claude--select-menu.txt` | AskUserQuestion: chip line, question, numbered options **with description sub-lines**, "Type something." free-text row, separated "5. Chat about this", "Enter to select · ↑/↓ · Esc" footer | `blocked` |
| `claude--select-multi.txt` | **Multi-question** AskUserQuestion: a stepper header `←  ☒ Focus area  ☐ Scope  ☐ Workflow  ✔ Submit  →` above the current question, "Tab/Arrow keys to navigate" footer. prompt-select deliberately BAILS on this; since T7 the wizard grammar (`grammar/wizard.ts`) claims it | `blocked` |
| `claude--permission-edit.txt` | Edit permission: diff preview, "Do you want to create hello.txt?", `❯ 1. Yes / 2. Yes, allow all edits… (shift+tab) / 3. No`, "Esc to cancel · Tab to amend" | `blocked` |
| `claude--permission-bash.txt` | Bash permission: command + explanation, "This command requires approval", "Do you want to proceed?", scoped don't-ask-again option, "… · ctrl+e to explain" | `blocked` |
| `claude--plan-approval.txt` | ExitPlanMode: plan text, "…ready to execute. Would you like to proceed?", 4 options with hint sub-lines, "ctrl+g to edit in nano · <plan path>" footer | `blocked` |
| `claude--plan-approval--numbered-body.txt` | Plan approval whose plan BODY lists numbered steps ("1. Title / 2. … / 5. TODO stub") inside the option-scan window: the menu is the trailing `1,2,3,4` suffix, body rows drop out (regression fixture for the body-list bug) | `blocked` |
| `claude--select-multiselect-single.txt` | **Single-question multiSelect** AskUserQuestion: checkbox `[ ]` options under a `←  ☐ Toppings  ✔ Submit  →` stepper, "Enter to select · ↑/↓ · Esc" footer. Lifted to a `multi-select` block — the verified interaction is **DIGIT N toggles option N** (pointer-independent); the closed-loop Submit macro walks the pointer to Submit and confirms | `blocked` |
| `claude--select-multiselect-checked.txt` | Same dialog **mid-selection**: some boxes `[✔]` (Mushrooms, Olives), the stepper's question chip flipped to `☒` (answered). Exercises the checked-glyph lift (`[✔]`/`[x]`/`[✓]` → `checked: true`; terminal is source of truth) | `blocked` |
| `claude--select-multiselect-review.txt` | The multiSelect **review/confirm** screen: `←  ☐ Toppings  ✔ Submit  →` stepper, "Ready to submit your answers?" over `❯ 1. Submit answers / 2. Cancel`, with a `⚠ You have not answered all questions` line (`incomplete`). Lifts the `review` phase (submit = key `1`, cancel = key `2`) | `blocked` |

## Wizard corpus (captured 2026-07-05, sandbox pane; choreography in `../../lib/grammar/WIZARD_NOTES.md`)

| Fixture | State / what's in it |
|---|---|
| `claude--wizard-q1.txt` | Fresh 3-question wizard: all chips `☐`, Q1 current (its chip carries the bg-highlight SGR — the only *styling*-based marker in the grammars), options with description sub-lines |
| `claude--wizard-q2.txt` | Q1 answered (`☒`), Q2 current — the state right after a digit instant-selected and auto-advanced |
| `claude--wizard-q1-revisit.txt` | Navigated `Left` back to answered Q1: chosen row shows a trailing ` ✔` (`2. UI ✔`), pointer reset to row 1 |
| `claude--wizard-submit.txt` | Submit review step, all answered: `● question / → answer` pairs, `❯ 1. Submit answers / 2. Cancel` — **no hint footer** (the tail anchor differs from every other dialog) |
| `claude--wizard-submit-unanswered.txt` | Review reached by Right-skipping unanswered questions: `⚠ You have not answered all questions`, submit still offered |

## Preview-variant corpus (captured 2026-07-05, sandbox pane; choreography in `../../lib/grammar/NOTES_NOTES.md`)

The PREVIEW variant of AskUserQuestion (`!multiSelect` + ≥1 option with a `preview` field): a
fixed-width option column, the pointed option's preview pane on the right, and the per-question
**notes** affordance (`n to add notes` in the footer). Detected by `grammar/preview-select.ts`;
deliberately NOT matched by prompt-select or the wizard grammar.

| Fixture | State / what's in it |
|---|---|
| `claude--select-preview.txt` | Single preview question, pointer on row 1, `Notes: press n to add notes` hint |
| `claude--select-preview-note-input.txt` | Note input **focused**: placeholder `Add notes on this design…`, footer gains `ctrl+g to edit in nano` |
| `claude--select-preview-note-attached.txt` | Committed note (`Notes: prefer subtle shadows`), input blurred |
| `claude--wizard-preview-q1.txt` | 2-question wizard whose Q1 is a preview step: stepper header above the preview layout |
| `claude--wizard-preview-note-attached.txt` | Same wizard step with a note attached |

All sandbox-generated (a scratch pane driven through the bridge) except `claude--working.txt`,
which is a real pane working on this repo. Every `blocked` fixture's menu sits at the **buffer
tail** — the invariant T2's detector leans on.

## Lessons already encoded here (don't re-learn them)

- **Match on parsed text, not raw bytes**: SGR codes sit *between* glyphs (`❯` and `1.` are in
  different styled segments), so regexes over the raw buffer miss. Matchers run on
  `StyledLine`/segment text after `parseAnsi` (see `web/src/lib/blocks.ts`).
- **Chrome varies per install**: statusline is user-configured (this one shows
  `[Model] ctx:N% cwd … tokens`), hint footers differ per dialog kind, and a usage banner can sit
  above the input box. Don't anchor chrome detection to one exact string.
- **Menus are heterogeneous**: pointer rows (`❯ N.`), plain numbered rows, description sub-lines,
  and free-text escape rows ("Type something.", "Tell Claude what to change") all occur; footers
  are the most stable discriminator ("Enter to select/confirm", "Esc to cancel").
