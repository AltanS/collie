import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FileImageAnswer } from "@/lib/api";
import {
  __heldImages,
  clearHeldImages,
  dropHeldImages,
  fileVersionOf,
  heldImage,
  imageSubject,
  MAX_HELD_BYTES,
  MAX_HELD_IMAGES,
} from "@/lib/file-image-cache";
import { setDeviceToken } from "@/lib/pairing";
import { wipeDevice } from "@/lib/wipe";

// The Files screen holds the bytes of the pictures it drew, in memory, under the file's version
// (ADR 0090, amended 2026-10-07). These tests run the table through `heldImage`, the one door.

const SUBJECT = imageSubject(undefined, "pane:w1:p1");
const V1 = { tag: "100:1", own: true } as const;

function picture(size = 4, type = "image/png"): Blob {
  return new Blob([new Uint8Array(size)], { type });
}

/** A fetcher that answers with `answer` and counts its calls. */
function fetcher(answer?: FileImageAnswer) {
  return vi.fn(async (): Promise<FileImageAnswer> => answer ?? { outcome: "image", blob: picture() });
}

beforeEach(() => {
  clearHeldImages();
  localStorage.clear();
});

describe("the held pictures", () => {
  it("asks the bridge once for one path at one version, and serves the second open from memory", async () => {
    const fetch = fetcher();
    const first = await heldImage(SUBJECT, "a.png", V1, fetch);
    const second = await heldImage(SUBJECT, "a.png", V1, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    if (first.outcome !== "image" || second.outcome !== "image") throw new Error("not images");
    expect(second.blob).toBe(first.blob);
  });

  it("asks again for another version, another path, another pane, another machine", async () => {
    const fetch = fetcher();
    await heldImage(SUBJECT, "a.png", V1, fetch);
    await heldImage(SUBJECT, "a.png", { tag: "100:2", own: true }, fetch);
    await heldImage(SUBJECT, "b.png", V1, fetch);
    await heldImage(imageSubject(undefined, "pane:w1:p2"), "a.png", V1, fetch);
    await heldImage(imageSubject({ host: "laptop" }, "pane:w1:p1"), "a.png", V1, fetch);
    await heldImage(imageSubject({ session: "work" }, "pane:w1:p1"), "a.png", V1, fetch);
    await heldImage(imageSubject(undefined, "space:w1:p1"), "a.png", V1, fetch);
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(__heldImages().count).toBe(7);
  });

  it("holds nothing for a file with no version, and fetches every time", async () => {
    const fetch = fetcher();
    await heldImage(SUBJECT, "a.png", null, fetch);
    await heldImage(SUBJECT, "a.png", null, fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(__heldImages().count).toBe(0);
  });

  it("builds the version from size and mtime, and none from half of it", () => {
    expect(fileVersionOf(52_224, 1_728_300_000_123.5)).toBe("52224:1728300000123.5");
    expect(fileVersionOf("52224", "1728300000123.5")).toBe("52224:1728300000123.5");
    expect(fileVersionOf(52_224, undefined)).toBeNull();
    expect(fileVersionOf(null, 1)).toBeNull();
  });

  it("does not hold a refusal, a failure or a body that is not an image", async () => {
    for (const answer of [
      { outcome: "too-large" },
      { outcome: "not-image" },
      { outcome: "failed" },
      { outcome: "image", blob: picture(4, "text/html") },
      { outcome: "image", blob: picture(4, "") },
    ] as const) {
      const fetch = fetcher(answer);
      expect(await heldImage(SUBJECT, "x.png", V1, fetch)).toBe(answer);
      await heldImage(SUBJECT, "x.png", V1, fetch);
      expect(fetch).toHaveBeenCalledTimes(2);
    }
    expect(__heldImages().count).toBe(0);
  });

  it("does not hold bytes whose own version disagrees with the version asked for", async () => {
    const newer = fetcher({ outcome: "image", blob: picture(), version: "100:2" });
    await heldImage(SUBJECT, "a.png", V1, newer);
    expect(__heldImages().count).toBe(0);
    // Agreeing, or silent (a member behind a lead forwards no version), it is held.
    await heldImage(SUBJECT, "a.png", V1, fetcher({ outcome: "image", blob: picture(), version: "100:1" }));
    await heldImage(SUBJECT, "b.png", V1, fetcher({ outcome: "image", blob: picture() }));
    expect(__heldImages().count).toBe(2);
    // A Markdown picture's tag is its Markdown file's, which its own headers cannot be compared with.
    await heldImage(SUBJECT, "c.png", { tag: "doc.md@9:9", own: false }, fetcher({ outcome: "image", blob: picture(), version: "100:1" }));
    expect(__heldImages().count).toBe(3);
  });
});

describe("the bounds", () => {
  it("holds at most 32 pictures and drops the oldest first", async () => {
    const fetch = fetcher();
    for (let i = 0; i < MAX_HELD_IMAGES + 3; i++) await heldImage(SUBJECT, `${String(i)}.png`, V1, fetch);
    expect(__heldImages().count).toBe(MAX_HELD_IMAGES);
    fetch.mockClear();
    await heldImage(SUBJECT, "0.png", V1, fetch);
    await heldImage(SUBJECT, "2.png", V1, fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockClear();
    await heldImage(SUBJECT, `${String(MAX_HELD_IMAGES + 2)}.png`, V1, fetch);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("counts a hit as a use, so the picture looked at last is the last to go", async () => {
    const fetch = fetcher();
    for (let i = 0; i < MAX_HELD_IMAGES; i++) await heldImage(SUBJECT, `${String(i)}.png`, V1, fetch);
    await heldImage(SUBJECT, "0.png", V1, fetch);
    await heldImage(SUBJECT, "new.png", V1, fetch);
    fetch.mockClear();
    await heldImage(SUBJECT, "0.png", V1, fetch);
    expect(fetch).not.toHaveBeenCalled();
    await heldImage(SUBJECT, "1.png", V1, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("holds at most 64 MiB in all, dropping the oldest until it fits", async () => {
    const MiB = 1024 * 1024;
    // Blobs are not allocated here: a Blob over a sized view would be, so fake only the size.
    const big = (size: number): Blob => Object.defineProperty(picture(1), "size", { value: size });
    for (const name of ["a", "b", "c", "d"]) {
      await heldImage(SUBJECT, `${name}.png`, V1, fetcher({ outcome: "image", blob: big(16 * MiB) }));
    }
    expect(__heldImages()).toEqual({ count: 4, bytes: MAX_HELD_BYTES });
    await heldImage(SUBJECT, "e.png", V1, fetcher({ outcome: "image", blob: big(10 * MiB) }));
    // The oldest goes, and only until the new one fits: a (16 MiB) frees enough for e (10 MiB).
    expect(__heldImages()).toEqual({ count: 4, bytes: 58 * MiB });
    const probe = fetcher();
    await heldImage(SUBJECT, "a.png", V1, probe);
    expect(probe).toHaveBeenCalledTimes(1);
    const kept = fetcher();
    await heldImage(SUBJECT, "e.png", V1, kept);
    expect(kept).not.toHaveBeenCalled();
  });

  it("does not hold one picture bigger than the whole table", async () => {
    const huge = Object.defineProperty(picture(1), "size", { value: MAX_HELD_BYTES + 1 });
    await heldImage(SUBJECT, "huge.png", V1, fetcher({ outcome: "image", blob: huge }));
    expect(__heldImages()).toEqual({ count: 0, bytes: 0 });
  });
});

describe("dropping and clearing", () => {
  it("a refresh drops one pane's pictures and leaves the others", async () => {
    const other = imageSubject(undefined, "pane:w1:p2");
    const fetch = fetcher();
    await heldImage(SUBJECT, "a.png", V1, fetch);
    await heldImage(other, "a.png", V1, fetch);
    dropHeldImages(SUBJECT);
    fetch.mockClear();
    await heldImage(SUBJECT, "a.png", V1, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    await heldImage(other, "a.png", V1, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("the wipe empties the table, for each way a pairing ends and for a password prompt", async () => {
    for (const reason of ["unpair", "revoked", "expired"] as const) {
      await heldImage(SUBJECT, "a.png", V1, fetcher());
      expect(__heldImages().count).toBe(1);
      await wipeDevice(reason);
      expect(__heldImages()).toEqual({ count: 0, bytes: 0 });
    }
    await heldImage(SUBJECT, "a.png", V1, fetcher());
    await wipeDevice("password", { scope: undefined, paneId: "w1:p1" });
    expect(__heldImages().count).toBe(0);
  });

  it("a new token empties the table; the same token again does not", async () => {
    setDeviceToken("tok-one");
    await heldImage(SUBJECT, "a.png", V1, fetcher());
    setDeviceToken("tok-one");
    expect(__heldImages().count).toBe(1);
    setDeviceToken("tok-two");
    expect(__heldImages().count).toBe(0);
  });
});

// The picture path never reaches a persistent store (ADR 0090, amended 2026-10-07; ADR 0087). Read
// off the source with comments dropped, because the modules' own headers name the stores they avoid.
describe("a picture's bytes are never persisted", () => {
  const code = (file: string) =>
    readFileSync(resolve(import.meta.dirname, file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");

  it("the held-picture table and the screens that draw pictures touch no persistent store", () => {
    for (const file of ["./file-image-cache.ts", "../components/file-preview.tsx"]) {
      const src = code(file);
      for (const store of [/\bputRecord\b/, /\bcaches\./, /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /from "@\/lib\/store"/]) {
        expect({ file, store: String(store), found: store.test(src) }).toEqual({ file, store: String(store), found: false });
      }
    }
  });
});
