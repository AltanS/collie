import { http, HttpResponse } from "msw";

import type {
  AgentView,
  SessionSummary,
  SnapshotResponse,
  TabView,
  WorkspaceView,
} from "@/lib/types";

// A couple of fixture agents covering the triage groups, reused across tests.
export const fixtureAgents: AgentView[] = [
  {
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "webapp",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "blocked",
    cwd: "/home/you/webapp",
    focused: false,
  },
  {
    paneId: "w2:p1",
    workspaceId: "w2",
    workspaceLabel: "collie",
    workspaceNumber: 2,
    tabId: "w2:t1",
    agent: "codex",
    status: "working",
    cwd: "/home/you/collie",
    focused: true,
  },
];

export const fixtureShellPanes: AgentView[] = [
  {
    paneId: "w2:p2",
    workspaceId: "w2",
    workspaceLabel: "collie",
    workspaceNumber: 2,
    tabId: "w2:t2",
    agent: "shell",
    status: "unknown",
    cwd: "/home/you/collie",
    focused: false,
    kind: "shell",
  },
];

export const fixtureWorkspaces: WorkspaceView[] = [
  {
    workspaceId: "w1",
    number: 1,
    label: "webapp",
    focused: false,
    activeTabId: "w1:t1",
    tabCount: 1,
    paneCount: 1,
  },
  {
    workspaceId: "w2",
    number: 2,
    label: "collie",
    focused: true,
    activeTabId: "w2:t1",
    tabCount: 2,
    paneCount: 2,
  },
];

export const fixtureTabs: TabView[] = [
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "1", focused: false, paneCount: 1 },
  { tabId: "w2:t1", workspaceId: "w2", number: 1, label: "code", focused: true, paneCount: 1 },
  { tabId: "w2:t2", workspaceId: "w2", number: 2, label: "shell", focused: false, paneCount: 1 },
];

// A two-session registry: the primary "default" plus a named "collie-demo". Order is primary-first,
// then alphabetical — matching the bridge contract.
export const fixtureSessions: SessionSummary[] = [
  { name: "default", isPrimary: true, reachable: true, agents: 2, working: 1, blocked: 1 },
  { name: "collie-demo", isPrimary: false, reachable: true, agents: 1, working: 1, blocked: 0 },
];

export const fixtureSnapshot: SnapshotResponse = {
  bridge: "connected",
  agents: fixtureAgents,
  shellPanes: fixtureShellPanes,
  workspaces: fixtureWorkspaces,
  tabs: fixtureTabs,
  notifications: { snoozedUntil: null },
  sessions: fixtureSessions,
  ts: 0,
};

// Default happy-path handlers; individual tests can override via server.use(...).
export const handlers = [
  http.get("/api/snapshot", () => HttpResponse.json(fixtureSnapshot)),
  http.get(/\/api\/pane\/[^/]+$/, () =>
    HttpResponse.json({ paneId: "w1:p1", text: "hello from the pane", truncated: false, revision: 1 }),
  ),
  http.post(/\/api\/pane\/[^/]+\/reply$/, () => HttpResponse.json({ ok: true })),
  http.post(/\/api\/pane\/[^/]+\/keys$/, () => HttpResponse.json({ ok: true })),
  http.post(/\/api\/pane\/[^/]+\/close$/, () => HttpResponse.json({ ok: true })),
  http.post("/api/tab", () =>
    HttpResponse.json({
      ok: true,
      pane: {
        paneId: "w2:p9",
        workspaceId: "w2",
        workspaceLabel: "collie",
        tabId: "w2:t9",
        cwd: "/home/you/collie",
      },
    }),
  ),
  http.post("/api/workspace", () =>
    HttpResponse.json({
      ok: true,
      pane: {
        paneId: "w9:p1",
        workspaceId: "w9",
        workspaceLabel: "new-space",
        tabId: "w9:t1",
        cwd: "/home/you",
      },
    }),
  ),
  http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "" })),
  http.post("/api/notifications/snooze", async ({ request }) => {
    const { snoozedUntil } = (await request.json()) as { snoozedUntil: number | null };
    return HttpResponse.json({ snoozedUntil });
  }),
  http.get("/api/notifications/prefs", () =>
    HttpResponse.json({ blocked: true, done: false, updates: true }),
  ),
  http.post("/api/notifications/prefs", async ({ request }) => {
    const patch = (await request.json()) as Record<string, boolean>;
    return HttpResponse.json({ blocked: true, done: false, updates: true, ...patch });
  }),
  http.post("/api/update/check", () =>
    HttpResponse.json({
      current: "0.11.0",
      latest: "0.11.0",
      latestUrl: null,
      releaseAvailable: false,
      bridgeStale: false,
      checkedAt: Date.now(),
    }),
  ),
];
