import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "./host.ts";
import {
  HISTORY_MINUTES,
  loadMachineHistory,
  MACHINE_HISTORY_FILE,
  MachineHistory,
  MINUTE_MS,
  saveMachineHistory,
} from "./machine-history.ts";
import { ensureOwnerOnlyDir, isOwnerOnly, privateRoot } from "./owner-only.ts";
import type { MachineSample } from "./types.ts";

// One bucket per minute per machine, a day of them, persisted from the tick (ADR 0084).

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const DAY_MS = 24 * 60 * MINUTE_MS;

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-machine-history-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function sample(cpu: number, memFrac: number, net?: { rx: number; tx: number }): MachineSample {
  const s: MachineSample = { cpu, cores: 4, memUsed: memFrac * 8e9, memTotal: 8e9 };
  if (net !== undefined) {
    s.rxBps = net.rx;
    s.txBps = net.tx;
  }
  return s;
}

describe("minute buckets", () => {
  test("samples in one minute fold into one point: cpu average and maximum, memory and network averages", () => {
    const h = new MachineHistory();
    h.record("desk", sample(0.2, 0.5, { rx: 100, tx: 10 }), T0 + 1_000);
    h.record("desk", sample(0.6, 0.7, { rx: 300, tx: 30 }), T0 + 30_000);
    h.record("desk", sample(0.4, 0.6), T0 + 59_999);
    expect(h.points("desk", T0 + 60_000)).toEqual([[T0, 0.4, 0.6, 0.6, 200, 20]]);
  });

  test("a minute with no network reading says null, and a missing minute is simply missing", () => {
    const h = new MachineHistory();
    h.record("desk", sample(0.1, 0.2), T0);
    h.record("desk", sample(0.3, 0.4), T0 + 2 * MINUTE_MS);
    expect(h.points("desk", T0 + 3 * MINUTE_MS)).toEqual([
      [T0, 0.1, 0.1, 0.2, null, null],
      [T0 + 2 * MINUTE_MS, 0.3, 0.3, 0.4, null, null],
    ]);
  });

  test("machines are kept apart, and an unknown one has no points", () => {
    const h = new MachineHistory();
    h.record("desk", sample(0.1, 0.2), T0);
    h.record("laptop", sample(0.9, 0.8), T0);
    expect(h.points("laptop", T0)).toEqual([[T0, 0.9, 0.9, 0.8, null, null]]);
    expect(h.points("nas", T0)).toEqual([]);
  });

  test("a clock that stepped back a little folds into the newest minute, so the list stays ordered", () => {
    const h = new MachineHistory();
    h.record("desk", sample(0.2, 0.5), T0 + MINUTE_MS + 10);
    h.record("desk", sample(0.4, 0.5), T0 + 50_000);
    const points = h.points("desk", T0 + 2 * MINUTE_MS);
    expect(points.map((p) => p[0])).toEqual([T0 + MINUTE_MS]);
    expect(points[0]![1]).toBeCloseTo(0.3, 10);
  });

  test("a clock that jumped back by more than a minute drops the buckets now in the future", () => {
    const h = new MachineHistory();
    h.record("desk", sample(0.1, 0.5), T0 - MINUTE_MS);
    h.record("desk", sample(0.2, 0.5), T0 + 5 * 60 * MINUTE_MS);
    h.record("desk", sample(0.3, 0.5), T0 + 5 * 60 * MINUTE_MS + MINUTE_MS);
    h.markSaved();
    // The clock comes back five hours: the two minutes it wrote ahead go, the one before stays.
    h.record("desk", sample(0.4, 0.5), T0);
    expect(h.dirty()).toBe(true);
    expect(h.points("desk", T0 + 30_000).map((p) => p[0])).toEqual([T0 - MINUTE_MS, T0]);
    expect(h.minutes("desk", T0 - 10 * MINUTE_MS, T0 + MINUTE_MS).map((m) => m.cpu)).toEqual([0.1, 0.4]);
  });

  test("the evaluator's view leaves the open minute out", () => {
    const h = new MachineHistory();
    h.record("desk", sample(0.5, 0.5), T0);
    h.record("desk", sample(0.9, 0.5), T0 + MINUTE_MS + 1);
    expect(h.minutes("desk", T0, T0 + MINUTE_MS + 2)).toEqual([{ t: T0, cpu: 0.5, mem: 0.5 }]);
  });
});

describe("the 24 h prune", () => {
  test("a bucket older than a day is gone from the next read", () => {
    const h = new MachineHistory();
    h.record("desk", sample(0.1, 0.1), T0);
    h.record("desk", sample(0.2, 0.2), T0 + MINUTE_MS);
    expect(h.points("desk", T0 + DAY_MS).map((p) => p[0])).toEqual([T0 + MINUTE_MS]);
    expect(h.points("desk", T0 + DAY_MS + MINUTE_MS)).toEqual([]);
  });

  test("never more than 1440 points, however long the clock runs", () => {
    const h = new MachineHistory();
    for (let i = 0; i < HISTORY_MINUTES + 30; i++) h.record("desk", sample(0.1, 0.1), T0 + i * MINUTE_MS);
    const now = T0 + (HISTORY_MINUTES + 29) * MINUTE_MS;
    expect(h.points("desk", now).length).toBeLessThanOrEqual(HISTORY_MINUTES);
  });

  test("a machine that left takes its history with it", () => {
    const h = new MachineHistory();
    h.record("desk", sample(0.1, 0.1), T0);
    h.record("laptop", sample(0.1, 0.1), T0);
    h.drop("laptop");
    h.record("nas", sample(0.1, 0.1), T0);
    h.retain(new Set(["desk"]));
    expect(h.points("laptop", T0)).toEqual([]);
    expect(h.points("nas", T0)).toEqual([]);
    expect(h.points("desk", T0).length).toBe(1);
  });
});

