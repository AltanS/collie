import { loadDraft, saveDraft } from "@/lib/drafts";
import { AGAIN_KEY, rememberAgain } from "@/lib/new-page";
import { NO_PROMPTS_KEY, rememberNoPromptsConfirm } from "@/lib/no-prompts";
import { loadLastPaneText, loadLastSnapshot, saveLastPaneText, saveLastSnapshot } from "@/lib/last-seen";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { FakeIDBFactory, uninstallFakeIndexedDB } from "@/test/fake-indexeddb";
import {
  EXPIRED_BODY,
  getDeviceToken,
  getPairingExpiry,
  isNotPaired,
  isPairingExpired,
  NOT_PAIRED_BODY,
  PAIRING_EXPIRES_KEY,
  rememberPairingExpiry,
  setDeviceToken,
} from "@/lib/pairing";
import { PUSH_ENDPOINT_KEY } from "@/lib/push-endpoint";
import { __closeForWipe, __resetStore, getRecord, putRecord, STORE_NAME, storeStatus } from "@/lib/store";
import type { SnapshotResponse } from "@/lib/types";
import {
  __refusalSettled,
  __resetWipe,
  clearLastWipe,
  lastWipeReason,
  onWipe,
  pairingRefused,
  resumePendingWipe,
  WIPE_CHANNEL,
  WIPE_LAST_KEY,
  WIPE_PENDING_KEY,
  WIPE_TAB_ID,
  type WipeAnnouncement,
  type WipeContext,
  wipeDevice,
} from "./wipe";

// The one wipe routine (M46 spec 02). Pinned here: every class of stored session data goes, the
// preferences stay, a password prompt clears one pane's text and nothing else, a registered cleaner
// runs, a cleaner that fails stops nothing, and a browser without Cache Storage or a service worker
// is not an error.

const LEAD = undefined;
const SNAP: SnapshotResponse = { bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], ts: 1 };

/** A fake Cache Storage: its names, and what was deleted. */
function stubCaches(names: string[]) {
  const deleted: string[] = [];
  vi.stubGlobal("caches", {
    keys: vi.fn(async () => [...names]),
    delete: vi.fn(async (name: string) => {
      deleted.push(name);
      return true;
    }),
  });
  return { deleted };
}

const unsubscribe = vi.fn(async () => true);
let subscription: { unsubscribe: typeof unsubscribe } | null = null;
let serviceWorkerDescriptor: PropertyDescriptor | undefined;

function stubServiceWorker(): void {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: vi.fn(async () => ({
        pushManager: { getSubscription: vi.fn(async () => subscription) },
      })),
    },
  });
}

/** Seed one entry of every class the wipe owns, plus the preferences it must leave. */
function seed(): void {
  setDeviceToken("tok-phone");
  saveDraft(LEAD, "w1:p1", "half a reply");
  saveDraft({ host: "member", session: "default" }, "w2:p1", "another");
  saveLastSnapshot(LEAD, SNAP);
  saveLastPaneText(LEAD, "w1:p1", "pane text");
  localStorage.setItem(PUSH_ENDPOINT_KEY, "https://push.example.test/device");
  for (const key of PREFERENCE_KEYS) localStorage.setItem(key, "pref");
}

// Preferences: how this phone likes to look, never what a session said.
const PREFERENCE_KEYS = [
  "collie:theme:v1",
  "collie:design:v1",
  "collie:display-prefs:v4",
  "collie:dash-prefs:v1",
  "collie:pins:v1",
  "collie:tour:v1",
  "collie:push-disabled",
  "collie:locale:v1",
];

