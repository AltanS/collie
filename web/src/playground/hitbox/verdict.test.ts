import { describe, expect, it } from "vitest";

import type { Target } from "./scan";
import { judge, reachMin } from "./verdict";

function target(over: Partial<Target> = {}): Target {
  return {
    name: "x",
    selector: "button",
    tag: "button",
    role: null,
    box: { x: 0, y: 0, w: 48, h: 48 },
    hit: { x: 0, y: 0, w: 48, h: 48 },
    hitShare: 1,
    restShare: null,
    restCoveredBy: [],
    reach: { top: 0, right: 0, bottom: 0, left: 0 },
    probeMisses: [],
    probeCount: 17,
    coveredBy: [],
    ink: null,
    shell: null,
    gap: 20,
    gapTo: null,
    events: ["onClick"],
    touchAction: "auto",
    pointerEvents: "auto",
    disabled: false,
    inline: false,
    fixed: false,
    opacity: 1,
    edge: { left: 0, right: 0 },
    holdGuard: false,
    ...over,
  };
}

describe("the hitbox verdict", () => {
  it("passes a 48px button with room around it", () => {
    expect(judge(target())).toEqual({ verdict: "ok", flags: [], severity: 0 });
  });

  it("reads what the finger reaches, not what is drawn: a 28px button with a 44px reach is ok", () => {
    const t = target({ box: { x: 0, y: 0, w: 28, h: 28 }, hit: { x: -8, y: -8, w: 44, h: 44 } });
    expect(reachMin(t)).toBe(44);
    expect(judge(t).verdict).toBe("ok");
  });

  it("calls a 32px close button small, worse when a neighbour is near", () => {
    const alone = judge(target({ hit: { x: 0, y: 0, w: 32, h: 32 }, gap: 30 }));
    const crowded = judge(target({ hit: { x: 0, y: 0, w: 32, h: 32 }, gap: 4, gapTo: "Settings" }));
    expect(alone.verdict).toBe("small");
    expect(crowded.severity).toBeGreaterThan(alone.severity);
    expect(crowded.flags[0]).toContain("4px from Settings");
  });

  it("puts covered first when a layer lies over most of the box", () => {
    const t = target({ hitShare: 0.5, coveredBy: ["button[fab] x40"] });
    expect(judge(t).verdict).toBe("covered");
  });

  it("counts a target that is covered only where it first stands, less than one covered after centring", () => {
    const rest = judge(target({ restShare: 0.8, restCoveredBy: ["button[fab] x9"] }));
    const always = judge(target({ hitShare: 0.8, coveredBy: ["button[fab] x9"] }));
    expect(rest.verdict).toBe("covered");
    expect(rest.severity).toBeLessThan(always.severity);
  });

  it("marks a target that moves, and a hold guard as dead time", () => {
    expect(judge(target(), { shiftPx: 45 }).verdict).toBe("shifts");
    expect(judge(target({ holdGuard: true })).verdict).toBe("dead-time");
    expect(judge(target(), { shiftPx: 0.5 }).verdict).toBe("ok");
  });

  it("does not read the share of a wrapped inline link", () => {
    expect(judge(target({ inline: true, hitShare: 0.5, coveredBy: ["p x9"] })).verdict).toBe("ok");
  });

  it("calls a target nothing reaches covered", () => {
    expect(judge(target({ hit: null, hitShare: 0, coveredBy: ["nav x300"] })).verdict).toBe("covered");
  });
});
