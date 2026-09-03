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

## Codex corpus (captured 2026-08-22, Codex v0.149.0, sandbox panes)

Byte-faithful `format:ansi` captures with one sanitization pass, every substitution
LENGTH-PRESERVING so row padding stays byte-identical: the operator's username and hostname
(`collie-user`, `collies-macbook-pro-1` — painted in the shell prompt line and host config
path, which no sandbox can avoid), the Darwin per-user temp-dir token
(`sanitizedtempdirtoken000000000`), and the Codex session UUIDs from `codex resume` lines
(`00000000-0000-7000-8000-…`). Codex's chrome is boxless: a
`› ` prompt row (wrapping onto two-space-indented continuation rows) with a dot-separated status
row beneath (`<model> · <cwd> · Context N% left · weekly N% left`); every section of a screen is
separated by exactly one blank row. Approval dialogs need `-c approvals_reviewer=user` — with
`auto_review` (the capture host's default) eligible requests route through a reviewer subagent
and the observed commands were approved with no dialog painted.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `codex--trust-prompt.txt` | First screen in an untrusted directory: trust paragraph, `› 1. Yes, continue / 2. No, quit`, `Press enter to continue`. Digit 2 live-probed: quit immediately | `blocked` |
| `codex--fresh-idle.txt` | Welcome banner box, tips, empty `› Ask Codex to do anything` composer, status row | `idle` |
| `codex--draft.txt` | One-line draft on the `› ` row | `idle` |
| `codex--draft-wrapped.txt` | Long draft word-wrapped onto a two-space-indented continuation row | `idle` |
| `codex--working.txt` | `• Working (3s • esc to interrupt)` above a still-visible composer (Codex queues mid-turn) | `working` |
| `codex--approval-exec.txt` | Exec approval: header, Environment/Reason, `$ command`, options `1. Yes, proceed (y)` / `2. …don't ask again… (p)` / `3. No… (esc)`, enter/esc footer. Digits 1 and 3 live-probed (1 ran the command, 3 rejected it — file verified absent); `y` probed too | `blocked` |
| `codex--ask-fruit.txt` | `request_user_input` card: `Question 1/1` header, options with descriptions plus the auto-added `None of the above`, notes footer. Digit live-probed: answers AND submits | `blocked` |
| `codex--ask-wizard-q1.txt` | Two-question set, `Question 1/2`; footer adds `←/→ to navigate questions`. Digit probed: answers and advances | `blocked` |
| `codex--ask-wizard-q2.txt` | Same set, `Question 2/2`; footer `enter to submit all`. Digit probed: submits the whole set | `blocked` |
| `codex--ask-notes-focused.txt` | Notes box open (`› Add notes`, footer `tab or esc to clear notes`): a digit would TYPE — the adapter refuses to raw | `blocked` |

## Codex 0.150.1 corpus (captured 2026-08-28, herdr 0.8.2, Linux sandbox panes)

Byte-faithful `format:ansi` captures from throwaway herdr tabs in `/tmp/collie-codex-sandbox`
(a `git init` repo on `main`) and `/tmp/collie-codex-nogit`. **No scrubbing was needed** — no
username, hostname or home path appears in any of the five files. Every session carries the
host's `codex_apps` MCP 401 startup warning in its transcript; that is real screen output, not
noise added here. **The headline: 0.150.1's DEFAULT status row is two fields,
`<model-with-reasoning> · <current-dir>`, with no `Context N% left` token** — so the
`Context`-bearing `STATUS_ROW` regex never matches. `isStatusRow` therefore also accepts the row
by its RENDERER PAINT (unstyled two-space indent, coloured non-dim fields, dim ` · ` separators),
which is what locates the composer on every capture below. Live-probed the same session with an explicit
`-c 'tui.status_line=["model-with-reasoning","current-dir","git-branch","context-remaining","weekly-limit"]'`:
`git-branch` renders `main` and `context-remaining` renders `Context 100% left`, so the Context
field is simply absent from the default list, not suppressed by a degraded login.
`codex--v0150-working` is MISSING: the capture host's ChatGPT auth could not refresh
(`Your access token could not be refreshed because your refresh token was already used`), so no
model turn could be run.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `codex--v0150-idle.txt` | Git sandbox, trust and hooks dialogs answered, empty dim `› Ask Codex to do anything` composer over the two-field status row. Pins that the `Context`-bearing regex does NOT match here, and that the styled acceptor does | `idle` |
| `codex--v0150-draft-wrapped.txt` | A 571-character sentence typed into the same composer, word-wrapped onto two two-space-indented continuation rows (the pane is 216 columns, so ~350 chars would not have wrapped three ways) | `idle` |
| `codex--v0150-nogit-idle.txt` | Same idle screen in a directory with no git repo. The status row is the SAME two fields — no branch field to lose, because the default list has none | `idle` |
| `codex--v0150-custom-status.txt` | `-c 'tui.status_line=["model-with-reasoning","current-dir","git-branch"]'` (Context deliberately omitted) with a short draft on the `› ` row. Pins the styled custom-status design: per-field colours and dim ` · ` separators | `idle` |
| `codex--v0150-paste-placeholder.txt` | One `pane.send_text` of exactly 3000 non-newline ASCII characters lands as `[Pasted Content 1024 chars]` — **N is 1024, not 3000**. Codex's TUI keeps only the first 1024 characters of a single burst, so `draftCarriesSend("x".repeat(3000), draft)` is **false** (it is true for a 1024-character send). See `codex/paste.ts` | `idle` |

## Codex 0.151.0 capture (2026-08-29, herdr 0.8.2, Linux sandbox pane)

Byte-faithful `format:ansi` capture from a throwaway herdr tab in `/tmp/collie-codex-sandbox`, with
one length-preserving sanitization pass on the shell prompt the pane opened with (`user@sbox`, `$`).
Status row is 0.150.1's two-field default, so the styled acceptor is what locates the composer here
too. **The headline: a continuation row is NOT always two-space indented.** The gutter is two
spaces, but what follows it is the operator's own text — and a draft carrying a hard line break
whose next line begins with spaces (one shift+enter, trivial to type on a phone) paints a FOUR-space
row. That is an ordinary draft, not a dialog.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `codex--v0151-draft-indented-line.txt` | Two-line draft: the `› ` row, then a hard line break whose text starts with two spaces, painted as a four-space-indented continuation above the two-field status row. `composerReady` must be TRUE — `/^ {2}\S/` refused it, `locateComposer` returned null, and the pane refused every send with "the agent's input box isn't on screen" until the draft was cleared | `idle` |

## Codex mobile chrome (reconstructed 2026-09-03)

**Not a capture.** This one file is RECONSTRUCTED from the two rows reported in
[PR #144](https://github.com/AltanS/collie/pull/144), which were seen on a live Codex pane the
contributor could reach and this repo's capture hosts could not. It carries real ESC bytes in the
shape the report describes, and it is the ground truth for `codex/display.ts` only. Replace it with
a real `format:ansi` capture the next time a Codex pane paints these rows, and delete this note.

Two rows matter, and both are 100 columns wide:

- the **submitted user message**, padded to the terminal width and filled with the truecolor
  `48;2;240;240;240`. The mirror is authored in dark space and inverted under the light theme, so
  that fill lands near-black: a heavy full-width bar on a phone. The two diff rows beneath it carry
  their own backgrounds and must keep them.
- the **labelled separator** `─ Worked for 3m 12s ──…`, a short rule, a label, then a rule to the
  row's end. It is not a pure rule, so blocks.ts leaves it wrapping; the codex adapter clips it.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `codex--submitted-fill-labelled-rule.txt` | Finished turn: the near-white submitted-message row, an assistant line, two coloured diff rows, the labelled `Worked for` rule, then the idle composer and the two-field status row | `idle` |

## Grok corpus (live panes 2026-08-21–23)

Grok's composer is a rounded box at the tail: `╭─…─╮` / `│ ❯ … │` / `╰─ <status> ─╯`, then a blank and a key-hint row. The status run is opaque (display name, optional effort, optional permission mode). User-message bubbles use **square** corners (`┌ ┐ └ ┘`) and must never be read as the composer. **All identifying content genericized** per the repo's public-repo rule.

`grok--fresh-idle` and `grok--draft-single` are byte-faithful `pane.read format:ansi` captures from a sandbox pane on 2026-08-23 (Darwin temp-dir token length-preserved). The remaining Tier-1 chrome files (`grok--draft-wrapped`, `grok--working`, `grok--done`, `grok--user-bubble`) are **structure fixtures**: plain UTF-8, LF, no ESC. Live Grok splits the bottom-border status into three SGR runs (rule, status, rule); that shape is pinned in [`grok/markers.test.ts`](../../lib/harness/grok/markers.test.ts) against a reconstructed ANSI buffer from a 2026-08-21 probe. Dialog captures below **are** byte-faithful `format:ansi` from a sandbox pane the same day.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `grok--fresh-idle.txt` | Empty `│ ❯ │` box, status in the bottom border, idle hint row (`Shift+Tab:mode`). Byte-faithful `format:ansi` 2026-08-23 | `idle` |
| `grok--draft-single.txt` | Stranded one-line draft `testing stuff` on the ❯ row; hint bar adds `Enter:send`. Byte-faithful `format:ansi` 2026-08-23 | `idle` |
| `grok--draft-wrapped.txt` | Draft wrapped onto a continuation row inside the box | `idle` |
| `grok--working.txt` | Mid-turn; empty box; working hint row under the box | `working` |
| `grok--startup.txt` | Fresh-session welcome screen: banner box (logo, menu) above an idle composer whose under-box row is the bare `[stable]` channel chip, not the hint bar. composerReady must be TRUE. Byte-faithful `format:ansi` 2026-08-22 | `idle` |
| `grok--done.txt` | Square user-message bubble ABOVE an idle composer — the bubble must survive the strip | `idle` |
| `grok--user-bubble.txt` | Torn frame: square bubble, no composer. `locateComposer` must return null | — |
| `grok--permission-rm.txt` | Bash `rm` permission card at the tail; `●` on option 1 (always-approve). Composer replaced. Byte-faithful `format:ansi` 2026-08-21 | `blocked` |
| `grok--permission-rm-moved.txt` | Same card, `Tab` once, `●` on option 2 (Yes, proceed) | `blocked` |
| `grok--permission-rm-feedback.txt` | Same card, `●` on option 3 (reject / type feedback). Digit 3 live-probed: rejects immediately; emitted as No, reject | `blocked` |
| `grok--permission-edit.txt` | File-write permission card, FOUR options (`1` always-approve, `2` allow-all-edits-this-session, `3` Yes, `4` No, reject); footer `1/4:select`. Digits 3 and 4 live-probed 2026-08-22 (3 confirms once, does not persist; 4 rejects immediately). Byte-faithful `format:ansi` | `blocked` |
| `grok--plan-approval.txt` | Plan preview above a composer with placeholder `Build anything`; footer `a:approve` / `q:quit plan`. Byte-faithful `format:ansi` 2026-08-21 | `blocked` |
| `grok--ask-color.txt` | `ask_user_question` card: three color options + `z` free-text; footer `Tab:next answer`. Digit `2` live-probed as submit. Composer replaced | `blocked` |
| `grok--ask-color-moved.txt` | Same card after `Tab` | `blocked` |
| `grok--ask-wizard-q1.txt` | Two-question ask, step `[1/2]` Which layout?; `Enter:select` | `blocked` |
| `grok--ask-wizard-q2.txt` | Same questionnaire, `[2/2]` Dark mode?; `Enter:submit` | `blocked` |
| `grok--ask-multi.txt` | Checkbox ask (`[ ]`). Digit submits — stay raw | `blocked` |
| `grok--ask-multi-checked.txt` | Same card, Pepperoni `[x]` after Tab+Space | `blocked` |
| `grok--ask-size.txt` | Two-option radio + `z` row | `blocked` |
| `grok--ask-z-focused.txt` | `z (●) ❯` empty; footer `Esc:back` | `blocked` |
| `grok--ask-z-typed.txt` | `z (●) ❯ med` | `blocked` |
| `grok--ask-esc-park.txt` | Card still up; footer `Tab/Space:question`. Bare digit probed 2026-08-22: silently swallowed; adapter emits `["Tab","N"]` (Tab re-enters, probed 2x) | `blocked` |
| `grok--ask-z-parked.txt` | Esc from a focused `z`: z row repaints idle, footer says `Tab:next answer`, but inner hint reads `Enter:edit` — keyboard still on the free-text field; a digit TYPES (probed 2x). Buttons must lock. Byte-faithful `format:ansi` 2026-08-22 | `blocked` |
| `grok--plan-tab-prompt.txt` | Plan review after `Tab:prompt`; composer empty; footer `Tab:plan` / `Esc:back` | `blocked` |
| `grok--plan-request-changes.txt` | Same geometry after `s` (request changes = type in composer) | `blocked` |


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
| `claude--plan-approval--feedback-focused.txt` | Plan approval with the **feedback input FOCUSED** (`❯` on `4. Tell Claude what to change`, box empty). Claude routes every digit into that field as text while it has focus, so no answer row can be pressed — the model carries `feedback.focused`, the renderer locks every button behind a banner, and `lib/prompt-action.ts` refuses to write (choreography in [`PLAN_FEEDBACK_NOTES.md`](../../lib/grammar/PLAN_FEEDBACK_NOTES.md)) | `blocked` |
| `claude--plan-approval--feedback-typed.txt` | The same dialog after typing into that input and arrowing OFF it: row 4 reads `use a guard clause instead` — the user's own words as the label — with `❯` back on row 3. The digits answer normally here, and only the row's static `shift+tab to approve with this feedback` description keeps it from being up-levelled into a live `keys:["4"]` button carrying that sentence. Collie will not type into a non-empty box (the caret resets to position 0 on re-entry, so it would PREPEND), so the block shows the text read-only | `blocked` |
| `claude--plan-approval--feedback-wrapped.txt` | A 185-character value in that input, **wrapped** onto a continuation line with `❯` arrowed off. The row re-flows rather than windowing, so the value is rebuilt from the label plus the lines above the hint — and those lines push the footer far enough from the options that `MAX_FOOTER_GAP` needs an allowance or the whole dialog stops parsing (it did, before this was measured) | `blocked` |
| `claude--plan-approval--three-row.txt` | The same dialog on an install with `showClearContextOnPlanAccept` **off**: two answers and the input at row **3**, not 4. Pins that nothing keys on a fixed option count or a fixed feedback key | `blocked` |
| `claude--plan-approval--three-row-focused.txt` | Its pair, captured one keystroke later — `3` was sent and nothing else. The ONLY on-screen difference is where `❯` sits, which makes the two together the real-capture proof that `coreSignature` survives the feedback flow's own first write while `signature` does not | `blocked` |
| `claude--select-multiselect-single.txt` | **Single-question multiSelect** AskUserQuestion: checkbox `[ ]` options under a `←  ☐ Toppings  ✔ Submit  →` stepper, "Enter to select · ↑/↓ · Esc" footer. Lifted to a `multi-select` block — the verified interaction is **DIGIT N toggles option N** (pointer-independent); the closed-loop Submit macro walks the pointer to Submit and confirms | `blocked` |
| `claude--select-multiselect-checked.txt` | Same dialog **mid-selection**: some boxes `[✔]` (Mushrooms, Olives), the stepper's question chip flipped to `☒` (answered). Exercises the checked-glyph lift (`[✔]`/`[x]`/`[✓]` → `checked: true`; terminal is source of truth) | `blocked` |
| `claude--select-multiselect-review.txt` | The multiSelect **review/confirm** screen: `←  ☐ Toppings  ✔ Submit  →` stepper, "Ready to submit your answers?" over `❯ 1. Submit answers / 2. Cancel`, with a `⚠ You have not answered all questions` line (`incomplete`). Lifts the `review` phase (submit = key `1`, cancel = key `2`) | `blocked` |

## In-flight send / self-race corpus (captured 2026-07-18, `collie-demo` sandbox pane)

Captures of the ~350ms window where the composer's own reply sits on the `❯` line before the
bridge presses Enter — the frame `extractInputDraft` misreads as a stranded draft. The fix suppresses
it two ways (cross-poll stabilisation + match-last-sent), so these anchor the parse behaviour those
guards lean on (`web/src/hooks/use-terminal-draft.ts`, `web/src/lib/harness/claude/chrome.test.ts`).

| Fixture | State / what's in it |
|---|---|
| `claude--send-inflight.txt` | `/rename` typed, Enter not yet sent: the slash-autocomplete menu above a `❯ /rename` box at the tail — `extractInputDraft` reads `"/rename"` (the transient false positive) |
| `claude--rename-resolved.txt` | A poll later: the command submitted (`✢ Thundering…` spinner), the box line cleared back to bare `❯` — `extractInputDraft` reads `null` |
| `claude--draft-wrapped.txt` | A long stranded draft that soft-wraps onto continuation lines inside the box (`❯ …` + 3 indented lines). Regression fixture: the multi-line box must still strip off the mirror (it used to stay visible), and `extractInputDraft` folds the continuations back into one space-joined line |
| `claude--draft-paste-placeholder.txt` | A send long enough to trip Claude's paste heuristic: the box holds `❯ [Pasted text #3 +3 lines]` — Claude's own token, not our words — which is why the #34 guard could never verify a long message ([`.adr/0010`](../../../../.adr/0010-long-sends-are-verified-via-the-paste-placeholder.md)). Still ordinary composer chrome: an input box with a draft, `composerReady` true, no dialog. **Derived** from `claude--draft-wrapped.txt` (its four draft rows replaced by the token line; every other byte carried over) |

## Background-agents footer corpus (structure from real panes 2026-07-19, SANITIZED)

A newer Claude Code UI paints a "background agents" footer BELOW the statusline/hint — a blank line,
a bold `● main` header, then one `◯ <agent> <task…> · ↓ <tokens>` row per background agent. Those
extra lines broke `locateInputBox` (it tolerated only the statusline window), so the whole box stayed
visible on the mirror **and** no draft chip surfaced. Byte-faithful SGR/CRLF structure taken from real
panes; **all identifying content genericized** (paths, session/agent names, tasks, tokens) per the
repo's public-repo rule. The parser tolerates the footer as chrome by POSITION (a blank-separated
non-blank run below the statusline), never by content.

| Fixture | State / what's in it |
|---|---|
| `claude--draft-footer-empty.txt` | Empty `❯` box with the footer below it — box + statusline + hint + footer all strip; `extractInputDraft` → `null` (no chip) |
| `claude--draft-footer-single.txt` | A single-line stranded draft on the `❯` line, footer below — draft recovered, box + footer stripped |
| `claude--draft-footer-wrapped.txt` | A wrapped multi-line draft, footer below — continuations folded back into one line, whole box + footer stripped |

## Generic-menu corpus (captured 2026-08-05, sandbox pane; decision in [`.adr/0009`](../../../../.adr/0009-a-generic-menu-is-driven-by-the-keys-it-names.md))

Claude Code's `/model` picker — a full-screen modal that is **not** an AskUserQuestion dialog: no
`Enter to select` footer, numbered rows that no grammar may turn into digit buttons (a digit here
confirms **and** saves the user's default for new sessions), and **no input box at the tail**, which
is why a composer send used to be typed straight into it. Claimed by the last-resort footer grammar
(`grammar/menu.ts`), which runs only after all four specific detectors decline.

| Fixture | State / what's in it |
|---|---|
| `claude--menu-model-picker.txt` | Picker open, `❯` on row 1: title `Select model`, five numbered rows with description columns, an `◐ Medium effort ←/→ to adjust` row, and the key-hint footer `Enter to set as default · s to use this session only · Esc to cancel`. Lifts a `menu` block with three actions + Up/Down + Left/Right |
| `claude--menu-model-picker-moved.txt` | The same picker after `2×Down` (`❯` on row 3) — same title and actions, **different signature**. The race-guard fixture: a committing key must refuse a tap on the earlier render, an arrow must not |
| `claude--menu-model-picker-dismissed.txt` | After `Esc`: the ordinary input box + statusline are back. The **negative control** — its statusline is `·`-separated like a key-hint footer, so only the input-box gate keeps it raw |

## Slash-autocomplete corpus (captured 2026-09-01, Claude Code v2.1.257, live pane)

Claude Code's **command-completion popup** — the run of rows it paints directly under the input
box's bottom border while the draft is still a partial slash command. It is the picker's opposite
number: the input box is **live** underneath it, so this is composer chrome plus a list, never a
modal. Read by `harness/claude/autocomplete.ts` and peeled off the tail by `locateInputBox` before
its own walk, because the run is far taller than `MAX_STATUS_LINES` and used to hide the box behind
it — `composerReady` false, every send stalled, the whole 220-column grid soft-wrapped onto the
phone. Selection inside the popup is **SGR-only** (the highlighted row is byte-identical to its
neighbours), so the grammar matches on shape and never on colour.

| Fixture | State / what's in it |
|---|---|
| `claude--autocomplete-slash-long.txt` | `/model` typed on a machine with many skills: 23 popup rows — 17 entries at a description column of 43, six of whose blurbs wrap onto a continuation row. **No statusline and no key-hint footer**: while the popup is open the run reaches the last line of the screen. The capture the bug was diagnosed from |
| `claude--autocomplete-slash-short.txt` | The 3-row shape (`/re` → `/rename`, `/resume`, `/release-notes`) at a description column of 23, first row highlighted. **Derived**: written to the same layout and SGR palette as the long capture, at a width that fits the page |

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
| `claude--wizard-multiselect-q1.txt` | **A multiSelect question as one STEP of a wizard** — the shape no grammar owned. Stepper `←  ☐ Toppings  ☐ Crust  ✔ Submit  →`, checkbox rows with description sub-lines, and a navigable **`Next`** row (not `Submit`) because this isn't the last question |
| `claude--wizard-multiselect-checked.txt` | Same step with boxes 1 and 3 ticked; the question chip flips `☐`→`☒` on the FIRST tick — "answered" means touched, not complete |
| `claude--wizard-multiselect-pointer-next.txt` | Same step with the `❯` pointer on the `Next` row — the state the advance macro walks to and verifies before pressing Enter. Note the footer gains `ctrl+g to edit in Vim` here, which is why the signature stops before it |
| `claude--wizard-multiselect-final.txt` | A multiSelect as the **LAST** step: the row reads `Submit`, and the earlier chip shows `☒ Size` |
| `claude--wizard-preview-wrapped-label.txt` | Same wizard step whose **option 1 label wraps** onto two continuation rows, so the numbered rows are no longer adjacent — the shape that used to defeat detection entirely. **Derived**, not captured: the left gutter of `claude--wizard-preview-q1.txt` was rewritten and every byte from the Notes column rightward carried over untouched (the observed live shape came from a real pane whose content can't go in a public repo) |

All sandbox-generated (a scratch pane driven through the bridge) except `claude--working.txt`,
which is a real pane working on this repo. Every `blocked` fixture's menu sits at the **buffer
tail** — the invariant T2's detector leans on.

## omp corpus (captured 2026-08-11, oh-my-pi `omp` v17.2.12, three sandbox panes)

The second adapter's corpus (`web/src/lib/harness/omp/`). omp inverts Claude's composer layout — the
statusline is painted INTO the box's top border, the draft's LAST fragment sits ON the bottom border
with earlier fragments stacked above it, and autocomplete renders BELOW the box — so none of Claude's
chrome constants transfer and every one of these captures had to be re-derived.

That adapter is **Tier 1**: it strips chrome and re-surfaces the statusline and a stranded draft, and
it up-levels **nothing**. So every row below is a capture the adapter must leave as a raw block, and
all twenty-one are asserted that way (`harness/omp.test.ts`). Ten carry a live composer; the other
eleven are modals the reply pre-flight has to refuse, and they are **six picker screens** (`/model`,
`/settings` and `/resume`, each with a moved-selection twin) plus **five `ask`-tool screens**.

**What this corpus does not contain: omp's tool-approval dialog.** No capture of it exists here, so
nothing below pins `composerReady` on the one screen where a wrong `true` would be worst — a reply
typed at a live approval prompt, with the submit key answering it. Two things stand in for a capture
today, and neither is a substitute for one: `ompBuildBlocks` returns a `raw` block *unconditionally*,
so an approval screen cannot be up-levelled whether or not anyone has seen it; and the pre-flight's
`false` on such a screen is **inferred** from the eleven modals that were captured. The inference now
rests on something the scanner actually tests rather than on a property of the captures: every one of
those eleven is a **box drawn at column 0**, and `locateComposer` refuses any composer with a box
under it (`opensBox`, omp/chrome.ts step (a)), so an approval dialog drawn the way all eleven are is
declined by the same rule. What remains uncaptured is whether omp draws that one as a box at all.
Capturing it is the first thing the later Tier-2 contribution owes, ahead of any grammar.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `omp--fresh-idle.txt` | Fresh session: welcome tips scrollback, `✔ New session started`, an EMPTY composer. omp paints no placeholder in an empty box — there is no `INPUT_PLACEHOLDERS` analogue to write | `idle` |
| `omp--working.txt` | Mid-turn: `⠸ Working… ⟦esc⟧` braille spinner above an empty composer | `working` |
| `omp--done.txt` | Completed turn, and the `◀ N` variant: omp splices a transcript-scroll indicator into the SAME border it paints the statusline into. Pinned as a known limitation of `extractStatusLines` (the trim stops at the `1` segment) | `idle` |
| `omp--done--tool-result.txt` | Completed turn ending in a boxed tool result (`╰───╯`, corner-to-corner) plus a `※ recap:` line. The negative control for the composer-bottom literal: this box closes with no gutter | `idle` |
| `omp--draft-single.txt` | A stranded draft that fits one row, written into the bottom border: `╰─ list the files in this repo ─╯` | `idle` |
| `omp--draft-ghost-suggestion.txt` | The same draft with omp's **inline completion suggestion** painted after it: `repo` unstyled, then `sitory` in a muted foreground, then the padding. The ghost is not in the input buffer, so `extractInputDraft` must read `list the files in this repo` — reading the row verbatim stalled every reply with "Message didn't reach the input box" (`composerGhost`, omp/markers.ts). **Derived** from `omp--draft-single.txt`: the SGR run and six ghost cells were spliced in and six padding cells taken out, so the row still measures 189 cells and every other byte is carried over | `idle` |
| `omp--draft-ghost-suggestion-busy.txt` | The same ghost on the shape **omp 18** draws while the agent is WORKING: the draft itself carries an explicit theme foreground (`38;2;242;244;248`), so the suggestion is no longer "colour after no colour". The first `composerGhost` rule anchored on the draft being unstyled, found no anchor here, and every busy pane went back to stalling. **Derived** from `omp--draft-ghost-suggestion.txt`: one SGR run spliced in before the draft, and the welcome banner's version retargeted `v17.2.12` → `v18.0.11` (same length), so no cell is added or removed | `idle` |
| `omp--draft-wrapped.txt` | A 355-char draft soft-wrapped over three rows — two `│  …  │` continuations ABOVE the bottom border, which carries the tail (`hand`). Regression fixture for the fold direction | `idle` |
| `omp--menu-dismissed.txt` | The welcome panel (a 100-cell `╭───┴───╮` box) plus an MCP failure notice above an empty composer. Negative control: a second, narrower box on screen must not be spliced into the composer's geometry | `idle` |
| `omp--slash-palette.txt` | `/` typed: the autocomplete renders BELOW the box, at the box's own width, with one wrapped entry (3 rows) — a `skill:…` row, which omp assembles from the capturing machine and which is therefore NOT an omp built-in. `extractInputDraft` reads `"/"` | `idle` |
| `omp--slash-palette--filtered.txt` | `/new` typed: five palette rows below the box, all omp built-ins — but note they are everything omp fuzzy-matched for `new`, an accident of one search rather than a curated set. One of three sources for `lib/agent-commands.ts`'s `omp` catalog (collie draws its own palette for an omp pane, because the chrome strip takes omp's); the other two are the tip line and this table — see below | `idle` |
| `omp--select-menu.txt` | The `ask` tool's single-choice dialog (`╭─ Ask ─╮` box, `❯ ○ Red` rows, an `○ Other (type your own)` free-text escape). **Declined** — a different widget whose `handleInput` is unread, and whose escape row would strand a phone user in a free-text input | `blocked` |
| `omp--select-menu-moved.txt` | The same dialog with the pointer moved | `blocked` |
| `omp--select-multi.txt` | The `ask` tool's multi-select (`☐ Cheese` rows under a `toppings / Submit` chip row). **Declined** — same reasons, plus omp never numbers its options, so the shared multi-select model's `String(o.n)` walk has nothing to read | `blocked` |
| `omp--select-multi-checked.txt` | The same dialog mid-selection (`☑ Cheese`) | `blocked` |
| `omp--select-multi-review.txt` | Its review screen — whose body is `1. toppings: Cheese, Olives`, a NUMBERED SUMMARY rather than a numbered menu. The exact digit trap [`.adr/0009`](../../../../.adr/0009-a-generic-menu-is-driven-by-the-keys-it-names.md) exists for | `blocked` |
| `omp--menu-model.txt` | `/model`: a two-pane provider/model picker, footer `Enter assign roles · ↑/↓ providers · → models · type to search · Esc close`. **Declined** — `parseKeyHintFooter` returns `[]` for it (omp writes `<key> <verb>`, not `<key> to <verb>`) | `idle` |
| `omp--menu-model-moved.txt` | The same picker with the selection moved | `idle` |
| `omp--menu-settings.txt` | `/settings`: a tabbed panel. **Declined** — its footer is the ONE omp footer `parseKeyHintFooter` parses, and it yields only `{Jump sections, [Tab]}` + `{Close, [Escape]}`, because `menuKeyFor` rejects the compound tokens (`Enter/Space`, `←/→`, `Type`) its real actions are named with. A modal whose only button is "Jump sections" is worse than the raw mirror | `idle` |
| `omp--menu-settings-moved.txt` | The same panel with the selection moved | `idle` |
| `omp--menu-resume.txt` | `/resume`: the session picker. **Declined** — `parseKeyHintFooter` returns `[]` for its footer too, and the footer is worth reading before writing any omp grammar: `[Del/⌫ delete · Enter select · Tab all projects · Esc cancel]` names `Del`, which is neither on `menuKeyFor`'s whitelist nor a key `pane.send_keys` accepts | `idle` |
| `omp--menu-resume-moved.txt` | The same picker with the selection moved | `idle` |

**No picker's confirm key was ever pressed.** Every dialog here was driven onto the screen, captured,
and dismissed with `Escape`.

**This corpus is also the whole provenance of omp's slash catalog** (`lib/agent-commands.ts`), because
omp ships no command reference to read. A command may only enter that catalog on one of three
warrants, and each row there is marked with which:

1. **A palette row** — a line of omp's own `/` autocomplete in the two captures above.
2. **omp's own tip line** — `` Tip: `/shake` rips heavy tool results out of context to reclaim tokens
   without a full /compact `` , printed above the composer in 8 of these 20 captures. It names
   `/shake` and `/compact` outright and is where both of their descriptions come from.
3. **This table** — a command it records as having been TYPED to produce a fixture (`/model`,
   `/settings`, `/resume`). That the command was run and its screen captured is stronger evidence
   that it exists than a palette row is; it is weaker on what the command *does*, so those rows are
   described by the screen and nothing further.

If you extend the catalog, extend this list first. A command with no warrant here is a guess, and the
catalog types itself into a live shell.

**Sanitized in place, length-preserving — no capture here is raw.** Everything identifying was
rewritten to a fabricated equivalent of the SAME byte length, ASCII for ASCII, so every row's column
alignment and display width survives byte-for-byte. Two classes were replaced, across all 20 files at
once:

- **Environment.** The cwd reads `…abc-0123456789ab/scratchpad/omp-sandbox`; MCP servers read `alfa` /
  `Sample Hub` / `example-cli` / `sandcastle` / `diagram-validator` / `skyline` / `pear` / `spinner`;
  session titles are sandbox prompts and the palette entry reads `skill:sample-doc-tool` over an
  `example.test` URL.
- **Vendor account state.** omp prints the provider a session runs on (the welcome panel's centred
  line) and, in `/model`, marks with `●` which providers the user is signed into above the `○`
  catalogue of the rest. Every name in that `●` column — and every `<provider>/<model>` row it feeds
  in the right pane — was replaced, so both panes stay in sync: `amazon-bedrock`→`example-vendor`,
  `cursor`→`vendor`, `bedrock-mantle`→`example-mantle`, `google`→`sample`, `llama.cpp`→`local-rig`,
  `lm-studio`→`local-lab`, `ollama`→`native`. **Count on yours, not on this list** — the hit counts are
  a property of one capture session, not of omp. `google` and `ollama` match only when NOT
  followed by `-`: the hyphenated `google-vertex` / `google-gemini-cli` / `google-antigravity` /
  `ollama-cloud` rows live in the `○` column, which is omp's shipped catalogue — the same on every
  install, so it is not user data and stays verbatim. `Cursor` also survives inside `/settings`' own
  `Show Hardware Cursor` label, which is a terminal setting, not the vendor.

What the pass deliberately keeps is the SHAPE the detectors read — seven configured providers, their
model counts, the `●`/`○` split, every column boundary. **Redo this before `git add`, not after.** The
whole-corpus check is that `amazon-bedrock|bedrock-mantle|cursor|llama\.cpp|lm-studio` returns only
the two `Show Hardware Cursor` lines, and that `/Users/`, `/home/`, an email, a
`sk-`/`ghp_`/`AKIA`-shaped string and a session UUID each return nothing.

**⚠ Line endings vary per fixture and must NOT be normalised.** Each capture is either **all-CRLF or
all-LF** — never mixed, never a lone `\r`, and none ends in a trailing newline — so a file's CRLF
count always equals its `wc -l`, one FEWER than the rows it draws (27 CRLFs ⇒ 28 rows). The counts
below are that `wc -l`, i.e. what `grep -c` reports. Twelve are all-CRLF: `menu-dismissed` 27, `select-menu` and
`select-menu-moved` 55, `menu-model*` / `menu-resume*` / `menu-settings*` 56, `select-multi*` 58. The
other ten — `fresh-idle`, `working`, `done`, `done--tool-result`, `draft-single`,
`draft-ghost-suggestion`, `draft-ghost-suggestion-busy`, `draft-wrapped`, `slash-palette` and
`slash-palette--filtered` — are all-LF
with **zero**. The alternate screen is a
good guess at which is which but not a rule: `omp--menu-dismissed.txt` paints an ordinary inline
screen and is still all-CRLF, so re-measure rather than infer (`grep -c $'\r' <file>`). Any edit must
be made in **binary mode**; a text-mode Python pass silently strips `\r` and changes every byte count.

Two more things a future omp detector must not assume. omp's pickers run on the **alternate screen**,
so `pane.read source=recent` returns exactly `viewport_rows` lines with no scrollback — "there is
transcript above the dialog" is not available as corroborating evidence the way it is for Claude. And
omp's `agent_status` stays `idle` while a picker is up; only the `ask` tool flips it to `blocked`.
**Nothing may gate on `blocked`.**

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


## agy corpus (captured 2026-08-26, Antigravity CLI 1.1.17, sandbox panes)

Byte-faithful `format:ansi` captures from running sandbox `agy` panes via `scripts/capture-fixture.sh <paneId> <name> 300`. Fastfetch system scrollback was trimmed, and all session identities were sanitized with length-preserving substitutions so row padding and column alignments stay byte-identical: account email (`developer.user@corp.test`) and session plan brain UUIDs (`00000000-0000-7000-8000-000000000000`).

AGY renders a framed input box bounded by horizontal rules (`─`), with status / hint lines below the bottom border (`? for shortcuts`, `esc to cancel`, model/effort metadata). Its dialogs use standard footers (`Enter to select · ↑/↓ to navigate`, `Tab to amend · Esc to cancel`, `Enter to confirm · Esc to cancel`, `ctrl+g to edit`).

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `agy--fresh-idle.txt` | Fresh session: Antigravity header logo and session info, idle input box between horizontal rules, statusline below (`? for shortcuts`) | `idle` |
| `agy--working.txt` | Mid-turn: tool calls, `⣾ Loading...` spinner with tip line, input box with `esc to cancel` status line | `working` |
| `agy--done.txt` | Completed turn: tool output, assistant summary, idle input box | `idle` |
| `agy--select-menu.txt` | AskUserQuestion single-select dialog: question, numbered options 1..3 with description sub-lines, free-text row "4. Write-in...", "↑/↓ Navigate · enter Select · esc Skip" footer | `blocked` |
| `agy--permission-bash.txt` | Bash execution permission dialog: command, "Requesting permission for: ls -la /tmp", options 1..4 (Yes / allow in conversation / persist / No), "↑/↓ Navigate · tab Amend · ctrl+g edit/expand command" footer | `blocked` |
| `agy--permission-edit.txt` | File edit / multi-line write permission dialog: multi-line heredoc preview, options 1..4, "↑/↓ Navigate · tab Amend · ctrl+g edit/expand command · ctrl+r Review" footer | `blocked` |
| `agy--trust-prompt.txt` | Workspace folder trust prompt: "Do you trust the contents of this project?", options "Yes, I trust this folder" / "No, exit", "↑/↓ Navigate · enter Confirm" footer | `blocked` |
| `agy--plan-approval.txt` | Plan approval dialog: plan question, options 1..3 (Execute plan / Request changes / Cancel) + "4. Write-in...", "↑/↓ Navigate · enter Select · esc Skip · ctrl+r Review" footer | `blocked` |


- **A free-text row's LABEL is not a stable marker**: it is the placeholder only while the box is
  empty. Type into the plan dialog's row 4 and the label becomes the user's own sentence. Its
  static `shift+tab to approve with this feedback` description is what identifies it in both
  states — and `❯` sitting on it means the field has focus, where every digit is swallowed as
  text rather than answering ([`PLAN_FEEDBACK_NOTES.md`](../../lib/grammar/PLAN_FEEDBACK_NOTES.md)).
  The row's DIGIT is install-dependent too (3 or 4), so it is read off the screen, never assumed.

