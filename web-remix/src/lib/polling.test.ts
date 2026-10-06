/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import type { HomeData } from "@web/lib/loaders";
import { internScope } from "@web/lib/scope";
import type { AgentStatus, AgentView, SnapshotResponse, UpdateInfo } from "@web/lib/types";
import * as web from "@web/hooks/use-polling";

import {
  BURST_MIN_POLLS,
  BURST_MS,
  BURST_QUIET_POLLS,
  burstOnPoll,
  HOME_BUSY_MS,
  HOT_MS,
  IDLE_MS,
  intervalFor,
  type Burst,
} from "./polling";

// The cadence must answer exactly as web's (hooks/use-polling.ts `intervalFor`). Each case is asked of
// both resolvers, so a change on either side that the other did not make fails here.

function agent(paneId: string, status: AgentStatus): AgentView {
  return { paneId, agent: "claude", status, workspaceId: "w1", workspaceLabel: "w", workspaceNumber: 1, tabId: "w1:t1", cwd: "/", focused: false };
}

function snap(agents: AgentView[], update?: UpdateInfo): SnapshotResponse {
  return { bridge: "connected", ts: 1, agents, shellPanes: [], workspaces: [], tabs: [], update };
}

/** The same herd as web's root loader hands it to its resolver. */
function homeData(data: SnapshotResponse | undefined): HomeData | undefined {
  if (data === undefined) return undefined;
  return {
    bridge: data.bridge,
    device: undefined,
    agents: data.agents,
    shellPanes: data.shellPanes,
    workspaces: data.workspaces,
    tabs: data.tabs,
    sessions: [],
    servers: [],
    ts: data.ts,
    scope: internScope({}),
    viewAll: false,
    snoozedUntil: null,
    update: data.update,
    error: false,
    authError: false,
  };
}

const quiet = { bursting: false, changed: false, topology: false };

function both(data: SnapshotResponse | undefined, paneId: string | null, following: boolean, intent = quiet): number {
  const ours = intervalFor(data, { paneId, following }, intent);
  const theirs = web.intervalFor(homeData(data), paneId, {
    bursting: intent.bursting,
    following,
    changed: intent.changed,
    topologyBursting: intent.topology,
  });
  expect(ours).toBe(theirs);
  return ours;
}

describe("intervalFor matches web's five rules", () => {
  test("the constants are web's", () => {
    expect([BURST_MS, HOT_MS, HOME_BUSY_MS, IDLE_MS]).toEqual([web.BURST_MS, web.HOT_MS, web.HOME_BUSY_MS, web.IDLE_MS]);
  });

  test("an idle pane whose mirror did not move rests at IDLE_MS, however busy the herd is", () => {
    const data = snap([agent("w1:p1", "idle"), agent("w2:p1", "working"), agent("w3:p1", "blocked")]);
    expect(both(data, "w1:p1", true)).toBe(IDLE_MS);
  });

  test("a followed pane whose own agent works, or whose mirror moved, is HOT_MS", () => {
    expect(both(snap([agent("w1:p1", "working")]), "w1:p1", true)).toBe(HOT_MS);
    expect(both(snap([agent("w1:p1", "blocked")]), "w1:p1", true)).toBe(HOT_MS);
    expect(both(snap([agent("w1:p1", "idle")]), "w1:p1", true, { ...quiet, changed: true })).toBe(HOT_MS);
  });

  test("a pane scrolled back into history is not followed: IDLE_MS even while its agent works", () => {
    expect(both(snap([agent("w1:p1", "working")]), "w1:p1", false, { ...quiet, changed: true })).toBe(IDLE_MS);
  });

  test("a pane the snapshot no longer knows has nothing to watch", () => {
    expect(both(snap([agent("w2:p1", "idle")]), "w1:p1", true, { ...quiet, changed: true })).toBe(IDLE_MS);
  });

  test("home: HOME_BUSY_MS while any agent works or is blocked, IDLE_MS over a resting herd", () => {
    expect(both(snap([agent("w1:p1", "working")]), null, true)).toBe(HOME_BUSY_MS);
    expect(both(snap([agent("w1:p1", "blocked")]), null, true)).toBe(HOME_BUSY_MS);
    expect(both(snap([agent("w1:p1", "idle"), agent("w1:p2", "done")]), null, true)).toBe(IDLE_MS);
    expect(both(undefined, null, true)).toBe(IDLE_MS);
  });

  test("a send burst on the open pane and a topology burst anywhere are BURST_MS", () => {
    expect(both(snap([agent("w1:p1", "idle")]), "w1:p1", true, { ...quiet, bursting: true })).toBe(BURST_MS);
    expect(both(snap([agent("w1:p1", "idle")]), null, true, { ...quiet, topology: true })).toBe(BURST_MS);
  });

  test("an update run in flight is HOT_MS on a screen with no pane", () => {
    const update: UpdateInfo = {
      current: "1.0.0",
      latest: "1.1.0",
      latestUrl: null,
      releaseAvailable: true,
      majorAvailable: null,
      majorUrl: null,
      bridgeStale: false,
      checkedAt: null,
      run: { schema: 1, state: "staging", from: "1.0.0", to: "1.1.0", startedAt: 1, updatedAt: 1, pid: 1, attempt: 1 },
    };
    const data = snap([agent("w1:p1", "idle")], update);
    expect(both(data, null, true)).toBe(HOT_MS);
  });
});

describe("burstOnPoll, web's burst bookkeeping", () => {
  const start: Burst = { paneId: "w1:p1", polls: 0, quiet: 0, topology: 0 };

  test("no burst stays no burst", () => {
    const none: Burst = { paneId: null, polls: 0, quiet: 0, topology: 0 };
    expect(burstOnPoll(none, true)).toBe(none);
  });

  test("a burst lasts at least BURST_MIN_POLLS reads, then BURST_QUIET_POLLS quiet reads end it", () => {
    let b = start;
    for (let i = 0; i < BURST_MIN_POLLS - 1; i++) {
      b = burstOnPoll(b, false);
      expect(b.paneId).toBe("w1:p1");
    }
    b = burstOnPoll(b, false);
    expect(b.paneId).toBeNull();
  });

  test("a changed read resets the quiet count, so a moving mirror keeps the burst", () => {
    let b = start;
    for (let i = 0; i < BURST_MIN_POLLS + 3; i++) b = burstOnPoll(b, true);
    expect(b.paneId).toBe("w1:p1");
    for (let i = 0; i < BURST_QUIET_POLLS - 1; i++) {
      b = burstOnPoll(b, false);
      expect(b.paneId).toBe("w1:p1");
    }
    b = burstOnPoll(b, false);
    expect(b.paneId).toBeNull();
  });
});
