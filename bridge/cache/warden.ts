// The thing that ticks. `UpdateMonitor`'s shape, for `UpdateMonitor`'s reason.
//
// Every dependency is injected, nothing is resolved from the environment, and this class owns NO TIMER
// (`bridge/update.ts` § UpdateMonitorDeps is the precedent, `NotificationCoordinator` and `PeerNotifier`
// are the other two). The wiring site in `bridge/index.ts` is then a deps literal with no logic in it,
// which is what makes "every gate is proved in warden.test.ts" an honest claim — there is no
// `bridge/index.test.ts`, and CLAUDE.md says why.
//
// ── THE CLOCK IS THE MUX POLL, AND IT IS ALREADY RUNNING ─────────────────────
// `tick` is called from `engine.onUpdate`, after `CacheTracker.refresh`, so the panes it judges already
// carry a fresh reading (spec 02). The poll runs at 1.5 s and relaxes to 12 s with no phone attached,
// which is how a blocked push reaches a sleeping phone today; at 12 s resolution a 300 s window is hit
// with 4 % jitter, well inside "about five minutes".
//
// A LEAD TICKS TWICE, from two call sites and with one warden. Its own panes arrive on its own poll; a
// member's arrive on the sweep that parsed that member's body, which is the same hook
// `bridge/crew/notify.ts` is driven by and the same "no second timer" rule (CREW_PROTOCOL.md §10.1).
// So a peer's watched pane warns from the lead, where the subscriptions are.
//
// ── MUTED MEANS NOTHING SENT AND NOTHING RECORDED ────────────────────────────
// The snooze applies, unlike an update push, which bypasses it on purpose: a cache warning is exactly
// quiet-hours material. And the pair is NOT recorded while muted, so a snooze that ends inside the
// window still warns.

import type { PushMessage } from "../push.ts";
import { cacheWarnings } from "./warn.ts";
import type { CacheWatchLedger } from "./watch.ts";
import type { CacheWarnPane } from "./watch-key.ts";

export interface CacheWardenDeps {
  readonly now: () => number;
  /** `snooze.isMuted()`. Read live, so a snooze set between two ticks is honoured on the next one. */
  readonly muted: () => boolean;
  /** `notifyPrefs.current().cache` — the global switch, read live for the same reason. */
  readonly globalOn: () => boolean;
  readonly store: CacheWatchLedger;
  /** The resolved `COLLIE_CACHE_WARN_SECONDS`. One window for every watched pane (no per-pane threshold). */
  readonly warnSeconds: number;
  /** `push.send` in `bridge/index.ts`, a recorder in the test. */
  readonly send: (msg: PushMessage) => void;
}

export class CacheWarden {
  constructor(private readonly deps: CacheWardenDeps) {}

  /** Judge one batch of panes: refresh their grace clock, then warn whatever has come due. */
  tick(panes: readonly CacheWarnPane[]): void {
    const at = this.deps.now();
    // Before the mute gate: a snooze must not age an operator's list out from under them.
    this.deps.store.seen(
      panes.map((p) => p.key),
      at,
    );
    if (this.deps.muted()) return;
    const out = cacheWarnings({
      panes,
      watched: (pane) => this.deps.globalOn() || this.deps.store.has(pane.key),
      nowMs: at,
      warnSeconds: this.deps.warnSeconds,
      sent: this.deps.store.sentMarks(),
    });
    if (out.messages.length === 0) return;
    for (const msg of out.messages) this.deps.send(msg);
    // Recorded AFTER the sends are handed over, and not awaited: `onUpdate` is synchronous and a poll
    // must never wait on a file write. The store's save is atomic, so a crash between the two costs at
    // most one duplicate warning.
    void this.deps.store.markSent(out.sentPairs);
  }
}
