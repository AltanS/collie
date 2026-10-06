// The stub bridge of the wave-4 route specs. A base set of answers every route needs (snapshot,
// config, devices, update check) plus pluggable handlers, one per area, so Crew, Machines, History,
// Changes and Settings each ship their payloads in a file of their own (`routes-<area>-api.ts`) and
// the specs share this one installer. Payloads are shaped like web/e2e/fixtures/api.ts. Harness and
// multiplexer names are plain data here, never a list the app matches against.
import type { Page, Request, Route } from "@playwright/test";

import type { JsonValue } from "@web/lib/json";
import type { AgentView, BridgeConfig, SnapshotResponse, UpdateCheckResponse } from "@web/lib/types";

export interface Call {
  method: string;
  path: string;
  search: string;
  body: JsonValue | undefined;
}

export interface StubContext {
  route: Route;
  request: Request;
  url: URL;
  method: string;
  /** The JSON body of a write, or undefined. */
  body: JsonValue | undefined;
  json<T>(status: number, body: T): Promise<void>;
}

/** Answer the request and return true, or return false to let the next handler try. */
export type StubHandler = (ctx: StubContext) => Promise<boolean> | boolean;

export interface RoutesStub {
  /** Every request answered, in order, for the assertions on writes. */
  calls: Call[];
  /** The writes only. */
  writes(): Call[];
}

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
    pane({ paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "collie", tabId: "w1:t1", tabLabel: "build", status: "idle" }),
    pane({ paneId: "w2:p1", workspaceId: "w2", workspaceLabel: "website", tabId: "w2:t1", tabLabel: "docs", status: "done" }),
  ],
  shellPanes: [],
  workspaces: [
    { workspaceId: "w1", number: 1, label: "collie", focused: true, activeTabId: "w1:t1", tabCount: 1, paneCount: 1 },
    { workspaceId: "w2", number: 2, label: "website", focused: false, activeTabId: "w2:t1", tabCount: 1, paneCount: 1 },
  ],
  tabs: [
    { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "build", focused: true, paneCount: 1 },
    { tabId: "w2:t1", workspaceId: "w2", number: 1, label: "docs", focused: true, paneCount: 1 },
  ],
};

export const CONFIG: BridgeConfig = { push: false, vapidPublicKey: "" };

export const UPDATE_CHECK: UpdateCheckResponse = {
  current: "1.17.0",
  latest: "1.17.0",
  latestUrl: null,
  releaseAvailable: false,
  majorAvailable: null,
  majorUrl: null,
  bridgeStale: false,
  checkedAt: Date.now() - 120_000,
  preflight: { schema: 1, verdict: "green", checks: [{ id: "disk", verdict: "green", reason: "ok" }] },
};

/** Install the stub on `page`. `handlers` run in order before the base answers. */
export async function installRoutesApi(page: Page, handlers: readonly StubHandler[] = []): Promise<RoutesStub> {
  const calls: Call[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    let body: JsonValue | undefined;
    try {
      body = request.postDataJSON();
    } catch {
      body = undefined;
    }
    calls.push({ method, path: url.pathname, search: url.search, body });
    const ctx: StubContext = {
      route,
      request,
      url,
      method,
      body,
      json: (status, payload) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) }),
    };
    for (const handler of handlers) if (await handler(ctx)) return;
    const key = `${method} ${url.pathname}`;
    if (key === "GET /api/snapshot") return ctx.json(200, SNAPSHOT);
    if (key === "GET /api/config") return ctx.json(200, CONFIG);
    if (key === "GET /api/devices") return ctx.json(200, { enforced: false, current: null, devices: [] });
    if (key === "GET /api/update/check") return ctx.json(200, UPDATE_CHECK);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: `no stub for ${key}` }) });
  });
  return { calls, writes: () => calls.filter((c) => c.method !== "GET") };
}
