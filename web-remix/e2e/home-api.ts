// The dashboard's stub bridge (wave 2): a two-machine crew (`lead` bluefin, `peer` minibuch), three
// workspaces on the lead and one on the peer, prompt cache readings in all three states, an update
// available, and the reads the Crew and Files tabs make. Built per test, so the cache expiry times
// are relative to the test's own clock. Handlers for `installRoutesApi` (routes-api.ts); the crew
// census and the machines cards are the wave-4 stubs, reused.
import type { AgentView, CacheRuleWire, PaneCache, SnapshotResponse } from "@web/lib/types";

import { paneBody } from "./fixtures";
import type { StubHandler } from "./routes-api";
import { changesStub } from "./routes-changes-api";
import { CREW } from "./routes-crew-api";
import { machinesStub } from "./routes-machines-api";

const MIN = 60_000;

function pane(over: Partial<AgentView> & Pick<AgentView, "paneId" | "workspaceId" | "workspaceLabel" | "tabId">): AgentView {
  return {
    workspaceNumber: Number(over.workspaceId.replace(/\D/gu, "")) || 1,
    agent: "claude",
    status: "idle",
    cwd: "/home/dev/project",
    focused: false,
    kind: "agent",
    ...over,
  };
}

function cache(state: PaneCache["state"], minutesLeft: number | undefined, now: number): PaneCache {
  const reading: PaneCache = { state, ttlSeconds: 300, ruleId: "anthropic-5m", confidence: "documented" };
  if (minutesLeft !== undefined) reading.expiresAt = now + minutesLeft * MIN + 20_000;
  return reading;
}

export const CACHE_RULES: CacheRuleWire[] = [
  {
    id: "anthropic-5m",
    label: "Anthropic, 5 minutes",
    ttlSeconds: 300,
    confidence: "documented",
    sourceTitle: "Prompt caching",
    sourceUrl: "https://example.invalid/prompt-caching",
    retrievedAt: "2026-09-01",
    slidingWindow: true,
    automatic: true,
  },
];

/** The snapshot at `now`. `update` makes the update ribbon show (`releaseAvailable`). */
export function homeSnapshot(now: number, update = true): SnapshotResponse {
  const body: SnapshotResponse = {
    bridge: "connected",
    ts: now,
    servers: [
      { id: "lead", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: now },
      { id: "peer", name: "minibuch", isLead: false, reachable: true, protocol: "ok", lastSeenAt: now },
    ],
    agents: [
      pane({ paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "collie", tabId: "w1:t1", tabLabel: "build", status: "blocked", cache: cache("warm", 12, now), lastActiveAt: now - 5 * MIN }),
      pane({ paneId: "w1:p2", workspaceId: "w1", workspaceLabel: "collie", tabId: "w1:t1", tabLabel: "build", agent: "some-new-harness", status: "working", cache: cache("expiring", 0, now), lastActiveAt: now - 1 * MIN }),
      pane({ paneId: "w1:p3", workspaceId: "w1", workspaceLabel: "collie", tabId: "w1:t2", tabLabel: "tests", status: "idle", cache: cache("cold", undefined, now), lastActiveAt: now - 30 * MIN, lastSeenAt: now - 30 * MIN }),
      pane({ paneId: "w2:p1", workspaceId: "w2", workspaceLabel: "website", tabId: "w2:t1", tabLabel: "docs", agent: "some-new-harness", status: "done", lastActiveAt: now - 2 * MIN }),
      pane({ paneId: "w3:p1", workspaceId: "w3", workspaceLabel: "brand", tabId: "w3:t1", tabLabel: "logo", status: "idle", lastActiveAt: now - 60 * MIN, lastSeenAt: now - 60 * MIN }),
      pane({ paneId: "w1:p1", host: "peer", workspaceId: "w1", workspaceLabel: "infra", tabId: "w1:t1", tabLabel: "deploy", status: "blocked", cache: cache("warm", 4, now), lastActiveAt: now - 3 * MIN }),
    ],
    shellPanes: [pane({ paneId: "w2:p2", workspaceId: "w2", workspaceLabel: "website", tabId: "w2:t1", tabLabel: "docs", agent: "", kind: "shell" })],
    workspaces: [
      { workspaceId: "w1", number: 1, label: "collie", focused: true, activeTabId: "w1:t1", tabCount: 2, paneCount: 3 },
      { workspaceId: "w2", number: 2, label: "website", focused: false, activeTabId: "w2:t1", tabCount: 1, paneCount: 2 },
      { workspaceId: "w3", number: 3, label: "brand", focused: false, activeTabId: "w3:t1", tabCount: 1, paneCount: 1 },
      { workspaceId: "w1", host: "peer", number: 1, label: "infra", focused: true, activeTabId: "w1:t1", tabCount: 1, paneCount: 1 },
    ],
    tabs: [
      { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "build", focused: true, paneCount: 2 },
      { tabId: "w1:t2", workspaceId: "w1", number: 2, label: "tests", focused: false, paneCount: 1 },
      { tabId: "w2:t1", workspaceId: "w2", number: 1, label: "docs", focused: true, paneCount: 2 },
      { tabId: "w3:t1", workspaceId: "w3", number: 1, label: "logo", focused: true, paneCount: 1 },
      { tabId: "w1:t1", host: "peer", workspaceId: "w1", number: 1, label: "deploy", focused: true, paneCount: 1 },
    ],
  };
  if (update) {
    body.update = {
      current: "1.17.0",
      latest: "1.18.0",
      latestUrl: null,
      releaseAvailable: true,
      majorAvailable: null,
      majorUrl: null,
      bridgeStale: false,
      checkedAt: null,
    };
  }
  return body;
}

/** Every dashboard read and write, answered. `snap` is read on each poll, so a test can change it. */
export function homeHandlers(snap: () => SnapshotResponse): StubHandler[] {
  const machines = machinesStub();
  const crew: StubHandler = async (ctx) => {
    const key = `${ctx.method} ${ctx.url.pathname}`;
    if (key === "GET /api/snapshot") {
      await ctx.json(200, snap());
      return true;
    }
    if (key === "GET /api/crew") {
      await ctx.json(200, CREW);
      return true;
    }
    if (key === "GET /api/cache-rules") {
      await ctx.json(200, { rules: CACHE_RULES });
      return true;
    }
    if (key === "POST /api/tab") {
      await ctx.json(200, { ok: true, pane: { paneId: "w1:p9", workspaceId: "w1", workspaceLabel: "collie", tabId: "w1:t3", cwd: "/home/dev/project" } });
      return true;
    }
    const one = /^\/api\/pane\/([^/]+)$/u.exec(ctx.url.pathname);
    if (ctx.method === "GET" && one?.[1] !== undefined) {
      await ctx.json(200, paneBody(decodeURIComponent(one[1])));
      return true;
    }
    return false;
  };
  return [crew, machines.handler, changesStub()];
}
