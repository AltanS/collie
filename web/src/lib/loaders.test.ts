import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fixtureAgents, fixtureSnapshot } from "@/test/handlers";

// loaders.ts keeps a module-level "last good" cache, so each test re-imports the module fresh
// (via vi.resetModules) to start from an empty cache and stay independent of run order.
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it("treats a cold-start TimeoutError as an error snapshot, NOT a rethrow to the error boundary", async () => {
    // The cold-start-against-a-dead-host case: the first snapshot fetch aborts at its timeout with a
    // DOMException named "TimeoutError" (distinct from the "AbortError" of a superseded revalidation).
    // The loader must fall into the error-snapshot branch so RootLayout + the escalation prompt handle
    // it uniformly — it must NOT bubble to RootError's generic "Something went wrong" screen.
    const { rootLoader } = await import("./loaders");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const data = await rootLoader();
    expect(data.error).toBe(true);
    expect(data.bridge).toBeUndefined();
    expect(data.agents).toEqual([]);
  });

  it("surfaces the snapshot's optional update field onto the loader data", async () => {
    const update = {
      current: "0.11.0",
      latest: "0.12.0",
      releaseAvailable: true,
      bridgeStale: false,
      checkedAt: 123,
    };
    server.use(
      http.get("/api/snapshot", () => HttpResponse.json({ ...fixtureSnapshot, update })),
    );
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.update).toEqual(update);
  });

  it("leaves update undefined when the snapshot omits it (older bridge)", async () => {
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.update).toBeUndefined();
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

  it("treats a TimeoutError from fetchPane as degraded (stale text + error), NOT a rethrow", async () => {
    // A request that times out aborts with a DOMException named "TimeoutError" — distinct from the
    // "AbortError" of a superseded revalidation. The loader rethrows only AbortError, so a timeout
    // must fall into the stale-data branch (keep the last-good text on screen, flagged) and not
    // bubble up as if the run were superseded.
    const { paneLoader } = await import("./loaders");
    await paneLoader({ params: { paneId: "w1:p1" } }); // prime the per-pane stale cache (via MSW)

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const stale = await paneLoader({ params: { paneId: "w1:p1" } });

    expect(stale.error).toBe(true);
    expect(stale.text).toBe("hello from the pane");
    expect(stale.paneId).toBe("w1:p1");
  });

  it("throws on a missing :paneId param (fail-loud to the error boundary)", async () => {
    const { paneLoader } = await import("./loaders");
    await expect(paneLoader({ params: {} })).rejects.toThrow(/paneId/);
  });
});

describe("requested-lines bookkeeping (Load older)", () => {
  it("defaults to the base window and grows a step per tap, capped", async () => {
    const { getRequestedLines, growRequestedLines, canGrowRequestedLines, DETAIL_HISTORY_MAX } =
      await import("./loaders");
    expect(getRequestedLines("w1:p1")).toBe(600);
    expect(canGrowRequestedLines("w1:p1")).toBe(true);

    expect(growRequestedLines("w1:p1")).toBe(1200);
    expect(growRequestedLines("w1:p1")).toBe(1800);
    expect(getRequestedLines("w1:p1")).toBe(1800);

    // Grow all the way to the cap; further taps clamp and canGrow flips false.
    let last = 1800;
    while (last < DETAIL_HISTORY_MAX) last = growRequestedLines("w1:p1");
    expect(last).toBe(DETAIL_HISTORY_MAX);
    expect(growRequestedLines("w1:p1")).toBe(DETAIL_HISTORY_MAX); // stays clamped
    expect(canGrowRequestedLines("w1:p1")).toBe(false);
  });

  it("tracks each pane independently", async () => {
    const { getRequestedLines, growRequestedLines } = await import("./loaders");
    growRequestedLines("w1:p1");
    expect(getRequestedLines("w1:p1")).toBe(1200);
    expect(getRequestedLines("w2:p1")).toBe(600); // untouched
  });

  it("the loader fetches with (and reports) the pane's requested window", async () => {
    const { paneLoader, growRequestedLines } = await import("./loaders");
    growRequestedLines("w1:p1"); // 600 → 1200
    const data = await paneLoader({ params: { paneId: "w1:p1" } });
    expect(data.requestedLines).toBe(1200);
    expect(data.truncated).toBe(false); // from the MSW fixture
  });

  it("resetRequestedLines clears back to the base window", async () => {
    const { getRequestedLines, growRequestedLines, resetRequestedLines } = await import("./loaders");
    growRequestedLines("w1:p1");
    resetRequestedLines("w1:p1");
    expect(getRequestedLines("w1:p1")).toBe(600);
  });
});

