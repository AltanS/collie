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
  it("returns the live snapshot on success", async () => {
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.error).toBe(false);
    expect(data.authError).toBe(false);
    expect(data.bridge).toBe("connected");
    expect(data.agents).toHaveLength(2);
  });

  it.each([401, 403] as const)("marks a %i response as an auth error", async (status) => {
    rejectSnapshot(status);
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.error).toBe(true);
    expect(data.authError).toBe(true);
  });

  it("keeps the last-good herd (flagged error) when a refresh fails", async () => {
    const { rootLoader } = await import("./loaders");
    await rootLoader(); // prime the cache with a good snapshot

    failSnapshot();
    const stale = await rootLoader();

    expect(stale.error).toBe(true);
    expect(stale.authError).toBe(false);
    expect(stale.bridge).toBe("connected"); // from the cached snapshot
    expect(stale.agents).toHaveLength(2);
    expect(stale.agents[0]!.paneId).toBe(fixtureAgents[0]!.paneId);
  });

  it("does not mark a network error as an auth error", async () => {
    const { rootLoader } = await import("./loaders");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network failed"));
    const data = await rootLoader();
    expect(data.error).toBe(true);
    expect(data.authError).toBe(false);
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
    expect(data.authError).toBe(false);
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
    expect(data.authError).toBe(false);
    expect(data.paneId).toBe("w1:p1");
    expect(data.text).toBe(paneTextWithDraft());
  });

  it.each([401, 403] as const)("marks a %i response as an auth error", async (status) => {
    rejectPane(status);
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({ params: { paneId: "w1:p1" } });
    expect(data.error).toBe(true);
    expect(data.authError).toBe(true);
  });

  it("keeps the last-good pane text (flagged error) when a refresh fails", async () => {
    const { paneLoader } = await import("./loaders");
    await paneLoader({ params: { paneId: "w1:p1" } }); // prime per-pane cache

    failPane();
    const stale = await paneLoader({ params: { paneId: "w1:p1" } });

    expect(stale.error).toBe(true);
    expect(stale.authError).toBe(false);
    expect(stale.text).toBe(paneTextWithDraft());
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
    expect(stale.authError).toBe(false);
    expect(stale.text).toBe(paneTextWithDraft());
    expect(stale.paneId).toBe("w1:p1");
  });

  it("throws on a missing :paneId param (fail-loud to the error boundary)", async () => {
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
    expect(data.scope).toEqual({ host: undefined, session: "collie-demo" });
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
    expect(data.scope).toEqual({ host: undefined, session: undefined });
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
    expect(data.scope).toEqual({ host: undefined, session: "collie-demo" });
  });

  it("keeps a per-session stale cache — a failed refresh in one session shows no other's herd", async () => {
    const { rootLoader } = await import("./loaders");
    await rootLoader({ request: new Request("http://localhost/") }); // prime the primary session

    failSnapshot(); // now every snapshot 500s
    const stale = await rootLoader({ request: new Request("http://localhost/?s=collie-demo") });

    expect(stale.error).toBe(true);
    expect(stale.scope).toEqual({ host: undefined, session: "collie-demo" });
    expect(stale.agents).toEqual([]); // NOT the primary session's cached herd
    expect(stale.bridge).toBeUndefined();
  });

  it("tracks requested scrollback per (host, session, pane) so ids can't collide", async () => {
    const { getRequestedLines, growRequestedLines } = await import("./loaders");
    growRequestedLines("w1:p1", { session: "collie-demo" });
    expect(getRequestedLines("w1:p1", { session: "collie-demo" })).toBe(1000);
    expect(getRequestedLines("w1:p1")).toBe(600); // the lead's primary session, same id, untouched
    growRequestedLines("w1:p1", { host: "badger" });
    expect(getRequestedLines("w1:p1", { host: "badger" })).toBe(1000);
    expect(getRequestedLines("w1:p1")).toBe(600); // still untouched — a different machine entirely
    expect(getRequestedLines("w1:p1", { host: "badger", session: "collie-demo" })).toBe(600);
  });

  // The host dimension, end to end through a loader: the wire param, the per-scope stale cache, and
  // the nav-vs-revalidate classification a host switch must get for free (the URL changed).
  it("hands back a referentially STABLE scope across revalidations", async () => {
    const { rootLoader } = await import("./loaders");
    const a = await rootLoader({ request: new Request("http://localhost/?h=badger&s=demo") });
    const b = await rootLoader({ request: new Request("http://localhost/?h=badger&s=demo") });
    // Identity, not just equality: `data.scope` replaces a plain string in React dep arrays.
    expect(a.scope).toBe(b.scope);
    const lead = await rootLoader({ request: new Request("http://localhost/") });
    expect(lead.scope).not.toBe(a.scope);
  });

  it("rootLoader reads ?h= off the URL and sends it as host=", async () => {
    let captured: { host: string | null; session: string | null } | undefined;
    server.use(
      http.get("/api/snapshot", ({ request }) => {
        const q = new URL(request.url).searchParams;
        captured = { host: q.get("host"), session: q.get("session") };
        return HttpResponse.json(fixtureSnapshot);
      }),
    );
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader({ request: new Request("http://localhost/?h=badger&s=collie-demo") });
    expect(captured).toEqual({ host: "badger", session: "collie-demo" });
    expect(data.scope).toEqual({ host: "badger", session: "collie-demo" });
  });

  it("keeps the stale snapshot cache per HOST — one machine's failure shows no other's herd", async () => {
    const { rootLoader } = await import("./loaders");
    await rootLoader({ request: new Request("http://localhost/") }); // prime the lead

    failSnapshot();
    const stale = await rootLoader({ request: new Request("http://localhost/?h=badger") });

    expect(stale.error).toBe(true);
    expect(stale.scope).toEqual({ host: "badger", session: undefined });
    expect(stale.agents).toEqual([]); // NOT the lead's cached herd
  });

  it("paneLoader keys its stale text per host — no cross-host mirror bleed", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, ({ request }) => {
        const host = new URL(request.url).searchParams.get("host");
        return HttpResponse.json({
          paneId: "w1:p1",
          text: host ? `on ${host}` : "on the lead",
          truncated: false,
          revision: 1,
        });
      }),
    );
    const { paneLoader } = await import("./loaders");
    const lead = await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1%3Ap1"),
    });
    const peer = await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1%3Ap1?h=badger"),
    });
    expect(lead.text).toBe("on the lead");
    expect(peer.text).toBe("on badger");

    // Now fail every read: each scope must fall back to ITS OWN last-known text, not the other's.
    server.use(http.get(/\/api\/pane\/[^/]+$/, () => new HttpResponse(null, { status: 500 })));
    const leadStale = await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1%3Ap1?stale=1"),
    });
    const peerStale = await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1%3Ap1?h=badger&stale=1"),
    });
    expect(leadStale.text).toBe("on the lead");
    expect(peerStale.text).toBe("on badger");
  });
});

