import { FLOAT_AWAY_CAP_MS } from "@/lib/tricks/float";

// THE PLAY CLOCK OF A STAY PICTURE (the `float` place). A sprite that plays once, and the second one after it, play on a
// clock that belongs to the part, not to the picture on screen. The picture goes away when a Page opens, a sheet covers the
// screen, the screen changes or the page is hidden, and is drawn again afterwards: it must take up where it stopped, not
// play again from its first frame. So the clock STOPS while the picture is away and RUNS again when it is drawn; its
// position is the milliseconds the sequence has played. A changed part value (`partSignature`) starts a new clock at 0.
// Away longer than FLOAT_AWAY_CAP_MS: the sequence is over (the position is infinite, the end state shows).
//
// Module level and in memory only: it outlives a remount of the layer and is lost with the page. The layer clears the
// entries of the parts that have left.

interface Entry {
  sig: string;
  /** Milliseconds played up to `since` (or up to the pause). */
  base: number;
  /** When the clock last started to run, or null while it stands. */
  since: number | null;
  /** When it stopped, or null while it runs. */
  pausedAt: number | null;
}

export class FloatClock {
  private readonly entries = new Map<string, Entry>();

  /** Where the play is now, in milliseconds from its first frame. 0 for a part with no clock, or one with another value. */
  positionOf(key: string, sig: string, now: number = Date.now()): number {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.sig !== sig) return 0;
    if (entry.since !== null) return entry.base + Math.max(0, now - entry.since);
    if (entry.pausedAt !== null && now - entry.pausedAt > FLOAT_AWAY_CAP_MS) return Number.POSITIVE_INFINITY;
    return entry.base;
  }

  /** The picture is drawn and runs: a new clock for a new value, the stopped one carries on (or ends, after too long). */
  resume(key: string, sig: string, now: number = Date.now()): void {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.sig !== sig) {
      this.entries.set(key, { sig, base: 0, since: now, pausedAt: null });
      return;
    }
    if (entry.since !== null) return;
    entry.base = this.positionOf(key, sig, now);
    entry.since = now;
    entry.pausedAt = null;
  }

  /** The picture is away or stands (a hidden page): the clock stops where it is. */
  pause(key: string, sig: string, now: number = Date.now()): void {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.sig !== sig || entry.since === null) return;
    entry.base = entry.base + Math.max(0, now - entry.since);
    entry.since = null;
    entry.pausedAt = now;
  }

  /** Keeps the clocks of these parts and drops the rest: a part that has left takes its clock with it. */
  retain(keys: ReadonlySet<string>): void {
    for (const key of this.entries.keys()) if (!keys.has(key)) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

/** The one clock of the page. */
export const floatClock = new FloatClock();