beforeEach(() => {
  sessionStorage.clear();
  __resetWipe();
  // The last-seen records live in the on-device store (lib/store.ts), on its memory fallback here:
  // jsdom has no IndexedDB. Its cleaner registers itself again on the first write after the reset.
  __resetStore();
  subscription = { unsubscribe };
  unsubscribe.mockClear();
  serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (serviceWorkerDescriptor) Object.defineProperty(navigator, "serviceWorker", serviceWorkerDescriptor);
  else Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("wipeDevice — a pairing that ended", () => {
  it("clears the token, every draft, every last-seen entry, the push endpoint and subscription", async () => {
    stubCaches([]);
    stubServiceWorker();
    seed();

    const report = await wipeDevice("unpair");

    expect(report).toEqual({ reason: "unpair", failed: [] });
    expect(getDeviceToken()).toBeNull();
    expect(loadDraft(LEAD, "w1:p1")).toBeNull();
    expect(loadDraft({ host: "member", session: "default" }, "w2:p1")).toBeNull();
    expect(await loadLastSnapshot(LEAD)).toBeNull();
    expect(await loadLastPaneText(LEAD, "w1:p1")).toBeNull();
    expect(localStorage.getItem(PUSH_ENDPOINT_KEY)).toBeNull();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("forgets the New page's last start per machine, because it names that pairing's folders", async () => {
    stubCaches([]);
    stubServiceWorker();
    rememberAgain("", { what: { kind: "shell" }, label: "Shell", cwd: "~/src/client", branch: null, at: 1 });
    expect(localStorage.getItem(AGAIN_KEY)).not.toBeNull();
    await wipeDevice("unpair");
    expect(localStorage.getItem(AGAIN_KEY)).toBeNull();
  });

  it("forgets the per-device No prompts confirms, so a new pairing asks again (ADR 0094)", async () => {
    stubCaches([]);
    stubServiceWorker();
    rememberNoPromptsConfirm("", "claude --dangerously-skip-permissions", 1);
    expect(localStorage.getItem(NO_PROMPTS_KEY)).not.toBeNull();
    await wipeDevice("unpair");
    expect(localStorage.getItem(NO_PROMPTS_KEY)).toBeNull();
  });

  it("keeps the No prompts confirms on a password wipe, which clears session text only", async () => {
    stubCaches([]);
    stubServiceWorker();
    rememberNoPromptsConfirm("", "codex --yolo", 1);
    await wipeDevice("password", { scope: LEAD, paneId: "w1:p1" });
    expect(localStorage.getItem(NO_PROMPTS_KEY)).not.toBeNull();
  });

  it("clears the memory tier of drafts too, not only localStorage", async () => {
    // Over the disk cap: this draft lives only in the memory tier.
    saveDraft(LEAD, "w1:p1", "x".repeat(9 * 1024));
    expect(loadDraft(LEAD, "w1:p1")).not.toBeNull();
    await wipeDevice("revoked");
    expect(loadDraft(LEAD, "w1:p1")).toBeNull();
  });

  it("has run its synchronous cleaners by the time it returns", async () => {
    seed();
    void wipeDevice("expired");
    expect(getDeviceToken()).toBeNull();
    expect(loadDraft(LEAD, "w1:p1")).toBeNull();
    // The store is asynchronous, and its clear is queued ahead of any read made after the call.
    expect(await loadLastPaneText(LEAD, "w1:p1")).toBeNull();
  });

  it("deletes every cache except the workbox precache", async () => {
    const { deleted } = stubCaches([
      "workbox-precache-v2-https://collie.example/",
      "collie-fonts",
      "collie-push-titles",
      "collie-push-titles:/collie/",
    ]);
    await wipeDevice("expired");
    expect(deleted.toSorted()).toEqual(["collie-fonts", "collie-push-titles", "collie-push-titles:/collie/"]);
  });

  it("leaves the preferences alone", async () => {
    seed();
    await wipeDevice("unpair");
    for (const key of PREFERENCE_KEYS) expect(localStorage.getItem(key)).toBe("pref");
  });

  it("does not throw and reports nothing failed when Cache Storage and the service worker are absent", async () => {
    // jsdom has neither, which is also a phone on plain HTTP.
    seed();
    await expect(wipeDevice("unpair")).resolves.toEqual({ reason: "unpair", failed: [] });
    expect(getDeviceToken()).toBeNull();
  });

  it("does not throw when the registration has no PushManager", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: vi.fn(async () => ({})) },
    });
    await expect(wipeDevice("unpair")).resolves.toEqual({ reason: "unpair", failed: [] });
  });
});

