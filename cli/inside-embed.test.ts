import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { CLAUDE_MOD_FILES, claudeModVersion, writeClaudeMod } from "./inside-embed.ts";

const MOD_DIR = join(import.meta.dir, "..", "inside", "claude");

/** Every file of the mod's folder that ships: not its tests, not its tsconfig, not the types the engine lays. */
function shippedFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      // The product embeds `/` paths on every platform, so the walk spells them with `/` too.
      const rel = relative(dir, path).replaceAll("\\", "/");
      if (rel === "tests" || rel === ".claude-plugin/types" || rel === "tsconfig.json" || rel === ".gitignore" || entry.name.endsWith(".spec.ts")) continue;
      if (entry.isDirectory()) walk(path);
      else out.push(rel);
    }
  };
  walk(dir);
  return out.toSorted();
}

describe("the Collie mod in the binary's payload", () => {
  test("every shipped file of inside/claude/ is embedded, and nothing else", () => {
    expect(CLAUDE_MOD_FILES.map((file) => file.path).toSorted()).toEqual(shippedFiles(MOD_DIR));
  });

  test("each embedded file is the file on disk, byte for byte", () => {
    for (const file of CLAUDE_MOD_FILES) expect(file.text, file.path).toBe(readFileSync(join(MOD_DIR, file.path), "utf8"));
  });

  test("it is written out byte for byte", () => {
    const dir = mkdtempSync(join(tmpdir(), "mod-"));
    const written = writeClaudeMod(join(dir, "collie"));
    expect(written).toHaveLength(CLAUDE_MOD_FILES.length);
    for (const file of CLAUDE_MOD_FILES) {
      const path = join(dir, "collie", file.path);
      expect(readFileSync(path, "utf8"), file.path).toBe(file.text);
      // Windows has no POSIX mode bits, so only the mode expectation waits for another platform.
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o644);
    }
    expect(shippedFiles(join(dir, "collie"))).toEqual(shippedFiles(MOD_DIR));
  });

  test("its version is Collie's version", () => {
    // SAFETY: package.json is this repository's own manifest, and it always carries a string version.
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
    // The plain version: an Edge stamp (`-edge.N`) goes into the three files of a build, never into the mod.
    expect(claudeModVersion()).toBe(pkg.version.replace(/-edge\.\d+$/u, ""));
  });
});
