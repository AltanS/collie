import { counterDates, DEFAULT_CAP, readDays, summarize, SUMMARY_DAYS, totalsOf, unknownTotal, type CounterRow } from "../bridge/surface/counters.ts";
import { join } from "node:path";
import type { CliContext } from "./context.ts";
import { ok, warn, type Finding } from "./finding.ts";
import type { Files } from "./sys.ts";

// ── What the readers saw, per harness and version (M56 spec 09) ──────────────
//
// The bridge counts every Surface verdict and every send outcome per harness, version and profile in
// `<stateDir>/surface/counters-<date>.json` and keeps fourteen days. This section reads the last seven
// and prints one line per row: how often the screen read as free, how often Collie could not tell and
// why, how many sends were refused, probed or confirmed by hand. It is a READ: nothing here writes, so
// `doctor` stays safe on a machine that is already misbehaving (cli/doctor.ts).
//
// A row is `warn` when the person typed past an unreadable screen as often as the cap allows
// (DEFAULT_CAP in 24 hours is the cap's own number, here read over seven days as a plain signal that a
// harness version needs a profile): the frames those sends were confirmed on are in `inbox.jsonl`.
// No row is ever `error`: a counter is a number, and `collie doctor` exits 0 on warnings.

/** What this section reaches: the context, one directory listing and file reads, and the clock. */
export interface SurfaceDeps {
  readonly ctx: CliContext;
  readonly files: Pick<Files, "list" | "read">;
  readonly now: () => number;
}

function words(record: Readonly<Record<string, number>>): string {
  const parts = Object.entries(record)
    .toSorted(([, a], [, b]) => b - a)
    .map(([word, n]) => `${word} ${String(n)}`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function rowLine(row: CounterRow): string {
  const unknown = unknownTotal(row);
  const refused = Object.values(row.refused).reduce((sum, n) => sum + n, 0);
  const modal = Object.values(row.modal).reduce((sum, n) => sum + n, 0);
  return [
    `${row.version} ${row.status}`,
    `free ${String(row.free)}`,
    `unknown ${String(unknown)}${words(row.unknown)}`,
    `modal ${String(modal)}${words(row.modal)}`,
    `refused ${String(refused)}${words(row.refused)}`,
    `probed ${String(row.probed)}`,
    `manual ${String(row.manual)}`,
    `sent ${String(row.sent)}`,
    `effective ${String(row.effective)}`,
    `unknown-outcome ${String(row.unknown_outcome)}`,
    `typed-not-submitted ${String(row.typed_not_submitted)}`,
  ].join(" · ");
}

/** The Surface table: a summary line, then one line per harness and version over the last seven days. Empty with no counters. */
export function surfaceFindings(deps: SurfaceDeps): Finding[] {
  const dir = join(deps.ctx.stateDir, "surface");
  const days = readDays(dir, deps.now(), SUMMARY_DAYS, deps.files);
  const rows = summarize(days);
  // No counters yet: no line at all, like the Whistle model's section on a host that never had one.
  // The bridge writes the first file when it reads its first agent pane, so a fresh install reads exactly
  // as it did before this section existed.
  if (rows.length === 0) return [];
  const totals = totalsOf(rows);
  const examples = deps.files.list(join(dir, "examples")).filter((name) => name.endsWith(".json")).length;
  const kept = counterDates(deps.files.list(dir)).length;
  const summary = ok(
    "surface",
    `last ${String(SUMMARY_DAYS)} days: free ${String(totals.free)} · unknown ${String(totals.unknown)} · manual ${String(totals.manual)} · ` +
      `${String(kept)} day files in ${dir} · examples ${join(dir, "examples")} (${String(examples)} files) · inbox ${join(dir, "inbox.jsonl")}`,
  );
  const lines = rows.map((row) => {
    const check = `surface-${row.harness}-${row.version}`;
    const detail = rowLine(row);
    return row.manual >= DEFAULT_CAP
      ? warn(check, detail, `a person typed past an unreadable screen ${String(row.manual)} times; send the frames in ${join(dir, "inbox.jsonl")} to the lab and add a profile for ${row.harness} ${row.version}`)
      : ok(check, detail);
  });
  return [summary, ...lines];
}
