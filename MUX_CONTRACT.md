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
| **L** | First-hand probe of this host's **live test instances** — 2026-08-25, tmux socket `/run/user/1000/collie-tmux.sock` and zellij session `collie-zellij` |
| **H8** | First-hand probe of **herdr 0.8.2** (protocol 20) on this host — 2026-08-28, an isolated `herdr --session wtprobe` over a throwaway repo, worktree verbs only |
| **?** | Not probed yet. The adapter's spec probes it and fills the cell in; **an unprobed cell is never declared supported.** |

## The floor — not capabilities

An adapter that cannot answer these is not an adapter; there is nothing for Collie to render, so
there is nothing to declare.

| Port method | Herdr | tmux | zellij |
| --- | --- | --- | --- |
| `reachable()` | any one-shot RPC answers (**API** § Transport) | `list-panes` exits 0 against the server (**T**) | `list-panes --json` parses for the configured session (**Z**) |
| `snapshot()` — panes, spaces, tabs | `session.snapshot`, one round trip (**API** § session.snapshot) | `list-panes -a -F '…'` → `%0 probe 0 bluefin bash 80x24 0` (**T**) | `list-panes --all --json` + `list-tabs --all --json`, two calls (**Z**); plugin panes — tab bar, status bar, overlays — are dropped, and they are why the id is namespaced (`plugin_0` and `terminal_0` both existed in the probe) |
| `watch()` — notify me to re-read | `events.subscribe` (**API** § Event stream) | control mode `tmux -C` (**T**) | `subscribe` for content + a bounded census for structure (**Z**) — the hybrid, and the only one of the three |
| `refresh()` — look NOW | a no-op that resolves: every `snapshot()` is already a fresh RPC and the watch is a real stream, so there is no clock to move (**API** § Transport) | resync every live watch and re-arm the 5 s backstop — **L**: `refresh()` resolved in **4 ms** and produced a topology callback for a `rename-window` run from another shell | census now and drop the interval to its floor — **L**: after 20 s idle, an out-of-band `rename-tab-by-id` reached the watch **446 ms** after `refresh()` was called |

`watch()` is on the floor because the *promise* is — "tell me to look again". Whether it is kept by a
push or a poll is what the two `push*Events` capabilities below declare.

`refresh()` is on the floor for the same reason: every multiplexer can take a listing on demand, and
it asks for nothing an adapter does not already do on its own schedule. What it buys is the
*schedule* — the operator's own tap, rather than the next census
([ADR 0031](./.adr/0031-freshness-is-a-declared-promise.md)). It writes nothing, which is what lets
`POST /api/refresh` be gated as a read and lets the live probe call it against a real session.

## The declared facts — not capabilities either

| Fact | Herdr | tmux | zellij |
| --- | --- | --- | --- |
| `topologyLatency` — how soon a change nobody announced is seen | `push` (**API** § Event stream: workspace/tab/pane created, closed, renamed all arrive) | `push` (**T**) — control mode announces `%window-add` / `%window-renamed`; the 5 s resync is the backstop for unattached sessions and for a tmux with no control mode, never the bound | `bounded`, **12 000 ms** (**Z**) — the census ceiling, because zellij's CLI announces no structure change at all. **L**: an out-of-band rename reached the watch in **5 892 ms** with nobody looking and in **1 049 ms** while `attention` said `watched` |
| `spaces` — how many spaces it can hold | `"many"` (**API**) | `"many"` (**T**) — a space is a tmux session, and a server holds any number | `"one"` (**Z**) — one adapter instance IS one session, because every zellij verb is scoped to one; see *What a space and a tab ARE* below for the mapping and the web rule |

Both are **facts, not capabilities**: they answer "how fast" and "what shape", never "whether", so
they sit beside `unsupportedKeys` on the declaration rather than in the capability list. Both are
published under `mux` in `/api/config`, and the phone reacts to the declaration and never to the
name. The number a `bounded` adapter states is its **ceiling** — the longest a change can sit
unseen — because a bound that only holds while the herd happens to be busy is not a bound.

