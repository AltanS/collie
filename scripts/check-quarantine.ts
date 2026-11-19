// The 14-day limit on a quarantined test. A flaky test moves to `<name>.quarantine.test.ts` (see
// `scripts/test-sets.ts`), and the file's first line says since when and why:
//
//     // quarantined: 2026-11-19 flaky on the CI runner, waits on a socket that closes late
//
// A quarantined test that nobody fixes is a test that nobody runs, so the `quarantine` job in `ci.yml`
// runs this script and turns red when a file is older than `QUARANTINE_LIMIT_DAYS`. Fix the test and give
// it its old name back, or delete it. The header itself is pinned by `scripts/check-quarantine.test.ts`,
// which the quick gate runs; the DATE is read only here, never by a test, so no gate fails on a clock.
//
//   bun scripts/check-quarantine.ts            exit 1 on a missing header or an expired file

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const QUARANTINE_LIMIT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const HEADER = /^\/\/ quarantined: (\d{4})-(\d{2})-(\d{2}) (\S.*)$/u;

export interface QuarantineHeader {
  /** The day the file was quarantined, as UTC midnight. */
  since: Date;
  reason: string;
}

/** The header a quarantine file's first line must be, or null when the line is not one (also an impossible date). */
export function parseQuarantineHeader(firstLine: string): QuarantineHeader | null {
  const match = HEADER.exec(firstLine);
  if (match === null) return null;
  const [, year, month, day, reason] = match;
  const since = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const real = since.getUTCFullYear() === Number(year) && since.getUTCMonth() === Number(month) - 1 && since.getUTCDate() === Number(day);
  return real ? { since, reason: reason ?? "" } : null;
}

/** Whole days from the quarantine day to `now`. */
export function daysQuarantined(header: QuarantineHeader, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - header.since.getTime()) / DAY_MS);
}

export interface QuarantineFinding {
  file: string;
  problem: string;
}

/** What is wrong with each quarantine file: no header, or older than the limit. `firstLines` maps path to first line. */
export function quarantineFindings(firstLines: ReadonlyMap<string, string>, now: Date): QuarantineFinding[] {
  const findings: QuarantineFinding[] = [];
  for (const [file, line] of firstLines) {
    const header = parseQuarantineHeader(line);
    if (header === null) {
      findings.push({ file, problem: "the first line is not `// quarantined: YYYY-MM-DD <reason>`" });
      continue;
    }
    const days = daysQuarantined(header, now);
    if (days > QUARANTINE_LIMIT_DAYS) findings.push({ file, problem: `quarantined ${String(days)} days ago, over the ${String(QUARANTINE_LIMIT_DAYS)}-day limit: fix it or delete it` });
  }
  return findings;
}

/** Every `*.quarantine.test.*` file of the tree, tracked or not yet added. */
export function quarantineFiles(root: string): string[] {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.quarantine.test.*"], { cwd: root, encoding: "utf8" });
  return listed.stdout.split("\n").filter((file) => file !== "");
}

export function firstLinesOf(root: string, files: readonly string[]): Map<string, string> {
  return new Map(files.map((file) => [file, (readFileSync(join(root, file), "utf8").split("\n")[0] ?? "").trimEnd()]));
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const files = quarantineFiles(root);
  const findings = quarantineFindings(firstLinesOf(root, files), new Date());
  console.log(`quarantine: ${String(files.length)} file(s), limit ${String(QUARANTINE_LIMIT_DAYS)} days`);
  for (const finding of findings) console.log(`  ${finding.file}: ${finding.problem}`);
  process.exit(findings.length === 0 ? 0 : 1);
}
