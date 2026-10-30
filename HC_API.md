# herdr-core socket API: empirically verified (hc 0.1.14, protocol generation 1)

Probed on 2026-10-29 for the `herdr-core` mux adapter (`bridge/mux/herdr-core/`, milestone M74).
This file is to that adapter what [`HERDR_API.md`](./HERDR_API.md) is to the `herdr` adapter: the
facts the code leans on, each with a real request and a trimmed real answer.

**herdr-core is not herdr.** `herdr` is the terminal multiplexer (the TUI, `herdr.sock`, 0.9.x).
`herdr-core` (CLI `hc`) is a terminal runtime: it keeps terminals alive and knows nothing about
panes, tabs or spaces. herdr-app (the window, 0.1.x) draws spaces and tabs on top of it and keeps
them in a core document. The two Herdr products run side by side on one host and never share a
socket.

Two sessions were used, and only one of them was written to:

- **`default`**, the live core: one terminal `t1`, Altan's Claude Code session inside herdr-app.
  READ ONLY: `hello`, `server.status`, `terminal.list`, `terminal.get`, `terminal.read`,
  `events.subscribe`, `doc.get`, `templates.list`. Nothing was typed, run, killed or labelled.
- **`collie-lab`**, a private core started with `HC_SESSION=collie-lab hc server start` and scratch
  `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME`. Every write below ran
  there, in terminals whose cwd is under `~/.cache/collie-lab/`. Starting it left `default` alone
  (same pid and uptime before and after).

Other sources: `hc --skill`, `hc schema --json` (OpenRPC, the same document as `rpc.discover`), the
herdr-core repository's `schema/README.md` (framed mode, events, documents) and `docs/security.md`
(socket paths), and `~/.config/herdr-app/AGENTS.md` (spaces, tabs, labels). The API status is
"preview (protocol generation 1, version 0.x)"; the repository promises that the API only grows and
that a break needs a new generation.

## Transport

- **Socket path.** `HC_SOCKET` if set. Otherwise `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`,
  where the session is `HC_SESSION` or `default`. Without `XDG_RUNTIME_DIR` the core uses
  `/run/user/<uid>/herdr-core/` when that directory exists, then the session's state directory,
  `${XDG_STATE_HOME:-~/.local/state}/herdr-core/<session>/<session>.sock` (macOS).
  A `socket` setting in `~/.config/herdr-core/config.toml` can also move it (not read by Collie).
  Holder sockets sit beside the client socket as `<session>.holder.<id>.sock`; they are not for
  clients.

  ```
  $ ls $XDG_RUNTIME_DIR/herdr-core/
  collie-lab.sock  default.holder.f716496c.sock  default.sock
  ```

- **`HERDR_SOCKET_PATH` is the TUI's**, never the core's. The adapter ignores it.
- **Plain mode**: JSON-RPC 2.0, one message per line, many requests per connection. `hello` is not
  required in plain mode: `server.status` as the first line on a fresh connection answered normally.
  Unknown params are ignored (`terminal.list {"bogus":1}` answered the list).
- **`hello`** pins the generation. Asking for another one is refused:

  ```
  → {"jsonrpc":"2.0","id":1,"method":"hello","params":{"generation":1}}
  ← {"id":1,"jsonrpc":"2.0","result":{"core":{"id":"bb92…","name":"bluefin"},
      "features":["framed","attach","events","status","shell"],"framed":false,"generation":1,
      "methods":["hello","server.status",…,"rpc.discover"],"version":"0.1.14"}}

  → {"jsonrpc":"2.0","id":2,"method":"hello","params":{"generation":2}}
  ← {"error":{"code":-32000,"data":{"hint":"this core speaks generation 1",
      "kind":"unsupported_generation"},"message":"protocol generation 2 not supported"},"id":2,…}
  ```

