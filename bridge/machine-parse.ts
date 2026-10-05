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
import type { MinuteBucket } from "./machine-history.ts";
import { CREW_MACHINE_FIELD, isMachineSample } from "./machine-stats.ts";
import type { AlertMetric, AlertRule, MachineAlerts, MachineSample } from "./types.ts";

/** The bounds of a rule, as the phone offers them and the bridge accepts them. */
export const ALERT_ABOVE_MIN = 0.5;
export const ALERT_ABOVE_MAX = 0.99;
export const ALERT_FOR_MIN_MIN = 5;
export const ALERT_FOR_MIN_MAX = 120;

const METRICS: readonly AlertMetric[] = ["cpu", "mem"];

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
  return isMachineSample(sample) ? sample : null;
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
 * `machine-history.json` as minute buckets per machine. A bucket that is not nine finite numbers, or
 * whose count is not a positive integer, is dropped; the rest of the file still loads.
 */
export function coerceHistoryFile(raw: JsonValue | undefined, maxMinutes: number): Map<string, MinuteBucket[]> {
  const out = new Map<string, MinuteBucket[]>();
  const machines = recordOf(recordOf(raw)?.machines);
  if (machines === null) return out;
  for (const [id, rows] of Object.entries(machines)) {
    if (!Array.isArray(rows)) continue;
    const buckets: MinuteBucket[] = [];
    for (const row of rows.slice(-maxMinutes)) {
      const bucket = Array.isArray(row) ? bucketOf(row) : null;
      if (bucket !== null) buckets.push(bucket);
    }
    if (buckets.length > 0) out.set(id, buckets.toSorted((a, b) => a.t - b.t));
  }
  return out;
}

/** One persisted bucket, `[t, n, cpuSum, cpuMax, memSum, rxSum, rxN, txSum, txN]`, or `null`. */
function bucketOf(row: readonly JsonValue[]): MinuteBucket | null {
  if (row.length !== 9) return null;
  const [t, n, cpuSum, cpuMax, memSum, rxSum, rxN, txSum, txN] = row.map((v) => numberOf(v));
  if (t == null || n == null || cpuSum == null || cpuMax == null || memSum == null) return null;
  if (rxSum == null || rxN == null || txSum == null || txN == null) return null;
  if (!Number.isInteger(n) || n <= 0) return null;
  return { t, n, cpuSum, cpuMax, memSum, rxSum, rxN, txSum, txN };
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
    if (rules.cpu !== undefined || rules.mem !== undefined) out.set(id, { rules, open });
  }
  return out;
}
