# Herdr socket API — empirically verified (v0.7.0, protocol 14)

Probed live against a running Herdr server. These are the facts the bridge is built on;
they confirm the socket assumptions behind the design in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Transport

- Unix domain socket at `$HERDR_SOCKET_PATH` (default `~/.config/herdr/herdr.sock`).
- **Newline-delimited JSON.** Request: `{"id": <string>, "method": <string>, "params": <object>}`.
  - `id` **must be a string** (integer → `invalid_request`).
- Response: `{"id", "result": {"type": "...", ...}}` or `{"id": "", "error": {"code", "message"}}`.
- **RPC is one-shot: the server closes the connection after a single response.** Send one
  request per connection. (Confirmed: a second request on the same connection never replies —
  the socket is already closed.)
- Malformed requests close the connection too, and the serde error message names the missing/
  wrong field — which is how this contract was reverse-engineered without side effects.
- **Exception:** `events.subscribe` keeps the connection open and streams events.

## Methods the bridge uses (verified params)

| Method | Params | Returns (`result.type`) |
|---|---|---|
| `workspace.list` | `{}` | `workspace_list` → `workspaces[]` |
| `pane.list` | `{}` | `pane_list` → `panes[]` |
| `pane.read` | `{pane_id, source, lines, format}` | `pane_read` → `read{text, truncated, revision}` |
| `pane.send_text` | `{pane_id, text}` | (ack) |
| `pane.send_keys` | `{pane_id, keys}` | (ack) |
| `agent.send` | `{target, text}` | (ack) — writes **literal** text, no Enter |

- `pane.read` `source` ∈ `visible | recent | recent-unwrapped`; `format` ∈ `text | ansi`.
  **`format: "text"` returns clean plain text (no ANSI escapes)** → safe to render, no XSS surface.
- `agent.send` writes literal text only; to submit a reply, follow with an Enter keypress
  (`pane.send_keys {keys: ["Enter"]}`) — submit-key name needs live confirmation per agent.

## `pane.send_keys` key grammar (verified)

The server **validates** every key and rejects unknown names with
`{error:{code:"invalid_key", message:"unsupported key <X>"}}` (pane lookup happens first, so probe
against a real pane). Empirically enumerated against Herdr 0.7.0 — it is **NOT** tmux syntax:

- **Special keys (bare, case-insensitive):** `Up` `Down` `Left` `Right` `Tab` `Enter` `Escape`
  `Space` `Backspace` (alias `BS`), and function keys `F1`…`F12`.
- **Literal single characters:** a one-character string is typed as that character — digits (`"1"`,
  `"2"`, …), letters, punctuation (live-verified 2026-07-04). This is what Collie's prompt-select
  taps send: `{keys:["1"]}` answers a permission dialog; `{keys:["2","Enter"]}` picks option 2 of an
  AskUserQuestion select.
- **Modifier chords (join with `+`):** `ctrl+c`, `ctrl+u`, `ctrl+d`, `ctrl+l`, `ctrl+r`,
  `shift+tab`, `ctrl+left`, `alt+f`, … Modifiers: `ctrl` / `shift` / `alt` / `cmd` / `super`
  (case-insensitive). This is the **same grammar as `config.toml [keys]`**.
- **NOT supported** (all return `invalid_key`): tmux-style `C-c` / `BTab`; and the keys
  `PageUp` `PageDown` `Home` `End` `Insert` `Delete` (in any spelling). There is no forward-delete
  and no scrollback paging via keys — the web mirror is scrollable instead.
- ⚠️ Consequence: Ctrl-C is **`ctrl+c`**, not `C-c`. Multiple keys per call are applied in order,
  e.g. `{keys:["Down","Enter"]}`.

## Object shapes (observed)

```jsonc
// workspace.list → workspaces[]
{ "workspace_id":"w0000000000000", "number":1, "label":"demo",
  "focused":false, "pane_count":2, "tab_count":1,
  "active_tab_id":"w0000000000000:t1", "agent_status":"done" }

// pane.list → panes[]
{ "pane_id":"w0000000000000:p1", "terminal_id":"term_…", "workspace_id":"w0000000000000",
  "tab_id":"w0000000000000:t1", "focused":false, "cwd":"/…/demo",
  "foreground_cwd":"/…/demo", "agent":"claude", "agent_status":"done",
  "agent_session":{"source":"herdr:claude","agent":"claude","kind":"id","value":"…"},
  "revision":0 }
```

`agent_status` ∈ `idle | working | blocked | done | unknown`. Panes without an agent omit/null `agent`.

## Event stream (available; NOT used by the MVP)

`events.subscribe` `{subscriptions: [{type, …}]}` keeps the connection open and streams events.
Empty `subscriptions: []` → `{result:{type:"subscription_started"}}`. The full event catalog
(the `type` values) is:

```
workspace.created  workspace.updated  workspace.renamed  workspace.closed  workspace.focused
worktree.created   worktree.opened    worktree.removed
tab.created        tab.closed         tab.focused        tab.renamed
pane.created       pane.closed        pane.focused       pane.moved        pane.exited
pane.agent_detected  pane.output_matched  pane.agent_status_changed
```

`pane.agent_status_changed` subscriptions are **pane-scoped** (require a `pane_id`), which makes
global monitoring via subscriptions a bookkeeping exercise (subscribe/unsubscribe as panes come
and go, plus resync on reconnect). **The MVP polls `pane.list` instead** (~1.5 s): one cheap call
returns every pane's `agent_status` with no per-pane subscription management and free resync.
The event stream is the documented path to lower-latency push later (P3).
