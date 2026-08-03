# 0005 — A composed key queue never outlives its dock

Status: **Accepted** (2026-08-03)

## Context

The nav tray's key queue ([`use-key-queue.ts`](../web/src/hooks/use-key-queue.ts)) lets you compose a
sequence of keys — `ctrl+alt+shift+p`, or an ordered run of several chords — review it as chips, and
send the whole thing as ONE `pane.send_keys` call. The review step is the entire point: these keys go
straight into a live terminal, and the strip is the last place a mistake is cheap.

`NavTray` unmounts when its dock closes, so `useKeyQueue`'s state resets and the composed queue is
gone. That is a real papercut — a mis-tap on the ✕ (or on the Keys toggle, or on Quick/Agent/Display,
all of which unmount the tray just as effectively) destroys careful work with no warning.

The obvious fix is to lift the queue up to `Composer`, where it would survive the dock closing and be
waiting when you reopen. That was proposed during the 0.23.0 controls work and rejected.

## Decision

**Closing the Keys dock discards the queue. The queue is never lifted, persisted, or restored.**

**A mis-tap is answered with a confirm, not with persistence.** When the queue is non-empty, leaving
the Keys dock takes a second tap ("Tap again to discard N queued keys").

**The guard lives on the drawer transition, not on the ✕.** `Composer.requestDrawer()` is the single
choke point every dock change routes through, because the ✕ is only one of five ways to unmount the
tray. `NavTray` pushes its staged count up (`onQueueChange`) and reports 0 on unmount, so a stale
count can't arm a phantom confirm on a later, clean close.

**An armed-but-empty queue does not arm the confirm.** A lone `once` modifier with no chips staged is
one tap of setup, not work worth protecting.

## Consequences

- **A queue can never fire into state it wasn't composed against.** This is the reason for the whole
  decision. A queue that survived into a later open would sit there looking reviewed while the pane
  underneath it moved on — a different dialog, a different menu position, a different mode — and then
  Send would fire yesterday's chord sequence into today's TUI. For a surface whose safety story is
  *you review exactly what is about to go on the wire*, resurrected state is worse than lost state:
  losing a queue costs you thirty seconds of re-tapping, and firing a stale one costs you whatever
  those keys did.
- **The confirm is a real interruption, and that is accepted.** It fires only on genuine work (a
  non-empty queue) and only on the way out.
- **Deliberately NOT applied to every dock.** Quick and Display hold no composed state, so guarding
  them would be ceremony. Over-guarding is not free: a confirm you meet routinely trains you to
  double-tap through it reflexively, which destroys its value at the one moment it matters.
- **The tray stays the owner of its own state**, so `useKeyQueue` remains a plain unmount-resets
  hook with no lifecycle coupling to the Composer beyond a count pushed upward.

### What would justify revisiting

- Evidence that accidental discards actually happen often *despite* the confirm — that would mean the
  confirm is in the wrong place, not that persistence is right.
- The queue becomes expensive enough to build that losing it is a genuine cost (a long recorded
  macro, say, rather than a handful of chords). At that point the answer is probably named, saved
  sequences with explicit lifecycle — a different feature, not a longer-lived queue, and this ADR
  would be superseded rather than amended.
- Herdr grows a way to send keys *conditionally* on pane state, which would defuse the stale-fire
  hazard that motivates all of this.