describe("wipeDevice — a password prompt (ADR 0017)", () => {
  it("clears that one pane's draft and mirror, and nothing else", async () => {
    const { deleted } = stubCaches(["collie-fonts"]);
    stubServiceWorker();
    seed();
    saveLastPaneText(LEAD, "w1:p2", "other pane");
    saveDraft(LEAD, "w1:p2", "other draft");

    await wipeDevice("password", { scope: LEAD, paneId: "w1:p1" });

    expect(loadDraft(LEAD, "w1:p1")).toBeNull();
    expect(await loadLastPaneText(LEAD, "w1:p1")).toBeNull();
    // The rest of the session text stays, and so does everything that is not session text.
    expect(loadDraft(LEAD, "w1:p2")).toBe("other draft");
    expect((await loadLastPaneText(LEAD, "w1:p2"))?.value).toBe("other pane");
    expect(await loadLastSnapshot(LEAD)).not.toBeNull();
    expect(getDeviceToken()).toBe("tok-phone");
    expect(localStorage.getItem(PUSH_ENDPOINT_KEY)).not.toBeNull();
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });
});

describe("onWipe — the registry later stores join", () => {
  it("runs a registered cleaner with the reason, and the pane on a password wipe", async () => {
    const seen: WipeContext[] = [];
    onWipe("store", (context) => {
      seen.push(context);
    });
    await wipeDevice("revoked");
    await wipeDevice("password", { scope: LEAD, paneId: "w1:p1" });
    expect(seen).toEqual([
      { reason: "revoked" },
      { reason: "password", pane: { scope: LEAD, paneId: "w1:p1" } },
    ]);
  });

  it("waits for an asynchronous cleaner, and unregistering stops it", async () => {
    let done = 0;
    const off = onWipe("store", async () => {
      await Promise.resolve();
      done += 1;
    });
    await wipeDevice("unpair");
    expect(done).toBe(1);
    off();
    await wipeDevice("unpair");
    expect(done).toBe(1);
  });

  it("a cleaner that throws stops none of the others, and the report names it", async () => {
    seed();
    let after = false;
    onWipe("broken", () => {
      throw new Error("boom");
    });
    onWipe("rejects", () => Promise.reject(new Error("boom")));
    onWipe("after", () => {
      after = true;
    });
    const report = await wipeDevice("expired");
    expect(report.failed.toSorted()).toEqual(["broken", "rejects"]);
    expect(after).toBe(true);
    expect(getDeviceToken()).toBeNull();
    expect(loadDraft(LEAD, "w1:p1")).toBeNull();
  });

  it("a failing built-in cleaner is reported by name and the rest still run", async () => {
    vi.stubGlobal("caches", { keys: vi.fn(async () => Promise.reject(new Error("denied"))) });
    seed();
    let ran = false;
    onWipe("after", () => {
      ran = true;
    });
    const report = await wipeDevice("unpair");
    expect(report.failed).toEqual(["caches"]);
    expect(ran).toBe(true);
  });
});

/** Answer the confirming `GET /api/devices` with `status` and `body`, and count the calls. */
function confirmWith(status: number, body: string) {
  const seen: (string | null)[] = [];
  server.use(
    http.get("/api/devices", ({ request }) => {
      seen.push(request.headers.get("authorization"));
      return status === 200
        ? HttpResponse.json({ enforced: true, current: "phone", devices: [] })
        : new HttpResponse(body, { status });
    }),
  );
  return seen;
}

