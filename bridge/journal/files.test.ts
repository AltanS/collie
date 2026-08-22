import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { containedRealpath } from "./files.ts";

describe("containedRealpath", () => {
  async function fixture() {
    const created = await mkdtemp(join(tmpdir(), "collie-files-"));
    const base = await realpath(created);
    const root = join(base, "root");
    await mkdir(root, { recursive: true });

    const inside = join(root, "inside.txt");
    await Bun.write(inside, "inside\n");

    const outsideDir = join(base, "outside");
    await mkdir(outsideDir, { recursive: true });
    const outside = join(outsideDir, "outside.txt");
    await Bun.write(outside, "outside\n");

    const sneakyDir = join(root, "sneaky");
    await symlink(outsideDir, sneakyDir, process.platform === "win32" ? "junction" : "dir");
    const escaped = join(sneakyDir, "outside.txt");

    return { base, root, inside, outside, escaped };
  }

  test("keeps real files under the root and rejects outside-root or symlinked-out paths", async () => {
    const { base, root, inside, outside, escaped } = await fixture();
    try {
      expect(await containedRealpath(inside, root)).toBe(inside);
      expect(await containedRealpath(outside, root)).toBeNull();
      expect(await containedRealpath(escaped, root)).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
