// The red list itself (M102 spec 15, decision 2): every entry names a fixing spec, a place in the
// product code and a sentence, and some test carries its tag. The count per spec is printed, so a run's
// log shows how far the gate is. `bun scripts/invariant-red.ts --gate` is the release gate.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { countBySpec, KNOWN_RED, type KnownRedId } from "./known-red";

const REPO = resolve(import.meta.dirname, "..", "..", "..", "..");

function testSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...testSources(path));
    else if (/\.test\.tsx?$/u.test(name) && !path.endsWith("known-red.test.ts")) out.push(readFileSync(path, "utf8"));
  }
  return out;
}

describe("M102-15, the red list", () => {
  // SAFETY: the keys of KNOWN_RED are exactly the KnownRedId union.
  const ids = Object.keys(KNOWN_RED) as KnownRedId[];

  it("every entry names its invariant, its fixing spec, a file and line, and what the person meets", () => {
    for (const id of ids) {
      const entry = KNOWN_RED[id];
      expect(entry.where, id).toMatch(/\.(ts|tsx):\d+/u);
      expect(entry.what.length, id).toBeGreaterThan(20);
    }
  });

  it("every entry is the tag of some test", () => {
    const sources = [...testSources(join(REPO, "bridge")), ...testSources(join(REPO, "web", "src"))];
    const untagged = ids.filter((id) => !sources.some((source) => source.includes(`"${id}"`)));
    expect(untagged).toEqual([]);
  });

  it("prints the count per fixing spec", () => {
    const counts = countBySpec();
    console.info(`[known-red] ${Object.entries(counts).map(([spec, n]) => `${spec}=${String(n)}`).join(" ")} total=${String(ids.length)}`);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(ids.length);
  });
});