- **Framed mode**: `hello {"framed": true}` switches the connection after its reply. Every frame is
  `[channel u32 LE][kind u8][len u32 LE][payload]`. Kinds: 0 DATA, 1 CREDIT, 2 CLOSE, 3 RESIZE,
  4 FOCUS, 5 FACTS. Channel 0 carries JSON-RPC messages (one per DATA frame) both ways. Only
  `terminal.attach` needs framed mode.
- **Errors** carry a stable `data.kind` and a `hint`:

  ```
  {"error":{"code":-32000,"data":{"hint":"see `hc ls --all`","kind":"not_found"},
    "message":"no terminal \"t99\""},"id":3,"jsonrpc":"2.0"}
  {"error":{"code":-32000,"data":{"hint":"no machines yet: hc machine add <ssh-target>",
    "kind":"machine_unknown"},"message":"unknown machine \"box\""},"id":4,…}
  {"error":{"code":-32601,"data":{"hint":"see `hc schema`","kind":"unknown_method"},…}
  {"error":{"code":-32602,"data":{"hint":"see `hc schema`","kind":"invalid_params"},
    "message":"unknown key \" \" (try enter, esc, up, ctrl+c, alt+x, f5, a)"},…}
  ```

  Kinds seen in the schema: `not_found`, `machine_unknown`, `finished`, `unavailable` (a kept
  terminal waiting for its new shell), `blocked` (`send` to a blocked program), `invalid_params`,
  `name_taken`, `spawn_failed`, `invalid_template`, `conflict` (`doc.set`), `needs_update`,
  `unsupported_generation`, `unknown_method`.

## The terminal record

`terminal.list` on `default` (trimmed; the only terminal):

```json
{"hidden_finished":0,"terminals":[{
  "address":"t1","argv":["/bin/bash"],"cols":70,"rows":30,"cwd":"~",
  "foreground":{"argv":["claude","--dangerously-skip-permissions"],"cwd":"~/projects/collie-workspace","name":"claude","pid":60190},
  "identity":"ghostty","keep":true,
  "labels":{"herdr.space":"sp64f7…5658","herdr.tab":"tbf773…fb10","where":"collie-workspace / 1"},
  "name":null,"notify":true,"parent":null,"pid":53909,"reason":null,"reported":true,
  "screen":"exact","state":"live",
  "status":{"app":"claude-code","state":"idle"},"status_ms":1793308532159,
  "title":"inside-herdr-app","turn":1}]}
```

What each field means for Collie:

| Field | Meaning |
|---|---|
| `address` | `t7`: this terminal forever on this core, never reused. A terminal on an added machine is `machine/t7` (`box/t3` in the docs). The adapter drops every address with a `/` (ADR 0036). |
| `name` | A name given at start (`hc run --name review`), unique among live terminals. No method renames it. |
| `labels` | Free-form `key=value`, never interpreted by the core. herdr-app sets `herdr.space`, `herdr.tab` and `where`. |
| `state` | `live` or `finished`. `terminal.list` lists live ones unless `all: true`. |
| `screen` | `exact`, or `inexact` after a core crash (older history may be missing). NOT the screen text. |
| `status` | The program's own OSC 7501 report, or null. See *Status*. |
| `turn` | Goes up each time the status leaves `working`. |
| `title` | The OSC title the program set. |
| `foreground` | The foreground process group's leader: `{pid, name, argv, cwd}`, read about twice a second. A process name, not an agent identity. The adapter takes an agent from it only when the program sends no report (omp 18.6.1 sends none), through the same table as a report, with no status. |
| `cols`, `rows` | The terminal size. The last ACTIVE attached viewer sets it. |
| `keep` | Replace a lost program with a shell in place. herdr-app sets it on the terminals it shows. |
| `parent`, `notify` | The terminal that started it, and whether that parent gets notes typed into it. |

There is no focus field and no content revision on a terminal.

## `terminal.read`: the screen as plain text

