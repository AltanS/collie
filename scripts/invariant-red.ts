// The red list of the invariant suites (M102 spec 15, decision 2): every test that is red on the base,
// kept in its suite as an expected failure and named in web/src/test/invariants/known-red.ts with the
// spec that fixes it. This prints the count per spec and each entry with the files that carry its tag.
//
//     bun scripts/invariant-red.ts          # the list, exit 0
//     bun scripts/invariant-red.ts --gate   # exit 1 while any entry is left: the release gate
//
// It also fails (exit 2) when an entry is named by no test. A test cannot name an id the list lacks:
// `knownRed` takes only known ids, so the typecheck refuses it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { countBySpec, KNOWN_RED, knownRed, type KnownRedId } from "../web/src/test/invariants/known-red.ts";

const ROOT = resolve(import.meta.dir, "..");
const DIRS = ["bridge", "web/src"];
function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...testFiles(path));
    else if (/\.test\.tsx?$/u.test(name)) out.push(path);
  }
  return out;
}

/** The known ids a test file names: an id counts where the source holds it as a quoted string. */
export function tagsIn(source: string): KnownRedId[] {
  // SAFETY: the keys of KNOWN_RED are exactly the KnownRedId union.
  return (Object.keys(KNOWN_RED) as KnownRedId[]).filter((id) => source.includes(`"${id}"`));
}

const where = new Map<string, string[]>();
for (const dir of DIRS) {
  for (const file of testFiles(join(ROOT, dir))) {
    for (const id of tagsIn(readFileSync(file, "utf8"))) {
      const list = where.get(id) ?? [];
      list.push(relative(ROOT, file));
      where.set(id, list);
    }
  }
}

// SAFETY: the keys of KNOWN_RED are exactly the KnownRedId union.
const known = Object.keys(KNOWN_RED) as KnownRedId[];
const unused = known.filter((id) => !where.has(id));

console.log("Invariant tests red on the base, per fixing spec:");
for (const [spec, count] of Object.entries(countBySpec())) console.log(`  ${spec.padEnd(8)} ${String(count)}`);
console.log(`  total    ${String(known.length)}`);
console.log("");
for (const id of known) {
  const entry = knownRed(id);
  console.log(`${entry.fixedBy}  ${entry.invariant}  ${id}`);
  console.log(`    ${entry.what}`);
  console.log(`    at ${entry.where}`);
  console.log(`    tagged in ${(where.get(id) ?? ["NO TEST"]).join(", ")}`);
}

if (unused.length > 0) {
  console.error(`entries no test names: ${unused.join(", ")}`);
  process.exit(2);
}
if (process.argv.includes("--gate") && known.length > 0) {
  console.error(`release gate: ${String(known.length)} invariant tests are still red. No tag while any is.`);
  process.exit(1);
}
