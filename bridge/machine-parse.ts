// Every untrusted value the machines feature reads, in one file (ADR 0084).
//
// Four readers, and each is the parse at its boundary: a member's `machineStats` sibling off the crew
// link, the body of `POST /api/machines/:id/alerts`, and the two state files, `machine-history.json`
// and `machine-alerts.json`. They live together for the reason `stt/json.ts` is one file: every
// `typeof` the feature needs sits in here, so the lint override names this file and no feature module.
//
// Each reader returns a value the rest of the feature can trust, or `null` (or an empty map for a
// state file). A state file that does not parse is read as empty: history is a cache of the last day,
// and an unreadable rule file means no rule, which is the closed reading (it pushes nothing).

import type { JsonObject, JsonValue } from "./json.ts";
import type { LoadedMinute } from "./machine-history.ts";
import { MAX_DISKS } from "./machine-disks.ts";
import { CREW_MACHINE_FIELD, isMachineSample } from "./machine-stats.ts";
import type { AlertMetric, AlertRule, MachineAlerts, MachineDisk, MachineSample } from "./types.ts";

/** The bounds of a rule, as the phone offers them and the bridge accepts them. */
export const ALERT_ABOVE_MIN = 0.5;
export const ALERT_ABOVE_MAX = 0.99;
export const ALERT_FOR_MIN_MIN = 5;
export const ALERT_FOR_MIN_MAX = 120;

const METRICS: readonly AlertMetric[] = ["cpu", "mem", "disk"];

