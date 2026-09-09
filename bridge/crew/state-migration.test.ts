import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CREW, leadStore, member } from "./fixtures.ts";
import { emptyCrewOps, serializeCrewOps } from "./ops-store.ts";
import { formatMarker, markerFor } from "./staleness.ts";
import { crewStateFileMoves, migrateCrewStateFiles } from "./state-migration.ts";
import { parseTrustStore, serializeTrustStore, TRUST_STORE_FILENAME } from "./trust-store.ts";

// The one-time move from 1.7.0's `pack-*.json` to 1.8.0's `crew-*.json`, driven on a REAL directory:
// three real files, written in the 1.7.0 spelling, moved by the same function `bridge/index.ts` and
// `cli/context.ts` call at start. A fake filesystem would prove the branch and not the rename, and
// the rename is the part that loses a roster when it is wrong.
//
// REMOVE_IN_1_9_0, with the module it drives.

/** A state directory holding exactly the files named, one per `pack-*.json` name. */
function stateDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "collie-m27-state-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const modernStore = leadStore({ peers: [member({ memberId: "nas" })] });

/**
 * The trust store as 1.7.0 wrote it: the same shape, with `pack` for `crew` and `packId` for
 * `crewId`. Derived from the store the tests already use rather than hand-typed, so the fixture
 * cannot drift away from the real shape while claiming to be it.
 */
function trust170(): string {
  const modern = serializeTrustStore(modernStore);
  const old = modern.replace(/"crew":/g, '"pack":').replace(/"crewId":/g, '"packId":');
  // The fixture must really be the OLD file, or the test below proves nothing.
  expect(old).toContain('"pack":');
  expect(old).toContain('"packId":');
  expect(old).not.toContain('"crewId":');
  return old;
}

const ops170 = () => serializeCrewOps(emptyCrewOps());
const runtime170 = () => formatMarker(markerFor(modernStore, 1_754_000_000_000, 42));

describe("the state files 1.8.0 reads", () => {
  test("the three moves are the three files, old name to new", () => {
    expect(crewStateFileMoves().map((m) => [m.legacy, m.current])).toEqual([
      ["pack-trust.json", "crew-trust.json"],
      ["pack-ops.json", "crew-ops.json"],
      ["pack-runtime.json", "crew-runtime.json"],
    ]);
    expect(TRUST_STORE_FILENAME).toBe("crew-trust.json");
  });
});

describe("migrateCrewStateFiles — on a real directory", () => {
  test("a fresh install: nothing there, nothing said, nothing created", () => {
    const dir = stateDir({});
    expect(migrateCrewStateFiles(dir)).toEqual([]);
    for (const move of crewStateFileMoves()) {
      expect(existsSync(join(dir, move.current))).toBe(false);
      expect(existsSync(join(dir, move.legacy))).toBe(false);
    }
  });

  test("a 1.7.0 directory: all three renamed in place, no copy of the old left behind", () => {
    const dir = stateDir({
      "pack-trust.json": trust170(),
      "pack-ops.json": ops170(),
      "pack-runtime.json": runtime170(),
    });
    const before = readFileSync(join(dir, "pack-trust.json"), "utf8");

    const lines = migrateCrewStateFiles(dir);

    expect(lines).toHaveLength(3);
    for (const move of crewStateFileMoves()) {
      expect(existsSync(join(dir, move.current))).toBe(true);
      // A RENAME, not a copy: two trust stores on one disk are two rosters, and the later reader
      // decides which pins are enforced. No `.bak` either.
      expect(existsSync(join(dir, move.legacy))).toBe(false);
      expect(existsSync(join(dir, `${move.legacy}.bak`))).toBe(false);
      expect(lines.some((l) => l.includes(move.legacy) && l.includes(move.current))).toBe(true);
    }
    // The bytes are the same bytes. The move touches names and nothing inside a file.
    expect(readFileSync(join(dir, "crew-trust.json"), "utf8")).toBe(before);
    expect(lines.every((l) => l.startsWith("[crew] "))).toBe(true);
  });

  test("the old inner keys are read once and written back in the crew spelling", () => {
    const dir = stateDir({ "pack-trust.json": trust170() });
    migrateCrewStateFiles(dir);

    const parsed = parseTrustStore(readFileSync(join(dir, "crew-trust.json"), "utf8"));
    expect(parsed?.crew?.crewId).toBe(CREW.crewId);
    expect(parsed?.crew?.name).toBe(CREW.name);
    expect(parsed?.crew?.secret).toBe(CREW.secret);
    // Every other field survived the read: a migration that dropped the roster would be a
    // migration that unpinned a member.
    expect(parsed?.peers.map((p) => p.memberId)).toEqual(["nas"]);
    expect(parsed).toEqual(modernStore);

    // What the next write puts back carries the new names only, so the fallback is spent once.
    const written = serializeTrustStore(parsed!);
    expect(written).toContain('"crew":');
    expect(written).toContain('"crewId":');
    expect(written).not.toContain('"packId":');
  });

  test("an already-migrated directory: a no-op, said nowhere", () => {
    const dir = stateDir({
      "crew-trust.json": serializeTrustStore(modernStore),
      "crew-ops.json": ops170(),
      "crew-runtime.json": runtime170(),
    });
    expect(migrateCrewStateFiles(dir)).toEqual([]);
    expect(parseTrustStore(readFileSync(join(dir, "crew-trust.json"), "utf8"))).toEqual(modernStore);
    // Idempotent: the second start after the move is the same no-op as the tenth.
    expect(migrateCrewStateFiles(dir)).toEqual([]);
  });

  test("both files present: the crew file wins, the old one is left alone and named", () => {
    const dir = stateDir({
      "crew-trust.json": serializeTrustStore(modernStore),
      "pack-trust.json": trust170(),
    });
    const lines = migrateCrewStateFiles(dir);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("crew-trust.json");
    expect(lines[0]).toContain("pack-trust.json");
    // NOT overwritten, and NOT deleted. Whatever put the old file back there is the operator's
    // business; dropping what 1.8.0 wrote to honour it is not.
    expect(readFileSync(join(dir, "crew-trust.json"), "utf8")).toBe(serializeTrustStore(modernStore));
    expect(readFileSync(join(dir, "pack-trust.json"), "utf8")).toBe(trust170());
  });

  test("a rename that fails is reported, and the rest of the move still runs", () => {
    const dir = stateDir({ "pack-trust.json": trust170(), "pack-ops.json": ops170() });
    const lines = migrateCrewStateFiles(dir, {
      exists: (path) => existsSync(path),
      rename: (from, to) => {
        if (from.endsWith("pack-trust.json")) throw new Error("EPERM");
        writeFileSync(to, readFileSync(from, "utf8"));
      },
    });
    expect(lines[0]).toContain("could not rename pack-trust.json");
    expect(lines[1]).toContain("renamed pack-ops.json");
    expect(existsSync(join(dir, "crew-ops.json"))).toBe(true);
  });
});
