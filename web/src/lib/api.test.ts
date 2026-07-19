import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fixtureSnapshot } from "@/test/handlers";
import { __resetConnectionHealth, lastHealthyAt } from "./connection-health";
import {
  checkForUpdates,
  createTab,
  fetchPane,
  fetchSnapshot,
  sendReply,
  uploadImage,
  withTimeout,
} from "./api";

// The default happy-path handlers live in test/handlers.ts; here we focus on the write paths and the
// ApiError-on-non-2xx contract that every mutation depends on (and uploadImage's separate code path).
describe("api client", () => {
  it("sendReply returns the bridge's ok result on success", async () => {
    await expect(sendReply("w1:p1", "hi")).resolves.toEqual({ ok: true });
  });

  it("createTab posts and returns the created pane", async () => {
    const res = await createTab("w2");
    expect(res.ok).toBe(true);
  });

  it("throws with the status and body on a non-2xx response", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/reply$/, () => new HttpResponse("herdr down", { status: 502 })),
    );
    await expect(sendReply("w1:p1", "hi")).rejects.toThrow(/502/);
    await expect(sendReply("w1:p1", "hi")).rejects.toThrow(/herdr down/);
  });

  it("uploadImage posts multipart and returns the saved path", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: "/tmp/x.png" })),
    );
    const file = new File(["x"], "x.png", { type: "image/png" });
    await expect(uploadImage("w1:p1", file)).resolves.toEqual({ ok: true, path: "/tmp/x.png" });
  });

  it("uploadImage throws on a non-2xx via its own (non-JSON) error path", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => new HttpResponse("too big", { status: 413 })),
    );
    const file = new File(["x"], "x.png", { type: "image/png" });
    await expect(uploadImage("w1:p1", file)).rejects.toThrow(/413/);
  });

  it("checkForUpdates POSTs (no body) and returns the fresh UpdateInfo", async () => {
    const info = {
      current: "0.11.0",
      latest: "0.12.0",
      releaseAvailable: true,
      bridgeStale: false,
      checkedAt: 1_700_000_000_000,
    };
    let method: string | undefined;
    let body: string | null = null;
    server.use(
      http.post("/api/update/check", async ({ request }) => {
        method = request.method;
        body = await request.text();
        return HttpResponse.json(info);
      }),
    );
    await expect(checkForUpdates()).resolves.toEqual(info);
    expect(method).toBe("POST");
    expect(body).toBe(""); // no request body
  });

  it("checkForUpdates throws on a non-2xx response", async () => {
    server.use(http.post("/api/update/check", () => new HttpResponse("down", { status: 503 })));
    await expect(checkForUpdates()).rejects.toThrow(/503/);
  });
});