```
→ terminal.read {"terminal":"t1","lines":0}          (default, read only)
← {"complete":true,"how":"screen","text":"\n ▐▛███▛█   Claude Code v2.1.312\n▝▜██████▀  Opus 5.5 …\n
   …\n❯ /rename inside-herdr-app\n  ⎿  Session renamed to: inside-herdr-app\n…\n❯ \n
   ──────…\n  [Opus·high] ~/projects/collie-workspace on main*\n  ⏵⏵ bypass permissions on …"}
```

- `text` is the rendered screen, one line per row, `rows` lines (30 here, 120 for a lab terminal
  started over the API), no wider than `cols`. Trailing blank rows are kept.
- **No colour.** No escape byte at all, also after `printf "\033[31mRED\033[0m"` in the lab. The
  core renders with an emulator (it vendors ghostty's) but the API hands out text only.
- `lines: N` adds up to N history lines above the screen. `how` is `screen` (no history asked),
  `history` (lab: `lines: 500` after `seq 1 150` gave 183 lines), or `stitched` (a full-screen app,
  read by scrolling it; `default` t1 answered `stitched` for `lines: 50`). `complete: false` means
  part may be missing, with `why: "working"` when a full-screen app is not scrolled while it works.
- Collie hands a `complete: false` read to the mirror with its rows, marked `partial` (`MuxGrid.partial`),
  and the Send Protocol takes such a read as no read: it types nothing and presses nothing on a screen
  that may lack rows. Only a stitched read (`lines` above 0) was seen incomplete; the viewport read the
  protocol uses (`lines: 0`) was always complete.
- No history depth is reported anywhere, so how far a read can reach is unknown in advance.

## Typing: `send`, `put`, `keys` and raw input

Collie's Send Protocol types the text first, checks the screen, and only then presses Enter as its
own key. The core has three write methods and none of them is "type this text, press nothing":

| Method | What it does | Fit |
|---|---|---|
| `terminal.send {terminal, text}` | Pastes the text and presses Enter, once nobody has typed for about 3 s. Refuses a `blocked` program unless `force`. | No: it submits. |
| `terminal.put {terminal, name, data}` | Writes a file (base64, at most 8 MB) beside the terminal and prints where it landed. Types nothing. | No: it is a file drop (an image paste), not typing. |
| `terminal.keys {terminal, keys[]}` | Presses named keys, encoded for the program's current keyboard modes. | For keys, yes. For text, no: see the refusals below. |

`terminal.keys` takes key NAMES. Probed in the lab against a raw-mode sink
(`stty raw -echo; cat > /dev/null`) so no key could end it:

- Accepted: `up down left right tab enter esc escape space backspace delete insert home end pageup
  pagedown f1`…`f12`, every letter and digit, upper case letters, the unshifted punctuation
  `` ' , - . / ; = [ \ ] ` ``, and chords such as `ctrl+c`, `ctrl+u`, `ctrl+a`, `alt+b`, `shift+up`,
  `ctrl+shift+up`, `shift+tab`, `ctrl+alt+delete`, `ctrl+enter`, `shift+enter`, `alt+,`,
  `super+a`, `meta+a`, `cmd+a`. Names are case-insensitive (`Enter` works).
- Refused with `invalid_params` "unknown key": a literal space `" "`, `ä`, a whole word (`hello`),
  `page_up`, the shifted punctuation `` ! " # $ % & ( ) * + : < > ? @ ^ _ { | } ~ ``, `ctrl+[`,
  `ctrl+-`, `ctrl++`, `ctrl+!`, `alt+$`.
- Answer: `{"status":null,"turn":0}` (the status word when the keys went in, and the turn).
- Accepting `ctrl+enter` or `super+a` does not prove the program receives them as themselves; that
  depends on the program's keyboard mode, and was not probed.

**Raw text goes through a framed attach.** `terminal.attach` opens a raw stream on a framed
connection; DATA frames on its channel are input bytes, written as they are:

```
→ hello {"generation":1,"framed":true}                       (plain line; the reply is a plain line)
→ [ch 0][DATA] terminal.get {"terminal":"t1"}                 → cols 200, rows 120
→ [ch 0][DATA] terminal.attach {"terminal":"t1","cols":200,"rows":120}
← [ch 0][DATA] {"id":3,"result":{"channel":1,"terminal":{…}}}  then the first paint on channel 1
→ [ch 1][DATA] echo "typed $HOME ä raw"
→ [ch 1][CLOSE]
← [ch 1][CLOSE] (empty)
```

The line sat on the prompt with nothing submitted (`❯ echo "typed $HOME ä raw"`), the size stayed
200 x 120, and `terminal.keys {"keys":["enter"]}` then ran it (50 ms round trip, no quiet wait):
`typed /var/home/<user> ä raw`. `abc` followed by `keys ["backspace","backspace"]` left `a`.

**The key hold.** A `terminal.keys` call that follows a raw write is answered late. Measured on
2026-10-30 in a private `collie-lab` session on bluefin (hc 0.1.14, a raw-mode sink): a raw write
took 0.9 ms, a read 0.3 ms, a key press alone 33 ms, but a key press after a raw write was answered
about 3,030 ms after that write, whatever the gap between the two (gap 0: 3,033 ms; gap 2,500 ms:
531 ms; gap 3,500 ms: 32 ms). So the first key after typed text waits out the rest of about 3 s.
`terminal.send` quotes the same figure ("once nobody has typed for about 3 s", table above). Whether
the key reaches the program when the call starts or when it is answered was not probed. The 50 ms
round trip quoted above was a key pressed well after the write. This is the core's own behaviour and
an upstream ask; Collie's Send Protocol keeps the two writes of its probe outside its read bound.

The size rule is why the attach names the terminal's OWN size: "the last active viewer sets the
size (active: it typed, resized, gained focus or sent FACTS)". Typing makes the attach active, so
an attach at any other size would resize the terminal under herdr-app. A race with a resize between
the `get` and the attach is possible and was not observed.

## `terminal.run`, `terminal.kill`

```
→ terminal.run {"cwd":"~/.cache/collie-lab/hc-lab","labels":{"herdr.space":"splab0001",
                "herdr.tab":"tblab0001"},"no_parent":true,"no_notify":true}
← {"address":"t4","labels":{"herdr.space":"splab0001","herdr.tab":"tblab0001"},"keep":false,
   "parent":null,"notify":false,"cols":200,"rows":120,"state":"live",…}
```

- No `argv` and no `line`: the machine's own shell. `cwd` defaults to the core's own.
- Started from inside an hc terminal, a new terminal becomes that terminal's child and the parent
  gets notes typed into it. `no_parent: true` and `no_notify: true` avoid both; the adapter sends
  both.
- herdr-app adopts a terminal that carries `herdr.space` and `herdr.tab`; "an id Herdr doesn't know
  becomes a new space or tab" (AGENTS.md). That adoption is herdr-app's and was not probed here.

```
→ terminal.kill {"terminal":"rawsink"}
← {"address":"t3","state":"finished","reason":"killed","exit_code":null,"signal":1,…}
```

Kill on a terminal that already finished answers the record again, with no error. A killed or
exited terminal stays as a `finished` record until `terminal.rm`; `terminal.list` hides it.

## Status (OSC 7501)

A program reports its status with OSC 7501; the core stores it and never guesses from the screen.
The lab shell sent `printf '\033]7501;state=blocked:app=claude-code:kind=permission\a'`:

```
terminal.get → "status":{"app":"claude-code","kind":"permission","state":"blocked"},
               "reported":true,"records":{}
event        → {"type":"status","terminal":"t1","seq":13,
                "data":{"records":{},"reported":true,"status":{"app":"claude-code","kind":"permission","state":"blocked"}}}
```

- `state`: `idle`, `working`, `done`, `blocked`, `error` (the binary advertises exactly these in
  its 7501 query answer, `?:states=idle,working,done,blocked,error:kinds=permission,question,auth`).
- `app`: the program's own word. Claude Code reports `claude-code`. Nothing is translated.
- `kind`: `permission`, `question` or `auth`, on `blocked` only. `msg`, `title`, `progress`
  (0 to 100) are optional.
- `records`: further 7501 records by id, for a program that reports on several things.
- `turn` goes up each time the status leaves `working`; a `turn` event carries `{turn, state}`.
- A program that never reports has `status: null`, `reported: false`.

## `events.subscribe`

```
→ events.subscribe {}
← {"result":{"channel":null,"seq":0,"terminals":[ …every matching terminal, full records… ]}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":2,"terminal":"t1","type":"foreground",
     "data":{"argv":["/bin/bash"],"cwd":"~/.cache/collie-lab/hc-lab","name":"bash","pid":700085}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":3,"terminal":"t1","type":"title",
     "data":{"title":"altan@bluefin:~/.cache/collie-lab/hc-lab"}}}
← {"jsonrpc":"2.0","method":"heartbeat","params":{"seq":5}}          (15 s apart, when idle)
← {"jsonrpc":"2.0","method":"event","params":{"seq":10,"terminal":"t2","type":"finished",
     "data":{"exit_code":null,"finished_ms":1793310013161,"reason":"exited","signal":2}}}
```

- In plain mode the connection carries only notifications after the reply.
- Types (docs): `created` (whole record), `lost`, `restarted` (whole record), `keep`, `finished`,
  `removed`, `status`, `turn`, `title`, `labels`, `size`, `foreground`, and `doc` (no `terminal`;
  `{name, version}`, unfiltered subscribers only). Seen in the lab: `created`, `foreground`,
  `title`, `status`, `finished`, `heartbeat`.
- **No event for screen content.** Output that changes no title, status or foreground is silent.
- `missed` (docs, not provoked): `{"method":"missed","params":{"seq":57,"terminals":[…]}}` for a
  subscriber that fell behind. Drop events whose `seq` is not above it, and re-read documents.
- `seq` rises by one per event and restarts with each core process. A heartbeat carries the
  current `seq`. On `default` a subscriber with no traffic got `{"method":"heartbeat",
  "params":{"seq":0}}` after 15 s.
- Events about terminals on added machines arrive in the same stream as `machine/t7`, and a
  machine's reconnect is reported locally as `missed`.

## Documents: `doc.get` and the `herdr-app` layout

```
→ doc.get {"name":"herdr-app"}                                   (default, read only)
← {"version":1,"value":{"spaces":[{"id":"sp64f7…5658","name":"","folder":"~",
     "tabs":[{"id":"tbf773…fb10","name":"",
       "root":{"type":"row","id":"tbf773…fb10","children":[
         {"type":"block","id":"pa0372…e55","content":{"terminal":"t1"}}]}}]}]}}
```

- One document per machine, written by herdr-app, opaque to the core. `version` is 0 and `value`
  null when never written.
- A space: `id` (`sp` and 32 hex), `name` (empty when herdr-app derives it), `folder` (where it was
  made), `tabs`. A tab: `id` (`tb` and 32 hex), `name` (empty when it is called by its place, 1, 2,
  ...), `root` (the split tree; a leaf block names a terminal or a mod).
- herdr-app's own rule for an unnamed space: "called after where its first terminal is now (its
  repo, else its folder, `~` at home)". It also writes that display name into each terminal's
  `where` label as `<space> / <tab>`: `collie-workspace / 1` above, while the document's `name`
  is empty and its `folder` is `~`.
