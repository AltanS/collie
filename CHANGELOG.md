# Changelog

All notable changes to Collie are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[Semantic Versioning](https://semver.org/). The newest `## [x.y.z]` heading **must** match the
`version` in `herdr-plugin.toml`, `package.json`, and `web/package.json` (enforced by
`scripts/check-version.sh`). See [`CLAUDE.md`](./CLAUDE.md) → *Versioning* for the bump policy.

## [0.2.0] - 2026-06-29

### Added
- **Quick-key row while typing.** When the composer is focused (soft keyboard up), a compact row of
  `1`–`5` · `Esc` · `Enter` appears above the action row, so you can drive an agent's numbered/confirm
  prompt without opening the Keys sheet. Buttons fire on pointer-down so the keyboard stays up.
- **In-pane tab bar + space-view tab strip.** The pane view now has a tab bar at the top, above the
  terminal mirror: the current space's tabs (active tab highlighted, blocked-agent dot) and a `+` to
  create a tab — tap a tab to switch to it without leaving the pane. The home space view shows the
  same strip (with an "All" chip that lists every tab); its old per-space "New tab" button moved here.

### Changed
- **Removed the "Sent ✓" / "Agent killed" success toasts.** The terminal mirror already reflects the
  result and the composer clears on send, so the toast was redundant — and it landed over the bottom
  of the mirror (where agent prompts render). The status channel is now error-first (matching the
  existing "silent on success" behavior of raw key sends).
- **Errors persist and are tap-to-dismiss** — the status bar stays until you tap it (with an ✕)
  instead of auto-expiring after 5s; non-error notices auto-clear faster (2.5s).
- **The send button briefly shows a ✓** (1.5s) after a successful send as quiet tap-site
  acknowledgment, in place of the removed toast.

### Fixed
- **Recover from a closed pane.** Running `exit` in a shell (or any pane closing) now returns you
  Home instead of stranding you on a dead "agent gone" view; a stale just-created pane no longer
  masks one that has since closed.

## [0.1.1] - 2026-06-29

### Changed
- **Mirror: mute TUI box-drawing rules.** Agent panes draw full-width separator/border rules (e.g.
  Claude's input box) in a loud theme color that wrapped into stacked bars on a phone. Pure
  box-drawing/rule segments now render in a faint divider color instead of their bright SGR color;
  all real text stays faithful. (The cross-width wrapping of those rules is inherent and unchanged.)

## [0.1.0] - 2026-06-29

Initial public release of **Collie** — a phone web UI to monitor and reply to your Herdr agent
herd over Tailscale.

### Added
- Mobile-first PWA (Vite + React + TypeScript + Tailwind v4 + shadcn): triage home screen, a
  per-agent colored terminal mirror, an agent-aware slash-command palette, a special-keys pad, and
  image upload.
- Bun/TypeScript bridge over Herdr's Unix socket: a polled live snapshot plus reply / keys / upload
  endpoints, and space/tab/pane management (create shell panes, switch, kill) via a unified nav hub.
- A `systemd --user` service supervised independently of Herdr, with a `tailscale serve` launcher
  (`scripts/collie-ctl.sh`) and a thin Herdr plugin (`herdr.collie`) exposing
  start/stop/restart/status/url actions.
- Optional Web Push (VAPID) notifications when an agent needs you.
- Security posture: loopback-only bind, `tailscale serve` as the sole ingress (never `funnel`), a
  same-origin gate, an optional `COLLIE_TRUSTED_USER` identity check, a strict CSP, and terminal
  output rendered as React text nodes (the XSS boundary).
