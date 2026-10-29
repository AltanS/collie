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
// Whether sends arrive is not asked here: the counters are per day and cannot say what the last sends
// did. The `sends-*` rows (cli/send-findings.ts, M71 spec 01) read the receipts for that, and replaced
// the refusal-rate warning these rows carried until then.
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

function edgeWords(row: CounterRow): string[] {
  const total = Object.values(row.edges).reduce((sum, n) => sum + n, 0);
  return total === 0 ? [] : [`edges ${String(total)}${words(row.edges)}`];
}

/** The held sends (M56 spec 15), only where a send was held, so a host that never held one reads as before. */
function heldWords(row: CounterRow): string[] {
  if (row.held + row.held_sent + row.held_expired + row.held_cancelled === 0) return [];
  return [`held ${String(row.held)}`, `held-sent ${String(row.held_sent)}`, `held-expired ${String(row.held_expired)}`, `held-cancelled ${String(row.held_cancelled)}`];
}

/** Hook-held permissions by outcome (M56 spec 12), only where a hold happened. */
function holdWords(row: CounterRow): string[] {
  const total = Object.values(row.holds).reduce((sum, n) => sum + n, 0);
  return total === 0 ? [] : [`held asks ${String(total)}${words(row.holds)}`];
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
    `discarded ${String(row.discarded)}`,
    ...heldWords(row),
    // Hook edges (M56 spec 11) only where a pane took one, so a host without hooks reads as before.
    ...edgeWords(row),
    ...holdWords(row),
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
    if (row.manual < DEFAULT_CAP) return ok(check, detail);
    const remedy = `a person typed past an unreadable screen ${String(row.manual)} times; send the frames in ${join(dir, "inbox.jsonl")} to the lab and add a profile for ${row.harness} ${row.version}`;
    return warn(check, detail, remedy);
  });
  return [summary, ...lines];
}
