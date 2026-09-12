import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// ── WHAT THIS FILE IS ────────────────────────────────────────────────────────
// A TOMBSTONE. It was a clock; the removal it counted down to happened in 1.9.0, and what is left is
// a ratchet against the names coming back.
//
// 1.8.0 renamed every name a machine reads on the crew link (protocol version 2, CREW_PROTOCOL.md §0,
// ADR 0039) and kept a one-release overlap so a 1.7.0 member could follow the update roll (§0.1). Each
// half carried a `REMOVE_IN_<this release>` comment, and this file failed once the package minor
// reached 9 with any of it still present. 1.9.0 deleted all of it, in the commit that rewrote this file. The spec is
// `.tracker/M28-update-takes-the-screen/07-crew-wire-v1-leaves-as-scheduled.md`; what replaced the
// overlap for a genuinely old machine is ADR 0045, a named refusal on the lead's own preflight.
//
// Every assertion below is now UNCONDITIONAL. There is no version to read and no early return: a
// reintroduced 1.7.0 prefix, budget key, `packId` reader or old census route is red on the
// commit that writes it, not at some future minor.
//
// ── THE NEXT CLOCK, AND IT IS NOT HERE ───────────────────────────────────────
// One clock is still running: `cli/program.test.ts:137-145`, "the `crew` alias is gone in 2.0.0". It
// reads the package MAJOR and fires at 2, and it guards the three names ADR 0038 deliberately kept
// for a person rather than a machine: the `collie pack` command alias, `collie docs pack` and the
// app's `/pack` route. Whoever cuts 2.0.0 starts there and should find this file from it: the two
// tombstones are one story about the same word, and reading either in isolation is how a removal gets
// half done.
//
// ── HOW TO ADD A ROW ─────────────────────────────────────────────────────────
// One `describe` per group, one `test` per thing that must stay gone. A test reads the file it is
// about off disk rather than importing it, so the absence is proved by the source no longer saying
// the thing — an import would keep compiling against a leftover export.

/**
 * 1.7.0's path prefix, built rather than written out.
 *
 * A LITERAL HERE WOULD MAKE THIS FILE LIE. The removal's own scan reads every source under `bridge/`,
 * `cli/` and `web/src/` for these strings, so a test that spelled one would be the only hit and the
 * scan would fail on the file asserting the absence. Same reason the marker is joined below.
 */
const OLD_PREFIX = `/${"pack"}/v1`;

/** 1.7.0's signing-context prefix and header prefix, built for the same reason. */
const OLD_DOMAIN = `collie-${"pack"}-`;
const OLD_HEADER = `x-${"pack"}-`;

/** 1.7.0's two budget keys, and the old dismiss key, built the same way. */
const OLD_ENV = [`COLLIE_${"PACK"}_TIMEOUT_MS`, `COLLIE_${"PACK"}_HELLO_TIMEOUT_MS`];
const OLD_DISMISS_KEY = `dismissed${"Pack"}Version`;

/** The marker every half of the overlap carried, built so this file is not its own last hit. */
const MARKER = ["REMOVE", "IN", "1", "9", "0"].join("_");

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

/** True when that module is not in the tree at all. The shape "this file is gone" is asserted with. */
function absent(relative: string): boolean {
  try {
    source(relative);
    return false;
  } catch {
    return true;
  }
}

// ── The wire: protocol version 2's one release of overlap, removed (M27/03) ──
// Three things went together: the lead's version 1 listener, the member's one fallback dial, and the
// service worker's version 1 denylist line. Any one of them coming back would mean a build that
// answers, dials or denies a prefix nothing speaks.
describe("wire", () => {
  test("the version 1 overlap module is gone", () => {
    expect(absent("./crew/v1-overlap.ts")).toBe(true);
  });

  test("the lead answers one prefix", () => {
    expect(source("./crew/router.ts")).not.toContain("v1-overlap.ts");
    expect(source("./crew/router.ts")).not.toContain(OLD_PREFIX);
    expect(source("./crew/router.ts")).not.toContain(MARKER);
  });

  test("the member dials one prefix, with no fallback", () => {
    expect(source("./crew/peer-client.ts")).not.toContain("v1-overlap.ts");
    expect(source("./crew/peer-client.ts")).not.toContain(OLD_PREFIX);
    expect(source("./crew/peer-client.ts")).not.toContain(MARKER);
  });

  // The fallback's one journal line was written once per member per PROCESS, which took a set shared
  // by every client a wiring built. Two wirings held one, and both went with the fallback.
  test("nothing wires a shared told-version-1 set", () => {
    expect(source("./index.ts")).not.toContain("toldVersion1");
    expect(source("../cli/crew.ts")).not.toContain("toldVersion1");
  });

  test("the version 1 signing contexts are gone", () => {
    expect(source("./crew/signing.ts")).not.toContain(OLD_DOMAIN);
    expect(source("./crew/signing.ts")).not.toContain(OLD_HEADER);
    expect(source("./crew/signing.ts")).not.toContain(MARKER);
    expect(source("./crew/warrant.ts")).not.toContain("canonicalWarrantVersion1");
    expect(source("./crew/warrant.ts")).not.toContain(MARKER);
  });

  test("the service worker lists one crew prefix", () => {
    expect(source("../web/src/lib/sw-routes.ts")).not.toContain("/pack");
  });
});

