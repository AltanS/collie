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
    expect(h.points("desk", T0 + 60_000)).toEqual([[T0, 0.4, 0.6, 0.6, 200, 20, null]]);
  });

  test("a minute with no network reading says null, and a missing minute is simply missing", () => {
    const h = new MachineHistory();
    h.record("desk", sample(0.1, 0.2), T0);
    h.record("desk", sample(0.3, 0.4), T0 + 2 * MINUTE_MS);
    expect(h.points("desk", T0 + 3 * MINUTE_MS)).toEqual([
      [T0, 0.1, 0.1, 0.2, null, null, null],
      [T0 + 2 * MINUTE_MS, 0.3, 0.3, 0.4, null, null, null],
    ]);
  });

  test("machines are kept apart, and an unknown one has no points", () => {
    const h = new MachineHistory();
    h.record("desk", sample(0.1, 0.2), T0);
    h.record("laptop", sample(0.9, 0.8), T0);
    expect(h.points("laptop", T0)).toEqual([[T0, 0.9, 0.9, 0.8, null, null, null]]);
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
    expect(h.minutes("desk", T0, T0 + MINUTE_MS + 2)).toEqual([{ t: T0, cpu: 0.5, mem: 0.5, disk: null }]);
  });
});

describe("the fullest disk", () => {
  const disks = (...fracs: number[]) => fracs.map((f, i) => ({ mount: `/d${i}`, used: f * 1000, total: 1000 }));

  test("a minute keeps the fullest disk's average fraction as its seventh value", () => {
    const h = new MachineHistory();
    h.record("desk", { ...sample(0.1, 0.5), disks: disks(0.2, 0.6) }, T0 + 1_000);
    h.record("desk", { ...sample(0.1, 0.5), disks: disks(0.8, 0.3) }, T0 + 30_000);
    h.record("desk", sample(0.1, 0.5), T0 + 50_000);
    expect(h.points("desk", T0 + MINUTE_MS)).toEqual([[T0, 0.1, 0.1, 0.5, null, null, 0.7]]);
    expect(h.minutes("desk", T0, T0 + MINUTE_MS)[0]!.disk).toBeCloseTo(0.7, 10);
  });

  test("the file carries the disk value only on the minutes that have one, and it loads back", async () => {
    const dir = await tempDir();
    const h = new MachineHistory();
    h.record("desk", sample(0.1, 0.5), T0);
    h.record("desk", { ...sample(0.1, 0.5), disks: disks(0.6584) }, T0 + MINUTE_MS);
    expect(h.toFile(T0 + MINUTE_MS + 1).machines.desk!.rows).toEqual([
      [0, 0.1, 0.1, 0.5, null, null],
      [1, 0.1, 0.1, 0.5, null, null, 0.658],
    ]);
    await saveMachineHistory(dir, h, T0 + MINUTE_MS + 1);
    const back = await loadMachineHistory(dir, T0 + MINUTE_MS + 1);
    expect(back.points("desk", T0 + 2 * MINUTE_MS).map((p) => p[6])).toEqual([null, 0.658]);
  });

  test("a version 2 file written before the disk value loads with null", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, MACHINE_HISTORY_FILE),
      JSON.stringify({ version: 2, machines: { desk: { t: T0, n: 1, rows: [[0, 0.1, 0.2, 0.3, 5, 6]] } } }),
    );
    const h = await loadMachineHistory(dir, T0 + MINUTE_MS);
    expect(h.points("desk", T0 + MINUTE_MS)).toEqual([[T0, 0.1, 0.2, 0.3, 5, 6, null]]);
  });
});

