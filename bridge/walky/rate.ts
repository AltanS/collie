// The caps (M62 README decision 6, hardened 2026-10-17). In memory only: a restart forgets the
// windows, which costs at most one more window's worth from a sender that was already at a cap.
//
//   sender   30 tokens per sender per 10 minutes. The key is `kind + memberId + address`, never the
//            label, which is display data the sender chooses. An operator's broadcast takes one
//            token per target it reaches.
//   pair     6 messages per 10 minutes between the same two addresses, either direction: two agents
//            that answer each other cannot run a loop past it.
//   member   on a lead, one outer bucket per member that dials it: 60 tokens per 10 minutes, so one
//            machine cannot spend the lead's typing on its own.

export const RATE_LIMIT = 30;
export const RATE_WINDOW_MS = 10 * 60 * 1000;
export const PAIR_LIMIT = 6;
export const MEMBER_LIMIT = 60;
/** The most keys one limiter remembers. The one seen least recently goes first. */
const KEYS_MAX = 512;

export class RateLimiter {
  private readonly seen = new Map<string, number[]>();

  constructor(
    private readonly limit = RATE_LIMIT,
    private readonly windowMs = RATE_WINDOW_MS,
  ) {}

  private recent(key: string, now: number): number[] {
    return (this.seen.get(key) ?? []).filter((at) => now - at < this.windowMs);
  }

  /** Whether `key` has room for `count` more tokens at `now`. Counts nothing. */
  room(key: string, now: number, count = 1): boolean {
    return this.recent(key, now).length + count <= this.limit;
  }

  /** Take `count` tokens for `key` at `now`. False when they do not fit: nothing is counted. */
  take(key: string, now: number, count = 1): boolean {
    const recent = this.recent(key, now);
    if (recent.length + count > this.limit) {
      this.seen.set(key, recent);
      return false;
    }
    for (let i = 0; i < count; i++) recent.push(now);
    // Re-inserted, so the map's order is the order keys were last seen in.
    this.seen.delete(key);
    this.seen.set(key, recent);
    while (this.seen.size > KEYS_MAX) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }
}

/** The key a sender is counted under: its kind, its machine and its pane address. Never the label. */
export function senderKey(kind: "agent" | "operator", memberId: string | null, address: string | null): string {
  return `${kind}:${memberId ?? "-"}:${address ?? "-"}`;
}

/** The key of the pair of two addresses, the same in either direction. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}
