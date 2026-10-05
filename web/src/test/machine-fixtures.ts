// The Machines pages' fixtures, shared by the unit suite (src/test/handlers.ts), the browser tier's API
// stub (e2e/fixtures/api.ts) and the states playground, so the three never describe a machine two ways.
//
// `ts` is the answering bridge's clock and every `sampledAt` and history time is stamped on it. It is
// a fixed number, never `Date.now()`: the pages age everything against it, and a test must not depend
// on when it runs.

import type { MachineHistoryResponse, MachineRow, MachineSpark, MachinesResponse } from "@/lib/types";

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

/** The lead's clock for every fixture below. */
export const FIXTURE_MACHINES_TS = 5_000_000_000;

/** Four machines: a busy lead, a peer whose CPU alert is firing, one that went quiet, and an older one. */
export const fixtureMachineRows: MachineRow[] = [
  {
    id: "bluefin",
    name: "bluefin",
    isLead: true,
    health: "reachable",
    sample: { cpu: 0.34, cores: 8, memUsed: 7.4 * GIB, memTotal: 16 * GIB, load1: 1.42, rxBps: 1.2 * MIB, txBps: 340 * KIB },
    sampledAt: FIXTURE_MACHINES_TS - 4_000,
    alerts: { cpu: { above: 0.9, forMin: 10 } },
    firing: [],
  },
  {
    id: "workshop",
    name: "workshop",
    isLead: false,
    health: "reachable",
    sample: { cpu: 0.96, cores: 4, memUsed: 3.1 * GIB, memTotal: 8 * GIB, load1: 4.8, rxBps: 12 * KIB, txBps: 3 * KIB },
    sampledAt: FIXTURE_MACHINES_TS - 6_000,
    alerts: { cpu: { above: 0.9, forMin: 10 }, mem: { above: 0.95, forMin: 30 } },
    firing: ["cpu"],
  },
  {
    id: "attic",
    name: "attic",
    isLead: false,
    health: "unreachable",
    sample: { cpu: 0.12, cores: 2, memUsed: 1.1 * GIB, memTotal: 4 * GIB },
    sampledAt: FIXTURE_MACHINES_TS - 25 * 60_000,
    alerts: {},
    firing: [],
  },
  {
    // An older member: reachable, but it sends no load yet. `sample` and `sampledAt` are absent.
    id: "pantry",
    name: "pantry",
    isLead: false,
    health: "reachable",
    alerts: {},
    firing: [],
  },
];

/** A lead with a crew: all four rows. */
export const fixtureMachines: MachinesResponse = { ts: FIXTURE_MACHINES_TS, machines: fixtureMachineRows };

/** The default world is solo: one row, the lead, and `isLead` true. */
export const fixtureMachinesSolo: MachinesResponse = {
  ts: FIXTURE_MACHINES_TS,
  machines: [{ ...fixtureMachineRows[0]!, name: "this-machine", id: "local" }],
};

/**
 * A day of history, one point per minute, oldest first. Deterministic: a slow wave for the average, a
 * spike every hour for the maximum, memory climbing and falling, a network that breathes.
 *
 * Two kinds of hole, because the charts must draw both as gaps: a missing stretch of minutes (a lead that
 * restarted, `gapFrom`..`gapTo` minutes ago, so the last hour is whole) and a stretch with no network
 * counters (`null`), one hour ago.
 */
export function fixtureMachineHistory(
  options: { ts?: number; minutes?: number; cpuLevel?: number; network?: boolean } = {},
): MachineHistoryResponse {
  const ts = options.ts ?? FIXTURE_MACHINES_TS;
  const minutes = options.minutes ?? 1440;
  const level = options.cpuLevel ?? 0.3;
  const network = options.network ?? true;
  const points: MachineHistoryResponse["points"] = [];
  for (let ago = minutes - 1; ago >= 0; ago -= 1) {
    if (ago >= 300 && ago < 330) continue; // the restart: thirty minutes with no points at all
    const wave = (Math.sin(ago / 23) + 1) / 2;
    const avg = Math.min(0.97, Math.max(0.02, level * (0.5 + wave)));
    const max = Math.min(1, avg + 0.08 + (ago % 60 === 0 ? 0.3 : 0.04 * wave));
    const mem = 0.35 + 0.2 * ((Math.sin(ago / 90) + 1) / 2);
    const noCounters = !network || (ago >= 60 && ago < 70);
    const rx = noCounters ? null : Math.round(200 * KIB * (0.2 + wave) + (ago % 7) * 10 * KIB);
    const tx = noCounters ? null : Math.round(60 * KIB * (0.3 + wave));
    points.push([ts - ago * 60_000, avg, max, mem, rx, tx]);
  }
  return { ts, stepMs: 60_000, points };
}

/**
 * A row's last `minutes` complete minutes, the way `?spark=N` answers: oldest first, two places, the
 * newest the minute before `ts`. It climbs toward the row's reading now, so the spark's right end
 * meets the number above it. A row with no reading gets none; a machine that went quiet gets the
 * minutes before it went quiet, then `null` for every minute since, as the lead records it.
 */
export function fixtureSpark(row: MachineRow, ts: number = FIXTURE_MACHINES_TS, minutes = 30): MachineSpark | undefined {
  const sample = row.sample;
  if (sample === undefined) return undefined;
  const mem = sample.memTotal > 0 ? sample.memUsed / sample.memTotal : 0;
  const quietFor = row.health === "reachable" ? 0 : Math.ceil((ts - (row.sampledAt ?? ts)) / 60_000);
  const cpu: (number | null)[] = [];
  const memory: (number | null)[] = [];
  for (let ago = minutes; ago >= 1; ago -= 1) {
    if (ago < quietFor) {
      cpu.push(null);
      memory.push(null);
      continue;
    }
    const wave = Math.sin(ago / 3) * 0.06 + Math.sin(ago / 7) * 0.05;
    const climb = (minutes - ago) / minutes;
    cpu.push(round2(Math.min(1, Math.max(0.01, sample.cpu * (0.55 + 0.45 * climb) + wave))));
    memory.push(round2(Math.min(1, Math.max(0.01, mem - 0.03 * (ago / minutes) + wave / 6))));
  }
  return { stepMs: 60_000, cpu, mem: memory };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A census with each row's spark, the answer to `GET /api/machines?spark=N`. */
export function withSpark(census: MachinesResponse, minutes = 30): MachinesResponse {
  return {
    ...census,
    machines: census.machines.map((row) => {
      const spark = fixtureSpark(row, census.ts, minutes);
      return spark === undefined ? row : { ...row, spark };
    }),
  };
}

/** The census for one read: with sparks when the URL asks for them (`?spark=N`), as the bridge does. */
export function censusFor(census: MachinesResponse, url: URL): MachinesResponse {
  const spark = Number(url.searchParams.get("spark"));
  return Number.isInteger(spark) && spark >= 1 && spark <= 60 ? withSpark(census, spark) : census;
}

/** The history for one read: only the minutes at or after `?since=` when the URL names one, as the bridge does. */
export function historyFor(url: URL): MachineHistoryResponse {
  const day = fixtureMachineHistory();
  const since = Number(url.searchParams.get("since") ?? Number.NaN);
  return Number.isSafeInteger(since) ? { ...day, points: day.points.filter((p) => p[0] >= since) } : day;
}
