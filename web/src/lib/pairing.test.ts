import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import {
  __resetPairing,
  authHeader,
  clearDeviceToken,
  checkPairingExpiry,
  EXPIRED_BODY,
  getDeviceToken,
  getPairingExpiry,
  isNotPaired,
  isPairingExpired,
  markExpired,
  markNotPaired,
  NOT_PAIRED_BODY,
  PAIRING_EXPIRES_KEY,
  rememberPairingExpiry,
  setDeviceToken,
  subscribePairing,
  TOKEN_STORAGE_KEY,
} from "./pairing";
import {
  closePane,
  fetchDevices,
  fetchFilesDir,
  fetchPane,
  fetchSnapshot,
  isPairingRefusal,
  pairDevice,
  revokeDevice,
} from "./api";
import { __resetConnectionHealth } from "./connection-health";
import { loadDraft, saveDraft } from "./drafts";
import { loadLastPaneText, saveLastPaneText } from "./last-seen";
import { __resetStore } from "./store";
import { devicesLoader } from "./loaders";
import { __refusalSettled } from "./wipe";

/** The confirming `GET /api/devices` the wipe asks before it runs (lib/wipe.ts): refused again. */
function confirmRefusal(body: string): void {
  server.use(http.get("/api/devices", () => new HttpResponse(body, { status: 403 })));
}

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

