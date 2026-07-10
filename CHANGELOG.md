# Changelog

All notable changes to Collie are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[Semantic Versioning](https://semver.org/). The newest `## [x.y.z]` heading **must** match the
`version` in `herdr-plugin.toml`, `package.json`, and `web/package.json` (enforced by
`scripts/check-version.sh`). See [`CLAUDE.md`](./CLAUDE.md) → *Versioning* for the bump policy.

## [0.12.1] - 2026-07-10

### Fixed
- View transitions no longer flicker the dashboard list on every poll — React Router fires one per revalidation, so animation is gated to transitions we initiate and un-armed ones swap instantly (71e2ba2)
- `loaders.ts` is text again (real git diff/blame): the `paneKey` joiner is an escaped NUL, not a literal one (fcb0b7d)
- Deep-linking a space that never existed shows "Space not found", not "Space closed" (fcb0b7d)

### Changed
- Settings gear navigates imperatively so it still slides under the transition gate (71e2ba2)
- Security posture documents that `COLLIE_MULTI_SESSION` (default on) fronts every named session (fcb0b7d)

## [0.12.0] - 2026-07-10

### Added
- Space detail is a deep-linkable route (`/space/:spaceId`) with a working browser Back button, replacing the in-home drill-in state (0e5f9c8)

### Changed
- Dashboard, space, and settings scroll inside a viewport-clipped region so a view-transition slide captures what's on screen, not the full document height (2aa9272)

### Fixed
- View-transition slides no longer detach the sticky header or warp the content — only the pinned header and the content region animate, and the sliding group's geometry is pinned so it can't size-morph between two different-height views (2aa9272)

## [0.11.0] - 2026-07-09

### Added
- Terminal-draft recovery: a queued-then-recalled message stranded on the "❯" input line now surfaces as a composer chip (46dcf35)
- "Edit here" clears the stranded terminal line and adopts the text into the composer, so the next send isn't corrupted; per-draft dismiss (46dcf35)
- `extractInputDraft` grammar helper reads the input box's prompt line (skips the empty box + queued-messages placeholder) (46dcf35)

## [0.10.7] - 2026-07-09

### Changed
- Header height is consistent between the dashboard and inside a space (both compact) — no more 65px→57px jump (6250e0c)
- Removed the keyboard-only quick-keys strip (Esc/Tab/arrows/Enter) above View/Controls; those keys now live in the Keys sheet (6250e0c)

## [0.10.6] - 2026-07-09

### Security
- Removed one-tap yes/no reply buttons from push notifications — they POSTed to the terminal without opening the app, i.e. approving blind. Notifications now only deep-link to the pane (3873e42)

## [0.10.5] - 2026-07-09

### Changed
- Navigation chrome (header + footer nav) brightened to a solid zinc-800 surface, lifting it off the content (9da7195)

## [0.10.4] - 2026-07-09

### Changed
- Faint translucent zinc disc behind the Collie header mark, lifting its silhouette off the dark header (45daa22)

## [0.10.3] - 2026-07-09

### Changed
- Collie header ring is thinner and lighter, with more diameter so the mark has room to breathe (35db0e5)

## [0.10.2] - 2026-07-09

### Changed
- Pane header no longer shows the session chip — session UI is dashboard-only, keeping the in-space header clean (ba56ba9)
- Collie header mark framed with a whitesmoke ring so it reads as a deliberate badge on the dark header (ba56ba9)

## [0.10.1] - 2026-07-09

### Changed
- Session switcher is dashboard-only — hidden once you drill into a space, keeping the in-space header clean (bb0048d)
- Pane-header agent logo shrunk (size-8 → size-6) so it reads as subordinate to the Collie brand mark (bb0048d)

## [0.10.0] - 2026-07-09

### Added
- Herdr session switcher: one bridge fronts every named herdr session — `?session=` on the API, `?s=` in the app, sessions summary in the snapshot, per-session notification slots, `COLLIE_MULTI_SESSION` kill-switch (8fa1f20)

## [0.9.0] - 2026-07-07

### Changed
- Quick keys mimic a physical keyboard on both surfaces: Esc top-left, Tab below it, inverted-T arrows, Enter top-right; Keys sheet gains a full-width spacebar (2f70662)
- Attach image lives in the reply row (usable without the phone keyboard open); digits leave the inline strip — the 123 tab remains (2f70662)
- Header collie logo is transparent like the gallop sprite — removed favicon.svg's baked-in gray backing rect (3f05da8)

## [0.8.0] - 2026-07-07

### Added
- Poll herdr 0.7.2's `session.snapshot` — one RPC per tick instead of three list calls; permanent fallback to the list trio on older servers (5687bbf)
- Event-poked polling: `events.subscribe` stream triggers immediate debounced re-polls; interval relaxes to `COLLIE_POLL_IDLE_MS` (default 12s) while the stream is healthy (5687bbf)

### Changed
- HERDR_API.md re-verified against herdr 0.7.2 / protocol 16; terminal observe/control filed under ARCHITECTURE.md Future ideas (aad94b3)

## [0.7.0] - 2026-07-06

### Added
- Notification type prefs: Settings "Notify when" toggles per agent status, bridge-wide; default pushes only "Needs input" (blocked) — "Finished" (done) is off (98cf5d2)

### Changed
- Push sends carry a `collie-herd` topic + 6h TTL: an offline device now gets one current summary on reconnect instead of replaying every queued update (98cf5d2)
- Disabling a notification kind retracts its pending/outstanding alerts immediately (98cf5d2)

## [0.6.0] - 2026-07-06

### Added
- First-paint PWA splash: the galloping collie shows before React mounts (299f632)
- Keys sheet: `Ctrl` modifier + visible key queue — compose chords/sequences, review, Send as one call; dialer-size digits on a `123` tab (515f795)

### Changed
- Header Collie mark matches the agent logo (2rem, aligned across screens); Find lives in the composer View row; placeholder is just "Type a reply…" (11385ee)

### Fixed
- Option taps no longer pop the phone keyboard or steal the note editor's focus (11385ee)
- Stalled connections no longer zombify the app: fetch timeouts (10s/20s/60s), polls supersede a wedged revalidation at 12s, and the collie gallops within 2.5s of a stalled load or pane-tap navigation (e6ad939)

## [0.5.0] - 2026-07-05

### Added
- **Preview-variant question notes.** Claude Code's *preview* AskUserQuestion — a single-select
  question whose options carry a `preview` field (the mockup/snippet pane, footer hint
  `n to add notes`) — is lifted into a native block that surfaces the per-question note affordance.
  A note (attach / edit / remove) is driven from the native option UI and applies **per question**,
  not per option row. Delivery uses the verified staged keystroke choreography
  (`n` → confirm the input focused → clear → paste the text via the reply path → `Escape` to blur,
  each stage verified rendered before the next fires; `Enter` is never sent, since it would submit
  the dialog — see `web/src/lib/grammar/NOTES_NOTES.md`), and option selection is the two-step
  digit → verify-pointer → `Enter` recipe. Race-guarded like the other dialog blocks (a stale tap on
  a drifted dialog aborts before anything irreversible is sent). Claude-scoped (`hasBlockGrammar`)
  and web-only; the standard non-preview select and wizard steps are unaffected (pressing `n` there
  is a no-op, so no notes UI is shown).

### Security
- **Preview-note tap guard hardened to region-signature parity.** The preview dialog's race guard now
  carries a pointer- and note-independent **core signature** (the subject/question/stepper above the
  options joined with the option rows' left column, `❯` normalised) — matching the 0.4.0 `signature`
  parity the prompt/wizard guards already had. It is enforced at entry AND on **every** mid-flight
  acceptance/drift check, so a same-shaped successor dialog (identical question + labels, different
  subject) can no longer be answered by a stale tap: no digit-then-`Enter` or `Enter` is sent unless
  the fresh read's core signature byte-matches what the user saw. The blur poll is now three-valued
  (ok / drifted / timeout) so the Escape-retry fires only on a genuine swallowed key — never after the
  dialog drifted or vanished (which a blind second Escape could cancel / interrupt). Pasted note text
  is stripped of C0/C1 control bytes (ESC, BEL, …) before it can reach the focused input.

## [0.4.0] - 2026-07-05

### Added
- **Block-based terminal renderer.** Pane rendering now flows through a semantic Block AST (styled
  lines → typed blocks → React components) instead of a flat span mirror. The raw-block foundation is
  byte-for-byte identical to the old mirror, but it's the seam every feature below builds on —
  detected regions are lifted into native blocks in place, and anything unrecognized falls back to
  the raw mirror. Scoped to Claude Code (`hasBlockGrammar`); every other agent renders the plain
  mirror, since their TUIs are unverified.
- **Native prompt buttons.** A Claude single-choice dialog at the buffer tail (select, permission,
  trust, plan approval) is lifted out of the mirror and rendered as tappable buttons; a tap sends the
  per-family keystrokes (digit, or digit+Enter for AskUserQuestion), guarded so a stale tap on a
  scrolled-up menu can't fire. The agent's own input box/statusline are stripped so they don't
  duplicate the composer.
- **Status strip.** The stripped statusline (model · ctx% · cwd · branch · tokens) is re-surfaced as
  a slim line above the composer, so the branch/context stays visible instead of vanishing with the
  input-box chrome.
- **Submission progress bar.** A slim indeterminate bar across the top of the app while any mutation
  (reply, keys, prompt tap, upload, tab/space create, close, snooze) is in flight; background polling
  never triggers it, and a 120ms delay means a fast action never flashes it.
- **Raw-terminal escape hatch.** A View toggle (terminal icon) that turns off the block renderer —
  native prompt buttons, chrome stripping, status strip — and shows the plain mirror, so a
  mis-detected/mis-rendered dialog can always be driven by hand with the keys pad. Persisted.
- **Multi-question wizard.** A multi-question AskUserQuestion (the `☒ Focus area ☐ Scope ✔ Submit`
  stepper) now renders as a native step-by-step wizard instead of bailing to the raw mirror: the
  stepper chips (answered/current per question), the current question's options as tappable buttons
  (one digit each — verified: a wizard digit instant-selects and advances), back/next step
  navigation, and the final Submit review step (answers echoed, submit/cancel). Incremental
  round-trip: every tap is a single race-guarded keystroke re-derived against a fresh read; the TUI
  stays the source of truth. Choreography + fixtures documented in
  `web/src/lib/grammar/WIZARD_NOTES.md`.
- **Galloping Collie loader.** The mascot now doubles as the app's activity indicator: a 6-frame
  gallop sprite (`web/public/dog-gallop.png`, a 768×128 transparent strip) stepped through with a
  pure-CSS `steps(6)` animation (no JS timers). At rest it's the familiar static app icon
  (`favicon.svg`); it springs into the gallop on the boot splash while the first snapshot loads and
  whenever the connection isn't live (connecting / reconnecting / offline), settling back to the
  static icon once live. Honours `prefers-reduced-motion`. New `DogGallop` component; rough
  first-pass art to be replaced with higher-quality frames.

### Changed
- **One consistent top-left mark on every screen.** The Collie is now the brand + home button +
  connection loader in a single shared `CollieHome` component, rendered identically on the dashboard
  and inside a pane — so the header's top-left always means the same thing (previously a "stacks"
  icon inside a pane vs. the Collie logo on the dashboard). Inside a pane the Collie gallops on
  reconnect from the same global connection state as the dashboard (shared `isConnecting` predicate).

### Removed
- **The pane's Nav-hub drawer** (the left "stacks" drawer). It was redundant now that the Collie
  handles Home, the swipe-up switcher already covers pane switching/closing, and the breadcrumb
  covers cross-space jumps — removed along with its `SpaceList` component. The swipe-up switcher now
  appears whenever a pane is open, so even the last pane stays closable.

### Fixed
- **Multi-question AskUserQuestion no longer mis-parsed.** A multi-step AskUserQuestion (the
  `☒ Focus area  ☐ Scope  ✔ Submit` stepper) was detected as a single-question select and answered
  with one digit+Enter — submitting a half-filled form. It's now recognized as a wizard and left as
  the raw mirror (drive it with the keys pad, or via the new escape hatch) rather than mis-sending.

### Security
- **Prompt/wizard taps are guarded against same-shaped successor dialogs.** The tap race guard now
  compares a byte-signature of the whole dialog region — including the subject above the options (the
  diff/command being approved), not just the question and option labels. So a tap on a frozen mirror
  can no longer approve a *different* action that happens to render an identical-looking prompt (e.g.
  a second edit to the same file after the first was answered elsewhere). Herdr's `revision` is a
  stub, so this content signature is the load-bearing freshness check.

## [0.3.0] - 2026-07-03

A full-codebase review pass: four audit agents (backend, frontend, security, ops/product) swept the
tree; everything they found was verified, fixed, and the top feature gaps were built.

### Added
- **Reply from the notification.** Needs-you pushes now carry up to two quick-reply action buttons
  (agent-aware: codex gets `yes`/`no`, others `yes`/`continue`; bridge sends `quickReplies` in the
  payload). Tapping one POSTs the reply straight from the service worker and confirms with a silent
  "Sent ✓" — no app open needed. Body tap still deep-links as before.
- **Find in output.** A magnifier in the pane header opens a find bar: case-insensitive match over
  the visible buffer, match count, prev/next that cooperates with the scroll-freeze, highlights
  rendered through the same React-text-node path (XSS boundary untouched).
- **Load older scrollback.** A "load older" row at the top of the mirror grows the fetched window
  600 lines at a time (up to 5000; the bridge clamps reads at 10000), preserving your scroll
  position across the refetch.
- **Destructive-input confirm.** Replies matching a reviewed pattern list (`rm -rf`, `sudo`,
  `git push --force`, `dd if=`, `mkfs`, redirects to system paths, …) flip Send into a two-tap
  "Really send?" state for ~3s — same pattern the `/clear` palette action already used.
- **Audit log.** Every write action (reply, keys, upload, tab/workspace create, pane close) appends
  a single JSONL line — timestamp, action, pane, device, truncated params — to
  `<state-dir>/audit.log` (mode 0600). Audit failures never block the action itself.
- `COLLIE_PUBLIC_HOSTS` env var — an explicit Host-header allowlist. When set, requests addressed
  to any other Host are rejected before origin logic, defeating DNS rebinding. Strongly
  recommended (set it to your MagicDNS name); effectively mandatory with `COLLIE_SERVE_MODE=http`.
- Startup warnings when `COLLIE_TRUSTED_USER` or `COLLIE_PUBLIC_HOSTS` is unset — parity with the
  existing bind/allowlist warnings, since an empty trusted-user means any tailnet device has write
  access.
- Uploaded images are now swept after 48h (was: kept forever).

### Changed
- **Builds are gated.** `bun run build` (root) and `collie-ctl.sh build` now typecheck bridge and
  web before building, and build into `dist-staging` with an atomic swap — a failed build can no
  longer leave an empty `web/dist` serving 503s. The pre-push hook typechecks both sides too
  (`SKIP_TYPECHECK=1` to bypass once). Root tsconfig now enforces `noUnusedLocals/Parameters`.
- **Write requests without an `Origin` header are rejected** unless they arrive on loopback
  (browsers always send Origin on POST; curl-on-host keeps working).
- Idle lock is now timestamp-based: backgrounding/foregrounding the app no longer resets the
  countdown, and returning past the deadline locks immediately.
- The composer moved into its own `<Composer>` component; `agent-chat.tsx` slimmed by ~230 lines.
- A reply whose text lands but whose submit keystroke fails now reports "typed into the pane but
  not submitted — check the pane before resending" (and `textDelivered: true`) instead of a generic
  error that invited double-sends.
- systemd unit hardened (`NoNewPrivileges`, `PrivateTmp`) and made persistent
  (`StartLimitIntervalSec=0`, `RestartSec=5`) so a crash-loop can't leave the service permanently
  down while you're phone-only.
- Notification deep links URL-encode the pane id; sheets manage focus (focus in on open, restore on
  close, `aria-labelledby`); space status dots gained screen-reader text; pinch-zoom re-enabled
  (removed `maximum-scale=1`).

### Fixed
- **Socket leak on RPC timeout** — a stalled Herdr left the Unix-socket FD open on every timed-out
  request; under the 1.5s poll cadence this exhausted file descriptors and wedged the bridge. Every
  terminal path now closes the socket.
- **UTF-8 corruption across socket chunks** — multi-byte characters (box drawing, emoji) straddling
  a socket-read boundary rendered as `�`; replies are now stream-decoded.
- **Overlapping polls** — a slow Herdr let 1.5s ticks pile up 3-4 concurrent polls; a tick is now
  skipped while the previous poll is in flight.
- **Upload buffering** — a too-large upload was buffered fully into RAM before the 10MB check;
  oversized `Content-Length` is now rejected up front and `Bun.serve` caps request bodies at 12MB.
- Push subscription saves are serialized and written atomically (temp+rename); concurrent
  add/prune can no longer drop a subscription. State files are written 0600 in 0700 dirs.
- First PWA load no longer flashes an immediate reload (service-worker `controllerchange` on
  initial claim was treated as an update).
- A rotated VAPID key now unsubscribes the stale push subscription and re-subscribes fresh instead
  of silently dead-ending pushes.
- Superseded loader revalidations are aborted (`request.signal` threaded through); raw key presses
  debounce their revalidate (one refetch per burst instead of one per keystroke).
- Slash-command insert appends to the draft instead of overwriting it; tap-to-focus no longer
  collapses an active text selection (copying pane output works now).
- `envInt` config parsing rejects garbage and out-of-range values (negative poll/debounce
  intervals, invalid ports) with a warning instead of silently accepting them.
- Static-file path guard now checks the directory boundary (`dist` vs `dist-*`); `?lines=` is
  clamped; API/static responses carry `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`; graceful shutdown drains in-flight requests.
- Pre-commit version guard now also covers `web/vite.config.ts`, `web/index.html`,
  `web/package.json`, `web/public/`, `systemd/`, and root `package.json`, and requires the new
  version to sort strictly above the old one.

## [0.2.0] - 2026-06-30

### Changed
- **Smarter push notifications.** A blocked/done alert is no longer fire-and-forget. Each one now
  waits a short **debounce window** (`COLLIE_NOTIFY_DELAY_MS`, default 30s) before it sends; an agent
  you clear at your desk within that window never reaches your phone. Alerts that *do* fire are
  **retracted** automatically once the agent resolves (or its pane closes), so handled work stops
  piling up on your lock screen. The service worker also **suppresses** the system notification when a
  Collie tab is already open and visible (the in-app status surfaces it instead).
- **Coalesced into one notification.** The whole herd shares a single notification slot: one agent
  shows the named, deep-linked alert; several collapse into a *"N agents need you"* digest (tap → the
  triage home) that updates in place as agents come and go, instead of stacking N separate alerts.

### Added
- **Do Not Disturb / snooze** (Settings → *Do not disturb*): pause all push for 30m / 1h / 4h, or
  resume early. Server-enforced and self-expiring, so it quiets every device — and it clears whatever
  is already on the lock screen the moment you snooze. The current deadline rides the snapshot, so it
  stays in sync across devices.
- `COLLIE_NOTIFY_DELAY_MS` env var — the push debounce window in ms (default `30000`; `0` notifies on
  the next tick with no debounce).
- `POST /api/notifications/snooze` — set/clear the global snooze (`{ snoozedUntil: number | null }`);
  the active deadline is reported on the snapshot as `notifications.snoozedUntil`.

## [0.1.0] - 2026-06-30

Initial public release of **Collie** — a phone web UI to monitor and reply to your Herdr agent
herd over Tailscale.

### Added
- **Mobile-first PWA** (Vite + React + TypeScript + Tailwind v4 + shadcn): a triage dashboard
  (Spaces overview + Needs-you / Working / Idle agent groups), a per-agent colored terminal mirror,
  an agent-aware slash-command palette (Claude Code, Codex, pi, opencode), a special-keys pad with
  inline arrows/Tab, per-agent brand icons, image upload, and animated view transitions. Installable,
  with an auto-updating service worker and a build-stamp footer.
- **Bun/TypeScript bridge** over Herdr's Unix socket: a polled live snapshot (adaptive cadence,
  gzip + `ETag`/`304`) plus reply / keys / upload endpoints, and space/tab/pane management (create
  shell panes, switch, kill) through a unified nav hub.
- **Runs as a `systemd --user` service** supervised independently of Herdr, with a `tailscale serve`
  launcher (`scripts/collie-ctl.sh`) and a thin Herdr plugin (`herdr.collie`) exposing
  start / stop / restart / status / url / version / update / uninstall actions. One-command update
  (pull → rebuild → restart → re-link) for the linked checkout.
- **Optional Web Push (VAPID) notifications** when an agent needs you, with a custom service-worker
  push handler that renders the real message and deep-links the tap to the agent's pane.
- **Security posture:** loopback-only bind, `tailscale serve` as the sole ingress (never `funnel`),
  a same-origin gate, an optional `COLLIE_TRUSTED_USER` identity check, optional per-device
  authorisation via a trusted upstream header, a strict CSP, and terminal output rendered as React
  text nodes (the XSS boundary).