function recordOf(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function numberOf(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read a member's `machineStats` off the answer its snapshot rode on (CREW_PROTOCOL.md §5, §7.1).
 *
 * `null` for every shape this build cannot trust: absent (a member older than the field), not an
 * object, a key of the wrong type, or any number that is not finite or not in range. `null` means
 * **not reported**, never zero. The whole sample is dropped rather than repaired: a reading with one
 * impossible number has told us its sender is broken, and the other numbers came from the same place.
 * Unknown keys are ignored, so a later build may add one without this build refusing it (§7.1).
 */
export function parsePeerMachineStats(value: JsonValue): MachineSample | null {
  const field = recordOf(recordOf(value)?.[CREW_MACHINE_FIELD]);
  if (field === null) return null;
  const cpu = numberOf(field.cpu);
  const cores = numberOf(field.cores);
  const memUsed = numberOf(field.memUsed);
  const memTotal = numberOf(field.memTotal);
  if (cpu === null || cores === null || memUsed === null || memTotal === null) return null;
  const sample: MachineSample = { cpu, cores, memUsed, memTotal };
  for (const key of ["load1", "rxBps", "txBps"] as const) {
    if (field[key] === undefined) continue;
    const n = numberOf(field[key]);
    if (n === null) return null;
    sample[key] = n;
  }
  if (field.disks !== undefined) {
    const disks = disksOf(field.disks);
    if (disks === null) return null;
    // An empty list says what an absent one says: nothing to report.
    if (disks.length > 0) sample.disks = disks;
  }
  return isMachineSample(sample) ? sample : null;
}

/**
 * A member's `disks`: an array of `{ mount, used, total }`. `null` (the whole sample drops) for any
 * entry that is not that shape; the ranges are `isMachineSample`'s. A later build that sends more
 * than {@link MAX_DISKS} is cut to the first ones rather than refused.
 */
function disksOf(value: JsonValue): MachineDisk[] | null {
  if (!Array.isArray(value)) return null;
  const out: MachineDisk[] = [];
  for (const entry of value.slice(0, MAX_DISKS)) {
    const rec = recordOf(entry);
    const used = numberOf(rec?.used);
    const total = numberOf(rec?.total);
    const mount = rec?.mount;
    if (rec === null || typeof mount !== "string" || used === null || total === null) return null;
    out.push({ mount, used, total });
  }
  return out;
}

/** One rule, or `null` when it is outside the bounds the phone offers. */
function ruleOf(value: JsonValue | undefined): AlertRule | null {
  const rec = recordOf(value);
  if (rec === null) return null;
  const above = numberOf(rec.above);
  const forMin = numberOf(rec.forMin);
  if (above === null || above < ALERT_ABOVE_MIN || above > ALERT_ABOVE_MAX) return null;
  if (forMin === null || !Number.isInteger(forMin) || forMin < ALERT_FOR_MIN_MIN || forMin > ALERT_FOR_MIN_MAX) {
    return null;
  }
  return { above, forMin };
}

/**
 * The body of `POST /api/machines/:id/alerts`: the WHOLE rule set for one machine.
 *
 * A missing key removes that rule. A present key must be a rule inside the bounds, or the whole body
 * is refused (`null`, a 400): a half-applied write would leave the phone showing a rule the bridge
 * did not take. Unknown keys are ignored, the way `parseNotifyPrefsPatch` ignores them.
 */
export function parseMachineAlerts(value: JsonValue | undefined): MachineAlerts | null {
  const rec = recordOf(value);
  if (rec === null) return null;
  const out: MachineAlerts = {};
  for (const metric of METRICS) {
    if (rec[metric] === undefined) continue;
    const rule = ruleOf(rec[metric]);
    if (rule === null) return null;
    out[metric] = rule;
  }
  return out;
}

/**
 * `machine-history.json` as minutes per machine, oldest first. Two versions load: version 2, the
 * compact rows `machine-history.ts` writes, and version 1, the nine sums per minute the first 1.17.0
 * builds wrote. A row that is not the right count of finite numbers is dropped; the rest of the file
 * still loads.
 */
export function coerceHistoryFile(raw: JsonValue | undefined, maxMinutes: number): Map<string, LoadedMinute[]> {
  const out = new Map<string, LoadedMinute[]>();
  const file = recordOf(raw);
  const machines = recordOf(file?.machines);
  if (machines === null) return out;
  const version = numberOf(file?.version);
  for (const [id, entry] of Object.entries(machines)) {
    const minutes = version === 2 ? minutesOfV2(entry) : minutesOfV1(entry);
    if (minutes.length > 0) out.set(id, minutes.toSorted((a, b) => a.t - b.t).slice(-maxMinutes));
  }
  return out;
}

/** A fraction off disk, or `null` when it is not one. */
function fractionOf(value: JsonValue | undefined): number | null {
  const n = numberOf(value);
  return n !== null && n >= 0 && n <= 1 ? n : null;
}

/** A rate off disk: a non-negative number, or `null` for "no reading" (and for anything else). */
function rateOf(value: JsonValue | undefined): number | null {
  const n = numberOf(value);
  return n !== null && n >= 0 ? n : null;
}

/**
 * Version 2: `{ t, n, rows: [[gap, cpu, cpuMax, mem, rx | null, tx | null, disk?], ...] }`. The
 * seventh value is the fullest disk's fraction, absent on a minute with none and in every file
 * written before it.
 */
function minutesOfV2(entry: JsonValue | undefined): LoadedMinute[] {
  const rec = recordOf(entry);
  const start = numberOf(rec?.t);
  const lastN = numberOf(rec?.n);
  const rows = rec?.rows;
  if (rec === null || start === null || !Array.isArray(rows)) return [];
  const out: LoadedMinute[] = [];
  let t = start;
  rows.forEach((row, index) => {
    if (!Array.isArray(row) || (row.length !== 6 && row.length !== 7)) return;
    const gap = numberOf(row[0]);
    if (gap === null || !Number.isInteger(gap) || gap < 0) return;
    t += gap * 60_000;
    const cpu = fractionOf(row[1]);
    const cpuMax = fractionOf(row[2]);
    const mem = fractionOf(row[3]);
    if (cpu === null || cpuMax === null || mem === null) return;
    const n = index === rows.length - 1 && lastN !== null && Number.isInteger(lastN) && lastN > 0 ? lastN : 1;
    out.push({ t, n, cpu, cpuMax, mem, rx: rateOf(row[4]), tx: rateOf(row[5]), disk: fractionOf(row[6]) });
  });
  return out;
}

/** Version 1: one row per minute, `[t, n, cpuSum, cpuMax, memSum, rxSum, rxN, txSum, txN]`. */
function minutesOfV1(entry: JsonValue | undefined): LoadedMinute[] {
  if (!Array.isArray(entry)) return [];
  const out: LoadedMinute[] = [];
  for (const row of entry) {
    if (!Array.isArray(row) || row.length !== 9) continue;
    const [t, n, cpuSum, cpuMax, memSum, rxSum, rxN, txSum, txN] = row.map((v) => numberOf(v));
    if (t == null || n == null || cpuSum == null || cpuMax == null || memSum == null) continue;
    if (rxSum == null || rxN == null || txSum == null || txN == null) continue;
    if (!Number.isInteger(n) || n <= 0) continue;
    out.push({
      t,
      n,
      cpu: cpuSum / n,
      cpuMax,
      mem: memSum / n,
      rx: rxN > 0 ? rxSum / rxN : null,
      tx: txN > 0 ? txSum / txN : null,
      disk: null,
    });
  }
  return out;
}

/** One machine's stored rules and the episodes open for it. */
export interface StoredMachineAlerts {
  readonly rules: MachineAlerts;
  readonly open: readonly AlertMetric[];
}

/**
 * `machine-alerts.json`. A rule outside the bounds is dropped on its own; an open episode for a metric
 * that has no rule is dropped too, because nothing could ever close it.
 */
export function coerceAlertsFile(raw: JsonValue | undefined): Map<string, StoredMachineAlerts> {
  const out = new Map<string, StoredMachineAlerts>();
  const machines = recordOf(recordOf(raw)?.machines);
  if (machines === null) return out;
  for (const [id, entry] of Object.entries(machines)) {
    const rec = recordOf(entry);
    const rulesRec = recordOf(rec?.rules);
    if (rec === null || rulesRec === null) continue;
    const rules: MachineAlerts = {};
    for (const metric of METRICS) {
      const rule = ruleOf(rulesRec[metric]);
      if (rule !== null) rules[metric] = rule;
    }
    const openRaw = Array.isArray(rec.open) ? rec.open : [];
    const open = METRICS.filter((m) => openRaw.includes(m) && rules[m] !== undefined);
    if (METRICS.some((m) => rules[m] !== undefined)) out.set(id, { rules, open });
  }
  return out;
}
