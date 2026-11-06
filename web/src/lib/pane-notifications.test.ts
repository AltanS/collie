import { describe, expect, it, vi } from "vitest";

import { closePaneNotificationsIn, isPaneNotification, type NotificationSource } from "./pane-notifications";

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
