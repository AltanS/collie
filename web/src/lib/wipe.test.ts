import { loadDraft, saveDraft } from "@/lib/drafts";
import { loadLastPaneText, loadLastSnapshot, saveLastPaneText, saveLastSnapshot } from "@/lib/last-seen";
import { getDeviceToken, isNotPaired, isPairingExpired, setDeviceToken } from "@/lib/pairing";
import { PUSH_ENDPOINT_KEY } from "@/lib/push-endpoint";
import { __resetStore } from "@/lib/store";
import type { SnapshotResponse } from "@/lib/types";
import { __resetWipe, onWipe, pairingRefused, type WipeContext, wipeDevice } from "./wipe";

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

describe("pairingRefused — the wipe on a refusal", () => {
  it("wipes when this phone held a token, and latches the reason", async () => {
    seed();
    pairingRefused("not-paired");
    expect(isNotPaired()).toBe(true);
    expect(isPairingExpired()).toBe(false);
    expect(getDeviceToken()).toBeNull();
    expect(loadDraft(LEAD, "w1:p1")).toBeNull();
  });

  it("expired latches the pair-again reason and wipes", async () => {
    seed();
    pairingRefused("expired");
    expect(isPairingExpired()).toBe(true);
    expect(getDeviceToken()).toBeNull();
    expect(await loadLastPaneText(LEAD, "w1:p1")).toBeNull();
  });

  it("with no token held it only latches: an unpaired phone's drafts are its own", () => {
    saveDraft(LEAD, "w1:p1", "typed before pairing");
    let wiped = false;
    onWipe("probe", () => {
      wiped = true;
    });
    pairingRefused("not-paired");
    expect(isNotPaired()).toBe(true);
    expect(wiped).toBe(false);
    expect(loadDraft(LEAD, "w1:p1")).toBe("typed before pairing");
  });
});