describe("pairingRefused — the wipe on a refusal, confirmed once more", () => {
  it("wipes when the confirming read is also `device not paired`, asked with the same token", async () => {
    seed();
    const seen = confirmWith(403, NOT_PAIRED_BODY);
    pairingRefused("not-paired");
    expect(isNotPaired()).toBe(true);
    expect(isPairingExpired()).toBe(false);
    await __refusalSettled();
    expect(seen).toEqual(["Bearer tok-phone"]);
    expect(getDeviceToken()).toBeNull();
    expect(loadDraft(LEAD, "w1:p1")).toBeNull();
    expect(lastWipeReason()).toBe("revoked");
  });

  it("expired latches the pair-again reason and wipes on a confirmed `device expired`", async () => {
    seed();
    confirmWith(403, EXPIRED_BODY);
    pairingRefused("expired");
    expect(isPairingExpired()).toBe(true);
    await __refusalSettled();
    expect(getDeviceToken()).toBeNull();
    expect(await loadLastPaneText(LEAD, "w1:p1")).toBeNull();
    expect(lastWipeReason()).toBe("expired");
  });

  it("a confirmation that says expired after a not-paired refusal wipes as expired", async () => {
    seed();
    confirmWith(403, ` ${EXPIRED_BODY}\n`);
    pairingRefused("not-paired");
    await __refusalSettled();
    expect(getDeviceToken()).toBeNull();
    expect(isPairingExpired()).toBe(true);
    expect(lastWipeReason()).toBe("expired");
  });

  it.each([
    ["a 200", 200, ""],
    ["the 503 `pairing unavailable`", 503, "pairing unavailable"],
    ["another 403 text", 403, "device not authorised"],
    ["a crew member's longer body", 403, `${NOT_PAIRED_BODY} on this host`],
    ["a 500", 500, "boom"],
  ])("%s latches the refusal and wipes nothing", async (_name, status, body) => {
    seed();
    confirmWith(status, body);
    pairingRefused("not-paired");
    await __refusalSettled();
    expect(isNotPaired()).toBe(true);
    expect(getDeviceToken()).toBe("tok-phone");
    expect(loadDraft(LEAD, "w1:p1")).toBe("half a reply");
    expect(localStorage.getItem(WIPE_PENDING_KEY)).toBeNull();
    expect(lastWipeReason()).toBeNull();
  });

  it("a network error latches the refusal and wipes nothing", async () => {
    seed();
    server.use(http.get("/api/devices", () => HttpResponse.error()));
    pairingRefused("expired");
    await __refusalSettled();
    expect(isPairingExpired()).toBe(true);
    expect(getDeviceToken()).toBe("tok-phone");
    expect(loadDraft(LEAD, "w1:p1")).toBe("half a reply");
  });

  it("a burst of refusals asks the bridge once", async () => {
    seed();
    const seen = confirmWith(403, NOT_PAIRED_BODY);
    pairingRefused("not-paired");
    pairingRefused("not-paired");
    pairingRefused("expired");
    await __refusalSettled();
    expect(seen).toHaveLength(1);
  });

  it("a fresh pairing that lands while the bridge is asked is not wiped", async () => {
    seed();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get("/api/devices", async () => {
        await gate;
        return new HttpResponse(NOT_PAIRED_BODY, { status: 403 });
      }),
    );
    pairingRefused("not-paired");
    setDeviceToken("tok-new");
    release();
    await __refusalSettled();
    expect(getDeviceToken()).toBe("tok-new");
  });

  it("with no token held it only latches: an unpaired phone's drafts are its own", async () => {
    saveDraft(LEAD, "w1:p1", "typed before pairing");
    const seen = confirmWith(403, NOT_PAIRED_BODY);
    let wiped = false;
    onWipe("probe", () => {
      wiped = true;
    });
    pairingRefused("not-paired");
    await __refusalSettled();
    expect(isNotPaired()).toBe(true);
    expect(wiped).toBe(false);
    expect(seen).toEqual([]);
    expect(loadDraft(LEAD, "w1:p1")).toBe("typed before pairing");
  });
});

