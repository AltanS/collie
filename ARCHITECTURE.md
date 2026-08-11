# Architecture — Collie (a Herdr web bridge over Tailscale)

> **Why Collie is shaped the way it is.** The deployment model, the interaction loop, and especially
> the security posture — the reasoning the code can't state itself. This describes what is built; a
> few deliberate *non*-decisions are called out as such, and §8 parks ideas that are not built on
> purpose. For how to run it see [`README.md`](./README.md); for repo conventions
> [`CLAUDE.md`](./CLAUDE.md); for the verified socket contract [`HERDR_API.md`](./HERDR_API.md).

## 1. The problem (real workflow, real pain)

The route Collie replaces: **Termux on Android → SSH into a tailnet machine → run the Herdr TUI.**
Three pains:

1. The on-screen **terminal keyboard is terrible** to type on.
2. **No voice control** in a terminal.
3. **Re-SSHing / re-logging-in every time** is tedious.

The goal: a **mobile web interface, reachable over Tailscale, that you don't have to keep logging
into** — so you can check on and steer your agent herd from a phone with the native keyboard and
voice, no SSH.

## 2. What Collie is

A Herdr web bridge — a long-lived local process that

- connects to Herdr's Unix-socket API (`$HERDR_SOCKET_PATH`),
- serves a **mobile-first web app**, with live state polled over HTTP (see §5),
- translates browser actions → socket methods,
- sits behind **one hardened front door** — `tailscale serve` (default; tailnet-only HTTPS +
  MagicDNS) or a conforming reverse proxy
  ([README → Variant C](./README.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale)) —
  installable as a **PWA**.

The browser never touches the socket directly; the bridge is the only thing that does.

```
   phone / laptop (PWA)
        │  HTTPS over tailnet  (https://herd.<tailnet>.ts.net)
        ▼
   tailscale serve  ── injects identity headers, terminates TLS   (Variant C: a reverse proxy instead)
        │  127.0.0.1:PORT   (bridge binds loopback ONLY)
        ▼
   Collie (this project)
     • static web app + small JSON API (browser polls /api/snapshot)
     • herdr-client adapter (the ONLY code that knows socket method names)
     • snapshot poll, event-poked (see §5)
        │  newline-delimited JSON over Unix socket
        ▼
   Herdr server (owns panes, agents, state)
```

## 3. Deployment model — **systemd user service, not a plugin pane**

This is the clearest call in the design. A plugin **pane** runs inside a terminal pane: if the pane
closes, the user detaches, or Herdr restarts, the bridge dies — exactly when you're on mobile and not
watching the TUI. A long-lived network daemon must be supervised independently.

- **The bridge runs as a `systemd --user` service** (launchd agent on macOS) — starts at login,
  restarts on failure, survives Herdr restarts.
- **The Herdr plugin stays — as a thin registration/launcher,** so the bridge shows up in
  `herdr plugin list` and Herdr conventions still apply. Its `[[actions]]` do things like
  `systemctl --user start collie` and **print the tailnet URL**; they do *not* host the server. A
  `[[build]]` step builds the web UI on `herdr plugin install` (GitHub); local `link` installs skip
  it and build lazily on first `start`. Concretely that's `[[actions]]` + `[[build]]` and nothing
  else: `[[panes]]` is what this section argues against, and `[[events]]` would duplicate the
  bridge's own `events.subscribe` stream (§5).
- **The checkout on disk *is* the plugin — in one of two shapes.** `herdr plugin install` does not
  clone: it `git init`s, `git fetch --depth 1 origin HEAD`s and `git checkout --detach FETCH_HEAD`s
  into `~/.config/herdr/plugins/github/<hashed-id>`, so a turnkey install is **detached and shallow**
  with no remote-tracking refs, while a linked clone sits on a branch. The `update` action carries
  both ([ADR 0006](./.adr/0006-update-advances-the-checkout-herdr-installed.md)) because Herdr has no
  `plugin update` of its own — its refresh is a reinstall, which replaces the checkout but does not
  restart the service.