The two defaults deliberately point opposite ways. `spaces` may be omitted and reads as `"many"`,
because a strip over one space is harmless while a hidden strip over three is navigation the operator
cannot reach. `topologyLatency` is **required**, because both of its answers promise the operator
something: defaulting to `push` would hide real staleness, and defaulting to `bounded` would invent a
counter for a multiplexer that is never stale.

**Attention tightens a census; it never changes the declaration.** The bridge knows whether a phone
read it within the last ten seconds (`bridge/state-engine.ts`) and hands that one word to `watch()`.
zellij's census runs between 1.5 s and 3 s while somebody is looking and between 3 s and 12 s while
nobody is; tmux and Herdr ignore it, because they push. The declaration keeps stating the idle
ceiling: attention is something the bridge observes, never something a caller can promise.

**L** — first-hand probe against this host's live test instances, 2026-08-25: tmux socket
`/run/user/1000/collie-tmux.sock`, zellij session `collie-zellij`.

## Capabilities

| Capability | Consumed by | Herdr | tmux | zellij |
| --- | --- | --- | --- | --- |
| `paneGrid` | `GET /api/pane/:id` | `pane.read` with `format:"ansi"` (**API**) | `capture-pane -p -e` — SGR intact (**T**) | `dump-screen --ansi --pane-id <id>` — SGR intact, no padding (**Z**) |
| `gridScrollback` | the mirror's "Load older" | yes, bounded by the pane's ring; an alt-screen pane reports its viewport only (**API**, `bridge/types.ts` `readableLines`) | `capture-pane -S -N` — 51 lines behind a 24-line viewport (**T**); depth is `history_size + pane_height` | `dump-screen --full` (**Z**) — 294 lines behind a 22-line viewport in the probe. Screen scrollback, **not** the agent's log; see below. `readableLines` is the pane's rows plus zellij's own default `scroll_buffer_size` (10 000), because no verb reports the real depth |
| `agentDetection` | the `agents`/`shellPanes` split, triage sort | agent name + status + status-change events (**API** § Object shapes, § Event stream) | **no** — only `pane_current_command` / `pane_title` (**T**) | **no** — the listing reports a pane's title and its launch command, and neither is an agent (**Z**) |
| `agentSessionRef` | `GET /api/pane/:id/history` | the pane record carries the session an agent named (**API** § Object shapes) | **no** (**T**) — history is declared absent, not empty | **no** (**Z**) |
| `typeText` | `POST …/reply` step 1 | `pane.send_text` (**API**) | `send-keys -t <pane> 'text'` (**T**) | `write-chars --pane-id <id> -- <text>` (**Z**). Refused past 128 KiB: zellij takes the text as an argv element with no stdin path, and 200 000 characters answered `Argument list too long` — the message is refused, never split (ADR 0010). **`paste` is deliberately not used**: probed, it wraps the text in `ESC[200~ … ESC[201~`, an input path neither other adapter takes |
| `sendKeys` | `POST …/reply` step 2, `POST …/keys` | `+`-joined, e.g. `ctrl+c`; paging/edit keys refused (**API** § key grammar) | `C-c`, `BTab`, `PPage`, `DC` — its own names, and it sends the whole alphabet including the six Herdr refuses (**T**); it has no Super/Command key, so a `meta` chord is refused | `send-keys "Ctrl a"`, space-separated (**Z**); `Esc` is the one renamed key and every other name in the alphabet was accepted, so `unsupportedKeys` is empty. It REFUSES a name it does not know (exit 2) rather than typing it. `Super a` exits 0 and delivers a bare `a`, so a `meta` chord is refused |
| `renamePane` | `POST …/rename` | `pane.rename`, `null` clears (**API** § Rename) | `select-pane -T <label>`, and `-T ""` clears (**T**) — tmux's ONE title slot, shared with whatever the pane's program prints, so the adapter remembers what it set (see § Contract-owned rules, *Pane naming*) | `rename-pane --pane-id <id> -- <label>` (**Z**); an empty label restores zellij's own name, which is how `null` clears. zellij's ONE title slot, shared the same way and split the same way |
| `closePane` | `POST …/close` | `pane.close` (**API** § Close) | `kill-pane` (**T**) | `close-pane --pane-id <id>` (**Z**) |
| `createTab` | `POST /api/tab` — JSON body `{"workspaceId": …, "label"?: …, "cwd"?: …}`; the space id is the one the snapshot reports (`GET /api/snapshot`), which under zellij is always the constant `session` | `tab.create`, returns the fresh shell (**API**) | `new-window -d -P -F` returns the fresh pane's ids (**T**); `-d` so nothing the operator is looking at moves. **Refused** on tmux < 3.7 while the global `window-size` is `manual`: the spawn segfaults the whole server (tmux #4849, fixed in 3.7), so the adapter reads the option first and hands the operator the `tmux set -g window-size latest` that clears it — it never sets the option itself | `new-tab [--name] [--cwd]` prints the new tab's stable id; the fresh pane comes from the listing straight after, which the probe found already populated (**Z**) |
| `renameTab` | `POST /api/tab/:id/rename` | `tab.rename`, non-null only (**API** § Rename) | `rename-window -t @N -- <label>` (**T**) | `rename-tab-by-id <n> <label>` (**Z**) |
| `closeTab` | `POST /api/tab/:id/close` | `tab.close` — a bulk pane-close (**API** § Close) | `kill-window` (**T**) — and it ends the session too when it was the last window, exactly as tmux itself does | `close-tab-by-id <n>` (**Z**) — and zellij closes a tab whose last pane goes away, exactly as it does by hand |
| `setFocus` | `POST /api/pane/:id/focus` — the pane sheet's "Show in terminal" row | `pane.focus {pane_id}`, ONE call: probed 2026-08-25 against the `collie-demo` sandbox session, the reply was `pane_info` and the next snapshot moved `focused_pane_id`, `focused_tab_id` AND `focused_workspace_id` together, so `tab.focus`/`workspace.focus` are never called. A pane that has gone answers `pane_not_found` (probed read-only against the live server) → `gone` | `select-window -t <window> ; select-pane -t <pane>` — one invocation, both levels, because a screen showing the right window and the wrong pane is a half-kept promise (**T**, probed 2026-08-25 on the test server: `window_active` and `pane_active` moved together) — **plus `; switch-client -c <client_tty> -t <session>` for every attached non-control client sitting on another session**, because tmux's current window belongs to the SESSION and those two commands move nothing on a terminal that is showing a different one (**T**, probed 2026-08-25 on the two-session test server: focusing a `collie-tmux` pane answered `{ok:true}` while the client on `ss-wp` stayed put; with the switch-client leg the client moved and `#{session_name} #{pane_id}` followed). No client attached ⇒ nothing to switch, and the window/pane selection alone is right: the next attach lands there. The window id, the session id and the clients all come out of the same listing the snapshot uses, so a stale pane id is `gone` before anything is spawned; `can't find window:` / `can't find pane:` classify as `gone` | **no** (**Z**) — `action focus-pane-id` exists on 0.44.2 and does NOTHING: probed 2026-08-25 with a client attached, both `focus-pane-id terminal_3` and the bare `focus-pane-id 3` exited 0 while `list-clients` still reported the client on `terminal_0`, and `focus-next-pane` moved it, so the session was live. `go-to-tab <n>` DOES work (1-based over tab position, probed) — and a tab-level approximation is deliberately declined: the promise is "this pane is in front", and showing a tab whose focus sits on a neighbour is the quiet lie conformance exists to catch |
| `createSpace` | `POST /api/workspace` | `workspace.create` (**API**) | `new-session -d -P -F` (**T**) — claimed: it is one verb, it is detached, and a duplicate name comes back as `refused` with tmux's own sentence. It carries the same `window-size manual` refusal as `createTab`: `new-session` spawns a window too, so tmux #4849 kills the server here as well | **no** (**Z**) — `zellij attach --create-background` does make a detached session, but every zellij verb is scoped to ONE session, so a session created here would be invisible to the adapter that made it |
| `listWorktrees` | `GET /api/workspace/:id/worktrees` | `worktree.list {cwd}` — answers for a repo NOTHING has open, so the sheet can list a checkout before there is a space to name it by (**H8**). The repo's own checkout comes back too, with `is_linked_worktree: false` | **no** (**T**) — tmux has no Git vocabulary; a `git worktree list` here would answer about the host, not about anything tmux knows | **no** (**Z**) — same, and see `createSpace` |
| `createWorktree` | `POST /api/workspace/:id/worktree` | `worktree.create {cwd, branch, focus:false}` → the new workspace and its root pane, ready to navigate to (**H8**). **NOT ATOMIC:** probed in a session with no window server, the checkout was created and the open failed `worktree_open_failed` — the branch exists, nothing shows it, and a retry answers `worktree_create_failed` because the path is taken. Recovery is `openWorktree` | **no** (**T**) — `git worktree add` would run, but tmux keeps no record tying the checkout to the session showing it, so what it made could not be listed or removed again (ADR 0032) | **no** (**Z**) — same, plus one session means no second space to open it as |
| `openWorktree` | `POST /api/workspace/:id/worktree/open` | `worktree.open {cwd, path, focus:false}` → `already_open` plus the space showing it; asking for one already up is an ANSWER, not a refusal (**H8**). `path` alone answers `not_git_worktree` — the repo must come with it | **no** (**T**) | **no** (**Z**) |
| `pushTopologyEvents` | `bridge/event-poker.ts` | full event catalog: workspace/tab/pane created, closed, renamed (**API** § Event stream) | control mode pushes `%window-add`, `%session-changed` (**T**) | **no** (**Z**) — no CLI verb announces one. `zellij watch` is a read-only attach, `zellij pipe` needs a WASM plugin on the other end, and `action --help` has no event verb. The adapter censuses `list-panes` instead: 3 s after any change, doubling to 12 s while nothing moves |
| `pushPaneEvents` | `bridge/event-poker.ts` | `pane.agent_status_changed`, pane-scoped (**API** § Event stream) | `%output`, but only for the panes of the session a control client is ATTACHED to (**T**) — so the adapter attaches one per watched session, capped, and a 5-second listing is the floor | `subscribe --ansi --format json --pane-id <id> …` — several panes per stream, newline-delimited JSON `pane_update` frames (**Z**). It also emits one `pane_closed`, the single topology fact zellij does push, which shortens the census rather than replacing it |

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
| `COLLIE_ZELLIJ_BIN` | — | The same, for `zellij`. The fixed-path probe tries `~/.local/bin` first, because that is where zellij's own installer puts it. |

