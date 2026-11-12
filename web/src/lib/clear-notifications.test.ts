import { afterEach, describe, expect, it, vi } from "vitest";

import { badgeKey, parseBadgeSlots, recordSlot, type BadgeCaches } from "./app-badge";
import { clearDeviceNotifications, closeAllNotificationsIn, zeroSlotsIn, type ShownSource } from "./clear-notifications";
import { zeroPaneSlotIn } from "./pane-notifications";

// Clear all, on the page's own device: what a pane read does here (lib/pane-notifications.ts), for
// every slot the bridge cleared. Every notification closes, whatever its tag; each cleared slot's
// count goes to zero; a slot still blocked keeps its count. Each half says when it could not.

const ORIGIN = "https://h";

function memoryCaches() {
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
  const slots = (origin = ORIGIN) => parseBadgeSlots(store.get(badgeKey(origin, "/")) ?? "{}");
  return { caches, slots };
}

const badgeTarget = () => ({ setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("closeAllNotificationsIn", () => {
  it("closes every notification, a blocked pane's, a summary and an update alert alike", async () => {
    const shown = [
      { data: { paneId: "w1:p1" }, tag: "collie:herd:w1:p1", close: vi.fn() },
      { data: {}, tag: "collie:herd@laptop", close: vi.fn() },
      { data: { target: "update" }, tag: "collie:update", close: vi.fn() },
    ];
    const source: ShownSource = { getNotifications: async () => shown };
    await expect(closeAllNotificationsIn(source)).resolves.toBe("done");
    for (const n of shown) expect(n.close).toHaveBeenCalledOnce();
  });

  it("says it failed, and never throws, when the list is refused", async () => {
    const source: ShownSource = { getNotifications: () => Promise.reject(new Error("no")) };
    await expect(closeAllNotificationsIn(source)).resolves.toBe("failed");
  });
});

describe("zeroSlotsIn", () => {
  it("zeroes each cleared slot, keeps a blocked one counting, and shows the new total", async () => {
    const { caches, slots } = memoryCaches();
    await recordSlot(caches, ORIGIN, "/", "collie:herd:w1:p1", 1); // blocked: not in the bridge's list
    await recordSlot(caches, ORIGIN, "/", "collie:herd:w1:p2", 1);
    await recordSlot(caches, ORIGIN, "/", "collie:herd:work:w2:p1", 1);
    const target = badgeTarget();
    const home = { caches, origin: ORIGIN, mount: "/", target };
    await expect(zeroSlotsIn(home, ["collie:herd:w1:p2", "collie:herd:work:w2:p1"])).resolves.toBe("done");
    expect(slots()).toEqual({ "collie:herd:w1:p1": 1 });
    expect(target.setAppBadge).toHaveBeenCalledWith(1);
  });

  it("is what a read of each of those panes does to the store, in one write", async () => {
    const a = memoryCaches();
    const b = memoryCaches();
    for (const { caches } of [a, b]) {
      await recordSlot(caches, ORIGIN, "/", "collie:herd:w1:p1", 1);
      await recordSlot(caches, ORIGIN, "/", "collie:herd:w1:p2", 1);
    }
    await zeroPaneSlotIn({ caches: a.caches, origin: ORIGIN, mount: "/", target: badgeTarget() }, "w1:p2");
    await zeroSlotsIn({ caches: b.caches, origin: ORIGIN, mount: "/", target: badgeTarget() }, ["collie:herd:w1:p2"]);
    expect(b.slots()).toEqual(a.slots());
  });

  it("says it failed, and never throws, when Cache Storage refuses", async () => {
    const refused: BadgeCaches = { open: () => Promise.reject(new Error("no")) };
    await expect(zeroSlotsIn({ caches: refused, origin: ORIGIN, mount: "/", target: badgeTarget() }, ["collie:herd:w1:p2"])).resolves.toBe(
      "failed",
    );
  });
});

describe("clearDeviceNotifications — what it says it did", () => {
  it("a browser with no service worker and no Cache Storage has nothing to clear, which is not a failure", async () => {
    vi.stubGlobal("caches", undefined);
    await expect(clearDeviceNotifications([])).resolves.toEqual({ notifications: "absent", countStore: "absent" });
  });

  it("a registration that refuses, or a store that refuses, is said as exactly that", async () => {
    vi.stubGlobal("caches", { open: () => Promise.reject(new Error("quota")) });
    Object.defineProperty(navigator, "serviceWorker", {
      value: { getRegistration: () => Promise.reject(new Error("no")) },
      configurable: true,
    });
    try {
      await expect(clearDeviceNotifications(["collie:herd:w1:p2"])).resolves.toEqual({ notifications: "failed", countStore: "failed" });
    } finally {
      // SAFETY: defined above as an own, configurable property of the jsdom navigator.
      delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    }
  });

  it("reaching Cache Storage itself throws: that half fails, and the notifications are still closed", async () => {
    Object.defineProperty(globalThis, "caches", {
      get: () => {
        throw new Error("SecurityError");
      },
      configurable: true,
    });
    const shown = { tag: "collie:herd:w1:p1", close: vi.fn() };
    Object.defineProperty(navigator, "serviceWorker", {
      value: { getRegistration: async () => ({ getNotifications: async () => [shown] }) },
      configurable: true,
    });
    try {
      await expect(clearDeviceNotifications(["collie:herd:w1:p2"])).resolves.toEqual({ notifications: "done", countStore: "failed" });
      expect(shown.close).toHaveBeenCalledOnce();
    } finally {
      // SAFETY: `caches` was defined above as an own, configurable property of the jsdom global.
      delete (globalThis as { caches?: unknown }).caches;
      // SAFETY: `serviceWorker` was defined above as an own, configurable property of the jsdom navigator.
      delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    }
  });

  it("closes the registration's notifications and zeroes the cleared slots when both are there", async () => {
    const { caches, slots } = memoryCaches();
    await recordSlot(caches, location.origin, "/", "collie:herd:w1:p1", 1);
    await recordSlot(caches, location.origin, "/", "collie:herd:w1:p2", 1);
    vi.stubGlobal("caches", caches);
    const shown = { tag: "collie:herd:w1:p1", close: vi.fn() };
    Object.defineProperty(navigator, "serviceWorker", {
      value: { getRegistration: async () => ({ getNotifications: async () => [shown] }) },
      configurable: true,
    });
    try {
      await expect(clearDeviceNotifications(["collie:herd:w1:p2"])).resolves.toEqual({ notifications: "done", countStore: "done" });
      expect(shown.close).toHaveBeenCalledOnce();
      expect(slots(location.origin)).toEqual({ "collie:herd:w1:p1": 1 });
    } finally {
      // SAFETY: as above.
      delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    }
  });
});