// M46 spec 01: a token past the expiry the operator gave it is refused with its own body.
describe("the expired latch", () => {
  it("latches expired on a write refused with the expired body, and drops the dead token", async () => {
    setDeviceToken("tok-old");
    confirmRefusal(EXPIRED_BODY);
    server.use(
      http.post(/\/api\/pane\/[^/]+\/close$/, () => new HttpResponse(EXPIRED_BODY, { status: 403 })),
    );
    await expect(closePane("w1:p1")).rejects.toThrow(/403/);
    expect(isNotPaired()).toBe(true);
    expect(isPairingExpired()).toBe(true);
    // The wipe (M46 spec 02) took the dead token once the bridge confirmed; the wipe tests pin the rest.
    await __refusalSettled();
    expect(getDeviceToken()).toBeNull();
  });

  it("is not set by the plain not-paired body", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/close$/, () => new HttpResponse(NOT_PAIRED_BODY, { status: 403 })),
    );
    await expect(closePane("w1:p1")).rejects.toThrow(/403/);
    expect(isNotPaired()).toBe(true);
    expect(isPairingExpired()).toBe(false);
  });

  it("survives the not-paired refusal that follows once the token is gone", () => {
    markExpired();
    markNotPaired();
    expect(isPairingExpired()).toBe(true);
  });

  it("clears on a fresh pairing and on a write that goes through", async () => {
    markExpired();
    setDeviceToken("tok-new");
    expect(isPairingExpired()).toBe(false);
    expect(isNotPaired()).toBe(false);

    markExpired();
    await closePane("w1:p1");
    expect(isPairingExpired()).toBe(false);
  });

  it("notifies subscribers once per change", () => {
    setDeviceToken("tok-old");
    let hits = 0;
    const unsub = subscribePairing(() => hits++);
    markExpired();
    expect(hits).toBe(1);
    markExpired();
    expect(hits).toBe(1);
    unsub();
  });

  it("a devices answer naming this token as expired latches it on a cold open, with no write", async () => {
    setDeviceToken("tok-old");
    server.use(
      http.get("/api/devices", () =>
        HttpResponse.json({
          enforced: true,
          current: null,
          currentExpired: true,
          devices: [{ label: "phone", createdAt: 1, lastSeenAt: 2, expiresAt: 3, expired: true, current: false }],
        }),
      ),
    );
    const data = await devicesLoader();
    expect(data.devices[0]?.expired).toBe(true);
    expect(isPairingExpired()).toBe(true);
    // The confirming read is this same 200, not a refusal: the latch shows, nothing is wiped.
    await __refusalSettled();
    expect(getDeviceToken()).toBe("tok-old");
  });

  it("remembers this device's own expiry from a devices answer that names it", async () => {
    setDeviceToken("tok-phone");
    server.use(
      http.get("/api/devices", () =>
        HttpResponse.json({
          enforced: true,
          current: "phone",
          devices: [
            { label: "tablet", createdAt: 1, lastSeenAt: 2, expiresAt: 99, current: false },
            { label: "phone", createdAt: 1, lastSeenAt: 2, expiresAt: 4_000_000_000_000, current: true },
          ],
        }),
      ),
    );
    await devicesLoader();
    expect(getPairingExpiry()).toBe(4_000_000_000_000);
    expect(localStorage.getItem(PAIRING_EXPIRES_KEY)).toBe("4000000000000");
  });

  it("a fresh pairing forgets the old pairing's expiry", () => {
    rememberPairingExpiry(1234);
    setDeviceToken("tok-new");
    expect(getPairingExpiry()).toBeNull();
  });

  it("a cold open past the remembered expiry shows the pair-again wording and wipes nothing", () => {
    setDeviceToken("tok-phone");
    rememberPairingExpiry(1000);
    checkPairingExpiry(1000);
    expect(isPairingExpired()).toBe(true);
    expect(getDeviceToken()).toBe("tok-phone");
  });

  it("a cold open before the expiry latches nothing", () => {
    setDeviceToken("tok-phone");
    rememberPairingExpiry(2000);
    checkPairingExpiry(1999);
    expect(isNotPaired()).toBe(false);
  });

  it("the 503 `pairing unavailable` is never a refusal", async () => {
    setDeviceToken("tok-phone");
    server.use(http.get("/api/snapshot", () => new HttpResponse("pairing unavailable", { status: 503 })));
    await expect(fetchSnapshot()).rejects.toThrow(/503/);
    expect(isNotPaired()).toBe(false);
    await __refusalSettled();
    expect(getDeviceToken()).toBe("tok-phone");
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

// M46 spec 02: the bridge's two exact refusal texts, met while this phone holds a token, end the
// pairing here, and the one wipe routine clears what was stored under it. Any other 403 wipes nothing.
describe("the wipe on a pairing refusal", () => {
  // The last-seen records live in the on-device store (lib/store.ts), which the shared setup does
  // not reset. jsdom has no IndexedDB, so the store runs on its memory fallback here.
  beforeEach(() => __resetStore());
  const CLOSE = /\/api\/pane\/[^/]+\/close$/;

  function seedSession(): void {
    setDeviceToken("tok-phone");
    saveDraft(undefined, "w1:p1", "half a reply");
    saveLastPaneText(undefined, "w1:p1", "pane text");
  }

  async function expectWiped(): Promise<void> {
    await __refusalSettled();
    expect(getDeviceToken()).toBeNull();
    expect(loadDraft(undefined, "w1:p1")).toBeNull();
    expect(await loadLastPaneText(undefined, "w1:p1")).toBeNull();
  }

  async function expectKept(): Promise<void> {
    await __refusalSettled();
    expect(getDeviceToken()).toBe("tok-phone");
    expect(loadDraft(undefined, "w1:p1")).toBe("half a reply");
    expect((await loadLastPaneText(undefined, "w1:p1"))?.value).toBe("pane text");
  }

  it("a write refused with \"device not paired\" while a token is held runs the wipe", async () => {
    seedSession();
    confirmRefusal(NOT_PAIRED_BODY);
    server.use(http.post(CLOSE, () => new HttpResponse(NOT_PAIRED_BODY, { status: 403 })));
    await expect(closePane("w1:p1")).rejects.toThrow(/403/);
    expect(isNotPaired()).toBe(true);
    await expectWiped();
  });

  it("a write refused with \"device expired\" runs the wipe", async () => {
    seedSession();
    confirmRefusal(EXPIRED_BODY);
    server.use(http.post(CLOSE, () => new HttpResponse(EXPIRED_BODY, { status: 403 })));
    await expect(closePane("w1:p1")).rejects.toThrow(/403/);
    expect(isPairingExpired()).toBe(true);
    await expectWiped();
  });

  it("a gated read refused with the same body runs the wipe too", async () => {
    seedSession();
    confirmRefusal(NOT_PAIRED_BODY);
    server.use(http.get("/api/snapshot", () => new HttpResponse(NOT_PAIRED_BODY, { status: 403 })));
    await expect(fetchSnapshot()).rejects.toThrow(/403/);
    await expectWiped();
  });

  it("the proxy allowlist's \"device not authorised\" does not wipe", async () => {
    seedSession();
    server.use(http.post(CLOSE, () => new HttpResponse("device not authorised", { status: 403 })));
    await expect(closePane("w1:p1")).rejects.toThrow(/403/);
    expect(isNotPaired()).toBe(false);
    await expectKept();
  });

  it("a 403 of any other text does not wipe, nor does a body that only contains the refusal", async () => {
    seedSession();
    server.use(http.post(CLOSE, () => new HttpResponse("forbidden: device not paired", { status: 403 })));
    await expect(closePane("w1:p1")).rejects.toThrow(/403/);
    await expectKept();
  });

  it("a crew member's longer refusal on the files route latches and does not wipe", async () => {
    seedSession();
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, () => new HttpResponse(`${NOT_PAIRED_BODY} on this host`, { status: 403 })),
    );
    await expect(fetchFilesDir({ kind: "pane", paneId: "w1:p1" }, "")).resolves.toEqual({ outcome: "not-paired" });
    expect(isNotPaired()).toBe(true);
    await expectKept();
  });

  it("the lead's exact refusal on the files route wipes", async () => {
    seedSession();
    confirmRefusal(NOT_PAIRED_BODY);
    server.use(http.get(/\/api\/pane\/[^/]+\/files/, () => new HttpResponse(NOT_PAIRED_BODY, { status: 403 })));
    await expect(fetchFilesDir({ kind: "pane", paneId: "w1:p1" }, "")).resolves.toEqual({ outcome: "not-paired" });
    await expectWiped();
  });

  it("with no token held, the refusal only latches and the phone's drafts stay", async () => {
    saveDraft(undefined, "w1:p1", "typed before pairing");
    server.use(http.post(CLOSE, () => new HttpResponse(NOT_PAIRED_BODY, { status: 403 })));
    await expect(closePane("w1:p1")).rejects.toThrow(/403/);
    expect(isNotPaired()).toBe(true);
    expect(loadDraft(undefined, "w1:p1")).toBe("typed before pairing");
  });

  it("a devices answer naming this token as expired latches, and the confirming 200 wipes nothing", async () => {
    seedSession();
    server.use(
      http.get("/api/devices", () =>
        HttpResponse.json({ enforced: true, current: null, currentExpired: true, devices: [] }),
      ),
    );
    await devicesLoader();
    expect(isPairingExpired()).toBe(true);
    await expectKept();
  });

  it("a single refusal the confirming read does not repeat wipes nothing", async () => {
    seedSession();
    server.use(http.post(CLOSE, () => new HttpResponse(NOT_PAIRED_BODY, { status: 403 })));
    // The default registry answers 200: the bridge did not refuse twice.
    await expect(closePane("w1:p1")).rejects.toThrow(/403/);
    expect(isNotPaired()).toBe(true);
    await expectKept();
  });

  it("a devices answer that only names nobody latches and waits for the bridge's exact 403", async () => {
    seedSession();
    server.use(http.get("/api/devices", () => HttpResponse.json({ enforced: true, current: null, devices: [] })));
    await devicesLoader();
    expect(isNotPaired()).toBe(true);
    await expectKept();
  });
});

