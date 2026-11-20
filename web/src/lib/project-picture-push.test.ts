import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  asPushPictureTrace,
  iconCopyKey,
  keepPushPictureTrace,
  lookUpPushPicture,
  paneKey,
  paneMapKey,
  pictureSwitchCacheName,
  pictureSwitchKey,
  projectPictureCacheName,
  pushPictureFor,
  takePushPictureTrace,
  type PictureCaches,
  type TraceCaches,
} from "./project-picture-push";

// THE PUSH COPY, as the service worker reads it (issue 811, ADR 0160). The worker never fetches.

const ORIGIN = "https://box.example";
const MOUNT = "/";
const V = "0123456789ab0123456789ab";
const V2 = "ba9876543210ba9876543210";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 250]);

/** A fake Cache Storage holding the given entries under the right cache name. */
function caches(entries: Record<string, string | Uint8Array> | null): PictureCaches {
  return {
    has: async () => entries !== null,
    open: async () => ({
      match: async (key: string) => {
        const value = entries?.[key];
        // SAFETY: the test bodies are strings or byte arrays, both valid `Response` bodies.
        return value === undefined ? undefined : new Response(value as BodyInit);
      },
    }),
  };
}

const map = (table: Record<string, string>) => JSON.stringify(table);

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("the push copy never touches the network");
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("the cache keys", () => {
  it("keep one cache per mount", () => {
    expect(projectPictureCacheName("/")).toBe("collie-project-pictures");
    expect(projectPictureCacheName("/collie/")).toBe("collie-project-pictures:/collie/");
  });

  it("name the machine and the pane, never the session", () => {
    expect(paneKey({ paneId: "p1" })).toBe("\u0000p1");
    expect(paneKey({ host: "box", paneId: "p1" })).toBe("box\u0000p1");
  });
});

describe("iconCopyKey", () => {
  it("names the machine and the version, and never the pane", () => {
    expect(iconCopyKey(ORIGIN, MOUNT, null, V)).toBe(`${ORIGIN}/project-pictures/lead/icon-${V}.png`);
    expect(iconCopyKey(ORIGIN, MOUNT, undefined, V)).toBe(iconCopyKey(ORIGIN, MOUNT, null, V));
    expect(iconCopyKey(ORIGIN, MOUNT, "", V)).toBe(iconCopyKey(ORIGIN, MOUNT, null, V));
    expect(iconCopyKey(ORIGIN, "/collie/", "box 2", V)).toBe(`${ORIGIN}/collie/project-pictures/host-box%202/icon-${V}.png`);
  });

  it("cannot spell one machine as another, nor a member as the lead", () => {
    expect(iconCopyKey(ORIGIN, MOUNT, "lead", V)).not.toBe(iconCopyKey(ORIGIN, MOUNT, null, V));
    expect(iconCopyKey(ORIGIN, MOUNT, "a/b", V)).not.toBe(iconCopyKey(ORIGIN, MOUNT, "a", V));
    expect(iconCopyKey(ORIGIN, MOUNT, "../x", V)).not.toContain("../");
  });
});

