import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEVICES_FILENAME, filePairingIo, PairingStore, sha256Hex } from "./pairing.ts";
import { RACY_WINDOW_MS } from "./stat-held.ts";

// The paired-device registry's read behind a stat check, under the racy-timestamp rule (stat-held.ts). A revoked
// device must never stay accepted because a cache kept the old list. The stat is held still by a fake (the same
// size, modified time, inode and change time), so only the clock of the read decides; no sleep, no reliance on a
// file system's time resolution. A revoke by ANOTHER process is written straight to the file, padded to the old
// size; a revoke by this process goes through the store and must be refused on the very next check.

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const AT = 1_800_000_000_000;
const INSIDE = AT + RACY_WINDOW_MS / 4;
const AFTER = AT + RACY_WINDOW_MS * 5;

/** A store over a temp state folder whose registry stats as written at `AT`, read at `clock.t`. */
async function rig(t: number) {
  const stateDir = mkdtempSync(join(tmpdir(), "collie-pairing-racy-"));
  roots.push(stateDir);
  const path = join(stateDir, DEVICES_FILENAME);
  const clock = { t, stats: 0 };
  const io = filePairingIo(stateDir, {
    now: () => clock.t,
    stat: (at) => {
      clock.stats += 1;
      return { size: statSync(at).size, mtimeMs: AT, ino: 7, ctimeMs: AT };
    },
  });
  // A fixed clock far after the enrolment, so no `lastSeenAt` stamp write lands between the checks.
  const store = new PairingStore(io, () => AT);
  const pixel = await store.enrolApproved("pixel");
  const laptop = await store.enrolApproved("laptop");
  await store.idle();
  return { store, path, clock, pixel: pixel.token, laptop: laptop.token };
}

/** What `collie devices revoke <label>` in another process leaves: the file without that device, here padded to its old size. */
function revokeFromTerminal(path: string, label: string): void {
  const before = readFileSync(path, "utf8");
  // SAFETY: the file was just written by this store (`writeRegistry`), which always writes `{ devices: [...] }`.
  const registry = JSON.parse(before) as { devices: { label: string }[] };
  const after = JSON.stringify({ ...registry, devices: registry.devices.filter((d) => d.label !== label) }, null, 2);
  expect(after.length).toBeLessThan(before.length);
  writeFileSync(path, after.padEnd(before.length, " "));
  expect(statSync(path).size).toBe(before.length);
}

describe("a revoke written by another process", () => {
  test("with the same size inside the window of the last read: the very next check refuses the device", async () => {
    const r = await rig(INSIDE);
    expect(r.store.resolve(r.pixel)?.label).toBe("pixel");
    revokeFromTerminal(r.path, "pixel");
    expect(r.store.resolve(r.pixel)).toBeNull();
    expect(r.store.resolve(r.laptop)?.label).toBe("laptop");
  });

  test("after the window the cache answers from the stat alone, and the file is not read", async () => {
    const r = await rig(AFTER);
    expect(r.store.resolve(r.pixel)?.label).toBe("pixel");
    const stats = r.clock.stats;
    // A rewrite that leaves every stat fact as it was, which no real write does once the read is settled: the
    // held parse stands, so the check costs one stat and no read.
    revokeFromTerminal(r.path, "pixel");
    expect(r.store.resolve(r.pixel)?.label).toBe("pixel");
    expect(r.clock.stats).toBe(stats + 1);
  });
});

describe("a revoke by this process drops the cache at once, whatever the stat says", () => {
  // The stat is held still AND the read settled, the worst case for a cache: only the write's own drop helps.
  test("the app's revoke by label", async () => {
    const r = await rig(AFTER);
    expect(r.store.resolve(r.pixel)?.label).toBe("pixel");
    expect(await r.store.revoke("pixel")).toBe(true);
    expect(r.store.resolve(r.pixel)).toBeNull();
    expect(r.store.resolve(r.laptop)?.label).toBe("laptop");
  });

  test("the revoke of an uncollected device by its token hash (pair-request.ts)", async () => {
    const r = await rig(AFTER);
    expect(r.store.resolve(r.pixel)?.label).toBe("pixel");
    expect(await r.store.revokeByTokenHash(sha256Hex(r.pixel))).toBe("pixel");
    expect(r.store.resolve(r.pixel)).toBeNull();
  });

  test("a write that is no revoke (a takeover's adopt) keeps a revoked device refused", async () => {
    const r = await rig(AFTER);
    expect(await r.store.revoke("pixel")).toBe(true);
    expect(await r.store.adopt([{ label: "lead-phone", tokenHash: sha256Hex("x".repeat(43)), createdAt: AT }])).toEqual([]);
    expect(r.store.resolve(r.pixel)).toBeNull();
    expect(r.store.resolve(r.laptop)?.label).toBe("laptop");
  });
});
