// `bun run e2e:recordings:check` (in web/): the check of the browser leg's cassettes (M67, ADR 0125). It
// reads every file under web/e2e/rig/cassettes/ and fails when one holds a key, a bearer token, an
// Authorization or x-api-key header, a path into a home folder (cassette.ts FORBIDDEN), the owner's
// host names or company names (HOSTS), when a .jsonl is over 1 MiB, when a .jsonl does not parse, or
// when a meta.json lists a case under `failed`: a merged tree holds no recording from a case that did not
// pass. `checkFile` is the pure core over (path, text); the vitest in cassettes-check.test.ts runs it
// over the committed tree on every CI test run. It prints the file and line of each finding, never the
// matched text. Exit 0: clean. Exit 1: a finding. Run it before a commit that adds cassettes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { forbiddenIn, parseCassette, type CassetteMeta } from "./cassette";
import { CASSETTE_ROOT } from "./tier";

function files(dir: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** The biggest a cassette file may be: 1 MiB. The longest legitimate turn so far (omp, 160 queued items) is about 370 KB per stream. */
export const MAX_CASSETTE_BYTES = 1024 * 1024;

/** What must not appear in any cassette beyond cassette.ts FORBIDDEN: the owner's machines and companies. */
export const HOSTS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: "the host name bluefin", re: /bluefin/iu },
  { name: "the host name minibuch", re: /minibuch/iu },
  { name: "the name sprqvntrs", re: /sprqvntrs/iu },
  { name: "the name sportsight", re: /sportsight/iu },
];

/**
 * Every finding of one file, as `<path>: <finding>` lines. Pure: the path is only a label and the
 * extension decides what is read (`.jsonl` as a cassette, `meta.json` as the index of a version).
 * The recorder's placeholders (`{{lab}}`, `{{home}}`, `{{walky:0}}`) never match a rule.
 */
export function checkFile(path: string, text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (finding: string): void => {
    if (seen.has(finding)) return;
    seen.add(finding);
    out.push(`${path}: ${finding}`);
  };
  for (const finding of forbiddenIn(text)) add(finding);
  text.split("\n").forEach((line, i) => {
    for (const { name, re } of HOSTS) if (re.test(line)) add(`line ${String(i + 1)}: ${name}`);
  });
  if (path.endsWith(".jsonl")) {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_CASSETTE_BYTES) add(`${String(Math.ceil(bytes / 1024))} KiB is over the ${String(MAX_CASSETTE_BYTES / 1024)} KiB limit`);
    try {
      parseCassette(text);
    } catch (err) {
      add(`does not parse (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (path.endsWith("meta.json")) {
    try {
      // SAFETY: a meta.json is the stub's own output; a hand-edited one that breaks the shape is a finding below.
      const meta = JSON.parse(text) as CassetteMeta;
      for (const [leg, legMeta] of Object.entries(meta.legs)) for (const c of legMeta.failed ?? []) add(`leg ${leg}: ${c} is marked failed (re-record it alone, a merged tree holds none)`);
    } catch (err) {
      add(`does not parse (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return out;
}

/** Every finding under a root, as `<file>: <finding>` lines. */
export function checkCassettes(root: string): string[] {
  return files(root).flatMap((file) => checkFile(relative(root, file), readFileSync(file, "utf8")));
}

if (import.meta.main) {
  const root = process.argv[2] ?? CASSETTE_ROOT;
  const findings = checkCassettes(root);
  const count = files(root).length;
  if (findings.length > 0) {
    for (const line of findings) console.error(line);
    console.error(`cassette check: ${String(findings.length)} finding(s) in ${root}`);
    process.exit(1);
  }
  console.log(`cassette check: ${String(count)} file(s) clean in ${root}`);
}
