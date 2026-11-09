import { describe, expect, it, vi } from "vitest";

import { badgeKey, recordSlot, type BadgeCaches } from "./app-badge";
import { herdSlotTag, paneSlotTag } from "./pane-notifications";
import {
  staleNotifications,
  sweepNotificationsIn,
  type ShownNotification,
  type SweepBadge,
  type SweepView,
} from "./notification-sweep";
import type { NotifData } from "./push-decision";
import type { AgentStatus, AgentView, ServerSummary, SessionSummary } from "./types";

// The bridge skips a clear once a phone's daily budget of silent pushes is spent (bridge/push.ts,
// rule 4). The notification it would have closed must then go without a push: the page closes it
// once a live snapshot says nothing waits on it, and never closes one the snapshot cannot answer for.

function pane(paneId: string, status: AgentStatus, extra: Partial<AgentView> = {}): AgentView {
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
    ...extra,
  };
}

function view(agents: AgentView[], extra: Partial<SweepView> = {}): SweepView {
  return { agents, scope: {}, viewAll: false, servers: [], sessions: [], ...extra };
}

type Shown = ShownNotification & { close: ReturnType<typeof vi.fn<() => void>> };
function shown(tag: string, data: NotifData): Shown {
  return { tag, data, close: vi.fn<() => void>() };
}
/** A pane's own notification, tagged the way the bridge's sink tags it. */
function paneNote(paneId: string, data: Omit<NotifData, "paneId"> = {}): Shown {
  return shown(paneSlotTag(paneId, data)!, { paneId, ...data });
}

const tags = (list: readonly ShownNotification[]) => list.map((n) => n.tag);

describe("staleNotifications — a pane's own notification", () => {
  it("closes when the pane is back to work or rests seen, and keeps it while the pane needs you", () => {
    const v = view([
      pane("w1:p1", "working"),
      pane("w1:p2", "done", { lastActiveAt: 100, lastSeenAt: 200 }),
      pane("w1:p3", "blocked"),
      pane("w1:p4", "done", { lastActiveAt: 200, lastSeenAt: 100 }),
    ]);
    const notes = ["w1:p1", "w1:p2", "w1:p3", "w1:p4"].map((id) => paneNote(id));
    expect(tags(staleNotifications(notes, v))).toEqual(["collie:herd:w1:p1", "collie:herd:w1:p2"]);
  });

  it("closes when the pane is gone from the session the snapshot lists whole", () => {
    expect(tags(staleNotifications([paneNote("w1:p9")], view([pane("w1:p1", "blocked")])))).toEqual(["collie:herd:w1:p9"]);
  });

  it("judges a named session only by its own panes, and a gone pane only when the view lists that session", () => {
    const work = paneNote("w1:p1", { session: "work" });
    // The primary's w1:p1 is resting, but the notification is the named session's: no verdict.
    expect(staleNotifications([work], view([pane("w1:p1", "idle")]))).toEqual([]);
    // Addressed to that session, its panes answer for it.
    expect(tags(staleNotifications([work], view([pane("w1:p1", "idle")], { scope: { session: "work" } })))).toEqual([
      "collie:herd:work:w1:p1",
    ]);
    // A widened view tags each pane with its session and lists every session.
    const sessions: SessionSummary[] = [
      { name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 1 },
      { name: "work", isPrimary: false, reachable: true, agents: 1, working: 0, blocked: 1 },
    ];
    const widened = view([pane("w1:p1", "blocked", { session: "default" }), pane("w1:p2", "blocked", { session: "work" })], {
      viewAll: true,
      sessions,
    });
    expect(staleNotifications([work], widened).map((n) => n.tag)).toEqual(["collie:herd:work:w1:p1"]);
    expect(staleNotifications([paneNote("w1:p1")], widened)).toEqual([]);
  });

  it("judges a crew member's pane only while the snapshot holds it, never by its absence", () => {
    const servers: ServerSummary[] = [
      { id: "desk", name: "desk", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 0 },
      { id: "laptop", name: "laptop", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 0 },
    ];
    const resting = paneNote("w1:p1", { host: "laptop" });
    const gone = paneNote("w1:p2", { host: "laptop" });
    const v = view([pane("w1:p1", "idle", { host: "laptop" }), pane("w1:p1", "blocked", { host: "desk" })], { servers });
    expect(tags(staleNotifications([resting, gone], v))).toEqual(["collie:herd@laptop:w1:p1"]);
    // The lead's own w1:p1 is blocked: its notification stays, whatever the member's pane does.
    expect(staleNotifications([paneNote("w1:p1")], v)).toEqual([]);
  });
});

describe("staleNotifications — what it never touches", () => {
  it("leaves a machine or update alert, another tag, and a notification without data alone", () => {
    const v = view([]);
    const notes = [
      shown("collie:machine:desk:cpu", { target: "machine", machine: "desk" }),
      shown("collie-update", { target: "settings" }),
      shown("collie:w1:p1", { paneId: "w1:p1" }),
      { tag: "collie:herd:w1:p1", data: null, close: vi.fn() },
    ];
    expect(staleNotifications(notes, v)).toEqual([]);
  });
});

describe("staleNotifications — a session's summary", () => {
  it("closes when no pane of its session needs you, and keeps it while one does", () => {
    const summary = shown(herdSlotTag()!, { paneId: "w1:p1" });
    expect(tags(staleNotifications([summary], view([pane("w1:p1", "working"), pane("w1:p2", "idle")])))).toEqual([
      "collie:herd",
    ]);
    expect(staleNotifications([summary], view([pane("w1:p1", "working"), pane("w1:p2", "blocked")]))).toEqual([]);
  });

  it("keeps a member's summary, whose session the snapshot cannot list whole", () => {
    const summary = shown(herdSlotTag({ host: "laptop" })!, { host: "laptop" });
    expect(staleNotifications([summary], view([]))).toEqual([]);
  });
});

describe("sweepNotificationsIn", () => {
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

  it("closes the stale ones, zeroes their slots in the icon's count, and shows the new total", async () => {
    const { caches: badgeCaches, store } = memoryCaches();
    await recordSlot(badgeCaches, "https://c.test", "/", "collie:herd:w1:p1", 1);
    await recordSlot(badgeCaches, "https://c.test", "/", "collie:herd:w1:p3", 1);
    const setAppBadge = vi.fn(async () => {});
    const badge: SweepBadge = { caches: badgeCaches, origin: "https://c.test", mount: "/", target: { setAppBadge } };
    const stale = paneNote("w1:p1");
    const live = paneNote("w1:p3");
    const closed = await sweepNotificationsIn(
      { getNotifications: async () => [stale, live] },
      view([pane("w1:p1", "working"), pane("w1:p3", "blocked")]),
      badge,
    );
    expect(closed).toBe(1);
    expect(stale.close).toHaveBeenCalledOnce();
    expect(live.close).not.toHaveBeenCalled();
    expect(setAppBadge).toHaveBeenCalledWith(1);
    expect(JSON.parse(store.get(badgeKey("https://c.test", "/"))!)).toEqual({ "collie:herd:w1:p3": 1 });
  });

  it("never throws when the list is refused, and closes nothing", async () => {
    const badge: SweepBadge = { caches: null, origin: "", mount: "/", target: {} };
    await expect(sweepNotificationsIn({ getNotifications: () => Promise.reject(new Error("no")) }, view([]), badge)).resolves.toBe(0);
  });
});
