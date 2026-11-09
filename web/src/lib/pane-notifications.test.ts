import { describe, expect, it, vi } from "vitest";

import { badgeKey, recordSlot, type BadgeCaches } from "./app-badge";
import {
  closePaneNotificationsIn,
  isPaneNotification,
  paneSlotTag,
  zeroPaneSlotIn,
  type NotificationSource,
} from "./pane-notifications";

// The bridge skips a pane's clear to a device whose page read the pane (bridge/push.ts, rule 2), on
// the promise that this page closed its own notification for it first. So the close must cover the
// pane's own notification on the machine and in the session the read named, and nothing else.
describe("isPaneNotification", () => {
  it("matches the pane on this machine's primary session", () => {
    expect(isPaneNotification({ paneId: "w1:p1" }, "w1:p1")).toBe(true);
    expect(isPaneNotification({ paneId: "w1:p1" }, "w1:p1", { host: "", session: "" })).toBe(true);
  });

  it("matches a member's pane and a named session only under that same scope", () => {
    expect(isPaneNotification({ paneId: "w1:p1", host: "laptop" }, "w1:p1", { host: "laptop" })).toBe(true);
    expect(isPaneNotification({ paneId: "w1:p1", host: "laptop" }, "w1:p1")).toBe(false);
    expect(isPaneNotification({ paneId: "w1:p1" }, "w1:p1", { host: "laptop" })).toBe(false);
    expect(isPaneNotification({ paneId: "w1:p1", session: "work" }, "w1:p1", { session: "work" })).toBe(true);
    expect(isPaneNotification({ paneId: "w1:p1", session: "work" }, "w1:p1")).toBe(false);
  });

  it("leaves another pane, a digest with no pane, and a machine or update alert alone", () => {
    expect(isPaneNotification({ paneId: "w1:p2" }, "w1:p1")).toBe(false);
    expect(isPaneNotification({}, "w1:p1")).toBe(false);
    expect(isPaneNotification(null, "w1:p1")).toBe(false);
    expect(isPaneNotification({ paneId: "w1:p1", target: "machine" }, "w1:p1")).toBe(false);
  });
});

describe("closePaneNotificationsIn", () => {
  it("closes exactly the pane's own notifications", async () => {
    const mine = { data: { paneId: "w1:p1" }, close: vi.fn() };
    const other = { data: { paneId: "w1:p2" }, close: vi.fn() };
    const digest = { data: {}, close: vi.fn() };
    const source: NotificationSource = { getNotifications: async () => [mine, other, digest] };
    await closePaneNotificationsIn(source, "w1:p1");
    expect(mine.close).toHaveBeenCalledOnce();
    expect(other.close).not.toHaveBeenCalled();
    expect(digest.close).not.toHaveBeenCalled();
  });

  it("never throws when the list is refused", async () => {
    const source: NotificationSource = { getNotifications: () => Promise.reject(new Error("no")) };
    await expect(closePaneNotificationsIn(source, "w1:p1")).resolves.toBeUndefined();
  });
});

// The page does on this device what the pane's clear would: the bridge then skips that clear here,
// so the slot's share of the icon count must go to zero from the page too.
describe("paneSlotTag — the slot the bridge's sink opened for the pane", () => {
  it("names it the way bridge/server.ts seenSlotTag does", () => {
    expect(paneSlotTag("w1:p1")).toBe("collie:herd:w1:p1");
    expect(paneSlotTag("w1:p1", { session: "work" })).toBe("collie:herd:work:w1:p1");
    expect(paneSlotTag("w1:p1", { host: "laptop" })).toBe("collie:herd@laptop:w1:p1");
    expect(paneSlotTag("w1:p1", { host: "laptop", session: "work" })).toBeNull();
  });
});

describe("zeroPaneSlotIn", () => {
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
    return { caches, store };
  }

  it("zeroes the pane's slot and shows the total of the others", async () => {
    const { caches, store } = memoryCaches();
    await recordSlot(caches, "https://h", "/", "collie:herd:w1:p1", 1);
    await recordSlot(caches, "https://h", "/", "collie:herd:w1:p2", 1);
    const target = { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) };
    await zeroPaneSlotIn({ caches, origin: "https://h", mount: "/", target }, "w1:p1");
    expect(JSON.parse(store.get(badgeKey("https://h", "/"))!)).toEqual({ "collie:herd:w1:p2": 1 });
    expect(target.setAppBadge).toHaveBeenCalledWith(1);
  });

  it("clears the icon when the pane was the last slot counted", async () => {
    const { caches } = memoryCaches();
    await recordSlot(caches, "https://h", "/", "collie:herd@laptop:w1:p1", 1);
    const target = { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) };
    await zeroPaneSlotIn({ caches, origin: "https://h", mount: "/", target }, "w1:p1", { host: "laptop" });
    expect(target.clearAppBadge).toHaveBeenCalledOnce();
  });

  it("touches nothing for a scope that names no slot, and never throws on a refused store", async () => {
    const target = { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) };
    const refused: BadgeCaches = { open: () => Promise.reject(new Error("no")) };
    await zeroPaneSlotIn({ caches: refused, origin: "https://h", mount: "/", target }, "w1:p1", { host: "laptop", session: "x" });
    await expect(zeroPaneSlotIn({ caches: refused, origin: "https://h", mount: "/", target }, "w1:p1")).resolves.toBeUndefined();
    expect(target.setAppBadge).not.toHaveBeenCalled();
    expect(target.clearAppBadge).not.toHaveBeenCalled();
  });
});
