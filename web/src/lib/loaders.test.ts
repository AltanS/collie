import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fixtureAgents, fixtureSnapshot, paneTextWithDraft } from "@/test/handlers";

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

const rejectSnapshot = (status: 401 | 403) =>
  server.use(http.get("/api/snapshot", () => new HttpResponse(null, { status })));

const failPane = () =>
  server.use(http.get(/\/api\/pane\/[^/]+$/, () => new HttpResponse(null, { status: 500 })));

const rejectPane = (status: 401 | 403) =>
  server.use(http.get(/\/api\/pane\/[^/]+$/, () => new HttpResponse(null, { status })));

describe("rootLoader", () => {
  it("returns a fresh snapshot with authoritative cache presence", async () => {
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.snapshotStale).toBe(false);
    expect(data.snapshotAuthError).toBe(false);
    expect(data.snapshotHasLastGood).toBe(true);
    expect(data.bridge).toBe("connected");
    expect(data.agents).toHaveLength(2);
  });

  it("reports a cold root failure without inventing a cached snapshot", async () => {
    failSnapshot();
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.snapshotStale).toBe(true);
    expect(data.snapshotAuthError).toBe(false);
    expect(data.snapshotHasLastGood).toBe(false);
    expect(data.agents).toEqual([]);
    expect(data.bridge).toBeUndefined();
  });

  it.each([401, 403] as const)("gives root auth precedence for a %i response", async (status) => {
    rejectSnapshot(status);
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.snapshotStale).toBe(true);
    expect(data.snapshotAuthError).toBe(true);
    expect(data.snapshotHasLastGood).toBe(false);
  });

  it("keeps the last-good root snapshot on a failed refresh", async () => {
    const { rootLoader } = await import("./loaders");
    await rootLoader();
    failSnapshot();

    const stale = await rootLoader();
    expect(stale.snapshotStale).toBe(true);
    expect(stale.snapshotAuthError).toBe(false);
    expect(stale.snapshotHasLastGood).toBe(true);
    expect(stale.bridge).toBe("connected");
    expect(stale.agents[0]!.paneId).toBe(fixtureAgents[0]!.paneId);
  });

  it("keeps cache presence for an intentionally empty root snapshot", async () => {
    let calls = 0;
    server.use(
      http.get("/api/snapshot", () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ ...fixtureSnapshot, agents: [], shellPanes: [] })
          : new HttpResponse(null, { status: 500 });
      }),
    );
    const { rootLoader } = await import("./loaders");
    await rootLoader();
    const stale = await rootLoader();

    expect(stale.snapshotHasLastGood).toBe(true);
    expect(stale.agents).toEqual([]);
  });

  it("still fetches each root navigation after a failure", async () => {
    const { rootLoader } = await import("./loaders");
    failSnapshot();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await rootLoader({ request: new Request("http://localhost/") });
    await rootLoader({ request: new Request("http://localhost/space/w1") });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("surfaces the snapshot's optional update and voice capability", async () => {
    const update = {
      current: "0.11.0",
      latest: "0.12.0",
      releaseAvailable: true,
      bridgeStale: false,
      checkedAt: 123,
    };
    server.use(
      http.get("/api/snapshot", () =>
        HttpResponse.json({ ...fixtureSnapshot, update, transcriptionEnabled: true }),
      ),
    );
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.update).toEqual(update);
    expect(data.transcriptionEnabled).toBe(true);
  });
});