// ── The environment, the state files and the API, removed (M27/02) ──────────
// The other half of the same one release: the two 1.7.0 environment keys, the one-time state-file
// rename, the old census route's 308, the old dismiss scope, the trust store's old inner keys, the
// `pack` arm on every preflight document read, and the old dismiss key in `update-state.json`.
describe("environment, state and the API", () => {
  test("the old environment keys are not read", () => {
    const src = source("./crew/peer-client.ts");
    for (const key of OLD_ENV) expect(src).not.toContain(key);
  });

  // The rename is gone and was NOT replaced by a quieter rename. What replaced it is a line, read
  // once from the boot path: `legacyStateFileNotice` (ADR 0045).
  test("the state file rename is gone, and the notice stands in its place", () => {
    expect(absent("./crew/state-migration.ts")).toBe(true);
    expect(absent("./crew/state-migration.test.ts")).toBe(true);
    expect(source("./crew/trust-store.ts")).toContain("legacyStateFileNotice");
    expect(source("./index.ts")).toContain("legacyStateFileNotice");
  });

  test("1.7.0's census route is not a route", () => {
    expect(source("./server.ts")).not.toContain(`/api/${"pack"}`);
  });

  test("the old dismiss scope is not accepted", () => {
    expect(source("./server.ts")).not.toContain('asked === "pack"');
    expect(source("./server.ts")).not.toContain('"pack"');
  });

  test("the trust store does not read the old inner keys", () => {
    const src = source("./crew/trust-store.ts");
    expect(src).not.toContain("d.pack");
    expect(src).not.toContain("p.packId");
    expect(src).not.toContain("storedWarrantCrewId");
  });

  // The crew's update rows on `/api/update/check` and inside every printed preflight document. Three
  // readers, three separate processes; none of them reads the old key any more.
  test("no preflight document is read under `pack`", () => {
    expect(source("./update-action.ts")).not.toContain("rec.pack");
    expect(source("../cli/update-check.ts")).not.toContain("doc.pack");
    expect(source("../cli/update-check.ts")).not.toContain("pack?: readonly PreflightMember[]");
  });

  test("the old dismiss key is not read from `update-state.json`", () => {
    expect(source("./update.ts")).not.toContain(OLD_DISMISS_KEY);
  });

  // The warrant's crew id and the standby sync's, both spelled `packId` by 1.7.0 (M27/09).
  test("no crew id is read under `packId`", () => {
    expect(source("./crew/warrant.ts")).not.toContain("w.packId");
    expect(source("./crew/trust-store.ts")).not.toContain("legacy.packId");
    expect(source("./crew/standby-devices.ts")).not.toContain("record.packId");
    expect(source("./crew/standby-devices.ts")).not.toContain("eitherCrewId");
    expect(source("./crew/enrollment.ts")).not.toContain("v.packId");
  });
});

// ── The marker itself ────────────────────────────────────────────────────────
// Nothing under `bridge/`, `cli/` or `web/src/` carries this release's marker any more, including
// this file. A new `REMOVE_IN_<version>` marker is welcome; reusing this one is not, because its clock
// has already fired.
describe("the marker", () => {
  test("no source in the tree still carries the 1.9.0 removal marker", () => {
    for (const f of [
      "./crew/router.ts",
      "./crew/peer-client.ts",
      "./crew/signing.ts",
      "./crew/warrant.ts",
      "./crew/trust-store.ts",
      "./crew/standby-devices.ts",
      "./crew/enrollment.ts",
      "./crew/admission.ts",
      "./server.ts",
      "./update.ts",
      "./update-action.ts",
      "./index.ts",
      "../cli/crew.ts",
      "../cli/update-check.ts",
      "../web/src/lib/sw-routes.ts",
    ]) {
      expect(source(f)).not.toContain(MARKER);
    }
  });
});
