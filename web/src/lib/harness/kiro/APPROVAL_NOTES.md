# Kiro CLI V3 approval and composer captures

## Provenance

Every fixture was captured on 2026-10-17 from public `kiro-cli 2.32.0`: the x86_64 musl build from the stable channel at `prod.download.cli.kiro.dev`, checked against the sha256 in its manifest and run directly, using Bun 1.4.3 on Linux. Isolated PTYs ran minimal scratch agents with `--v3 --trust-tools=''` and the model `qwen3-coder-next`. Shell, filesystem and local stdio MCP probes used only synthetic commands, files and messages. No persistent tool-approval option was confirmed. All scratch processes were stopped.

Actual PTY output was fed into an xterm terminal grid. Each `.txt` fixture is an SGR-only projection of its visible text, padding, colors and style flags. These files are grid captures, not original PTY escape streams or claimed Herdr `pane.read` responses. Transcript rows above the relevant approval or composer were removed. Blank viewport rows remain.

For publication, the username and the scratch folder path were replaced with equal-length aliases, following the path across row breaks where it wraps. A host-specific authentication-expiry label in composer status rows was replaced with the equal-length word `Status`; its time value is unchanged. These substitutions preserve wrapping and columns. Request markers, option labels, pointers, dividers, footers and diff contents were not changed. No credentials or real conversation content are included.

The `-trusted-`, `idle-oneline`, `draft-cwd-wrapped` and `kiro--v2-` fixtures were captured the same day from the same version, through Herdr, with the default agent configuration (no `--trust-tools`) in a disposable `/tmp/kiro-fixture/demo` folder. These are Herdr `pane read --source visible --format ansi --raw` responses, cut from the composer divider or the `↓` preview row down. They use the same expiry substitution, and the host's model name was replaced with the equal-length `qwen3-coder`.

Existing workspace trust, permissions and user settings were not edited. The captures and live probes alone establish the behavior described here.

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

Collie types into the composer only when the whole status bar frame is on screen: the divider, a bar holding `·`-separated fields and the context gauge, the cwd, a blank row and the `›` prompt. The cwd takes one of three layouts. It is right-aligned on the bar's row when both fit, on its own row below the bar when they do not, or starts on the bar's row and wraps mid-path onto the next one. The third appeared live when the expiry field grew by one character (`12h 47m`) and pushed `/tmp/kiro-fixture/demo` past 120 columns.

The footer is `/sessions to resume · /copy to clipboard` on V3 and `/copy to clipboard` alone on the V2 engine (`kiro-cli chat --v2`). It disappears while a draft is typed.

## Send profile

`web/src/lib/surface/profiles/kiro.json` is the bridge's send profile for kiro-cli 2.32.0, measured on that build on 2026-10-17. Ctrl+J, Shift+Enter and Alt+Enter each insert a newline, and the profile uses Ctrl+J. One Backspace per character clears a draft across its lines. Bracketed paste is taken as text; past about 10 lines or 1500 characters it collapses to `N lines ▸` or `N chars ▸`, and one Backspace removes that chip. The probe character `⌁`, `!` and `@` are plain characters in the box, but a draft starting with `!` runs as a local shell command with no approval, so `/`, `!` and `@` are reserved leads.

While a turn runs, the prompt row reads `›  Kiro is working · Ns · Type to steer · Ctrl+S to queue` above a `(esc to cancel)` row. Enter then shows `◇ 1 message queued` and the message is answered in the same turn, so the profile records that Enter steers. Ctrl+S switches between Steer and Queue mode rather than queueing one message, so the profile names no queue key.

On Herdr, `⌁` typed into a live shell approval panel changed nothing on screen. Two live probed sends from the phone UI then passed through the bridge: one line sent with Enter, and two lines sent with Ctrl+J then Enter, which arrived as one message. Both receipts read `outcome: "sent"`, so the profile is verified through 2.32.0. tmux and zellij were not tried.

## Request binding

