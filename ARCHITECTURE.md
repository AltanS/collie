# Architecture — Collie (a Herdr web bridge over Tailscale)

> **Design rationale**, captured before the build and kept for the "why" behind Collie's shape —
> the deployment model, the interaction loop, and especially the security posture. A few passages
> still speak in the original "P0/P1" planning tense; treat those as historical. **Most notably the
> live-state transport: this doc sketches a WebSocket fan-out, but the build instead polls over
> HTTP (`useRevalidator` → `/api/snapshot`) — see §5, "Output model: poll, not stream." Read the
> WS/WSS passages below as the original design, not what shipped.** For the operational truth see
> [`README.md`](./README.md), [`CLAUDE.md`](./CLAUDE.md), and the verified socket API in
> [`HERDR_API.md`](./HERDR_API.md).

## 1. The problem (real workflow, real pain)

Today: **Termux on Android → SSH into a tailnet machine → run the Herdr TUI.** Three pains:

1. The on-screen **terminal keyboard is terrible** to type on.
2. **No voice control** in a terminal.
3. **Re-SSHing / re-logging-in every time** is tedious.

Goal: a **mobile web interface, reachable over Tailscale, that you don't have to keep logging
into** — so you can check on and steer your agent herd from a phone with the native keyboard
and voice, no SSH.

## 2. What we're building

**Collie** — a Herdr web bridge: a long-lived local process that

- connects to Herdr's Unix-socket API (`$HERDR_SOCKET_PATH`),
- serves a **mobile-first web app** (HTTP for assets; live state is polled over HTTP in the
  shipped build — the WebSocket design described here was never built, see §5),
- translates browser actions → socket methods, and fans Herdr's event stream → browsers,
- exposed **tailnet-only via `tailscale serve`** (HTTPS + MagicDNS), installable as a **PWA**.

The browser never touches the socket directly; the bridge is the only thing that does.

```
   phone / laptop (PWA)
        │  HTTPS + WSS over tailnet  (https://herd.<tailnet>.ts.net)
        ▼
   tailscale serve  ── injects identity headers, terminates TLS
        │  127.0.0.1:PORT   (bridge binds loopback ONLY)
        ▼
   Collie (this project)
     • static web app + WebSocket fan-out
     • herdr-client adapter (the ONLY code that knows socket method names)
     • reconnect/resync state machine
        │  newline-delimited JSON over Unix socket
        ▼
   Herdr server (owns panes, agents, state)
```

## 3. Deployment model — **systemd user service, not a plugin pane**

This was the clearest call in the design. A plugin **pane** runs inside a terminal pane: if the
pane closes, the user detaches, or Herdr restarts, the bridge dies — exactly when you're on mobile
and not watching the TUI. A long-lived network daemon must be supervised independently.

- **Run the bridge as a `systemd --user` service** (launchd agent on macOS) — starts at login,
  restarts on failure, survives Herdr restarts.
- **The Herdr plugin stays — as a thin registration/launcher,** so the bridge shows up in
  `herdr plugin list` and Herdr conventions still apply. Its `[[actions]]` do things like
  `systemctl --user start collie` and **print the tailnet URL**; they do *not* host the
  server. A `[[build]]` step builds the web UI on `herdr plugin install` (GitHub); local
  `link` installs skip it and build lazily on first `start`.
- **Socket-path discovery:** a non-Herdr-launched daemon won't get `$HERDR_SOCKET_PATH`
  injected. Resolve it from a well-known location (`~/.config/herdr/herdr.sock` default, or a
  small bridge config file written at install time). Re-resolve on reconnect in case it moves.

## 4. The core interaction loop

Deliberately **not** full terminal mirroring. The loop:

```
agent goes blocked
   → PUSH notification  (with the agent's question IN the notification body)
   → tap → app opens to that agent
   → "Agent is asking:" <extracted blocking message>   ← structured, not raw tail
       + scrollable context snapshot below
   → reply:  plain text box (Android's keyboard handles voice dictation for free)
             + one-tap quick replies [yes] [no] [approve] [continue] [1] [2]
   → explicit Send button  → agent.send
   → "Sent ✓" + card flips blocked → working   ("did it land?" confirmation)
```

