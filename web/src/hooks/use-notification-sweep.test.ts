import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeData } from "@/lib/loaders";
import type { AgentStatus, AgentView } from "@/lib/types";

import { useNotificationSweep } from "./use-notification-sweep";

// When the page sweeps its notifications (lib/notification-sweep.ts decides which): on the first
// live snapshot after it becomes visible, and when a snapshot changes what needs you. Never on a
// snapshot that is not a fresh read, which could close a notification that arrived after it.

function pane(paneId: string, status: AgentStatus): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "proj",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status,
    cwd: "/home/k/proj",
    focused: false,
  };
}

function home(agents: AgentView[], over: Partial<HomeData> = {}): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents,
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
    ...over,
  };
}

let visibility: DocumentVisibilityState = "visible";
const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
};

const stale = { tag: "collie:herd:w1:p1", data: { paneId: "w1:p1" }, close: vi.fn() };
const getNotifications = vi.fn(async () => [stale]);

beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: async () => ({ getNotifications }) },
  });
  getNotifications.mockClear();
  stale.close.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("useNotificationSweep", () => {
  it("sweeps on the first live snapshot and closes what no longer needs you", async () => {
    renderHook(() => useNotificationSweep(home([pane("w1:p1", "working")])));
    await waitFor(() => expect(stale.close).toHaveBeenCalledOnce());
  });

  it("judges nothing by a saved copy, a failed read or a mux that is down", async () => {
    const { rerender } = renderHook(({ data }) => useNotificationSweep(data), {
      initialProps: { data: home([pane("w1:p1", "working")], { stale: true }) },
    });
    rerender({ data: home([pane("w1:p1", "working")], { error: true }) });
    rerender({ data: home([], { bridge: "disconnected" }) });
    rerender({ data: home([pane("w1:p1", "working")], { lastSeenAt: 1 }) });
    await new Promise((r) => setTimeout(r, 20));
    expect(getNotifications).not.toHaveBeenCalled();
  });

  it("sweeps once per picture while open, and again on the first snapshot after a return", async () => {
    const { rerender } = renderHook(({ data }) => useNotificationSweep(data), {
      initialProps: { data: home([pane("w1:p1", "blocked")]) },
    });
    await waitFor(() => expect(getNotifications).toHaveBeenCalledTimes(1));
    expect(stale.close).not.toHaveBeenCalled();
    // A poll that changes nothing about what needs you does not ask again.
    rerender({ data: home([pane("w1:p1", "blocked")]) });
    await new Promise((r) => setTimeout(r, 20));
    expect(getNotifications).toHaveBeenCalledTimes(1);

    // Hidden: no sweep, even if a snapshot lands.
    setVisibility("hidden");
    rerender({ data: home([pane("w1:p1", "working")]) });
    await new Promise((r) => setTimeout(r, 20));
    expect(getNotifications).toHaveBeenCalledTimes(1);

    // Back: the snapshot still on screen is from before; the next one sweeps, same picture or not.
    setVisibility("visible");
    await new Promise((r) => setTimeout(r, 20));
    expect(getNotifications).toHaveBeenCalledTimes(1);
    rerender({ data: home([pane("w1:p1", "working")]) });
    await waitFor(() => expect(stale.close).toHaveBeenCalledOnce());
    expect(getNotifications).toHaveBeenCalledTimes(2);
  });
});
