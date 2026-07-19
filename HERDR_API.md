# Herdr socket API — empirically verified (v0.7.2, protocol 16)

Probed live against a running Herdr server, most recently re-probed 2026-07-07 and cross-checked
against the bundled machine-readable schema — `herdr api schema [--json | --output PATH]`
(`schema_version 1`, covering requests, responses, errors, and events) is now the fastest way to
re-derive this contract without probing. These are the facts the bridge is built on; they confirm
the socket assumptions behind the design in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

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
| `session.snapshot` | `{}` | `session_snapshot` → `snapshot{workspaces[], tabs[], panes[], agents[], layouts[], focused_*}` |
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

## `session.snapshot` — one RPC, the whole herd (new in 0.7.2)

`session.snapshot` `{}` → `{"type":"session_snapshot","snapshot":{...}}`. One-shot like every RPC —
no special connection handling, no streaming. The `snapshot` bundles everything a client needs to
bootstrap or resync in a single round trip:

```jsonc
{ "version":"0.7.2", "protocol":16,
  "workspaces":[ /* same record shape as workspace.list → workspaces[] */ ],
  "tabs":      [ /* same record shape as tab.list → tabs[] */ ],
  "panes":     [ /* same record shape as pane.list → panes[] */ ],
  "agents":    [ /* precomputed subset of panes[] that carry an agent */ ],
  "layouts":   [ /* per-tab PaneLayoutSnapshot, see layout.updated below */ ],
  "focused_workspace_id":"w0…", "focused_tab_id":"w0…:t1", "focused_pane_id":"w0…:p1" }
  // focused_* are string | null
```

Docs-blessed pattern: **bootstrap with `session.snapshot` → `events.subscribe` → re-`session.snapshot`
on reconnect or staleness.** CLI mirror: `herdr api snapshot` prints the raw reply — handy for
diffing shapes without writing a client.

Collie's bridge polls this method (one RPC per tick instead of the `workspace.list` + `pane.list`
+ `tab.list` trio) and falls back to the trio on older servers that don't know the method. Old-server
detection: the error reply is
``{"id":"","error":{"code":"invalid_request","message":"invalid request: unknown variant `session.snapshot`, expected one of ..."}}``
— the bridge treats an `unknown variant` error on `session.snapshot` specifically as "fall back,"
not a hard failure.

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
- Re-checked against 0.7.2's bundled schema: unchanged.

## Rename methods — set an object's label (verified)

Three sibling RPCs set a display label on a workspace, tab, or pane. Live-verified 2026-07-18.

| Method | Params | `label` | Returns (`result.type`) | Event |
|---|---|---|---|---|
| `pane.rename` | `{pane_id, label}` | `string \| null` — **null clears** | `pane_info` → `{pane}` | **none** |
| `tab.rename` | `{tab_id, label}` | `string` (non-null) | `tab_info` → `{tab}` | `tab_renamed` |
| `workspace.rename` | `{workspace_id, label}` | `string` (non-null) | `workspace_info` → `{workspace}` | `workspace_renamed` |

- **`pane.rename` is the odd one out, twice over.** Its `label` accepts `null`, which **clears** the
  label (the `label` key then disappears from the pane record); the sibling two take a non-null
  string. And it emits **NO event** — a renamed pane surfaces only on the next `session.snapshot` /
  `pane.list` poll. `tab.rename` / `workspace.rename` DO emit: `tab_renamed` →
  `{type, tab_id, workspace_id, label}`, `workspace_renamed` → `{type, workspace_id, label}` (the
  `event` field is snake_case on the stream, as everywhere).
- **Errors:** an unknown id → `{code:"pane_not_found" | "tab_not_found" | "workspace_not_found",
  message:"<kind> <id> not found"}`.
- **No length limit; empty string accepted** (stored as-is on tab/workspace). Re-verified on
  `tab.rename` 2026-07-19: `label:""` is stored **literally** (the tab's label becomes empty — it does
  **not** reset to the default number), and `label:null` is rejected with
  ``{code:"invalid_request", message:"invalid request: invalid type: null, expected a string"}`` —
  confirming tabs/workspaces have **no "clear"** (only `pane.rename` clears, via `null`). Collie makes
  its own opposite choices per object: a blank pane "Save" clears (blank → `null`), while a blank tab
  "Save" is refused client- and bridge-side, since a literal-empty tab chip is useless. See
  `bridge/server.ts` (`normalizeTabLabel`).
- **Undocumented field:** once set, a pane's label rides along as **`label?: string`** in `pane.list`,
  `pane.get`, `pane.current`, and `session.snapshot` panes (omitted when unset — so it's absent from
  the base pane shape below). Workspaces already expose `label`; tabs likewise.
