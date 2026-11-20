import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COPIES_MAX,
  PANES_MAX,
  RETRY_FIRST_MS,
  RETRY_MAX_MS,
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
import { iconCopyKey, paneMapKey, pictureSwitchCacheName, pictureSwitchKey, projectPictureCacheName, PUSH_ICON_PX, pushPictureFor } from "./project-picture-push";
import { PROJECT_PICTURE_BYTES_MAX } from "./project-picture-wire";

// THE PROJECT PICTURE STORE (issue 811, ADR 0160). The browser's decoder and canvas are the module's
// own seam, so these cases run on fake bytes and a fake canvas; Cache Storage is an in-memory fake.

const SWITCH_KEY = "collie:project-pictures:v1";
const COPIES_KEY = "collie:project-picture-copies:v1";
const PANES_KEY = "collie:project-picture-panes:v1";

const V1 = "0123456789ab0123456789ab";
const V2 = "ba9876543210ba9876543210";
const URL1 = "data:image/png;base64,SMALL";

/** Twenty-four hex digits for a number, so a test can mint as many versions as it needs. */
const version = (n: number) => n.toString(16).padStart(24, "0");

/** The storage key of one machine's copy: the machine (empty for the lead), a NUL, the version. */
const K = (v: string, host?: string) => `${host ?? ""}\u0000${v}`;

/** A still PNG's leading bytes: signature, the IHDR chunk with the sides, then an empty IDAT. */
function pngBytes(width: number, height: number): Uint8Array {
  const out = new Uint8Array(45);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  out.set([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54], 33);
  return out;
}
const blobOf = (b: Uint8Array) => new Blob([Uint8Array.from(b)], { type: "image/png" });

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
        keys: async () => [...store.keys()].map((url) => ({ url })),
        delete: async (request: { url: string }) => store.delete(request.url),
      };
    }),
    has: async (name: string) => stores.has(name),
    delete: vi.fn(async (name: string) => stores.delete(name)),
    keys: async () => [...stores.keys()],
  };
  return { storage, stores };
}

const cacheName = projectPictureCacheName("/");
/** A picture that passes the header check; the canvas is faked, so the rest of it never matters. */
const bytes = () => blobOf(pngBytes(256, 256));
/** What the canvas hands back: opaque stand-ins for the page's own PNGs. */
const out = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

function seams(over: { fetch?: (path: string) => Promise<Blob> } = {}) {
  const draw = vi.fn(async (_b: Blob, boxes: readonly { width: number; height: number }[]) => boxes.map(() => out()));
  const dataUrl = vi.fn(async () => URL1);
  const fetch = vi.fn(over.fetch ?? (async () => bytes()));
  const clock = { at: 1_000_000 };
  __setProjectPictureSeams({ canvas: { draw, dataUrl }, fetch, now: () => clock.at });
  return { draw, dataUrl, fetch, clock };
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
    expect(pictureCopy(null, V1)).toBe(URL1);
    expect(localStorage.getItem(COPIES_KEY)).not.toBeNull();
    expect(localStorage.getItem(PANES_KEY)).not.toBeNull();

    setProjectPictures(false);
    await vi.waitFor(() => expect(fake.storage.delete).toHaveBeenCalledWith(cacheName));
    expect(localStorage.getItem(COPIES_KEY)).toBeNull();
    expect(localStorage.getItem(PANES_KEY)).toBeNull();
    expect(pictureCopy(null, V1)).toBeNull();
    expect(rememberedPicture({ paneId: "p1" })).toBeNull();
    expect(fake.stores.has(cacheName)).toBe(false);
  });
});

describe("panePicture", () => {
  it.each([undefined, "", "xyz", "0123456789A", "0123456789abc", "0123456789ag", "../etc/passwd"])("reads %j as no picture", (bad) => {
    expect(panePicture({ picture: bad })).toBeNull();
  });

  it("keeps a 24-hex version", () => {
    expect(panePicture({ picture: V1 })).toBe(V1);
  });
});

