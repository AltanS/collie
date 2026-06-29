import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fixtureAgents } from "@/test/handlers";

// loaders.ts keeps a module-level "last good" cache, so each test re-imports the module fresh
// (via vi.resetModules) to start from an empty cache and stay independent of run order.
beforeEach(() => {
  vi.resetModules();
});

const failSnapshot = () =>
  server.use(http.get("/api/snapshot", () => new HttpResponse(null, { status: 500 })));

const failPane = () =>
  server.use(http.get(/\/api\/pane\/[^/]+$/, () => new HttpResponse(null, { status: 500 })));

describe("rootLoader", () => {
  it("returns the live snapshot on success", async () => {
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.error).toBe(false);
    expect(data.bridge).toBe("connected");
    expect(data.agents).toHaveLength(2);
  });

  it("keeps the last-good herd (flagged error) when a refresh fails", async () => {
    const { rootLoader } = await import("./loaders");
    await rootLoader(); // prime the cache with a good snapshot

    failSnapshot();
    const stale = await rootLoader();

    expect(stale.error).toBe(true);
    expect(stale.bridge).toBe("connected"); // from the cached snapshot
    expect(stale.agents).toHaveLength(2);
    expect(stale.agents[0]!.paneId).toBe(fixtureAgents[0]!.paneId);
  });

  it("returns empty + error when there is no last-good snapshot", async () => {
    failSnapshot();
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.error).toBe(true);
    expect(data.agents).toEqual([]);
    expect(data.bridge).toBeUndefined();
  });
});

describe("paneLoader", () => {
  it("returns pane text on success", async () => {
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({ params: { paneId: "w1:p1" } });
    expect(data.error).toBe(false);
    expect(data.paneId).toBe("w1:p1");
    expect(data.text).toBe("hello from the pane");
  });

  it("keeps the last-good pane text (flagged error) when a refresh fails", async () => {
    const { paneLoader } = await import("./loaders");
    await paneLoader({ params: { paneId: "w1:p1" } }); // prime per-pane cache

    failPane();
    const stale = await paneLoader({ params: { paneId: "w1:p1" } });

    expect(stale.error).toBe(true);
    expect(stale.text).toBe("hello from the pane");
    expect(stale.paneId).toBe("w1:p1");
  });

  it("returns empty text + error when no last-good exists for that pane", async () => {
    failPane();
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({ params: { paneId: "wX:p9" } });
    expect(data.error).toBe(true);
    expect(data.text).toBe("");
    expect(data.paneId).toBe("wX:p9");
  });
});
