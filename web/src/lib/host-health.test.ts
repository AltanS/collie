import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as connectionHealth from "./connection-health";
import * as hostHealthModule from "./host-health";
import {
  departedHealth,
  healthFor,
  hostHealth,
  hostHealthMap,
  PRESENTED_STALE_MAX_MS,
  staleThresholdMs,
  writeRefusal,
} from "./host-health";
import type { ServerSummary } from "./types";

// TIER 2 (lead↔peer) in isolation, plus the negative test that keeps TIER 1 (phone↔lead) single.
// The two tiers are only safe as long as they stay two: this file's job is to fail the moment
// somebody makes connection-health.ts host-aware, or gives this module a clock.

const LEAD_NOW = 1_000_000;

/** Source with comments removed — see the two source-level assertions at the bottom of this file. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function member(over: Partial<ServerSummary> = {}): ServerSummary {
  return {
    id: "workshop",
    name: "workshop",
    isLead: false,
    reachable: true,
    protocol: "ok",
    lastSeenAt: LEAD_NOW,
    ...over,
  };
}

const HOT = { at: LEAD_NOW, pollMs: 1500 };

describe("staleThresholdMs — PACK_PROTOCOL.md §10.2", () => {
  it("is 3 × pollMs at the hot cadence", () => {
    expect(staleThresholdMs(1500)).toBe(4500);
  });

  it("caps at 15s, so a cold cadence can't buy a peer extra green", () => {
    // 3 × 4000 = 12000, still under the cap; 3 × 6000 would be 18000 and is clamped.
    expect(staleThresholdMs(4000)).toBe(12_000);
    expect(staleThresholdMs(6000)).toBe(PRESENTED_STALE_MAX_MS);
    expect(PRESENTED_STALE_MAX_MS).toBe(15_000);
  });

  it("never goes negative on a nonsense cadence", () => {
    expect(staleThresholdMs(-1)).toBe(0);
  });
});

describe("hostHealth — three states and no more", () => {
  it("a reachable, freshly-seen member is live", () => {
    expect(hostHealth(member(), HOT).state).toBe("live");
  });

  it("a member the lead just missed once is STILL live — a single missed poll is invisible", () => {
    const h = hostHealth(member({ reachable: false, lastSeenAt: LEAD_NOW - 3000 }), HOT);
    expect(h.state).toBe("live");
  });

  it("becomes stale once past the threshold, keeping its last-good content", () => {
    const h = hostHealth(member({ reachable: false, lastSeenAt: LEAD_NOW - 5000 }), HOT);
    expect(h.state).toBe("stale");
    expect(h.lastSeenLabel).toMatch(/last seen/);
  });

  it("is stale even when the lead calls it reachable, if the receipt is old", () => {
    // The sweep runs on its own cadence — "it answered, eventually" is not "this is current". This
    // is also what stops a resumed idle lock presenting paused peers as fresh.
    expect(hostHealth(member({ lastSeenAt: LEAD_NOW - 60_000 }), HOT).state).toBe("stale");
  });

  it("is unknown when it has never answered at all — nothing cached to show", () => {
    const h = hostHealth(member({ reachable: false, lastSeenAt: 0 }), HOT);
    expect(h.state).toBe("unknown");
    expect(h.lastSeenLabel).toBe("never seen");
  });

  it("presents an incompatible member immediately, without the missed-poll tolerance", () => {
    // §10.2: incompatible is NOT retried on the poll (slow backoff), so smoothing it would be
    // measuring a sweep that isn't running.
    const h = hostHealth(
      member({ reachable: false, protocol: "incompatible", lastSeenAt: LEAD_NOW }),
      HOT,
    );
    expect(h.state).toBe("stale");
    expect(h.incompatible).toBe(true);
  });

  it("with no lead clock (`at` 0) falls back to the lead's plain boolean, never to 'fresh'", () => {
    expect(hostHealth(member({ reachable: false }), { at: 0, pollMs: 1500 }).state).toBe("stale");
    expect(hostHealth(member(), { at: 0, pollMs: 1500 }).state).toBe("live");
  });

  it("measures on the LEAD's clock — a skewed phone changes nothing", () => {
    // `at` IS the lead's `ts`; nothing in this module reads Date.now(). Running the same input at a
    // wildly different absolute time yields the identical answer.
    const shifted = hostHealth(
      member({ reachable: false, lastSeenAt: LEAD_NOW + 500_000 - 5000 }),
      { at: LEAD_NOW + 500_000, pollMs: 1500 },
    );
    expect(shifted.state).toBe("stale");
  });
});

describe("hostHealth — the lead is tier 1's answer, never this module's", () => {
  it("is always live and always writable, whatever its own fields say", () => {
    const h = hostHealth(member({ id: "bluefin", isLead: true, lastSeenAt: 0 }), HOT);
    expect(h.state).toBe("live");
    expect(h.writable).toBe(true);
    expect(writeRefusal(h)).toBeUndefined();
  });
});

describe("writable vs state — refusal is not smoothed", () => {
  it("a member inside the tolerance still refuses writes if the lead believes it unreachable", () => {
    // The presentation tolerance exists so a chip doesn't flap. A write is irreversible and the lead
    // will answer `host_unreachable` (503, §10.3) regardless, so the gate does NOT get the tolerance.
    const h = hostHealth(member({ reachable: false, lastSeenAt: LEAD_NOW - 1000 }), HOT);
    expect(h.state).toBe("live");
    expect(h.writable).toBe(false);
    expect(writeRefusal(h)).toMatch(/workshop is unreachable/);
  });

  it("names the member and its last-seen age (§10.3)", () => {
    const h = hostHealth(member({ reachable: false, lastSeenAt: LEAD_NOW - 600_000 }), HOT);
    expect(writeRefusal(h)).toBe("workshop is unreachable · last seen 10m");
  });

  it("refuses an incompatible member with the peer's reason verbatim", () => {
    const h = hostHealth(
      member({ protocol: "incompatible", protocolDetail: "pack protocol 2 (this collie speaks 1)" }),
      HOT,
    );
    expect(writeRefusal(h)).toBe(
      "workshop is running an incompatible Collie — pack protocol 2 (this collie speaks 1)",
    );
  });

  it("allows the write when the host is fine, and when there is no host at all (solo)", () => {
    expect(writeRefusal(hostHealth(member(), HOT))).toBeUndefined();
    expect(writeRefusal(undefined)).toBeUndefined();
  });
});

describe("hostHealthMap / healthFor / departedHealth", () => {
  it("answers nothing for a solo snapshot — no `servers`, no per-host machinery", () => {
    const map = hostHealthMap(undefined, HOT);
    expect(map.size).toBe(0);
    expect(healthFor(map, undefined)).toBeUndefined();
    expect(healthFor(map, "workshop")).toBeUndefined();
  });

  it("keys every member by id", () => {
    const map = hostHealthMap([member({ id: "a", isLead: true }), member({ id: "b" })], HOT);
    expect([...map.keys()]).toEqual(["a", "b"]);
  });

  it("treats a departed member as unknown-and-unwritable, not as fine", () => {
    const h = departedHealth("ghost");
    expect(h.state).toBe("unknown");
    expect(h.writable).toBe(false);
    expect(writeRefusal(h)).toMatch(/ghost is unreachable/);
  });
});

describe("recovery needs no machinery — it is just the next snapshot", () => {
  it("a member reported reachable again is live on the very next derivation", () => {
    const down = member({ reachable: false, lastSeenAt: LEAD_NOW - 30_000 });
    expect(hostHealth(down, HOT).state).toBe("stale");
    // The ordinary poll lands: the lead re-stamps lastSeenAt and flips reachable.
    const up = member({ reachable: true, lastSeenAt: LEAD_NOW + 1500 });
    expect(hostHealth(up, { at: LEAD_NOW + 1500, pollMs: 1500 }).state).toBe("live");
    expect(writeRefusal(hostHealth(up, { at: LEAD_NOW + 1500, pollMs: 1500 }))).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SEAM. These two are the reason the module exists at all.
// ─────────────────────────────────────────────────────────────────────────────

describe("tier 2 holds no clock and no state", () => {
  it("is a pure derivation — same inputs, same outputs, no accumulation", () => {
    const s = member({ reachable: false, lastSeenAt: LEAD_NOW - 5000 });
    const a = hostHealth(s, HOT);
    const b = hostHealth(s, HOT);
    expect(a).toEqual(b);
    // Deliberately no __reset* export to call between cases: there is nothing to reset, which is
    // the difference in kind from tier 1 (whose test hook exists precisely because it holds state).
    expect(Object.keys(hostHealthModule)).not.toContain("__resetHostHealth");
  });

  it("registers no timers or listeners at import time", () => {
    // Comments stripped: this module's header NAMES the machinery it refuses to use, and a grep that
    // can't tell a prohibition from a use would fail on the documentation of its own invariant.
    const src = stripComments(readFileSync(join(__dirname, "host-health.ts"), "utf8"));
    expect(src).not.toMatch(/setTimeout|setInterval|addEventListener|useSyncExternalStore/);
    // `let`/`var` at module scope would be mutable state; the module has none.
    expect(src).not.toMatch(/^(let|var) /m);
  });
});

describe("tier 1 stays single — connection-health.ts gains no host dimension", () => {
  it("exports nothing that takes a host argument", () => {
    for (const [name, value] of Object.entries(connectionHealth)) {
      if (typeof value !== "function") continue;
      // Every mutator/reader is nullary; a host-keyed variant would have to take one.
      // `subscribeHealth(cb)` is the store's one unavoidable parameter and it is a callback, not a
      // key. Everything else is nullary — a `markLive(host)` or a `useConnectionHealth(host)` would
      // show up here as an arity nobody signed off on.
      expect({ name, arity: value.length }).toEqual({
        name,
        arity: name === "subscribeHealth" ? 1 : 0,
      });
    }
  });

  it("mentions neither `host` nor `reachable` anywhere in its source", () => {
    // The invariant the spec pins by grep: tier 1 knows nothing about pack members.
    const src = stripComments(readFileSync(join(__dirname, "connection-health.ts"), "utf8"));
    expect(src).not.toMatch(/\breachable\b/);
    expect(src).not.toMatch(/\bhosts?\b/i);
  });
});
