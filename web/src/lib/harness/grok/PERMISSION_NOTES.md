# Grok permission card — keystroke recipe

Captured 2026-08-21 and 2026-08-22 on Grok Build 1.0.5 in a sandbox pane (`herdr agent start
groksandbox --kind grok -- --permission-mode default`). Ask mode. The card **replaces** the
composer (no `╭ ❯ ╰` at the tail). Herdr status: `blocked`.

The option count varies by tool class — two layouts captured:

```
┃  <title>
┃  <command>
┃  1 (●) Yes, and don't ask again for anything (always-approve mode)
┃  2 (○) Yes, proceed
┃  3 (○) No, reject (type to add feedback)
1/3:select  │  Tab:next option  │  Ctrl+o:always-approve  │  Ctrl+c:cancel  │  Esc:scrollback
```

```
┃  Allow Edit to <full path>?
┃  1 (○) Yes, and don't ask again for anything (always-approve mode)
┃  2 (○) Yes, allow all edits during this session
┃  3 (●) Yes
┃  4 (○) No, reject (type to add feedback)
1/4:select  │  Tab:next option  │  Ctrl+o:always-approve  │  Ctrl+c:cancel  │  Esc:scrollback
```

The invariant across both: the **last** row is the reject, the row **above it** is the one-shot
Yes, and every row above those is a persistent mode change (global always-approve; session-scoped
allow-all). The footer names the card family and counts its rows (`1/N:select`).

Live-probed:

| Key | Card | Effect |
|---|---|---|
| `Tab` | rm (2026-08-21) | Cycles the `●` 1 → 2 → 3 → 1. Does not confirm. |
| `Enter` | rm (2026-08-21) | Confirms the **highlighted** option. Default highlight on the first card was option 1 (always-approve); on both edit cards it was the one-shot Yes. |
| `2` | rm (2026-08-21) | Confirms **Yes, proceed** immediately, even when `●` is on option 1. Does not persist always-approve (status stayed `Grok 4.6 (high)`). |
| `3` | rm (2026-08-21) | Confirms **No, reject** immediately, no feedback field. |
| `3` | edit (2026-08-22, twice) | Confirms **Yes** immediately. Does **not** persist: the very next edit in the same session re-asked (negative control). |
| `4` | edit (2026-08-22) | Confirms **No, reject** immediately; the file was never written. |
| `q` | rm (2026-08-21) | Not a permission key. |

Not probed (so not emitted): digit `1` (always-approve — a persistent mode change), digit `2` on
the edit card (allow-all-edits-this-session — also persistent), `Ctrl+o`.

What the adapter emits — the bottom Yes/No pair only, and only when every row proves its class:

- The footer must carry all of `1/N:select`, `Tab:next option`, `Ctrl+o:always-approve`,
  `Ctrl+c:cancel`, and `N` must equal the number of option rows.
- Options must be consecutive unique `1..n` radio rows in one contiguous `┃` run, with nothing
  but a couple of blank rows between the card and its footer (the captures show exactly one).
- Last row → **No** button: label must start `No, reject`.
- Second-to-last row → **Yes** button: label must start `Yes` and must NOT match a persistence
  marker.
- Every earlier row must match a persistence marker (`always-approve`, `don't ask again`,
  `this session`) — those are never buttons. An upper row we cannot prove persistent refuses
  the **whole card**: its semantics are unprobed.
- At least one persistent upper row must exist (`n >= 3`): the footer advertises
  `Ctrl+o:always-approve`, so a bare Yes/No card would contradict its own footer — no capture
  has ever shown one.

Cancel stays on the Keys pad (`ctrl+c`). Typing on the No row for a feedback message was not
captured; the digit rejects immediately without one.

.adr/0009 still holds for *generic* menus. This is a specific probed grammar: the digit-confirms-
immediately mechanism and the bottom-pair invariant were each verified on two independent
layouts, and the classification refuses any card that steps outside what was probed.
