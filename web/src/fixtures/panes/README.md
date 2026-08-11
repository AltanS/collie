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
all twenty are asserted that way (`harness/omp.test.ts`). Nine carry a live composer; the other
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
other eight — `fresh-idle`, `working`, `done`, `done--tool-result`, `draft-single`, `draft-wrapped`,
`slash-palette` and `slash-palette--filtered` — are all-LF with **zero**. The alternate screen is a
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