describe("paneLoader", () => {
  it("returns a fresh pane result with authoritative cache presence", async () => {
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({ params: { paneId: "w1:p1" } });
    expect(data.paneStale).toBe(false);
    expect(data.paneAuthError).toBe(false);
    expect(data.paneHasLastGood).toBe(true);
    expect(data.text).toBe(paneTextWithDraft());
  });

  it("reports a cold pane failure without cached output", async () => {
    failPane();
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({ params: { paneId: "wX:p9" } });
    expect(data.paneStale).toBe(true);
    expect(data.paneAuthError).toBe(false);
    expect(data.paneHasLastGood).toBe(false);
    expect(data.text).toBe("");
  });

  it.each([401, 403] as const)("gives pane auth precedence for a %i response", async (status) => {
    rejectPane(status);
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({ params: { paneId: "w1:p1" } });
    expect(data.paneStale).toBe(true);
    expect(data.paneAuthError).toBe(true);
    expect(data.paneHasLastGood).toBe(false);
  });

  it("keeps a stale cached pane, including intentionally empty output", async () => {
    let calls = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ paneId: "w1:p1", text: "", truncated: false, revision: 1 })
          : new HttpResponse(null, { status: 500 });
      }),
    );
    const { paneLoader } = await import("./loaders");
    await paneLoader({ params: { paneId: "w1:p1" } });
    const stale = await paneLoader({ params: { paneId: "w1:p1" } });

    expect(stale.paneStale).toBe(true);
    expect(stale.paneAuthError).toBe(false);
    expect(stale.paneHasLastGood).toBe(true);
    expect(stale.text).toBe("");
  });

  it("keeps root and pane outcomes independent", async () => {
    const { rootLoader, paneLoader } = await import("./loaders");
    await rootLoader();
    failSnapshot();
    const staleRoot = await rootLoader();
    const freshPane = await paneLoader({ params: { paneId: "w1:p1" } });

    expect(staleRoot.snapshotStale).toBe(true);
    expect(freshPane.paneStale).toBe(false);
  });

  it("keeps a fresh root result when only the pane refresh fails", async () => {
    const { rootLoader, paneLoader } = await import("./loaders");
    await paneLoader({ params: { paneId: "w1:p1" } });
    failPane();

    const freshRoot = await rootLoader();
    const stalePane = await paneLoader({ params: { paneId: "w1:p1" } });

    expect(freshRoot.snapshotStale).toBe(false);
    expect(stalePane.paneStale).toBe(true);
  });

  it("does not share auth outcomes between root and pane loaders", async () => {
    rejectPane(401);
    const { rootLoader, paneLoader } = await import("./loaders");
    const pane = await paneLoader({ params: { paneId: "w1:p1" } });
    const root = await rootLoader();

    expect(pane.paneAuthError).toBe(true);
    expect(root.snapshotAuthError).toBe(false);
  });

  it("throws on a missing :paneId param", async () => {
    const { paneLoader } = await import("./loaders");
    await expect(paneLoader({ params: {} })).rejects.toThrow(/paneId/);
  });
});

describe("requested-lines bookkeeping (Load older)", () => {
  // The cap is 1000 because HERDR clamps `pane.read` there (live-probed: 2000 and 6000 both return
  // 1001 lines against a 6895-line buffer). With a 600-line base window that means exactly ONE
  // useful tap — which is the honest ceiling, not a shortfall in the stepping.
  it("defaults to the base window and grows to Herdr's real ceiling in one tap", async () => {
    const { getRequestedLines, growRequestedLines, canGrowRequestedLines, DETAIL_HISTORY_MAX } =
      await import("./loaders");
    expect(DETAIL_HISTORY_MAX).toBe(1000);
    expect(getRequestedLines("w1:p1")).toBe(600);
    expect(canGrowRequestedLines("w1:p1")).toBe(true);

    // A 600 step would overshoot the cap, so the first tap lands exactly on it.
    expect(growRequestedLines("w1:p1")).toBe(DETAIL_HISTORY_MAX);
    expect(getRequestedLines("w1:p1")).toBe(DETAIL_HISTORY_MAX);

    // Further taps clamp rather than climb, and the affordance switches off.
    expect(growRequestedLines("w1:p1")).toBe(DETAIL_HISTORY_MAX);
    expect(canGrowRequestedLines("w1:p1")).toBe(false);
  });

  it("tracks each pane independently", async () => {
    const { getRequestedLines, growRequestedLines } = await import("./loaders");
    growRequestedLines("w1:p1");
    expect(getRequestedLines("w1:p1")).toBe(1000);
    expect(getRequestedLines("w2:p1")).toBe(600); // untouched
  });

  it("the loader fetches with (and reports) the pane's requested window", async () => {
    const { paneLoader, growRequestedLines } = await import("./loaders");
    growRequestedLines("w1:p1"); // 600 → 1000 (the cap)
    const data = await paneLoader({ params: { paneId: "w1:p1" } });
    expect(data.requestedLines).toBe(1000);
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

    expect(stale.snapshotStale).toBe(true);
    expect(stale.snapshotHasLastGood).toBe(false);
    expect(stale.session).toBe("collie-demo");
    expect(stale.agents).toEqual([]); // NOT the primary session's cached herd
    expect(stale.bridge).toBeUndefined();
  });

  it("tracks requested scrollback per (session, pane) so ids can't collide across sessions", async () => {
    const { getRequestedLines, growRequestedLines } = await import("./loaders");
    growRequestedLines("w1:p1", "collie-demo");
    expect(getRequestedLines("w1:p1", "collie-demo")).toBe(1000);
    expect(getRequestedLines("w1:p1")).toBe(600); // the primary session's same id is untouched
  });
});