Product details that shaped the loop:

- **Extract the blocking message, don't show a raw screenful.** A "last screenful" is often a
  mid-stack-trace — the actual question is lines above. Herdr knows the *moment* the agent went
  blocked; capture that output chunk as a structured field and surface it prominently. The raw
  snapshot stays below for context.
- **Voice needs zero special build.** It's a plain text box — Android's default keyboard provides
  dictation via its mic button. No Web Speech API, no push-to-talk, no voice-specific fallback.
  Send is a normal explicit button (standard text-box UX), so dictated text is naturally
  reviewable before it goes — that's just how the box works, not a feature to build.
- **Quick replies are heuristics, not guarantees.** Different agents expect different input
  (a Y/n prompt vs a numbered menu vs an approval phrase). Provide agent-type-aware mappings
  where known, and always a **"send exactly what I type"** fallback.
- **Opinionated triage.** The home screen leads with **"NEEDS YOU (n)"** — blocked agents at
  top with a one-line excerpt each; working/idle agents collapsed below. Batch simultaneous
  blocks into one summary notification, not three races.
- **Close the trust loop.** Show a "Sent" state + timestamp on WS ack, then the visible
  blocked→working transition. Without it, latency makes users double-tap.

## 5. Architecture notes

- **`herdr-client` adapter is the only module that knows socket method names** (`pane.read`,
  `agent.send`, `events.subscribe`, …). It translates to/from an internal domain model
  (`AgentStatus`, `PaneSnapshot`, `BlockingMessage`). Everything else talks to the adapter, so
  a Herdr API rename is a one-file fix, not a shatter.
- **Two independent reconnect loops, designed in from the start** (not retrofitted):
  - *bridge ↔ Herdr*: on disconnect → backoff reconnect → re-`events.subscribe` → full resync
    (`workspace.list` + `pane.read` per pane) → push a fresh snapshot before resuming the stream.
  - *browser ↔ bridge*: client reconnect with a `bridge_status` banner (`connected` /
    `reconnecting` / `failed`) so the UI is never silently stale.
- **Per-client WebSocket backpressure.** Mobile-over-cellular is slow; the local event stream is
  fast. Watch `bufferedAmount`; above a threshold, coalesce/drop non-critical events and signal
  the client to re-fetch — otherwise a flaky phone OOMs the bridge.
- **Render `pane.read` safely** (see Security): strip ANSI **server-side** to plain text and render
  it as React text nodes; never `innerHTML` raw terminal output.
- **PWA cache-busting.** Service workers serve stale clients after an update. Put a bridge
  version in the WS handshake; on mismatch, prompt "Update available — tap to reload."
- **Output model: poll, not stream — now event-poked.** Herdr exposes `pane.read` (snapshot) and
  `pane.output_matched` (regex event) but no raw output-stream event, so the live pane view is
  still poll-on-status-change + caching, not streaming. What changed is the bridge's own
  Herdr-facing poll (full contract in `HERDR_API.md`): it ticks `session.snapshot` — one RPC
  returning every workspace/tab/pane/agent/layout — falling back to the `workspace.list` +
  `pane.list` (+ `tab.list`) trio on older servers. A long-lived `events.subscribe` stream runs
  alongside purely to **poke** that poll: lifecycle events plus a per-agent-pane
  `pane.agent_status_changed` subscription trigger an immediate debounced re-poll, while the
  interval itself relaxes to `COLLIE_POLL_IDLE_MS` (12 s default) whenever the stream is healthy
  and drops back to the fast `COLLIE_POLL_MS` when it isn't. The snapshot poll stays the source of
  truth throughout — a missed event costs one interval, never correctness.

## 6. Security model

This socket equals **arbitrary code execution on the host** (`agent.send` / `pane.send_text`
type into live terminals). The posture is single-user + tailnet-only, but three items are
genuine RCE vectors and are **MUST-DO before first use**:

