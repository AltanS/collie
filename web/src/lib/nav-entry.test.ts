import type { JsonValue } from "./json";
import {
  appPathOf,
  isFreshEntry,
  isInAppBack,
  markInAppBack,
  SEEDED_KEY,
  seedColdEntry,
  type RouterEntry,
  type SeedWindow,
} from "./nav-entry";

/** A window whose history records what the seed wrote. */
function fakeWindow(
  href: string,
  opts: { state?: JsonValue; length?: number; standalone?: boolean; seeded?: string } = {},
) {
  const url = new URL(href, "https://collie.test");
  const writes: Array<{ op: "replace" | "push"; data: RouterEntry; url: string }> = [];
  const store = new Map<string, string>(opts.seeded ? [[SEEDED_KEY, opts.seeded]] : []);
  const win: SeedWindow = {
    location: { pathname: url.pathname, search: url.search, hash: url.hash },
    history: {
      length: opts.length ?? 1,
      state: opts.state ?? null,
      replaceState: (data, _u, to) => void writes.push({ op: "replace", data, url: to }),
      pushState: (data, _u, to) => void writes.push({ op: "push", data, url: to }),
    },
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    standalone: () => opts.standalone ?? false,
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
      { op: "replace", data: { usr: null, key: "seed0", idx: 0 }, url: "/?h=badger" },
      { op: "push", data: { usr: { from: "/?h=badger" }, key: "seed1", idx: 1 }, url: "/pane/w1%3Ap1?h=badger" },
    ]);
  });

  it("seeds the whole chain under History, so each swipe climbs one level", () => {
    const { win, writes } = fakeWindow("/pane/p1/history");
    seedColdEntry(win);
    expect(writes.map((w) => w.url)).toEqual(["/", "/pane/p1", "/pane/p1/history"]);
    expect(writes.map((w) => w.data.idx)).toEqual([0, 1, 2]);
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

  it("does nothing in a browser tab that has history behind it", () => {
    const { win, writes } = fakeWindow("/pane/p1", { length: 4 });
    expect(seedColdEntry(win)).toBe(false);
    expect(writes).toEqual([]);
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
