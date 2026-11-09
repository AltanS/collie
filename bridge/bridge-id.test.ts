import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseJsonObject, type JsonObject } from "../web/src/lib/json.ts";
import { BRIDGE_ID_FILE, INSTALL_ID_RE, isBridgeId, isOwnId, mintInstallId, resolveBridgeId } from "./bridge-id.ts";

const dirs: string[] = [];
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "collie-bridge-id-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const fileOf = (dir: string): JsonObject | undefined => parseJsonObject(readFileSync(join(dir, BRIDGE_ID_FILE), "utf8"));
const quiet = { warn: () => {} };

describe("the install id", () => {
  test("is m_ and ten of [a-z0-9], never a crew member id, never a host name", () => {
    for (let i = 0; i < 50; i += 1) expect(mintInstallId()).toMatch(INSTALL_ID_RE);
    // The `_` keeps it apart from every crew member id.
    expect(isBridgeId("m_abcdefghij")).toBe(true);
    expect(isBridgeId("collie-04rj6a")).toBe(true);
    expect(isBridgeId("trick")).toBe(false);
    expect(isBridgeId("Bluefin.lan")).toBe(false);
  });

  test("skips the bytes that would skew the draw", () => {
    const bytes = () => Uint8Array.from([255, 252, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 35, 36]);
    expect(mintInstallId(bytes)).toBe("m_abcdefghij");
  });
});

describe("resolveBridgeId", () => {
  test("a solo bridge mints once, writes 0600, and serves the same id on every boot after", () => {
    const dir = stateDir();
    let mints = 0;
    const mint = () => {
      mints += 1;
      return `m_${String(mints).padStart(10, "0")}`;
    };
    const first = resolveBridgeId({ stateDir: dir, crewMemberId: null, mint, ...quiet });
    expect(first).toEqual({ id: "m_0000000001", previous: null });
    expect(statSync(join(dir, BRIDGE_ID_FILE)).mode & 0o777).toBe(0o600);
    expect(fileOf(dir)).toEqual({ v: 1, install: "m_0000000001", id: "m_0000000001", previous: null });
    const before = statSync(join(dir, BRIDGE_ID_FILE)).mtimeMs;
    const second = resolveBridgeId({ stateDir: dir, crewMemberId: null, mint, ...quiet });
    expect(second).toEqual(first);
    expect(mints).toBe(1);
    // Nothing changed, so nothing was written.
    expect(statSync(join(dir, BRIDGE_ID_FILE)).mtimeMs).toBe(before);
    expect(readdirSync(dir)).toEqual([BRIDGE_ID_FILE]);
  });

  test("a crew member serves its member id; the install id is kept for a later leave", () => {
    const dir = stateDir();
    const id = resolveBridgeId({ stateDir: dir, crewMemberId: "bluefin-hc", mint: () => "m_aaaaaaaaaa", ...quiet });
    expect(id).toEqual({ id: "bluefin-hc", previous: null });
    expect(fileOf(dir)).toEqual({ v: 1, install: "m_aaaaaaaaaa", id: "bluefin-hc", previous: null });
  });

  test("joining a crew keeps the install id as the alias; the id moves only at the restart", () => {
    const dir = stateDir();
    const solo = resolveBridgeId({ stateDir: dir, crewMemberId: null, mint: () => "m_aaaaaaaaaa", ...quiet });
    expect(solo.id).toBe("m_aaaaaaaaaa");
    const joined = resolveBridgeId({ stateDir: dir, crewMemberId: "desk", mint: () => "m_bbbbbbbbbb", ...quiet });
    expect(joined).toEqual({ id: "desk", previous: "m_aaaaaaaaaa" });
    expect(isOwnId(joined, "m_aaaaaaaaaa")).toBe(true);
    expect(isOwnId(joined, "desk")).toBe(true);
    expect(isOwnId(joined, "laptop")).toBe(false);
    // A later boot with the same id keeps the alias.
    expect(resolveBridgeId({ stateDir: dir, crewMemberId: "desk", ...quiet })).toEqual(joined);
    // Leaving the crew goes back to the install id, with the member id as the alias.
    expect(resolveBridgeId({ stateDir: dir, crewMemberId: null, ...quiet })).toEqual({ id: "m_aaaaaaaaaa", previous: "desk" });
  });

  test("an unusable crew member id falls back to the install id", () => {
    const dir = stateDir();
    expect(resolveBridgeId({ stateDir: dir, crewMemberId: "trick", mint: () => "m_aaaaaaaaaa", ...quiet }).id).toBe("m_aaaaaaaaaa");
  });

  test("a file that does not read is set aside, never overwritten in place, and a new id is minted", () => {
    const dir = stateDir();
    writeFileSync(join(dir, BRIDGE_ID_FILE), "{ not json");
    const warnings: string[] = [];
    const id = resolveBridgeId({ stateDir: dir, crewMemberId: null, mint: () => "m_cccccccccc", now: () => 7, warn: (line) => warnings.push(line) });
    expect(id.id).toBe("m_cccccccccc");
    expect(existsSync(join(dir, `${BRIDGE_ID_FILE}.bad-7`))).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  test("a write that fails warns and still serves the resolved id", () => {
    const dir = join(stateDir(), "missing", "\0bad");
    const warnings: string[] = [];
    const id = resolveBridgeId({ stateDir: dir, crewMemberId: null, mint: () => "m_dddddddddd", warn: (line) => warnings.push(line) });
    expect(id).toEqual({ id: "m_dddddddddd", previous: null });
    expect(warnings.some((line) => line.includes("could not save"))).toBe(true);
  });
});
