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
| `codex--queue-context-inline.txt` | Queue hint and context percentage share one raw footer row while the composer remains visible | `working` |
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
| `codex--v0154-submitted-fill.txt` | Codex 0.154.0, sandbox pane on 2026-09-15: one submitted user message, an assistant turn, a file edit with its unified diff, and the composer box. The message band and the composer are painted `rgb(240,240,240)` and run to the terminal edge; 0.154.0 paints its diff rows as plain text, with no fill at all. See *Codex light fills* below | `idle` |

## Codex 0.156.1 corpus (captured 2026-09-26, herdr, Linux sandbox panes)

Byte-faithful `format:ansi` captures from throwaway panes in `/tmp/collie-codex-debug`, each cut to
the rows its test needs, then scrubbed of the username and hostname (none survived the cut). Dialog
captures ran with `-a on-request -s read-only -c approvals_reviewer=user`. No key was pressed on
these screens while capturing. The new recipes (trust `Enter` / `Down, Enter`, patch `y` /
`Escape`, two-row exec `2`) were probed afterwards the same day in a fresh sandbox pane, see
`APPROVAL_NOTES.md` and `TRUST_NOTES.md`. **The
headline: 0.156.1's default status row drops SGR 2.** Its ` · ` separators carry the theme's
muted foreground (`38;2;135;140;164`), and there is still no `Context` field, so neither acceptor
matched. No default pane had a composer, and the unread-dialog card sat over a live input box. The
styled acceptor now takes either quiet paint, never by colour value (see `isStatusRow` in
`lib/harness/codex/markers.ts`). The composer band now sits on a `48;2;57;57;71` fill.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `codex--v0156-idle.txt` | Empty dim `› Ask Codex to do anything` composer on its fill, over the two-field status row whose separator is a foreground, not SGR 2. `composerReady` must be TRUE | `idle` |
| `codex--v0156-idle-50.txt` | The same idle screen with the pane at 50 columns | `idle` |
| `codex--v0156-draft-multiline.txt` | Three-line draft typed with hard breaks. The status row carries a third field (`Ask one question`) and a right-aligned `⚠ 1 warning · f2 to view` notice after a run of spaces | `idle` |
| `codex--v0156-draft-blank-line.txt` | Two-paragraph draft with a blank row inside the composer | `idle` |
| `codex--v0156-paste-placeholder.txt` | A typed paragraph, a blank row, then `[Pasted Content 1024 chars]`. The draft reads as both; it is not paste evidence on its own | `idle` |
| `codex--v0156-trust.txt` | Rewritten trust prompt: `Folder access`, the folder, `Trust this folder? …`, `› 1. Trust and continue` / `2. Quit`, footer `enter continue · esc quit`. Read as a pointer walk plus Enter (ADR 0055), no digit | `blocked` |
| `codex--v0156-approval-exec-2opt.txt` | Exec approval for a heredoc: the full `$ cat <<'EOF'` block, then only two options, `1. Yes, proceed (y)` / `2. No, and tell Codex what to do differently (esc)` | `blocked` |
| `codex--v0156-approval-exec-wrapped.txt` | Exec approval for a long `echo`: the persistent row 2 wraps onto two rows indented to the label column | `blocked` |
| `codex--v0156-approval-exec-wrapped-50.txt` | Exec approval for `touch` at 50 columns: rows 2 and 3 both wrap, and `(p)` and `(esc)` land on rows of their own | `blocked` |
| `codex--v0156-approval-patch.txt` | Patch approval: `Would you like to make the following edits?`, `Description:` / `Destination:`, `1. Yes, proceed (y)` / `2. Yes, and don't ask again for these files (a)` / `3. No… (esc)`. Buttons send the printed `y` and Escape | `blocked` |

Three more 0.156.1 screens were captured and are NOT in the corpus yet: the update prompt
(`Update now` / `Skip` / `Skip until next version`, footer `enter continue · esc skip`) and the
`/model` and `/permissions` pickers (footer `enter select · esc back`). No grammar reads them, by
decision. The footer names only Enter and Esc. Enter acts on the pointed row, which on the update
prompt runs an installer, and what Esc skips is not stated. So the unread-dialog card, with its one
Escape, is their way out. As fixtures they would show that card, and `unread-dialog.test.ts` lists
every Codex screen that does, so they land together with that list. Their footers are pinned
byte-exact in `codex.test.ts` meanwhile.

## Codex 0.156.1 headless (captured 2026-09-26, herdr 0.9.0, no Herdr client attached, #294)

Byte-faithful `format:ansi` captures from a throwaway Herdr session whose server never had a client
attached, read the way the bridge reads a pane. Codex asks the terminal for its colours at start,
and with no client nothing answers. It then paints the status row's ` · ` separator with no SGR at
all and the composer with no `48;2;57;57;71` fill; the fields keep their colours, and the
placeholder is still SGR 2. Before #294 the acceptor refused a separator with no paint, so every
Codex started this way had no composer and the unread-dialog card sat over a live input box. A
client attached later does not repaint the row; a Codex started after a client has attached once
paints the 0.156.1 client shape above. Each file is cut to the rows from the header box down; the
update notice above it is left out. **No scrubbing was needed**: the sandbox folder is
`/tmp/i294-proj-codex`, and no username, hostname or session UUID is on the kept rows.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `codex--v0156-headless-idle.txt` | Empty dim `› Ask Codex to do anything` with no fill, over `  GPT-6-Luna low · /tmp/i294-proj-codex` whose separator carries no paint. `composerReady` must be TRUE, the draft is null, and no unread-dialog card | `idle` |
| `codex--v0156-headless-draft.txt` | The same pane holding the typed draft `hello from the phone probe`. The draft reads back | `idle` |

## Codex 0.156.1 busy (captured 2026-09-26, herdr 0.9.0, harness canary)

Byte-faithful `format:ansi` captures from the harness canary's own Herdr session (M37/03, the `busy`
scenario), taken while Codex wrote a 500-word story. Each file is cut to the rows from the header
box down; the update notice above it is left out. **No scrubbing was needed**: the project folder is
`/tmp/collie-canary-project`, and no username, hostname or session UUID is on the kept rows.

While the first turn of a thread runs, the status row ends in one more ` · ` and a braille spinner
frame in a colour of its own. The canary saw `⠋` and `⠧`, two of the ten dots frames in the Codex
binary, and a different colour in each of three runs. The frame holds the place of the thread's
title: a few seconds later the same spot reads `Write a sheepdog story`, in the same colour. Before
this capture the frame was painted over as a starfield sparkle (see *Codex's Astra starfield*
below), the row then ended in a bare separator, and a busy Codex had no composer: the unread-dialog
card over the working pane, and a send refused as `blocked`. The spinner is now the row's tail, never
a field and never a sparkle, and only at the very end of a row that is already a whole status row
(`isStatusRow` in `lib/harness/codex/markers.ts`). With a draft in the box, Codex swaps the status row
for its queue hint.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `codex--v0156-busy-streaming.txt` | The story mid-stream above the empty composer, over `  GPT-6-Luna low · /tmp/collie-canary-project · ⠧`. `composerReady` must be TRUE, the draft is null, no unread-dialog card, and the status strip keeps the spinner | `working` |
| `codex--v0156-busy-draft.txt` | Later in the same turn: the draft `a draft typed while codex works` in the box, and the status row replaced by `  tab to queue message … 100% context left`. The draft reads back as send evidence, the check the reply guard makes before it presses Enter | `working` |

## Codex 0.157.1 fullscreen (captured 2026-09-27, herdr 0.9.0, harness canary, #294)

Byte-faithful `format:ansi` captures from the harness canary's own Herdr session, running Codex
0.157.1 from a scratch npm prefix with a temporary `CODEX_HOME`. Each file is the whole screen the
canary saved, from the header box down. **No scrubbing was needed**: the project folder is
`/tmp/collie-canary-project`, and no username, hostname or session UUID is on the kept rows.

**The headline: 0.157.0 turned `tui.fullscreen_transcript` on by default.** In that layout the
status line gets a row of its own, and ONE key-hint row sits straight under it: `? for shortcuts`
with an empty box, `tab to queue message` with a draft while a turn runs, and a right-aligned
`⚠ 1 warning · f2 to view` notice when Codex has one. With a draft and no notice the hint row is
blank. When it was not blank, the status row was no longer the last row, so no default 0.157 pane
had a composer: the unread-dialog card over a live input box, and every send refused. The canary
failed every scenario (idle, drafts, sends, narrow) before the fix. The reader now takes one
indented row straight under the status row as the hint row (`isHintRow` in
`lib/harness/codex/markers.ts`). The dialogs keep the 0.156.1 shape: no status row, footer last.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `codex--v0157-idle.txt` | Empty composer, the status row `  GPT-6-Luna low · /tmp/collie-canary-project`, and under it `  ? for shortcuts` plus the right-aligned notice. `composerReady` must be TRUE, no card | `idle` |
| `codex--v0157-idle-50.txt` | The same at 50 columns: the notice shortens to `⚠ 1 · f2` | `idle` |
| `codex--v0157-draft-notice.txt` | The two-line draft `Reply with only OK.` / `Second line of the message.`. The hint row holds only the notice, after a run of spaces. The draft reads back | `idle` |
| `codex--v0157-busy-streaming.txt` | The first turn of a thread mid-stream: the status row ends in the spinner frame `⠋`, the hint row under it | `working` |

## Codex reporter capture (#294, 2026-09-27, macOS, Herdr 0.9.1, SCRUBBED)

The reporter's `herdr pane read <pane-id> --source recent --lines 200 --format ansi`, taken by
Codex from inside its own pane while it worked, so the screen is mid-turn. The Codex version is not
on the screen. It is the fullscreen layout above, and the hint row reads `← for agents · ? for
shortcuts`: Codex adds `← for agents` when the TUI is attached to a local Codex daemon (the
app-server socket under `CODEX_HOME`). **Scrubbed**: the chat between the first message and the
Working row is cut (it held a home path and a project name), and the project folder in the status
row now reads `~/Code/project`. The first message's echo band, the Working row, the composer band,
the status row and the hint row are byte-faithful, with the reporter's theme colours.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `codex--reporter-294-busy-agents-hint.txt` | An echo `› herdr pane read …` band, `• Working (6s • esc to interrupt)`, the empty composer, `  GPT-6-Luna medium · ~/Code/project · Read recent pane output`, and `  ← for agents · ? for shortcuts` as the last row. `composerReady` must be TRUE, the lowest `›` row is the composer, no card | `working` |

## Codex reporter capture (#317, 2026-09-28, macOS, Codex 0.158.0, Herdr 0.9.1, SCRUBBED)

The reporter's `herdr pane read <pane-id> --source recent --lines 200 --format ansi`, taken from
inside the Codex session while it worked, and redacted by the reporter (equal-display-width
placeholders, published in a gist with the exact bytes as Base64). **Cut further here**: only the
Working row and the composer band below it are kept, so none of the redacted chat is in the tree.
The kept rows are byte-faithful to the reporter's file, theme colours included.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `codex--v0158-goal-notice.txt` | `• Working (5m 47s • esc to interrupt)`, the empty composer, and a status row whose third field carries the padding in its own purple before a right-aligned `Pursuing goal (17h 43m)` (a Codex `/goal`). `  ? for shortcuts` is the last row. Collie 1.14.x refused that row, so the pane had no composer: the unread-dialog card and every send refused. `composerReady` must be TRUE, no card | `working` |

## Codex mobile chrome (reconstructed 2026-09-03)

