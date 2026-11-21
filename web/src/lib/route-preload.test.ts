import type { RouteObject } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRELOAD_RELOAD_KEY, setChunkReloader } from "./chunk-reload";
import { lazyChunk, lazyScreen } from "./lazy-route";
import {
  __resetPreload,
  IDLE_FALLBACK_MS,
  lazyLoadsOf,
  PRELOAD_RETRY_ROUNDS,
  schedulePreload,
  type PreloadDocument,
  type PreloadHost,
  type PreloadWindow,
} from "./route-preload";

function Screen() {
  return null;
}

/** A page whose idle moment, visibility and network the test drives by hand. */
function fakeHost(opts: { idle: boolean; hidden?: boolean; offline?: boolean; saveData?: boolean }) {
  let visibility: DocumentVisibilityState = opts.hidden === true ? "hidden" : "visible";
  let online = opts.offline !== true;
  const listeners = new Set<() => void>();
  const onlineListeners = new Set<() => void>();
  const idleCallbacks: (() => void)[] = [];
  const timers: { cb: () => void; ms: number }[] = [];
  const doc: PreloadDocument = {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (_type, cb) => void listeners.add(cb),
    removeEventListener: (_type, cb) => void listeners.delete(cb),
  };
  const win: PreloadWindow = {
    addEventListener: (_type, cb) => void onlineListeners.add(cb),
    removeEventListener: (_type, cb) => void onlineListeners.delete(cb),
  };
  const host: PreloadHost = {
    document: doc,
    window: win,
    requestIdleCallback: opts.idle ? (cb) => void idleCallbacks.push(cb) : undefined,
    setTimeout: (cb, ms) => void timers.push({ cb, ms }),
    onLine: () => online,
    saveData: opts.saveData === true,
  };
  /** Run the idle callbacks asked for so far, as the browser would at its next idle moment. */
  const idle = (): void => {
    for (const cb of idleCallbacks.splice(0)) cb();
  };
  return {
    host,
    idleCallbacks,
    timers,
    idle,
    show: () => {
      visibility = "visible";
      for (const cb of listeners) cb();
    },
    hide: () => {
      visibility = "hidden";
      for (const cb of listeners) cb();
    },
    goOnline: () => {
      online = true;
      for (const cb of onlineListeners) cb();
    },
    listenerCount: () => listeners.size,
    onlineListenerCount: () => onlineListeners.size,
  };
}

