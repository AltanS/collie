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
  postMessage: ReturnType<typeof vi.fn>;
}

function worker(state: string, on: Handlers): FakeWorker {
  return {
    state,
    addEventListener: (type, fn) => {
      on[type] = fn;
    },
    // A spy, because the nudge out of `waiting` is an assertion of its own below.
    postMessage: vi.fn(),
  };
}

/** Load a fresh `pwa.ts` against a stubbed registration, and hand back every seam it wired. */
async function load(
  opts: { controlled?: boolean; installing?: FakeWorker | null; waiting?: FakeWorker | null } = {},
) {
  vi.resetModules();
  const reload = vi.fn();
  const regEvents: Handlers = {};
  const swEvents: Handlers = {};
  const registration = {
    installing: opts.installing ?? null,
    waiting: opts.waiting ?? null,
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

  it("a worker reaching activated does not reload; the controller swap does (2026-09-12)", async () => {
    // `activated` runs BEFORE the controller swap, and it is the handler that sweeps the superseded
    // precache. A page reloaded there is a page asking the outgoing worker for a shell that is being
    // deleted, which is the 2026-09-12 hang. The swap is the signal; nothing earlier is.
    const on: Handlers = {};
    const installing = worker("installing", on);
    const h = await load({ controlled: true, installing });
    h.regEvents.updatefound?.();
    installing.state = "activated";
    on.statechange?.();
    expect(h.reload).not.toHaveBeenCalled();

    h.swEvents.controllerchange?.();
    expect(h.reload).toHaveBeenCalledTimes(1);
    // And a second swap on the same page adds nothing.
    h.swEvents.controllerchange?.();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});

describe("a tap while a worker is on its way in (2026-09-12)", () => {
  // The incident: a self-update from 1.8.0 to 1.8.1, the band saying "updated, tap to reload", and a
  // tap that reloaded the page eight seconds later while the new worker was still installing — an
  // 869 kB chunk down a slow link, 125 seconds of it. The reload was answered by the OLD worker out
  // of the OLD precache, so the page asked for 1.8.0's entry chunk; that chunk was gone from disk and
  // then gone from the cache, React never booted, and the pre-React dog galloped until the operator
  // reloaded by hand. The rule below is the whole fix.

  it("INSTALLING: the tap reloads nothing and says so", async () => {
    const on: Handlers = {};
    const installing = worker("installing", on);
    const h = await load({ controlled: true, installing });

    await h.mod.checkForUpdate();
    await vi.advanceTimersByTimeAsync(30_000); // far past the stuck guard
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.registration.update).not.toHaveBeenCalled(); // nothing to ask: it is already happening
    expect(h.registration.unregister).not.toHaveBeenCalled();
    expect(h.mod.getUpdateStage()).toBe("installing");

    // The swap is what moves the page, and the band stops saying "downloading" on the way.
    installing.state = "activated";
    on.statechange?.();
    expect(h.mod.getUpdateStage()).toBe("idle");
    h.swEvents.controllerchange?.();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("WAITING: the tap nudges the worker through and still reloads on the swap", async () => {
    const on: Handlers = {};
    const waiting = worker("installed", on);
    const h = await load({ controlled: true, waiting });

    await h.mod.checkForUpdate();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" }, []);
    expect(h.reload).not.toHaveBeenCalled();

    h.swEvents.controllerchange?.();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("THE GUARD IS GATED: a download started by this very tap is not a wedge", async () => {
    // The guard is armed before `reg.update()` is awaited, so the worker it must not reload over is
    // usually one this tap itself started. Eight seconds is the budget for a wedge, never for a
    // download.
    const on: Handlers = {};
    const installing = worker("installing", on);
    const h = await load({ controlled: true });
    h.registration.update.mockImplementation(async () => {
      h.registration.installing = installing;
    });

    await h.mod.checkForUpdate();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.mod.getUpdateStage()).toBe("installing");
  });

  it("NOTHING COMING: update() that finds no worker still takes the wedged-precache path", async () => {
    // The other half of the gate. With nothing on its way in there is no download to protect, so the
    // 2026-09-09 escape is untouched: unregister, drop the caches, go to the bridge.
    const h = await load({ controlled: true });
    await h.mod.checkForUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.registration.unregister).toHaveBeenCalledTimes(1);
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

  /**
   * The wedge the guard is FOR, since 2026-09-12: an update job that never settles.
   *
   * It used to be reproduced with a worker stuck in `installing`, which is no longer a wedge at all
   * — the page waits out a download however long it takes. What remains genuinely stuck is the job
   * queue itself: `reg.update()` is a job on the same per-scope queue as a wedged one, so it never
   * resolves, nothing is ever installing, and the tap has nothing to wait for.
   */
  function theUpdateJobNeverSettles(h: { registration: { update: ReturnType<typeof vi.fn> } }): void {
    h.registration.update.mockImplementation(() => new Promise<void>(() => {}));
  }

  it("THE CYCLE: the second tap unregisters instead of repeating the guard", async () => {
    const h = await load({ controlled: true });
    theUpdateJobNeverSettles(h);
    await aPollSaysWeAreStale();

    // Tap one. Nothing is on its way in and the job never settles, so the stuck guard is what
    // eventually reloads the page — on the stale bundle, precache intact.
    void h.mod.checkForUpdate();
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
    const h = await load({ controlled: true });
    theUpdateJobNeverSettles(h);

    void h.mod.checkForUpdate();
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(3_000);
    void h.mod.checkForUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.registration.unregister).not.toHaveBeenCalled();
  });

  it("OFFLINE SAFETY: a bridge that stopped answering keeps the precache", async () => {
    // Dropping a precache offline strands the PWA on an error page with nothing cached, which is
    // worse than any stale bundle. So the branch also asks whether the bridge is still there, and
    // the answer is the poll: no header for twenty seconds is no network. The tap then takes the old
    // path — a thrown update(), a plain reload, precache intact.
    const h = await load({ controlled: true });
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