- Focus, zoom and settled tabs are per screen, in herdr-app's own `view.json`. They are not in the
  core and not in the document.
- `doc.set` writes only if the version still matches (`conflict` otherwise). herdr-app says to
  change structure through its commands, so Collie never writes this document.

## `server.status`, `templates.list`

```
→ server.status {}            (default)
← {"core":{"id":"bb92…","name":"bluefin"},"version":"0.1.14","pid":100646,"uptime_ms":1129419,
   "live":1,"finished":0,"holder":{"current":true,"pid":53903,"terminals":1,…},"holders":[…],
   "installed_by":null}
→ templates.list {}           (default)
← {"templates":[]}
```

## The terminal's own environment

The core puts the terminal's address into the environment of every process in it. Probed on
2026-10-29 in the private `collie-lab` session (`hc send` of `env | grep -i ^HC` into a terminal that
`hc run --bg` had started), and again in a second session on a custom `HC_SOCKET`:

```
HC_TERMINAL_ID=t1                                           the address, as terminal.list gives it
HC_TERMINAL_SOCKET=/run/user/1000/herdr-core/collie-lab.sock   the client socket of the core that owns it
HC_SESSION=collie-lab                                       only when the core was started with it
HC_SOCKET=/…/sockdir/alt.sock                               only when the core was started with it
HC_SCOPE=149630853-9e24dfaafae6250d2164f4f959c07c58         opaque; changes with each core process
```

