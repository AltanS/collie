import { describe, expect, it, vi } from "vitest";

import { badgeTotal, parseBadgeSlots, recordSlot, showBadge, slotCount, withSlot, type BadgeCaches, type BadgePush } from "./app-badge";

/** A push body as the worker gets it: parsed JSON of whatever shape the sender wrote. */
function wire(text: string): BadgePush {
  return JSON.parse(text);
}

// The icon's count. The load-bearing rules: only a herd push moves it, a bridge that predates the
// field never zeroes a slot, a retraction does, and the icon shows every slot added up.

describe("slotCount", () => {
  it("reads a herd push's count, on the primary, a named session and a peer alike", () => {
    expect(slotCount({ tag: "collie:herd", badge: 2 })).toBe(2);
    expect(slotCount({ tag: "collie:herd:work", badge: 0 })).toBe(0);
    expect(slotCount({ tag: "collie:herd@laptop", badge: 1 })).toBe(1);
  });

  it("zeroes the slot a retraction closes", () => {
    expect(slotCount({ type: "clear", tag: "collie:herd" })).toBe(0);
  });

  it("says nothing for another kind of push, or a herd push without the field", () => {
    expect(slotCount({ type: "update", tag: "collie:update" })).toBeUndefined();
    expect(slotCount({ type: "machine", tag: "collie:herd" })).toBeUndefined();
    expect(slotCount({ tag: "collie:herd" })).toBeUndefined();
    expect(slotCount({ badge: 3 })).toBeUndefined();
  });

  it("refuses a count that is not a whole, non-negative number", () => {
    expect(slotCount({ tag: "collie:herd", badge: -1 })).toBeUndefined();
    expect(slotCount({ tag: "collie:herd", badge: 1.5 })).toBeUndefined();
  });

  it("treats a badge that is not a number like a missing one, and never throws", () => {
    // A push body is parsed JSON from the wire, so the field can be any type.
    for (const badge of ['"2"', '""', "null", "true", "false", "{}", "[]", "[2]", '"NaN"']) {
      expect(slotCount(wire(`{"tag":"collie:herd","badge":${badge}}`))).toBeUndefined();
    }
    for (const body of ["{}", "[]", '{"badge":2}', '{"type":"clear"}', '{"tag":5}', '{"tag":null,"badge":2}', '{"tag":5,"type":"clear"}', '{"tag":["collie:herd"],"badge":1}']) {
      expect(() => slotCount(wire(body))).not.toThrow();
      expect(slotCount(wire(body))).toBeUndefined();
    }
  });
});

describe("a herd push from an older bridge (no badge field, or a badge that is no number)", () => {
  // What `handlePush` in sw.ts does: record a slot only when `slotCount` has a count to give.
  function worker() {
    const store = new Map<string, string>();
    const caches: BadgeCaches = {
      open: async () => ({
        match: async (key: RequestInfo | URL) => {
          const text = store.get(String(key));
          return text === undefined ? undefined : new Response(text);
        },
        put: async (key: RequestInfo | URL, res: Response) => void store.set(String(key), await res.text()),
      }),
    };
    const shown: number[] = [];
    const target = { setAppBadge: async (n?: number) => void shown.push(n ?? 0), clearAppBadge: async () => void shown.push(0) };
    return {
      shown,
      store,
      async push(body: BadgePush) {
        const count = slotCount(body);
        if (count !== undefined && body.tag !== undefined) await showBadge(target, await recordSlot(caches, "https://h", "/", body.tag, count));
      },
    };
  }

  it("leaves the stored slot count as it was", async () => {
    const w = worker();
    await w.push({ tag: "collie:herd", badge: 2 });
    const stored = [...w.store.values()];
    for (const old of ['{"tag":"collie:herd","title":"Done"}', '{"tag":"collie:herd","badge":"3"}', '{"tag":"collie:herd","badge":null}', '{"tag":"collie:herd","badge":{"n":1}}']) {
      await expect(w.push(wire(old))).resolves.toBeUndefined();
    }
    expect([...w.store.values()]).toEqual(stored);
    expect(w.shown).toEqual([2]);
  });

  it("is still closed by a retraction", async () => {
    const w = worker();
    await w.push({ tag: "collie:herd", badge: 2 });
    await w.push({ tag: "collie:herd" });
    await w.push({ type: "clear", tag: "collie:herd" });
    expect(w.shown).toEqual([2, 0]);
  });
});

describe("the slots", () => {
  it("adds every slot up, and drops a slot that reaches zero", () => {
    const slots = withSlot(withSlot({}, "collie:herd", 2), "collie:herd@laptop", 1);
    expect(badgeTotal(slots)).toBe(3);
    expect(withSlot(slots, "collie:herd", 0)).toEqual({ "collie:herd@laptop": 1 });
  });

  it("keeps only whole positive counts when read back", () => {
    expect(parseBadgeSlots('{"a":2,"b":0,"c":-1,"d":"3","e":1.5}')).toEqual({ a: 2 });
    expect(parseBadgeSlots("not json")).toEqual({});
  });

  it("stores a slot and answers the total across every slot", async () => {
    const store = new Map<string, string>();
    const caches: BadgeCaches = {
      open: async () => ({
        match: async (key: RequestInfo | URL) => {
          const text = store.get(String(key));
          return text === undefined ? undefined : new Response(text);
        },
        put: async (key: RequestInfo | URL, res: Response) => void store.set(String(key), await res.text()),
      }),
    };
    expect(await recordSlot(caches, "https://h", "/", "collie:herd", 2)).toBe(2);
    expect(await recordSlot(caches, "https://h", "/", "collie:herd@laptop", 1)).toBe(3);
    expect(await recordSlot(caches, "https://h", "/", "collie:herd", 0)).toBe(1);
  });
});

describe("showBadge", () => {
  it("sets a count, and clears the icon at zero", async () => {
    const target = { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) };
    await showBadge(target, 2);
    expect(target.setAppBadge).toHaveBeenCalledWith(2);
    await showBadge(target, 0);
    expect(target.clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it("does nothing where the API is missing, and swallows a refusal", async () => {
    await expect(showBadge({}, 2)).resolves.toBeUndefined();
    await expect(showBadge(undefined, 2)).resolves.toBeUndefined();
    const refusing = { setAppBadge: async () => Promise.reject(new Error("NotAllowedError")) };
    await expect(showBadge(refusing, 2)).resolves.toBeUndefined();
  });
});
