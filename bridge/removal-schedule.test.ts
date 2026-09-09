import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// ── WHAT THIS FILE IS ────────────────────────────────────────────────────────
// One place that remembers what 1.9.0 has to delete.
//
// 1.8.0 renamed every name a machine reads (protocol version 2, CREW_PROTOCOL.md §0, ADR 0039) and
// kept a one-release overlap so a 1.7.0 member can follow the update roll (§0.1). Every part of that
// overlap carries a `REMOVE_IN_1_9_0` comment at the line that goes, which is how a reader finds it;
// this file is how the SUITE finds it. Each assertion below is inert while the package minor is
// under 9 and fails the moment it reaches 9 with the thing still present.
//
// The pattern is `cli/program.test.ts`'s major-2 test for the `collie pack` alias, applied to a
// minor instead of a major.
//
// ── HOW TO ADD A ROW ─────────────────────────────────────────────────────────
// One `describe` per group of related removals, and inside it one `test` per thing that goes. A test
// reads the file it is about off disk rather than importing it, so a removal is proved by the source
// no longer saying the thing — an import would keep compiling against a leftover export.

/** The package minor this tree claims. The clock every assertion below reads. */
function packageMinor(): number {
  const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const minor = Number.parseInt(/"version": *"\d+\.(\d+)\./.exec(pkg)?.[1] ?? "", 10);
  expect(Number.isNaN(minor)).toBe(false);
  return minor;
}

/** True while the removal is not due yet. A test that reads this returns instead of asserting. */
function beforeRemoval(minor: number): boolean {
  return packageMinor() < minor;
}

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

// ── The wire: protocol version 2's one release of overlap (M27/03) ───────────
// Three things, and they go together or not at all: the lead's version 1 listener, the member's one
// fallback dial, and the service worker's version 1 denylist line. Leaving any one of them behind
// would mean a 1.9.0 that still answers, dials or denies a prefix nothing speaks.
describe("wire", () => {
  test("the version 1 overlap module is gone in 1.9.0", () => {
    if (beforeRemoval(9)) return;
    let present = true;
    try {
      source("./crew/v1-overlap.ts");
    } catch {
      present = false;
    }
    expect(present).toBe(false);
  });

  test("the lead no longer answers /pack/v1 in 1.9.0", () => {
    if (beforeRemoval(9)) return;
    expect(source("./crew/router.ts")).not.toContain("v1-overlap.ts");
    expect(source("./crew/router.ts")).not.toContain("REMOVE_IN_1_9_0");
  });

  test("the member no longer falls back to /pack/v1 in 1.9.0", () => {
    if (beforeRemoval(9)) return;
    expect(source("./crew/peer-client.ts")).not.toContain("v1-overlap.ts");
    expect(source("./crew/peer-client.ts")).not.toContain("REMOVE_IN_1_9_0");
  });

  test("the version 1 signing contexts are gone in 1.9.0", () => {
    if (beforeRemoval(9)) return;
    expect(source("./crew/signing.ts")).not.toContain("REMOVE_IN_1_9_0");
    expect(source("./crew/warrant.ts")).not.toContain("REMOVE_IN_1_9_0");
  });

  test("the service worker no longer lists /pack/v1 in 1.9.0", () => {
    if (beforeRemoval(9)) return;
    expect(source("../web/src/lib/sw-routes.ts")).not.toContain("/pack");
  });

  // The other direction, and it is the one that catches a removal done by halves: while ANY of the
  // overlap is here, all of it has to be, and every site has to carry the marker a reader greps for.
  test("while the overlap exists, every side of it is marked", () => {
    if (!beforeRemoval(9)) return;
    for (const file of [
      "./crew/v1-overlap.ts",
      "./crew/router.ts",
      "./crew/peer-client.ts",
      "./crew/signing.ts",
      "./crew/warrant.ts",
      "../web/src/lib/sw-routes.ts",
    ]) {
      expect(source(file)).toContain("REMOVE_IN_1_9_0");
    }
    expect(source("./crew/v1-overlap.ts")).toContain('"/pack/v1/"');
    expect(source("../web/src/lib/sw-routes.ts")).toContain("/pack");
  });
});