// Every request carries a deadline so a black-holed connection can't leave a fetch pending forever.
// GOTCHA: AbortSignal.timeout is NOT driven by Vitest fake timers in Node, so we don't try to
// fast-forward a 10s budget. Instead we spy on AbortSignal.timeout to assert the RIGHT budget is
// requested per endpoint class and that its signal reaches fetch, plus one real-timer test (tiny ms)
// proving the produced signal actually aborts a pending op with a TimeoutError.
describe("api client — request timeouts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("applies GET_TIMEOUT_MS (10s) to snapshot and pane reads", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    await fetchSnapshot();
    await fetchPane("w1:p1");
    expect(spy).toHaveBeenCalledWith(10_000);
    // Both are GET reads, so the only budget requested is the GET one.
    expect(spy.mock.calls.every(([ms]) => ms === 10_000)).toBe(true);
  });

  it("applies MUTATION_TIMEOUT_MS (20s) to mutations", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    await sendReply("w1:p1", "hi");
    expect(spy).toHaveBeenCalledWith(20_000);
  });

  it("applies UPLOAD_TIMEOUT_MS (60s) to image uploads", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: "/x.png" })),
    );
    const spy = vi.spyOn(AbortSignal, "timeout");
    await uploadImage("w1:p1", new File(["x"], "x.png", { type: "image/png" }));
    expect(spy).toHaveBeenCalledWith(60_000);
  });

  it("passes the timeout signal through to fetch", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    let captured: AbortSignal | null | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init?: RequestInit) => {
      captured = init?.signal;
      return new Response("{}", { status: 200 });
    });
    await fetchSnapshot();
    const produced = timeoutSpy.mock.results[0]!.value as AbortSignal;
    expect(captured).toBe(produced); // no caller signal → the timeout signal reaches fetch directly
  });

  it("composes the caller's signal with the timeout — a caller abort still surfaces as AbortError", async () => {
    // AbortSignal.any means either cause can abort the fetch. A caller (React Router) abort keeps its
    // "AbortError" name, which loaders rethrow as a superseded run — the timeout must not mask it.
    const controller = new AbortController();
    controller.abort();
    await expect(fetchSnapshot(undefined, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("withTimeout produces a signal that aborts a pending op with a TimeoutError (real timer)", async () => {
    // Parameterised ms (20) keeps this on real timers and fast. Proves the wiring yields a
    // "TimeoutError" (NOT "AbortError"), which is what makes loaders treat a timeout as degraded data.
    const signal = withTimeout(undefined, 20);
    expect(signal).toBeInstanceOf(AbortSignal);
    await expect(
      new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason));
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

// The browser URL uses the short `?s=`; on the wire every session-scoped endpoint takes `session=`.
// A named session must append that param (composing correctly with fetchPane's `?lines=`); the
// primary session (undefined) must leave the path untouched so a single-session bridge is unaffected.
describe("api client — session scoping", () => {
  afterEach(() => vi.restoreAllMocks());

  function captureUrls() {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(String(input));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    return urls;
  }

  it("appends session= to a named session (composing with ?lines=)", async () => {
    const urls = captureUrls();
    await fetchSnapshot("collie-demo");
    await fetchPane("w1:p1", 600, "collie-demo");
    await sendReply("w1:p1", "hi", true, "collie-demo");
    expect(urls[0]).toBe("/api/snapshot?session=collie-demo");
    expect(urls[1]).toBe("/api/pane/w1%3Ap1?lines=600&session=collie-demo");
    expect(urls[2]).toBe("/api/pane/w1%3Ap1/reply?session=collie-demo");
  });

  it("leaves the path untouched on the primary session (no param)", async () => {
    const urls = captureUrls();
    await fetchSnapshot();
    await fetchPane("w1:p1", 600);
    expect(urls[0]).toBe("/api/snapshot");
    expect(urls[1]).toBe("/api/pane/w1%3Ap1?lines=600");
  });
});

// The fetch layer is where liveness is stamped onto the shared lib/connection-health anchor (the same
// interception point that captures X-Collie-Build). A live snapshot/pane stamps; a 200 that reports
// the herd link down must NOT — otherwise the "Herdr is down" escalation could never fire.
describe("api client — connection-health stamping", () => {
  it("stamps a live moment on a healthy snapshot (bridge connected)", async () => {
    __resetConnectionHealth(1); // pin the anchor far in the past
    await fetchSnapshot(); // default handler → fixtureSnapshot.bridge === "connected"
    expect(lastHealthyAt()).toBeGreaterThan(1);
  });

  it("does NOT stamp when the snapshot 200s but reports the herd link disconnected", async () => {
    server.use(
      http.get("/api/snapshot", () =>
        HttpResponse.json({ ...fixtureSnapshot, bridge: "disconnected" }),
      ),
    );
    __resetConnectionHealth(1);
    await fetchSnapshot();
    expect(lastHealthyAt()).toBe(1); // a 200 that says "Herdr down" is not a provably-live moment
  });

  it("stamps a live moment on a successful pane read", async () => {
    __resetConnectionHealth(1);
    await fetchPane("w1:p1"); // default handler → 200 body
    expect(lastHealthyAt()).toBeGreaterThan(1);
  });

  it("does NOT stamp when a poll fails (the throw precedes the stamp)", async () => {
    server.use(http.get("/api/snapshot", () => new HttpResponse("boom", { status: 502 })));
    __resetConnectionHealth(1);
    await expect(fetchSnapshot()).rejects.toThrow(/502/);
    expect(lastHealthyAt()).toBe(1);
  });
});