**MUST-DO**
- **Bind the bridge to `127.0.0.1` only** and let `tailscale serve` proxy it. Binding `0.0.0.0`
  makes the whole identity check theater. Trust Tailscale identity headers
  (`Tailscale-User-Login`) **only** when the request source is loopback (i.e. came from
  tailscaled). Assert the **specific owner login**, reject any other tailnet user.
- **Render `pane.read` output safely** — it's attacker-influenceable (filenames, agent output,
  fetched web content). Never `innerHTML` raw; render as React text nodes with a
  **strict CSP** (`default-src 'self'`) so an escaping miss can't run injected script that calls
  back into the socket.
- **Same-origin gate on every API request** — accept only when the browser's `Origin` host equals
  the `Host` header the bridge receives (loopback is always allowed); reject otherwise, so a page on
  any other tailnet device can't CSRF the bridge. With a plain `tailscale serve` on the MagicDNS name
  these match automatically (no config). When Collie is fronted by a *different* public hostname or an
  extra reverse proxy / TLS terminator (custom domain, load balancer, Headscale + upstream TLS), the
  public origin no longer matches the forwarded `Host` — list that exact origin in
  `COLLIE_ALLOWED_ORIGINS` (the only sanctioned way to widen the gate; never bind off-loopback to
  "fix" it).
- **Idle timeout / re-auth.** Tailscale identity proves the *device*, not *who's holding it*. The
  PWA stays "signed in" with no session, so a stolen unlocked phone is a root shell. Add a
  configurable idle timeout (30–60 min) requiring re-confirmation before the WS reconnects.

**NICE-TO-HAVE (cheap, add incrementally)**
- **Tailscale ACL scoping** to your specific devices (`src: tag:my-phone → dst: this:bridge`).
  Promote to MUST-DO the moment the tailnet has any device you don't fully control.
- **Destructive-action confirm** — a browser-side prompt when input pattern-matches `rm`,
  `sudo`, `git push --force`, `dd`, etc. Prevents catastrophic mistaps.
- **Optional short PIN** gating reconnection — friction against a grabbed phone.
- **Audit log** — append every socket call (timestamp, method, truncated params) to a local file.

Full passthrough (no command allow-list) is acceptable for a personal tool — an allow-list would
defeat the purpose. **Never use `tailscale funnel`** (public exposure).

## 7. Tailscale & PWA

- `tailscale serve` → tailnet-only HTTPS on a stable MagicDNS hostname; node cert doesn't rotate,
  so the PWA stays signed in. No credential management, no login screen.
- Install as a PWA (Add to Home Screen) → app icon, instant open, persistent.
- Known failure mode (accept, don't engineer around): if `tailscaled` is down, the bridge is
  reachable on localhost but not via MagicDNS. On **Android specifically**, the OS backgrounds
  Tailscale aggressively — a notification tap may hit the app before the tunnel is up. Mitigation:
  put the agent's question **in the notification body** so it's actionable even if the web app
  doesn't load instantly.

## 8. Future ideas

Not planned, not scheduled — a parking lot for ideas surfaced while reading Herdr's socket surface,
so they don't get re-discovered from scratch or acted on by accident.

- **`herdr terminal session observe` / `control` (new in 0.7.2).** A CLI subcommand pair that
  streams a pane as NDJSON live ANSI frames — `observe` is read-only; `control` additionally
  accepts stdin commands (`terminal.input`, `terminal.resize`, `terminal.scroll`,
  `terminal.release`) with one-controller-at-a-time semantics (`--takeover` to steal control). A
  bridge process could spawn either as a child and get a true live pane mirror, or even a full
  interactive terminal, instead of polled snapshots. **But raw ANSI frames need a real terminal
  emulator to render** (cursor movement, screen clears, scroll regions — well beyond the current
  SGR-color-only parser, see `HERDR_API.md`), and rendering that faithfully in the browser would
  breach the security posture's "pane output is React text nodes only" XSS boundary (§6). Adopt
  this deliberately, with a real terminal-emulator library and a re-examined threat model — or not
  at all. This is the designated parking spot for that idea; don't half-do it.
