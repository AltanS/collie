import { cacheChipView, COLD_GRACE_MS } from "./cache-view";
import type { PaneCache } from "./types";

// The chip's whole rule, as a table. It is pure precisely so the edge at the zero crossing can be
// asserted at 9 s and at 11 s rather than by rendering and hoping.

const NOW = 1_800_000_000_000;

const cache = (over: Partial<PaneCache> = {}): PaneCache => ({
  state: "warm",
  expiresAt: NOW + 12 * 60_000,
  ttlSeconds: 3600,
  ruleId: "claude.subscription",
  confidence: "documented",
  lastRequestAt: NOW - 48 * 60_000,
  ...over,
});

describe("nothing to say renders nothing", () => {
  it("no reading at all", () => {
    expect(cacheChipView(undefined, NOW)).toBeNull();
  });

  it("the unknown state", () => {
    expect(cacheChipView(cache({ state: "unknown" }), NOW)).toBeNull();
  });

  it("a warm reading with no expiry — a countdown with nothing to count to", () => {
    expect(cacheChipView(cache({ expiresAt: undefined }), NOW)).toBeNull();
  });
});

describe("the label", () => {
  it("is whole minutes left", () => {
    expect(cacheChipView(cache(), NOW)?.label).toBe("12m");
  });

  it("rounds DOWN, so a chip never promises a minute it does not have", () => {
    expect(cacheChipView(cache({ expiresAt: NOW + 179_000 }), NOW)?.label).toBe("2m");
  });

  it("is `<1m` under a minute, never a second count", () => {
    expect(cacheChipView(cache({ expiresAt: NOW + 40_000 }), NOW)?.label).toBe("<1m");
  });

  it("is the cold word when the bridge says cold", () => {
    expect(cacheChipView(cache({ state: "cold" }), NOW)?.label).toBe("cold");
  });
});

describe("the tone", () => {
  it("warm is warm", () => {
    expect(cacheChipView(cache(), NOW)?.tone).toBe("warm");
  });

  it("expiring comes from the BRIDGE's own state, not from a local threshold", () => {
    // The warn shoulder is a quarter of the TTL and the bridge owns that arithmetic (engine.ts). The
    // chip must not compute a second opinion about it, or the two could disagree on one pane.
    expect(cacheChipView(cache({ state: "expiring", expiresAt: NOW + 8 * 60_000 }), NOW)?.tone).toBe("expiring");
  });

  it("cold from the bridge is cold however much clock is left — a MISS is not a timeout", () => {
    const missed = cache({ state: "cold", expiresAt: NOW + 50 * 60_000 });
    expect(cacheChipView(missed, NOW)?.tone).toBe("cold");
  });
});

describe("crossing zero has a grace", () => {
  it("9 s past expiry still reads its last state", () => {
    const view = cacheChipView(cache({ expiresAt: NOW - 9000 }), NOW);
    expect(view?.tone).toBe("warm");
    expect(view?.label).toBe("<1m");
  });

  it("11 s past expiry reads cold", () => {
    expect(cacheChipView(cache({ expiresAt: NOW - 11_000 }), NOW)?.tone).toBe("cold");
  });

  it("exactly at the grace is not yet cold — the flip is strictly past it", () => {
    expect(cacheChipView(cache({ expiresAt: NOW - COLD_GRACE_MS + 1 }), NOW)?.tone).toBe("warm");
    expect(cacheChipView(cache({ expiresAt: NOW - COLD_GRACE_MS }), NOW)?.tone).toBe("cold");
  });

  it("an expiring reading keeps its amber through the grace rather than flashing warm", () => {
    expect(cacheChipView(cache({ state: "expiring", expiresAt: NOW - 5000 }), NOW)?.tone).toBe("expiring");
  });
});

describe("the overridden mark", () => {
  it("is off by default", () => {
    expect(cacheChipView(cache(), NOW)?.overridden).toBe(false);
  });

  it("is on when the number came from cache-rules.toml", () => {
    expect(cacheChipView(cache({ overridden: true }), NOW)?.overridden).toBe(true);
  });

  it("survives into the cold state, because the number is still the operator's", () => {
    expect(cacheChipView(cache({ state: "cold", overridden: true }), NOW)?.overridden).toBe(true);
  });
});
