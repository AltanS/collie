import { describe, expect, it, vi } from "vitest";

import { badgeTotal, parseBadgeSlots, recordSlot, showBadge, slotCount, withSlot, type BadgeCaches } from "./app-badge";

// The icon's count. The load-bearing rules: only a herd push moves it, a bridge that predates the
// field never zeroes a slot, a retraction does, and the icon shows every slot added up.

describe("slotCount", () => {
  it("reads a herd push's blocked count, on the primary, a named session and a peer alike", () => {
    expect(slotCount({ tag: "collie:herd", blocked: 2 })).toBe(2);
    expect(slotCount({ tag: "collie:herd:work", blocked: 0 })).toBe(0);
    expect(slotCount({ tag: "collie:herd@laptop", blocked: 1 })).toBe(1);
  });

  it("zeroes the slot a retraction closes", () => {
    expect(slotCount({ type: "clear", tag: "collie:herd" })).toBe(0);
  });

  it("says nothing for another kind of push, or a herd push without the field", () => {
    expect(slotCount({ type: "update", tag: "collie:update" })).toBeUndefined();
    expect(slotCount({ type: "machine", tag: "collie:herd" })).toBeUndefined();
    expect(slotCount({ tag: "collie:herd" })).toBeUndefined();
    expect(slotCount({ blocked: 3 })).toBeUndefined();
  });

  it("refuses a count that is not a whole, non-negative number", () => {
    expect(slotCount({ tag: "collie:herd", blocked: -1 })).toBeUndefined();
    expect(slotCount({ tag: "collie:herd", blocked: 1.5 })).toBeUndefined();
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
