import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Break } from "./r5";
import { CEILINGS_PATH, readCeilings, tally, WAIVERS, type Ceilings } from "./waivers";

// THE CEILINGS OF R5, written from a run. `THEMES_OUT=<dir>` makes each case of `e2e/themes.spec.ts` write its
// measurements; this reads them, puts every break under its waiver (`waivers.ts`) and writes `ceilings.json`.
//
//     cd web && bun e2e/themes/ceilings.ts <out-dir> [--raise]
//
// A count only goes down: a case that breaks a waiver more often than its ceiling says is a new defect, and the script
// stops and names it unless `--raise` says the raise is on purpose. A break no waiver names stops it too: give it a
// cause in `waivers.ts` first. It prints the count per waiver, which is the table of the findings.

const [dirArg, ...flags] = process.argv.slice(2);
if (dirArg === undefined) {
  console.error("usage: bun e2e/themes/ceilings.ts <out-dir> [--raise]");
  process.exit(2);
}
const raise = flags.includes("--raise");
const dir = resolve(dirArg);
const before = readCeilings();
const after: Ceilings = {};
const raised: string[] = [];
const loose: string[] = [];
let cases = 0;

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).toSorted()) {
  // SAFETY: every JSON file in an out-dir is one case's record, written by e2e/themes.spec.ts in this shape.
  const run = JSON.parse(readFileSync(join(dir, file), "utf8")) as { key: string; look: string; breaks: Break[] };
  cases += 1;
  const { counts, loose: unnamed } = tally(run.breaks, run.look);
  for (const b of unnamed) loose.push(`${run.key} ${b.rule} ${b.el}: ${b.ink} on ${b.ground} = ${String(b.value)}`);
  for (const [id, list] of counts) {
    const was = before[id]?.[run.key] ?? 0;
    if (list.length > was && Object.keys(before).length > 0) raised.push(`${run.key} "${id}": ${String(was)} -> ${String(list.length)}`);
    (after[id] ??= {})[run.key] = list.length;
  }
}

if (loose.length > 0) {
  console.error(`${String(loose.length)} breaks have no waiver; give each a cause in e2e/themes/waivers.ts:`);
  for (const l of loose.slice(0, 40)) console.error(`  ${l}`);
  process.exit(1);
}
if (raised.length > 0 && !raise) {
  console.error("These counts would go UP. A ceiling only goes down; pass --raise if this is on purpose:");
  for (const r of raised) console.error(`  ${r}`);
  process.exit(1);
}

const sorted: Ceilings = {};
for (const w of WAIVERS) {
  const entries = Object.entries(after[w.id] ?? {}).toSorted(([a], [b]) => a.localeCompare(b));
  if (entries.length > 0) sorted[w.id] = Object.fromEntries(entries);
}
writeFileSync(CEILINGS_PATH, `${JSON.stringify(sorted, null, 1)}\n`);
console.log(`${String(cases)} cases read, ceilings written to ${CEILINGS_PATH}`);
for (const w of WAIVERS) {
  const counts = Object.values(sorted[w.id] ?? {});
  console.log(`${w.id}: ${String(counts.reduce((a, b) => a + b, 0))} breaks in ${String(counts.length)} cases`);
}
