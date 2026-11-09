import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseJsonObject, type JsonObject } from "../web/src/lib/json.ts";
import { BRIDGE_ID_FILE, type BridgeIdentity, INSTALL_ID_RE, isBridgeId, isOwnId, mintInstallId, resolveBridgeId } from "./bridge-id.ts";

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

/** Resolve as index.ts does at boot, then use it once, as a trick run or a hill post does. */
function boot(opts: Parameters<typeof resolveBridgeId>[0]): Pick<BridgeIdentity, "id" | "previous"> {
  const identity = resolveBridgeId(opts);
  identity.keep();
  return { id: identity.id, previous: identity.previous };
}

describe("resolveBridgeId", () => {
  test("boot only reads: nothing is written until the id is first kept (solo zero-tax)", () => {
    const dir = stateDir();
    const identity = resolveBridgeId({ stateDir: dir, crewMemberId: null, mint: () => "m_aaaaaaaaaa", ...quiet });
    expect(identity.id).toBe("m_aaaaaaaaaa");
    expect(readdirSync(dir)).toEqual([]);
    identity.keep();
    expect(readdirSync(dir)).toEqual([BRIDGE_ID_FILE]);
    // A boot that never kept its id threw it away: the next mints another, and nothing was keyed on it.
    const unused = stateDir();
    expect(resolveBridgeId({ stateDir: unused, crewMemberId: null, mint: () => "m_bbbbbbbbbb", ...quiet }).id).toBe("m_bbbbbbbbbb");
    expect(resolveBridgeId({ stateDir: unused, crewMemberId: null, mint: () => "m_cccccccccc", ...quiet }).id).toBe("m_cccccccccc");
  });

  test("a solo bridge mints once, writes 0600, and serves the same id on every boot after", () => {
    const dir = stateDir();
    let mints = 0;
    const mint = () => {
      mints += 1;
      return `m_${String(mints).padStart(10, "0")}`;
    };
    const first = boot({ stateDir: dir, crewMemberId: null, mint, ...quiet });
    expect(first).toEqual({ id: "m_0000000001", previous: null });
    expect(statSync(join(dir, BRIDGE_ID_FILE)).mode & 0o777).toBe(0o600);
    expect(fileOf(dir)).toEqual({ v: 1, install: "m_0000000001", id: "m_0000000001", previous: null });
    const before = statSync(join(dir, BRIDGE_ID_FILE)).mtimeMs;
    const second = boot({ stateDir: dir, crewMemberId: null, mint, ...quiet });
    expect(second).toEqual(first);
    // The second boot read the install id: the one draw it made was never used.
    expect(fileOf(dir)?.install).toBe("m_0000000001");
    // Nothing changed, so nothing was written.
    expect(statSync(join(dir, BRIDGE_ID_FILE)).mtimeMs).toBe(before);
    expect(readdirSync(dir)).toEqual([BRIDGE_ID_FILE]);
  });

  test("a crew member serves its member id; the install id is kept for a later leave", () => {
    const dir = stateDir();
    const id = boot({ stateDir: dir, crewMemberId: "bluefin-hc", mint: () => "m_aaaaaaaaaa", ...quiet });
    expect(id).toEqual({ id: "bluefin-hc", previous: null });
    expect(fileOf(dir)).toEqual({ v: 1, install: "m_aaaaaaaaaa", id: "bluefin-hc", previous: null });
  });

  test("joining a crew keeps the install id as the alias; the id moves only at the restart", () => {
    const dir = stateDir();
    const solo = boot({ stateDir: dir, crewMemberId: null, mint: () => "m_aaaaaaaaaa", ...quiet });
    expect(solo.id).toBe("m_aaaaaaaaaa");
    const joining = resolveBridgeId({ stateDir: dir, crewMemberId: "desk", mint: () => "m_bbbbbbbbbb", ...quiet });
    expect({ id: joining.id, previous: joining.previous }).toEqual({ id: "desk", previous: "m_aaaaaaaaaa" });
    expect(isOwnId(joining, "m_aaaaaaaaaa")).toBe(true);
    expect(isOwnId(joining, "desk")).toBe(true);
    expect(isOwnId(joining, "laptop")).toBe(false);
    // Not kept yet: the next boot still knows the alias from the file.
    expect(boot({ stateDir: dir, crewMemberId: "desk", ...quiet })).toEqual({ id: "desk", previous: "m_aaaaaaaaaa" });
    // Kept now: a later boot with the same id keeps the alias.
    expect(boot({ stateDir: dir, crewMemberId: "desk", ...quiet })).toEqual({ id: "desk", previous: "m_aaaaaaaaaa" });
    // Leaving the crew goes back to the install id, with the member id as the alias.
    expect(boot({ stateDir: dir, crewMemberId: null, ...quiet })).toEqual({ id: "m_aaaaaaaaaa", previous: "desk" });
  });

  test("an unusable crew member id falls back to the install id", () => {
    const dir = stateDir();
    expect(boot({ stateDir: dir, crewMemberId: "trick", mint: () => "m_aaaaaaaaaa", ...quiet }).id).toBe("m_aaaaaaaaaa");
  });

  test("a file that does not read is set aside at the first use, never overwritten in place, and a new id is minted", () => {
    const dir = stateDir();
    writeFileSync(join(dir, BRIDGE_ID_FILE), "{ not json");
    const warnings: string[] = [];
    const identity = resolveBridgeId({ stateDir: dir, crewMemberId: null, mint: () => "m_cccccccccc", now: () => 7, warn: (line) => warnings.push(line) });
    expect(identity.id).toBe("m_cccccccccc");
    expect(warnings).toHaveLength(1);
    expect(existsSync(join(dir, `${BRIDGE_ID_FILE}.bad-7`))).toBe(false);
    identity.keep();
    expect(existsSync(join(dir, `${BRIDGE_ID_FILE}.bad-7`))).toBe(true);
    expect(fileOf(dir)?.install).toBe("m_cccccccccc");
  });

  test("a write that fails warns once and still serves the resolved id", () => {
    const dir = join(stateDir(), "missing", "\0bad");
    const warnings: string[] = [];
    const identity = resolveBridgeId({ stateDir: dir, crewMemberId: null, mint: () => "m_dddddddddd", warn: (line) => warnings.push(line) });
    identity.keep();
    identity.keep();
    expect(identity.id).toBe("m_dddddddddd");
    expect(warnings.filter((line) => line.includes("could not save"))).toHaveLength(1);
  });
});
