import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The two reload lanes (M20/05). On 2026-09-07 the operator tapped the update band many times and
// nothing happened: one module-level latch served the automatic triggers and the manual tap alike, so
// whichever fired first silenced the other for the life of the page. These tests pin the split.
//
// `pwa.ts` registers a service worker at import time and its latches are module state, so every test
// loads a fresh copy through `vi.resetModules()` and drives the real listeners the module installs.

type Handlers = Record<string, () => void>;

interface FakeWorker {
  state: string;
  addEventListener: (type: string, fn: () => void) => void;
  postMessage: (message: { type: string }, transfer?: readonly Transferable[]) => void;
}

function worker(state: string, on: Handlers): FakeWorker {
  return {
    state,
    addEventListener: (type, fn) => {
      on[type] = fn;
    },
    postMessage: () => {},
  };
}

/** Load a fresh `pwa.ts` against a stubbed registration, and hand back every seam it wired. */
async function load(opts: { controlled?: boolean; installing?: FakeWorker | null } = {}) {
  vi.resetModules();
  const reload = vi.fn();
  const regEvents: Handlers = {};
  const swEvents: Handlers = {};
  const registration = {
    installing: opts.installing ?? null,
    waiting: null,
    update: vi.fn(async () => {}),
    unregister: vi.fn(async () => true),
    addEventListener: (type: string, fn: () => void) => {
      regEvents[type] = fn;
    },
  };
  vi.stubGlobal("navigator", {
    serviceWorker: {
      controller: opts.controlled === true ? {} : null,
      addEventListener: (type: string, fn: () => void) => {
        swEvents[type] = fn;
      },
      getRegistrations: async () => [registration],
    },
  });
  // jsdom's own `location.reload` throws "not implemented", so the whole object is replaced.
  vi.stubGlobal("location", { reload });
  vi.stubGlobal("window", globalThis.window ?? {});
  Object.defineProperty(globalThis.window, "location", { value: { reload }, configurable: true });
  vi.doMock("virtual:pwa-register", () => ({
    registerSW: (o: { onRegisteredSW: (url: string, r: typeof registration) => void }) =>
      o.onRegisteredSW("/sw.js", registration),
  }));
  const mod = await import("./pwa");
  return { mod, reload, registration, regEvents, swEvents };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock("virtual:pwa-register");
  // The stuck guard's note lives here (`GUARD_RELOAD_KEY`), and it is meant to survive a reload —
  // so it also survives a test unless a test clears it.
  sessionStorage.clear();
});

