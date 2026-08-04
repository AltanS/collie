# 0007 — The idle lock is a pause, not a gate

Status: **Accepted** (2026-08-04)

## Context

The idle lock ([`use-idle-lock.ts`](../web/src/hooks/use-idle-lock.ts)) was introduced as a security
mitigation. `ARCHITECTURE.md` justified it in those terms: Tailscale proves the *device*, not who is
holding it, the PWA has no session to expire, so "a stolen unlocked phone would be a root shell" — and
the lock answered that by unmounting the router until tapped.

It never actually did that job. The lock is client-side React state that starts `false` on every
mount, so a page reload — or the OS killing and relaunching the PWA — walks straight through it. The
README has always said so plainly: *"the idle-lock is UX, not auth."* What it bought against someone
holding your unlocked phone was one tap.

Meanwhile it was charging real costs:

- **It locked hidden tabs.** The deadline was measured from the last real interaction and re-checked
  on `visibilitychange`, so backgrounding Collie for 30 minutes and returning meant meeting the lock
  screen on the way back in. That is where essentially every lock anyone saw came from — and it is the
  one moment the lock protects nothing, because a hidden tab *already* polls nothing
  ([`use-polling.ts`](../web/src/hooks/use-polling.ts) skips every tick while `document.hidden`).
- **It destroyed work.** Rendering the lock *instead of* the router unmounted the whole route tree,
  and `Composer` keeps its draft, upload and open sheets in local state. A pause silently ate an
  in-progress reply.
- **It could eat an alert.** The service worker suppresses a push when a Collie tab is visible, on the
  theory that the in-app UI already surfaces it ([`push-decision.ts`](../web/src/lib/push-decision.ts)).
  A locked-but-visible tab satisfies that check while showing nothing and polling nothing, so the
  notification was dropped by both paths at once.

## Decision

**The idle lock is a pause on an unattended, visibly-open Collie. It is not an access control, and it
is not described as one.**

**A hidden page never locks.** The timer fires, sees `visibilityState !== "visible"`, and lets itself
die. Nothing needs pausing behind a tab that is already not polling.

**Returning to the foreground auto-resumes.** A lock met on the way back is ceremony: it guards
nothing a reload didn't already bypass, and it costs a tap every single time. Coming back stamps fresh
activity and restarts the countdown.

Together those two rules mean the lock has exactly one way to appear: **you left Collie open, visible
and untouched past the deadline.** A desk, a tablet, a kiosk — almost never a phone, whose screen
sleeps long first.

**The cover sits above a still-mounted router.** Polling pauses through a module-scoped store
([`lib/idle.ts`](../web/src/lib/idle.ts)) that the polling tick reads live; releasing it revalidates
immediately, since no loader re-runs on its own with the tree still mounted.

**The screen carries the Collie mark and honest copy.** No lock iconography, no "for safety" — it is
the app's one chrome-less full-viewport screen, so it states whose it is and what it did.

## Consequences

- **Whoever picks up your unlocked phone sees your herd without tapping.** This is the cost, and it is
  accepted as approximately zero: it was one tap before, on a screen a reload dismissed. The real
  boundary is, and always was, the tailnet plus your phone's own lock screen. If that is not enough,
  the answer is a PIN on reconnect or Tailscale ACL scoping (both still listed in `ARCHITECTURE.md`
  as considered-not-built) — not a longer-lived client flag.
- **`ARCHITECTURE.md` no longer lists the idle timeout as a security measure.** Leaving it there would
  claim a gate the code has never implemented, which is worse than not having one: it invites someone
  to skip a real control because this one looks like it is covering them.
- **Resuming is lossless.** Draft, scroll position and open sheets survive a pause, because nothing
  unmounts.
- **The push-suppression overlap narrows but does not vanish.** `locked` now implies `visible`, so it
  is the *only* locked state rather than a rare one — but it is nearly unreachable on a phone, and it
  coincides with being at your desk, which the 30-second notification debounce
  ([`notifications.ts`](../bridge/notifications.ts)) already treats as "don't alert". Teaching the
  service worker to ask its clients whether they are live was considered and judged disproportionate
  for the residue.
- **The 30-minute deadline is unchanged**, and still only configurable by editing the constant.

### What would justify revisiting

- Collie growing a real session or identity of its own (a PIN, a proxy sign-in the app can observe).
  At that point re-confirming after idle becomes meaningful, and this ADR is superseded rather than
  amended — the resumption gesture would be authenticating something, not just dismissing a cover.
- Evidence of alerts genuinely lost to the locked-visible overlap — that argues for the service-worker
  liveness round-trip, not for reverting the auto-resume.