describe("pushPictureFor", () => {
  const full = (): PictureCaches =>
    caches({
      [paneMapKey(ORIGIN, MOUNT)]: map({ [paneKey({ paneId: "p1" })]: V, [paneKey({ host: "box", paneId: "p2" })]: V }),
      [iconCopyKey(ORIGIN, MOUNT, null, V)]: PNG,
      [iconCopyKey(ORIGIN, MOUNT, "box", V)]: PNG,
    });

  it("returns the page's PNG as a data URL for a pane in the map", async () => {
    const url = await pushPictureFor(full(), ORIGIN, MOUNT, { paneId: "p1" });
    expect(url).toMatch(/^data:image\/png;base64,/);
    const decoded = Uint8Array.from(atob(url?.split(",")[1] ?? ""), (c) => c.charCodeAt(0));
    expect([...decoded]).toEqual([...PNG]);
  });

  it("finds a member's pane by its machine", async () => {
    expect(await pushPictureFor(full(), ORIGIN, MOUNT, { host: "box", paneId: "p2" })).toMatch(/^data:image\/png;base64,/);
    expect(await pushPictureFor(full(), ORIGIN, MOUNT, { host: "other", paneId: "p2" })).toBeNull();
  });

  it("uses the copy of the pane's own machine: another host's copy of the same version is not used", async () => {
    const c = caches({
      [paneMapKey(ORIGIN, MOUNT)]: map({ [paneKey({ host: "box", paneId: "p2" })]: V }),
      [iconCopyKey(ORIGIN, MOUNT, "other", V)]: PNG,
      [iconCopyKey(ORIGIN, MOUNT, null, V)]: PNG,
    });
    expect(await pushPictureFor(c, ORIGIN, MOUNT, { host: "box", paneId: "p2" })).toBeNull();
  });

  it("takes the version the map holds for the pane, not another version's copy", async () => {
    const other = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
    const c = caches({
      [paneMapKey(ORIGIN, MOUNT)]: map({ [paneKey({ paneId: "p1" })]: V2 }),
      [iconCopyKey(ORIGIN, MOUNT, null, V)]: PNG,
      [iconCopyKey(ORIGIN, MOUNT, null, V2)]: other,
    });
    const url = await pushPictureFor(c, ORIGIN, MOUNT, { paneId: "p1" });
    expect([...Uint8Array.from(atob(url?.split(",")[1] ?? ""), (ch) => ch.charCodeAt(0))]).toEqual([...other]);
  });

  it("returns null with no Cache for the mount", async () => {
    expect(await pushPictureFor(caches(null), ORIGIN, MOUNT, { paneId: "p1" })).toBeNull();
  });

  it("returns null with no map", async () => {
    expect(await pushPictureFor(caches({ [iconCopyKey(ORIGIN, MOUNT, null, V)]: PNG }), ORIGIN, MOUNT, { paneId: "p1" })).toBeNull();
  });

  it("returns null for a pane the map does not name", async () => {
    expect(await pushPictureFor(full(), ORIGIN, MOUNT, { paneId: "p9" })).toBeNull();
  });

  it("returns null when the map names a version with no copy", async () => {
    const c = caches({ [paneMapKey(ORIGIN, MOUNT)]: map({ [paneKey({ paneId: "p1" })]: V }) });
    expect(await pushPictureFor(c, ORIGIN, MOUNT, { paneId: "p1" })).toBeNull();
  });

  it("returns null for a copy that is not PNG bytes", async () => {
    const c = caches({
      [paneMapKey(ORIGIN, MOUNT)]: map({ [paneKey({ paneId: "p1" })]: V }),
      [iconCopyKey(ORIGIN, MOUNT, null, V)]: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]),
    });
    expect(await pushPictureFor(c, ORIGIN, MOUNT, { paneId: "p1" })).toBeNull();
  });

  it.each(["{oops", "[]", "null", "42", ""])("returns null for a malformed map (%j)", async (junk) => {
    const c = caches({ [paneMapKey(ORIGIN, MOUNT)]: junk, [iconCopyKey(ORIGIN, MOUNT, null, V)]: PNG });
    expect(await pushPictureFor(c, ORIGIN, MOUNT, { paneId: "p1" })).toBeNull();
  });

  it("returns null for a version in the map that is not 24 hex", async () => {
    const c = caches({ [paneMapKey(ORIGIN, MOUNT)]: map({ [paneKey({ paneId: "p1" })]: "../../x" }), [iconCopyKey(ORIGIN, MOUNT, null, V)]: PNG });
    expect(await pushPictureFor(c, ORIGIN, MOUNT, { paneId: "p1" })).toBeNull();
  });

  it.each([undefined, {}, { paneId: null }, { paneId: "" }])("returns null with no pane id (%j)", async (pane) => {
    expect(await pushPictureFor(full(), ORIGIN, MOUNT, pane)).toBeNull();
  });

  it("returns null, and does not throw, when Cache Storage throws", async () => {
    const broken: PictureCaches = { has: async () => Promise.reject(new Error("storage")), open: async () => Promise.reject(new Error("storage")) };
    expect(await pushPictureFor(broken, ORIGIN, MOUNT, { paneId: "p1" })).toBeNull();
  });

  it("never calls fetch", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await pushPictureFor(full(), ORIGIN, MOUNT, { paneId: "p1" });
    await pushPictureFor(caches(null), ORIGIN, MOUNT, { paneId: "p1" });
    expect(spy).not.toHaveBeenCalled();
  });
});

