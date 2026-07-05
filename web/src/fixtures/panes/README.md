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
| `claude--select-multi.txt` | **Multi-question** AskUserQuestion: a stepper header `←  ☒ Focus area  ☐ Scope  ☐ Workflow  ✔ Submit  →` above the current question, "Tab/Arrow keys to navigate" footer. Detection deliberately BAILS on this (a wizard can't be answered by one digit+Enter) → falls back to raw | `blocked` |
| `claude--permission-edit.txt` | Edit permission: diff preview, "Do you want to create hello.txt?", `❯ 1. Yes / 2. Yes, allow all edits… (shift+tab) / 3. No`, "Esc to cancel · Tab to amend" | `blocked` |
| `claude--permission-bash.txt` | Bash permission: command + explanation, "This command requires approval", "Do you want to proceed?", scoped don't-ask-again option, "… · ctrl+e to explain" | `blocked` |
| `claude--plan-approval.txt` | ExitPlanMode: plan text, "…ready to execute. Would you like to proceed?", 4 options with hint sub-lines, "ctrl+g to edit in nano · <plan path>" footer | `blocked` |

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
