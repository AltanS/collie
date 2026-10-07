// The stub bridge the smoke reads: two workspaces on one machine, one blocked agent (so the summary
// line and the heading dot have something to say), one finished agent that was never opened (the
// unseen square), and one bare shell. Harness and multiplexer names are plain data here, never a list
// the app matches against. The working pane has a harness name no adapter knows: nothing reads its
// mirror, so the stub text stays plain terminal text and never turns into a dialog card.
import type { BrowserContext } from "@playwright/test";
import type { AgentView, BridgeConfig, PaneReadResponse, SnapshotResponse } from "@web/lib/types";

function pane(over: Partial<AgentView> & Pick<AgentView, "paneId" | "workspaceId" | "workspaceLabel" | "tabId">): AgentView {
  return {
    workspaceNumber: over.workspaceId === "w1" ? 1 : 2,
    agent: "claude",
    status: "idle",
    cwd: "/home/dev/project",
    focused: false,
    kind: "agent",
    ...over,
  };
}

export const SNAPSHOT: SnapshotResponse = {
  bridge: "connected",
  ts: 1_790_000_000_000,
  agents: [
    pane({ paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "collie", tabId: "w1:t1", tabLabel: "build", status: "blocked" }),
    pane({ paneId: "w1:p2", workspaceId: "w1", workspaceLabel: "collie", tabId: "w1:t1", tabLabel: "build", agent: "some-new-harness", status: "working" }),
    pane({
      paneId: "w2:p1",
      workspaceId: "w2",
      workspaceLabel: "website",
      tabId: "w2:t1",
      tabLabel: "docs",
      agent: "some-new-harness",
      status: "done",
      lastActiveAt: 1_790_000_000_000,
    }),
  ],
  shellPanes: [pane({ paneId: "w2:p2", workspaceId: "w2", workspaceLabel: "website", tabId: "w2:t1", tabLabel: "docs", agent: "", kind: "shell" })],
  workspaces: [
    { workspaceId: "w1", number: 1, label: "collie", focused: true, activeTabId: "w1:t1", tabCount: 1, paneCount: 2 },
    { workspaceId: "w2", number: 2, label: "website", focused: false, activeTabId: "w2:t1", tabCount: 1, paneCount: 2 },
  ],
  tabs: [
    { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "build", focused: true, paneCount: 2 },
    { tabId: "w2:t1", workspaceId: "w2", number: 1, label: "docs", focused: true, paneCount: 2 },
  ],
};

export const CONFIG: BridgeConfig = { push: false, vapidPublicKey: "" };

export function paneBody(paneId: string): PaneReadResponse {
  return { paneId, text: `stub mirror of ${paneId}\n$ `, truncated: false, revision: 1 };
}

/**
 * Turn the S3 islands document off for this context, so the bridge draws `/` and `/pane/:paneId` as
 * S1/S2 did: the specs that pin those documents (ssr-boot, pane-frames) keep pinning them, and
 * e2e/islands.spec.ts holds the islands document. Both the prefs cookie (read by the server render)
 * and local storage (the client writes the cookie back from it) carry the switch.
 */
export async function islandsOff(context: BrowserContext, baseURL: string): Promise<void> {
  const value = encodeURIComponent(JSON.stringify({ "collie:islands:v1": "0" }));
  await context.addCookies([{ name: "collie-prefs", value, url: baseURL }]);
  await context.addInitScript(() => {
    try {
      localStorage.setItem("collie:islands:v1", "0");
    } catch {
      // A page with no storage: the cookie alone carries the switch for the server.
    }
  });
}
