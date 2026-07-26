# 0001 — Collie manages exactly one front door

- **Status:** Accepted
- **Date:** 2026-07-27
- **Shipped in:** 0.16.0
- **Trail:** [PR #26](https://github.com/AltanS/collie/pull/26) (declined,
  [reasoning](https://github.com/AltanS/collie/pull/26#issuecomment-5085567630)) ·
  [PR #36](https://github.com/AltanS/collie/pull/36) (what we kept from it)

## Context

Collie is remote shell access. Whatever sits in front of the loopback bridge is the only thing
between a stranger and a terminal running as you, so "which front door" is a security question
before it is a convenience one.

**The bridge is already tunnel-agnostic.** Its entire Tailscale coupling is *one* line —
`req.headers.get("tailscale-user-login")` in `bridge/server.ts`. Everything else is a convenience in
`scripts/collie-ctl.sh` and the README's voice. The bridge binds loopback, speaks plain HTTP, and
gates on `Host`, `Origin`, and two optional headers, one of which (`COLLIE_DEVICE_HEADER`) is
deliberately vendor-neutral.

PR #26 proposed a **second managed front door**: `COLLIE_FRONT_DOOR=tailscale|netbird|proxy`, a
supervised `netbird expose` sidecar with its own systemd unit and teardown, and config plumbing for
NetBird's auth flags. 1441 additions across 12 files. The work was careful, and it raised a fair
question — is Collie too tied to Tailscale, and are non-Tailscale users being hindered?

Three things settled it, each checked rather than assumed:

1. **Nobody was blocked.** `COLLIE_SKIP_SERVE=1` plus `netbird expose 8787` *is* the whole
   integration. What the PR added on top was supervision and teardown of that one command — the same
   thing Variant C already, deliberately, declines to do for anyone's Caddy.
2. **We would have been shipping blind.** NetBird isn't installed on the deployment host, there's no
   CI for it, and shell code sat outside both test suites. Its CLI contract — flag names, the v0.66
   floor, what `expose` actually publishes — would have been maintained by reading a PR description.
   Two prior PRs from a different contributor had described changes their diffs did not contain.
3. **Managing someone else's authenticated process means owning their credentials.** The PR
   demonstrated the cost rather than hypothesising it: the generated runner passed `--with-pin` and
   `--with-password` as command-line arguments, so `ps -eo args` and `/proc/<pid>/cmdline` (mode
   `444`) handed them to any local user.

And the precedent doesn't scale. Cloudflare Tunnel, ZeroTier, Twingate and Nebula all have equal
claim, each with a different CLI and auth model, all as `case` branches in one bash script. That is a
plugin-shaped problem being solved in the wrong shape.

## Decision

**Collie manages exactly one front door: `tailscale serve`.**

We own its lifecycle end to end — `collie-ctl.sh` publishes it, records the mapping in
`<config-dir>/tailscale-managed-handler`, and only ever tears down a mapping still matching that
record.

**Every other tunnel is `COLLIE_SKIP_SERVE=1` plus [README Variant
E](../README.md#variant-e--any-other-mesh-or-tunnel-netbird-zerotier-cloudflare-tunnel).** The
operator owns the ingress; Collie publishes nothing, supervises nothing, and tears down nothing.

The criterion is not popularity or quality. It is: **we manage only what we run and can test.**
`tailscale serve` is on the deployment host, so a regression surfaces the same day.

## Consequences

**Accepted costs.** Non-Tailscale operators supervise their own tunnel — no sidecar unit from us, and
`uninstall` won't remove it. That is exactly what Variant C has always promised for a reverse proxy,
so it is a consistency, not a new gap.

**What we keep owning.** The ownership tracking extracted from #26 (0.16.0) makes the one managed
mapping precise in both directions: publishing refuses to replace a root mount we don't own, and
teardown refuses to remove one that was replaced out from under us. A blind
`tailscale serve --https=443 off` could previously unpublish a mapping Collie never created.

**Documentation carries the load instead of code.** Variant E covers NetBird, ZeroTier, Cloudflare
Tunnel and anything not yet invented, for zero runtime surface. When the honest fix for "users feel
excluded" is a doc section, that is the fix.

**The funnel prohibition generalises.** "Never `tailscale funnel`" was never about Tailscale; it is
about reachability. Any tunnel offering a public URL inherits it, and auth in front of a public URL
is not a substitute for not having one. A shared PIN guarding a root shell is a root password.

**What would justify revisiting.** If the deployment host itself moves to another mesh, that mesh
becomes testable and its front door becomes ownable. The rule that survives is *exactly one managed
front door* — not one per vendor. Adding a second, whatever the vendor, means maintaining a CLI
contract we cannot exercise, and this ADR should be superseded rather than quietly ignored.
