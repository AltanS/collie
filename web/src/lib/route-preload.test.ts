import type { RouteObject } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRELOAD_RELOAD_KEY, setChunkReloader } from "./chunk-reload";
import { lazyChunk, lazyScreen } from "./lazy-route";
import { __resetPreload, IDLE_FALLBACK_MS, lazyLoadsOf, schedulePreload, type PreloadDocument, type PreloadHost } from "./route-preload";

function Screen() {
  return null;
}

/** A page whose idle moment and visibility the test drives by hand. */
function fakeHost(opts: { idle: boolean; hidden?: boolean }) {
  let visibility: DocumentVisibilityState = opts.hidden === true ? "hidden" : "visible";
  const listeners = new Set<() => void>();
  const idleCallbacks: (() => void)[] = [];
  const timers: { cb: () => void; ms: number }[] = [];
  const doc: PreloadDocument = {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (_type, cb) => void listeners.add(cb),
    removeEventListener: (_type, cb) => void listeners.delete(cb),
  };
  const host: PreloadHost = {
    document: doc,
    requestIdleCallback: opts.idle ? (cb) => void idleCallbacks.push(cb) : undefined,
    setTimeout: (cb, ms) => void timers.push({ cb, ms }),
  };
  return {
    host,
    idleCallbacks,
    timers,
    show: () => {
      visibility = "visible";
      for (const cb of listeners) cb();
    },
    listenerCount: () => listeners.size,
  };
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
    page.idleCallbacks[0]?.();
    await run;
    expect(broken).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(reloader).not.toHaveBeenCalled();
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
