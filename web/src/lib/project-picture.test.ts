import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COPIES_MAX,
  PANES_MAX,
  PUSH_PX,
  SMALL_PX,
  __reloadProjectPictures,
  __resetProjectPictures,
  __setProjectPictureSeams,
  loadPicture,
  panePicture,
  pictureCopy,
  projectPicturesOn,
  rememberPanePictures,
  rememberedPicture,
  setProjectPictures,
  useProjectPicture,
} from "./project-picture";
import { paneMapKey, projectPictureCacheName, pushCopyKey } from "./project-picture-push";

// THE PROJECT PICTURE STORE (issue 811, ADR 0161). The browser's decoder and canvas are the module's
// own seam, so these cases run on fake bytes and a fake canvas; Cache Storage is an in-memory fake.

const SWITCH_KEY = "collie:project-pictures:v1";
const COPIES_KEY = "collie:project-picture-copies:v1";
const PANES_KEY = "collie:project-picture-panes:v1";

const V1 = "0123456789ab";
const V2 = "ba9876543210";
const URL1 = "data:image/png;base64,SMALL";

/** Twelve hex digits for a number, so a test can mint as many versions as it needs. */
const version = (n: number) => n.toString(16).padStart(12, "0");

/** An in-memory Cache Storage: just the slice the module touches, keyed by string. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const storage = {
    open: vi.fn(async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        put: async (key: string, response: Response) => void store.set(key, response),
        match: async (key: string) => store.get(key)?.clone(),
      };
    }),
    has: async (name: string) => stores.has(name),
    delete: vi.fn(async (name: string) => stores.delete(name)),
    keys: async () => [...stores.keys()],
  };
  return { storage, stores };
}

const cacheName = projectPictureCacheName("/");
const bytes = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

function seams(over: { fetch?: (path: string) => Promise<Blob> } = {}) {
  const draw = vi.fn(async (_b: Blob, sides: readonly number[]) => sides.map(() => bytes()));
  const dataUrl = vi.fn(async () => URL1);
  const fetch = vi.fn(over.fetch ?? (async () => bytes()));
  __setProjectPictureSeams({ canvas: { draw, dataUrl }, fetch });
  return { draw, dataUrl, fetch };
}

let fake: ReturnType<typeof fakeCaches>;

beforeEach(() => {
  __resetProjectPictures();
  fake = fakeCaches();
  vi.stubGlobal("caches", fake.storage);
});
afterEach(() => {
  __resetProjectPictures();
  vi.unstubAllGlobals();
});

describe("the project picture switch", () => {
  it("is on by default and stores nothing", () => {
    expect(projectPicturesOn()).toBe(true);
    expect(localStorage.getItem(SWITCH_KEY)).toBeNull();
  });

  it("stores off, keeps it across a reload, and stores nothing again when turned back on", () => {
    setProjectPictures(false);
    expect(localStorage.getItem(SWITCH_KEY)).toBe("off");
    __reloadProjectPictures();
    expect(projectPicturesOn()).toBe(false);
    setProjectPictures(true);
    expect(localStorage.getItem(SWITCH_KEY)).toBeNull();
  });

  it("drops every copy, the pane map and the Cache Storage entries when turned off", async () => {
    seams();
    await loadPicture(V1);
    rememberPanePictures([{ paneId: "p1", picture: V1 }]);
    expect(pictureCopy(V1)).toBe(URL1);
    expect(localStorage.getItem(COPIES_KEY)).not.toBeNull();
    expect(localStorage.getItem(PANES_KEY)).not.toBeNull();

    setProjectPictures(false);
    await vi.waitFor(() => expect(fake.storage.delete).toHaveBeenCalledWith(cacheName));
    expect(localStorage.getItem(COPIES_KEY)).toBeNull();
    expect(localStorage.getItem(PANES_KEY)).toBeNull();
    expect(pictureCopy(V1)).toBeNull();
    expect(rememberedPicture({ paneId: "p1" })).toBeNull();
    expect(fake.stores.has(cacheName)).toBe(false);
  });
});

describe("panePicture", () => {
  it.each([undefined, "", "xyz", "0123456789A", "0123456789abc", "0123456789ag", "../etc/passwd"])("reads %j as no picture", (bad) => {
    expect(panePicture({ picture: bad })).toBeNull();
  });

  it("keeps a 12-hex version", () => {
    expect(panePicture({ picture: V1 })).toBe(V1);
  });
});

describe("loadPicture", () => {
  it("fetches the version's path, keeps the small copy and writes the push copy into Cache Storage", async () => {
    const s = seams();
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledWith(`/api/project-picture/${V1}`);
    expect(s.draw).toHaveBeenCalledWith(expect.any(Blob), [SMALL_PX, PUSH_PX]);
    expect(pictureCopy(V1)).toBe(URL1);
    expect(JSON.parse(localStorage.getItem(COPIES_KEY) ?? "{}")).toEqual({ [V1]: URL1 });
    const stored = await (await fake.storage.open(cacheName)).match(pushCopyKey(location.origin, "/", V1));
    expect(stored?.headers.get("content-type")).toBe("image/png");
  });

  it("names the machine for a member's picture", async () => {
    const s = seams();
    await loadPicture(V1, "box 2");
    expect(s.fetch).toHaveBeenCalledWith(`/api/project-picture/${V1}?host=box%202`);
  });

  it("loads a version once, even when asked twice at the same time or again afterwards", async () => {
    const s = seams();
    await Promise.all([loadPicture(V1), loadPicture(V1)]);
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not fetch while the switch is off", async () => {
    const s = seams();
    setProjectPictures(false);
    await loadPicture(V1);
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it("does not ask again for a version that failed, in this page's life", async () => {
    const s = seams({ fetch: async () => Promise.reject(new Error("refused")) });
    await loadPicture(V1);
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(pictureCopy(V1)).toBeNull();
    // Another version is not tainted by it.
    await loadPicture(V2);
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });

  it("counts bytes that do not decode as a failure", async () => {
    const s = seams();
    __setProjectPictureSeams({ canvas: { draw: async () => Promise.reject(new Error("no decode")), dataUrl: async () => URL1 } });
    await loadPicture(V1);
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(pictureCopy(V1)).toBeNull();
  });

  it("keeps the small copy when Cache Storage is missing", async () => {
    vi.stubGlobal("caches", undefined);
    seams();
    await loadPicture(V1);
    expect(pictureCopy(V1)).toBe(URL1);
  });
});

describe("the small copies", () => {
  it("survive a reload, as the first frame of a cold open", async () => {
    seams();
    await loadPicture(V1);
    __reloadProjectPictures();
    expect(pictureCopy(V1)).toBe(URL1);
  });

  it("read a stored value that is not a PNG data URL or not a version as nothing", () => {
    localStorage.setItem(COPIES_KEY, JSON.stringify({ [V1]: "https://evil.example/x.png", nothex: URL1, [V2]: URL1 }));
    __reloadProjectPictures();
    expect(pictureCopy(V1)).toBeNull();
    expect(pictureCopy("nothex")).toBeNull();
    expect(pictureCopy(V2)).toBe(URL1);
  });

  it.each(["{oops", "[]", "null", "7", '"text"'])("read malformed storage (%s) as empty", (junk) => {
    localStorage.setItem(COPIES_KEY, junk);
    __reloadProjectPictures();
    expect(pictureCopy(V1)).toBeNull();
  });

  it("are bounded to COPIES_MAX, the oldest dropped", async () => {
    seams();
    for (let n = 1; n <= COPIES_MAX + 2; n += 1) await loadPicture(version(n));
    expect(pictureCopy(version(1))).toBeNull();
    expect(pictureCopy(version(2))).toBeNull();
    expect(pictureCopy(version(3))).toBe(URL1);
    expect(pictureCopy(version(COPIES_MAX + 2))).toBe(URL1);
    expect(Object.keys(JSON.parse(localStorage.getItem(COPIES_KEY) ?? "{}"))).toHaveLength(COPIES_MAX);
  });

  it("answer null for no version and while the switch is off", async () => {
    seams();
    await loadPicture(V1);
    expect(pictureCopy(null)).toBeNull();
    setProjectPictures(false);
    expect(pictureCopy(V1)).toBeNull();
  });
});

describe("rememberPanePictures", () => {
  it("writes the map to storage and to Cache Storage", async () => {
    rememberPanePictures([{ paneId: "p1", picture: V1 }, { paneId: "p2", host: "box", picture: V2 }]);
    expect(rememberedPicture({ paneId: "p1" })).toBe(V1);
    expect(rememberedPicture({ paneId: "p2", host: "box" })).toBe(V2);
    expect(rememberedPicture({ paneId: "p2" })).toBeNull();
    expect(Object.values(JSON.parse(localStorage.getItem(PANES_KEY) ?? "{}")).toSorted()).toEqual([V1, V2].toSorted());
    await vi.waitFor(async () => {
      const entry = await (await fake.storage.open(cacheName)).match(paneMapKey(location.origin, "/"));
      expect(Object.values(JSON.parse((await entry?.text()) ?? "{}")).toSorted()).toEqual([V1, V2].toSorted());
    });
  });

  it("survives a reload", () => {
    rememberPanePictures([{ paneId: "p1", picture: V1 }]);
    __reloadProjectPictures();
    expect(rememberedPicture({ paneId: "p1" })).toBe(V1);
  });

  it("removes a pane whose snapshot names no picture, and the key when the map is empty", () => {
    rememberPanePictures([{ paneId: "p1", picture: V1 }, { paneId: "p2", picture: V2 }]);
    rememberPanePictures([{ paneId: "p1" }, { paneId: "p2", picture: V2 }]);
    expect(rememberedPicture({ paneId: "p1" })).toBeNull();
    expect(rememberedPicture({ paneId: "p2" })).toBe(V2);
    rememberPanePictures([{ paneId: "p2", picture: "malformed" }]);
    expect(rememberedPicture({ paneId: "p2" })).toBeNull();
    expect(localStorage.getItem(PANES_KEY)).toBeNull();
  });

  it("writes nothing when nothing changed", () => {
    rememberPanePictures([{ paneId: "p1", picture: V1 }]);
    const set = vi.spyOn(Storage.prototype, "setItem");
    rememberPanePictures([{ paneId: "p1", picture: V1 }]);
    expect(set).not.toHaveBeenCalled();
    set.mockRestore();
  });

  it("is bounded to PANES_MAX, the oldest dropped", () => {
    const list = Array.from({ length: PANES_MAX + 3 }, (_, n) => ({ paneId: `p${String(n)}`, picture: V1 }));
    rememberPanePictures(list);
    expect(rememberedPicture({ paneId: "p0" })).toBeNull();
    expect(rememberedPicture({ paneId: "p2" })).toBeNull();
    expect(rememberedPicture({ paneId: "p3" })).toBe(V1);
    expect(Object.keys(JSON.parse(localStorage.getItem(PANES_KEY) ?? "{}"))).toHaveLength(PANES_MAX);
  });

  it("does nothing while the switch is off", () => {
    setProjectPictures(false);
    rememberPanePictures([{ paneId: "p1", picture: V1 }]);
    expect(localStorage.getItem(PANES_KEY)).toBeNull();
  });
});

describe("useProjectPicture", () => {
  it("returns null for no pane", () => {
    seams();
    expect(renderHook(() => useProjectPicture(null)).result.current).toBeNull();
    expect(renderHook(() => useProjectPicture(undefined)).result.current).toBeNull();
  });

  it("returns null with the switch off and loads nothing", () => {
    const s = seams();
    setProjectPictures(false);
    const { result } = renderHook(() => useProjectPicture({ paneId: "p1", picture: V1 }));
    expect(result.current).toBeNull();
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it("returns the copy on the very first render when the device holds one (the first-frame rule)", () => {
    localStorage.setItem(COPIES_KEY, JSON.stringify({ [V1]: URL1 }));
    __reloadProjectPictures();
    seams();
    const seen: (string | null)[] = [];
    renderHook(() => {
      const url = useProjectPicture({ paneId: "p1", picture: V1 });
      seen.push(url);
      return url;
    });
    expect(seen[0]).toBe(URL1);
  });

  it("returns null first, starts the load, and draws again when the copy lands", async () => {
    const s = seams();
    const { result } = renderHook(() => useProjectPicture({ paneId: "p1", picture: V1 }));
    expect(result.current).toBeNull();
    await vi.waitFor(() => expect(s.fetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(result.current).toBe(URL1));
  });

  it("falls back to the remembered version when the pane carries none", () => {
    localStorage.setItem(COPIES_KEY, JSON.stringify({ [V1]: URL1 }));
    localStorage.setItem(PANES_KEY, JSON.stringify({ "\u0000p1": V1 }));
    __reloadProjectPictures();
    seams();
    const { result } = renderHook(() => useProjectPicture({ paneId: "p1" }));
    expect(result.current).toBe(URL1);
  });

  it("prefers the pane's own version over the remembered one", () => {
    localStorage.setItem(COPIES_KEY, JSON.stringify({ [V1]: URL1, [V2]: "data:image/png;base64,TWO" }));
    localStorage.setItem(PANES_KEY, JSON.stringify({ "\u0000p1": V1 }));
    __reloadProjectPictures();
    seams();
    const { result } = renderHook(() => useProjectPicture({ paneId: "p1", picture: V2 }));
    expect(result.current).toBe("data:image/png;base64,TWO");
  });

  it("goes quiet when the switch is turned off while mounted", () => {
    localStorage.setItem(COPIES_KEY, JSON.stringify({ [V1]: URL1 }));
    __reloadProjectPictures();
    seams();
    const { result } = renderHook(() => useProjectPicture({ paneId: "p1", picture: V1 }));
    expect(result.current).toBe(URL1);
    act(() => setProjectPictures(false));
    expect(result.current).toBeNull();
  });
});
