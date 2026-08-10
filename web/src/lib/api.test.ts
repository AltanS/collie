import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fixtureSnapshot } from "@/test/handlers";
import { __resetConnectionHealth, lastHealthyAt } from "./connection-health";
import {
  checkForUpdates,
  createTab,
  fetchPane,
  fetchSnapshot,
  sendKeys,
  sendReply,
  transcribeAudio,
  uploadImage,
  withTimeout,
  XHR_HEADER,
  XHR_HEADER_VALUE,
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

  it("adds expected_prompt to reply and keys bodies only when supplied", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/(reply|keys)$/, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );

    await sendReply("w1:p1", "hi", true, undefined, "Approve?\n1. Yes");
    await sendKeys("w1:p1", ["1"], undefined, "Approve?\n1. Yes");
    await sendKeys("w1:p1", ["Left"]);

    expect(bodies).toEqual([
      { text: "hi", submit: true, expected_prompt: "Approve?\n1. Yes" },
      { keys: ["1"], expected_prompt: "Approve?\n1. Yes" },
      { keys: ["Left"] },
    ]);
  });

  it("returns the structured prompt_changed result instead of throwing on 409", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, () =>
        HttpResponse.json(
          { ok: false, error: "prompt changed", code: "prompt_changed" },
          { status: 409 },
        ),
      ),
    );
    await expect(sendKeys("w1:p1", ["1"], undefined, "Approve?")).resolves.toEqual({
      ok: false,
      error: "prompt changed",
      code: "prompt_changed",
    });
  });

  // The bridge runs the binding check on BOTH endpoints that accept `expected_prompt`, so reply
  // must recover a 409 exactly like keys. They are easy to let drift apart: the recovery used to be
  // blanket handling inside the transport, and moving it to the call sites is precisely the moment
  // one of them gets forgotten and starts throwing where the other returns a value.
  it("returns the structured prompt_changed result instead of throwing on 409 for reply too", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/reply$/, () =>
        HttpResponse.json(
          { ok: false, error: "prompt changed", code: "prompt_changed" },
          { status: 409 },
        ),
      ),
    );
    await expect(sendReply("w1:p1", "hi", true, undefined, "Approve?")).resolves.toEqual({
      ok: false,
      error: "prompt changed",
      code: "prompt_changed",
    });
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

  it("transcribeAudio posts one redirect-refused multipart recording and reported duration", async () => {
    let reportedDuration = "";
    let requests = 0;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/transcribe$/, async ({ request }) => {
        // MSW's Node multipart parser does not recognise jsdom's File implementation, so assert the
        // actual encoded multipart contract rather than asking its Node-only parser to rehydrate it.
        requests += 1;
        const url = new URL(request.url);
        const body = await request.text();
        reportedDuration = body.includes("1234") ? "1234" : "";
        expect(url.pathname).toBe("/api/pane/w1%3Ap1/transcribe");
        expect(url.searchParams.get("session")).toBe("collie-demo");
        expect(request.redirect).toBe("error");
        expect(request.headers.get(XHR_HEADER)).toBe(XHR_HEADER_VALUE);
        expect(request.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
        expect(body).toContain('name="file"; filename=');
        expect(body).toContain("Content-Type: audio/webm");
        expect(body).toContain('name="duration_ms"');
        return HttpResponse.json({ ok: true, text: "editable words" });
      }),
    );
    const file = new File(["audio"], "recording.webm", { type: "audio/webm" });
    await expect(transcribeAudio("w1:p1", file, 1234, "collie-demo")).resolves.toEqual({
      ok: true,
      text: "editable words",
    });
    expect(reportedDuration).toBe("1234");
    expect(requests).toBe(1);
  });

  it("transcribeAudio preserves the bridge status error", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/transcribe$/, () => new HttpResponse("provider down", { status: 502 })),
    );
    const file = new File(["audio"], "recording.webm", { type: "audio/webm" });
    await expect(transcribeAudio("w1:p1", file, 1234)).rejects.toThrow(/502 provider down/);
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

// Voice owns a distinct 90-second total deadline because its completed multipart response can stall
// after headers. These cases stay local to the new endpoint; existing request paths retain main's
// native timeout coverage above.
describe("api client — transcription deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function stallTranscriptionBody() {
    let signal: AbortSignal | null | undefined;
    let resolveBodyRead: () => void = () => {};
    const bodyReadStarted = new Promise<void>((resolve) => {
      resolveBodyRead = resolve;
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init?: RequestInit) => {
      signal = init?.signal;
      if (!signal) throw new Error("expected transcription deadline signal");
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            signal!.addEventListener("abort", () => controller.error(signal!.reason), { once: true });
          },
          pull() {
            resolveBodyRead();
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });

    return {
      bodyReadStarted,
      get signal() {
        return signal;
      },
    };
  }

  it("keeps the 90-second deadline through a stalled transcription body", async () => {
    vi.useFakeTimers();
    const stalled = stallTranscriptionBody();
    const pending = transcribeAudio(
      "w1:p1",
      new File(["x"], "recording.webm", { type: "audio/webm" }),
      1_000,
    ).catch((error: unknown) => error);

    await stalled.bodyReadStarted;
    await vi.advanceTimersByTimeAsync(90_000);

    await expect(pending).resolves.toMatchObject({ name: "TimeoutError" });
    expect(stalled.signal?.aborted).toBe(true);
  });

  it("keeps caller cancellation through a transcription body after headers", async () => {
    const caller = new AbortController();
    const stalled = stallTranscriptionBody();
    const pending = transcribeAudio(
      "w1:p1",
      new File(["x"], "recording.webm", { type: "audio/webm" }),
      1_000,
      undefined,
      caller.signal,
    );

    await stalled.bodyReadStarted;
    caller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stalled.signal?.aborted).toBe(true);
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

// A proxy that REDIRECTS an unauthenticated request instead of refusing it strips Collie of the only
// signal `isAuthError` (lib/loaders.ts) can act on: `fetch` follows the cross-origin 302, the call
// rejects as a TypeError with no status, and the refusal banner — with the Sign-in link that would
// restore the session — never renders. Marking requests as XHR is what makes such a proxy answer 401
// instead. Every path that talks to the bridge must carry it, including the three that bypass `req`:
// fetchPane builds its own header bag; uploadImage and transcribeAudio set only this marker so the
// browser keeps ownership of each multipart boundary.
describe("api client — XHR marker for identity proxies", () => {
  afterEach(() => vi.restoreAllMocks());

  function captureHeaders() {
    const seen: Headers[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      seen.push(new Headers(init?.headers));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    return seen;
  }

  it("marks reads, mutations, pane polls, uploads and transcription alike", async () => {
    const seen = captureHeaders();
    await fetchSnapshot();
    await sendReply("w1:p1", "hi");
    await fetchPane("w1:p1");
    await uploadImage("w1:p1", new File(["x"], "x.png", { type: "image/png" }));
    await transcribeAudio("w1:p1", new File(["x"], "recording.webm", { type: "audio/webm" }), 1_000);
    expect(seen).toHaveLength(5);
    for (const headers of seen) expect(headers.get(XHR_HEADER)).toBe(XHR_HEADER_VALUE);
  });

  it("leaves multipart uploads and transcription without a content-type so boundaries survive", async () => {
    const seen = captureHeaders();
    await uploadImage("w1:p1", new File(["x"], "x.png", { type: "image/png" }));
    await transcribeAudio("w1:p1", new File(["x"], "recording.webm", { type: "audio/webm" }), 1_000);
    expect(seen).toHaveLength(2);
    for (const headers of seen) expect(headers.get("content-type")).toBeNull();
  });
});
