import { describe, expect, it } from "vitest";

import { WAY_OUT_CASES, wayOutCase } from "@/test/way-out-states";
import { ageWords, DIALOG_PLACEHOLDER, wayOut, wayOutState, WAY_OUT_STATES, type WayOutReadings } from "./way-out";
import { sendSlot, UNREAD_SURFACE } from "./send-slot";

// The way out as one pure function (M56 spec 07): the state of a Surface and the three facts, whether the
// Keys dock opens and sends, and the words the placeholder names the state with.

const NOW = 1_000_000;
const READINGS: WayOutReadings = { keysCapable: true, readAt: NOW - 12_000, now: NOW, unread: false, shell: false };
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

  it("names every state in words, but free and offline keep the ordinary placeholder", () => {
    const keys = new Set<string>();
    for (const c of WAY_OUT_CASES) {
      const words = wayOut(c.surface, facts(c), READINGS).words;
      if (c.state === "free" || c.state === "offline") {
        expect(words, c.state).toBeNull();
        continue;
      }
      expect(words, c.state).not.toBeNull();
      const id = `${words!.key}:${JSON.stringify(words!.params ?? {})}`;
      expect(keys.has(id), `${c.state} repeats ${id}`).toBe(false);
      keys.add(id);
    }
  });

  it("an ask is named by its kind", () => {
    const ask = (kind: "menu" | "permission" | "question") => ({
      revision: 1,
      turn: "idle" as const,
      modal: { ask: { id: "a", kind, options: [], channel: "keys" as const, hash: "h" } },
      composer: "unknown" as const,
    });
    for (const kind of ["menu", "permission", "question"] as const) {
      expect(wayOut(ask(kind), facts(wayOutCase("free")), READINGS).words?.key).toBe(DIALOG_PLACEHOLDER[kind]);
    }
  });

  it("a stale read carries its age, and a stale read with no stamp says only that it is old", () => {
    const c = wayOutCase("stale");
    expect(wayOut(c.surface, facts(c), READINGS).words).toEqual({ key: "composer.placeholder.stale", params: { age: "12 s" } });
    expect(wayOut(c.surface, facts(c), { ...READINGS, readAt: undefined }).words).toEqual({ key: "composer.placeholder.staleNoAge" });
  });

  it("a pane not read yet and a bare shell keep the ordinary placeholder for no match", () => {
    const c = wayOutCase("no-match");
    expect(wayOut(c.surface, facts(c), READINGS).words?.key).toBe("composer.placeholder.noMatch");
    expect(wayOut(c.surface, facts(c), { ...READINGS, unread: true }).words).toBeNull();
    expect(wayOut(c.surface, facts(c), { ...READINGS, shell: true }).words).toBeNull();
  });
});

describe("ageWords", () => {
  it("reads seconds, minutes, hours and days, and nothing without a stamp", () => {
    expect(ageWords(undefined, NOW)).toBeNull();
    expect(ageWords(NOW - 400, NOW)).toBe("0 s");
    expect(ageWords(NOW - 59_000, NOW)).toBe("59 s");
    expect(ageWords(NOW - 125_000, NOW)).toBe("2 min");
    expect(ageWords(NOW - 3 * 3_600_000, NOW)).toBe("3 h");
    expect(ageWords(NOW - 50 * 3_600_000, NOW)).toBe("2 d");
    expect(ageWords(NOW + 5_000, NOW)).toBe("0 s");
  });
});
