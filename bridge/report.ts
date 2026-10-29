// ── WHAT A "REPORT A PROBLEM" SHEET READS OFF THIS MACHINE (ADR 0123) ──────────────────────────
//
// The phone builds an issue body when a person taps Report a problem. Most of what it holds the phone
// already has: the receipts of the failing sends (`GET /api/send/receipts`). This module holds the
// rest, for the one read route `GET /api/report/context`: which Collie this is, on which line, OS and
// multiplexer, and, only when the person turned "Include the screen" on, the pane's last rows.
//
// THE SCREEN IS ALWAYS MASKED. The mirror masks secret shapes only while `COLLIE_REDACT` is on, because
// the mirror goes to the operator's own phone. A report is meant for a public issue, so its screen
// goes through the same mask (`redactText`, bridge/redact.ts) whatever that switch says. The phone
// shows this exact text in the preview before anything leaves, and nothing here is stored.
//
// THE DOCTOR'S SEND ROWS (M71 spec 05). The setup block also carries the `sends-<harness>`,
// `holds-<harness>` and `screen-<harness>` rows `collie doctor` prints, built by the same function over
// this bridge's own state dir (cli/send-findings.ts, wired in index.ts). A row here is check, status,
// detail and harness only: never a remedy (advice for the person at the machine), never a held text,
// never a typed line. {@link reportDoctorRows} picks the rows a report carries.
//
// Pure: no mux, no disk, no clock. The route in server.ts reads the grid and strips its escapes.

import type { DoctorStatus } from "../cli/finding.ts";
import type { ReleaseLine } from "./update-line.ts";
import { redactText } from "./redact.ts";

/** The most rows of a pane's screen a report carries: the bottom of the screen, where the box is. */
export const REPORT_SCREEN_ROWS = 40;

/** What `GET /api/report/context` answers. Every field is a fact about this machine or this pane. */
export interface ReportContext {
  /** This bridge's version, as `/api/health` answers it. */
  readonly collie: string;
  /** The release line this machine follows, or null when it keeps no record. */
  readonly line: ReleaseLine | null;
  /** The host's platform and `process.arch`, as the route's caller read them. */
  readonly os: string;
  readonly arch: string;
  /** The multiplexer's registry name. Said, never branched on. */
  readonly mux: string;
  /** The pane's agent string, `""` for a bare shell, null when no pane was named. */
  readonly harness: string | null;
  /** Whether this pane has a screen to include (a program session has none). */
  readonly screenable: boolean;
  /** On `screen=1` only: the last {@link REPORT_SCREEN_ROWS} rows, escapes stripped, masked. */
  readonly screen?: string;
  /** The doctor's send rows this report carries, in the doctor's order. Absent when the bridge could not read them. */
  readonly doctor?: readonly ReportDoctorRow[];
}

/** One doctor row as a report carries it: no remedy, no held text, no typed line. */
export interface ReportDoctorRow {
  readonly check: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  /** The harness as the doctor names it, `-` for a send with none. */
  readonly harness: string;
}

/** One row of the doctor's sends section as the bridge hands it to the route (`sendsReportRows`, cli/send-findings.ts). */
export interface DoctorRowSource {
  readonly check: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  /** Null on the one row that says no hold is open. */
  readonly harness: string | null;
  /** The row says only "nothing here": no sends in the window, no hold open, no stale screen. */
  readonly quiet: boolean;
}

/** The doctor's group for a pane's agent string: a bare shell's `""` is `-`, as the `sends-*` rows name it. */
const groupOf = (harness: string): string => (harness === "" ? "-" : harness);

const REPORT_CHECK = /^(?:sends|holds|screen)-/u;

/**
 * The rows a report carries. With a pane (`harness` not null), every `sends-*`, `holds-*` and
 * `screen-*` row of the pane's harness. Without one (the Settings door), every such row that says more
 * than "nothing here". The row that says no hold is open names no harness and is never carried. Each
 * row is copied field by field, so nothing else a source row holds can reach the answer.
 */
export function reportDoctorRows(rows: readonly DoctorRowSource[], harness: string | null): ReportDoctorRow[] {
  const group = harness === null ? null : groupOf(harness);
  return rows
    .filter((row) => REPORT_CHECK.test(row.check) && row.harness !== null)
    .filter((row) => (group === null ? !row.quiet : row.harness === group))
    .map((row) => ({ check: row.check, status: row.status, detail: row.detail, harness: row.harness ?? "-" }));
}

/**
 * The screen as a report carries it: the visible text (escapes already stripped), each row's trailing
 * blanks cut, the blank rows at the bottom dropped, the last `rows` rows kept, and every secret shape
 * masked by `redactText`, always.
 */
export function reportScreen(visibleText: string, rows = REPORT_SCREEN_ROWS): string {
  const lines = visibleText.split(/\r?\n/u).map((row) => row.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return redactText(lines.slice(-rows).join("\n"));
}