- **`agent.rename` `{target, name}`** also exists in the schema, but it is a DIFFERENT operation
  (renames an agent session, not a pane/tab/workspace) — **unverified and unwired by Collie**. Listed
  only so it isn't mistaken for the label renames above.

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
  "revision":0,
  "scroll":{"offset_from_bottom":0,"max_offset_from_bottom":128,"viewport_rows":48} }
```

`agent_status` ∈ `idle | working | blocked | done | unknown`. Panes without an agent omit/null `agent`.

> **Pane records now carry `scroll`** (new in 0.7.2, live-verified 2026-07-07): `pane.list`,
> `pane.get`, `pane.current`, and `session.snapshot` panes all include
> `scroll: {offset_from_bottom, max_offset_from_bottom, viewport_rows} | null` (all `uint64`;
> `offset_from_bottom == 0` means the pane is scrolled to the bottom). Collie doesn't consume it yet.

> **`revision` is a stub on Herdr 0.7.x** (live-verified 2026-07-05 on 0.7.0; reconfirmed unchanged
> on 0.7.2, live-verified 2026-07-07): `pane.read`, `pane.list`, and `session.snapshot` all return
> `revision: 0` for every pane, including actively-changing ones. Treat it as advisory /
> future-proofing only — never as a load-bearing change detector (Collie's prompt-select race
> guard re-derives the menu from content for exactly this reason).

## Event stream (now wired: event-poked polling)

`events.subscribe` `{subscriptions: [{type, pane_id?}]}` keeps the connection open and streams
events. Empty `subscriptions: []` → ack only, no events ever arrive. The ack and the event frames
are shaped differently — worth calling out explicitly:

- **Ack:** `{"id":"<id>","result":{"type":"subscription_started"}}`.
- **Event:** `{"event":"<snake_case>","data":{...}}`. Note the split: subscription `type` values
  are dot-form (`pane.agent_status_changed`), but the `event` field on each streamed line is
  snake_case (`pane_agent_status_changed`). Real example line:
  `{"data":{"pane_id":"w6:p3","type":"pane_agent_detected","workspace_id":"w6"},"event":"pane_agent_detected"}`.

The full event catalog (subscription `type` values), 0.7.2 additions marked `*`:

```
workspace.created  workspace.updated  workspace.renamed  workspace.closed  workspace.focused  workspace.moved *
worktree.created   worktree.opened    worktree.removed
tab.created        tab.closed         tab.focused        tab.renamed       tab.moved *
pane.created       pane.closed        pane.focused       pane.moved        pane.exited
pane.agent_detected  pane.output_matched  pane.agent_status_changed
layout.updated *   pane.scroll_changed *
```

`*` = new to the catalog in 0.7.2 (`workspace.moved`, `tab.moved`, `layout.updated`,
`pane.scroll_changed`); `workspace.updated` and `pane.focused` were already listed but are called
out here too since they're easy to miss in the block above.

- **Scoping, verified:** `pane.agent_status_changed`, `pane.scroll_changed`, and
  `pane.output_matched` **require** `pane_id` in the subscription (omit it →
  ``invalid_request: missing field `pane_id` ``). Everything else is global — subscribe with just
  `{type}`.
- **`layout.updated`** (global) payload is a full `PaneLayoutSnapshot`: `{workspace_id, tab_id,
  zoomed, area, focused_pane_id, panes:[{pane_id,focused,rect}],
  splits:[{id,direction,ratio,rect}]}` — the same shape as `session.snapshot`'s `layouts[]`.
- **`pane.scroll_changed`** (pane-scoped) payload: `{pane_id, workspace_id, scroll}` (`scroll`
  shape as in "Object shapes" above).
- **Rich payloads:** `pane_created` / `workspace_created` carry the **full** pane/workspace
  record, not just ids. `pane_exited` carries `{pane_id, workspace_id}`. `pane_agent_detected`
  carries `{pane_id, workspace_id, agent?}` and can fire in herd-wide bursts on re-detection —
  consumers should debounce it.

Collie now polls `session.snapshot` (above) as the source of truth, and additionally holds a
long-lived `events.subscribe` stream — global lifecycle events plus a per-agent-pane
`pane.agent_status_changed` subscription, resubscribed whenever the agent-pane set changes —
purely to **poke** the poller: an event triggers an immediate debounced re-poll, it never updates
state by itself. While the stream is healthy, interval polling relaxes to `COLLIE_POLL_IDLE_MS`
(default 12000 ms, min 1000 ms); when the stream is down or reconnecting, it drops back to the
fast `COLLIE_POLL_MS` cadence. Events accelerate; the snapshot stays authoritative — a missed
event costs one interval, never correctness.

Also visible in the 0.7.2 schema but unused by Collie: `events.wait`, `pane.send_input`,
`agent.list`, `pane.wait_for_output` — run `herdr api schema` for the full ~80-method catalog.