The adapter uses Collie's existing `submitPromptOption` action path. A decision requires a fresh matching screen. A pointer walk sends only its bound arrows, reads back the landed selection, and then sends Enter bound to that read. The adapter implements no network or send path.

The shell signature includes the full panel, request text, every option, pointer and footer. A filesystem signature additionally includes the complete visible pending tool preview. Reads include their line range; writes and replacements require all changed lines, with the visible counts matching the diff summary. The displayed subject is never shortened to fit a card.

Walk identity removes only the parsed pointer and normalizes the two verified pointer-dependent footer spellings. A changed command, path, read range, diff, title or option set invalidates the original decision. Unknown rows, missing previews, count mismatches, invisible controls, shortened subjects, oversized regions and wrapped unsupported footers refuse the lift. No endpoint assumption is declared for the offered button list, because persistent menu rows lie beyond it.

## MCP visibility and limits

Generic MCP approval buttons are deliberately not enabled. Kiro's terminal formatter can omit nested object arguments, non-primitive array members and fields such as `content`, `text`, `oldStr` and `newStr`. Successful echo probes verify the menu keys, not complete input visibility for arbitrary tools. Matching only the visible tool name and resource could answer a changed request whose omitted arguments differ.

MCP requests remain visible through the existing unread-dialog card. That card mirrors the original terminal rows in Chat as well as Terminal view and offers the proven Escape key with confirmation. It supplies no native Allow/Deny buttons. The original terminal and Keys pad remain available.

Other terminal-only cases include persistent trust pages, feedback editors, viewport-clipped diffs, unknown tool/menu shapes, very narrow wrapped footers, ASCII/lite screens, V2 engine approval panels and custom bindings. On V2, Collie types into the composer, and an approval shows as the unread-dialog card. These captures do not establish complete support for attachments, multiline draft recovery or unverified busy/queue/steer variants.

## Fixture groups

All names below have prefix `kiro--v3-` and suffix `.txt`.

| Group | Captured behavior |
| --- | --- |
| `approval-*`, `deny-request-*` | Shell pointer pairs at 120/60 columns, trust-highlight footer, feedback editor and clipped 40-column panel |
| `idle-*`, `draft-*` | Normal composer, literal single-line drafts and a word-wrapped draft |
| `idle-oneline-*`, `draft-cwd-wrapped-*` | cwd right-aligned on the bar's row, and the same cwd wrapping mid-path under a typed draft |
| `read-*`, `read-wrapped-*` | Complete read preview and range, Allow/Deny pairs, separate denied request and wrapped path |
| `write-*`, `replace-*` | Complete pending diff, Allow/Deny pairs, separate denied requests and replacement editor |
| `write-lines-*` | Complete 15-line diff, including two-digit line indices |
| `write-trusted-*`, `replace-trusted-*` | Default agent configuration: four-option write and replace panels, indented and blank added lines, bare context row |
| `write-viewport-*` | Incomplete 50-line proposal; remains unread |
| `mcp-*`, `mcp-wrapped-*` | Local echo approvals, long title/resource/argument rows and clipped footer; remain unread |

`kiro--v2-idle-w119.txt` is the V2 engine's idle composer, which prints only the copy hint.

## Regression coverage

`kiro.test.ts` runs adapter conformance against the Kiro captures and existing foreign/neutral corpus. `filesystem.test.ts` checks complete subjects, changed diffs and conservative refusal. `guard.test.ts` exercises the unchanged generic action with stale entry states, successor requests during pointer walks, selection timeouts, cancellation and bridge binding refusal. `prompt-binding-regions.json` pins every supported Kiro approval region for the client/bridge contract.

`web/e2e/kiro-chat.spec.ts` exercises the built app at phone and tablet sizes. It uses the real captured screens and source-parsed synthetic session data, checks each emitted binding with the bridge verifier, and covers Chat, read-only History, Allow/Deny actions, stale-request refusal and terminal-only limits. These browser tests replay the verified terminal transitions; they do not claim to drive a live CLI through a browser.
