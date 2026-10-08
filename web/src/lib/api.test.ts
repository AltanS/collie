import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fixtureCrewSnapshot, fixtureSnapshot } from "@/test/handlers";
import { __resetConnectionHealth, isLostLatched, lastHealthyAt } from "./connection-health";
import { isConnecting } from "./connection";
import { DEAD_DEBOUNCE_MS, isLive, resetLiveness } from "./liveness";
import { resetBasePathForTests } from "./base-path";
import { burstPaneId, resetPollIntent, sendCount } from "./poll-intent";
import {
  checkForUpdates,
  createTab,
  fetchChat,
  fetchConfig,
  fetchFileImage,
  fetchHistory,
  fetchPane,
  fetchSnapshot,
  filesImagePath,
  getNotifyPrefs,
  POLL_TIMEOUT_MS,
  readFailureKind,
  imageSrc,
  refreshNow,
  sendKeys,
  sendReply,
  textBeforeLastSend,
  uploadFile,
  sttTimeoutFor,
  transcribeAudio,
  withTimeout,
  XHR_HEADER,
  XHR_HEADER_VALUE,
} from "./api";

// The default happy-path handlers live in test/handlers.ts; here we focus on the write paths and the
// ApiError-on-non-2xx contract that every mutation depends on (and uploadFile's separate code path).
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

  it("adds expected_styled to a keys body only when supplied, beside expected_prompt", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );

    await sendKeys("w1:p1", ["Enter"], undefined, "Approve?", "styled lines");
    await sendKeys("w1:p1", ["Enter"], undefined, "Approve?");

    expect(bodies).toEqual([
      { keys: ["Enter"], expected_prompt: "Approve?", expected_styled: "styled lines" },
      { keys: ["Enter"], expected_prompt: "Approve?" },
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

  it("keeps the bridge's reason code on the 409 result, and drops one that is not a plain code", async () => {
    const respond = (reason: string) =>
      server.use(
        http.post(/\/api\/pane\/[^/]+\/keys$/, () =>
          HttpResponse.json(
            { ok: false, error: "prompt changed", code: "prompt_changed", reason },
            { status: 409 },
          ),
        ),
      );
    respond("style_misaligned");
    await expect(sendKeys("w1:p1", ["1"], undefined, "Approve?")).resolves.toEqual({
      ok: false,
      error: "prompt changed",
      code: "prompt_changed",
      reason: "style_misaligned",
    });
    respond("Approve this command? 1. Yes");
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

  // The burst starts at this one chokepoint, so a dialog tap, the key bar and the composer's typed
  // text never have to remember to start it (a card that waited for the idle poll kept a stale
  // highlight for up to 6 s).
  describe("the poll burst", () => {
    beforeEach(() => resetPollIntent());
    afterEach(() => resetPollIntent());

    it("a successful sendKeys starts a burst for that pane, on issue and again on the ok answer", async () => {
      expect(burstPaneId()).toBeNull();
      const pending = sendKeys("w1:p1", ["Up"]);
      // Issued, not yet answered: the operator is already watching.
      expect(burstPaneId()).toBe("w1:p1");
      expect(sendCount()).toBe(1);
      await pending;
      expect(burstPaneId()).toBe("w1:p1");
      expect(sendCount()).toBe(2);
    });

    it("a successful sendReply starts a burst for that pane", async () => {
      await sendReply("w1:p2", "hi");
      expect(burstPaneId()).toBe("w1:p2");
      expect(sendCount()).toBe(2);
    });

    // The rule: stamp on issue, and again only on an ok answer. A write that fails leaves the one
    // issue stamp, which is harmless because a burst ends itself after its minimum polls and two quiet
    // ones (poll-intent.ts); nothing here can keep the fast gap running.
    it("a failed sendKeys leaves only the stamp from the issue, never a second one", async () => {
      server.use(
        http.post(/\/api\/pane\/[^/]+\/keys$/, () => new HttpResponse("herdr down", { status: 502 })),
      );
      await expect(sendKeys("w1:p1", ["Up"])).rejects.toThrow(/502/);
      expect(sendCount()).toBe(1);
      server.use(
        http.post(/\/api\/pane\/[^/]+\/keys$/, () =>
          HttpResponse.json(
            { ok: false, error: "prompt changed", code: "prompt_changed" },
            { status: 409 },
          ),
        ),
      );
      await sendKeys("w1:p1", ["Up"], undefined, "Approve?");
      expect(sendCount()).toBe(2); // one more issue stamp, no ok stamp
    });

    it("remembers what the pane showed when the latest key was sent, not what it shows after", async () => {
      let text = "before";
      server.use(
        http.get(/\/api\/pane\/[^/]+$/, () =>
          HttpResponse.json({ paneId: "w9:p9", text, truncated: false, revision: 0 }, { headers: { etag: `"${text}"` } }),
        ),
      );
      expect(textBeforeLastSend("w9:p9")).toBeUndefined();
      await fetchPane("w9:p9");
      await sendKeys("w9:p9", ["Up"]);
      text = "after";
      await fetchPane("w9:p9");
      expect(textBeforeLastSend("w9:p9")).toBe("before");
    });
  });

  it("uploadFile posts multipart and returns the saved path", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: "/tmp/x.png" })),
    );
    const file = new File(["x"], "x.png", { type: "image/png" });
    await expect(uploadFile("w1:p1", file)).resolves.toEqual({ ok: true, path: "/tmp/x.png" });
  });

  it("uploadFile throws on a non-2xx via its own (non-JSON) error path", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => new HttpResponse("too big", { status: 413 })),
    );
    const file = new File(["x"], "x.png", { type: "image/png" });
    await expect(uploadFile("w1:p1", file)).rejects.toThrow(/413/);
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

  // M46 pass 3: the poll reads get 6s, one second above the bridge's own 5s mux timeout. A request
  // into a VPN with the radio off hangs instead of failing, and the old 10s leash made the phone slow
  // to admit the network was gone.
  it("applies POLL_TIMEOUT_MS (6s) to the four poll reads: herd, pane, Chat window, config", async () => {
    expect(POLL_TIMEOUT_MS).toBe(6_000);
    const spy = vi.spyOn(AbortSignal, "timeout");
    await fetchSnapshot();
    await fetchPane("w1:p1");
    await fetchChat("w1:p1");
    await fetchConfig();
    expect(spy.mock.calls.map(([ms]) => ms)).toEqual([6_000, 6_000, 6_000, 6_000]);
  });

  it("keeps the 10s leash on the long reads: a `?before=` page and the History page", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    await fetchChat("w1:p1", { limit: 40, before: { seq: 1, uuid: "a" } }).catch(() => {});
    await fetchHistory("w1:p1", { limit: 5000 }).catch(() => {});
    expect(spy.mock.calls.map(([ms]) => ms)).toEqual([10_000, 10_000]);
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
    await uploadFile("w1:p1", new File(["x"], "x.png", { type: "image/png" }));
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

// ── WHAT A FAILED READ SAYS ABOUT THE CONNECTION (M46 pass 3) ───────────────
describe("api client — failed reads and the outage latch", () => {
  beforeEach(() => __resetConnectionHealth());
  afterEach(() => vi.restoreAllMocks());

  // jsdom's DOMException is not an Error subclass, a browser's is; the stand-ins below are what a
  // browser hands the catch.
  const named = (name: string) => Object.assign(new Error(name), { name });

  it("classifies a thrown fetch and a deadline as network, a 5xx as server, the rest as other", () => {
    expect(readFailureKind(new TypeError("Failed to fetch"))).toBe("network");
    expect(readFailureKind(named("TimeoutError"))).toBe("network");
    // A superseded poll is the app's own abort, not the bridge failing.
    expect(readFailureKind(named("AbortError"))).toBe("other");
    expect(readFailureKind(new Error("anything"))).toBe("other");
  });

  it("classifies the bridge's own answers: a 5xx is server, a 4xx refusal is other", async () => {
    server.use(http.get("/api/snapshot", () => new HttpResponse("bad gateway", { status: 502 })));
    const server502 = await fetchSnapshot().then(() => null, (e: Error) => e);
    expect(readFailureKind(server502)).toBe("server");
    server.use(http.get("/api/snapshot", () => new HttpResponse("nope", { status: 404 })));
    const refused = await fetchSnapshot().then(() => null, (e: Error) => e);
    expect(readFailureKind(refused)).toBe("other");
  });

  it("a herd read that gets no answer latches the outage on the first failure", async () => {
    server.use(http.get("/api/snapshot", () => HttpResponse.error()));
    await expect(fetchSnapshot()).rejects.toBeInstanceOf(TypeError);
    expect(isLostLatched()).toBe(true);
  });

  it("a herd read that runs out of time latches the outage too", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort(named("TimeoutError")));
    await expect(fetchSnapshot()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(isLostLatched()).toBe(true);
  });

  // WebKit rejects ANY aborted fetch with a generic AbortError ("Fetch is aborted"), a deadline
  // included. The signal still carries its own reason, and the client reads it back.
  const webkitFetch = () =>
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        const fail = () => reject(named("AbortError"));
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail);
      });
    });

  it("a deadline WebKit reports as an AbortError is still a TimeoutError, and latches the outage", async () => {
    webkitFetch();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort(named("TimeoutError")));
    await expect(fetchSnapshot()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(isLostLatched()).toBe(true);
  });

  it("the app's own abort stays an AbortError on that engine and latches nothing", async () => {
    webkitFetch();
    const controller = new AbortController();
    controller.abort(named("AbortError"));
    await expect(fetchSnapshot(undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(isLostLatched()).toBe(false);
  });

  it("the two-failure rule: one 5xx latches nothing, the second in a row does, and a live answer clears it", async () => {
    server.use(http.get("/api/snapshot", () => new HttpResponse("bad gateway", { status: 502 })));
    await fetchSnapshot().catch(() => {});
    expect(isLostLatched()).toBe(false);
    await fetchSnapshot().catch(() => {});
    expect(isLostLatched()).toBe(true);
    server.use(http.get("/api/snapshot", () => HttpResponse.json(fixtureSnapshot)));
    await fetchSnapshot();
    expect(isLostLatched()).toBe(false);
  });

  it("a live answer between two 5xx resets the count", async () => {
    let status = 502;
    server.use(
      http.get("/api/snapshot", () =>
        status === 200 ? HttpResponse.json(fixtureSnapshot) : new HttpResponse("bad gateway", { status }),
      ),
    );
    await fetchSnapshot().catch(() => {});
    status = 200;
    await fetchSnapshot();
    status = 502;
    await fetchSnapshot().catch(() => {});
    expect(isLostLatched()).toBe(false);
  });

  it("a read the app aborted itself counts nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    await fetchSnapshot(undefined, controller.signal).catch(() => {});
    expect(isLostLatched()).toBe(false);
  });

  it("a refusal latches nothing: the bridge answered", async () => {
    server.use(http.get("/api/snapshot", () => new HttpResponse("nope", { status: 404 })));
    await fetchSnapshot().catch(() => {});
    await fetchSnapshot().catch(() => {});
    expect(isLostLatched()).toBe(false);
  });
});

