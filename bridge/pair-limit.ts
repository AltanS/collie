// The per-source-address limit on POST /api/pair (M46 spec 05).
//
// The pairing code already carries its own brake: five wrong tries kill the pending code
// (bridge/pairing.ts). That rule stays and still applies on top. This limit is the outer one: it
// stops a single address from hammering the route at all, wrong code or right, so a client cannot
// churn through fresh codes or keep the claim path hot. It is deliberately config-free, in memory,
// and not kept across a restart: a restart gives an address ten fresh tries, and the five-per-code
// rule still holds then.

/** Attempts one source address may make inside one window. */
export const PAIR_ATTEMPTS_PER_WINDOW = 10;
/** The sliding window, in milliseconds. Also the `retry-after` the refused caller is told, in seconds. */
export const PAIR_WINDOW_MS = 60_000;
/** The most addresses the limiter tracks at once. A spray from more sources than this evicts the oldest. */
export const PAIR_MAX_TRACKED = 1_024;

export interface PairLimiter {
  /**
   * Count one attempt from `source` at `now` and say whether it is allowed. `first` is true on the
   * first refusal of a window, so a caller can audit the burst once instead of once per request.
   */
  hit(source: string, now?: number): { allowed: boolean; first: boolean };
  /** How many addresses are tracked right now (for the bounded-map test). */
  size(): number;
}

interface Entry {
  stamps: number[];
  refused: boolean;
}

/** A sliding-window counter: each address keeps the timestamps of its attempts in the last window. */
export function createPairLimiter(
  limit: number = PAIR_ATTEMPTS_PER_WINDOW,
  windowMs: number = PAIR_WINDOW_MS,
  maxTracked: number = PAIR_MAX_TRACKED,
): PairLimiter {
  const seen = new Map<string, Entry>();

  function prune(now: number): void {
    for (const [source, entry] of seen) {
      const live = entry.stamps.filter((t) => now - t < windowMs);
      if (live.length === 0) seen.delete(source);
      else if (live.length !== entry.stamps.length) entry.stamps = live;
    }
  }

  return {
    hit(source, now = Date.now()) {
      // Pruned on every call: the map holds only addresses that tried inside the window.
      prune(now);
      const entry = seen.get(source) ?? { stamps: [], refused: false };
      if (entry.stamps.length >= limit) {
        const first = !entry.refused;
        entry.refused = true;
        return { allowed: false, first };
      }
      entry.stamps.push(now);
      // Re-insert so the Map's insertion order is least-recently-active first, then bound it.
      seen.delete(source);
      seen.set(source, entry);
      while (seen.size > maxTracked) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
      return { allowed: true, first: false };
    },
    size: () => seen.size,
  };
}

/**
 * The address a pairing attempt is counted under.
 *
 * The socket address is the kernel's and cannot be forged, so it is the key whenever the peer is
 * not on loopback. Only a loopback peer (the co-located front door: `tailscale serve`, Caddy) is a
 * trusted proxy, and only then is the first `x-forwarded-for` entry read, because that entry is
 * what the proxy saw. From any other peer an `x-forwarded-for` is a client's own words and is
 * ignored, so it cannot be used to dodge the limit by rotating the value.
 *
 * `peerIsLoopback` is `isLoopbackPeer(server.requestIP(req)?.address)`, passed in so this module
 * does not import the server.
 */
export function pairSourceKey(
  peer: string | null | undefined,
  peerIsLoopback: boolean,
  forwardedFor: string | null,
): string {
  if (!peerIsLoopback) return (peer ?? "").trim().toLowerCase();
  const first = forwardedFor?.split(",")[0]?.trim().toLowerCase();
  return first !== undefined && first !== "" ? first : "loopback";
}