describe("since and spark", () => {
  test("since keeps the minutes starting at or after it", () => {
    const h = new MachineHistory();
    for (let m = 0; m < 5; m++) h.record("desk", sample(0.1 * (m + 1), 0.5), T0 + m * MINUTE_MS);
    const now = T0 + 5 * MINUTE_MS;
    expect(h.points("desk", now, T0 + 3 * MINUTE_MS).map((p) => p[0])).toEqual([T0 + 3 * MINUTE_MS, T0 + 4 * MINUTE_MS]);
    expect(h.points("desk", now, T0 + 3 * MINUTE_MS + 1).map((p) => p[0])).toEqual([T0 + 4 * MINUTE_MS]);
    expect(h.points("desk", now, now)).toEqual([]);
    expect(h.points("desk", now, 0)).toEqual(h.points("desk", now));
  });

  test("a spark is the complete minutes, two places, null for a hole, and nothing before the first reading", () => {
    const h = new MachineHistory();
    h.record("desk", sample(0.123, 0.5), T0);
    h.record("desk", sample(0.456, 0.25), T0 + 2 * MINUTE_MS);
    // The open minute (T0 + 3) is left out of the spark even though it has a reading.
    h.record("desk", sample(0.9, 0.9), T0 + 3 * MINUTE_MS);
    const now = T0 + 3 * MINUTE_MS + 30_000;
    expect(h.spark("desk", now, 30)).toEqual({ stepMs: 60_000, cpu: [0.12, null, 0.46], mem: [0.5, null, 0.25] });
    // Asked for two minutes, the hole leads the window, so it is cut and one value is left.
    expect(h.spark("desk", now, 2)).toEqual({ stepMs: 60_000, cpu: [0.46], mem: [0.25] });
    expect(h.spark("nas", now, 30)).toBeNull();
    // A machine whose only reading is the open minute has no spark yet.
    const fresh = new MachineHistory();
    fresh.record("desk", sample(0.5, 0.5), T0);
    expect(fresh.spark("desk", T0 + 10_000, 30)).toBeNull();
  });

  test("a spark never holds more than the minutes asked for", () => {
    const h = new MachineHistory();
    for (let m = 0; m < 90; m++) h.record("desk", sample(0.5, 0.5), T0 + m * MINUTE_MS);
    const spark = h.spark("desk", T0 + 90 * MINUTE_MS, 30)!;
    expect(spark.cpu).toHaveLength(30);
    expect(spark.mem.every((v) => v === 0.5)).toBe(true);
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

  test("version 2 is compact: the first minute, a gap per row, three places, and the last row's count", () => {
    const h = new MachineHistory();
    h.record("desk", sample(0.12345, 0.5, { rx: 1000.4, tx: 20 }), T0);
    h.record("desk", sample(0.2, 0.25), T0 + MINUTE_MS);
    h.record("desk", sample(0.4, 0.75), T0 + 4 * MINUTE_MS);
    h.record("desk", sample(0.6, 0.75), T0 + 4 * MINUTE_MS + 30_000);
    expect(h.toFile(T0 + 4 * MINUTE_MS + 31_000)).toEqual({
      version: 2,
      machines: {
        desk: {
          t: T0,
          n: 2,
          rows: [
            [0, 0.123, 0.123, 0.5, 1000, 20],
            [1, 0.2, 0.2, 0.25, null, null],
            [3, 0.5, 0.6, 0.75, null, null],
          ],
        },
      },
    });
  });

  test("a minute saved half full goes on filling after a load, weighted by the samples it already had", async () => {
    const dir = await tempDir();
    const h = new MachineHistory();
    h.record("desk", sample(0.2, 0.5), T0 + 1_000);
    h.record("desk", sample(0.4, 0.5), T0 + 20_000);
    await saveMachineHistory(dir, h, T0 + 21_000);
    const back = await loadMachineHistory(dir, T0 + 21_000);
    back.record("desk", sample(0.9, 0.5), T0 + 40_000);
    // (0.2 + 0.4 + 0.9) / 3, not (0.3 + 0.9) / 2.
    expect(back.points("desk", T0 + 41_000)).toEqual([[T0, 0.5, 0.9, 0.5, null, null, null]]);
  });

  test("version 1, the first builds' nine sums per minute, still loads", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, MACHINE_HISTORY_FILE),
      JSON.stringify({ version: 1, machines: { desk: [[T0, 4, 2, 0.9, 2.4, 800, 4, 80, 2]] } }),
    );
    const h = await loadMachineHistory(dir, T0 + MINUTE_MS);
    expect(h.points("desk", T0 + MINUTE_MS)).toEqual([[T0, 0.5, 0.9, 0.6, 200, 40, null]]);
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
    expect(h.points("desk", T0 + MINUTE_MS)).toEqual([[T0, 0.5, 0.6, 0.5, null, null, null]]);
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
    expect(JSON.parse(await readFile(join(dir, MACHINE_HISTORY_FILE), "utf8")).version).toBe(2);
    if (process.platform === "win32") {
      expect(isOwnerOnly(join(dir, MACHINE_HISTORY_FILE), HOST)).toEqual({ state: "private" });
      return;
    }
    expect((await stat(join(dir, MACHINE_HISTORY_FILE))).mode & 0o777).toBe(0o600);
  });
});