// A transcription deadline is a function of the clip, not a constant. The beta shipped a flat 60s,
// which failed a five-minute recording on a mobile uplink while being far more slack than a
// five-second one ever needs.
describe("api client — the transcription deadline scales with the clip", () => {
  it("a longer clip earns a longer deadline, always", () => {
    const small = sttTimeoutFor(64 * 1024);
    const large = sttTimeoutFor(8 * 1024 * 1024);
    expect(large).toBeGreaterThan(small);
  });

  it("an 8 MiB clip — the largest Collie will record — is allowed a little under six minutes", () => {
    const budget = sttTimeoutFor(8 * 1024 * 1024);
    expect(budget).toBeGreaterThan(5 * 60_000);
    expect(budget).toBeLessThan(6 * 60_000);
  });

  it("a short clip still keeps the whole fixed allowance the provider and the round trip need", () => {
    // 80s of provider deadline + overhead, before a single byte of audio is counted.
    expect(sttTimeoutFor(0)).toBe(80_000);
    expect(sttTimeoutFor(20 * 1024)).toBeGreaterThan(80_000);
  });

  it("a nonsense size cannot produce a deadline shorter than the fixed allowance", () => {
    expect(sttTimeoutFor(-1)).toBe(80_000);
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
  // belong to the collie this phone is talking to, and a per-host copy would be crew administration.
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
// A journal is an AGENT's own output, so an image reference in it is untrusted content. Two shapes
// are loadable and nothing else — the bridge refuses the rest too, and this is the check on the side
// that would do the fetching.
describe("api client — which image references this phone will load", () => {
  const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  it("takes a blob path, and carries the host the pane belongs to", () => {
    expect(imageSrc(`/api/blobs/${hash}`)).toBe(`/api/blobs/${hash}`);
    expect(imageSrc(`/api/blobs/${hash}`, { host: "badger" })).toBe(
      `/api/blobs/${hash}?host=badger`,
    );
    expect(imageSrc(`/api/blobs/${hash}`, { host: "badger", session: "demo" })).toBe(
      `/api/blobs/${hash}?host=badger&session=demo`,
    );
  });

  it("takes an inline data image, unscoped — it IS the bytes", () => {
    expect(imageSrc("data:image/png;base64,AAAA", { host: "badger" })).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("refuses a remote URL, a non-image data URL, and a path that is not a blob", () => {
    for (const ref of [
      "https://evil.example/x.png",
      "http://evil.example/x.png",
      "//evil.example/x.png",
      "data:text/html;base64,PHNjcmlwdD4=",
      "/api/blobs/../snapshot",
      `/api/blobs/${hash}x`,
      "/api/blobs/1234",
    ]) {
      expect(imageSrc(ref)).toBeNull();
    }
  });
});

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
  // crew would escalate the whole phone to "not connected", pause polling, and take the dashboard
  // offline — the exact conflation lib/host-health.ts exists to prevent.
  it("stamps a live moment even when the snapshot reports unreachable peers", async () => {
    server.use(http.get("/api/snapshot", () => HttpResponse.json(fixtureCrewSnapshot)));
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
// restore the session — never renders. The XHR marker handles proxies that honour it; manual redirect
// handling covers forward-auth layers that turn the refusal back into a 3xx. Every path that talks to
// the bridge must carry both behaviours, including pane reads and multipart uploads that bypass `req`.
describe("api client — identity proxy refusals", () => {
  afterEach(() => vi.restoreAllMocks());

  function captureRequests() {
    const headers: Headers[] = [];
    const redirects: (RequestRedirect | undefined)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      headers.push(new Headers(init?.headers));
      redirects.push(init?.redirect);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    return { headers, redirects };
  }

  it("marks reads, mutations, pane polls and uploads as XHR and disables redirect following", async () => {
    const seen = captureRequests();
    await fetchSnapshot();
    await sendReply("w1:p1", "hi");
    await fetchPane("w1:p1");
    await uploadFile("w1:p1", new File(["x"], "x.png", { type: "image/png" }));
    expect(seen.headers).toHaveLength(4);
    for (const headers of seen.headers) expect(headers.get(XHR_HEADER)).toBe(XHR_HEADER_VALUE);
    expect(seen.redirects).toEqual(["manual", "manual", "manual", "manual"]);
  });

  it("leaves the multipart upload without a content-type so the boundary survives", async () => {
    const seen = captureRequests();
    await uploadFile("w1:p1", new File(["x"], "x.png", { type: "image/png" }));
    expect(seen.headers[0].get("content-type")).toBeNull();
  });

  it("turns a fronting proxy 3xx into the 401 auth path the loader understands", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302 }));
    await expect(fetchSnapshot()).rejects.toThrow(/401.*requires sign-in/);
  });

  it("turns a browser manual opaqueredirect into the same 401 auth path", async () => {
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, "type", { value: "opaqueredirect" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    await expect(fetchSnapshot()).rejects.toThrow(/401.*requires sign-in/);
  });

  // The fourth bridge call site. It bypasses `req` like the other two and, unlike them, returns its
  // refusal as a value instead of throwing — so a proxy 3xx has to arrive here as a plain 401 too,
  // or the composer prints a transport error where the sign-in sentence belongs.
  it("turns a fronting proxy 3xx on the transcribe POST into a 401 result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302 }));
    const result = await transcribeAudio(new Blob(["x"], { type: "audio/webm" }));
    expect(result).toMatchObject({ ok: false, status: 401 });
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

  it("sends NOTHING for a peer — the route is not on the crew link's forwarding table", async () => {
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

// ADR 0052: every caller spells `/api/…`; the mount the bridge served the document under is put in
// front of it in one place, `apiFetch`.
describe("api client under a mount", () => {
  afterEach(() => {
    document.querySelector('meta[name="collie-base"]')?.remove();
    resetBasePathForTests();
  });

  it("asks for /collie/api/… when the document says it is mounted at /collie/", async () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "collie-base");
    meta.setAttribute("content", "/collie/");
    document.head.appendChild(meta);
    resetBasePathForTests();
    const asked: string[] = [];
    server.use(
      http.get("/collie/api/snapshot", ({ request }) => {
        asked.push(new URL(request.url).pathname);
        return HttpResponse.json(fixtureSnapshot);
      }),
    );
    await fetchSnapshot();
    expect(asked).toEqual(["/collie/api/snapshot"]);
  });
});

// ── THE LIVE SESSION READ (ADR 0073) ────────────────────────────────────────────────────────────
// The transport half of spec 09: which query it builds, and the three outcomes a caller must tell
// apart. The merge itself is `lib/chat-window.test.ts` and has no fetch in it at all.
describe("fetchChat", () => {
  const liveBody = (paneId: string) => ({
    paneId,
    available: true,
    page: "live",
    gen: 7,
    rev: 3,
    head: 1_000_002,
    oldest: 1_000_000,
    hasOlder: false,
    upserts: [],
  });

  function captureChat(paneId: string, etag?: string) {
    const asked: string[] = [];
    const seen: Headers[] = [];
    server.use(
      http.get(`/api/pane/${paneId}/chat`, ({ request }) => {
        const url = new URL(request.url);
        asked.push(url.search);
        seen.push(request.headers);
        return HttpResponse.json(liveBody(paneId), etag ? { headers: { etag } } : undefined);
      }),
    );
    return { asked, seen };
  }

  it("asks with no query at all when the caller holds nothing", async () => {
    const { asked } = captureChat("chat-plain");
    await fetchChat("chat-plain");
    expect(asked).toEqual([""]);
  });

  it("spells the two cursors the way the bridge parses them", async () => {
    const after = captureChat("chat-after");
    await fetchChat("chat-after", { limit: 40, after: { gen: 7, rev: 3 } });
    expect(after.asked).toEqual(["?limit=40&after=7%3A3"]);

    const before = captureChat("chat-before");
    await fetchChat("chat-before", { before: { seq: 1_000_000, uuid: "u-1" } });
    expect(before.asked).toEqual(["?before=1000000%3Au-1"]);
  });

  it("marks the pane seen — watching a session is looking at the pane", async () => {
    const { seen } = captureChat("chat-seen");
    await fetchChat("chat-seen");
    expect(seen[0]?.get("x-collie-seen")).toBe("1");
  });

  it("returns the bridge's own body on a 200", async () => {
    captureChat("chat-body");
    await expect(fetchChat("chat-body")).resolves.toEqual({
      outcome: "body",
      body: liveBody("chat-body"),
    });
  });

  it("returns `available: false` as a body — a pane with no session is not a failure", async () => {
    server.use(
      http.get("/api/pane/chat-none/chat", () =>
        HttpResponse.json({ paneId: "chat-none", available: false, reason: "no-session" }),
      ),
    );
    await expect(fetchChat("chat-none")).resolves.toEqual({
      outcome: "body",
      body: { paneId: "chat-none", available: false, reason: "no-session" },
    });
  });

  it("validates the LIVE page with the ETag it was given, and reads the 304 as no change", async () => {
    let asks = 0;
    server.use(
      http.get("/api/pane/chat-etag/chat", ({ request }) => {
        asks += 1;
        if (request.headers.get("if-none-match") === 'W/"c1"') {
          return new HttpResponse(null, { status: 304, headers: { etag: 'W/"c1"' } });
        }
        return HttpResponse.json(liveBody("chat-etag"), { headers: { etag: 'W/"c1"' } });
      }),
    );
    await expect(fetchChat("chat-etag")).resolves.toMatchObject({ outcome: "body" });
    await expect(fetchChat("chat-etag", { after: { gen: 7, rev: 3 } })).resolves.toEqual({
      outcome: "unchanged",
    });
    expect(asks).toBe(2);
  });

  it("never validates a read that holds nothing, so a remounted view gets the body and not a 304", async () => {
    // The tag outlives the view. A first read was answered with this body, nothing moved, the view
    // left for the Files screen and came back with an empty window: the same read with no cursor
    // would hash to the same tag and be answered 304 into a window with nothing in it.
    const { seen } = captureChat("chat-remount", 'W/"c3"');
    await fetchChat("chat-remount");
    await fetchChat("chat-remount");
    expect(seen[1]?.get("if-none-match")).toBeNull();
  });

  it("does not validate a `?before=` page — a one-shot tap has no repeat fetch to save", async () => {
    const { seen } = captureChat("chat-older", 'W/"c2"');
    await fetchChat("chat-older");
    await fetchChat("chat-older", { before: { seq: 1_000_000, uuid: "u-1" } });
    expect(seen[0]?.get("if-none-match")).toBeNull();
    expect(seen[1]?.get("if-none-match")).toBeNull();
  });

  it("reads a 404 as a machine a release behind, never as an empty session", async () => {
    server.use(
      http.get("/api/pane/chat-404/chat", () => new HttpResponse("not found", { status: 404 })),
    );
    await expect(fetchChat("chat-404")).resolves.toEqual({
      outcome: "stale",
    });
  });

  it("still throws on anything else — a stale member is not a refusal", async () => {
    server.use(
      http.get("/api/pane/chat-502/chat", () => new HttpResponse("herdr down", { status: 502 })),
    );
    await expect(fetchChat("chat-502")).rejects.toThrow(/502/);
  });
});

// M46 hardening: a pane is live while its LAST read succeeded (lib/liveness.ts). fetchPane is the
// one writer: a success marks it, a failure takes it down after the debounce, an abort does neither.
describe("fetchPane drives the pane's liveness", () => {
  beforeEach(() => resetLiveness());

  it("a 200 marks the pane live, and a failed read takes it down after the debounce", async () => {
    await fetchPane("w1:p1");
    expect(isLive("w1:p1")).toBe(true);
    server.use(http.get(/\/api\/pane\/[^/]+$/, () => new HttpResponse("boom", { status: 500 })));
    await expect(fetchPane("w1:p1")).rejects.toThrow(/500/);
    expect(isLive("w1:p1")).toBe(true); // debounced: one dropped poll does not flicker
    await new Promise((resolve) => setTimeout(resolve, DEAD_DEBOUNCE_MS + 50));
    expect(isLive("w1:p1")).toBe(false);
  });

  it("a network error counts as a failed read", async () => {
    await fetchPane("w1:p1");
    server.use(http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.error()));
    await expect(fetchPane("w1:p1")).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, DEAD_DEBOUNCE_MS + 50));
    expect(isLive("w1:p1")).toBe(false);
  });

  it("a read the caller aborted says nothing about the bridge", async () => {
    await fetchPane("w1:p1");
    const controller = new AbortController();
    controller.abort();
    await expect(fetchPane("w1:p1", undefined, undefined, controller.signal)).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, DEAD_DEBOUNCE_MS + 50));
    expect(isLive("w1:p1")).toBe(true);
  });
});

describe("the Files image read (ADR 0090)", () => {
  it("addresses files/image beside the Files read, in both forms, with the scope", () => {
    expect(filesImagePath({ kind: "pane", paneId: "w1:p1" }, "img/a b.png")).toBe("/api/pane/w1%3Ap1/files/image?path=img%2Fa+b.png");
    expect(filesImagePath({ kind: "space", spaceId: "w2" }, "logo.png", { host: "laptop", session: "s1" })).toBe(
      "/api/workspace/w2/files/image?path=logo.png&host=laptop&session=s1",
    );
  });

  it("answers the bytes, and turns 413, 415 and any other failure into an outcome", async () => {
    const got = await fetchFileImage({ kind: "pane", paneId: "w1:p1" }, "logo.png");
    if (got.outcome !== "image") throw new Error(got.outcome);
    expect(got.blob.type).toBe("image/png");
    // The version the bridge sent with the bytes is the size and mtime, joined as the text read's are.
    expect(got.version).toMatch(/^\d+:\d+$/);
    server.use(http.get(/\/files\/image$/, () => new HttpResponse(new Uint8Array(3), { headers: { "content-type": "image/png" } })));
    const bare = await fetchFileImage({ kind: "pane", paneId: "w1:p1" }, "logo.png");
    // Not `expect.any(Blob)`: the fetch polyfill's Blob and jsdom's are different classes on some
    // Node versions (CI's), so the class check fails there while the answer is right.
    if (bare.outcome !== "image") throw new Error(bare.outcome);
    expect(bare.blob.type).toBe("image/png");
    expect(bare.blob.size).toBe(3);
    expect(Object.keys(bare).toSorted()).toEqual(["blob", "outcome"]);
    server.resetHandlers();
    for (const [status, outcome] of [
      [413, "too-large"],
      [415, "not-image"],
      [404, "failed"],
      [500, "failed"],
    ] as const) {
      server.use(http.get(/\/files\/image$/, () => new HttpResponse("no", { status })));
      expect(await fetchFileImage({ kind: "space", spaceId: "w1" }, "a.png")).toEqual({ outcome });
    }
    server.use(http.get(/\/files\/image$/, () => HttpResponse.error()));
    expect(await fetchFileImage({ kind: "pane", paneId: "w1:p1" }, "a.png")).toEqual({ outcome: "failed" });
  });

  it("an abort rethrows, so a screen that moved on hears nothing", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(fetchFileImage({ kind: "pane", paneId: "w1:p1" }, "logo.png", undefined, abort.signal)).rejects.toBeTruthy();
  });
});