describe("loadPicture", () => {
  it("fetches the version's path, keeps the small copy and writes the push copy into Cache Storage", async () => {
    const s = seams();
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledWith(`/api/project-picture/${V1}`);
    expect(s.draw).toHaveBeenCalledWith(expect.any(Blob), [
      { width: SMALL_PX, height: SMALL_PX },
      { width: PUSH_ICON_PX, height: PUSH_ICON_PX },
    ]);
    expect(pictureCopy(null, V1)).toBe(URL1);
    expect(JSON.parse(localStorage.getItem(COPIES_KEY) ?? "{}")).toEqual({ [K(V1)]: URL1 });
    const stored = await (await fake.storage.open(cacheName)).match(iconCopyKey(location.origin, "/", null, V1));
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

  it("puts the banner copy under the key of the picture's own machine", async () => {
    const s = seams();
    await loadPicture(V1, "box 2");
    expect(s.draw).toHaveBeenCalledTimes(1);
    const cache = await fake.storage.open(cacheName);
    expect(await cache.match(iconCopyKey(location.origin, "/", "box 2", V1))).toBeDefined();
    expect(await cache.match(iconCopyKey(location.origin, "/", null, V1))).toBeUndefined();
    expect(await cache.match(iconCopyKey(location.origin, "/", "box 3", V1))).toBeUndefined();
  });

  it("asks the canvas for the small box and the 192 px push icon box, and stores the second blob as the icon", async () => {
    const small = new Blob(["small"], { type: "image/png" });
    const icon = new Blob(["icon!"], { type: "image/png" });
    const draw = vi.fn(async () => [small, icon]);
    __setProjectPictureSeams({ canvas: { draw, dataUrl: vi.fn(async () => URL1) }, fetch: async () => bytes() });
    // jsdom's Blob is not a body Node's Response can read, so the test records what the module hands over.
    const bodies: unknown[] = [];
    const Plain = Response;
    vi.stubGlobal(
      "Response",
      class extends Plain {
        constructor(body?: BodyInit | null, init?: ResponseInit) {
          super(body, init);
          bodies.push(body);
        }
      },
    );
    await loadPicture(V1, "box");
    expect(draw).toHaveBeenCalledWith(expect.any(Blob), [
      { width: 96, height: 96 },
      { width: 192, height: 192 },
    ]);
    const stored = await (await fake.storage.open(cacheName)).match(iconCopyKey(location.origin, "/", "box", V1));
    expect(stored).toBeDefined();
    expect(bodies).toEqual([icon]);
    expect(bodies[0]).not.toBe(small);
  });

  it("counts bytes that do not decode as a failure, and tries again only after the wait", async () => {
    const s = seams();
    __setProjectPictureSeams({ canvas: { draw: async () => Promise.reject(new Error("no decode")), dataUrl: async () => URL1 } });
    await loadPicture(V1);
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(pictureCopy(null, V1)).toBeNull();
  });

  it("keeps the small copy when Cache Storage is missing", async () => {
    vi.stubGlobal("caches", undefined);
    seams();
    await loadPicture(V1);
    expect(pictureCopy(null, V1)).toBe(URL1);
  });
});

describe("a copy belongs to one machine", () => {
  it("is not returned for another machine with the same version", async () => {
    seams();
    await loadPicture(V1, "a");
    expect(pictureCopy("a", V1)).toBe(URL1);
    expect(pictureCopy("b", V1)).toBeNull();
    expect(pictureCopy(null, V1)).toBeNull();
    expect(pictureCopy("", V1)).toBeNull();
    expect(Object.keys(JSON.parse(localStorage.getItem(COPIES_KEY) ?? "{}"))).toEqual([K(V1, "a")]);
  });

  it("is kept apart from the lead's copy of the same version", async () => {
    seams();
    await loadPicture(V1);
    await loadPicture(V1, "a");
    expect(Object.keys(JSON.parse(localStorage.getItem(COPIES_KEY) ?? "{}")).toSorted()).toEqual([K(V1), K(V1, "a")].toSorted());
    expect(pictureCopy(null, V1)).toBe(URL1);
    expect(pictureCopy("a", V1)).toBe(URL1);
  });

  it("is read back from storage by machine, and a bare version key reads as nothing", () => {
    localStorage.setItem(COPIES_KEY, JSON.stringify({ [K(V1, "a")]: URL1, [V2]: URL1 }));
    __reloadProjectPictures();
    expect(pictureCopy("a", V1)).toBe(URL1);
    expect(pictureCopy("b", V1)).toBeNull();
    expect(pictureCopy(null, V2)).toBeNull();
  });

  it("is fetched again for the other machine, once each", async () => {
    const s = seams();
    await loadPicture(V1, "a");
    await loadPicture(V1, "b");
    await loadPicture(V1, "a");
    expect(s.fetch.mock.calls.map((c) => c[0])).toEqual([`/api/project-picture/${V1}?host=a`, `/api/project-picture/${V1}?host=b`]);
  });

  it("is not blocked by another machine's failure of the same version", async () => {
    const s = seams({ fetch: async (path) => (path.includes("host=a") ? Promise.reject(new Error("404")) : bytes()) });
    await loadPicture(V1, "a");
    expect(pictureCopy("a", V1)).toBeNull();
    await loadPicture(V1, "b");
    expect(pictureCopy("b", V1)).toBe(URL1);
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("the retry backoff of a failed load", () => {
  /** A fetch that fails until told to succeed. */
  function flaky() {
    const state = { ok: false };
    const s = seams({ fetch: async (path) => (state.ok || !path.includes(V1) ? bytes() : Promise.reject(new Error("404"))) });
    return { ...s, state };
  }

  it("does not retry before the first wait, retries after it, and waits twice as long next", async () => {
    const s = flaky();
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(1);

    s.clock.at += RETRY_FIRST_MS - 1;
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(1);

    s.clock.at += 1;
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(2);

    // The second failure waits 30 s.
    s.clock.at += 2 * RETRY_FIRST_MS - 1;
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(2);
    s.clock.at += 1;
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(3);
  });

  it("doubles from 15 s up to the 10 min cap and stays there", async () => {
    const s = flaky();
    const waits = [15, 30, 60, 120, 240, 480, 600, 600, 600].map((sec) => sec * 1000);
    let calls = 0;
    for (const wait of waits) {
      await loadPicture(V1);
      calls += 1;
      expect(s.fetch).toHaveBeenCalledTimes(calls);
      s.clock.at += wait - 1;
      await loadPicture(V1);
      expect(s.fetch).toHaveBeenCalledTimes(calls);
      s.clock.at += 1;
    }
    expect(RETRY_FIRST_MS).toBe(waits[0]);
    expect(RETRY_MAX_MS).toBe(600_000);
  });

  it("clears the failure on a success, so the copy is kept and nothing is fetched again", async () => {
    const s = flaky();
    await loadPicture(V1);
    s.state.ok = true;
    s.clock.at += RETRY_FIRST_MS;
    await loadPicture(V1);
    expect(pictureCopy(null, V1)).toBe(URL1);
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });

  it("forgets the old wait after a success: a later failure of the same key starts at the first wait", async () => {
    const s = flaky();
    await loadPicture(V1);
    s.clock.at += RETRY_FIRST_MS;
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(2);
    s.state.ok = true;
    s.clock.at += 2 * RETRY_FIRST_MS;
    await loadPicture(V1);
    expect(pictureCopy(null, V1)).toBe(URL1);
    // Push V1 out of the bounded copies, so it can fail afresh.
    for (let n = 1; n <= COPIES_MAX; n += 1) await loadPicture(version(n));
    expect(pictureCopy(null, V1)).toBeNull();
    s.state.ok = false;
    const before = s.fetch.mock.calls.length;
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(before + 1);
    s.clock.at += RETRY_FIRST_MS;
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(before + 2);
  });

  it("counts a refused header as a failure with the same wait", async () => {
    const s = seams({ fetch: async () => blobOf(new Uint8Array([1, 2, 3])) });
    await loadPicture(V1);
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    s.clock.at += RETRY_FIRST_MS;
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a failure for one machine from delaying another's retry", async () => {
    const s = flaky();
    await loadPicture(V1, "a");
    s.clock.at += RETRY_FIRST_MS;
    await loadPicture(V1, "b");
    await loadPicture(V1, "a");
    expect(s.fetch.mock.calls.map((c) => c[0])).toEqual([`/api/project-picture/${V1}?host=a`, `/api/project-picture/${V1}?host=b`, `/api/project-picture/${V1}?host=a`]);
  });
});

describe("the header check before the canvas", () => {
  /** The header bytes of a JPEG: SOI, a baseline frame header (SOF0) with the given sides. */
  function jpegBytes(width: number, height: number): Uint8Array {
    const b = new Uint8Array(30);
    b.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3]);
    return b;
  }
  /** The header bytes of an extended WebP (VP8X) with the given sides. */
  function webpBytes(width: number, height: number): Uint8Array {
    const b = new Uint8Array(30);
    b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
    const w = width - 1;
    const h = height - 1;
    b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24);
    return b;
  }

  const refused: [string, () => Blob][] = [
    ["over 256 KB", () => blobOf(Object.assign(new Uint8Array(PROJECT_PICTURE_BYTES_MAX + 1), pngBytes(256, 256)))],
    ["a GIF", () => blobOf(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...Array.from({ length: 30 }, () => 0)]))],
    ["a PNG 63 px wide", () => blobOf(pngBytes(63, 256))],
    ["a PNG 63 px tall", () => blobOf(pngBytes(256, 63))],
    ["a PNG 1025 px wide", () => blobOf(pngBytes(1025, 256))],
    ["a PNG 1025 px tall", () => blobOf(pngBytes(256, 1025))],
    ["a truncated PNG header", () => blobOf(pngBytes(256, 256).subarray(0, 20))],
    ["an empty body", () => blobOf(new Uint8Array(0))],
  ];

  it.each(refused)("refuses %s before the canvas is asked, and counts it as a failure", async (_name, make) => {
    const s = seams({ fetch: async () => make() });
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.draw).not.toHaveBeenCalled();
    expect(s.dataUrl).not.toHaveBeenCalled();
    expect(pictureCopy(null, V1)).toBeNull();
    expect(localStorage.getItem(COPIES_KEY)).toBeNull();
  });

  const accepted: [string, () => Blob][] = [
    ["a PNG", () => blobOf(pngBytes(256, 256))],
    ["a PNG at the smallest side", () => blobOf(pngBytes(64, 64))],
    ["a PNG at the largest side", () => blobOf(pngBytes(1024, 1024))],
    ["a JPEG (SOF0)", () => blobOf(jpegBytes(300, 200))],
    ["a WebP (VP8X)", () => blobOf(webpBytes(512, 128))],
  ];

  it.each(accepted)("lets %s through to the canvas", async (_name, make) => {
    const s = seams({ fetch: async () => make() });
    await loadPicture(V1);
    expect(s.draw).toHaveBeenCalledTimes(1);
    expect(pictureCopy(null, V1)).toBe(URL1);
  });
});

