#!/usr/bin/env bun
// One-shot cleanup for the drift loop (2026-11-19): the four `failed` rows of 2026-10-23 were caused by
// `min-release-age=7` in the person's ~/.npmrc (npm said `notarget`), not by a lab verdict. The lab has
// installed with `npm_config_min_release_age=0` since 2026-10-30 (harnesses.ts, npmInstallCommand), so the
// cause is gone. This command turns those rows into `retry` so the loop may run them again.
//
//   bun scripts/harness-canary/lab/retry-old.ts               print what it would change (the default)
//   bun scripts/harness-canary/lab/retry-old.ts --apply       write it, after a copy of the ledger
//   --ledger PATH    the ledger (default: the lab's own)
//   --date D         the day of the rows (default 2026-10-23)
//
// It touches only a `failed` row of that day whose note is a `notarget` failure. Nothing else changes. It
// never runs a lab pair. Note: the feeds name only the newest version, so an old pair comes back only while
// it is still the newest, or when a person names it with `--version`.

import { copyFileSync } from "node:fs";
import { classifyFailure, RETRY_GAP_MS } from "./failure-class";
import { ledgerPath, readLedger, writeLedger, type LabLedger, type LabRow } from "./lab-ledger";

export const OLD_DAY = "2026-10-23";

export interface Change {
  readonly before: LabRow;
  readonly after: LabRow;
}

/** The rows that would move, and the ledger as it would be. Pure: nothing is written. */
export function planCleanup(ledger: LabLedger, day: string, now: number) {
  const changes: Change[] = [];
  const rows = ledger.rows.map((row): LabRow => {
    if (row.result !== "failed" || row.date !== day || classifyFailure(row.note ?? "") !== "notarget") return row;
    // tries 0 and a last try one wait ago: due at the next tick. The week starts now.
    const after: LabRow = { ...row, result: "retry", tries: 0, firstTry: now, lastTry: now - RETRY_GAP_MS, cause: "notarget", notified: undefined };
    changes.push({ before: row, after });
    return after;
  });
  return { changes, next: { rows } satisfies LabLedger };
}

export function describeChange(change: Change): string {
  return `${change.before.harness} ${change.before.version} (${change.before.date}): failed -> retry (notarget)`;
}

/** Runs the command. Returns the lines to print. `apply` false (the default) writes nothing. */
export function cleanup(options: { readonly ledger: string; readonly day: string; readonly apply: boolean; readonly now: number }): string[] {
  const { changes, next } = planCleanup(readLedger(options.ledger), options.day, options.now);
  const lines = changes.map(describeChange);
  if (changes.length === 0) return [`nothing to change: no failed row of ${options.day} holds a notarget failure`];
  if (!options.apply) return [...lines, `dry run: ${String(changes.length)} row(s) would change in ${options.ledger}; add --apply to write`];
  const backup = `${options.ledger}.bak-${new Date(options.now).toISOString().slice(0, 10)}`;
  copyFileSync(options.ledger, backup);
  writeLedger(options.ledger, next);
  return [...lines, `changed ${String(changes.length)} row(s); the old ledger is at ${backup}`];
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const take = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i < 0 ? undefined : argv[i + 1];
  };
  const unknown = argv.filter((arg) => arg.startsWith("--") && !["--apply", "--dry-run", "--ledger", "--date"].includes(arg));
  if (unknown.length > 0) {
    console.error(`unknown option ${unknown[0] ?? ""}`);
    process.exit(2);
  }
  if (argv.includes("--apply") && argv.includes("--dry-run")) {
    console.error("--apply and --dry-run exclude each other");
    process.exit(2);
  }
  for (const line of cleanup({ ledger: take("--ledger") ?? ledgerPath(), day: take("--date") ?? OLD_DAY, apply: argv.includes("--apply"), now: Date.now() })) console.log(line);
}