- **Socket-path discovery:** a non-Herdr-launched daemon won't get `$HERDR_SOCKET_PATH` injected, so
  it resolves the path from a well-known location (`~/.config/herdr/herdr.sock` default, or the
  bridge's own config) and re-resolves on reconnect in case it moves.

## 4. The core interaction loop

Deliberately **not** full terminal mirroring. The loop:

```
agent goes blocked
   → PUSH notification  (which agent, which workspace — see the gap below)
   → tap → app opens to that agent
   → the pane, with recognised prompts parsed into tappable blocks
       (prompt-select · preview-select · wizard)   ← structured, not a raw screenful
   → reply:  plain text box (Android's keyboard handles voice dictation for free)
             + quick actions + a special-key strip
   → explicit Send button  → agent.send + Enter
   → "Sent ✓" + card flips blocked → working   ("did it land?" confirmation)
```

Product details that shaped the loop:

- **Don't show a raw screenful.** A "last screenful" is often a mid-stack-trace — the actual
  question is lines above. Collie parses recognised prompts out of the pane text into interactive
  blocks (`web/src/lib/blocks.ts`), so answering a permission dialog or a menu is a tap, not a
  transcription exercise. The raw pane stays below for context.
  - **Where this stops short of the design.** The original intent was for the *bridge* to capture the
    output chunk at the moment Herdr says an agent went blocked, and hand the client a structured
    `BlockingMessage`. That was never built: parsing is client-side and pattern-based, over whatever
    the current pane happens to show. It works because agent prompts are formulaic, and it degrades
    to "read the pane" when they aren't.
- **Voice needs zero special build.** It's a plain text box — Android's default keyboard provides
  dictation via its mic button. No Web Speech API, no push-to-talk, no voice-specific fallback. Send
  is a normal explicit button, so dictated text is naturally reviewable before it goes — that's just
  how the box works, not a feature to build.
- **Quick replies are heuristics, not guarantees.** Different agents expect different input (a Y/n
  prompt vs a numbered menu vs an approval phrase), so there is always a **"send exactly what I
  type"** fallback.
- **Opinionated triage.** The home screen leads with **"NEEDS YOU"** — blocked agents at top,
  working/idle collapsed below. Simultaneous blocks batch into one summary notification, not three
  races.
- **Close the trust loop.** A "Sent" state on the `POST`'s HTTP response, then the visible
  blocked→working transition. Without it, latency makes users double-tap.
- **Manage a pane in place.** Long-pressing a pane pill in the tab's pane switcher opens a small
  actions sheet — rename it (the label then leads its cards/headers) or close it. Both are the same
  `pane.rename` / `pane.close` writes the security posture already covers
  (`web/src/components/pane-actions-sheet.tsx`).

**Known gap — the notification body doesn't carry the question.** The design called for putting the
agent's question *in* the notification, so a tap is actionable even before the app loads (§7 explains
why that matters on Android). What ships identifies **which** agent needs you — title `<agent>
<verb>`, body `<workspace> · <cwd>` (`bridge/notifications.ts`) — and you read the question in the
app. Closing this needs the server-side blocking-message capture described above.

## 5. Architecture notes

- **The `herdr-client` adapter is the only module that knows socket method names** (`pane.read`,
  `agent.send`, `events.subscribe`, …). It translates to/from an internal domain model
  (`AgentStatus`, `AgentView`, `SnapshotResponse` — `bridge/types.ts`), so a Herdr API rename is a
  one-file fix, not a shatter.
- **One protocol, two dialers.** Herdr's control socket is AF_UNIX on Linux/macOS and a *named pipe*
  on Windows (named after the full socket path). `bridge/dial.ts` is the only place that knows the
  difference: `Bun.connect({unix})` on POSIX, `node:net` on Windows. The wire protocol is identical —
  the `interprocess` crate Herdr uses inserts no framing or metadata, so the same newline-delimited
  JSON-RPC speaks to both, streaming `events.subscribe` included. `COLLIE_HERDR_DIAL=net` forces the
  Windows dialer anywhere, which is how that branch stays tested off Windows.
- **Output model: poll, not stream — event-poked.** Herdr exposes `pane.read` (snapshot) and
  `pane.output_matched` (regex event) but **no raw output-stream event**, so there is nothing to
  stream even if we wanted to; the live pane view is poll-on-status-change + caching. The bridge's
  Herdr-facing poll ticks `session.snapshot` — one RPC returning every workspace/tab/pane/agent/
  layout — falling back to the `workspace.list` + `pane.list` (+ `tab.list`) trio on older servers
  (full contract in [`HERDR_API.md`](./HERDR_API.md)). A long-lived `events.subscribe` stream runs
  alongside purely to **poke** that poll: lifecycle events plus a per-agent-pane
  `pane.agent_status_changed` subscription trigger an immediate debounced re-poll, while the interval
  relaxes to `COLLIE_POLL_IDLE_MS` (12 s default) whenever the stream is healthy and drops back to
  the fast `COLLIE_POLL_MS` when it isn't. **The snapshot poll stays the source of truth throughout —
  a missed event costs one interval, never correctness.**