// A PWA must navigate INSTANTLY to last-known data while offline. During a KNOWN, escalated outage
// (the shared connection-health store has latched "lost"), a NAVIGATION (loader run at a NEW url) skips
// the doomed fetch and returns cache immediately (flagged error); a REVALIDATION (same url — the poll)
// still really fetches, so recovery is discovered and the stale data swapped out. connection-health is
// imported AFTER vi.resetModules() alongside loaders so both share one fresh module instance (the latch
// the test sets is the one the loader reads).
describe("loaders — offline navigation fast path", () => {
  it("a navigation during a known outage returns the cached snapshot INSTANTLY (error, no fetch)", async () => {
    const { rootLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");

    await rootLoader({ request: new Request("http://localhost/") }); // prime the last-good snapshot
    latchLost(); // escalated outage

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Different url ⇒ navigation ⇒ fast path: cache returned without touching the network.
    const data = await rootLoader({ request: new Request("http://localhost/space/w1") });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(data.error).toBe(true); // flagged stale
    expect(data.bridge).toBe("connected"); // last-known herd
    expect(data.agents).toHaveLength(2);
  });

  it("keeps the last auth classification on the navigation fast path", async () => {
    rejectSnapshot(401);
    const { rootLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");

    const rejected = await rootLoader({ request: new Request("http://localhost/") });
    expect(rejected.authError).toBe(true);
    latchLost();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const data = await rootLoader({ request: new Request("http://localhost/space/w1") });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(data.error).toBe(true);
    expect(data.authError).toBe(true);
  });

  // Free consequence of putting the host in the URL: a host switch changes the URL, so the existing
  // full-URL compare already classifies it as a NAVIGATION. No special case, no flag — the offline
  // fast path is correct for it the day the dimension ships.
  it("a HOST switch reads as a navigation, not a revalidation", async () => {
    const { rootLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");

    await rootLoader({ request: new Request("http://localhost/") }); // prime + set lastRootUrl
    latchLost();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Same path, different host ⇒ a different url ⇒ navigation ⇒ fast path, no network.
    const data = await rootLoader({ request: new Request("http://localhost/?h=badger") });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(data.error).toBe(true);
    expect(data.scope).toEqual({ host: "badger", session: undefined });
    // ...and it is that HOST's cache that was consulted, which is empty — never the lead's herd.
    expect(data.agents).toEqual([]);
  });

  it("a revalidation (same url) still really fetches while latched — polls keep probing", async () => {
    const { rootLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");

    await rootLoader({ request: new Request("http://localhost/") }); // sets lastRootUrl = "/"
    latchLost();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await rootLoader({ request: new Request("http://localhost/") }); // same url ⇒ revalidation
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("recovery: the next successful revalidation clears the latch and returns fresh, live data", async () => {
    const { rootLoader } = await import("./loaders");
    const { latchLost, isLostLatched } = await import("./connection-health");

    await rootLoader({ request: new Request("http://localhost/") });
    latchLost();
    expect(isLostLatched()).toBe(true);

    const data = await rootLoader({ request: new Request("http://localhost/") }); // lands (MSW success)
    expect(data.error).toBe(false);
    expect(isLostLatched()).toBe(false); // markLive cleared the latch
  });

  it("navigating to an UNVISITED pane during an outage returns a degraded pane INSTANTLY (no fetch)", async () => {
    const { paneLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");
    latchLost();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const data = await paneLoader({
      params: { paneId: "wX:p9" },
      request: new Request("http://localhost/pane/wX:p9"),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(data.error).toBe(true);
    expect(data.text).toBe(""); // never fetched → empty mirror, but instant (no 10s hang)
    expect(data.revision).toBe(0);
  });

  it("returning to a PREVIOUSLY-VISITED pane during an outage shows its stale mirror INSTANTLY", async () => {
    const { rootLoader, paneLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");

    // Visit the pane (healthy) so its text is cached, then leave to the dashboard — rootLoader clears
    // the pane discriminator so a RETURN reads as a fresh navigation, not a poll.
    await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1:p1"),
    });
    await rootLoader({ request: new Request("http://localhost/") });

    latchLost();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const data = await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1:p1"),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(data.error).toBe(true);
    expect(data.text).toBe(paneTextWithDraft()); // the stale mirror
  });

  it("polling within a pane during an outage keeps fetching (same url ⇒ revalidation)", async () => {
    const { paneLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");

    await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1:p1"),
    });
    latchLost();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1:p1"), // same url ⇒ poll ⇒ must fetch
    });
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("does NOT fast-path when the connection is not latched (a brief blip still fetches)", async () => {
    const { rootLoader } = await import("./loaders");
    // No latchLost(): a transient blip must keep really fetching on navigation, not serve stale.
    await rootLoader({ request: new Request("http://localhost/") });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await rootLoader({ request: new Request("http://localhost/space/w1") }); // navigation, but not latched
    expect(fetchSpy).toHaveBeenCalled();
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

// The lead's own clock has to reach the components, because it is what per-host staleness is measured
// against (lib/host-health.ts). It rides on HomeData rather than being read from `Date.now()` at the
// point of use — a phone whose clock is minutes off would otherwise report every peer in the pack
// permanently stale, or permanently fresh, depending on which way it is wrong.
describe("rootLoader — the snapshot's own timestamp", () => {
  it("carries `ts` through to the route data", async () => {
    server.use(
      http.get("/api/snapshot", () => HttpResponse.json({ ...fixtureSnapshot, ts: 1_234_567 })),
    );
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader({ request: new Request("http://x/") });
    expect(data.ts).toBe(1_234_567);
  });

  it("is 0 on the empty degraded shape, where there are no servers to date anyway", async () => {
    server.use(http.get("/api/snapshot", () => new HttpResponse("boom", { status: 502 })));
    // A scope nothing has ever been cached for, so `staleHome` takes its no-cache branch.
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader({ request: new Request("http://x/?h=never-fetched") });
    expect(data.error).toBe(true);
    expect(data.servers).toEqual([]);
    expect(data.ts).toBe(0);
  });
});
