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

  // The fallback's one journal line is written once per member per PROCESS, which takes a set shared
  // by every client the wiring builds. Two wirings hold one, and both go with the fallback.
  test("nothing wires a shared told-version-1 set in 1.9.0", () => {
    if (beforeRemoval(9)) return;
    expect(source("./index.ts")).not.toContain("toldVersion1");
    expect(source("../cli/crew.ts")).not.toContain("toldVersion1");
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
      // The two wirings that hand the fallback's per-process "already said" set to their clients.
      "./index.ts",
      "../cli/crew.ts",
    ]) {
      expect(source(file)).toContain("REMOVE_IN_1_9_0");
    }
    expect(source("./crew/v1-overlap.ts")).toContain('"/pack/v1/"');
    expect(source("../web/src/lib/sw-routes.ts")).toContain("/pack");
    // The shape rule the fallback triggers on, and the one line that reads it. Named because the
    // rule is what the VM lab corrected on 2026-09-09, and a removal that took the reader and left
    // the rule would leave dead code nobody could explain.
    expect(source("./crew/v1-overlap.ts")).toContain("routesNoCrewV1");
    expect(source("./crew/peer-client.ts")).toContain("routesNoCrewV1");
  });
});

// ── The environment, the state files and the API (M27/02) ───────────────────
// The other half of the same one release of overlap: the two 1.7.0 environment keys, the one-time
// state-file rename, `/api/pack`'s 308, the old dismiss scope, the trust store's old inner keys,
// the `pack` arm on every preflight document read, and the old dismiss key in `update-state.json`.
// Each is inert on a 1.8.0 install and each is a name 1.9.0 must not still read.
describe("environment, state and the API", () => {
  test("the old environment keys are no longer read in 1.9.0", () => {
    if (beforeRemoval(9)) return;
    const src = source("./crew/peer-client.ts");
    expect(src).not.toContain("COLLIE_PACK_TIMEOUT_MS");
    expect(src).not.toContain("COLLIE_PACK_HELLO_TIMEOUT_MS");
  });

  test("the state file rename is gone in 1.9.0", () => {
    if (beforeRemoval(9)) return;
    let present = true;
    try {
      source("./crew/state-migration.ts");
    } catch {
      present = false;
    }
    expect(present).toBe(false);
  });

  test("`/api/pack` no longer answers a 308 in 1.9.0", () => {
    if (beforeRemoval(9)) return;
    expect(source("./server.ts")).not.toContain("/api/pack");
  });

  test("the old dismiss scope is no longer accepted in 1.9.0", () => {
    if (beforeRemoval(9)) return;
    expect(source("./server.ts")).not.toContain('asked === "pack"');
  });

  test("the trust store no longer reads the old inner keys in 1.9.0", () => {
    if (beforeRemoval(9)) return;
    const src = source("./crew/trust-store.ts");
    expect(src).not.toContain("d.pack");
    expect(src).not.toContain("p.packId");
  });

  // The crew's update rows on `/api/update/check` and inside every printed preflight document.
  // Three readers, three separate processes: the bridge reading its own `collie update --check`
  // subprocess, `collie crew update` reading its own bridge over loopback, and the lead reading a
  // MEMBER's document over ssh. Any of the three can face a 1.7.0 writer during the roll.
  test("no preflight document is read under `pack` in 1.9.0", () => {
    if (beforeRemoval(9)) return;
    expect(source("./update-action.ts")).not.toContain("rec.pack");
    expect(source("../cli/update-check.ts")).not.toContain("doc.pack");
    expect(source("../cli/update-check.ts")).not.toContain("pack?: readonly PreflightMember[]");
  });

  test("the old dismiss key is no longer read from `update-state.json` in 1.9.0", () => {
    if (beforeRemoval(9)) return;
    expect(source("./update.ts")).not.toContain("dismissedPackVersion");
  });

  // The warrant's crew id and the standby sync's, both spelled `packId` by 1.7.0 (M27/09). Neither
  // is translated by the overlap: every 1.8.0 writer emits `crewId` and every 1.8.0 reader accepts
  // either, which is what covers both skews without a body translation. The fallbacks go in 1.9.0.
  test("no crew id is read under `packId` in 1.9.0", () => {
    if (beforeRemoval(9)) return;
    expect(source("./crew/warrant.ts")).not.toContain("w.packId");
    expect(source("./crew/trust-store.ts")).not.toContain("legacy.packId");
    expect(source("./crew/trust-store.ts")).not.toContain("storedWarrantCrewId");
    expect(source("./crew/standby-devices.ts")).not.toContain("record.packId");
    expect(source("./crew/standby-devices.ts")).not.toContain("eitherCrewId");
    expect(source("./crew/enrollment.ts")).not.toContain("v.packId");
  });

  // The same both-or-neither rule the wire block ends on: while any of this is here, every site
  // carries the marker a reader greps for.
  test("while the overlap exists, every side of it is marked", () => {
    if (!beforeRemoval(9)) return;
    for (const file of [
      "./crew/peer-client.ts",
      "./crew/state-migration.ts",
      "./crew/trust-store.ts",
      "./crew/warrant.ts",
      "./crew/standby-devices.ts",
      "./crew/enrollment.ts",
      "./server.ts",
      "./update-action.ts",
      "./update.ts",
      "../cli/update-check.ts",
    ]) {
      expect(source(file)).toContain("REMOVE_IN_1_9_0");
    }
  });
});