// A superseded revalidation aborts the in-flight fetch via request.signal. The loaders must
// RETHROW that AbortError (so React Router discards the stale run) rather than treating a
// superseded poll as a genuine stale-freshness result.
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

// historyLoader reads the agent's OWN transcript — the only conversation history a Claude pane can
// have, since its terminal runs on the alternate screen and keeps no scrollback ring. Every
// "unavailable" answer is an ordinary state the view explains, never an error banner.
describe("historyLoader", () => {
  const failHistory = (status: number) =>
    server.use(http.get(/\/api\/pane\/[^/]+\/history/, () => new HttpResponse(null, { status })));

  const unavailable = (reason: string) =>
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, () =>
        HttpResponse.json({ paneId: "w1:p1", available: false, reason }),
      ),
    );

  it("returns the newest page of turns", async () => {
    const { historyLoader } = await import("./loaders");
    const data = await historyLoader({ params: { paneId: "w1:p1" } });
    expect(data.unavailable).toBeUndefined();
    expect(data.entries.map((e) => e.uuid)).toEqual(["t1", "t2"]);
    expect(data.total).toBe(2);
    expect(data.hasMore).toBe(false);
  });

  it("asks for a bounded first page rather than the whole transcript", async () => {
    let seen = "";
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, ({ request }) => {
        seen = new URL(request.url).searchParams.get("limit") ?? "";
        return HttpResponse.json({
          paneId: "w1:p1",
          available: true,
          entries: [],
          hasMore: false,
          total: 0,
          fileTruncated: false,
        });
      }),
    );
    const { historyLoader, HISTORY_PAGE_SIZE } = await import("./loaders");
    await historyLoader({ params: { paneId: "w1:p1" } });
    expect(seen).toBe(String(HISTORY_PAGE_SIZE));
  });

  it.each([["disabled"], ["no-session"], ["no-log"]])(
    "passes through the %s reason so the view can explain it",
    async (reason) => {
      unavailable(reason);
      const { historyLoader } = await import("./loaders");
      const data = await historyLoader({ params: { paneId: "w1:p1" } });
      expect(data.unavailable).toBe(reason);
      expect(data.entries).toEqual([]);
    },
  );

  it("degrades to an error state (not a throw) when the fetch fails", async () => {
    failHistory(500);
    const { historyLoader } = await import("./loaders");
    const data = await historyLoader({ params: { paneId: "w1:p1" } });
    expect(data.unavailable).toBe("error");
    expect(data.entries).toEqual([]);
  });

  it("throws on a missing :paneId route param (a misconfigured route, not a user state)", async () => {
    const { historyLoader } = await import("./loaders");
    await expect(historyLoader({ params: {} })).rejects.toThrow(/paneId/);
  });

  it("scopes the request to the session in the request url", async () => {
    let seen: string | null = "unset";
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, ({ request }) => {
        seen = new URL(request.url).searchParams.get("session");
        return HttpResponse.json({
          paneId: "w1:p1",
          available: true,
          entries: [],
          hasMore: false,
          total: 0,
          fileTruncated: false,
        });
      }),
    );
    const { historyLoader } = await import("./loaders");
    await historyLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1:p1/history?s=demo"),
    });
    expect(seen).toBe("demo");
  });

  it("rethrows an abort instead of returning an error state", async () => {
    const controller = new AbortController();
    controller.abort();
    const { historyLoader } = await import("./loaders");
    await expect(
      historyLoader({
        params: { paneId: "w1:p1" },
        request: new Request("http://localhost/", { signal: controller.signal }),
      }),
    ).rejects.toThrow();
  });
});
