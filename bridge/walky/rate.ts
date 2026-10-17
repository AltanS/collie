// The sender cap (M62 README, decision 6): 30 messages per sender session per 10 minutes. A
// message to `all` counts once. In memory only: a restart forgets the window, which costs at most
// one more window's worth from a sender that was already at the cap.

export const RATE_LIMIT = 30;
export const RATE_WINDOW_MS = 10 * 60 * 1000;
/** The most senders the limiter remembers. The one seen least recently goes first. */
const SENDERS_MAX = 512;

export class RateLimiter {
  private readonly seen = new Map<string, number[]>();

  constructor(
    private readonly limit = RATE_LIMIT,
    private readonly windowMs = RATE_WINDOW_MS,
  ) {}

  /** Count one message from `sender` at `now`. False when the sender is at the cap: nothing is counted. */
  take(sender: string, now: number): boolean {
    const recent = (this.seen.get(sender) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.seen.set(sender, recent);
      return false;
    }
    recent.push(now);
    // Re-inserted, so the map's order is the order senders were last seen in.
    this.seen.delete(sender);
    this.seen.set(sender, recent);
    while (this.seen.size > SENDERS_MAX) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }
}

/** The key a sender is counted under: its pane address, or `operator:<label>`. */
export function senderKey(kind: "agent" | "operator", address: string | null, label: string): string {
  return kind === "agent" && address !== null ? `agent:${address}` : `operator:${label}`;
}
