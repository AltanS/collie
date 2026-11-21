import type { RouteObject } from "react-router";
import { describe, expect, it } from "vitest";

import { isLazyScreen } from "@/lib/lazy-route";
import { lazyLoadsOf } from "@/lib/route-preload";

// THE SPLIT OF THE ROUTE TABLE (ADR 0169). Which screens load on demand, that the background preload
// knows every one of them, and that the first-paint screens stay in the main chunk.

/** Every route of the table as `[path, route]`, the path spelled from the root with its parents. */
function flatten(routes: readonly RouteObject[], parent = ""): [string, RouteObject][] {
  return routes.flatMap((route) => {
    const own = route.index === true ? parent || "/" : `${parent}/${route.path ?? ""}`.replace(/\/+/g, "/");
    const row: [string, RouteObject] = [own, route];
    return [row, ...flatten(route.children ?? [], own === "/" ? "" : own)];
  });
}

async function table(): Promise<[string, RouteObject][]> {
  const { routes } = await import("@/router");
  return flatten(routes);
}

const EAGER = ["/", "/slot/:slot", "/space/:spaceId", "/trick/:paneId", "/pair/approve", "/pane/:paneId", "/pane/:paneId/zoom"];

describe("the lazy route table", () => {
  it("has a preload for every lazy route, so a new one cannot be forgotten", async () => {
    const { routes } = await import("@/router");
    const { loads, unknown } = lazyLoadsOf(routes);
    expect(unknown).toEqual([]);
    const lazyCount = (await table()).filter(([, route]) => route.lazy !== undefined).length;
    expect(loads).toHaveLength(lazyCount);
  });

  it("keeps the screens a first paint needs, and Pair approve, in the main chunk", async () => {
    const rows = await table();
    for (const path of EAGER) {
      const row = rows.find(([p]) => p === path);
      expect(row, path).toBeDefined();
      expect(row?.[1].lazy, path).toBeUndefined();
    }
  });

  it("loads Settings, Updates, Changes, New, Crew, Machines, Conversations, History, the Hill and the Trick card on demand", async () => {
    const lazy = (await table()).filter(([, route]) => route.lazy !== undefined).map(([path]) => path);
    for (const path of [
      "/settings",
      "/settings/look",
      "/settings/chat",
      "/settings/notifications",
      "/settings/notifications/load/:machine",
      "/settings/devices",
      "/settings/privacy",
      "/settings/updates",
      "/settings/tricks/:key",
      "/settings/accounts/:id/login",
      "/pane/:paneId/changes/*",
      "/space/:spaceId/changes/*",
      "/new",
      "/new/add",
      "/crew",
      "/machines",
      "/machines/:id",
      "/conversations",
      "/conversations/:id",
      "/pane/:paneId/history",
      "/hill",
      "/trick-card/:decisionId",
    ]) {
      expect(lazy, path).toContain(path);
    }
  });

  it("keeps the old Settings addresses as redirects that load no chunk (ADR 0170)", async () => {
    const rows = await table();
    for (const path of ["/settings/appearance", "/settings/appearance/character", "/settings/harnesses", "/settings/device", "/settings/alerts", "/settings/experiments", "/settings/system", "/settings/system/install-count"]) {
      const row = rows.find(([p]) => p === path);
      expect(row, path).toBeDefined();
      expect(row?.[1].lazy, path).toBeUndefined();
    }
  });

  it("resolves each lazy route to a component", async () => {
    for (const [path, route] of await table()) {
      if (!isLazyScreen(route.lazy)) continue;
      const loaded = await route.lazy();
      expect(loaded.Component, path).toBeInstanceOf(Function);
    }
  }, 30_000);
});