// The session in the request URL's `?s=` must reach the API as `session=` and be exposed on the
// loader data so components don't re-derive it — and each session's keep-previous-data cache is
// independent, so a failed refresh in one never surfaces another session's herd/pane.
describe("loaders — session scoping", () => {
  it("rootLoader threads ?s= to the API as session= and surfaces it on the data", async () => {
    let captured: string | null = "MISSING";
    server.use(
      http.get("/api/snapshot", ({ request }) => {
        captured = new URL(request.url).searchParams.get("session");
        return HttpResponse.json(fixtureSnapshot);
      }),
    );
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader({ request: new Request("http://localhost/?s=collie-demo") });
    expect(captured).toBe("collie-demo");
    expect(data.session).toBe("collie-demo");
    expect(data.sessions).toHaveLength(2);
  });

  it("rootLoader omits the param on the primary session (no ?s=)", async () => {
    let captured: string | null = "MISSING";
    server.use(
      http.get("/api/snapshot", ({ request }) => {
        captured = new URL(request.url).searchParams.get("session");
        return HttpResponse.json(fixtureSnapshot);
      }),
    );
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader({ request: new Request("http://localhost/") });
    expect(captured).toBeNull();
    expect(data.session).toBeUndefined();
  });

  it("paneLoader threads the session through to the pane read", async () => {
    let captured: string | null = "MISSING";
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, ({ request }) => {
        captured = new URL(request.url).searchParams.get("session");
        return HttpResponse.json({ paneId: "w1:p1", text: "hi", truncated: false, revision: 1 });
      }),
    );
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/?s=collie-demo"),
    });
    expect(captured).toBe("collie-demo");
    expect(data.session).toBe("collie-demo");
  });

  it("keeps a per-session stale cache — a failed refresh in one session shows no other's herd", async () => {
    const { rootLoader } = await import("./loaders");
    await rootLoader({ request: new Request("http://localhost/") }); // prime the primary session

    failSnapshot(); // now every snapshot 500s
    const stale = await rootLoader({ request: new Request("http://localhost/?s=collie-demo") });

    expect(stale.error).toBe(true);
    expect(stale.session).toBe("collie-demo");
    expect(stale.agents).toEqual([]); // NOT the primary session's cached herd
    expect(stale.bridge).toBeUndefined();
  });

  it("tracks requested scrollback per (session, pane) so ids can't collide across sessions", async () => {
    const { getRequestedLines, growRequestedLines } = await import("./loaders");
    growRequestedLines("w1:p1", "collie-demo");
    expect(getRequestedLines("w1:p1", "collie-demo")).toBe(1200);
    expect(getRequestedLines("w1:p1")).toBe(600); // the primary session's same id is untouched
  });
});

// A superseded revalidation aborts the in-flight fetch via request.signal. The loaders must
// RETHROW that AbortError (so React Router discards the stale run) rather than swallow it into the
// stale-data/error-banner branch — otherwise a fast poll would flash a spurious "reconnecting…".
describe("loaders — aborted request", () => {
  function abortedRequest(): Request {
    const controller = new AbortController();
    controller.abort();
    return new Request("http://localhost/", { signal: controller.signal });
  }

  it("rootLoader rethrows the abort instead of returning stale/error data", async () => {
    const { rootLoader } = await import("./loaders");
    await expect(rootLoader({ request: abortedRequest() })).rejects.toThrow();
  });

  it("paneLoader rethrows the abort instead of returning stale/error data", async () => {
    const { paneLoader } = await import("./loaders");
    await expect(
      paneLoader({ params: { paneId: "w1:p1" }, request: abortedRequest() }),
    ).rejects.toThrow();
  });
});
