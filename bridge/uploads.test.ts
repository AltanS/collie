import { describe, expect, test } from "bun:test";

import { filesToPrune, sweepUploads, type UploadFs } from "./uploads.ts";

// filesToPrune is the pure decision; sweepUploads is exercised with a fake fs so the stat/unlink
// orchestration (and its best-effort error handling) is covered without touching disk.

const HOUR = 60 * 60 * 1000;
const TTL = 48 * HOUR;

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
  ): { fs: UploadFs; unlinked: string[] } {
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