describe("a wipe is resumable", () => {
  it("marks itself pending before any cleaner runs and clears the mark after the last", async () => {
    let pendingDuring: string | null = null;
    let release: () => void = () => {};
    onWipe("slow", async () => {
      pendingDuring = localStorage.getItem(WIPE_PENDING_KEY);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const done = wipeDevice("revoked");
    expect(pendingDuring).toBe("revoked");
    expect(localStorage.getItem(WIPE_PENDING_KEY)).toBe("revoked");
    release();
    await done;
    expect(localStorage.getItem(WIPE_PENDING_KEY)).toBeNull();
  });

  it("clears the mark even when a cleaner failed, so a re-paired phone is not wiped at every boot", async () => {
    onWipe("broken", () => {
      throw new Error("nope");
    });
    const report = await wipeDevice("unpair");
    expect(report.failed).toEqual(["broken"]);
    expect(localStorage.getItem(WIPE_PENDING_KEY)).toBeNull();
  });

  it("a password wipe marks nothing pending and names no cause", async () => {
    await wipeDevice("password", { scope: LEAD, paneId: "w1:p1" });
    expect(localStorage.getItem(WIPE_PENDING_KEY)).toBeNull();
    expect(lastWipeReason()).toBeNull();
  });

  it("at boot, a pending mark runs the wipe again with its reason, before anything reads", async () => {
    seed();
    localStorage.setItem(WIPE_PENDING_KEY, "expired");
    const contexts: WipeContext[] = [];
    onWipe("probe", (context) => {
      contexts.push(context);
    });
    const resumed = resumePendingWipe();
    // The synchronous cleaners have run by the time it returns.
    expect(getDeviceToken()).toBeNull();
    expect(loadDraft(LEAD, "w1:p1")).toBeNull();
    expect(await resumed).toEqual({ reason: "expired", failed: [] });
    expect(contexts).toEqual([{ reason: "expired" }]);
    expect(localStorage.getItem(WIPE_PENDING_KEY)).toBeNull();
  });

  it("at boot with no mark, nothing runs; an unknown mark is dropped", () => {
    seed();
    expect(resumePendingWipe()).toBeNull();
    localStorage.setItem(WIPE_PENDING_KEY, "password");
    expect(resumePendingWipe()).toBeNull();
    expect(localStorage.getItem(WIPE_PENDING_KEY)).toBeNull();
    expect(getDeviceToken()).toBe("tok-phone");
  });
});

describe("the wipe names its cause once, and clears the pairing's expiry", () => {
  it.each(["unpair", "revoked", "expired"] as const)("%s is remembered for the pair screen", async (reason) => {
    await wipeDevice(reason);
    expect(localStorage.getItem(WIPE_LAST_KEY)).toBe(reason);
    expect(lastWipeReason()).toBe(reason);
    clearLastWipe();
    expect(lastWipeReason()).toBeNull();
  });

  it("drops the remembered pairing expiry with the token", async () => {
    setDeviceToken("tok-phone");
    rememberPairingExpiry(Date.now() + 60_000);
    await wipeDevice("unpair");
    expect(localStorage.getItem(PAIRING_EXPIRES_KEY)).toBeNull();
    expect(getPairingExpiry()).toBeNull();
  });
});

describe("other tabs let go of the store", () => {
  it("announces the wipe on the collie-wipe channel, with this page's id", async () => {
    const listener = new BroadcastChannel(WIPE_CHANNEL);
    const got = new Promise<WipeAnnouncement>((resolve) => {
      listener.addEventListener("message", (event: MessageEvent<WipeAnnouncement>) => resolve(event.data), {
        once: true,
      });
    });
    await wipeDevice("revoked");
    expect(await got).toEqual({ type: "wipe", reason: "revoked", from: WIPE_TAB_ID });
    listener.close();
  });

  it("the store closes its connection when another tab announces a wipe", async () => {
    const idb = new FakeIDBFactory().install();
    try {
      __resetStore();
      await putRecord("snapshot", "probe", 1);
      expect(idb.connections.some((c) => !c.closed)).toBe(true);
      __closeForWipe();
      expect(idb.connections.every((c) => c.closed)).toBe(true);
      // The next call reopens, and the record is still there: only the connection went.
      expect((await getRecord("snapshot", "probe"))?.value).toBe(1);
    } finally {
      __resetStore();
      uninstallFakeIndexedDB();
    }
  });

  it("a delete another tab blocks is retried once, and succeeds when that tab lets go", async () => {
    const idb = new FakeIDBFactory({ blockDeletes: 1 }).install();
    try {
      __resetStore();
      await putRecord("snapshot", "probe", 1);
      const report = await wipeDevice("unpair");
      expect(report.failed).toEqual([]);
      expect(idb.deleted).toContain(STORE_NAME);
      expect(storeStatus().deleteBlocked).toBe(false);
    } finally {
      __resetStore();
      uninstallFakeIndexedDB();
    }
  });

  it("a delete still blocked after the retry gives up, is recorded, and the rows are gone anyway", async () => {
    const idb = new FakeIDBFactory({ blockDeletes: 2 }).install();
    try {
      __resetStore();
      await putRecord("snapshot", "probe", 1);
      const report = await wipeDevice("unpair");
      expect(report.failed).toEqual(["store"]);
      expect(storeStatus().deleteBlocked).toBe(true);
      expect(idb.rows(STORE_NAME, "meta")).toEqual([]);
      expect(localStorage.getItem(WIPE_PENDING_KEY)).toBeNull();
    } finally {
      __resetStore();
      uninstallFakeIndexedDB();
    }
  });
});