describe("the reload latch is split into two lanes", () => {
  it("a tap on an origin with no worker to check still reloads", async () => {
    const h = await load();
    vi.stubGlobal("navigator", {});
    await h.mod.checkForUpdate();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("GUARD: a tap while an automatic reload is already navigating does nothing", async () => {
    // A controller swap on a page that already had one is an automatic reload, and the page is on
    // its way out. Forcing the tap through here is a double navigation, which is what counsel
    // refused a plain latch bypass over.
    const h = await load({ controlled: true });
    h.swEvents.controllerchange?.();
    expect(h.reload).toHaveBeenCalledTimes(1);

    await h.mod.checkForUpdate();
    vi.advanceTimersByTime(2_000); // inside the window where the page may still be leaving
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("a reload that did not navigate gives the tap back", async () => {
    // `location.reload()` normally does not return. When it does — a standalone window that refused
    // the navigation — the page is still alive with its latch spent, and every later tap is
    // swallowed for the life of the page. That is 2026-09-07's symptom in a new coat, so the manual
    // lane is re-armed once it is clear the page is not going anywhere.
    const h = await load({ controlled: true });
    h.swEvents.controllerchange?.();
    expect(h.reload).toHaveBeenCalledTimes(1);

    await h.mod.checkForUpdate();
    vi.advanceTimersByTime(20_000);
    // The stuck guard behind that tap now lands, because the tap is no longer refused.
    expect(h.reload).toHaveBeenCalledTimes(2);
  });

  it("THE SPLIT: a manual reload does not spend the automatic lane's latch", async () => {
    // The 2026-09-07 shape, mirrored. With one shared latch, whichever lane fired first silenced the
    // other for the life of the page. The automatic worker swap below is what the operator is
    // waiting for, and a tap they made earlier must not have swallowed it.
    const h = await load({ controlled: true });

    await h.mod.checkForUpdate(); // update() finds nothing to activate, so the wedged-precache path runs
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reload).toHaveBeenCalledTimes(1);

    // The automatic lane, still armed: its own latch was never touched.
    h.swEvents.controllerchange?.();
    expect(h.reload).toHaveBeenCalledTimes(2);
  });

  it("the automatic lane still collapses its own triggers into one reload", async () => {
    const h = await load({ controlled: true });
    h.swEvents.controllerchange?.();
    h.swEvents.controllerchange?.();
    h.swEvents.controllerchange?.();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("a worker that activates for the automatic lane reloads through the automatic latch", async () => {
    const on: Handlers = {};
    const installing = worker("installing", on);
    const h = await load({ controlled: true, installing });
    h.regEvents.updatefound?.();
    installing.state = "activated";
    on.statechange?.();
    expect(h.reload).toHaveBeenCalledTimes(1);
    // And a second activation on the same page adds nothing.
    on.statechange?.();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});

describe("the tap after the stuck guard's own reload", () => {
  // 2026-09-09, release lane, 1.6.0 → 1.7.0, iPhone PWA: every tap showed "updating…", reloaded, and
  // came back on the same stale bundle, for about three minutes. The stuck guard's reload is served by
  // the ACTIVE worker, so it lands on the bundle the operator is trying to leave, and the next tap
  // starts the identical cycle. The note the guard leaves behind is what breaks it.

  /**
   * A poll answers, carrying a build id that is not this bundle's.
   *
   * One call is both of the branch's conditions: the page is provably STALE (the served id differs
   * from the baked one) and the bridge is provably ANSWERING (a header only arrives on a response
   * it sent). That is the shape on the phone too — the chip is on screen because the poll keeps
   * saying so.
   */
  async function aPollSaysWeAreStale(): Promise<void> {
    const { observeServerBuild } = await import("./server-build");
    observeServerBuild("a-build-this-bundle-is-not");
  }

  it("THE CYCLE: the second tap unregisters instead of repeating the guard", async () => {
    const on: Handlers = {};
    const installing = worker("installing", on);
    const h = await load({ controlled: true, installing });
    await aPollSaysWeAreStale();

    // Tap one. A worker is installing, so nothing is forced: the tap waits, and the stuck guard is
    // what eventually reloads the page — on the stale bundle, precache intact.
    await h.mod.checkForUpdate();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.registration.unregister).not.toHaveBeenCalled();

    // The page came back on the same bundle, still stale, and the manual lane gives itself back. The
    // poll is still answering, which is what the chip on screen means.
    await vi.advanceTimersByTimeAsync(3_000);
    await aPollSaysWeAreStale();

    // Tap two, the one that was worth nothing for three minutes. It takes the unregister-then-reload
    // path, so the navigation is answered by the bridge instead of by the wedged precache.
    await h.mod.checkForUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.registration.unregister).toHaveBeenCalledTimes(1);
    expect(h.reload).toHaveBeenCalledTimes(2);
  });

  it("a page the guard reloaded onto a bundle that is level does NOT unregister", async () => {
    // The note alone must not arm it. Nothing was observed off the header here, so the page is not
    // provably stale, and dropping a precache on that evidence buys a reload loop and no update.
    const on: Handlers = {};
    const installing = worker("installing", on);
    const h = await load({ controlled: true, installing });

    await h.mod.checkForUpdate();
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await h.mod.checkForUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.registration.unregister).not.toHaveBeenCalled();
  });

  it("OFFLINE SAFETY: a bridge that stopped answering keeps the precache", async () => {
    // Dropping a precache offline strands the PWA on an error page with nothing cached, which is
    // worse than any stale bundle. So the branch also asks whether the bridge is still there, and
    // the answer is the poll: no header for twenty seconds is no network. The tap then takes the old
    // path — a thrown update(), a plain reload, precache intact.
    const on: Handlers = {};
    const installing = worker("installing", on);
    const h = await load({ controlled: true, installing });
    await aPollSaysWeAreStale();
    sessionStorage.setItem("collie:pwa:guardReload:v1", "1");
    h.registration.update.mockRejectedValueOnce(new Error("offline"));

    // The last thing the bridge said was a while ago now, which is what going offline looks like.
    await vi.advanceTimersByTimeAsync(21_000);
    await h.mod.checkForUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.registration.unregister).not.toHaveBeenCalled();
  });
});