For zellij, `COLLIE_MUX_ENDPOINT_ZELLIJ` is a **session name**, and **empty means the single running
session** — with none, or with two, Collie refuses to start driving one rather than guessing, and the
message names what it found. A configured session that has exited is refused by name; it is never
silently replaced by a neighbour.

**One environment variable is load-bearing for zellij and easy to lose.** zellij finds its running
sessions through a socket directory under `XDG_RUNTIME_DIR`. Probed: the same `list-sessions` under
`env -i` reported a live session as `(EXITED …)`. A collie that sees every zellij session as exited is
looking at a unit file with no `XDG_RUNTIME_DIR`.

Multi-session discovery (`COLLIE_MULTI_SESSION`) walks Herdr's config root for Herdr sockets, so it is
Herdr's own shape and is inert under any other multiplexer: a tmux collie fronts the one tmux server
its endpoint names.

**A collie pointed at another multiplexer never dials Herdr's socket.** `createMux` builds exactly the
adapter `COLLIE_MUX` names and no other, and the Herdr adapter is the only thing that dials the path
`HERDR_SOCKET_PATH` resolves to (`bridge/index.ts`). So Herdr need not be installed or running for a
tmux or zellij collie — the README's
[walkthrough](./README.md#using-the-app-on-tmux-or-zellij) starts one without it.

### What a space and a tab ARE, per multiplexer

The contract's nouns are space → tab → pane. Each adapter says which of its own levels those are, and
the answer is part of the adapter's header rather than folklore:

| Collie | Herdr | tmux | zellij |
| --- | --- | --- | --- |
| space | workspace (`w6`) | **session** (`$0`) | **the session, and there is exactly one** — a constant id, never the session's name |
| tab | tab (`t3`) | **window** (`@3`) | **tab** (`tab_3`, off zellij's stable `tab_id`) |
| pane | pane (`w6:p3`) | **pane** (`%7`) | **terminal** (`terminal_7`, carried through unchanged) |

tmux's three levels are Collie's three levels, and every id is carried through unchanged — which is
what makes them stable across a rename (a `session_id` survives what a `session_name` does not).

**zellij has the same three levels and does not get the same mapping**, and the reason is its CLI
rather than taste: every zellij verb is scoped to one session (`action --session`, and no verb lists
panes across sessions), so one adapter instance drives one session and its world has exactly one
space. That space's id is a **constant** rather than the session's name — a name is the one thing
about a session an operator could change, and identity rule 2 says an id may not move under them. The
tab id is prefixed (`tab_3`) because zellij's tab ids and pane ids are both bare integers and the two
namespaces are unrelated. One consequence to know about: zellij hands a new tab the lowest free tab
id, so tab ids **are** recycled — pane ids are not, which is where identity rule 4 actually bites.

**How many spaces a multiplexer can hold is DECLARED, not counted.** Every adapter answers `spaces`
beside its capabilities (`bridge/mux/capabilities.ts`) — zellij `"one"`, tmux and Herdr `"many"` —
and it is published in `/api/config` under `mux`. It is not a capability, because nothing degrades:
there is no verb to decline and no control to grey out. The web reads it in one place
(`useMuxHasSpaces`, `web/src/lib/mux-capability.ts`) and drops the space strip on `"one"`, leaving
the tab strip as the top level; the way BACK out of a drill-in is navigation rather than a space, so
it stays. An absent answer reads as `"many"` — the fail-open direction, where at worst a strip shows
one chip, instead of hiding a level the operator cannot then reach.

**An exited zellij session reads as UNREACHABLE, not as an empty herd.** zellij keeps a stopped
session listed as `(EXITED - attach to resurrect)`; probed, `action` against one answers
`Session 'x' not found` and exits 1, so Collie says the same: `reachable()` is false, the snapshot
throws with a message naming the session, and the operator gets the disconnected banner. Resurrecting
it re-runs the session's commands, so it stays the operator's own `attach` to make.

## Contract-owned rules

Seven things the contract owns outright, because an adapter deciding them independently is how the
seam rots.

| Rule | What the contract says | How each adapter meets it |
| --- | --- | --- |
| **Identity** ([`identity.ts`](./bridge/mux/identity.ts)) | A pane id is opaque above the adapter, stable across reconnect/restart/rename, unique within one collie, never recycled, and safe as one URL segment | Herdr `w6:p3` (**API**); tmux `%0` (**T**); zellij `terminal_<n>` (**Z**) — three shapes, all carried unchanged |
| **Keys** ([`keys.ts`](./bridge/mux/keys.ts)) | One neutral spelling: `+`-joined lower-case modifiers in canonical order `ctrl alt shift meta`, then a single character or one CapitalCase name from a **closed, complete** alphabet | Herdr's grammar is nearly it, minus `meta`→`super`/`cmd` (**API**); tmux and zellij each need a real translation table (**T**, **Z**) |
| **The grid** | Already rendered by the multiplexer, colour only. Collie runs no terminal emulator ([ADR 0008](./.adr/0008-collie-does-not-run-a-terminal-emulator.md)) — an adapter may **decline** the grid; it never gets a VT parser written for it | all three render on demand (**API**, **T**, **Z**) |
| **Refusal** | One shape, four reasons, and `unsupported` is not a failure — the UI explains it (M10/06) instead of reporting an error | every adapter returns it rather than throwing; conformance checks both directions (M10/03) |
| **Pane naming** | `paneLabel` is ONLY a name an operator gave the pane THROUGH COLLIE (`renamePane`). A title the pane's own program wrote is `terminalTitle`, never `paneLabel`. A multiplexer with one title slot cannot tell the two apart from its listing, so its adapter remembers the labels it set itself — in memory, keyed by pane id, cleared by `renamePane(null)` and when the pane leaves the listing — and reports everything else in that slot as `terminalTitle`. After a bridge restart an operator's earlier label therefore degrades to `terminalTitle`: still visible, less prominent, never a lie | Herdr has two slots and needs no memory — `label` is the operator's, `terminal_title` is the program's (**API** § Object shapes); tmux (`pane_title`, **T**) and zellij (the listing's `title`, **Z**) have one each and keep the memory described here |
| **Focus** | `MuxPane.focused` is **the pane the operator's own terminal is showing** — a fact the snapshot reports, never a pane Collie chose. Every adapter answers it on the floor; only CHANGING it is a capability (`setFocus`), and the phone changes it on one named tap and never as a side effect of navigation ([ADR 0031](./.adr/0031-freshness-is-a-declared-promise.md)). Focus is per-client everywhere, so "no client attached" is a real answer: `false` on every pane. **It is also per SPACE, and a reader must resolve the space first**: every space has an active tab with an active pane, so a server with three spaces reports three focused panes at once and only the one in the focused space (`MuxSpace.focused`) is on the operator's screen. Changing it is the same two levels — a `setFocus` that moves a pane inside a space nobody is attached to has kept the promise only for the next attach, so an adapter whose clients can sit on another space must carry them (tmux's `switch-client`, above) | Herdr reports `focused` per pane, and `session.snapshot` carries `focused_pane_id`/`focused_tab_id`/`focused_workspace_id` beside it (**API** § Object shapes) — read straight through. tmux: the active pane of the active window, which is a property of the SESSION, so every client on it sees the same pane; WHICH session is in front comes from `list-clients`, filtered by `client_control_mode` so this adapter's own watch never counts as a person (**T**, probed 2026-08-25: Collie's watcher `1`, two real terminals `0`; with none attached the old last-activity ordering still answers). zellij: `is_focused` is per-TAB (probed: two panes of one tab both report it after a split) AND'd with the tab's `active`, so a detached session — which marks no tab active — honestly reports no focused pane (**Z**, probed 2026-08-25) |
| **Transport death** | An adapter whose transport died *during* a call answers `unreachable`, never `refused`. `refused` means the multiplexer understood and said no, so retrying is pointless — a transport that went away mid-call is the opposite, and mis-reporting it puts a red per-tap error where the disconnected banner and its retry belong | a dropped socket / closed stream (**API**); tmux's `server exited unexpectedly` and `lost server` classify with "no server running" (**T**, `tmux/protocol.ts`); a dead session's verb (**Z**). Pinned per adapter — the conformance world has no perturbation for it, because killing a live transport mid-call is shaped differently in each transport and a shared knob would only model one of them |

Three traps worth naming, the first two found while writing this table:

- **Scrollback is not history.** zellij's `dump-screen --full` is untyped screen text; the journal
  reads the *agent's own log* and knows turns, tools and content ([`bridge/journal/`](./bridge/journal/)).
  If screen scrollback is ever exposed it gets its own capability name — never `agentSessionRef`.
- **The pane list is not the pane.** Collie's `AgentView` carries things only Collie knows (when you
  last looked, whether a pane is unseen). Those are the bridge's, not the multiplexer's, and
  `MuxPane` deliberately stops short of them.
- **A title outlives the program that wrote it.** tmux keeps a pane's `pane_title` after the program
  that printed it has exited (live-observed: a bare `bash` still advertising a finished agent's task).
  The adapter reports both raw facts — the title as `terminalTitle`, the foreground command as
  `foregroundCommand` — and the bridge marks the pair "a shell + a title" as a stale title
  (`bridge/state-engine.ts`), which the phone renders quietly instead of as the pane's name. Nothing
  is dropped: a title is never deleted on a guess about who wrote it.
