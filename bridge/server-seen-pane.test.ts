import { describe, expect, test } from "bun:test";
import { isTopologyWrite, marksPaneSeen, paneGateLevel, SEEN_HEADER } from "./server.ts";
import type { AgentView } from "./types.ts";

describe("seenPane — manual seen / unseen mark", () => {
  test("marksPaneSeen leaves `seen` to its own handler, paneGateLevel gates it as write, and isTopologyWrite warms peer sweeps", () => {
    expect(marksPaneSeen(new Request("http://x/api/pane/w1:p1/seen", { method: "POST" }), "seen")).toBe(false);
    expect(
      marksPaneSeen(
        new Request("http://x/api/pane/w1:p1/seen", { method: "POST", headers: { [SEEN_HEADER]: "1" } }),
        "seen",
      ),
    ).toBe(false);
    expect(paneGateLevel("seen", "POST")).toBe("write");
    expect(paneGateLevel("seen")).toBe("write");
    expect(isTopologyWrite("/api/pane/w1%3Ap1/seen", "POST")).toBe(true);
  });

  test("toggles seen/unseen on a live real agent pane, audits pane.seen, pokes the engine, and rejects invalid targets or bodies", async () => {
    const { seenPane } = await import("./server.ts");
    const recordedSeen: Array<{ session: string; paneId: string; seen: boolean }> = [];
    const audits: Array<import("./audit.ts").AuditEntry> = [];
    let pokes = 0;

    const activity = {
      setSeen(session: string, paneId: string, seen: boolean) {
        recordedSeen.push({ session, paneId, seen });
      },
    };
    const stubEngine: Partial<import("./state-engine.ts").StateEngine> = {
      pokeNow: () => {
        pokes++;
      },
      current: () => ({
        bridge: "connected",
        agents: [
          {
            paneId: "w1:p1",
            workspaceId: "w1",
            workspaceLabel: "webapp",
            workspaceNumber: 1,
            tabId: "w1:t1",
            agent: "claude",
            status: "idle",
            cwd: "/work/webapp",
            focused: false,
          },
          {
            paneId: "trick:t1",
            workspaceId: "tricks",
            workspaceLabel: "Tricks",
            workspaceNumber: 2,
            tabId: "tricks:1",
            agent: "trick",
            status: "idle",
            cwd: "/work/webapp",
            focused: false,
            kind: "trick",
          },
        ],
        shellPanes: [
          {
            paneId: "w1:sh",
            workspaceId: "w1",
            workspaceLabel: "webapp",
            workspaceNumber: 1,
            tabId: "w1:t1",
            agent: "shell",
            status: "unknown",
            cwd: "/work/webapp",
            focused: false,
            kind: "shell",
          },
        ],
        workspaces: [],
        tabs: [],
        ts: 1000,
      }),
    };
    // SAFETY: seenPane reads only `current().agents` and `pokeNow()`.
    const engine = stubEngine as Pick<import("./state-engine.ts").StateEngine, "current" | "pokeNow">;
    const audit: Pick<import("./audit.ts").AuditLog, "record"> = {
      record(entry) {
        audits.push(entry);
      },
    };

    const unreadRes = await seenPane(
      activity,
      engine,
      "w1:p1",
      new Request("http://x/api/pane/w1%3Ap1/seen", { method: "POST", body: JSON.stringify({ seen: false }) }),
      audit,
      "iphone",
      "default",
    );
    expect(unreadRes.status).toBe(200);
    expect(await unreadRes.json()).toEqual({ ok: true });
    expect(recordedSeen).toEqual([{ session: "default", paneId: "w1:p1", seen: false }]);
    expect(pokes).toBe(1);
    expect(audits).toEqual([
      { action: "pane.seen", paneId: "w1:p1", session: "default", device: "iphone", detail: { seen: false } },
    ]);

    const badJson = await seenPane(
      activity,
      engine,
      "w1:p1",
      new Request("http://x/api/pane/w1%3Ap1/seen", { method: "POST", body: "{" }),
      audit,
      "iphone",
      "default",
    );
    expect(badJson.status).toBe(400);

    const badSeen = await seenPane(
      activity,
      engine,
      "w1:p1",
      new Request("http://x/api/pane/w1%3Ap1/seen", { method: "POST", body: JSON.stringify({ seen: "yes" }) }),
      audit,
      "iphone",
      "default",
    );
    expect(badSeen.status).toBe(400);

    for (const invalidId of ["w1:missing", "w1:sh", "trick:t1"]) {
      const res = await seenPane(
        activity,
        engine,
        invalidId,
        new Request("http://x/api/pane/x/seen", { method: "POST", body: JSON.stringify({ seen: true }) }),
        audit,
        "iphone",
        "default",
      );
      expect(res.status).toBe(404);
    }
  });

  test("rejects unsettled panes (working and blocked) with 409 without mutating activity, audit, or poking", async () => {
    const { seenPane } = await import("./server.ts");
    const recordedSeen: Array<{ session: string; paneId: string; seen: boolean }> = [];
    const audits: Array<import("./audit.ts").AuditEntry> = [];
    let pokes = 0;

    const activity = {
      setSeen(session: string, paneId: string, seen: boolean) {
        recordedSeen.push({ session, paneId, seen });
      },
    };
    const stubEngine: Partial<import("./state-engine.ts").StateEngine> = {
      pokeNow: () => {
        pokes++;
      },
      current: () => ({
        bridge: "connected",
        agents: [
          {
            paneId: "w1:work",
            workspaceId: "w1",
            workspaceLabel: "webapp",
            workspaceNumber: 1,
            tabId: "w1:t1",
            agent: "claude",
            status: "working",
            cwd: "/work/webapp",
            focused: false,
          },
          {
            paneId: "w1:blk",
            workspaceId: "w1",
            workspaceLabel: "webapp",
            workspaceNumber: 1,
            tabId: "w1:t1",
            agent: "claude",
            status: "blocked",
            cwd: "/work/webapp",
            focused: false,
          },
        ],
        shellPanes: [],
        workspaces: [],
        tabs: [],
        ts: 1000,
      }),
    };
    // SAFETY: seenPane reads only `current().agents` and `pokeNow()`.
    const engine = stubEngine as Pick<import("./state-engine.ts").StateEngine, "current" | "pokeNow">;
    const audit: Pick<import("./audit.ts").AuditLog, "record"> = {
      record(entry) {
        audits.push(entry);
      },
    };

    for (const paneId of ["w1:work", "w1:blk"]) {
      for (const seen of [true, false]) {
        const res = await seenPane(
          activity,
          engine,
          paneId,
          new Request(`http://x/api/pane/${encodeURIComponent(paneId)}/seen`, {
            method: "POST",
            body: JSON.stringify({ seen }),
          }),
          audit,
          "iphone",
          "default",
        );
        expect(res.status).toBe(409);
        expect(await res.text()).toBe("pane is not settled");
      }
    }
    expect(recordedSeen).toEqual([]);
    expect(audits).toEqual([]);
    expect(pokes).toBe(0);
  });

  test("withPaneActivity emits manualUnseen: true only when unreadAt is present and activeAt > seenAt", async () => {
    const { withPaneActivity } = await import("./server.ts");
    const base: AgentView = {
      paneId: "w1:p1",
      workspaceId: "w1",
      workspaceLabel: "webapp",
      workspaceNumber: 1,
      tabId: "w1:t1",
      agent: "claude",
      status: "idle",
      cwd: "/work/webapp",
      focused: false,
    };

    expect(withPaneActivity(base, undefined)).toBe(base);
    expect("manualUnseen" in withPaneActivity(base, { activeAt: 100, seenAt: 200 })).toBe(false);
    expect("manualUnseen" in withPaneActivity(base, { activeAt: 200, seenAt: 100 })).toBe(false);
    expect("manualUnseen" in withPaneActivity(base, { activeAt: 100, seenAt: 200, unreadAt: 150 })).toBe(false);
    expect(withPaneActivity(base, { activeAt: 200, seenAt: 199, unreadAt: 300 })).toMatchObject({
      lastActiveAt: 200,
      lastSeenAt: 199,
      manualUnseen: true,
    });
  });
});
