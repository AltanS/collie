// No test file passes 100 KB. A 700 KB file (`bridge/surface/protocol.test.ts` was one) is slow to open,
// hard to review, and one worker's edit conflicts with another's. A new case goes in a new file next to
// the old one, and an old file that is over the cap is split by its `describe` blocks.
//
// The files below were over the cap when the rule came in. Each has a ceiling, its size then rounded up
// to the next 10 KB: it may not grow past it, and it leaves the list when it drops under 100 KB. The list
// only ever shrinks.

import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const KB = 1024;
const CAP = 100 * KB;

const OVERSIZED = {
  "bridge/crew/forward.test.ts": 110 * KB,
  "bridge/crew/router.test.ts": 190 * KB,
  "bridge/journal/pi.test.ts": 140 * KB,
  "bridge/server.test.ts": 340 * KB,
  "bridge/tricks/service.test.ts": 200 * KB,
  "bridge/walky/crew.test.ts": 130 * KB,
  "bridge/walky/deliver.test.ts": 150 * KB,
  "cli/crew.test.ts": 160 * KB,
  "cli/doctor.test.ts": 190 * KB,
  "cli/lifecycle.test.ts": 140 * KB,
  "cli/remote.test.ts": 140 * KB,
  "cli/update.test.ts": 210 * KB,
  "integration/crew-harness.test.ts": 190 * KB,
  "scripts/collie-cli.test.sh": 140 * KB,
  "web/src/components/agent-chat.test.tsx": 290 * KB,
  "web/src/components/composer.test.tsx": 360 * KB,
  "web/src/lib/tricks/schema.test.ts": 130 * KB,
} satisfies Record<string, number>;

function testFiles(): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", "*.test.*", "*.spec.*"], { cwd: ROOT });
  return listed.stdout.toString().split("\n").filter((file) => file !== "" && existsSync(join(ROOT, file)));
}

const kb = (bytes: number): string => `${(bytes / KB).toFixed(1)} KB`;

/** What is wrong with the sizes of `files` (path to bytes), against a cap and a list of ceilings. */
function sizeFindings(sizes: ReadonlyMap<string, number>, ceilings: Readonly<Record<string, number>>, cap: number): string[] {
  const findings: string[] = [];
  for (const [file, size] of sizes) {
    const ceiling = ceilings[file];
    if (ceiling === undefined && size > cap) findings.push(`${file} is ${kb(size)}, over the ${kb(cap)} cap. Split it by its describe blocks into files under the cap.`);
    if (ceiling !== undefined && size > ceiling) findings.push(`${file} is ${kb(size)}, over its ceiling of ${kb(ceiling)}. Add new cases in a new file next to it.`);
    if (ceiling !== undefined && size <= cap) findings.push(`${file} is ${kb(size)}, under the ${kb(cap)} cap again. Remove it from OVERSIZED in scripts/test-file-size.test.ts.`);
  }
  for (const file of Object.keys(ceilings)) {
    if (!sizes.has(file)) findings.push(`${file} is in OVERSIZED but is not a tracked test file. Remove it from the list.`);
  }
  return findings;
}

describe("the test file size cap", () => {
  test("no test file is over 100 KB, and no listed file is over its ceiling or under the cap", () => {
    const sizes = new Map(testFiles().map((file) => [file, statSync(join(ROOT, file)).size]));
    expect(sizeFindings(sizes, OVERSIZED, CAP)).toEqual([]);
  });

  test("the rule names each way a file can break it", () => {
    const sizes = new Map([
      ["a.test.ts", 150 * KB],
      ["b.test.ts", 120 * KB],
      ["c.test.ts", 80 * KB],
      ["d.test.ts", 90 * KB],
    ]);
    const findings = sizeFindings(sizes, { "b.test.ts": 110 * KB, "c.test.ts": 110 * KB, "gone.test.ts": 110 * KB }, CAP);
    expect(findings).toHaveLength(4);
    expect(findings[0]).toContain("a.test.ts is 150.0 KB, over the 100.0 KB cap");
    expect(findings[1]).toContain("b.test.ts is 120.0 KB, over its ceiling of 110.0 KB. Add new cases in a new file next to it.");
    expect(findings[2]).toContain("c.test.ts is 80.0 KB, under the 100.0 KB cap again");
    expect(findings[3]).toContain("gone.test.ts is in OVERSIZED");
  });

  test("a ceiling is a whole number of 10 KB steps above the cap", () => {
    for (const [file, ceiling] of Object.entries(OVERSIZED)) {
      expect(ceiling % (10 * KB), file).toBe(0);
      expect(ceiling, file).toBeGreaterThan(CAP);
    }
  });
});