describe("the small copies", () => {
  it("survive a reload, as the first frame of a cold open", async () => {
    seams();
    await loadPicture(V1);
    __reloadProjectPictures();
    expect(pictureCopy(null, V1)).toBe(URL1);
  });

  it("read a stored value that is not a PNG data URL or not a version as nothing", () => {
    localStorage.setItem(COPIES_KEY, JSON.stringify({ [K(V1)]: "https://evil.example/x.png", [K("nothex")]: URL1, [V1.replace("0", "1")]: URL1, [K(V2)]: URL1 }));
    __reloadProjectPictures();
    expect(pictureCopy(null, V1)).toBeNull();
    expect(pictureCopy(null, "nothex")).toBeNull();
    expect(pictureCopy(null, V2)).toBe(URL1);
  });

  it.each(["{oops", "[]", "null", "7", '"text"'])("read malformed storage (%s) as empty", (junk) => {
    localStorage.setItem(COPIES_KEY, junk);
    __reloadProjectPictures();
    expect(pictureCopy(null, V1)).toBeNull();
  });

  it("are bounded to COPIES_MAX, the oldest dropped", async () => {
    seams();
    for (let n = 1; n <= COPIES_MAX + 2; n += 1) await loadPicture(version(n));
    expect(pictureCopy(null, version(1))).toBeNull();
    expect(pictureCopy(null, version(2))).toBeNull();
    expect(pictureCopy(null, version(3))).toBe(URL1);
    expect(pictureCopy(null, version(COPIES_MAX + 2))).toBe(URL1);
    expect(Object.keys(JSON.parse(localStorage.getItem(COPIES_KEY) ?? "{}"))).toHaveLength(COPIES_MAX);
  });

  it("answer null for no version and while the switch is off", async () => {
    seams();
    await loadPicture(V1);
    expect(pictureCopy(null, null)).toBeNull();
    setProjectPictures(false);
    expect(pictureCopy(null, V1)).toBeNull();
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

  it("drops a pane that is absent from the next list, and a machine's pane with the same id stays apart", () => {
    rememberPanePictures([{ paneId: "p1", picture: V1 }, { paneId: "p2", picture: V2 }, { paneId: "p2", host: "box", picture: V1 }]);
    rememberPanePictures([{ paneId: "p2", picture: V2 }]);
    expect(rememberedPicture({ paneId: "p1" })).toBeNull();
    expect(rememberedPicture({ paneId: "p2", host: "box" })).toBeNull();
    expect(rememberedPicture({ paneId: "p2" })).toBe(V2);
    expect(Object.keys(JSON.parse(localStorage.getItem(PANES_KEY) ?? "{}"))).toEqual(["\u0000p2"]);
    rememberPanePictures([]);
    expect(localStorage.getItem(PANES_KEY)).toBeNull();
  });

  it("changes the entry, in storage and in Cache Storage, when the pane's version changes", async () => {
    rememberPanePictures([{ paneId: "p1", picture: V1 }]);
    rememberPanePictures([{ paneId: "p1", picture: V2 }]);
    expect(rememberedPicture({ paneId: "p1" })).toBe(V2);
    expect(JSON.parse(localStorage.getItem(PANES_KEY) ?? "{}")).toEqual({ "\u0000p1": V2 });
    await vi.waitFor(async () => {
      const entry = await (await fake.storage.open(cacheName)).match(paneMapKey(location.origin, "/"));
      expect(JSON.parse((await entry?.text()) ?? "{}")).toEqual({ "\u0000p1": V2 });
    });
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
    localStorage.setItem(COPIES_KEY, JSON.stringify({ [K(V1)]: URL1 }));
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
    localStorage.setItem(COPIES_KEY, JSON.stringify({ [K(V1)]: URL1 }));
    localStorage.setItem(PANES_KEY, JSON.stringify({ "\u0000p1": V1 }));
    __reloadProjectPictures();
    seams();
    const { result } = renderHook(() => useProjectPicture({ paneId: "p1" }));
    expect(result.current).toBe(URL1);
  });

  it("prefers the pane's own version over the remembered one", () => {
    localStorage.setItem(COPIES_KEY, JSON.stringify({ [K(V1)]: URL1, [K(V2)]: "data:image/png;base64,TWO" }));
    localStorage.setItem(PANES_KEY, JSON.stringify({ "\u0000p1": V1 }));
    __reloadProjectPictures();
    seams();
    const { result } = renderHook(() => useProjectPicture({ paneId: "p1", picture: V2 }));
    expect(result.current).toBe("data:image/png;base64,TWO");
  });

  it("goes quiet when the switch is turned off while mounted", () => {
    localStorage.setItem(COPIES_KEY, JSON.stringify({ [K(V1)]: URL1 }));
    __reloadProjectPictures();
    seams();
    const { result } = renderHook(() => useProjectPicture({ paneId: "p1", picture: V1 }));
    expect(result.current).toBe(URL1);
    act(() => setProjectPictures(false));
    expect(result.current).toBeNull();
  });
});

describe("the push icon copies are bounded (R5)", () => {
  it("keeps only the icon copies of the newest COPIES_MAX copies, and the pane map", async () => {
    seams();
    rememberPanePictures([{ paneId: "p1", picture: version(1) }]);
    for (let n = 1; n <= COPIES_MAX + 5; n++) await loadPicture(version(n));
    const store = fake.stores.get(cacheName)!;
    const icons = [...store.keys()].filter((k) => k.endsWith(".png"));
    expect(icons).toHaveLength(COPIES_MAX);
    expect(store.has(iconCopyKey(location.origin, "/", null, version(1)))).toBe(false);
    expect(store.has(iconCopyKey(location.origin, "/", null, version(COPIES_MAX + 5)))).toBe(true);
    expect(store.has(paneMapKey(location.origin, "/"))).toBe(true);
  });
  it("drops a 2:1 banner an older build kept, at the first icon copy it writes", async () => {
    seams();
    const store = await fake.storage.open(cacheName);
    const oldBanner = `${location.origin}/project-pictures/lead/${V1}.png`;
    await store.put(oldBanner, new Response("old"));
    await loadPicture(V1);
    const keys = [...fake.stores.get(cacheName)!.keys()];
    expect(keys).not.toContain(oldBanner);
    expect(keys).toContain(iconCopyKey(location.origin, "/", null, V1));
  });
});

describe("the switch reaches every tab and the worker (R6)", () => {
  it("follows another tab's change through the storage event", async () => {
    seams();
    await loadPicture(V1);
    expect(pictureCopy(null, V1)).toBe(URL1);
    localStorage.setItem(SWITCH_KEY, "off");
    act(() => {
      globalThis.dispatchEvent(new StorageEvent("storage", { key: SWITCH_KEY }));
    });
    expect(projectPicturesOn()).toBe(false);
    expect(pictureCopy(null, V1)).toBeNull();
    await vi.waitFor(() => expect(fake.storage.delete).toHaveBeenCalledWith(cacheName));
    localStorage.removeItem(SWITCH_KEY);
    act(() => {
      globalThis.dispatchEvent(new StorageEvent("storage", { key: SWITCH_KEY }));
    });
    expect(projectPicturesOn()).toBe(true);
  });

  it("ignores a storage event for another key", () => {
    localStorage.setItem(SWITCH_KEY, "off");
    globalThis.dispatchEvent(new StorageEvent("storage", { key: "collie:other" }));
    expect(projectPicturesOn()).toBe(true);
    localStorage.removeItem(SWITCH_KEY);
  });

  it("writes the worker's marker when off and removes it when on", async () => {
    const marker = pictureSwitchCacheName("/");
    setProjectPictures(false);
    await vi.waitFor(() => expect(fake.stores.get(marker)?.has(pictureSwitchKey(location.origin, "/"))).toBe(true));
    setProjectPictures(true);
    await vi.waitFor(() => expect(fake.stores.has(marker)).toBe(false));
  });

  it("the worker attaches no picture while the marker is there, even with a copy and a map", async () => {
    rememberPanePictures([{ paneId: "p1", picture: V1 }]);
    await vi.waitFor(() => expect(fake.stores.get(cacheName)?.has(paneMapKey(location.origin, "/"))).toBe(true));
    // A push icon copy as plain bytes (jsdom's Blob does not reach a Response's body as bytes).
    const pictures = await fake.storage.open(cacheName);
    await pictures.put(iconCopyKey(location.origin, "/", null, V1), new Response(Uint8Array.from(pngBytes(256, 256))));
    expect(await pushPictureFor(fake.storage, location.origin, "/", { paneId: "p1" })).not.toBeNull();
    // Another tab (or a stale page) still holds the copies: only the marker says off.
    const marker = await fake.storage.open(pictureSwitchCacheName("/"));
    await marker.put(pictureSwitchKey(location.origin, "/"), new Response("off"));
    expect(await pushPictureFor(fake.storage, location.origin, "/", { paneId: "p1" })).toBeNull();
  });
});

describe("a failed load retries when its wait ends (R7)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tries again on its own timer, with no new render", async () => {
    vi.useFakeTimers();
    let fail = true;
    const s = seams({ fetch: async () => (fail ? Promise.reject(new Error("down")) : bytes()) });
    rememberPanePictures([{ paneId: "p1", picture: V1 }]);
    await loadPicture(V1);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    fail = false;
    s.clock.at += RETRY_FIRST_MS;
    await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS);
    expect(s.fetch).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(pictureCopy(null, V1)).toBe(URL1));
  });

  it("stops the timer when no pane shows the picture any more", async () => {
    vi.useFakeTimers();
    const s = seams({ fetch: async () => Promise.reject(new Error("down")) });
    rememberPanePictures([{ paneId: "p1", picture: V1 }]);
    await loadPicture(V1);
    rememberPanePictures([]);
    s.clock.at += RETRY_MAX_MS;
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it("stops the timer when the switch goes off", async () => {
    vi.useFakeTimers();
    const s = seams({ fetch: async () => Promise.reject(new Error("down")) });
    await loadPicture(V1);
    setProjectPictures(false);
    s.clock.at += RETRY_MAX_MS;
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("the failures are bounded by the panes (S2)", () => {
  it("forgets a failure when no pane shows its picture, so a version per poll cannot grow the map", async () => {
    const s = seams({ fetch: async () => Promise.reject(new Error("down")) });
    for (let n = 1; n <= 50; n++) {
      rememberPanePictures([{ paneId: "p1", picture: version(n), host: "m" }]);
      await loadPicture(version(n), "m");
    }
    expect(s.fetch).toHaveBeenCalledTimes(50);
    // Only the last version is still shown, so only its failure holds back a new try.
    await loadPicture(version(49), "m");
    expect(s.fetch).toHaveBeenCalledTimes(51);
    await loadPicture(version(50), "m");
    expect(s.fetch).toHaveBeenCalledTimes(51);
  });
});
