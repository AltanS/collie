import type { JsonValue } from "./json";
import {
  appPathOf,
  BOOTED_KEY,
  isFreshEntry,
  openPendingTarget,
  PENDING_OPEN_KEY,
  receiveOpen,
  seedKey,
  stripOpenMarker,
  type OpenGate,
  type OpenRouter,
  isInAppBack,
  markInAppBack,
  SEEDED_KEY,
  seedColdEntry,
  type RouterEntry,
  type SeedWindow,
} from "./nav-entry";

/** A window whose history records what the seed wrote. */
/** A window whose history records what the seed wrote. Installed-app by default, as most cases are. */
function fakeWindow(
  href: string,
  opts: { state?: JsonValue; length?: number; standalone?: boolean; seeded?: string; booted?: boolean } = {},
) {
  const url = new URL(href, "https://collie.test");
  const writes: Array<{ op: "replace" | "push"; data: RouterEntry | JsonValue | undefined; url: string }> = [];
  const store = new Map<string, string>(opts.seeded ? [[SEEDED_KEY, opts.seeded]] : []);
  if (opts.booted) store.set(BOOTED_KEY, "1");
  let keys = 0;
  const win: SeedWindow = {
    location: { pathname: url.pathname, search: url.search, hash: url.hash },
    history: {
      length: opts.length ?? 1,
      state: opts.state ?? null,
      replaceState: (data, _u, to) => void writes.push({ op: "replace", data, url: to }),
      pushState: (data, _u, to) => void writes.push({ op: "push", data, url: to }),
    },
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    standalone: () => opts.standalone ?? true,
    key: () => `k${keys++}`,
  };
  return { win, writes, store };
}


describe("isFreshEntry", () => {
  it("is fresh when React Router has not stamped the entry", () => {
    expect(isFreshEntry(null)).toBe(true);
    expect(isFreshEntry({})).toBe(true);
  });

  it("is not fresh on a stamped entry, which a reload and a back-forward keep", () => {
    expect(isFreshEntry({ usr: null, key: "k", idx: 0 })).toBe(false);
    expect(isFreshEntry({ usr: null, key: "k", idx: 3 })).toBe(false);
  });
});

describe("seedColdEntry", () => {
  it("puts the dashboard behind a pane opened cold, and stamps both like the router", () => {
    const { win, writes } = fakeWindow("/pane/w1%3Ap1?h=badger");
    expect(seedColdEntry(win)).toBe(true);
    expect(writes).toEqual([
      { op: "replace", data: { usr: null, key: "k0", idx: 0 }, url: "/?h=badger" },
      { op: "push", data: { usr: { from: "/?h=badger" }, key: "k1", idx: 1 }, url: "/pane/w1%3Ap1?h=badger" },
    ]);
  });

  it("seeds the whole chain under History, so each swipe climbs one level", () => {
    const { win, writes } = fakeWindow("/pane/p1/history");
    seedColdEntry(win);
    expect(writes.map((w) => w.url)).toEqual(["/", "/pane/p1", "/pane/p1/history"]);
    expect(writes.map((w) => w.data)).toMatchObject([{ idx: 0 }, { idx: 1 }, { idx: 2 }]);
  });

  it("keeps the hash on the target only", () => {
    const { win, writes } = fakeWindow("/settings#paired-devices");
    seedColdEntry(win);
    expect(writes.map((w) => w.url)).toEqual(["/", "/settings#paired-devices"]);
  });

  it("does nothing on the dashboard", () => {
    const { win, writes } = fakeWindow("/");
    expect(seedColdEntry(win)).toBe(false);
    expect(writes).toEqual([]);
  });

  it("does nothing on an entry the router already stamped (a reload)", () => {
    const { win, writes } = fakeWindow("/pane/p1", { state: { usr: null, key: "a", idx: 1 }, length: 2 });
    expect(seedColdEntry(win)).toBe(false);
    expect(writes).toEqual([]);
  });

  it("does nothing in a plain browser tab, even a new one with nothing behind it", () => {
    // A desktop deep link opened in a new tab keeps the browser's own history.
    for (const length of [1, 4]) {
      const { win, writes } = fakeWindow("/pane/p1", { length, standalone: false });
      expect(seedColdEntry(win)).toBe(false);
      expect(writes).toEqual([]);
    }
  });

  it("seeds a browser tab the service worker opened for a notification, and strips the marker", () => {
    const { win, writes } = fakeWindow("/pane/p1?h=badger&from=notification", { standalone: false });
    expect(seedColdEntry(win)).toBe(true);
    expect(writes.map((w) => w.url)).toEqual(["/?h=badger", "/pane/p1?h=badger"]);
  });

  it("strips the marker even when it does not seed, keeping the entry's state", () => {
    const state = { usr: null, key: "a", idx: 0 };
    const { win, writes } = fakeWindow("/?from=notification#top", { state, standalone: false });
    expect(seedColdEntry(win)).toBe(false);
    expect(writes).toEqual([{ op: "replace", data: state, url: "/#top" }]);
  });

  it("does not seed a tab that booted before: iOS reloading an evicted app drops the state", () => {
    const { win, writes } = fakeWindow("/pane/p1", { booted: true });
    expect(seedColdEntry(win)).toBe(false);
    expect(writes).toEqual([]);
  });

  it("seeds a notification's window in a tab that booted before, since a reload never carries the marker", () => {
    const { win } = fakeWindow("/pane/p1?from=notification", { booted: true, length: 3 });
    expect(seedColdEntry(win)).toBe(true);
  });

  it("seeds in the installed app even with history behind it", () => {
    const { win } = fakeWindow("/pane/p1", { length: 4, standalone: true });
    expect(seedColdEntry(win)).toBe(true);
  });

  it("does not seed a URL twice in one session while its seed is still behind it", () => {
    const { win, writes } = fakeWindow("/pane/p1", { length: 2, standalone: true, seeded: "/pane/p1" });
    expect(seedColdEntry(win)).toBe(false);
    expect(writes).toEqual([]);
  });

  it("records the seeded URL", () => {
    const { win, store } = fakeWindow("/pane/p1");
    seedColdEntry(win);
    expect(store.get(SEEDED_KEY)).toBe("/pane/p1");
  });
});

