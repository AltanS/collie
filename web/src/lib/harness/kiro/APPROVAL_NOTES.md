# Kiro CLI V3 approval and composer captures

## Provenance

These notes cover the captures of the shell, read and write approval panels and of the composer. Where and how they were made, and what was substituted for publication, is in the Kiro section of the fixture corpus [README](../../../fixtures/panes/README.md). The startup workspace trust card ("Trust, continue" and "Don't trust") has its own [notes](./WORKSPACE_TRUST_NOTES.md); it is separate from a tool panel's persistent trust page.

## Verified menu keys

- Up/Down move by one row and stop at the menu ends. Enter selects the highlighted row. Typing `3` on the shell Allow state did not move or confirm it; the adapter emits no numeric shortcut.
- Highlighting `Always allow` on a shell, write or replace panel changes the footer to `esc to close · Enter to see more options`. It opens a separate trust page, so that row is not exposed as a web approval button.
- Tab opens `Modify request`. Escape returns from that editor to the pending dropdown.
- Escape from the main approval cancels the current request and turn. The unread-dialog fallback keeps Collie's existing two-tap Escape confirmation.
- A normal single-line composer draft is submitted with Enter. Word-wrapped single-line drafts were captured at 60 columns. Paste-chip, multiline, queue and steer behavior are not enabled by these probes.

## Live approval probes

| Operation | Allow once | Deny or Close |
| --- | --- | --- |
| Shell `printf` | Printed the exact requested synthetic marker | Deny rejected the command without output; Escape cancelled the turn |
| `read_file` | Returned the marker in the disposable file | Deny returned no file contents |
| `fs_write` | Created the disposable file with its requested marker | Deny left the target absent |
| `str_replace` | Replaced the requested marker | A later denied replacement preserved the existing content |
| Local stdio MCP echo | Returned the supplied marker once, with one invocation log entry | Deny added no invocation log entry |

Shell has `Allow`, `Always allow`, `Deny`, `Always deny`. Under `--trust-tools=''` the filesystem menu has `Allow`, `Deny`, `Always deny`; with the default agent configuration, write and replace panels also offer `Always allow`. A read panel has been captured only without it. Only Allow once, Deny and the printed Close key become native actions. Persistent rows remain part of request identity but are not buttons.

A diff row is a right-aligned line number in six columns, the `+` or `-` marker, two spaces, then the code with its own indentation. An added or removed blank line is the number and marker alone. A replace shows an unchanged neighbouring line as its bare line number.

Wide and narrow captures include selected-row pairs, wrapped file paths, complete 15-line diffs, a replacement editor and a 50-line proposal whose preview extends above the viewport. Two real replacements of the same file have identical permission panels but different diffs. Their preview contents therefore participate in request identity.

## Composer frame

Collie types into the composer only when the whole status bar frame is on screen: the divider, the status rows with the context gauge on the first, a blank row and the `›` prompt. The gauge is what tells the composer from an echoed `›` line or a panel's editor. The cwd is not checked, because its layout changes with the bar's width: it is right-aligned on the bar's row when both fit, on its own row below the bar when they do not, or starts on the bar's row and wraps mid-path onto the next one. The third appeared live when the expiry field grew by one character (`12h 47m`) and pushed `/tmp/kiro-fixture/demo` past 120 columns.

The footer is `/sessions to resume · /copy to clipboard` on V3 and `/copy to clipboard` alone on the V2 engine (`kiro-cli chat --v2`). It disappears while a draft is typed.

## Send profile

`web/src/lib/surface/profiles/kiro.json` is the bridge's send profile for kiro-cli 2.32.0, measured on that build on 2026-10-17. Ctrl+J, Shift+Enter and Alt+Enter each insert a newline, and the profile uses Ctrl+J. One Backspace per character clears a draft across its lines. Bracketed paste is taken as text; past about 10 lines or 1500 characters it collapses to `N lines ▸` or `N chars ▸`, and one Backspace removes that chip. `!` and `@` are plain characters in the box, but a draft starting with `!` runs as a local shell command with no approval, so `/`, `!` and `@` are reserved leads.

While a turn runs, the box's last row is the prompt row, reading `›  Kiro is working · Ns · Type to steer · Ctrl+S to queue`, and a `ᗥ Thinking... (esc to cancel)` row may stand above the divider (`kiro--v3-running-w120`). Text typed and sent with Enter in a turn went into that turn: `kiro--v3-running-steered-w120` shows it as `› collie steer probe` in the transcript while the turn goes on, and an earlier run showed `◇ 1 message queued` before the same turn answered it. So the profile records that Enter steers. Ctrl+S switches between Steer and Queue mode rather than queueing one message, so the profile names no queue key. The profile's `runningPrompt` matches the busy text. When the input box is found it is read on the prompt row alone, so a draft that quotes it is not a running turn. When no box can be read (an unknown panel is on screen), the bridge's manual-send gate counts it on any row, as it counts every running sign there, so a quoted busy line can only refuse a send. Its running rows match the `(esc to cancel)` row and the `◇ N messages queued` row.

The rest of the profile follows the captures. The placeholder is plain text, not faint, so `placeholders.sgr` is 0 and the placeholder is matched by its text. The box has an open bottom that ends on its last non-blank row, which is the `/sessions … /copy to clipboard` footer when it shows, so the profile names no volatile rows below the box. `neverHeld` lists `/clear`, `/quit`, `/sessions` (which switches to another session) and `!` (which runs a shell command at once).