// ADR 0086: reads need the pairing token, so a phone that never paired is refused on its very first
// snapshot. That refusal must read as "pair this device": the latch set, no proxy sign-in banner, and
// no "connection lost" either, because the bridge answered.
describe("not paired on the first snapshot (ADR 0086)", () => {
  function refuseSnapshot(body: string): void {
    server.use(http.get("/api/snapshot", () => new HttpResponse(body, { status: 403 })));
  }

  it("a cold open refused with \"device not paired\" sets the latch, not the proxy auth error", async () => {
    const { rootLoader } = await import("./loaders");
    refuseSnapshot(NOT_PAIRED_BODY);
    const data = await rootLoader();
    expect(data.error).toBe(true);
    expect(data.authError).toBe(false);
    expect(isNotPaired()).toBe(true);
    expect(isPairingExpired()).toBe(false);
  });

  it("counts the refusal as the bridge answering, so the outage clock does not run", async () => {
    const { rootLoader } = await import("./loaders");
    const { lastHealthyAt } = await import("./connection-health");
    __resetConnectionHealth(0);
    refuseSnapshot(NOT_PAIRED_BODY);
    await rootLoader();
    expect(lastHealthyAt()).toBeGreaterThan(0);
  });

  it("a proxy's own 403 still reads as the auth error, and sets no latch", async () => {
    const { rootLoader } = await import("./loaders");
    refuseSnapshot("forbidden by the proxy");
    const data = await rootLoader();
    expect(data.authError).toBe(true);
    expect(isNotPaired()).toBe(false);
  });

  it("tells a pairing refusal apart from every other failure", async () => {
    refuseSnapshot(NOT_PAIRED_BODY);
    const failure = () => fetchSnapshot().then(() => null, (e: Error) => e);
    expect(isPairingRefusal(await failure())).toBe(true);
    refuseSnapshot(EXPIRED_BODY);
    expect(isPairingRefusal(await failure())).toBe(true);
    refuseSnapshot("device not authorised");
    expect(isPairingRefusal(await failure())).toBe(false);
    expect(isPairingRefusal(new Error("device not paired"))).toBe(false);
  });

  it("the devices read refused as unpaired answers an empty, enforced registry, not an error", async () => {
    server.use(http.get("/api/devices", () => new HttpResponse(NOT_PAIRED_BODY, { status: 403 })));
    await expect(devicesLoader()).resolves.toEqual({
      enforced: true,
      current: null,
      devices: [],
      error: false,
    });
    expect(isNotPaired()).toBe(true);
  });

  it("a fresh pairing clears the latch the first snapshot set", async () => {
    const { rootLoader } = await import("./loaders");
    refuseSnapshot(NOT_PAIRED_BODY);
    await rootLoader();
    expect(isNotPaired()).toBe(true);
    setDeviceToken("tok-test-placeholder");
    expect(isNotPaired()).toBe(false);
  });
});
