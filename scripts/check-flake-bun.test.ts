import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The flake's pinned Bun and MIN_BUN are two statements about ONE fact: the Bun this tree is built
// and measured on. If the flake ever pins a Bun BELOW MIN_BUN, the preflight warns the operator
// about the very Bun the release was built with — a check that calls its own build stale. So the
// two are read straight out of the files that hold them and compared here.

const ROOT = join(import.meta.dir, "..");

/** The pinned Bun, from the one line in flake.nix that states it. */
function flakeBunVersion(): string {
  const source = readFileSync(join(ROOT, "flake.nix"), "utf8");
  const match = /^\s*bunVersion\s*=\s*"([^"]+)";/m.exec(source);
  if (match === null) {
    throw new Error("flake.nix no longer declares `bunVersion = \"x.y.z\";` — this test reads that line");
  }
  return match[1]!;
}

/** MIN_BUN, from cli/update-check.ts. Read as text: the constant is module-private on purpose. */
function minBun(): string {
  const source = readFileSync(join(ROOT, "cli", "update-check.ts"), "utf8");
  const match = /^const MIN_BUN\s*=\s*"([^"]+)";/m.exec(source);
  if (match === null) {
    throw new Error("cli/update-check.ts no longer declares `const MIN_BUN = \"x.y.z\";`");
  }
  return match[1]!;
}

/** -1, 0 or 1. Numeric per component, so 1.10.0 sorts above 1.9.0 rather than below it. */
function compare(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

describe("flake.nix and MIN_BUN", () => {
  test("the flake pins a Bun at least MIN_BUN", () => {
    const pinned = flakeBunVersion();
    const floor = minBun();
    expect(compare(pinned, floor)).toBeGreaterThanOrEqual(0);
  });

  test("both versions are plain three-part numbers", () => {
    // A range, a tag or a `latest` in either place would make the comparison above meaningless.
    expect(flakeBunVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(minBun()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the archive URLs the flake fetches carry the pinned version", () => {
    // The version and the three sources are one pin. A `version` bumped without new hashes would
    // fetch the old archives under the new name, and every claim above it would be a lie.
    const source = readFileSync(join(ROOT, "flake.nix"), "utf8");
    const urls = [...source.matchAll(/url = "([^"]*oven-sh\/bun[^"]*)";/g)].map((m) => m[1]!);
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url).toContain("bun-v${finalAttrs.version}");
    }
  });

  test("the nixpkgs revision in flake.nix is the one flake.lock recorded", () => {
    // `inputs.nixpkgs.url` and the lock are one pin written twice, and only the LOCK is what `nix
    // build` fetches. Editing the rev without running `nix flake lock` therefore builds the old
    // nixpkgs under a new commit id, and the release would name a toolchain it did not use.
    const declared = /inputs\.nixpkgs\.url = "github:NixOS\/nixpkgs\/([0-9a-f]{40})";/.exec(
      readFileSync(join(ROOT, "flake.nix"), "utf8"),
    );
    if (declared === null) {
      throw new Error("flake.nix no longer pins nixpkgs by a 40-character revision — this test reads that line");
    }
    // SAFETY: the shape is asserted, not trusted — every step to `rev` is optional, so a lock that
    // does not have it reads as `undefined` and fails the comparison below rather than throwing.
    const lock = JSON.parse(readFileSync(join(ROOT, "flake.lock"), "utf8")) as {
      nodes: { nixpkgs?: { locked?: { rev?: string } } };
    };
    expect(lock.nodes.nixpkgs?.locked?.rev).toBe(declared[1]!);
  });

  test("compare orders versions numerically, not as text", () => {
    expect(compare("1.10.0", "1.9.0")).toBe(1);
    expect(compare("1.3.14", "1.3.14")).toBe(0);
    expect(compare("1.3.13", "1.3.14")).toBe(-1);
    expect(compare("1.4", "1.4.0")).toBe(0);
  });
});