**Not a capture.** This one file is RECONSTRUCTED from the two rows reported in
[PR #144](https://github.com/AltanS/collie/pull/144), which were seen on a live Codex pane the
contributor could reach and this repo's capture hosts could not. It carries real ESC bytes in the
shape the report describes, and it is the ground truth for the labelled-rule clip only. It is still
the only file carrying a `─ Worked for … ───` row and Codex's old fill-painted diff rows, so it
stays until a capture shows both.

Two rows matter, and both are 100 columns wide:

- the **submitted user message**, padded to the terminal width and filled with the truecolor
  `48;2;240;240;240`. The mirror is authored in dark space and inverted under the light theme, so
  that fill lands near-black: a heavy full-width bar on a phone. The two diff rows beneath it carry
  their own backgrounds and must keep them.
- the **labelled separator** `─ Worked for 3m 12s ──…`, a short rule, a label, then a rule to the
  row's end. `blocks.ts` classifies that neutral structural row through shared `StyledLine.noWrap`
  and mutes only its decorative rule runs; the renderer clips it only while wrapping. Codex
  decoration remains fill-only.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `codex--submitted-fill-labelled-rule.txt` | Finished turn: the near-white submitted-message row, an assistant line, two coloured diff rows, the labelled `Worked for` rule, then the idle composer and the two-field status row | `idle` |

## Codex's Astra starfield

The same capture carries a second thing nobody asked it for: the model was `gpt-6-astra`, and Astra
paints a starfield over the composer band. It is braille glyphs (U+2800 to U+28FF), each one its own
segment with its own grey foreground, on the row above the prompt, after the placeholder, and on the
row under it. Before issue #245 the draft reader took those glyphs for typed text, so this idle
composer reported a stranded draft. The Codex chrome now paints any single braille glyph with its
own colour over with a space before it reads the composer; see `withoutSparkles` in
`lib/harness/codex/markers.ts`. One glyph is spared: a spinner frame that ends the status row after
a ` · ` (see *Codex 0.156.1 busy* above). The starfield in this capture draws only on the eight
single-dot glyphs `⠁⠂⠄⠈⠐⠠⡀⢀`, none of which is a spinner frame.

## Codex light fills (why the rule is luminance, not a value)

`codex--v0154-submitted-fill.txt` was captured to answer PR #144's open ask for a real buffer, and
it answered a second question on the way. The fill in it is `rgb(240,240,240)`, the value #144
reported — but a Codex 0.154.0 pane on the same host, same version, same `tui.theme`, same
workspace, paints `rgb(244,244,244)` on exactly these rows. That buffer is a real work session and
is not committed here; the four-level difference is pinned as a byte string in
[`codex.test.ts`](../../lib/harness/codex.test.ts) instead.

What makes one pane light on 240 and another on 244 is not established. That is the point: an exact
match is a list of the fills someone happened to see, and it fails silently. `lib/harness/light-fill.ts`
matches by luminance instead, and Codex's floor sits at 220 — every fill in this whole corpus is
either Codex's 240 band or 188 and below, so 220 stands in a 52-point gap. A capture that ever lands
inside that gap is the signal to argue the number again.

## Pi 0.85 working editor (reconstructed 2026-09-05)

**Synthetic/sanitized structural reconstruction, not a capture.** Derived from Pi 0.85.0
`CustomEditor`'s embedded `Working` top-border shape at 94 columns, its ANSI segmentation is
constructed. It contains no private transcript payload and claims no byte-faithful captured
provenance: it has a 94-column labelled rule, a 94-space editor row, and a 94-column bottom rule,
with no final newline. It pins the neutral structural clipping and decorative-rule refinement paths
under the raw fallback only; it is not evidence for an agent adapter or status grammar.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `pi--v085-working-editor.txt` | Working editor geometry: `── ⠴ Working ` followed by 81 rules, a padded blank editor row, and the bottom border | `working` |

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
| `grok--reporter-294-draft-newline-hint.txt` | Grok Build 1.0.41 (macOS, Herdr 0.9.1), the reporter's `format:ansi` capture from issue #294 with the project path replaced by an equal-length `~/src/grok-demo`. A new top bar (`main <path> … 3.0K / 200K │ [Dashboard]`), a one-line draft in the box, `grok-4.7 · always-approve` in the bottom border, and a draft bar that adds `Shift+Enter/Opt+Enter:newline`. Collie 1.14.0 and earlier lost the box on that chord list, so every send from the phone failed after typing. `composerReady` must be TRUE and the draft reads back | `idle` |


## Corpus (captured 2026-07-04, Claude Code TUI as of that date)

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `claude--working.txt` | Mid-turn: `●` text blocks, `⎿` results, `✻` spinner with elapsed/tokens, `※` recap line, `❯` user echo, statusline | `working` |
| `claude--fresh-idle.txt` | Fresh session: empty input box between rules, statusline, usage-limit banner, shell MOTD scrollback above | `idle` |
| `claude--done.txt` | Completed turn: `⏺ Write(hello.txt)` call, `⎿` result, `●` summary, idle input box | `done` |
| `claude--trust-prompt.txt` | Folder-trust dialog: `❯ 1. Yes… / 2. No…`, "Enter to confirm · Esc to cancel" | `blocked` |
| `claude--trust-prompt-unnumbered.txt` | The SAME dialog on Claude Code 2.1.278 (captured 2026-09-22, 120 columns, sanitised length-preservingly: the shell prompt's username and hostname only): the rows lost their numbers and the pointer parks on the QUIT row — `❯ No, exit` / `  Yes, I trust this folder`, same "Enter to confirm · Esc to cancel" footer. Lifted by the pointed-list arm of the prompt-select grammar ([ADR 0055](../../../../.adr/0055-a-pointed-list-is-walked-then-confirmed.md)): a tap is the arrow walk from the pointer plus Enter, and no digit is synthesised because the screen printed none | `blocked` |
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
| `claude--workflow-view.txt` | Claude Code 2.1.285's **dynamic-workflow view**, captured 2026-09-30 at 226 columns from a throwaway `/tmp` lab run, paused with `p`. A two-pane box: five phases on the left with a partial `3 Verify the classification 1/3`, the running agent on the right with its model and token count. The lid is TITLED (`╭ Phases ───┬ Read the corpus · 1 agent ───╮`), so the floor's `┴` is what anchors the table run. The screen of [discussion #301](https://github.com/AltanS/collie/discussions/301): before [ADR 0072](../../../../.adr/0072-a-two-pane-box-pans.md) every `│ … │` row of it was CLIPPED on a phone, which is why the report shows a band of stacked rules and a `· 74…` cut off the right edge. Nothing in it is this machine's: the workflow's name, phases and agent labels were all authored for the lab | `working` |

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
| `claude--menu-effort-slider.txt` | The `/effort` slider (82 × 49, promoted from `claude-lab--menu-effort-slider--w82.txt`): a full-width rule, the title `Effort`, a `───` scale with a `▲` marker and a row of labels, **no numbered options**, and the key-hint footer `←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel`. Its footer phrase used to file it as the folder-trust prompt and silence the generic menu ([`.adr/0053`](../../../../.adr/0053-an-unread-dialog-still-has-a-way-out.md)); it now lifts a `menu` block titled `Effort` with Enter (Confirm), `s` (This session only), Escape (Cancel) and the Left/Right arrows labelled with the value under the `▲` — `xhigh` here |
| `claude--menu-effort-slider--w120.txt` | The same slider at 120 × 49, captured 2026-09-21 from a fresh isolated config with `/effort` opened and no arrow pressed, so its value is `high` where the 82-column file reads `xhigh`. It is the position-independence fixture: the labels sit at other columns and the Effort grammar still names the value. **Wider, not narrower, on purpose** — Claude lays the slider out as a flex row, so under about 86 columns the scale and the footer both wrap, the labels break mid-word, and the screen names no keys on one line. 40 and 60 columns were captured and discarded then; they are back below as `--w40` and `--w60`, because the grammar reads the wrapped shape too since 2026-09-22 |
| `claude--menu-effort-slider--w132.txt` | The same slider at 132 columns, captured live 2026-09-22. **Cropped to the dialog**: the file holds three blank rows, then the region's opening rule down to the footer, and nothing above it. The transcript this dialog opened over was the operator's own work and does not belong in a public repo, so it was cut rather than scrubbed; the kept rows are byte-identical to the capture. It is the WHOLE-SCALE fixture: six levels `low medium high xhigh max ultracode` on one label row, a `┆` divider in the track before `ultracode`, and a second label row `xhigh + workflows` under it that the grammar ignores because only the first non-blank row under the marker is the label row. The marker stands over `medium`, so `nav.leftRight` reads `label: "medium"` with all six in `values`, and the card renders one tappable chip per level ([`.adr/0054`](../../../../.adr/0054-a-printed-scale-is-tappable.md)) |
| `claude--menu-effort-slider--w80.txt` | The same slider at 80 × 40, captured live 2026-09-22 on Claude Code 2.1.278. **The narrowest width that still renders whole**: one label row with all six levels, one track row, one footer row. It is the control for the two wrapped captures below — same session, same reading, `label: "medium"` with all six in `values` — so a difference between it and them is the wrap and nothing else. The whole 40-row capture is kept, welcome banner included; the pane held no transcript above the dialog, so there was nothing to crop and nothing to scrub. Plain text: this capture carries no SGR bytes |
| `claude--menu-effort-slider--w60.txt` | The same slider at 60 × 40, captured live 2026-09-22. **Wrapped three ways at once.** `Faster` and `Smarter` break mid-word, the track runs over TWO rows with the `▲` on the first, three of the six levels break into a head and a fragment printed under it in the same column (`mediu` over `m`, `hig` over `h`, `ultracod` over `e`), and the footer runs over two rows. The grammar steps over the second track row, rebuilds each level from its two halves, and joins the footer rows back before parsing them, so it reads the same six levels and the same three keys as the 132-column file. `xhigh + workflows` sits two rows below the labels and stays out of `values`. Same whole-capture and plain-text notes as `--w80` |
| `claude--menu-effort-slider--w40.txt` | The same slider at 40 × 40, captured live 2026-09-22, and **the most wrapped shape there is**: ALL SIX levels break in two (`lo` over `w`, `medi` over `um`, `ultra` over `code`) and the footer runs over THREE rows. Everything else reads as at 60 columns, which is the point of having both — the merge is alignment, not a label list. Same whole-capture and plain-text notes as `--w80` |
| `claude--menu-effort-slider--w80-low.txt` | 80 × 40, `low` selected, captured live 2026-09-22: lifts exactly as `--w80` does, `label: "low"` |
| `claude--menu-effort-slider--w80-ultracode.txt` | 80 × 40, `ultracode` selected, captured live 2026-09-22: lifts exactly as `--w80` does, `label: "ultracode"` |
| `claude--menu-effort-slider--w60-low.txt` | 60 × 40, `low` selected, captured live 2026-09-22: wraps and rebuilds exactly as `--w60` does, `label: "low"` |
| `claude--menu-effort-slider--w60-ultracode.txt` | 60 × 40, `ultracode` selected, captured live 2026-09-22: **lifts**, with the marker over `ultracode` and all six levels. With `ultracode` selected the dialog repaints flush-left and unwrapped, and the footer runs onto a second row the TERMINAL broke at column 0 rather than Claude's flex wrap: the first row ends at column 57 of 60 and `only` could not follow it. It is the evidence for `readKeyHintFooter`'s soft-wrap exception — an indent-0 continuation joins the block when the row above had no room for its first word — so the three footer keys and the `←/→` phrase all survive the join |
| `claude--menu-effort-slider--w40-low.txt` | 40 × 40, `low` selected, captured live 2026-09-22: **declines.** At 40 columns with the marker leftmost Claude draws no `▲` at all — `low` is marked by colour alone — so no grammar lifts the screen and the unread-dialog card shows instead |
| `claude--menu-effort-slider--w40-ultracode.txt` | 40 × 40, `ultracode` selected, captured live 2026-09-22: **declines.** A genuine Claude Code 2.1.278 render glitch — labels truncated (`xhigh      m`), no marker, no divider — so the Effort grammar declines and the generic `menu` grammar lifts with Cancel only |
| `claude--menu-resume-picker--w120-first.txt` | The `/resume` session picker at 120 × 40, captured live 2026-09-22 on Claude Code 2.1.278 in `/tmp/resume-lab`, pointer on the first of four sessions. Lifts as a `prompt-select` list (resume.ts, ADR 0058): four sessions, each with its meta row as the description, the pointed one sending Enter and the rest walking Down, then Cancel. The footer wraps onto two rows and never names Enter or the arrows |
| `claude--menu-resume-picker--w120-third.txt` | The same picker, pointer on the third session: the rows above walk Up, the row below walks Down |
| `claude--menu-resume-picker--w120-search.txt` | The same picker with `hi` typed into the search box: one match, **no pointer glyph**, and the footer changes to `Type to Search · Enter to select · Esc to clear`. The single session sends Enter; the Esc row reads Clear |
| `claude--menu-resume-picker--w60-first.txt` | 60 × 40, pointer on the first session: the footer wraps onto three rows and still reads whole. The weekly-limit banner above the dialog is kept |
| `claude--menu-resume-picker--w80-second.txt` | 80 × 40, pointer on the second session |
| `claude--menu-resume-picker--w120-all-sanitized.txt` | **Sanitized.** The Ctrl+A all-projects view at 120 × 40: title `Resume session (1 of 50)`, a `now` age on the first row, a project path on every meta row, and a `↓` scroll marker in the pointer column of the last visible row, which is still a session. The capture listed real paths and session titles from other repositories; each one outside `/tmp/resume-lab` was replaced by an invented string of the same length, so every row keeps its width |

## Slash-autocomplete corpus (captured 2026-09-01, Claude Code v2.1.257, live pane)

Claude Code's **command-completion popup** — the run of rows it paints directly under the input
box's bottom border while the draft is still a partial slash command. It is the picker's opposite
number: the input box is **live** underneath it, so this is composer chrome plus a list, never a
modal. Read by `harness/claude/autocomplete.ts` and classified as the input box's tail by
`locateInputBox`, because the run is far taller than `MAX_STATUS_LINES` and used to hide the box
behind it — `composerReady` false, every send stalled, the whole 220-column grid soft-wrapped onto
the phone. Since ADR 0048 the box is found by its own frame first, so a popup row the grammar cannot
read no longer hides it. Selection inside the popup is **SGR-only** (the highlighted row is byte-identical to its
neighbours), so the grammar matches on shape and never on colour.

| Fixture | State / what's in it |
|---|---|
| `claude--autocomplete-slash-long.txt` | `/model` typed on a machine with many skills: 23 popup rows — 17 entries at a description column of 43, six of whose blurbs wrap onto a continuation row. **No statusline and no key-hint footer**: while the popup is open the run reaches the last line of the screen. The capture the bug was diagnosed from |
| `claude--autocomplete-slash-short.txt` | The 3-row shape (`/re` → `/rename`, `/resume`, `/release-notes`) at a description column of 23, first row highlighted. **Derived**: written to the same layout and SGR palette as the long capture, at a width that fits the page |
| `claude--autocomplete-slash-clipped.txt` | `/model` typed on an **82-column** pane: 27 popup rows, 19 entries at a description column of 31, descriptions wrapped to two rows and clipped with a trailing `…`. One plugin command's name is clipped from the left to `…ugin:refactor-dependencies`, the row that used to end the run early, hide the box and stall the send. **Hand-built** from a live 82-column observation (2026-09-17): the layout is the observed one, the session label (`demo-session`), transcript and command names are neutral stand-ins, none from the operator's workspace |

## Model-alias capture (2026-09-13, Claude Code v2.1.270, throwaway Herdr pane)

One byte-faithful `pane.read format:ansi` capture, and the only thing it is evidence for is that
Claude Code takes an ALIAS as an argument to `/model`. The harness bar's Claude Model chooser offers
`opus`, `sonnet`, `haiku` and `default`, and those four names are the one set of strings in
[`harness-bar.ts`](../../lib/harness-bar.ts) that no published catalog vouches for — so the row cites
this file. `/model sonnet` was typed into an idle pane in `/tmp/fable-capture-claude` and Enter
pressed; nothing else was sent, and no model turn was ever run. Claude answered on the row under the
echo, and the statusline under it moved from `[Opus·medium]` to `[Sonnet·xhigh]` in the same frame.
That acknowledgement is the whole point of the file: it says the command was understood, not merely
that it was accepted as text.

CRLF throughout with no trailing newline; `wc -l` is 62.

**One sanitization pass, LENGTH-PRESERVING, two substitutions.** The welcome banner names the
subscription the session runs on (`Claude Max` → `Claude Pro`), and the statusline's `LIMITS` row
prints per-account quota, whose four values become zeroes (`12%`, `31m`, `14%`, `18h` → `00%`, `00m`,
`00%`, `00h`) the way the OMP approval corpus below zeroes its own. Byte length is unchanged, 2799
before and after. Nothing else needed it: the cwd is a throwaway `/tmp` directory, and no username,
hostname, home path, email, session id or credential-shaped string appears in the file.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `claude--model-alias.txt` | `❯ /model sonnet` echoed on a filled row, then `⎿ Set model to Sonnet 5 and saved as your default for new sessions`, a screen of blank rows, and the idle input box above a `LIMITS` row and a `[Sonnet·xhigh]` statusline | `idle` |

**Running this capture changes the operator's saved default.** Claude's own sentence says so, and the
`model` key in `~/.claude/settings.json` really moved. Put it back by hand after capturing, or capture
with an isolated `CLAUDE_CONFIG_DIR`.

## Capture lab corpus (captured 2026-09-17, re-verified 2026-09-22 against Claude Code 2.1.278, throwaway Herdr session)

66 byte-faithful `pane.read format:ansi` captures from ONE real Claude Code session, driven through
a throwaway Herdr session (`--session claude-lab`) in a `/tmp` git project seeded with fake
commands and skills, at seven pane widths from 40 to 200 columns. Taken for tracker M31 to prove the
box-anchored locator ([ADR 0048](../../../../.adr/0048-the-input-box-is-found-by-its-own-frame.md))
against real screens instead of hand-built ones. **Width is a recorded fact here**: it is in the
file name (`--w<cols>`, plus `--h<rows>` where the pane was short), and it is in the table below.
The renderer was the classic TUI, the config directory was isolated, and no user plugins, hooks or
skills were loaded.

**The 2026-09-22 ritual run.** The lab was stood up again against Claude Code 2.1.278 and every
state in the table below was re-captured at its recorded widths. Sixty-three states came back with
the SAME reading the corpus already records, so nothing regressed. Fifty of those files carry the
2026-09-22 bytes; thirteen keep their 2026-09-17 bytes on purpose, because swapping them would break
a curated per-fixture table in another suite: the five `menu-*` and four `permission-*`/three
`plan-approval*` captures are pinned byte-exactly in `harness/prompt-binding-contract.test.ts`, and
on the new permission and plan screens the welcome banner has scrolled away so the word "Claude"
never appears — the `isAlienBuffer` promotion trap described further down. `statusline-numbered-rows`
is held for the same reason. One state, `survey-rating-above-box`, could not be reproduced: the
session-quality survey is time- and sample-gated, and it did not fire during the run. Its string is
still in the 2.1.278 binary, so the screen still exists; the fixture is left alone.

Kept fresh by a standing tracker ritual, owned and scheduled:
`tracker ritual run claude-capture-lab`. The ritual's trigger is a Claude Code
version change, not the calendar; its first step compares the machine's
`claude --version` against `claudeCodeVersion` in `claude-lab-corpus.json`
below.

`claude-lab-corpus.json` beside
[`harness/claude/claude-lab-corpus.test.ts`](../../lib/harness/claude/claude-lab-corpus.test.ts)
carries the reading a CORRECT locator would produce for every file here, written from the screen
rather than from the code, and the test asserts it. The critical line it holds: on every capture
with a live dialog the locator reports **no** box. Four screens are pinned as known gaps, each with
its reason in the table entry — the background-agents screen, a wrapped draft whose continuation row
opens with `❯`, shell (`!`) mode, and a statusline printing numbered rows. Deleting a gap's fields
when a fix lands is how the table signals the fix.

Since tracker M34 every entry also declares `expected.blockKind`, the block kind a correct pipeline
would lift from that screen, and `expected.keys` where that kind is interactive, the keystrokes the
screen itself offers, spelled the way Collie sends them. The test asserts both against the pipeline,
so a Claude release that changes a dialog's layout turns into a red line instead of a silent raw
mirror. An entry whose screen shows a dialog the pipeline still returns raw carries `knownRaw` with a
reason that names the grammar which would claim it, and one whose kind is right but whose key set is
short carries `knownKeyGap` with the set it emits today. Both follow the same ritual as the other
gaps: when the grammar lands, delete the field, do not edit the expectation.

**Two captures the lab recommended are deliberately NOT here:** its 82-column Edit-permission
screens, at 49 and at 30 rows. Every other Claude capture in this directory names Claude somewhere
on screen — usually in the welcome banner, sometimes in a `No, and tell Claude what to do
differently` option row — and that name is what `harness/agy/markers.ts` `isAlienBuffer` reads to
keep the agy adapter off a foreign buffer. On those two screens the banner has scrolled away and the
third option is a bare `No`, so the word never appears, and agy's prompt-select then lifts Claude's
numbered options. The cross-adapter fail-closed contract in `harness/agy/agy.test.ts` covers every
`.txt` in this directory, so it cannot hold while those two files are on disk. The older corpus
passed that guard by luck, not by design. Promoting them needs an agy-side fix first, not a wider
name list: the screens carry no Claude-specific phrase to match.

**The prefix is `claude-lab--`, not `claude--`, on purpose.** Six suites glob `claude--*.txt` and
check the whole Claude corpus against a hand-curated per-fixture table. Adding 66 captures to all of
them in one mechanical edit would bury the signals those tables exist to raise. These files are
ordinary Claude captures all the same; promote one into `claude--` by hand when a suite there wants
it.

**One sanitization pass, LENGTH-PRESERVING.** Only the `/status` screen carried identity (an email
address, an organisation name and a session id); those became `alice@exampleco.dev` and zeroes. No
username, hostname, home path or real project path appears in any file: the session ran from
`/tmp/claude-lab/project` and every command and skill name in the popups is a lab invention.

| Fixture | Cols × rows | State / what's in it |
|---|---|---|
| `claude-lab--agents-screen--w40.txt` | 40 × 49 | background agents screen (← from the composer): a typeable box whose Enter returns to the conversation, one-row key-hint footer under the box |
| `claude-lab--agents-screen--w82.txt` | 82 × 49 | background agents screen (← from the composer): a typeable box whose Enter returns to the conversation, key-hint footer under the box (enter · space · ctrl+x · ?) |
| `claude-lab--compacting--w82.txt` | 82 × 49 | /compact running: progress bar row above a live empty box |
| `claude-lab--draft-adversarial--w120.txt` | 120 × 49 | multiline draft holding a ❯ row, numbered rows and a ─── rule inside the box |
| `claude-lab--draft-adversarial--w40.txt` | 40 × 49 | multiline draft holding a ❯ row, numbered rows and a ─── rule inside the box |
| `claude-lab--draft-adversarial--w82.txt` | 82 × 49 | multiline draft holding a ❯ row, numbered rows and a ─── rule inside the box |
| `claude-lab--draft-long-wrapped--w40.txt` | 40 × 49 | long draft wrapped over several rows in the box |
| `claude-lab--draft-long-wrapped--w82.txt` | 82 × 49 | long draft wrapped over several rows in the box |
| `claude-lab--draft-paste-placeholder--w82.txt` | 82 × 49 | pasted block collapsed to a placeholder token in the box; hint row reads 'paste again to expand' |
| `claude-lab--draft-paste-plus-text--w82.txt` | 82 × 49 | paste placeholder followed by typed text |
| `claude-lab--draft-short--w40.txt` | 40 × 49 | one-line draft after a turn |
| `claude-lab--draft-short--w82.txt` | 82 × 49 | one-line draft after a turn |
| `claude-lab--history-search-match--w82.txt` | 82 × 49 | ctrl+r search with a match filled into the box; the box text is a recalled prompt, not typed |
| `claude-lab--idle-after-turn--w200.txt` | 200 × 49 | box after a finished turn, transcript above, ghost suggestion in box |
| `claude-lab--idle-after-turn--w40.txt` | 40 × 49 | box after a finished turn, transcript above, ghost suggestion in box |
| `claude-lab--idle-after-turn--w82.txt` | 82 × 49 | box after a finished turn, transcript above, ghost suggestion in box |
| `claude-lab--idle-fresh--w200.txt` | 200 × 49 | fresh session, empty box with ghost suggestion, statusline + mode hint |
| `claude-lab--idle-fresh--w40.txt` | 40 × 49 | fresh session, empty box with ghost suggestion, statusline + mode hint |
| `claude-lab--idle-fresh--w82.txt` | 82 × 49 | fresh session, empty box with ghost suggestion, statusline + mode hint |
| `claude-lab--idle-ghost-suggestion--w82.txt` | 82 × 49 | empty box painted with a faint ghost suggestion; draft must read null |
| `claude-lab--idle-labelled-top-border--w41.txt` | 41 × 49 | top border carries the session label ('─── Read README.md ─'); at narrow widths the label crowds the flank |
| `claude-lab--idle-labelled-top-border--w83.txt` | 83 × 49 | top border carries the session label ('─── Read README.md ─'); at narrow widths the label crowds the flank |
| `claude-lab--interrupted--w82.txt` | 82 × 49 | after Esc: 'Interrupted · What should Claude do instead?' row above a live empty box |
| `claude-lab--menu-config-panel--w82.txt` | 82 × 49 | /config settings panel: tab row, rounded ╭─╮ search box, scrolling list, key-hint footer |
| `claude-lab--menu-effort-slider--w82.txt` | 82 × 49 | /effort picker: a ─── slider row with ▲ marker, no numbered options, key-hint footer |
| `claude-lab--menu-model-picker--w82.txt` | 82 × 49 | /model picker: numbered options, effort row, 'Enter to set as default · s … · Esc to cancel' footer |
| `claude-lab--menu-resume-picker--w83.txt` | 83 × 49 | /resume session picker: ▔ top rule, rounded search box, ❯ pointer row, two-row key-hint footer |
| `claude-lab--menu-rewind--w82.txt` | 82 × 49 | esc-esc Rewind picker: ▔ top rule, ❯ pointer, 'Enter to continue · Esc to cancel' footer |
| `claude-lab--menu-status-screen--w82.txt` | 82 × 49 | /status screen: tab row, key/value rows, 'Esc to cancel' footer (contains account identity — sanitized) |
| `claude-lab--mode-bash--w40.txt` | 40 × 49 | shell (!) mode: prompt line starts with '!' and carries no ❯ marker; box is live |
| `claude-lab--mode-bash--w82.txt` | 82 × 49 | shell (!) mode: prompt line starts with '!' and carries no ❯ marker; box is live |
| `claude-lab--mode-memory--w82.txt` | 82 × 49 | memory (#) draft in the box |
| `claude-lab--permission-bash--w40.txt` | 40 × 49 | Bash command permission dialog, 4 numbered options, 'Esc to cancel · Tab to amend' footer |
| `claude-lab--permission-bash--w82.txt` | 82 × 49 | Bash command permission dialog, 4 numbered options, 'Esc to cancel · Tab to amend' footer |
| `claude-lab--permission-webfetch--w82.txt` | 82 × 49 | WebFetch permission dialog; last option ends with '(esc)' and there is no separate footer row |
| `claude-lab--permission-write--w82.txt` | 82 × 49 | Create-file permission dialog with a numbered new-file preview between ╌ rules |
| `claude-lab--plan-approval--w82--h30.txt` | 82 × 30 | plan approval on a 30-row pane |
| `claude-lab--plan-approval--w82.txt` | 82 × 49 | plan approval dialog: plan body between ╌ rules, three numbered options, path footer |
| `claude-lab--plan-approval-feedback-typed--w82.txt` | 82 × 49 | plan approval with feedback text typed into option 3 |
| `claude-lab--popup-at-file--w40.txt` | 40 × 49 | @-file mention popup ('+ path' rows) under the box; no popup grammar exists for it |
| `claude-lab--popup-at-file--w82.txt` | 82 × 49 | @-file mention popup ('+ path' rows) under the box; no popup grammar exists for it |
| `claude-lab--popup-slash-all--w40.txt` | 40 × 49 | '/' alone: full command list popup under the box |
| `claude-lab--popup-slash-all--w82--h30.txt` | 82 × 30 | '/' alone on a 30-row pane: popup taller than the pane, clipped |
| `claude-lab--popup-slash-all--w82.txt` | 82 × 49 | '/' alone: full command list popup under the box |
| `claude-lab--popup-slash-all-clipped--w82.txt` | 82 × 49 | '/packages': every visible name left-clipped with '…' |
| `claude-lab--popup-slash-clipped--w120.txt` | 120 × 49 | '/refactor': three left-clipped '…' command names incl. a project namespaced one — the ADR 0048 regression shape |
| `claude-lab--popup-slash-clipped--w200.txt` | 200 × 49 | '/refactor': three left-clipped '…' command names incl. a project namespaced one — the ADR 0048 regression shape |
| `claude-lab--popup-slash-clipped--w60.txt` | 60 × 49 | '/refactor': three left-clipped '…' command names incl. a project namespaced one — the ADR 0048 regression shape |
| `claude-lab--popup-slash-clipped--w82.txt` | 82 × 49 | '/refactor': three left-clipped '…' command names incl. a project namespaced one — the ADR 0048 regression shape |
| `claude-lab--popup-slash-mo--w82.txt` | 82 × 49 | '/mo' prefix popup; contains a left-clipped name '…nthropic-skills:import-memory' |
| `claude-lab--popup-slash-model-exact--w82.txt` | 82 × 49 | '/model' typed exactly, fuzzy popup still open |
| `claude-lab--popup-slash-nomatch--w82.txt` | 82 × 49 | popup with a single 'No commands match' row and no statusline; truth is a popup, a statusline reading is tolerable |
| `claude-lab--post-compact--w82.txt` | 82 × 49 | screen right after /compact finished: compacted summary rows above a live empty box |
| `claude-lab--statusline-10row--w82.txt` | 82 × 49 | 10-row statusline + hint: taller than MAX_STATUS_LINES, so the tail cannot be a statusline; box is live |
| `claude-lab--statusline-3row--w82.txt` | 82 × 49 | 3-row statusline plus the mode hint row (4 rows under the box) |
| `claude-lab--statusline-none--w82.txt` | 82 × 49 | no statusline at all: only the mode hint row under the box |
| `claude-lab--statusline-numbered-rows--w82.txt` | 82 × 49 | statusline rows holding '1. ' items and the words 'Esc to'; still a statusline, box is live |
| `claude-lab--statusline-prompt-row--w82.txt` | 82 × 49 | statusline whose first row starts with '❯ ' — a frame mark below the box |
| `claude-lab--statusline-rule-row--w82.txt` | 82 × 49 | statusline whose first row is '─ main ─────' — a rule below the box |
| `claude-lab--survey-rating-above-box--w82.txt` | 82 × 49 | session rating prompt ('1: Bad 2: Fine 3: Good 0: Dismiss') sits ABOVE a live box; digits go to the survey |
| `claude-lab--tasks-panel--w40.txt` | 40 × 49 | /tasks background-task panel (new in Claude Code 2.1.277): ▔ top rule, 'Background' title, empty-state row, key-hint footer wrapped onto two rows |
| `claude-lab--tasks-panel--w82.txt` | 82 × 49 | /tasks background-task panel (new in Claude Code 2.1.277): ▔ top rule, 'Background' title, empty-state row, one-line key-hint footer |
| `claude-lab--transcript-dialog-lookalike--w82.txt` | 82 × 49 | the transcript above the box holds '1. Yes / 2. No / Enter to select' rows: a dialog lookalike that must not refuse the live box |
| `claude-lab--working-popup-open--w82.txt` | 82 × 49 | slash popup with clipped names painted ABOVE the box while a tool runs; the tail under the box is the statusline |
| `claude-lab--working-queued-message--w82.txt` | 82 × 49 | queued '❯ …' row above the box while working; the box is empty under it (draft must read null) |
| `claude-lab--working-spinner--w82.txt` | 82 × 49 | tool running, spinner line above a live empty box |

## Dialog input corpus (captured 2026-09-26, Claude Code 2.1.283, herdr 0.9.0, throwaway Herdr panes)

Dialogs the phone could not read, or read wrong, found while chasing an operator report that
"line breaks" made Collie say it cannot read a dialog. Sandbox repos under `/tmp`, scrubbed with a
length-changing pass (user and host names, home paths, session ids zeroed), trimmed to the tail.
Every key behaviour named below was sent one keystroke at a time and read back.

| Fixture | State / what's in it |
|---|---|
| `claude--v2283-permission-amend-focused.txt` | Bash permission dialog after Tab on row 1: `❯ 1. Yes, and tell Claude what to do next`, footer shrinks to `Esc to cancel`. A digit here is typed into the note (`❯ 1. Yes, 2`) |
| `claude--v2283-permission-amend-typed.txt` | The same note holding two typed lines (`Yes, use b instead` / `and also c`), pointer on it |
| `claude--v2283-permission-amend-no-off-row.txt` | Tab on row 4 opens `No, and tell Claude what to do differently`; typed two lines, then `Up`: pointer on row 3, note kept. Off the note, digits answer (digit 4 from row 2 rejected the command) |
| `claude--v2283-ask-type-something-focused.txt` | AskUserQuestion, pointer on the empty `4. Type something.`; footer gains `ctrl+g to edit in nano`. A digit is typed into the field (`❯ 3. 1`) |
| `claude--v2283-ask-type-something-typed-two-lines.txt` | The field holding `my own answer` / `second line of my answer`, pointer on it |
| `claude--v2283-ask-type-something-typed-off-row.txt` | The field holding `1`, pointer moved up onto `2. Banana` |
| `claude--v2283-ask-two-line-question.txt` | A question written on two lines, painted with a `│` gutter; option descriptions whose line break herdr renders as U+FFFD |
| `claude--v2283-ask-long-question--w50.txt` | A 25-word question wrapped to three gutter rows at 50 columns |
| `claude--v2283-trust--w50.txt` | Folder-trust prompt at 50 columns; the `?` sits in the middle row of a five-row paragraph |
| `claude--v2283-multiselect-type-something-focused.txt` | multiSelect, pointer on `4. [ ] Type something`. Off the field, a typed row toggles with its digit like any other (measured) |
| `claude--v2283-wizard-two-line-question.txt` | Two-question wizard, step 1, question on two gutter rows |
| `claude--v2283-shell-before-first-frame.txt` | The shell prompt with `claude-danger` typed, read while herdr already reported the agent as `claude` (about 0.3 s before the first frame) |
| `claude--v2283-shell-after-exit.txt` | The shell prompt just after Claude exited, still reported as `claude` (about 0.5 s) |

## Draft-frame and modal-edge corpus (captured 2026-09-26, Claude Code 2.1.283, herdr 0.9.0, throwaway Herdr panes)

Two screens the phone read wrong. A draft holding a pasted rule or shell prompt hid its own input
box, and every slash-command modal opened under a `▔` (U+2594) edge that no grammar took as a region
top. Sandbox pane in `/tmp`, scrubbed for user and host names, trimmed to the tail rows each test
needs. The `▔` edge carries Claude's effort label near its right end (`▔▔▔…▔ ● high · /effort ▔`),
so it is not a plain rule.

| Fixture | State / what's in it |
|---|---|
| `claude--v2283-draft-rule.txt` | Live box, draft `see this output:` / `────────────────────` / `some text` / `────────────────────` / `end`. The two rules are indented continuation rows; the box stands and the whole draft reads back (ADR 0048 addendum 2026-09-26) |
| `claude--v2283-draft-prompt.txt` | Live box, draft `my shell said:` / `❯ ls -la` / `and then nothing`. The indented `❯` row is draft text, not the prompt row |
| `claude--v2283-slash-mcp.txt` | `/mcp` under a labelled `▔` edge, no `─` rule above the title. Footer `↑/↓ to navigate · Enter to confirm · Esc to cancel`. Lifts `menu` `Manage MCP servers` |
| `claude--v2283-slash-hooks.txt` | `/hooks`, a tall list: the `▔` edge sits 37 rows above the footer, past the 30-row rule window. Lifts `menu` `Hooks` |
| `claude--v2283-slash-effort.txt` | The `/effort` slider under the labelled edge, marker on `high`. The Effort grammar lifts it with all four keys and the scale |
| `claude--v2283-slash-export.txt` | `/export` picker: two numbered rows and a lone `Esc to cancel` footer. Lifts `menu` with one Cancel action and Up/Down, never a digit |
| `claude--v2283-slash-usage.txt` | `/usage` info panel under the edge, tab bar as its first row, lone `Esc to cancel` footer. Lifts `menu` with one Cancel action |

## Plugin marketplaces corpus (captured 2026-09-27, Claude Code 2.1.283, herdr 0.9.0, private Herdr session)

The Marketplaces tab of `/plugin` and the page one marketplace opens. Both footers say `Enter to
select`, so the generic menu stood aside and the phone showed only the unread-dialog card; the
`harness/claude/marketplaces.ts` grammar reads them now. Captured in a private Herdr session with a
copied `CLAUDE_CONFIG_DIR` (deleted after the run), in `/tmp/plugins-lab/project`, with two scratch
local marketplaces, `lab-market` (six installed plugins with long made-up descriptions, so its page
grows as tall as a real one) and `demo-market` (one plugin, none installed). The public
`claude-plugins-official` marketplace appears in every list because Claude adds it on its own. Each
file is a byte-faithful `herdr pane read --source recent --lines 300 --format ansi`, the call the
bridge's `/api/pane` route makes. No sanitising was needed: a scan for user and host names, home
paths and e-mail addresses finds none.

Every state was captured in both renderers, `"tui": "default"` (classic, no infix) and `"tui":
"fullscreen"` (`fullscreen-` infix), at 40, 82 and 120 columns (`--w<cols>`, 40 rows). The keys were
sent with `herdr pane send-keys`, the call the phone's buttons make: `u` marked the row, Enter applied
it, and Claude answered `✔ Updated 1 marketplace`.

| Fixture | State / what's in it |
|---|---|
| `claude--v2283-[fullscreen-]plugin-marketplaces-add--w{40,82,120}.txt` | The tab, `❯` on `+ Add Marketplace`. Footer `Enter to select · u to update · d to remove · Esc to go back`, wrapped onto two rows at 40 columns. Lifts `menu` `Manage marketplaces`: Select, Update (`u`), Go back, Up/Down. No `d` |
| `claude--v2283-[fullscreen-]plugin-marketplaces-pointed--w{40,82,120}.txt` | The same tab, `❯` on `lab-market`. Same reading |
| `claude--v2283-[fullscreen-]plugin-marketplaces-pending--w{40,82,120}.txt` | After `u`: `lab-market [UPDATE]`, `Pending changes: Enter to apply`, footer `Enter to apply changes · Esc to cancel` (two rows at 40 columns). Lifts `menu` `Manage marketplaces`: Apply changes, Cancel, Up/Down |
| `claude--v2283-[fullscreen-]plugin-marketplaces-updated--w{40,82,120}.txt` | After Enter: the menu is closed and the chat shows `✔ Updated 1 marketplace` above an ordinary box. Idle, raw |
| `claude--v2283-plugin-marketplace-detail--w{40,82,120}.txt` | `lab-market`'s page, `❯` on `Browse plugins (6)`, footer `Enter to select · Esc to go back`. The name row sits 29 to 54 rows above the footer, past the generic region scan. Lifts `menu` titled `lab-market`: Select, Go back, Up/Down |
| `claude--v2283-fullscreen-plugin-marketplace-detail--w120.txt` | The same page, full screen, 120 columns: it fits, so it reads as above |
| `claude--v2283-fullscreen-plugin-marketplace-detail--w{40,82}.txt` | **Clipped.** The same page, full screen: taller than the 40-row pane, so Claude clips it at the bottom and the footer is not on screen (at 40 columns the action rows are gone too). The screen names no key, so no grammar reads it and no unread card shows; typing stays refused. Moving the `❯` to the last row does not bring the footer back |
| `claude--v2283-fullscreen-plugin-marketplace-detail-short--w{40,82,120}.txt` | `demo-market`'s page, full screen: short enough to keep its footer. Lifts `menu` titled `demo-market`: Select, Go back, Up/Down |
| `claude--v2283-plugin-marketplace-detail-remove--w82.txt` | `demo-market`'s page with the `❯` on `Remove marketplace`. Lifts `menu` with Go back and Up/Down only: Enter here opens the remove confirm, which the phone cannot read |
| `claude--v2283-plugin-marketplace-detail-updated--w82.txt` | `lab-market`'s page after Enter on `Update marketplace`: `✔ Updated 1 marketplace` above the action rows, `❯` on the Update row. Same reading as the page |
| `claude--v2283-fullscreen-plugin-marketplaces-changed--w{40,82}.txt` | Esc from that page, full screen: back on the tab, whose `▔` edge now carries `Plugins changed. Run /reload-plugins to activate.` At 40 columns the label crowds out the edge's left run (` Plugins changed. Run /reload-plugins… ▔`), which `region-top.ts`'s edge shape does not take, so the marketplaces grammar accepts that crowded edge itself. Same reading as the tab |
| `claude--v2283-plugin-marketplaces-add-form--w82.txt` | Enter on `+ Add Marketplace`: a boxed text field, `Enter to add · Esc to cancel`. Not claimed by the marketplaces grammar; the unread card offers Escape |

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

**omp's tool-approval dialog now has its own section below** ("OMP tool-approval corpus", captured
2026-09-10). It used to be this corpus's known gap, and the reason it mattered is worth keeping:
`ompBuildBlocks` returns a `raw` block *unconditionally*, so an approval screen could never be
up-levelled whether or not anyone had seen it — but the pre-flight's `false` on one was **inferred**
from the eleven modals here rather than measured, on the one screen where a wrong `true` would be
worst. That inference rested on a premise nothing tested: whether omp draws that screen as a box at
all. It does, and the captures below measure it.

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
| `omp--select-menu.txt` | The `ask` tool's single-choice dialog (`╭─ Ask ─╮` box, `❯ ○ Red` rows, an `○ Other (type your own)` free-text escape), footer `Enter select · n note · ↑/↓ move · Esc cancel`. Declined until 2026-10-02; **lifted** since [ADR 0077](../../../../.adr/0077-the-omp-ask-single-select-is-lifted-and-its-multi-select-is-not.md) as a pointed list (`omp/ask.ts`), `Other` included, because the screen it opens is the answer editor the phone already reads | `blocked` |
| `omp--select-menu-moved.txt` | The same dialog with the pointer moved to Blue. Lifted: Red walks `Up` twice | `blocked` |
| `omp--select-multi.txt` | The `ask` tool's multi-select (`☐ Cheese` rows under a `toppings / Submit` chip row), footer `Space/Enter toggle · n note · ↑/↓ move · Tab/←/→ · Esc cancel`. **Declined** ([ADR 0077](../../../../.adr/0077-the-omp-ask-single-select-is-lifted-and-its-multi-select-is-not.md)): Enter toggles here and submits in 18.4.10, and omp never numbers its options, so neither shared toggle recipe (a digit, or a digit-jump then Enter) can drive it | `blocked` |
| `omp--select-multi-checked.txt` | The same dialog mid-selection (`☑ Cheese`) | `blocked` |
| `omp--select-multi-review.txt` | Its review screen — whose body is `1. toppings: Cheese, Olives`, a NUMBERED SUMMARY rather than a numbered menu. The exact digit trap [`.adr/0009`](../../../../.adr/0009-a-generic-menu-is-driven-by-the-keys-it-names.md) exists for | `blocked` |
| `omp--menu-model.txt` | `/model`: a two-pane provider/model picker, footer `Enter assign roles · ↑/↓ providers · → models · type to search · Esc close`. **Declined** — `parseKeyHintFooter` returns `[]` for it (omp writes `<key> <verb>`, not `<key> to <verb>`) | `idle` |
| `omp--menu-model-moved.txt` | The same picker with the selection moved | `idle` |
| `omp--menu-settings.txt` | `/settings`: a tabbed panel. **Declined** — its footer is the ONE omp footer `parseKeyHintFooter` parses, and it yields only `{Jump sections, [Tab]}` + `{Close, [Escape]}`, because `menuKeyFor` rejects the compound tokens (`Enter/Space`, `←/→`, `Type`) its real actions are named with. A modal whose only button is "Jump sections" is worse than the raw mirror | `idle` |
| `omp--menu-settings-moved.txt` | The same panel with the selection moved | `idle` |
| `omp--menu-resume.txt` | `/resume`: the session picker, unboxed (omp 17.x to 18.1): `Resume Session (current folder)`, a rule, a `>` search row, then sessions as blank-separated groups, the pointer `❯` in column 0, footer `[Del/⌫ delete · Enter select · Tab all projects · Esc cancel]`. One titled session (three rows) and two UNTITLED ones that print only first prompt and meta (two rows). **Lifted** since [ADR 0076](../../../../.adr/0076-the-omp-resume-picker-is-lifted-and-every-omp-modal-has-a-way-out.md) (`omp/resume.ts`): the footer prints `Enter select`, so a tap is the pointer walk plus Enter. It was declined until then because `parseKeyHintFooter` returns `[]` for the footer, and `Del` is neither on `menuKeyFor`'s whitelist nor a key `pane.send_keys` accepts, which is why delete is not on the card | `idle` |
| `omp--menu-resume-moved.txt` | The same picker with the pointer on the third session, a two-row one. Lifted: the first two walk Up | `idle` |

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

## OMP 18.1.10 rule composer corpus (captured 2026-09-05, herdr 0.8.x, version not recorded by the capture, sandbox pane)

Three byte-faithful `pane.read format:ansi` captures from a throwaway Herdr pane in a generic git
sandbox, with OMP 18.1.10 launched under an isolated `composer.shape: rule` config overlay. No
substitution was needed: the visible cwd is the generic `…ie-rule-sandbox`, the draft text is
synthetic, and the files contain no account, host, home-directory, session, credential-shaped string
or UUID. All three are CRLF throughout with no trailing newline; their `wc -l` counts are 28, 28 and
32 respectively.

This shape has no bottom border. Its OMP-local scanner (`harness/omp/rule.ts`) therefore accepts only
the complete renderer choreography at the pane tail: a top rule directly adjacent to `❯`, at most
100 two-space continuation rows, exactly one blank gap, then one standalone status row as the final
non-blank row. The OMP modal corpus and every Claude, Codex and Grok fixture are rejection cohorts;
the adapter conformance suite requires `composerReady` and its prompt binding to decline them.
Nothing is shared with the Claude harness beyond independently recognizing similar glyph geometry.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `omp--v18-rule-idle.txt` | Empty `❯` row below the top rule, one blank gap, then the standalone status row | `idle` |
| `omp--v18-rule-draft.txt` | The same tail with `COLLIE_RULE_DRAFT` stranded on its single prompt row | `idle` |
| `omp--v18-rule-wrapped.txt` | A five-row wrapped draft whose final `s` is a styled inline suggestion, not part of the input buffer | `idle` |

Live verification drove this checkout's real Collie UI against the same OMP 18.1.10 sandbox. With
`COLLIE_RULE_18110_STALE` stranded in the rule composer, the guard bound the clear to that exact
prompt, typed `COLLIE_RULE_18110_LIVE_ACK` with `submit:false`, read the pane back, then issued the
empty `submit:true`; the pane rendered the exact marker and not the stale prefix. With `/model` open,
the UI retained `COLLIE_RULE_18110_MODAL_GUARD`, offered the explicit override, sent no `/reply` or
`/keys` write, and left the modal unchanged.

## OMP tool-approval corpus (captured 2026-09-10, oh-my-pi `omp` v18.1.17, herdr 0.9.0, two sandbox panes)

Three byte-faithful `pane.read format:ansi` captures from throwaway Herdr panes in
`/tmp/collie-omp-sandbox` (a `git init` repo), taken with `scripts/capture-fixture.sh`. They close the
gap `harness/omp/index.ts` named: the tool-approval dialog, which the omp adapter declined without
anyone ever having captured it.

**One sanitization pass, LENGTH-PRESERVING.** The operator's statusline is the final row and names
per-account quota. Two substitutions there, both same-length and with the SGR escape sequences left
untouched: every DIGIT becomes `0`, and the account labels become generic (`A`/`B`/`C`/`D` for the
Claude profiles, `codex1`/`codex2` for the Codex accounts). The row's byte length is unchanged — 1267
bytes before and after, all three files. Nothing else needed substitution: no username, hostname,
home path, session id or credential-shaped string appears in any of the three. LF throughout with no
trailing newline; their `wc -l` counts are 52, 48 and 48.

The dialog is a BOX AT COLUMN 0 that spans the pane, titled `Allow tool: <tool>`, with two option
rows (`Approve` then `Deny`) and an `up/down navigate  enter select  esc cancel` footer. Every row of
it opens with a Box Drawing character — `╭`, `│`, `╰` — which is what `markers.ts`'s `BOX_ROW` matches,
so `locateComposer` refuses the composer beneath it. That is the premise `omp/index.ts` had to infer
and these captures measure.

**The body fields are not fixed.** A bash approval gated by a config `approval: prompt` pattern
carries `Reason:` (naming the pattern) and `Command:`. A `write` approval gated by
`--approval-mode always-ask` carries `Path:` and `Content:`, and `Content:` runs onto its own row, so
a body field can be multi-line. `Reason:` appeared only on the pattern-gated capture, so it looks
tied to WHY approval was requested rather than to the tool — one example each, so that is a
hypothesis, not a finding.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `omp--approval-bash.txt` | bash approval from a config pattern: `Reason: Prompt required by bash pattern: gh issue create *`, `Command: gh issue create --help`, Approve selected | `blocked` |
| `omp--approval-write.txt` | `write` approval under `--approval-mode always-ask`: `Path:` plus a multi-row `Content:`, Approve selected | `blocked` |
| `omp--approval-write--deny.txt` | The same screen with Deny selected. Three rows differ from the capture above: the two option rows, which swap the U+F054 marker, and the `Working…` spinner row, whose visible text is identical but whose SGR styling is not (the spinner was mid-animation) | `blocked` |

Keys live-probed on the real dialogs, not inferred. `y` is NOT a shortcut: the dialog was unchanged,
no character was typed anywhere, and the command did not run. `enter` selects the marked row — on the
bash dialog it approved and `gh issue create --help` then ran. `down` moves the U+F054 marker from
`Approve` to `Deny`, which is the entire difference between the two `write` captures. `esc` cancels —
probed on the `write` dialog, with the target file verified absent afterwards. One reproduction trap
worth recording: `read` is auto-approved even under `--approval-mode always-ask`, so a read call
paints no dialog and cannot be used to generate one.

Since [ADR 0078](../../../../.adr/0078-the-omp-tool-approval-is-lifted-and-deny-never-lands-on-approve.md)
all three lift as a card (`omp/approval.ts`): Approve, Deny and Cancel, the command or the path and
content in Approve's description. They are the evidence for the `nerd` preset: U+F054 as the pointer
over the text-keycap footer. The usage strip under the box stays out of the signature.

## OMP `/tree` capture (2026-09-13, oh-my-pi `omp` v18.1.19, throwaway Herdr pane)

One byte-faithful `pane.read format:ansi` capture, and the only thing it is evidence for is that omp
has `/tree` and what omp paints for it. The harness bar's omp rows each name a capture, so the Tree
button waited on this file rather than on the argument that omp is a pi fork
([`harness-bar.ts`](../../lib/harness-bar.ts)).

omp 18.1.19 was installed into a throwaway prefix and run in `/tmp/fable-omp-sandbox`, a `git init`
repo. Its five-step first-run setup was skipped with `Escape`, so the session has **no model at all**
— the screen carries omp's own `No models available` warning. `/tree` still works, which is itself the
finding: the command is local to the TUI and needs no provider.

The screen is a box at column 0 titled `Session Tree`, with a long hint row
(`Enter: switch. Alt+↑/↓: previous/next turn. PgUp/PgDn (←/→): page. …`), a `Search:` row, a rule, and
then the filtered list, which here reads `1 entries hidden by the current filter [default]` over
`Press Alt+A to show all, Alt+D for default` and `(0/1)`. `Alt+A` was probed: it reveals the one entry
as `› • [thinking: high]` and flips the footer to `[all]`. `Alt+D` put the default filter back, and the
capture is that default state — what `/tree` paints on its own, with nothing driven after it.

CRLF throughout with no trailing newline; `wc -l` is 35. **No sanitization pass was needed**, and that
is verified rather than assumed: the file contains no username, hostname, home path, email, session id,
credential-shaped string or UUID, and the modal covers the statusline that would otherwise carry the
cwd. The session had no provider signed in, so there is no vendor account state to rewrite either.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `omp--tree.txt` | The welcome panel and the `No models available` warning above a `╭─ Session Tree ─╮` box: hint row, `Search:` row, rule, then the default filter's `1 entries hidden` notice and `(0/1)` | `idle` |

`/tree` was dismissed with `Escape`; nothing in the tree was ever switched to.

## OMP empty-editor key hint (captured 2026-09-30, oh-my-pi `omp` v18.4.4, herdr 0.9.2, throwaway Herdr panes)

Four byte-faithful `pane.read format:ansi` captures, taken with `scripts/capture-fixture.sh`. The
first three come from fresh omp sessions in `/tmp`, one per composer shape. The rule and pi shapes ran under a
`--config` overlay that set only `composer.shape`. omp 18.4 paints a key hint into an EMPTY editor:
the Shift+Tab key glyphs in the accent colour, one space, then `to change thinking effort` in dim
italic, right-aligned in the draft row. The hint is not in the input buffer and goes away with the
first typed character. Read as text, the row was a draft of the two key glyphs, so every fresh
session showed "Draft in terminal". `draftPlaceholder` (`harness/omp/markers.ts`) now recognises
the hint by the renderer's shape.

omp's `composer-hints.ts` builds a second hint from the same parts, and it wins over the effort
hint: `← ← to see N running agents`, painted while a background subagent runs. Its key run is two
glyphs with a space between them, which the effort hint never tests. `omp--fresh-agents-hint.txt`
pins it in the boxed shape. It was captured 2026-10-02 on omp v18.4.10 and herdr 0.9.3, after one
`task` subagent was started in the background. omp retires a hint after its gesture is used three
times, and the capturing operator's own count had retired it, so this session ran on a copy of the
agent directory (`PI_CODING_AGENT_DIR`) with the hint counter cleared.

The operator's statusline template shows the model and the context meter, plus the subagent count
and git branch when there are any. The agents capture ran in a fresh `git init` sandbox, so its row
shows `1` and `main`. No cwd, host or account appears. **No sanitization pass was needed.** All four are CRLF with no trailing
newline; their `wc -l` counts are 2, 4, 4 and 2.

**The two boxed captures are deliberately outside the `extractStatusLines` content assertion.**
Every other boxed fixture is held to a status row that starts with `π`, ends with `▶` and names the
branch (`chrome.test.ts`). That is the default powerline template the rest of the corpus carries.
These two carry the operator's own template, which is neither, so they are held only to the shape
half of that test: exactly one styled row with more than one segment.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `omp--fresh-effort-hint.txt` | Boxed composer on a fresh session: the hint right-aligned in the `╰─ … ─╯` bottom border | `idle` |
| `omp--v18-rule-effort-hint.txt` | `rule` composer: the hint right-aligned on the empty `❯` row, then the blank gap and the status row | `idle` |
| `omp--v18-pi-effort-hint.txt` | `pi` composer: the hint right-aligned on the single draft row between the two rules, status row below | `idle` |
| `omp--fresh-agents-hint.txt` | Boxed composer with a background subagent running: `← ← to see 1 running agent` right-aligned in the bottom border | `idle` |

## OMP 18.4.10 modal corpus (captured 2026-10-02, oh-my-pi `omp` v18.4.10)

Nine captures from omp 18.4.10 (five more for the `ask` tool and five for the tool approval follow below), byte-faithful but for the sanitization pass below, taken to lift `/resume` and to give every other omp modal a declared way out ([ADR 0076](../../../../.adr/0076-the-omp-resume-picker-is-lifted-and-every-omp-modal-has-a-way-out.md)).
omp 18.4 draws its pickers as a rounded box that fills the pane (59 rows by 109 columns here) and prints **glyph keycaps** in the footer: `⏎` for Enter, `⌦/⌫` for delete, `⇥` for Tab, `⎋` for Escape. omp 17.x to 18.1 printed the same keys as words (`Enter`, `Del/⌫`, `Tab`, `Esc`), so the corpus now holds both dialects of the footer, and `omp/modal.ts` accepts exactly the six spellings of the way out (`⎋ cancel`, `⎋ close`, `⎋ to close`, `Esc cancel`, `Esc close`, `Esc to close`).

The `/resume` captures are the boxed layout of that picker: a titled top border (`╭─ Resume Session (current folder) ─…╮`), a `│ > <typed text> │` search row, sessions as blank-separated groups of three rows (title, first prompt, meta), and a bracketed footer, then the bottom border. The meta row reads `<age> ago · <size> · [current ·] ✔ done|⚠ interrupted · [⑂ fork] · [<cwd>]`, with a double space on each side of every `·`. Both sessions in these captures share one title, so the meta row is what tells them apart on the card. `omp--v18-4-resume-nomatch.txt` is the state with no row to point at: the grammar declines it, and the unread-dialog card with its Escape button stands over the raw mirror.

**One sanitization pass, LENGTH-PRESERVING, two substitutions, ASCII for ASCII and with every SGR
escape left untouched**, so each row keeps its byte length and its cell width:

- **The session id.** `omp--v18-4-composer-idle.txt` printed the forked session's UUID twice, in the
  `return to original: omp --resume <id>` notice and on the wrapped row under it. Both read
  `00000000-0000-7000-8000-000000000000`.
- **The cwd.** `~/projects/collie-workspace` became `~/projects/sample-workspace` on the composer
  powerline (`omp--v18-4-composer-idle.txt`), on the `/settings` preview row
  (`omp--v18-4-menu-settings.txt`) and on both meta rows of `omp--v18-4-resume-all-projects.txt`.

Kept verbatim, on purpose: the session title and first prompt (a sandbox request, quoted in the
transcript, the welcome panel's Recent sessions and the `/tree` list as well), the transcript itself,
the `GPT-6 Luna` model and the `openrouter` provider, which the older omp captures above already
print, and the `/model` catalogue. The whole-corpus check after the pass: a UUID pattern matches only
the zero id, and `/home/`, `/Users/`, an email, an `sk-`/`ghp_`/`AKIA`-shaped string, an OSC escape
and `collie-workspace` match nothing.

**Five more, the same day, for the `ask` tool** ([ADR 0077](../../../../.adr/0077-the-omp-ask-single-select-is-lifted-and-its-multi-select-is-not.md)),
from the lead's own pane at 108 columns by 210 and 284 rows. Each prompt asked omp to call `ask`
exactly once (`Pick a color` with Red, Green, Blue; then `Pick toppings` with Cheese, Olives, Basil and
`multi=true`). The moved, note and checked states are one `Down`, one `n` and one `Space` from the
dialog as it opened. The dialog replaces the composer, so no statusline and no cwd is on screen; above the
box is the session's own transcript (the same `Render Fancy Content in Terminal` session as the
captures above, its welcome splash, its earlier answered and cancelled `ask` calls) and a working row
(`⎋ Choosing a color`). **No sanitization pass was needed**, and that is checked rather than
assumed: a UUID pattern, `/home/`, `/Users/`, `/tmp`, an email, an `sk-`/`ghp_`/`AKIA`-shaped string,
an OSC escape, a host name and `collie-workspace` match nothing in the five files. All five are CRLF
with no trailing newline; `wc -l` is 209 for the three single-question color captures and 283 for the
two toppings captures.

The two footers are the version drift the grammar is built around. The single-select footer is the
17.2.12 one in glyph keycaps, `⏎ select · n note · ↑/↓ move · ⎋ cancel`. The multi-select footer
CHANGED MEANING: 17.2.12 printed `Space/Enter toggle`, 18.4.10 prints `␣ toggle · ⏎ submit`, and
omp 18.4.10's source confirms that Enter on an option there submits the checked set at once.

`omp--v18-4-tree.txt` is the one capture here without a way out: neither it nor `omp--tree.txt` prints an Esc segment (the hint row is clipped), so `ompModalOnScreen` answers false on it and it keeps no card.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `omp--v18-4-composer-idle.txt` | 177 rows: a long transcript, `Resumed session`, and `✔ Session forked · return to original: omp --resume <id> or /resume`, then an EMPTY boxed composer whose top border carries the 18.4 powerline with a context meter (`▶─2%───┃─1.1M─`). A composer, `composerReady` true, no card | `idle` |
| `omp--v18-4-menu-model.txt` | `/model`: the two-pane `╭─ Models ─┬─╮` picker, footer `⏎/→ models · ↑/↓ providers · type to search · Alt+←/Alt+→ kind · ⎋ close`. Stays raw; gets the card | not recorded |
| `omp--v18-4-menu-settings.txt` | `/settings`: the tabbed panel, footer `⏎/␣ to change · ⇥ to jump sections · ←/→ to switch tabs · Type to search · ⎋ to close`. Stays raw; gets the card | not recorded |
| `omp--v18-4-tree.txt` | `/tree`: 182 rows, the welcome panel and a long transcript above a `╭─ Session Tree ─╮` box whose hint row is clipped (`⇧⏎: summa…`). No footer names a way out, so no card | not recorded |
| `omp--v18-4-resume.txt` | `/resume` in the current folder, two sessions that share the title `Render Fancy Content in Terminal`, the pointer on the first. Lifts as a `prompt-select`: Enter, Down+Enter, then Cancel | not recorded |
| `omp--v18-4-resume-moved.txt` | The same screen with the pointer on the second session: Up+Enter, Enter, Cancel | not recorded |
| `omp--v18-4-resume-untitled-dated.txt` | Four sessions: an untitled one that prints two rows (first prompt, meta; `just now`), two titled ones, and one nine days old whose age reads `9/20/2026`; the pointer on the third. The two extra session logs were hand-made copies of a real one (new id, `touch -d`, title rows removed) so omp rendered the shapes itself, and deleted after the capture | not recorded |
| `omp--v18-4-resume-search.txt` | `ab` typed in the search row: both sessions still match, in the other order, the pointer on the first | not recorded |
| `omp--v18-4-resume-all-projects.txt` | After `⇥`: the title reads `(all projects)`, every meta row ends in the session's cwd, and the footer offers `⇥ current folder` | not recorded |
| `omp--v18-4-resume-nomatch.txt` | `abzzzzqq` typed: `No sessions in current folder. Press ⇥ to view all.` and no session row. The grammar declines, the card stands | not recorded |
| `omp--v18-4-ask-single.txt` | The `ask` tool's one-question single-select dialog: `╭─ Ask ─╮`, `Pick a color`, `❯ ○ Red`, `○ Green`, `○ Blue`, `○ Other (type your own)`, two blank body rows, footer `⏎ select · n note · ↑/↓ move · ⎋ cancel`. Lifts as a `prompt-select` (`omp/ask.ts`): Enter, then one more `Down` per row, then Cancel | not recorded |
| `omp--v18-4-ask-single-moved.txt` | The same dialog after one `Down`: the pointer on Green. Red walks `Up` | not recorded |
| `omp--v18-4-ask-note-editor.txt` | `n` on Green: the prompt-style answer editor titled `Note for Green: Pick a color`, an empty `│ > ` row, hint `⏎ or Ctrl+Q submit  ⎋ cancel  Ctrl+G external editor`. An input: `composerReady` true, no card | not recorded |
| `omp--v18-4-ask-multi.txt` | The multi-select dialog: the tab strip `toppings    Submit`, `Pick toppings`, `❯ ☐ Cheese`, `☐ Olives`, `☐ Basil`, `☐ Other (type your own)`, footer `␣ toggle · ⏎ submit · ↑/↓ move · ⇥/←/→ · ⎋ cancel`. Stays raw, gets the card | not recorded |
| `omp--v18-4-ask-multi-checked.txt` | The same dialog after one `Space`: `❯ ☑ Cheese`. Stays raw, gets the card | not recorded |

**Five more, the same day, for the tool-approval dialog** ([ADR 0078](../../../../.adr/0078-the-omp-tool-approval-is-lifted-and-deny-never-lands-on-approve.md)),
from the same session at 108 columns, 300 rows each. Each prompt asked omp for one harmless call,
`echo hello-approval` or a file under `/tmp/omp-sandbox-approval`, with approval required for every
call and no config pattern behind it, so the box carries no `Reason:` row. The moved states are one `Down` from the dialog as it opened.
These are the evidence for the `unicode` preset: the pointer is `❯` and the footer prints glyph
keycaps, `↑/↓ navigate  ⏎ select  ⎋ cancel`, segments split by two spaces. No usage strip sits under
the box. The pointed row's band is `rgb(0,130,179)` here and `rgb(60,56,54)` in the 18.1.17 captures,
which is why only the glyph is read (`omp/APPROVAL_NOTES.md`). **No sanitization pass was needed**,
and that is checked rather than assumed: the operator's user name and host names, `collie-workspace`,
`/home/`, `/Users/`, `/var/home`, a UUID pattern, an email, an `sk-`/`ghp_`/`AKIA`-shaped string, a
long hex or base64 token and an OSC escape match nothing in the five files. The only paths are the
sandbox's. All five are CRLF with no trailing newline; `wc -l` is 299.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `omp--v18-4-approval-bash.txt` | `╭─ Allow tool: bash ─╮`, `Command: echo hello-approval`, `❯ Approve`, `Deny`. Lifts as a card: Approve sends `Enter`, Deny `Down` `Enter`, Cancel `Escape` | not recorded |
| `omp--v18-4-approval-bash-moved.txt` | The same dialog after one `Down`: `❯ Deny`. Approve sends `Up` `Enter`, Deny still `Down` `Enter` | not recorded |
| `omp--v18-4-approval-write.txt` | `Allow tool: write`, `Path: /tmp/omp-sandbox-approval/note.txt`, `Content:`, `hello approval`, the pointer on Approve. Above it, the transcript records the denied shell command, then the call's own streaming preview | not recorded |
| `omp--v18-4-approval-write-moved.txt` | The same dialog after one `Down`: `❯ Deny` | not recorded |
| `omp--v18-4-approval-write-long.txt` | A `write` of fourteen rows, `sample line N for the approval dialog`: the box grows to hold them all. The card shows all fourteen, and so does the raw mirror above it | not recorded |

## OMP `ask` answer editor (captured 2026-10-01, oh-my-pi `omp` v18.4.4, herdr 0.9.3, throwaway Herdr pane)

Seven byte-faithful `pane.read format:ansi` captures, read through the local bridge from one throwaway
Herdr workspace in `/tmp/ompask`. The prompt asked omp to call its `ask` tool with one question and
three options, and the dialog was then driven with `Up`/`Down`, `Enter`, `n` and typed text.

They exist for one screen: the free-text box the `ask` tool opens for `Other (type your own)` and
for `n note`. omp's prompt-style `HookEditorComponent` (pi-tui `overlays/hook-editor.ts`) REPLACES the
composer while it is open (`extension-ui-controller.ts` clears the editor container and mounts only
this), so before `omp/answer-editor.ts` the reply pre-flight saw no composer and refused every reply
typed into it.

The box is titled `Custom answer: <question>` or `Note for <option>: <question>`, the first answer row
carries the editor's `> ` gutter, continuation rows are indented by the gutter's width, and the hint
row reads `<enter> or <ctrl+q> submit  <esc> cancel  <ctrl+g> external editor`. The hint is the one row
that tells the two editor modes apart: hook-style joins its submit keys with `/` and inserts a newline
on plain Enter.

Keys live-probed on the real editor, not inferred. Plain `Enter` submits. **A raw newline submits
too**: `pane.send_text` of `line one\nline two` answered the question with `line one` and typed
`line two` into the composer behind it (HERDR_API.md: `send_text` writes raw bytes). `Escape` returns
to the Ask dialog with nothing recorded.

CRLF throughout with no trailing newline; `wc -l` is 38 for `empty`, `typed` and `note`, 39 for
`wrapped`, 61 for `long`, and 43 for both dialog captures. **No sanitization pass was needed**, and that is verified rather
than assumed: no username, hostname, home or `/tmp` path, email, session id or UUID appears, and the
box covers the statusline. Every row above the box is the sandbox session's own transcript and omp's
`Update Available` notice.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `omp--select-menu-other.txt` | omp 18's single-choice Ask dialog with the pointer on `Other (type your own)`; footer `<enter> select · n note · ↑/↓ move · <esc> cancel`, in the Nerd Font preset (U+F0311, U+F12B7; pointer U+F054, radio U+F10C). A modal: `composerReady` false. Lifted since ADR 0077, the Nerd Font preset read from this capture | `working` |
| `omp--select-menu-noted.txt` | Back on the Ask dialog after a note was submitted with `Enter`: `Blue  ✎ note`. A modal: `composerReady` false. Lifted since ADR 0077, `✎ note` becoming Blue's description | `working` |
| `omp--answer-editor-empty.txt` | `Enter` on `Other`: `╭─ Custom answer: Pick a colour ─╮`, an empty `│ > ` row, the prompt-style hint | `working` |
| `omp--answer-editor-typed.txt` | The same editor holding `a deep teal, like the sea at dusk` | `working` |
| `omp--answer-editor-wrapped.txt` | A longer answer soft-wrapped onto a second row | `working` |
| `omp--answer-editor-long.txt` | A 700-word answer: the box grows with it, to 37 answer rows | `working` |
| `omp--answer-editor-note.txt` | `n` on `Blue`: the same editor titled `Note for Blue: Pick a colour`, holding `only if it is a warm blue` | `working` |

The answers were typed with `herdr pane send-text` into the sandbox session only, and the workspace was
closed afterwards.

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

## Muse corpus (captured 2026-09-18, Muse Code 1.3.0, sandbox pane)

Byte-faithful `format:ansi` captures from a throwaway Herdr pane in
`/tmp/collie-muse-sandbox`, taken through the tailnet front door (the sanctioned
`scripts/capture-fixture.sh` speaks loopback, which this host's bridge 403s —
same endpoint, same `jq -j '.text'` treatment). The session ran
`muse --approval-mode untrusted --approval-judge off` so every eligible approval
stopped on screen instead of auto-resolving (the paste-token capture ran in a second scratch pane
under default approvals — composer behavior only, no tool calls). All 18 files are CRLF throughout
with no trailing newline.

**One sanitization pass, LENGTH-PRESERVING.** The shell prompt names the
operator's cloud account, so all 34 occurrences of the real 24-character address
became `operator@example.test000` (24 chars either way, SGR untouched). Nothing
else needed it: no username, hostname, home path, session id, credential-shaped
string or UUID appears, and the cwd is the generic sandbox dir. Verified with
an email/path/UUID/secret-shape sweep, which returns only the fabricated token.

**The nine files added 2026-09-23 are hand-built, not captures** (#274 to #280):
`muse--draft-blank-row`, `muse--tip-loop`, `muse--palette-exact`, `muse--palette-partial`,
`muse--draft-image-chip`, `muse--draft-quoted-path`, `muse--tip-paste`,
`muse--approval-network` and `muse--approval-network-moved`. Each starts from one of the 18
captures above and swaps the box or dialog rows for the text the contributor saw live on Muse
1.3.0 under Collie 1.12.1. The transcript, the rules and the statusline are the capture's bytes;
the swapped rows reuse the styling of the rows they replace, so their colours are not evidence.

**The headline: Muse's questions are digit-MOVES, not digit-answers, and its
checkbox/review phases need pointer choreography.** A digit jumps the `›`
pointer; `Enter` selects (single), toggles (checkbox), or submits (review).
The approval and trust prompts are the opposite — digit alone. Every recipe
below was probed live, keystroke by keystroke; the full probe log is
[`DIALOG_NOTES.md`](../../lib/harness/muse/DIALOG_NOTES.md).

Three more things the captures pin. Muse pads every PTY row to full width and
opens content rows with a 2-column grey gutter, so detectors match rstripped
text and never colour (the palette answers OSC 10/11 — light, dark and none
responders paint different SGR). The composer tail — `── Voice input … ──`
rule, `❯` row, full-width `─` rule, `muse-spark-1.3 · …` statusline — stays on
screen UNDER question dialogs (only approval replaces the box, and trust is
pre-session), so `composerReady` is "box present AND no dialog claims the
screen". And the `Request user input` header carries a live `(Ns)` timer plus
spinner frames (`◇/◆/◈`), which anchors detection but must never enter a
signature.

| Fixture | State / what's in it | Herdr status |
|---|---|---|
| `muse--trust-prompt.txt` | Pre-session workspace trust: `Do you trust this workspace?`, `> 1  Trust and continue` / `  2  Quit` (two spaces, NO period — unlike every other Muse dialog), `Use Up/Down or 1/2, then Enter. Esc quits.` footer. Digit `1` live-probed: submits immediately | `blocked` |
| `muse--fresh-idle.txt` | Post-trust idle: banner, Voice rule, bare `❯`, bottom rule, `muse-spark-1.3 · max · <cwd> · Launch overrides` statusline | `idle` |
| `muse--palette-exact.txt` | Slash palette open under an exact command: `❯ /usage` + one suggestion row naming `/usage`. The read is the command alone, so verify passes and Enter submits it (#276) | `idle` |
| `muse--palette-partial.txt` | Slash palette open under partial input: `❯ /us` + the `/usage` suggestion. The read stays polluted on purpose — Enter would accept the suggestion, so verifying the typed text would bless another command (#276) | `idle` |
| `muse--draft-single.txt` | Stranded one-line draft on the `❯` row | `idle` |
| `muse--draft-wrapped.txt` | Long draft soft-wrapped onto a 2-space-indented continuation row (breaks at the hyphen in `soft-wrap`) | `idle` |
| `muse--draft-paste-token.txt` | A 3003-char single line collapsed to `[Pasted Content 3003 chars]` — per-LINE collapse (a 3300-char burst of short lines stayed literal), N in code points, threshold in (1000, 1200] | `idle` |
| `muse--draft-blank-row.txt` | Two-paragraph draft: a blank row between the `❯` head and the continuation. The tail walk steps over it, so the prompt binds, the draft folds, and no card draws (#274) | `idle` |
| `muse--draft-image-chip.txt` | An attached image path converted in place to `[Image #1]` (N in attach order). The read stays verbatim; the attach grammar maps it back for verify (#278) | `idle` |
| `muse--draft-quoted-path.txt` | A non-image path double-quoted in place (`"/tmp/…"`). Same split: verbatim read, attach grammar verifies (#278) | `idle` |
| `muse--working.txt` | Mid-turn: `◇ Double checking (2m 40s · esc to interrupt)` above the live composer | `working` |
| `muse--done.txt` | Completed turn: `◆ Ran command …`, `◆` summary, `◆ Worked for 1m 06s`, idle composer holding the `Start a message with ! to run a shell command yourself` placeholder (grey, not a draft) | `idle` |
| `muse--tip-loop.txt` | The same idle composer holding the rotated `/loop 10m <prompt> schedules a recurring prompt` placeholder tip — the tip rotates, and an unlisted one reads as a ghost draft (#274) | `idle` |
| `muse--tip-paste.txt` | The same idle composer holding the `Paste an image with Ctrl+V — file paths and URLs work too` placeholder tip — the tip rotates per context (#278) | `idle` |
| `muse--quoted-dialogs-bare.txt` | Model-printed facsimiles (approval + single-select + review) as the last reply above a bare box — the model paraphrased the review pointer (`│`), so no detector matches; nothing lifts and the reply stays allowed (#260) | `idle` |
| `muse--approval-ls.txt` | `Would you like to run the following command?`, `$` + `Stage 1/1` + `Current argv:` subject, `› 1. Allow this stage once (y)` / `2. Always allow … (p)` / `3. Abort … (esc)`. No footer row. Digit `1` live-probed: approves alone | `blocked` |
| `muse--approval-ls-moved.txt` | Same dialog after one `Down` (`›` on option 2) | `blocked` |
| `muse--approval-network.txt` | `Would you like to allow this network access?`, `network: host:port scheme` + `full URL:` subject, four options with `(y)`/`(p)`/`(esc)` hints and a `host:port (scheme)` scope on 2–3. Digit `1` live-probed: approves once, fetch runs (#280) | `blocked` |
| `muse--approval-network-moved.txt` | Same dialog with `›` on option 2, as seen live | `blocked` |
| `muse--ask-color.txt` | Single-select: `Request user input` header, question, `› 1. Red (Recommended)` / `2.` / `3.` / auto-added `4. None of the above`, `Enter to select · ↑/↓ to move · Tab for an optional note · Esc to interrupt` footer | `blocked` |
| `muse--ask-color-moved.txt` | Same dialog after one `Down` (`›` on option 2) | `blocked` |
| `muse--ask-color-notes-open.txt` | After `Tab`: inline `Note (optional): ▌` row under the pointed option, footer unchanged. The lift must decline: the note owns the keyboard | `blocked` |
| `muse--ask-color-notes-typed.txt` | After typing `x` into it (`Note (optional): x▌`) — the proof a digit would land there too | `blocked` |
| `muse--ask-toppings.txt` | Multi-select: `› 1. [ ] Cheese (Recommended)` … `4. [ ] None of the above` … `5. Submit answer (0 checked)`, footer wrapping mid-phrase (`Esc to` / `interrupt`) | `blocked` |
| `muse--ask-toppings-checked.txt` | After `Enter` on row 2: `[x] Pepperoni`, `Submit answer (1 checked)` | `blocked` |
| `muse--ask-toppings-notes-open.txt` | The same `Note (optional)` row on a checkbox dialog — declines the lift the same way | `blocked` |
| `muse--ask-toppings-review.txt` | Review phase: `Review answers before submit · Enter to edit or submit · …` lead, `Toppings: Pepperoni` summary, unnumbered `> Submit answers` / `Interrupt turn` rows. Digit `1` live-probed: swallowed; `Enter` on Submit submits | `blocked` |
| `muse--ask-drinks.txt` | The 2-option geometry (options + None + Submit are rows 1–4): nothing may key on a fixed option count or Submit digit. `None of the above` live-probed as a plain checkbox (`[x]`, counted) | `blocked` |
| `muse--tasks-popup.txt` | Background-tasks popup between the bottom rule and the statusline: `main · ↓ to select` header + one `└ ◆ … running … 24s` task row, bare `❯` above. The box stays live under it (probed: typing lands in the box), so the tail walk steps over the popup and no card draws. Captured 2026-09-26 on Muse Code 1.4.0; the same shape confirmed on 1.3.0-R3401.1 | `idle` |
| `muse--tasks-popup-draft.txt` | Same popup with `qq` in the box: the header drops its hint (bare `main`). The draft reads verbatim above the popup | `idle` |
| `muse--tasks-popup-approval.txt` | An `ls -la /tmp` approval with the popup under it: the approval still lifts (digit-alone keys), and the ticking elapsed stays out of the signature | `blocked` |

**Nothing was approved blindly.** The one approved command was `ls -la` on the
empty sandbox (output verified); the trust prompt covered a throwaway `/tmp`
dir; every question was answered with the sandbox's own test data. The dialogs
left open at the end were dismissed with `Escape`. A second session
(2026-09-26, tasks popup, same throwaway sandbox) approved `sleep 120/100/110/150`
(backgrounded, no output) and `ls -la /tmp` (listing verified).


## opencode corpus (captured 2026-09-26, opencode 1.18.32, herdr 0.9.0, private Herdr session)

Captures of **opencode 1.18.32** in a private Herdr session with a colour-answering client (the
canary's client, so the panes paint as a person's terminal would), read through the bridge's own
`readPane`. Scratch config only: `OPENCODE_CONFIG` pointed at a file in `/tmp` whose `permission`
block asks for `bash`, `edit` and `webfetch`, and the project was a fresh `git init` in `/tmp`. Two
widths: the Herdr pane's own 120 columns and 50 columns (`stty cols 50`, the canary's narrow
width). Byte-faithful `format:ansi`, no substitutions: every file was checked for user and host
names, home paths and keys, and holds only probe strings and `/tmp` paths. These replace the
contributor's captures of 2026-09-20, whose version string matched no opencode release.

The composer is a LEFT VERTICAL BAR run (`┃`, U+2503) with a `╹▀▀▀` rule under it and the status
rows below the rule. The transcript draws the same bar: each user message and each tool run is a
`┃` block of its own above the composer. Permission dialogs paint inside the composer's run. See
`web/src/lib/harness/opencode/PERMISSION_NOTES.md` for the probed recipe (Right and Left move and
wrap, Tab does nothing, Enter confirms, Escape declines, no digit).

| Fixture | State / what's in it | Herdr status |
| --- | --- | --- |
| `oc--fresh-idle.txt` | Splash logo, empty composer with an `Ask anything… "…"` placeholder, model row, rule, `tab agents  ctrl+p commands`, the cwd/version row at the foot | `idle` |
| `oc--draft-single.txt` | One draft row on a two-space-gutter interior row | `idle` |
| `oc--draft-wrapped.txt` | A long draft word-wrapped onto three interior rows | `idle` |
| `oc--draft-tree-glyphs.txt` | A four-line draft holding a pasted `tree`: a line, `├── src`, `└── web`, a last line. Captured at 226 columns on opencode 1.18.32, 2026-09-30, for the panel-border rule: a junction alone must not end the draft run, or three of these four lines are lost | `done` |
| `oc--draft-multiline.txt` | A six-line draft typed with hard breaks: a line, a blank line (a bare bar row inside the composer), an indented line, `❯ ls -la`, a `────` rule, a last line. The draft reads whole across the blank line | `done` |
| `oc--draft-while-working.txt` | A draft typed while `sleep 10 && echo done` ran: the running command and its spinner sit in the transcript above, the status row reads `esc interrupt` | `working` |
| `oc--working.txt` | The same run with an empty composer | `working` |
| `oc--done--tool-run.txt` | After the run finished: the command's output in the transcript, the empty composer, the cwd/tokens/cost status row | `done` |
| `oc--composer-plan.txt` | The agent switched with `tab`: the model row reads `Plan · …` | `idle` |
| `oc--slash-palette.txt` | `/` typed: the command list painted inside the box, above the input row. The composer still holds the keyboard | `idle` |
| `oc--command-palette.txt` | The ctrl+p palette, `Commands … esc` over `Search`, over the middle of the screen; on 1.18.32 it also cuts through the rule | `idle` |
| `oc--agents-picker.txt` | The `/agents` picker, `Select agent … esc` over `Search`, floating over the splash while the composer's tail stays intact underneath. The picker-shape check refuses it | `idle` |
| `oc--command-palette-query.txt` | The ctrl+p palette with the filter `mod` typed, which stands where `Search` was. A known gap, pinned as `it.fails`: `composerReady` answers true here | `done` |
| `oc--permission-bash.txt` | The bash permission dialog: `△ Permission required`, the heading `# Shell command`, the command `$ echo fixture-corpus-probe`, chips `Allow once` / `Allow always` / `Reject` with the pointer on `Allow once` | `blocked` |
| `oc--permission-bash--moved.txt` | After one `Right`: pointer on `Allow always`. The body does not change | `blocked` |
| `oc--permission-bash--reject.txt` | After a second `Right`: pointer on `Reject` | `blocked` |
| `oc--permission-bash--wrap.txt` | After a third `Right`: the pointer wrapped back to `Allow once` | `blocked` |
| `oc--permission-edit.txt` | The edit permission dialog: the heading `→ Edit probe.txt`, then the diff row `1 + hello` | `blocked` |
| `oc--permission-edit--moved.txt` | The same dialog, pointer on `Allow always` | `blocked` |
| `oc--permission-webfetch.txt` | The webfetch permission dialog: the heading `% WebFetch https://example.com`, then `URL: https://example.com` | `blocked` |
| `oc--permission-always-bash.txt` | `Allow always` + Enter opened the second step, `△ Always allow`, its body naming the pattern (`- echo *`), chips `Confirm` / `Cancel`, pointer on `Confirm` | `blocked` |
| `oc--permission-always-bash--cancel.txt` | The same step after one `Right`: pointer on `Cancel`, on two chips where no plurality of backgrounds exists | `blocked` |
| `oc--permission-always-edit.txt` | The second step for an edit: `This will allow edit until OpenCode is restarted.`, no pattern list | `blocked` |
| `oc--narrow--fresh-idle.txt` | 50 columns: the placeholder wraps over two rows, the model row squeezes its dots (`Build ·GPT-6 Astra Pro OpenRouter· medium`), a bare bar row sits between it and the rule, and a tip wraps over two rows under the key hints. `composerReady` must be TRUE | `idle` |
| `oc--narrow--draft-wrapped.txt` | 50 columns: a draft wrapped over three rows, the same bare bar row under the model row | `idle` |
| `oc--narrow--done.txt` | 50 columns, after a rejected command: the cwd/tokens/cost status row folds onto two rows | `done` |
| `oc--narrow--permission-bash.txt` | 50 columns: the chips on a bar row of their own, a bare bar row, then the hints on a row of their own | `blocked` |
| `oc--narrow--permission-always-bash.txt` | 50 columns, the second step: the body wraps over two rows, chips and hints on rows of their own | `blocked` |

## opencode question corpus (captured 2026-10-01, opencode 1.18.33, herdr 0.9.3, private Herdr session)

Captures of the `question` tool's dialog on **opencode 1.18.33**, in a private Herdr session run
headless (no client attached, so the pane is Herdr's own 120 by 40), with the user's normal opencode
config and a free model. The narrow files come from the same session with a client attached through
a private tmux, sized so the pane reads 50 by 40. Read with `herdr pane read --ansi --source recent
--lines 300`, which is the call the bridge's `readPane` makes (checked byte-equal against `/api/pane`
on a live pane), because the dev bridge does not watch a private session. Byte-faithful, no
substitutions: every file was checked for user and host names, home paths and keys, and holds only
probe strings, the model name and `/tmp/oc-question-lab`. The recipe, the focus marker and the
journal shapes are in `web/src/lib/harness/opencode/QUESTION_NOTES.md`. The status column was read
with `herdr pane get` once on the single-select dialog (`blocked`) and once after `Escape` (`idle`);
the other `blocked` cells repeat that by shape and were not read one by one.

The dialog paints in its own bar run (`┃`, purple here, `157;124;216`) at the buffer's tail, in
place of the composer: no model row, no rule, no status row. The pointer is a background chip on
the option's `N. label` run, one step lighter than the dialog (`30;30;30` on `20;20;20`).

| Fixture | State / what's in it | Herdr status |
| --- | --- | --- |
| `oc--question--single.txt` | One single-select question, three options with descriptions plus `4. Type your own answer`, pointer on `1. Red`, footer `↑↓ select  enter submit  esc dismiss`. No tab bar and no header row | `blocked` |
| `oc--question--single--moved.txt` | After one `Down`: the chip is on `2. Green`, nothing else changed | `blocked` |
| `oc--question--single--narrow.txt` | 50 columns: the same dialog, the same rows and footer, only the user message above it wraps | `blocked` |
| `oc--question--free-text.txt` | Digit `4` on the free-text row: it opened an input row under it that shows the placeholder `Type your own answer` in the description grey, one row taller | `blocked` |
| `oc--question--free-text--typed.txt` | The same input with `hello` typed: the text sits on the input row in the bright foreground | `blocked` |
| `oc--question--multi.txt` | One multi-select question, four options: a tab bar (` Colour ` chip, `Confirm`), `(select all that apply)` after the question, `[ ]` boxes, footer `⇆ tab  ↑↓ select  enter toggle  esc dismiss` | `blocked` |
| `oc--question--multi--toggled.txt` | After `Enter` on `1. [ ] Red`: the row reads `1. [✓] Red`, the pointer stays on it | `blocked` |
| `oc--question--multi--confirm.txt` | After `Tab`: the `Confirm` chip is active, the body is `Review` and `Colour: Red`, footer `⇆ tab  enter submit  esc dismiss` | `blocked` |
| `oc--question--multi--narrow.txt` | 50 columns, a long question: the question wraps over four rows, the footer's two-space gaps shrink to one space, and two bare bar rows close the dialog | `blocked` |
| `oc--question--two--q1.txt` | Two questions in one call: tab bar ` Colour ` chip, `Size`, `Confirm`; footer `⇆ tab  ↑↓ select  enter confirm  esc dismiss` | `blocked` |
| `oc--question--two--q1-answered.txt` | Back on the first tab after answering it: the answered option reads `1. Red ✓` (green), the pointer chip stays where it was, the tab `Size` is bright | `blocked` |
| `oc--question--two--q2.txt` | After `Enter` on the first tab: the `Size` chip is active, `Which size?`, the first tab `Colour` is bright | `blocked` |
| `oc--question--two--review.txt` | After `Enter` on the last question: the `Confirm` chip, `Review`, `Colour: Red`, `Size: Small` | `blocked` |
| `oc--question--tall8.txt` | Eight options with descriptions: the question row sits 20 rows above the footer, past the permission lift's 16-row bound | `blocked` |
| `oc--question--tall9.txt` | Nine options: the pointer started on `2. Two`, not on `1`. Reproduced three times, see the notes | `blocked` |
| `oc--question--tall14.txt` | Fourteen options: the dialog fills the pane (rows 1 to 38), the pointer started on `7. Seven`, the user message above is cut to its first row | `blocked` |
| `oc--question--answered.txt` | After `Enter` on `1. Red` and the model's reply: the dialog is gone, a `# Questions` block shows `Which colour?` and `Red`, then `You chose Red (warm).` and the empty composer | not read |
| `oc--question--dismissed.txt` | After `Escape`: the dialog is gone, the transcript keeps `→ Asked 1 question`, nothing answers it, the turn has ended | `idle` |
| `oc--question--three--q2-multi.txt` | Round two, **opencode 1.18.34**. Three questions, `Colour` answered, now on `Toppings` (multi, untouched): tab bar `Colour   Toppings   Size   Confirm` with `Toppings` active and `Colour` bright, `(select all that apply)`, four `[ ]` rows plus the free-text row, footer `⇆ tab  ↑↓ select  enter toggle  esc dismiss` while the other two question tabs say `enter confirm` | `idle` (read on this shape, not `blocked`) |
| `oc--question--three--q2-multi--toggled.txt` | The same tab after digit `2`: `2. [✓] Olives`, the chip on it, still on `Toppings`. A digit toggles and never advances here | `idle` |
| `oc--question--three--review.txt` | The `Confirm` tab with all three answered: `Review`, `Colour: Red`, `Toppings: Ham`, `Size: Large`, footer `⇆ tab  enter submit  esc dismiss` | `idle` |
| `oc--question--three--review--incomplete.txt` | The `Confirm` tab with `Size` not answered: `Size: (not answered)` in red (`224;108;117`), `Colour: Green`, `Toppings: Olives`. `Enter` still submits, journal `[["Green"],["Olives"],[]]`. Only answered tabs are bright, `Size` is grey although it was visited | `idle` |
| `oc--question--multi--free-text.txt` | Round two, 1.18.34. A lone multi call, digit `5` on the free-text row: the input row under `5. [ ] Type your own answer` shows the placeholder `Type your own answer`, no toggle yet | not read |
| `oc--question--multi--free-text--committed.txt` | After `mine` and `Enter`: `5. [✓] Type your own answer`, the input closed, `mine` under the row in grey (`128`) | not read |
| `oc--question--multi--confirm--empty.txt` | The `Confirm` tab of a lone multi call with nothing toggled: `Review`, `Colour: (not answered)` in red, footer `⇆ tab  enter submit  esc dismiss` | not read |

The last seven rows were captured on opencode 1.18.34, the rest of this corpus on 1.18.33. Herdr read
`idle`, not `blocked`, under the question dialogs probed in round two (see "Round two" in
`QUESTION_NOTES.md`). Each of the seven was checked for user and host names, home paths, tokens and
session ids and holds only probe strings and the model name.