/** Let the preload's promise chain run as far as it can without a new idle moment. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("lazyLoadsOf", () => {
  it("finds every lazy route at any depth, and names a lazy no preload knows", async () => {
    const a = vi.fn(() => Promise.resolve({ Screen }));
    const b = vi.fn(() => Promise.resolve({ Screen }));
    const routes: RouteObject[] = [
      {
        path: "/",
        children: [
          { index: true },
          { path: "a", lazy: lazyScreen(a, (m) => m.Screen) },
          { path: "settings", lazy: lazyScreen(b, (m) => m.Screen), children: [{ path: "own", lazy: () => Promise.resolve({}) }] },
        ],
      },
    ];
    const { loads, unknown } = lazyLoadsOf(routes);
    expect(loads).toHaveLength(2);
    for (const load of loads) await load();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(unknown).toEqual(["//settings/own/"]);
  });
});

describe("schedulePreload", () => {
  beforeEach(() => {
    __resetPreload();
    sessionStorage.removeItem(PRELOAD_RELOAD_KEY);
  });
  afterEach(() => {
    setChunkReloader(null);
  });

  it("waits for the idle moment, then imports every chunk one after another", async () => {
    const page = fakeHost({ idle: true });
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          order.push("first started");
          releaseFirst = () => {
            order.push("first done");
            resolve();
          };
        }),
    );
    const second = vi.fn(() => {
      order.push("second started");
      return Promise.resolve();
    });
    const run = schedulePreload([first, second], page.host);
    expect(first).not.toHaveBeenCalled();
    expect(page.idleCallbacks).toHaveLength(1);
    page.idleCallbacks[0]?.();
    await Promise.resolve();
    expect(second).not.toHaveBeenCalled();
    releaseFirst();
    await run;
    expect(order).toEqual(["first started", "first done", "second started"]);
  });

  it("uses a timer where the browser has no idle callback (Safari)", async () => {
    const page = fakeHost({ idle: false });
    const load = vi.fn(() => Promise.resolve());
    const run = schedulePreload([load], page.host);
    expect(page.timers.map((t) => t.ms)).toEqual([IDLE_FALLBACK_MS]);
    expect(load).not.toHaveBeenCalled();
    page.timers[0]?.cb();
    await run;
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("runs once per page load", async () => {
    const page = fakeHost({ idle: true });
    const load = vi.fn(() => Promise.resolve());
    const run = schedulePreload([load], page.host);
    expect(schedulePreload([load], page.host)).toBeNull();
    page.idleCallbacks[0]?.();
    await run;
    expect(page.idleCallbacks).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("skips a hidden document and starts after it is shown and idle again", async () => {
    const page = fakeHost({ idle: true, hidden: true });
    const load = vi.fn(() => Promise.resolve());
    const run = schedulePreload([load], page.host);
    page.idleCallbacks[0]?.();
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
    expect(page.listenerCount()).toBe(1);
    page.show();
    expect(page.listenerCount()).toBe(0);
    expect(page.idleCallbacks).toHaveLength(2);
    page.idleCallbacks[1]?.();
    await run;
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed chunk, goes on with the next, and never reloads", async () => {
    const reloader = vi.fn();
    setChunkReloader(reloader);
    const page = fakeHost({ idle: true });
    const broken = vi.fn(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
    const next = vi.fn(() => Promise.resolve());
    const run = schedulePreload([broken, next], page.host);
    page.idle();
    await settle();
    expect(broken).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    for (let round = 0; round < PRELOAD_RETRY_ROUNDS; round += 1) {
      page.idle();
      await settle();
    }
    await run;
    expect(reloader).not.toHaveBeenCalled();
  });

  it("tries a failed chunk again at the next idle moment, and only that chunk", async () => {
    const page = fakeHost({ idle: true });
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module")).mockResolvedValue(undefined);
    const fine = vi.fn(() => Promise.resolve());
    const run = schedulePreload([flaky, fine], page.host);
    page.idle();
    await settle();
    expect(flaky).toHaveBeenCalledTimes(1);
    expect(fine).toHaveBeenCalledTimes(1);
    // The retry waits for an idle moment of its own.
    expect(page.idleCallbacks).toHaveLength(1);
    page.idle();
    await run;
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(fine).toHaveBeenCalledTimes(1);
    expect(page.idleCallbacks).toHaveLength(0);
  });

  it("gives up on a chunk after three rounds of retries", async () => {
    const page = fakeHost({ idle: true });
    const gone = vi.fn(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
    const run = schedulePreload([gone], page.host);
    for (let i = 0; i < 10; i += 1) {
      page.idle();
      await settle();
    }
    await run;
    expect(gone).toHaveBeenCalledTimes(1 + PRELOAD_RETRY_ROUNDS);
    expect(page.idleCallbacks).toHaveLength(0);
  });

  it("offline, waits for the online event before it tries again", async () => {
    const page = fakeHost({ idle: true, offline: true });
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module")).mockResolvedValue(undefined);
    const run = schedulePreload([flaky], page.host);
    page.idle();
    await settle();
    expect(flaky).toHaveBeenCalledTimes(1);
    expect(page.onlineListenerCount()).toBe(1);
    // Idle moments while offline do not spend a round.
    page.idle();
    await settle();
    expect(page.idleCallbacks).toHaveLength(0);
    page.goOnline();
    expect(page.onlineListenerCount()).toBe(0);
    await settle();
    expect(page.idleCallbacks).toHaveLength(1);
    page.idle();
    await run;
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it("stops between two chunks while the page is hidden, and goes on after visibilitychange", async () => {
    const page = fakeHost({ idle: true });
    const second = vi.fn(() => Promise.resolve());
    const first = vi.fn(() => {
      page.hide();
      return Promise.resolve();
    });
    const run = schedulePreload([first, second], page.host);
    page.idle();
    await settle();
    expect(first).toHaveBeenCalledTimes(1);
    page.idle();
    await settle();
    expect(second).not.toHaveBeenCalled();
    expect(page.listenerCount()).toBe(1);
    page.show();
    expect(page.listenerCount()).toBe(0);
    page.idle();
    await run;
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("preloads nothing when the person asked for less data (Save-Data)", async () => {
    const page = fakeHost({ idle: true, saveData: true });
    const load = vi.fn(() => Promise.resolve());
    lazyChunk(load);
    await schedulePreload([load], page.host);
    expect(page.idleCallbacks).toHaveLength(0);
    expect(page.timers).toHaveLength(0);
    expect(load).not.toHaveBeenCalled();
  });

  it("takes a lazyChunk door made before the run, one made during it, and one made after it", async () => {
    const page = fakeHost({ idle: true });
    const order: string[] = [];
    const late = () => {
      order.push("during");
      return Promise.resolve();
    };
    lazyChunk(() => {
      order.push("before");
      return Promise.resolve();
    });
    const route = vi.fn(() => {
      order.push("route");
      // A door whose module is first evaluated while the preload imports a lazy screen.
      lazyChunk(late);
      return Promise.resolve();
    });
    const run = schedulePreload([route], page.host);
    page.idleCallbacks[0]?.();
    await run;
    expect(order).toEqual(["route", "before", "during"]);
    const after = vi.fn(() => Promise.resolve());
    lazyChunk(after);
    await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(1));
  });
});
