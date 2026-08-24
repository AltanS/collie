import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fixturePackSnapshot, fixtureSnapshot } from "@/test/handlers";
import { __resetConnectionHealth, isLostLatched, lastHealthyAt } from "./connection-health";
import { isConnecting } from "./connection";
import {
  checkForUpdates,
  createTab,
  fetchConfig,
  fetchPane,
  fetchSnapshot,
  getNotifyPrefs,
  refreshNow,
  sendKeys,
  sendReply,
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
    // SAFETY: `timeoutSpy` spies on `AbortSignal.timeout`, whose return type IS an AbortSignal;
    // `results[0]` exists because the call above went through it. Vitest types a spy result value
    // as `any`, which is the only reason this is written down.
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

// The browser URL uses the short `?h=` / `?s=`; on the wire every scoped endpoint takes the long
// names `host=` and `session=`, in that fixed order. A named host/session must append its param
// (composing correctly with fetchPane's `?lines=`); the lead's primary session (both undefined) must
// leave the path untouched, so a solo bridge sees byte-identical requests to what shipped.
describe("api client — scope on the wire", () => {
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
    const scope = { session: "collie-demo" };
    await fetchSnapshot(scope);
    await fetchPane("w1:p1", 600, scope);
    await sendReply("w1:p1", "hi", true, scope);
    expect(urls[0]).toBe("/api/snapshot?session=collie-demo");
    expect(urls[1]).toBe("/api/pane/w1%3Ap1?lines=600&session=collie-demo");
    expect(urls[2]).toBe("/api/pane/w1%3Ap1/reply?session=collie-demo");
  });

  it("appends host= before session=, composing with an existing query", async () => {
    const urls = captureUrls();
    const scope = { host: "badger", session: "collie-demo" };
    await fetchSnapshot(scope);
    await fetchPane("w1:p1", 600, scope);
    await sendReply("w1:p1", "hi", true, scope);
    expect(urls[0]).toBe("/api/snapshot?host=badger&session=collie-demo");
    expect(urls[1]).toBe("/api/pane/w1%3Ap1?lines=600&host=badger&session=collie-demo");
    expect(urls[2]).toBe("/api/pane/w1%3Ap1/reply?host=badger&session=collie-demo");
  });

  it("appends host= alone on a peer's primary session", async () => {
    const urls = captureUrls();
    await fetchSnapshot({ host: "badger" });
    await fetchPane("w1:p1", 600, { host: "badger" });
    expect(urls[0]).toBe("/api/snapshot?host=badger");
    expect(urls[1]).toBe("/api/pane/w1%3Ap1?lines=600&host=badger");
  });

  it("URL-encodes both params", async () => {
    const urls = captureUrls();
    await fetchSnapshot({ host: "a b", session: "c d" });
    expect(urls[0]).toBe("/api/snapshot?host=a%20b&session=c%20d");
  });

  it("leaves the path untouched on the lead's primary session (no param)", async () => {
    const urls = captureUrls();
    await fetchSnapshot();
    await fetchPane("w1:p1", 600);
    await fetchSnapshot({});
    await fetchSnapshot({ host: "  ", session: "  " });
    expect(urls[0]).toBe("/api/snapshot");
    expect(urls[1]).toBe("/api/pane/w1%3Ap1?lines=600");
    expect(urls[2]).toBe("/api/snapshot");
    expect(urls[3]).toBe("/api/snapshot");
  });

  // THE invariant this dimension exists for. fetchPane keeps a client-side (ETag, body) cache and
  // sends If-None-Match on the next poll; a pane id is unique only within one session on one machine,
  // so a key that stopped at (session, paneId) would let one host's mirror 304 into another's. Same
  // bug the session component was added to prevent, one dimension deeper — and this time the wrong
  // answer is a phone showing you machine A's terminal while every write goes to machine B.
  it("never serves one host's ETag or body to another host's same pane id", async () => {
    const seen: { url: string; inm: string | null }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, inm: headers.get("if-none-match") });
      const host = new URL(url, "http://localhost").searchParams.get("host") ?? "lead";
      return new Response(
        JSON.stringify({ paneId: "w1:p1", text: `mirror of ${host}`, truncated: false, revision: 1 }),
        { status: 200, headers: { "content-type": "application/json", etag: `"etag-${host}"` } },
      );
    });

    await fetchPane("w1:p1", 600); // the lead — caches "etag-lead"
    await fetchPane("w1:p1", 600, { host: "badger" }); // a peer, SAME pane id

    // The peer's first read must be unconditional: it has no cache entry of its own, and it must not
    // inherit the lead's ETag (which would 304 it into the lead's mirror).
    expect(seen[0]?.inm).toBeNull();
    expect(seen[1]?.inm).toBeNull();

    // Second round: each now revalidates with ITS OWN etag, and gets ITS OWN body.
    const lead = await fetchPane("w1:p1", 600);
    const peer = await fetchPane("w1:p1", 600, { host: "badger" });
    expect(seen[2]?.inm).toBe('"etag-lead"');
    expect(seen[3]?.inm).toBe('"etag-badger"');
    expect(lead.text).toBe("mirror of lead");
    expect(peer.text).toBe("mirror of badger");
  });

  it("keys the pane cache by session within a host too", async () => {
    const inms: (string | null)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      inms.push(new Headers(init?.headers).get("if-none-match"));
      const q = new URL(String(input), "http://localhost").searchParams;
      const tag = `${q.get("host") ?? "-"}/${q.get("session") ?? "-"}`;
      return new Response(
        JSON.stringify({ paneId: "w1:p1", text: tag, truncated: false, revision: 1 }),
        { status: 200, headers: { "content-type": "application/json", etag: `"${tag}"` } },
      );
    });
    // A host this file has not touched, so the module-scoped cache starts empty for both scopes.
    await fetchPane("w1:p1", 600, { host: "otter" });
    await fetchPane("w1:p1", 600, { host: "otter", session: "demo" });
    expect(inms).toEqual([null, null]); // neither inherited the other's ETag
    await fetchPane("w1:p1", 600, { host: "otter", session: "demo" });
    expect(inms[2]).toBe('"otter/demo"');
  });

  // The bridge-wide endpoints are the lead's own: push config, quiet hours and the update banner
  // belong to the collie this phone is talking to, and a per-host copy would be pack administration.
  it("never scopes the bridge-wide endpoints", async () => {
    const urls = captureUrls();
    await fetchConfig();
    await getNotifyPrefs();
    await checkForUpdates();
    expect(urls).toEqual([
      "/api/config",
      "/api/notifications/prefs",
      "/api/update/check",
    ]);
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

  // ── TIER 2 IS PAYLOAD, NOT TRANSPORT ───────────────────────────────────────
  // A peer being down is a FACT the lead reports inside a 200, so the poll that carried it was live
  // in every sense tier 1 cares about. If it suppressed the stamp instead, one quiet machine in a
  // pack would escalate the whole phone to "not connected", pause polling, and take the dashboard
  // offline — the exact conflation lib/host-health.ts exists to prevent.
  it("stamps a live moment even when the snapshot reports unreachable peers", async () => {
    server.use(http.get("/api/snapshot", () => HttpResponse.json(fixturePackSnapshot)));
    __resetConnectionHealth(1);
    const snap = await fetchSnapshot();
    expect(snap.servers?.some((s) => !s.reachable)).toBe(true); // the fixture's `attic` is down
    expect(lastHealthyAt()).toBeGreaterThan(1);
    // …and nothing about a peer outage may reach the global escalation or the poll-truth predicate.
    expect(isLostLatched()).toBe(false);
    expect(isConnecting({ bridge: snap.bridge, error: false, stalled: false })).toBe(false);
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
// instead. Every path that talks to the bridge must carry it, including the two that bypass `req`:
// fetchPane builds its own header bag, and uploadImage sets none at all so the browser keeps
// ownership of the multipart boundary.
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

  it("marks reads, mutations, pane polls and uploads alike", async () => {
    const seen = captureHeaders();
    await fetchSnapshot();
    await sendReply("w1:p1", "hi");
    await fetchPane("w1:p1");
    await uploadImage("w1:p1", new File(["x"], "x.png", { type: "image/png" }));
    expect(seen).toHaveLength(4);
    for (const headers of seen) expect(headers.get(XHR_HEADER)).toBe(XHR_HEADER_VALUE);
  });

  it("leaves the multipart upload without a content-type so the boundary survives", async () => {
    const seen = captureHeaders();
    await uploadImage("w1:p1", new File(["x"], "x.png", { type: "image/png" }));
    expect(seen[0].get("content-type")).toBeNull();
  });
});

// "LOOK NOW" — the one write-shaped call that is a read, and the one scope it declines to make.
describe("refreshNow", () => {
  it("posts to /api/refresh for the local collie", async () => {
    let calls = 0;
    server.use(
      http.post("/api/refresh", () => {
        calls += 1;
        return HttpResponse.json({ ok: true });
      }),
    );
    await refreshNow();
    expect(calls).toBe(1);
  });

  it("carries the session so a named session refreshes its own multiplexer, not the primary's", async () => {
    let seen = "";
    server.use(
      http.post("/api/refresh", ({ request }) => {
        seen = new URL(request.url).search;
        return HttpResponse.json({ ok: true });
      }),
    );
    await refreshNow({ session: "laptop" });
    expect(seen).toBe("?session=laptop");
  });

  it("sends NOTHING for a peer — the route is not on the pack link's forwarding table", async () => {
    let calls = 0;
    server.use(
      http.post("/api/refresh", () => {
        calls += 1;
        return HttpResponse.json({ ok: true });
      }),
    );
    await refreshNow({ host: "laptop" });
    expect(calls).toBe(0);
  });

  it("swallows a refusal: the revalidation that follows is the one that reports", async () => {
    server.use(http.post("/api/refresh", () => new HttpResponse("nope", { status: 503 })));
    await expect(refreshNow()).resolves.toBeUndefined();
  });
});
