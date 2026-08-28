import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import {
  __resetPairing,
  authHeader,
  clearDeviceToken,
  getDeviceToken,
  isNotPaired,
  markNotPaired,
  NOT_PAIRED_BODY,
  setDeviceToken,
  subscribePairing,
  TOKEN_STORAGE_KEY,
} from "./pairing";
import { closePane, fetchDevices, fetchPane, fetchSnapshot, pairDevice, revokeDevice } from "./api";

// Two things are pinned here, and they are the whole client half of the pairing gate:
//   1. The bearer is injected in ONE place — every request carries it when a token is stored and
//      carries no Authorization header at all when none is. A call site that plumbed its own header
//      would pass its own test and leave the other twenty calls unauthenticated.
//   2. The refusal latch is driven by the bridge's exact 403 body, so the header gate's
//      "device not authorised" can never be mistaken for "device not paired".

/** The Authorization headers a case's requests carried, in order. */
interface AuthCapture {
  seen: (string | null)[];
}

// Capture the Authorization header of whatever request the case makes.
function captureAuth(): AuthCapture {
  const seen: (string | null)[] = [];
  server.use(
    http.get("/api/snapshot", ({ request }) => {
      seen.push(request.headers.get("authorization"));
      return HttpResponse.json({ bridge: "connected", agents: [], ts: 0 });
    }),
    http.get(/\/api\/pane\/[^/]+$/, ({ request }) => {
      seen.push(request.headers.get("authorization"));
      return HttpResponse.json({ paneId: "w1:p1", text: "", truncated: false, revision: 1 });
    }),
    http.post(/\/api\/pane\/[^/]+\/close$/, ({ request }) => {
      seen.push(request.headers.get("authorization"));
      return HttpResponse.json({ ok: true });
    }),
  );
  return { seen };
}

describe("device token storage", () => {
  it("round-trips through a namespaced localStorage key", () => {
    expect(getDeviceToken()).toBeNull();
    setDeviceToken("tok-abc");
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("tok-abc");
    expect(getDeviceToken()).toBe("tok-abc");
    clearDeviceToken();
    expect(getDeviceToken()).toBeNull();
  });

  it("builds the Authorization header only when a token is stored", () => {
    expect(authHeader()).toEqual({});
    setDeviceToken("tok-abc");
    expect(authHeader()).toEqual({ authorization: "Bearer tok-abc" });
  });
});

describe("bearer injection", () => {
  it("carries the bearer on reads, writes and uploads once a token is stored", async () => {
    setDeviceToken("tok-abc");
    const { seen } = captureAuth();

    await fetchSnapshot();
    await fetchPane("w1:p1");
    await closePane("w1:p1");

    expect(seen).toEqual(["Bearer tok-abc", "Bearer tok-abc", "Bearer tok-abc"]);
  });

  it("omits the header entirely when this device holds no token", async () => {
    const { seen } = captureAuth();

    await fetchSnapshot();
    await fetchPane("w1:p1");
    await closePane("w1:p1");

    expect(seen).toEqual([null, null, null]);
  });

  it("sends the bootstrap pair request without a bearer", async () => {
    let auth: string | null | undefined;
    server.use(
      http.post("/api/pair", ({ request }) => {
        auth = request.headers.get("authorization");
        return HttpResponse.json({ token: "tok-new", label: "phone" });
      }),
    );
    await expect(pairDevice("ABCD2345", "phone")).resolves.toEqual({
      ok: true,
      token: "tok-new",
      label: "phone",
    });
    expect(auth).toBeNull();
  });
});

describe("the not-paired latch", () => {
  it("latches on a write refused with the bridge's not-paired body", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/close$/, () =>
        new HttpResponse(NOT_PAIRED_BODY, { status: 403 }),
      ),
    );
    expect(isNotPaired()).toBe(false);
    await expect(closePane("w1:p1")).rejects.toThrow(/403/);
    expect(isNotPaired()).toBe(true);
  });

  it("does NOT latch on the header gate's refusal — the two are distinguishable", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/close$/, () =>
        new HttpResponse("device not authorised", { status: 403 }),
      ),
    );
    await expect(closePane("w1:p1")).rejects.toThrow(/403/);
    expect(isNotPaired()).toBe(false);
  });

  it("clears on a write that actually goes through", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/close$/, () =>
        new HttpResponse(NOT_PAIRED_BODY, { status: 403 }),
      ),
    );
    await expect(closePane("w1:p1")).rejects.toThrow(/403/);
    expect(isNotPaired()).toBe(true);

    server.resetHandlers();
    await closePane("w1:p1");
    expect(isNotPaired()).toBe(false);
  });

  it("is never set by a read, which is ungated and says nothing either way", async () => {
    server.use(http.get("/api/snapshot", () => new HttpResponse("nope", { status: 403 })));
    // fetchSnapshot throws; the loader swallows it. What matters is the latch stayed down.
    await expect(fetchSnapshot()).rejects.toThrow(/403/);
    expect(isNotPaired()).toBe(false);
  });

  it("__resetPairing notifies subscribers, same as markNotPaired/clearNotPaired", () => {
    // Pins the fix: the reset helper used to assign `refused = false` on its own, so a subscriber —
    // any component driven by usePairing/useSyncExternalStore — kept painting "read-only" until some
    // unrelated render came along. Exactly the gap ec4bcd9 closed in connection-health and
    // self-update; this instance was missed. Nothing ever documented the silence as deliberate, and
    // every real mutation in this module has always emitted.
    markNotPaired();
    let hits = 0;
    const unsub = subscribePairing(() => hits++);
    __resetPairing();
    expect(isNotPaired()).toBe(false);
    expect(hits).toBe(1);
    unsub();
  });

  it("emits nothing when the reset changes nothing", () => {
    // The other half of the shape ec4bcd9 used: the guard inside the real mutator. A latch that is
    // already down must not wake every subscriber in the app on a reset that did nothing.
    expect(isNotPaired()).toBe(false);
    let hits = 0;
    const unsub = subscribePairing(() => hits++);
    __resetPairing();
    expect(hits).toBe(0);
    unsub();
  });
});

describe("the pairing endpoints", () => {
  it("returns the bridge's named reason instead of throwing on a 400", async () => {
    server.use(
      http.post("/api/pair", () => HttpResponse.json({ error: "bad-code" }, { status: 400 })),
    );
    await expect(pairDevice("WRONG123", "phone")).resolves.toEqual({
      ok: false,
      reason: "bad-code",
    });
  });

  it("still throws on a non-400 pair failure", async () => {
    server.use(http.post("/api/pair", () => new HttpResponse("boom", { status: 500 })));
    await expect(pairDevice("ABCD2345", "phone")).rejects.toThrow(/500/);
  });

  it("reads and revokes the registry", async () => {
    const registry = {
      enforced: true,
      current: "phone",
      devices: [{ label: "phone", createdAt: 1, lastSeenAt: 2, current: true }],
    };
    server.use(
      http.get("/api/devices", () => HttpResponse.json(registry)),
      http.post("/api/devices/revoke", async ({ request }) => {
        expect(await request.json()).toEqual({ label: "phone" });
        return HttpResponse.json({ enforced: false, current: null, devices: [] });
      }),
    );
    await expect(fetchDevices()).resolves.toEqual(registry);
    await expect(revokeDevice("phone")).resolves.toEqual({
      enforced: false,
      current: null,
      devices: [],
    });
  });
});
