// `bun run e2e:recordings:check` (in web/): the redaction check of the browser leg's cassettes (M67,
// ADR 0125). It reads every file under web/e2e/rig/cassettes/ and fails when one holds a key, a bearer
// token, an Authorization or x-api-key header, or a path into a home folder (cassette.ts FORBIDDEN),
// or when a cassette file does not parse. It prints the file and line of each finding, never the
// matched text. Exit 0: clean. Exit 1: a finding. Run it before a commit that adds cassettes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { forbiddenIn, parseCassette } from "./cassette";
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

/** Every finding under a root, as `<file>: <finding>` lines. */
export function checkCassettes(root: string): string[] {
  const out: string[] = [];
  for (const file of files(root)) {
    const text = readFileSync(file, "utf8");
    const name = relative(root, file);
    for (const finding of forbiddenIn(text)) out.push(`${name}: ${finding}`);
    if (file.endsWith(".jsonl")) {
      try {
        parseCassette(text);
      } catch (err) {
        out.push(`${name}: does not parse (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }
  return out;
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