// THE TRACE (round 19): the worker says why a push got its picture or not, from a fixed list.
describe("lookUpPushPicture's verdict", () => {
  const full = () => caches({ [paneMapKey(ORIGIN, MOUNT)]: map({ [paneKey({ paneId: "p1" })]: V }), [iconCopyKey(ORIGIN, MOUNT, null, V)]: PNG });
  const verdictOf = async (c: PictureCaches, pane: { paneId?: string; host?: string } = { paneId: "p1" }) => (await lookUpPushPicture(c, ORIGIN, MOUNT, pane))?.verdict;

  it("names each way a picture is found or missed", async () => {
    expect(await verdictOf(full())).toBe("shown");
    expect(await verdictOf(caches(null))).toBe("no-map");
    expect(await verdictOf(caches({}))).toBe("no-map");
    expect(await verdictOf(caches({ [paneMapKey(ORIGIN, MOUNT)]: map({}) }))).toBe("no-entry");
    expect(await verdictOf(caches({ [paneMapKey(ORIGIN, MOUNT)]: map({ [paneKey({ paneId: "p1" })]: V }) }))).toBe("no-copy");
    expect(await verdictOf(caches({ [paneMapKey(ORIGIN, MOUNT)]: map({ [paneKey({ paneId: "p1" })]: V }), [iconCopyKey(ORIGIN, MOUNT, null, V)]: "<svg/>" }))).toBe("not-png");
    expect(await verdictOf(full(), { paneId: "p1", host: "box" })).toBe("no-entry");
  });

  it("says the switch is off when its marker is there", async () => {
    const c: PictureCaches = {
      has: async () => true,
      open: async (name: string) => ({ match: async (key: string) => (name === pictureSwitchCacheName(MOUNT) && key === pictureSwitchKey(ORIGIN, MOUNT) ? new Response("off") : undefined) }),
    };
    expect(await verdictOf(c)).toBe("switch-off");
  });

  it("says unreadable when Cache Storage throws, and nothing at all for a push about no pane", async () => {
    const broken: PictureCaches = { has: async () => { throw new Error("refused"); }, open: async () => { throw new Error("refused"); } };
    expect(await lookUpPushPicture(broken, ORIGIN, MOUNT, { paneId: "p1" })).toEqual({ picture: null, verdict: "unreadable" });
    expect(await lookUpPushPicture(full(), ORIGIN, MOUNT, { paneId: "" })).toBeNull();
    expect(await lookUpPushPicture(full(), ORIGIN, MOUNT, undefined)).toBeNull();
  });
});

describe("the worker's trace", () => {
  function traceCaches(): TraceCaches & { store: Map<string, Response> } {
    const store = new Map<string, Response>();
    return {
      store,
      open: async () => ({
        match: async (key: RequestInfo | URL) => store.get(String(key))?.clone(),
        put: async (key: RequestInfo | URL, res: Response) => void store.set(String(key), res),
        delete: async (key: RequestInfo | URL) => store.delete(String(key)),
      }),
    };
  }
  const trace = { verdict: "no-copy", machine: "member", at: 1_700_000_000_000, workerBuild: "1.29.1-dev+0072de30c4.1795163609" } as const;

  it("is kept by the worker and taken once by the page", async () => {
    const c = traceCaches();
    await keepPushPictureTrace(c, ORIGIN, MOUNT, trace);
    expect(await takePushPictureTrace(c, ORIGIN, MOUNT)).toEqual(trace);
    expect(await takePushPictureTrace(c, ORIGIN, MOUNT)).toBeNull();
  });

  it("reads anything but its own fields from the fixed list as none", () => {
    expect(asPushPictureTrace(trace)).toEqual(trace);
    expect(asPushPictureTrace({ ...trace, verdict: "maybe" })).toBeNull();
    expect(asPushPictureTrace({ ...trace, machine: "laptop" })).toBeNull();
    expect(asPushPictureTrace({ ...trace, workerBuild: "../../etc/passwd" })).toBeNull();
    expect(asPushPictureTrace({ ...trace, workerBuild: "a b" })).toBeNull();
    expect(asPushPictureTrace({ ...trace, at: -1 })).toBeNull();
    expect(asPushPictureTrace("no-copy")).toBeNull();
    expect(asPushPictureTrace(null)).toBeNull();
  });
});