describe("appPathOf", () => {
  it("strips the origin", () => {
    expect(appPathOf("https://collie.test/pane/p1?h=a", "https://collie.test")).toBe("/pane/p1?h=a");
  });

  it("refuses another origin and garbage", () => {
    expect(appPathOf("https://evil.test/pane/p1", "https://collie.test")).toBeNull();
    expect(appPathOf("not a url", "https://collie.test")).toBeNull();
  });
});

describe("markInAppBack / isInAppBack", () => {
  it("answers for the marked pathname within the window, and for nothing else", () => {
    markInAppBack("/", 1000);
    expect(isInAppBack("/", 1100)).toBe(true);
    expect(isInAppBack("/", 1100)).toBe(true); // read-only: a second render answers the same
    expect(isInAppBack("/space/w1", 1100)).toBe(false);
    expect(isInAppBack("/", 5000)).toBe(false);
  });
});

describe("stripOpenMarker", () => {
  it("takes the marker out and leaves every other pair as it was spelled", () => {
    expect(stripOpenMarker("?from=notification")).toEqual({ search: "", marked: true });
    expect(stripOpenMarker("?h=a%3Ab&from=notification&s=1")).toEqual({ search: "?h=a%3Ab&s=1", marked: true });
    expect(stripOpenMarker("?h=a")).toEqual({ search: "?h=a", marked: false });
    expect(stripOpenMarker("")).toEqual({ search: "", marked: false });
  });
});

describe("seedKey", () => {
  it("is 128 random bits in hex, fresh each time", () => {
    const a = seedKey();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(seedKey()).not.toBe(a);
  });
});

describe("a notification target while the page cannot move", () => {
  function setup(busy: boolean) {
    const store = new Map<string, string>();
    const moves: Array<{ to: string; from: string }> = [];
    const router: OpenRouter = {
      state: { location: { pathname: "/space/w1", search: "" } },
      navigate: (to, opts) => void moves.push({ to, from: opts.state.from }),
    };
    const gate = {
      busy: () => busy,
      subscribe: () => () => {},
      storage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    } satisfies OpenGate;
    return { store, moves, router, gate, free: () => void (busy = false) };
  }

  it("opens at once, as a down move, when nothing holds the page", () => {
    const { moves, router, gate, store } = setup(false);
    expect(receiveOpen(router, gate, "/pane/p1")).toBe(true);
    expect(moves).toEqual([{ to: "/pane/p1", from: "/space/w1" }]);
    expect(store.size).toBe(0);
  });

  it("keeps the target while update mode holds the reload, and the fresh page opens it once", () => {
    const { moves, router, gate, store, free } = setup(true);
    expect(receiveOpen(router, gate, "/pane/p1")).toBe(true);
    expect(moves).toEqual([]);
    expect(store.get(PENDING_OPEN_KEY)).toBe("/pane/p1");
    // Still held: nothing opens.
    expect(openPendingTarget(router, gate)).toBe(false);
    free();
    expect(openPendingTarget(router, gate)).toBe(true);
    expect(moves).toEqual([{ to: "/pane/p1", from: "/space/w1" }]);
    // Consumed: a second boot opens nothing.
    expect(openPendingTarget(router, gate)).toBe(false);
    expect(moves).toHaveLength(1);
  });
});