describe("the persisted round trip", () => {
  test("save then load gives the same points, and a day-old bucket does not come back", async () => {
    const dir = await tempDir();
    const h = new MachineHistory();
    h.record("desk", sample(0.25, 0.5, { rx: 1000, tx: 50 }), T0 + 10);
    h.record("desk", sample(0.75, 0.5, { rx: 3000, tx: 150 }), T0 + 20);
    h.record("laptop", sample(0.1, 0.9), T0 + MINUTE_MS);
    await saveMachineHistory(dir, h, T0 + 2 * MINUTE_MS);

    const back = await loadMachineHistory(dir, T0 + 2 * MINUTE_MS);
    expect(back.points("desk", T0 + 2 * MINUTE_MS)).toEqual(h.points("desk", T0 + 2 * MINUTE_MS));
    expect(back.points("laptop", T0 + 2 * MINUTE_MS)).toEqual(h.points("laptop", T0 + 2 * MINUTE_MS));
    // A freshly loaded store has nothing new to write.
    expect(back.dirty()).toBe(false);

    const later = await loadMachineHistory(dir, T0 + DAY_MS + 30 * 1000);
    expect(later.points("desk", T0 + DAY_MS + 30 * 1000)).toEqual([]);
    expect(later.points("laptop", T0 + DAY_MS + 30 * 1000).length).toBe(1);
  });

  test("a bucket in the future is not loaded back: one minute of slack, no more", async () => {
    const dir = await tempDir();
    const h = new MachineHistory();
    h.record("desk", sample(0.1, 0.5), T0);
    h.record("desk", sample(0.2, 0.5), T0 + MINUTE_MS);
    h.record("desk", sample(0.3, 0.5), T0 + 2 * MINUTE_MS);
    h.record("laptop", sample(0.3, 0.5), T0 + 3 * 60 * MINUTE_MS);
    await saveMachineHistory(dir, h, T0 + 3 * 60 * MINUTE_MS);

    // The machine boots with its clock back at T0.
    const back = await loadMachineHistory(dir, T0 + 10);
    expect(back.points("desk", T0 + 10).map((p) => p[0])).toEqual([T0, T0 + MINUTE_MS]);
    expect(back.points("laptop", T0 + 10)).toEqual([]);
  });

  test("a missing or unreadable file is an empty store; a bad row is dropped, the rest loads", async () => {
    const dir = await tempDir();
    expect((await loadMachineHistory(dir, T0)).points("desk", T0)).toEqual([]);
    await writeFile(join(dir, MACHINE_HISTORY_FILE), "{not json");
    expect((await loadMachineHistory(dir, T0)).points("desk", T0)).toEqual([]);
    await writeFile(
      join(dir, MACHINE_HISTORY_FILE),
      JSON.stringify({
        version: 1,
        machines: {
          desk: [[T0, 2, 1, 0.6, 1, 0, 0, 0, 0], [T0 + MINUTE_MS, 0, 1, 1, 1, 0, 0, 0, 0], ["x"], [T0, 1, 1]],
          laptop: "nope",
        },
      }),
    );
    const h = await loadMachineHistory(dir, T0 + MINUTE_MS);
    expect(h.points("desk", T0 + MINUTE_MS)).toEqual([[T0, 0.5, 0.6, 0.5, null, null]]);
    expect(h.points("laptop", T0 + MINUTE_MS)).toEqual([]);
  });

  // Windows: the bridge gives the state dir an owner-only access list at start (M43 spec 04), and the
  // file the store writes inherits it. NTFS has no 0600, so the check reads that list instead.
  test("the file is written atomically and owner-only", async () => {
    const dir = await tempDir();
    if (process.platform === "win32") ensureOwnerOnlyDir(dir, HOST, { root: privateRoot("state"), repair: true });
    const h = new MachineHistory();
    h.record("desk", sample(0.5, 0.5), T0);
    await saveMachineHistory(dir, h, T0);
    // No temp file is left behind by the rename.
    await expect(stat(join(dir, `${MACHINE_HISTORY_FILE}.tmp`))).rejects.toThrow();
    expect(JSON.parse(await readFile(join(dir, MACHINE_HISTORY_FILE), "utf8")).version).toBe(1);
    if (process.platform === "win32") {
      expect(isOwnerOnly(join(dir, MACHINE_HISTORY_FILE), HOST)).toEqual({ state: "private" });
      return;
    }
    expect((await stat(join(dir, MACHINE_HISTORY_FILE))).mode & 0o777).toBe(0o600);
  });
});
