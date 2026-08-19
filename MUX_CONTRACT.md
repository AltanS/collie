# The mux contract — capability matrix

Collie's own interface to a terminal multiplexer lives in [`bridge/mux/`](./bridge/mux/): the port
([`types.ts`](./bridge/mux/types.ts)), what an adapter declares
([`capabilities.ts`](./bridge/mux/capabilities.ts)), and the one place a configured name becomes an
adapter ([`registry.ts`](./bridge/mux/registry.ts)). Why a port and not a relocated Herdr client:
[ADR 0022](./.adr/0022-the-mux-seam-is-a-port-collie-owns.md).

**This file is the evidence that the contract is not Herdr's shape renamed.** Every cell cites where
its answer was verified. Nothing here restates the port — read the code for that; read this to see
what each multiplexer can actually answer.

Sources, once:

| Tag | What it is |
| --- | --- |
| **API** | [`HERDR_API.md`](./HERDR_API.md) — the verified Herdr socket contract (0.7.2, protocol 16) |
| **T** | First-hand probe of **tmux 3.6b** on a throwaway server — [M10/04 Ground Truth](./.tracker/M10-mux-drivers/04-the-tmux-adapter.md) |
| **Z** | First-hand probe of **zellij 0.44.2** — [M10/05 Ground Truth](./.tracker/M10-mux-drivers/05-the-zellij-adapter.md) |
| **?** | Not probed yet. The adapter's spec probes it and fills the cell in; **an unprobed cell is never declared supported.** |

## The floor — not capabilities

An adapter that cannot answer these is not an adapter; there is nothing for Collie to render, so
there is nothing to declare.

| Port method | Herdr | tmux | zellij |
| --- | --- | --- | --- |
| `reachable()` | any one-shot RPC answers (**API** § Transport) | `list-panes` exits 0 against the server (**T**) | `list-sessions` enumerates sessions (**Z**) |
| `snapshot()` — panes, spaces, tabs | `session.snapshot`, one round trip (**API** § session.snapshot) | `list-panes -a -F '…'` → `%0 probe 0 bluefin bash 80x24 0` (**T**) | `list-panes` JSON + `list-tabs` (**Z**) |
| `watch()` — notify me to re-read | `events.subscribe` (**API** § Event stream) | control mode `tmux -C` (**T**) | per-pane stream + topology poll (**Z**) |

`watch()` is on the floor because the *promise* is — "tell me to look again". Whether it is kept by a
push or a poll is what the two `push*Events` capabilities below declare.

## Capabilities

| Capability | Consumed by | Herdr | tmux | zellij |
| --- | --- | --- | --- | --- |
| `paneGrid` | `GET /api/pane/:id` | `pane.read` with `format:"ansi"` (**API**) | `capture-pane -p -e` — SGR intact (**T**) | `dump-screen -a -p <id>` (**Z**) |
| `gridScrollback` | the mirror's "Load older" | yes, bounded by the pane's ring; an alt-screen pane reports its viewport only (**API**, `bridge/types.ts` `readableLines`) | `capture-pane -S -N` — 51 lines behind a 24-line viewport (**T**); depth is `history_size + pane_height` | `dump-screen --full` (**Z**) — screen scrollback, **not** history; see below |
| `agentDetection` | the `agents`/`shellPanes` split, triage sort | agent name + status + status-change events (**API** § Object shapes, § Event stream) | **no** — only `pane_current_command` / `pane_title` (**T**) | **no** — nothing in the probe reports an agent (**Z**) |
| `agentSessionRef` | `GET /api/pane/:id/history` | the pane record carries the session an agent named (**API** § Object shapes) | **no** (**T**) — history is declared absent, not empty | **no** (**Z**) |
| `typeText` | `POST …/reply` step 1 | `pane.send_text` (**API**) | `send-keys -t <pane> 'text'` (**T**) | `write-chars <CHARS> -p <id>` (**Z**) |
| `sendKeys` | `POST …/reply` step 2, `POST …/keys` | `+`-joined, e.g. `ctrl+c`; paging/edit keys refused (**API** § key grammar) | `C-c`, `BTab`, `PPage`, `DC` — its own names, and it sends the whole alphabet including the six Herdr refuses (**T**); it has no Super/Command key, so a `meta` chord is refused | `send-keys "Ctrl a"`, space-separated (**Z**) |
| `renamePane` | `POST …/rename` | `pane.rename`, `null` clears (**API** § Rename) | `select-pane -T <label>`, and `-T ""` clears (**T**) — tmux's ONE title slot, which is why `terminalTitle` is never reported on tmux | `rename-pane` (**Z**); clearing unprobed |
| `closePane` | `POST …/close` | `pane.close` (**API** § Close) | `kill-pane` (**T**) | `close-pane` (**Z**) |
| `createTab` | `POST /api/tab` | `tab.create`, returns the fresh shell (**API**) | `new-window -d -P -F` returns the fresh pane's ids (**T**); `-d` so nothing the operator is looking at moves | **?** `new-pane` exists; a new *tab* is unprobed (**Z**) |
| `renameTab` | `POST /api/tab/:id/rename` | `tab.rename`, non-null only (**API** § Rename) | `rename-window -t @N -- <label>` (**T**) | `rename-tab-by-id` (**Z**) |
| `closeTab` | `POST /api/tab/:id/close` | `tab.close` — a bulk pane-close (**API** § Close) | `kill-window` (**T**) — and it ends the session too when it was the last window, exactly as tmux itself does | `close-tab-by-id` (**Z**) |
| `createSpace` | `POST /api/workspace` | `workspace.create` (**API**) | `new-session -d -P -F` (**T**) — claimed: it is one verb, it is detached, and a duplicate name comes back as `refused` with tmux's own sentence | **?** same shape — a zellij session is configuration (**Z**) |
| `pushTopologyEvents` | `bridge/event-poker.ts` | full event catalog: workspace/tab/pane created, closed, renamed (**API** § Event stream) | control mode pushes `%window-add`, `%session-changed` (**T**) | **no** — nothing announces topology; the adapter runs a bounded poll (**Z**) |
| `pushPaneEvents` | `bridge/event-poker.ts` | `pane.agent_status_changed`, pane-scoped (**API** § Event stream) | `%output`, but only for the panes of the session a control client is ATTACHED to (**T**) — so the adapter attaches one per watched session, capped, and a 5-second listing is the floor | `subscribe --ansi -f json -p <id>` (**Z**) |