What the probe showed is in the profile's `probe.note`. Both probed sends went from the phone UI through the bridge, the two-line one arrived as one message, and both receipts read `outcome: "sent"`. With the profile in place, the same two sends were repeated on Herdr and went through unprobed (`probed: false`), each answered as one message.

## Request binding

The adapter uses Collie's existing `submitPromptOption` action path. A decision requires a fresh matching screen. A pointer walk sends only its bound arrows, reads back the landed selection, and then sends Enter bound to that read. The adapter implements no network or send path.

Every signature includes the full panel, request text, every option, pointer and footer, and the complete visible pending tool preview above it, whose header must name the panel's own command or path. A shell panel shows only the command: `description`, `cwd`, `run_in_background` and `timeout` appear only on the preview's `╰` row, and two calls that differ only in `timeout` draw the same panel (`shell-args-allow-w120` and `shell-args-no-timeout-allow-w120`). Kiro writes that row even for a call that set only the command, filling in `run_in_background=false`, so a shell panel without it stays on the terminal. Reads include their line range; writes and replacements require all changed lines, with the visible counts matching the diff summary. The displayed subject is never shortened to fit a card.

Walk identity removes only the parsed pointer and normalizes the two verified pointer-dependent footer spellings. A changed command, path, read range, diff, title or option set invalidates the original decision. Unknown rows, missing previews, count mismatches, invisible controls, shortened subjects, oversized regions and wrapped unsupported footers refuse the lift. No endpoint assumption is declared for the offered button list, because persistent menu rows lie beyond it.

## MCP visibility and limits

Generic MCP approval buttons are deliberately not enabled. A local MCP probe tool was called with a string, a string array, a nested object, an array of objects, and fields named `content`, `text`, `oldStr` and `newStr`; the 2.32.0 panel showed only the string and the string array (`target=lab-target, tags=lab-tag`). Successful echo probes verify the menu keys, not complete input visibility for arbitrary tools. Matching only the visible tool name and resource could answer a changed request whose hidden arguments differ.

MCP requests remain visible through the existing unread-dialog card. That card mirrors the original terminal rows in Chat as well as Terminal view and offers the proven Escape key with confirmation. It supplies no native Allow/Deny buttons. The original terminal and Keys pad remain available.

Other terminal-only cases include persistent trust pages, feedback editors, viewport-clipped diffs, unknown tool/menu shapes, very narrow wrapped footers, ASCII/lite screens, V2 engine approval panels and custom bindings. On V2, Collie types into the composer, and an approval shows as the unread-dialog card. These captures do not establish complete support for attachments, multiline draft recovery or unverified busy/queue/steer variants.

## Fixture groups

All names below have prefix `kiro--v3-` and suffix `.txt`.

| Group | Captured behavior |
| --- | --- |
| `approval-*`, `approval-denied-request-*` | Shell pointer pairs at 120/60 columns, trust-highlight footer, feedback editor and clipped 40-column panel |
| `shell-args-*`, `shell-bare-*`, `shell-wrapped-*` | Shell previews listing `cwd`, `timeout` and `run_in_background`, a call that set only the command, and a long command wrapped in both the preview and the panel |
| `idle-*`, `draft-*` | Normal composer, literal single-line drafts and a word-wrapped draft |
| `running-*` | A running turn: the busy prompt row, and a steered message inside the turn |
| `idle-oneline-*`, `draft-cwd-wrapped-*` | cwd right-aligned on the bar's row, and the same cwd wrapping mid-path under a typed draft |
| `read-*`, `read-wrapped-*` | Complete read preview and range, Allow/Deny pairs, separate denied request and wrapped path |
| `write-*`, `replace-*` | Complete pending diff, Allow/Deny pairs, separate denied requests and replacement editor |
| `write-lines-*` | Complete 15-line diff, including two-digit line indices |
| `write-trusted-*`, `replace-trusted-*` | Default agent configuration: four-option write and replace panels, indented and blank added lines, bare context row |
| `write-viewport-*` | Incomplete 50-line proposal; remains unread |
| `mcp-*`, `mcp-wrapped-*` | Local echo approvals, long title/resource/argument rows and clipped footer; remain unread |

`kiro--v2-idle-w119.txt` is the V2 engine's idle composer, which prints only the copy hint.

## Regression coverage

`kiro.test.ts` runs adapter conformance against the Kiro captures and existing foreign/neutral corpus. `filesystem.test.ts` checks complete subjects, changed diffs and conservative refusal. `lib/prompt-action.test.ts` drives the generic guarded action over the captures: Allow, the Deny walk, Close, the file panels' walks, and a successor edit of the same file arriving mid-walk. `prompt-binding-regions.json` pins every supported Kiro approval region for the client/bridge contract.

`web/e2e/kiro-chat.spec.ts` exercises the built app at phone and tablet sizes. It uses the real captured screens and source-parsed synthetic session data, checks that each emitted binding names the captured request, and covers Chat, read-only History, Allow/Deny actions, stale-request refusal and terminal-only limits. These browser tests replay the verified terminal transitions; they do not claim to drive a live CLI through a browser.
