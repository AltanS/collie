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
