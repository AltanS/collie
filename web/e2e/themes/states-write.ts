import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Break, Sample } from "./r5";
import { HELD_LOOKS, passingSamples, STATES_PATH, type HeldStates } from "./states";

// Writes `collie-states.json` from a run's THEMES_OUT: the passing state colours of Collie light and Collie dark.
// Run it once, on the day the looks were approved; a later run that rewrites it moves the approval and needs his word.
//
//     cd web && bun e2e/themes/states-write.ts <out-dir>

const dirArg = process.argv[2];
if (dirArg === undefined) {
  console.error("usage: bun e2e/themes/states-write.ts <out-dir>");
  process.exit(2);
}
const dir = resolve(dirArg);
const held: HeldStates = {};
let count = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).toSorted()) {
  // SAFETY: every JSON file in an out-dir is one case's record, written by e2e/themes.spec.ts in this shape.
  const run = JSON.parse(readFileSync(join(dir, file), "utf8")) as { key: string; look: string; breaks: Break[]; samples: Sample[] };
  if (!HELD_LOOKS.has(run.look)) continue;
  const passing = passingSamples(run.samples, run.breaks);
  if (passing.size === 0) continue;
  held[run.key] = Object.fromEntries(passing);
  count += passing.size;
}
writeFileSync(STATES_PATH, `${JSON.stringify(held, null, 1)}\n`);
console.log(`${String(count)} held states in ${String(Object.keys(held).length)} cases, written to ${STATES_PATH}`);
