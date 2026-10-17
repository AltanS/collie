import { describe, expect, it } from "vitest";

import { WAY_OUT_CASES, wayOutCase } from "@/test/way-out-states";
import { wayOut, wayOutState, WAY_OUT_STATES, type WayOutReadings } from "./way-out";
import { sendSlot, UNREAD_SURFACE } from "./send-slot";

// The way out as one pure function (M56 spec 07): the state of a Surface and the three facts, whether the
// Keys dock opens and sends.

const READINGS: WayOutReadings = { keysCapable: true };
const facts = (c: ReturnType<typeof wayOutCase>) => ({ gone: c.gone, readOnly: c.readOnly, offline: c.offline });

describe("wayOutState", () => {
  it.each(WAY_OUT_CASES.map((c) => [c.state, c] as const))("%s: the case table gives its own state", (state, c) => {
    expect(wayOutState(c.surface, facts(c))).toBe(state);
  });

  it("covers every word once, in the table's order", () => {
    expect(WAY_OUT_CASES.map((c) => c.state)).toEqual([...WAY_OUT_STATES]);
    expect(new Set(WAY_OUT_STATES).size).toBe(13);
    expect(WAY_OUT_CASES.map((c) => c.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it("agrees with the Send slot on which states are the manual Send and which wait for a read", () => {
    for (const c of WAY_OUT_CASES) {
      const slot = sendSlot(c.surface, facts(c));
      if (c.state === "unreadable" || c.state === "no-match") expect(slot, c.state).toBe("manual");
      if (c.state === "contested" || c.state === "stale" || c.state === "torn") expect(slot, c.state).toBe("wait");
    }
  });

  it("an unknown screen with no reason, and the stand-in for a pane not read yet, are no-match", () => {
    expect(wayOutState({ revision: 1, turn: "idle", modal: "none", composer: "unknown" }, facts(wayOutCase("free")))).toBe("no-match");
    expect(wayOutState(UNREAD_SURFACE, facts(wayOutCase("free")))).toBe("no-match");
  });

  it("the facts outrank the Surface: gone, then read-only, then a box out of reach, then offline", () => {
    const ask = wayOutCase("ask").surface;
    expect(wayOutState(ask, { gone: true, readOnly: true, offline: true })).toBe("gone");
    expect(wayOutState(ask, { gone: false, readOnly: true, offline: true })).toBe("readOnly");
    expect(wayOutState(wayOutCase("unreachable").surface, { gone: false, readOnly: false, offline: true })).toBe("unreachable");
    expect(wayOutState(ask, { gone: false, readOnly: false, offline: true })).toBe("offline");
  });
});

describe("wayOut", () => {
  it("opens the Keys dock in every state but gone and read-only, and sends keys in every one but those and offline", () => {
    for (const c of WAY_OUT_CASES) {
      const out = wayOut(c.surface, facts(c), READINGS);
      const closed = c.state === "gone" || c.state === "readOnly";
      expect(out.keysOpen, c.state).toBe(!closed);
      expect(out.keysSendable, c.state).toBe(!closed && c.state !== "offline");
    }
  });

  it("closes the dock when the multiplexer sends no key at all, in any state", () => {
    for (const c of WAY_OUT_CASES) {
      const out = wayOut(c.surface, facts(c), { ...READINGS, keysCapable: false });
      expect(out.keysOpen, c.state).toBe(false);
      expect(out.keysSendable, c.state).toBe(false);
    }
  });

  it("a box out of reach, a refusal's state and a stale read keep the dock", () => {
    for (const state of ["unreachable", "unreadable", "no-match", "contested", "stale", "torn", "running", "ask", "draft"] as const) {
      const c = wayOutCase(state);
      expect(wayOut(c.surface, facts(c), READINGS).keysSendable, state).toBe(true);
    }
  });
});