- `HC_TERMINAL_ID` is the pane id the adapter uses, unchanged, and `hc --skill` documents it as "your
  address". Addresses restart at `t1` in every core session, so the id alone is not an identity.
- `HC_TERMINAL_SOCKET` is the core's own client socket, and it stayed the core's path when the core
  ran on a custom `HC_SOCKET` (session `collie-lab-b`, socket `sockdir/alt.sock`, the variable held
  that path). It is the scope that joins an address to one core.
- Collie's beacon emitter reads `HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET` as the `herdr-core`
  marker (`cli/beacon.ts`), so a Claude hook edge and the agent's session id reach the right pane.
  Collie's own check: a shell in a lab terminal reported `claude-code` through OSC 7501, then ran
  `collie beacon emit` with a fake `SessionStart` payload (`session_id` `lab-session-0001`). The
  scratch bridge then listed the terminal as `agent: claude`, `status: idle` (the core's report, not
  the beacon's) and `hasSession: true`.
- A core started from a shell that sits inside the Herdr TUI hands its terminals that TUI's
  `HERDR_PANE_ID`, `HERDR_SOCKET_PATH` and friends as well (the lab core did). The beacon then
  carries both a `herdr` and a `herdr-core` marker. Each names only its own adapter's pane.
- A program that clears its environment does not carry them. A terminal on an added machine is
  `box/t7` to this core and (by the docs, not probed) plain `t7` on its own, so only the owning
  machine's Collie matches it; the adapter drops `box/t7` anyway.

## What does not fit Collie's mux port

Collie's mux port was built for a multiplexer that hands out a coloured screen and a revision. The
core does not, and M78 (2026-10-30, hc 0.1.14) ran the readers, the sends and the browser leg against
it. This section has two parts: what Collie now handles itself, and what stays an upstream ask.

### What Collie handles now

- **No colour.** `paneGrid` is plain text. The Surface falls back to text shapes where a reader keyed
  on SGR: the placeholder of an empty box (Claude, Codex, Hermes, Muse), and Claude's prompt
  suggestion, which a probe tells from a typed draft (the probe lands at the start of the box for a
  suggestion, after the text for a draft). pi's question is found by the footer's words and the
  numbered rows. Claude's permission title is found without the bold header. Where a colour-only
  fact has no text twin (see the asks below), the dialog reads as unreadable and the card offers
  Escape alone.
- **`complete: false`.** The read reaches the mirror with its rows, marked `partial`, and the Send
  Protocol takes it as no read.
- **The key hold.** The probe and the landing check of the Send Protocol wait out the core's 3 s after
  a raw write, so a send takes about 6 s on the core instead of a fraction of one. Nothing is mis-sent.
- **Upper case keys.** The core reads key names without regard to case, so `G` arrived as `g`. Collie
  sends `shift+g`.
- **No agent name without a report.** A program that sends no OSC 7501 report (omp 18.6.1) has
  `status: null`. The adapter names its agent from `foreground.name` through the table a report uses,
  and the pane has no status until the program reports.
- **No session id.** The core keeps the program's status, not the agent's conversation id. Collie
  gets it from the agent's own hook through `HC_TERMINAL_ID` (see above), so a Claude pane has
  History once `collie hooks install claude` is done, and not before. pi and omp have no such hook,
  so their panes have no History and no Chat card on the core.
- **No focus, no rename, no tab or space verbs.** Focus lives in herdr-app per screen; structure
  changes go through herdr-app commands. Spec 05 of M74 plans a mod for both.

### What stays an upstream ask

Each line is a thing the core could do that would close a gap Collie cannot close alone.

- **Colour.** A `format: "ansi"` (or another styled) option on `terminal.read`. Plain text hides every
  fact that a harness paints and does not write: about 100 dialog readings on pi, opencode and omp
  (the pointer row, the stepper chip, the selected tab) are colour only, so a dialog of those three
  whose pointer is colour only cannot be answered from the phone. Claude, Codex and the placeholders
  have a text twin and are done.
- **A history read that answers, and keys that do not wait for it.** `terminal.read` with `lines`
  above 0 did not answer in 30 s on a pi that showed a permission or question dialog, while the
  viewport read (`lines: 0`) answered in 0.1 s. Waited out, one such read took 25.03 s and answered
  `{"complete": false, "how": "screen"}` (M78 report 10, case 2, hc 0.1.14). The core runs one
  terminal's history reads and key presses one at a time: three history reads fired together ended at
  +25, +50 and +75 s, and a `terminal.keys` sent 2 s into a history read answered after 23.1 s, 100 ms
  after the read ended. A read the client gave up on still runs to its end. Another terminal in the
  same core answered keys and history reads in 0.1 s, so the hold is per terminal. The effect: a key
  call timed out at the client's 5 s and still reached pi later, and with a phone polling the pane
  every 1.5 s the terminal's keys stayed held for over nine minutes. Collie now keeps at most one
  history read per terminal on the core, starts none while the program reports `blocked` or while
  Collie reads an ask on the screen, backs off on time alone after a slow one (30 s from the end of
  that read, doubling for each further slow read in a row up to 5 minutes, back to 30 s after a fast
  one), and reports a key call that timed out as not confirmed instead of failed. A screen that
  redraws every frame makes any "retry when the screen changes" rule useless: pi's dialog redraws its
  spinner and cursor on every read, and Collie's first backoff, which ended on a screen change,
  still started ten 25 s history reads back to back under one dialog. So Collie backs off on time
  alone. The asks: a history read must not wait 25 s on a program that shows a dialog;
  `terminal.keys` must not wait behind pending reads on the same terminal; and a read whose client
  gave up (closed the connection) should be cancelled on the core.
- **`blocked` for pi's question.** The core's status stays `working` while pi waits on its question,
  because pi reports no blocked state for an extension's question. Collie marks the pane "needs you"
  from the screen. The ask: pi reports it, or the core says so.
- **A raw-text method.** Typing without Enter needs a framed attach and its size rule. A plain
  `terminal.type {terminal, text}` would remove the attach.
- **A revision.** The adapter derives one from the text it reads. A revision on the terminal record
  would make that exact and cheap.
- **A size that stays.** When the last viewer detaches, the core sets a terminal back to 200 x 120.
  Collie then reads an unviewed terminal at 200 columns, and herdr-app on a phone makes a narrow
  Claude. The ask: keep the size the last viewer set, or take it as a setting of the terminal.
- **A program that reports.** omp 18.6.1 sends no OSC 7501 report, so its pane has no status. The ask
  is for omp (or a hook of omp's own); the foreground-name table stands in until then.
- **No history depth.** `readableLines` cannot be stated, because no read says how far it can reach.
