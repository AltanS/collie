// WHAT THE CENSUS FOUND, read from the one JSON file `web/e2e/hitbox/census.run.ts` writes. The file is
// a build product of a browser run, not hand-edited: run the census again and the section follows.
// The pure helpers here (sort, count, group) are tested in `data.test.ts`; the section only draws.

import census from "../fixtures/hitbox-census.json";

import type { Verdict, VerdictTally } from "./verdict";

/** One tap target as the census recorded it (`CensusRow` in `e2e/hitbox/census.run.ts`). */
export interface Row {
  screen: string;
  group: string;
  size: string;
  name: string;
  selector: string;
  tag: string;
  box: readonly [number, number];
  hit: readonly [number, number] | null;
  hitShare: number;
  gap: number | null;
  gapTo: string | null;
  events: readonly string[];
  shiftPx: number | null;
  verdict: Verdict;
  flags: readonly string[];
  severity: number;
}

export const VERDICTS: readonly Verdict[] = ["ok", "small", "covered", "shifts", "dead-time"];

export const ROWS: readonly Row[] = census.rows.map((r) => ({
  ...r,
  box: [r.box[0] ?? 0, r.box[1] ?? 0] as const,
  hit: r.hit === null ? null : ([r.hit[0] ?? 0, r.hit[1] ?? 0] as const),
  verdict: VERDICTS.find((v) => v === r.verdict) ?? "ok",
}));

export const REACHED: readonly { screen: string; size: string; targets: number }[] = census.reached;

/** How many rows hold each verdict. */
export function countByVerdict(rows: readonly Row[]): VerdictTally {
  const counts: VerdictTally = { ok: 0, small: 0, covered: 0, shifts: 0, "dead-time": 0 };
  for (const r of rows) counts[r.verdict] += 1;
  return counts;
}

/** The worst `n` rows, most severe first. A target on both phone sizes counts once, at its worse reading. */
export function worst(rows: readonly Row[], n: number): Row[] {
  const best = new Map<string, Row>();
  for (const r of rows) {
    const key = `${r.screen}|${r.selector}|${r.name}`;
    const held = best.get(key);
    if (held === undefined || r.severity > held.severity) best.set(key, r);
  }
  return [...best.values()]
    .filter((r) => r.verdict !== "ok")
    .toSorted((a, b) => b.severity - a.severity || a.screen.localeCompare(b.screen) || a.name.localeCompare(b.name))
    .slice(0, n);
}

/** The rows of one size, one verdict (or every one), worst first. */
export function filterRows(rows: readonly Row[], size: string, verdict: Verdict | "all"): Row[] {
  return rows
    .filter((r) => (size === "all" || r.size === size) && (verdict === "all" || r.verdict === verdict))
    .toSorted((a, b) => b.severity - a.severity || a.screen.localeCompare(b.screen) || a.name.localeCompare(b.name));
}

/** Every distinct screen that was walked, in the order the walk met it. */
export function screensWalked(reached: readonly { screen: string }[]): string[] {
  return [...new Set(reached.map((r) => r.screen))];
}
