# 0021 - Windows service backend for Collie

- **Status:** Accepted
- **Date:** 2026-08-22
- **Shipped in:** Unshipped

## Context

Collie already runs on Windows at the bridge layer, but the launcher story is still split across
bash, per-OS shell glue, and service supervisor branches. That shape works, but it keeps the same
lifecycle logic in two languages and makes Windows the only host that does not have a supported
service path in the same codebase.

The candidate backends were:

- Task Scheduler on Windows
- systemd on Linux
- launchd on macOS

NSSM and WinSW were not chosen because they add a wrapper we would need to ship, test, and explain,
and they move the service contract out of the repo.

There is also one hard operational fact to keep honest: the bridge flush path is async, and the stop
model on Windows is a forced kill. The last debounce window can be lost. That matches the current
bridge code and its own comment in `bridge/activity.ts:300`, and it is better to accept that than to
pretend a graceful shutdown exists when Task Scheduler is used with `Stop-ScheduledTask` plus a
fallback `taskkill`.

## Decision

Use Task Scheduler as the Windows service backend, and keep the lifecycle implementation in
TypeScript under `scripts/ctl/` instead of bash.

`main.ts` becomes the single entry point for all supported ctl verbs. That lets Windows, macOS and
Linux share one parser, one readiness probe, one backend interface, and one command surface. The old
bash implementation still exists for compatibility, but the supported path moves to TS.

Windows service termination is a force-kill model. We accept that the final debounce window may be
lost on shutdown, and we rely on the normal save cadence plus the POSIX path elsewhere for the
stronger guarantee.

The manifest also becomes platform-neutral for lifecycle actions. Herdr action ids stay unique, so
we cannot keep separate per-platform action rows with the same ids. The right shape is one bun-based
command row per verb, with platform support declared at the item level.

The baseline deployment scope stays (a), full Windows host deployment. Alternatives remain noted,
but they are not the default:

- (b) Windows bridge only, with another host still handling ingress
- (c) Windows bridge behind an external reverse proxy or tunnel

## Consequences

Windows gets a supported service path without a second wrapper layer.

The tradeoff is explicit loss of the final debounce window on forced termination, which is acceptable
for the Windows backend but not a graceful-shutdown guarantee.

The ctl code becomes easier to test and reason about, because the same verbs and readiness checks are
used everywhere.

The manifest is simpler, but less specific per platform. That is the cost of keeping action ids
unique and the command surface uniform.

If a future Windows service backend can prove a better stop model without adding a new wrapper or a
second command path, this ADR can be revisited. Until then, Task Scheduler is the supported route.
