import { describe, expect, test } from "bun:test";

import {
  extFromName,
  filesToPrune,
  imageExtFromBytes,
  looksLikeText,
  sweepUploads,
  uploadExt,
  uploadTooLarge,
  type UploadFs,
} from "./uploads.ts";

// filesToPrune is the pure decision; sweepUploads is exercised with a fake fs so the stat/unlink
// orchestration (and its best-effort error handling) is covered without touching disk.

const HOUR = 60 * 60 * 1000;
const TTL = 48 * HOUR;

describe("imageExtFromBytes", () => {
  test("recognises PNG, JPEG, GIF, WebP by magic bytes", () => {
    expect(imageExtFromBytes(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(
      "png",
    );
    expect(imageExtFromBytes(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe("jpg");
    expect(imageExtFromBytes(Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("gif");
    const webp = new Uint8Array(12);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(imageExtFromBytes(webp)).toBe("webp");
  });

  test("rejects SVG, HTML, empty, and a RIFF that is not WebP", () => {
    expect(imageExtFromBytes(new TextEncoder().encode("<svg"))).toBeNull();
    expect(imageExtFromBytes(new TextEncoder().encode("<!doctype html>"))).toBeNull();
    expect(imageExtFromBytes(new Uint8Array())).toBeNull();
    const riff = new Uint8Array(12);
    riff.set([0x52, 0x49, 0x46, 0x46], 0);
    riff.set([0x57, 0x41, 0x56, 0x45], 8);
    expect(imageExtFromBytes(riff)).toBeNull();
  });
});

describe("uploadTooLarge", () => {
  const FIVE_MB = 5 * 1024 * 1024;

  test("honours the passed cap, not the shipped default", () => {
    expect(uploadTooLarge(String(6 * 1024 * 1024), FIVE_MB)).toBe(true);
    expect(uploadTooLarge(String(4 * 1024 * 1024), FIVE_MB)).toBe(false);
  });

  test("a missing or unparseable Content-Length is not oversize", () => {
    expect(uploadTooLarge(null, FIVE_MB)).toBe(false);
    expect(uploadTooLarge("not-a-number", FIVE_MB)).toBe(false);
  });
});

describe("looksLikeText", () => {
  test("plain ASCII and UTF-8 text pass", () => {
    expect(looksLikeText(new TextEncoder().encode("hello world"))).toBe(true);
    expect(looksLikeText(new TextEncoder().encode("héllo wörld — 日本語"))).toBe(true);
  });

  test("an empty array passes — nothing in it disagrees", () => {
    expect(looksLikeText(new Uint8Array())).toBe(true);
  });

  test("a NUL byte fails", () => {
    expect(looksLikeText(Uint8Array.of(0x68, 0x69, 0x00, 0x68, 0x69))).toBe(false);
  });

  test("a DEL (0x7f) byte fails", () => {
    expect(looksLikeText(Uint8Array.of(0x68, 0x69, 0x7f))).toBe(false);
  });

  test("an ESC (0x1b) byte passes — an ANSI-coloured .log is still a log", () => {
    expect(looksLikeText(Uint8Array.of(0x1b, 0x5b, 0x33, 0x31, 0x6d))).toBe(true);
  });

  test("tab, newline, and CR pass", () => {
    expect(looksLikeText(Uint8Array.of(0x09, 0x0a, 0x0d, 0x68, 0x69))).toBe(true);
  });

  // The deliberate hole, pinned so nobody closes it by accident. Every byte at or above 0x80 passes,
  // because that is what a UTF-8 continuation byte IS — the second test above ("héllo wörld — 日本語")
  // is nothing but high bytes once it leaves ASCII. A binary made only of high bytes therefore
  // passes this check, and the EXTENSION is what stops it: `uploadExt` asks the name first, and a
  // caller who renames a `.zip` to `.md` has only put a file the agent will read as gibberish onto
  // the operator's own disk. Tighten this and you break every non-English text file there is.
  test("high bytes all pass — the check cannot tell UTF-8 from a renamed binary, by design", () => {
    const highOnly = new Uint8Array(64).fill(0xff);
    expect(looksLikeText(highOnly)).toBe(true);
    // A real UTF-16LE document, which is NOT caught either way: its BOM is high bytes, but the NUL
    // padding of its ASCII characters is what actually refuses it.
    expect(looksLikeText(Uint8Array.of(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00))).toBe(false);
  });
});

describe("extFromName", () => {
  test("the last dot wins, lowercased", () => {
    expect(extFromName("notes.md")).toBe("md");
    expect(extFromName("A.TXT")).toBe("txt");
    expect(extFromName("archive.tar.gz")).toBe("gz");
  });

  test("a leading dot is not an extension", () => {
    expect(extFromName(".gitignore")).toBeNull();
  });

  test("no dot at all claims nothing", () => {
    expect(extFromName("README")).toBeNull();
  });

  test("a trailing dot claims nothing", () => {
    expect(extFromName("trailing.")).toBeNull();
  });

  test("a non-alphanumeric extension is rejected", () => {
    expect(extFromName("weird.a b")).toBeNull();
  });
});

describe("uploadExt", () => {
  const PNG_BYTES = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const TEXT_BYTES = new TextEncoder().encode("hello world");
  const NUL_BYTES = Uint8Array.of(0x68, 0x69, 0x00);

  test("bytes beat the name — PNG magic bytes win even under a .txt name", () => {
    expect(uploadExt("screenshot.txt", PNG_BYTES)).toBe("png");
  });

  test("a shipped text extension with text bytes is accepted", () => {
    expect(uploadExt("notes.md", TEXT_BYTES)).toBe("md");
  });

  test("a shipped text extension with binary bytes is refused", () => {
    expect(uploadExt("notes.md", NUL_BYTES)).toBeNull();
  });

  test("an extension outside the shipped list is refused by default, accepted via extraExts", () => {
    expect(uploadExt("app.rb", TEXT_BYTES)).toBeNull();
    expect(uploadExt("app.rb", TEXT_BYTES, ["rb"])).toBe("rb");
  });

  test("an extension the operator never declared stays refused", () => {
    expect(uploadExt("secrets.env", TEXT_BYTES)).toBeNull();
  });

  test("SVG is refused — script-bearing markup, not a raster image or a declared text type", () => {
    expect(uploadExt("logo.svg", new TextEncoder().encode("<svg></svg>"))).toBeNull();
  });
});

describe("filesToPrune", () => {
  const now = 1_000_000_000_000;

  test("prunes only entries strictly older than the TTL", () => {
    const entries = [
      { name: "fresh.png", mtimeMs: now - 1 * HOUR },
      { name: "old.png", mtimeMs: now - 49 * HOUR },
      { name: "ancient.jpg", mtimeMs: now - 100 * HOUR },
    ];
    expect(filesToPrune(entries, now, TTL)).toEqual(["old.png", "ancient.jpg"]);
  });

  test("an entry exactly at the TTL boundary is kept (not strictly older)", () => {
    expect(filesToPrune([{ name: "edge.png", mtimeMs: now - TTL }], now, TTL)).toEqual([]);
  });

  test("empty input yields nothing", () => {
    expect(filesToPrune([], now, TTL)).toEqual([]);
  });
});

describe("sweepUploads", () => {
  function fakeFs(
    files: Record<string, number>,
    opts: { failStat?: Set<string>; failUnlink?: Set<string> } = {},
  ) {
    const unlinked: string[] = [];
    const fs: UploadFs = {
      readdir: () => Promise.resolve(Object.keys(files)),
      stat: (p) => {
        const name = p.split("/").pop()!;
        if (opts.failStat?.has(name)) return Promise.reject(new Error("stat gone"));
        return Promise.resolve({ mtimeMs: files[name]! });
      },
      unlink: (p) => {
        const name = p.split("/").pop()!;
        if (opts.failUnlink?.has(name)) return Promise.reject(new Error("unlink gone"));
        unlinked.push(name);
        return Promise.resolve();
      },
    };
    return { fs, unlinked };
  }

  const now = 1_000_000_000_000;

  test("removes expired files and returns their names", async () => {
    const { fs, unlinked } = fakeFs({
      "fresh.png": now - 1 * HOUR,
      "old.png": now - 72 * HOUR,
    });
    const removed = await sweepUploads("/uploads", TTL, now, fs);
    expect(removed).toEqual(["old.png"]);
    expect(unlinked).toEqual(["old.png"]);
  });

  test("a missing uploads dir is not an error (nothing uploaded yet)", async () => {
    const fs: UploadFs = {
      readdir: () => Promise.reject(new Error("ENOENT")),
      stat: () => Promise.reject(new Error("nope")),
      unlink: () => Promise.reject(new Error("nope")),
    };
    expect(await sweepUploads("/uploads", TTL, now, fs)).toEqual([]);
  });

  test("skips a file that vanishes between readdir and stat", async () => {
    const { fs, unlinked } = fakeFs(
      { "old.png": now - 72 * HOUR, "racy.png": now - 72 * HOUR },
      { failStat: new Set(["racy.png"]) },
    );
    const removed = await sweepUploads("/uploads", TTL, now, fs);
    expect(removed).toEqual(["old.png"]);
    expect(unlinked).toEqual(["old.png"]);
  });

  test("a failed unlink is skipped without aborting the sweep", async () => {
    const { fs, unlinked } = fakeFs(
      { "a.png": now - 72 * HOUR, "b.png": now - 72 * HOUR },
      { failUnlink: new Set(["a.png"]) },
    );
    const removed = await sweepUploads("/uploads", TTL, now, fs);
    expect(removed).toEqual(["b.png"]);
    expect(unlinked).toEqual(["b.png"]);
  });
});