### Deliberately not capabilities

- **Image upload** (`POST /api/pane/:id/upload`). Read the route: `uploadPane` takes the config and
  never the multiplexer. It writes a file to the bridge host's disk and returns a path the operator
  pastes. A multiplexer cannot decline it, so declaring it would be theatre.
- **The floor**, above.
- **A single key.** `sendKeys` is one door; the keys behind it that a given multiplexer refuses are
  listed in that adapter's `unsupportedKeys` (Herdr's are enumerated in **API** § key grammar). One
  missing key must not close the door.

## Pointing a collie at a multiplexer

Three keys, and the default is that nothing changes for anyone. `bridge/config.ts` resolves them once
at startup and `bridge/index.ts` is the only place they become an adapter.

| Key | Default | What it says |
| --- | --- | --- |
| `COLLIE_MUX` | `herdr` | Which adapter drives this collie. An unknown name refuses to start, with the valid ones in the message. |
| `COLLIE_MUX_ENDPOINT_<NAME>` | — | Where that adapter's multiplexer lives, in **its** words. Herdr reads `HERDR_SOCKET_PATH` instead, so nothing about an existing deployment moves. For tmux: `COLLIE_MUX_ENDPOINT_TMUX` is a server **socket name** (`-L`) when it has no `/`, a **socket path** (`-S`) when it does, and **empty means tmux's own default server**. |
| `COLLIE_TMUX_BIN` | — | Absolute path to `tmux`, when it is somewhere unusual. Empty probes fixed paths — never `PATH`, which a systemd unit and a Herdr plugin action do not share with the operator's shell. |

Multi-session discovery (`COLLIE_MULTI_SESSION`) walks Herdr's config root for Herdr sockets, so it is
Herdr's own shape and is inert under any other multiplexer: a tmux collie fronts the one tmux server
its endpoint names.

### What a space and a tab ARE, per multiplexer

The contract's nouns are space → tab → pane. Each adapter says which of its own levels those are, and
the answer is part of the adapter's header rather than folklore:

| Collie | Herdr | tmux | zellij |
| --- | --- | --- | --- |
| space | workspace (`w6`) | **session** (`$0`) | **?** |
| tab | tab (`t3`) | **window** (`@3`) | tab (**Z**) |
| pane | pane (`w6:p3`) | **pane** (`%7`) | terminal (`terminal_1`) |

tmux's three levels are Collie's three levels, and every id is carried through unchanged — which is
what makes them stable across a rename (a `session_id` survives what a `session_name` does not).

## Contract-owned rules

Four things the contract owns outright, because an adapter deciding them independently is how the
seam rots.

| Rule | What the contract says | How each adapter meets it |
| --- | --- | --- |
| **Identity** ([`identity.ts`](./bridge/mux/identity.ts)) | A pane id is opaque above the adapter, stable across reconnect/restart/rename, unique within one collie, never recycled, and safe as one URL segment | Herdr `w6:p3` (**API**); tmux `%0` (**T**); zellij `terminal_<n>` (**Z**) — three shapes, all carried unchanged |
| **Keys** ([`keys.ts`](./bridge/mux/keys.ts)) | One neutral spelling: `+`-joined lower-case modifiers in canonical order `ctrl alt shift meta`, then a single character or one CapitalCase name from a **closed, complete** alphabet | Herdr's grammar is nearly it, minus `meta`→`super`/`cmd` (**API**); tmux and zellij each need a real translation table (**T**, **Z**) |
| **The grid** | Already rendered by the multiplexer, colour only. Collie runs no terminal emulator ([ADR 0008](./.adr/0008-collie-does-not-run-a-terminal-emulator.md)) — an adapter may **decline** the grid; it never gets a VT parser written for it | all three render on demand (**API**, **T**, **Z**) |
| **Refusal** | One shape, four reasons, and `unsupported` is not a failure — the UI explains it (M10/06) instead of reporting an error | every adapter returns it rather than throwing; conformance checks both directions (M10/03) |

Two traps worth naming, both found while writing this table:

- **Scrollback is not history.** zellij's `dump-screen --full` is untyped screen text; the journal
  reads the *agent's own log* and knows turns, tools and content ([`bridge/journal/`](./bridge/journal/)).
  If screen scrollback is ever exposed it gets its own capability name — never `agentSessionRef`.
- **The pane list is not the pane.** Collie's `AgentView` carries things only Collie knows (when you
  last looked, whether a pane is unseen). Those are the bridge's, not the multiplexer's, and
  `MuxPane` deliberately stops short of them.
