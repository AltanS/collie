import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { paneKey, paneMapKey, projectPictureCacheName, pushCopyKey, pushPictureFor, type PictureCaches } from "./project-picture-push";

// THE PUSH COPY, as the service worker reads it (issue 811, ADR 0161). The worker never fetches.

const ORIGIN = "https://box.example";
const MOUNT = "/";
const V = "0123456789ab";

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

describe("pushPictureFor", () => {
  const full = (): PictureCaches =>
    caches({
      [paneMapKey(ORIGIN, MOUNT)]: map({ [paneKey({ paneId: "p1" })]: V, [paneKey({ host: "box", paneId: "p2" })]: V }),
      [pushCopyKey(ORIGIN, MOUNT, V)]: PNG,
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

  it("returns null with no Cache for the mount", async () => {
    expect(await pushPictureFor(caches(null), ORIGIN, MOUNT, { paneId: "p1" })).toBeNull();
  });

  it("returns null with no map", async () => {
    expect(await pushPictureFor(caches({ [pushCopyKey(ORIGIN, MOUNT, V)]: PNG }), ORIGIN, MOUNT, { paneId: "p1" })).toBeNull();
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
      [pushCopyKey(ORIGIN, MOUNT, V)]: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]),
    });
    expect(await pushPictureFor(c, ORIGIN, MOUNT, { paneId: "p1" })).toBeNull();
  });

  it.each(["{oops", "[]", "null", "42", ""])("returns null for a malformed map (%j)", async (junk) => {
    const c = caches({ [paneMapKey(ORIGIN, MOUNT)]: junk, [pushCopyKey(ORIGIN, MOUNT, V)]: PNG });
    expect(await pushPictureFor(c, ORIGIN, MOUNT, { paneId: "p1" })).toBeNull();
  });

  it("returns null for a version in the map that is not 12 hex", async () => {
    const c = caches({ [paneMapKey(ORIGIN, MOUNT)]: map({ [paneKey({ paneId: "p1" })]: "../../x" }), [pushCopyKey(ORIGIN, MOUNT, V)]: PNG });
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