- **Scrollback comes from the transcript, not the terminal.** An agent's TUI runs on the *alternate
  screen* (`ESC[?1049h`), so the emulator keeps no scrollback ring and `pane.read` can never return
  more than the visible viewport — the live mirror physically cannot scroll back. Pane history is
  therefore read from the agent's **own transcript file** off disk (`bridge/journal/`,
  `/api/pane/:id/history`), a separate source from the mirror with different fidelity: turns and
  their text, not a replay of the screen. Each harness writes a different log in a different place,
  so this is a **per-agent adapter** (`bridge/journal/registry.ts` maps the pane's `agent` to one);
  a harness with no adapter simply has no journal. A harness can have **several roots** — one machine
  routinely holds more than one agent home (`CLAUDE_CONFIG_DIR` per Claude profile), so each
  `COLLIE_*_ROOT` takes a comma-separated list, searched in order until a root holds the session id;
  ids are globally unique, so that's a lookup, not a preference. Containment is checked **per root**,
  never against their union. The client fetches the whole conversation in one request
  and renders a window that grows upward, which is what lets find-in-history and jump-to-user-turn
  work across turns you haven't scrolled to. Rationale and the measured numbers are commented at the
  top of `web/src/routes/history.tsx`.
- **The browser polls too.** `useRevalidator` → `/api/snapshot` on an adaptive interval. There is no
  WebSocket fan-out to the browser and no push of state; pulling is what makes the two recovery loops
  below trivial.
- **Two independent recovery loops, designed in from the start** (not retrofitted):
  - *bridge ↔ Herdr*: the snapshot poll doubles as resync — a failed tick marks the herd
    disconnected (the UI's connection bar shows "Herdr offline") and keeps retrying; the
    `events.subscribe` stream reconnects with backoff and re-subscribes, and since it only pokes the
    poll, a dropped stream costs latency, never correctness.
  - *browser ↔ bridge*: polling makes reconnect trivial — failed polls surface in the connection bar
    / offline banner, and the next successful poll heals the UI. No socket lifecycle to manage.
- **Polling moots per-client backpressure.** A push design would need `bufferedAmount` watching so a
  slow phone couldn't OOM the bridge. Each client instead fetches a bounded snapshot at its own pace,
  so there is nothing to buffer or coalesce.
- **Render `pane.read` safely** (see §6): strip ANSI **server-side** to plain text and render it as
  React text nodes; never `innerHTML` raw terminal output.
- **PWA cache-busting.** Service workers serve stale clients after an update, so the build stamp
  travels in every response (`X-Collie-Build` header + `/api/config`); on mismatch the footer offers
  "new build — tap to update."

## 6. Security model

This socket equals **arbitrary code execution on the host** (`agent.send` / `pane.send_text` type
into live terminals). The posture is single-user, behind one hardened front door (tailnet-only by
default). These four are genuine RCE vectors and are **load-bearing — do not regress them:**

- **The bridge binds `127.0.0.1` only** and lets its single front door proxy it. Binding `0.0.0.0`
  makes the whole access check theater. But be exact about what that bind buys: it bounds **remote**
  reach, not local. Herdr's socket is a filesystem object, so its permissions bound callers to the
  owning uid; a TCP port bounds callers to the network namespace, which every uid on the host shares.
  So a process running as a *different* user — an agent you deliberately put under
  `sudo -u agent-review` to contain it — cannot open your herdr socket but **can** open
  `127.0.0.1:$COLLIE_PORT` and drive any pane in the herd. Installing Collie removes that uid
  boundary; if it is the containment you were relying on, the device gate below makes that port
  **read-only** — the one write gate that doesn't rest on "local means trusted". Note its scope: it
  gates writes and only writes, so that uid keeps reading snapshots, pane output and transcript
  history. It bounds damage, not disclosure. Closing the read side is outside what the bridge does —
  it needs the port not to be shared in the first place (its own network namespace, or a uid
  owner-match filter such as nftables `meta skuid`); a plain port firewall rule won't stop a
  same-host peer (raised in [#33](https://github.com/AltanS/collie/issues/33)).
  Under `tailscale serve`, the `Tailscale-User-Login` header is the person gate — trusted **only**
  when the request source is loopback (i.e. it came from tailscaled). `COLLIE_TRUSTED_USER` rejects a
  *mismatching* login and **passes an absent one**: it narrows which tailnet user is trusted, it does
  not mandate the header. That is safe under `tailscale serve`, which injects it on every request, and
  not safe behind anything that might stop injecting it — the header exists **only** under
  `tailscale serve` ingress. Under a reverse-proxy front door
  ([README → Variant C](./README.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale))
  there is none, and the equivalent write gate is **per-device auth** (`COLLIE_DEVICE_HEADER`) with
  the proxy contract (README Variant B/C requirements) as the load-bearing piece. That gate **fails
  closed since 0.15.0**: with `COLLIE_DEVICE_HEADER` set, a request arriving without the header is
  read-only, so reaching the port is no longer sufficient to write. Device ids are names your proxy
  asserts, not secrets — treat them as guessable and keep the front door and its ACL as the real
  containment.
- **`pane.read` output renders safely** — it's attacker-influenceable (filenames, agent output,
  fetched web content). Never `innerHTML`; it renders as React text nodes under a **strict CSP**
  (`default-src 'self'`), so an escaping miss can't run injected script that calls back into the
  socket.
- **A same-origin gate on every API request** — accepted only when the browser's `Origin` host equals
  the `Host` header the bridge receives (loopback always allowed), so a page on any other tailnet
  device can't CSRF the bridge. With a plain `tailscale serve` on the MagicDNS name these match
  automatically (no config). When Collie is fronted by a *different* public hostname or an extra
  reverse proxy / TLS terminator (custom domain, load balancer, Headscale + upstream TLS, or a
  reverse-proxy front door — [README → Variant C](./README.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale)),
  the public origin no longer matches the forwarded `Host` — list that exact origin in
  `COLLIE_ALLOWED_ORIGINS` (the only sanctioned way to widen the gate; never bind off-loopback to
  "fix" it).
Also shipped, as defence in depth:

- **Audit log** — every write-level action appends a JSONL line (timestamp, method, truncated params)
  to `<stateDir>/audit.log`, mode 0600 since it may echo reply text. An audit failure never fails the
  user's action (`bridge/audit.ts`).
- **Destructive-action confirm** — a browser-side prompt when input pattern-matches `rm`, `sudo`,
  `git push --force`, `dd`, etc. (`web/src/lib/destructive.ts`). Prevents catastrophic mistaps.

Considered, not built:

- **Tailscale ACL scoping** to your specific devices (`src: tag:my-phone → dst: this:bridge`).
  Promote this to mandatory the moment the tailnet has any device you don't fully control.
- **A short PIN** gating reconnection — friction against a grabbed phone. This, not the idle lock, is
  where that friction would have to live: the lock is a pause on an unattended screen and deliberately
  gates nothing ([ADR 0007](./.adr/0007-the-idle-lock-is-a-pause-not-a-gate.md)).

Full passthrough (no command allow-list) is acceptable for a personal tool — an allow-list would
defeat the purpose. **Never use `tailscale funnel`** (public exposure).

## 7. Tailscale & PWA

- `tailscale serve` → tailnet-only HTTPS on a stable MagicDNS hostname; the node cert doesn't rotate,
  so the PWA stays signed in. No credential management, no login screen.
- Install as a PWA (Add to Home Screen) → app icon, instant open, persistent.
- Known failure mode (accept, don't engineer around): if `tailscaled` is down, the bridge is reachable
  on localhost but not via MagicDNS. On **Android specifically**, the OS backgrounds Tailscale
  aggressively — a notification tap may hit the app before the tunnel is up, and you wait. The
  intended mitigation (the agent's question in the notification body, so the tap is at least
  informative) is the gap noted at the end of §4.

## 8. Future ideas

Not planned, not scheduled — a parking lot for ideas surfaced while reading Herdr's socket surface,
so they don't get re-discovered from scratch or acted on by accident.

- **`herdr terminal session observe` / `control` (new in 0.7.2).** A CLI subcommand pair that streams
  a pane as NDJSON live ANSI frames — `observe` is read-only; `control` additionally accepts stdin
  commands (`terminal.input`, `terminal.resize`, `terminal.scroll`, `terminal.release`) with
  one-controller-at-a-time semantics (`--takeover` to steal control). Consuming either would mean
  running a terminal emulator, and **Collie doesn't** — the emulation already happened one process
  upstream, so `pane.read` hands us a rendered grid rather than a byte stream. Latency is a transport
  question and cursor position is an upstream ask; `control` would resize the *shared* PTY and fight
  the desktop. The full argument, the costs the proposal hides, and the narrow shape that would be
  admissible if this is ever revisited:
  [ADR 0008](./.adr/0008-collie-does-not-run-a-terminal-emulator.md).
